// RFL judge: the staged cross-run straddle, UNCHANGED in shape, but over the REAL HTTP/2 duplex
// transport (real in-box HTTP/2 gateway spawned over a local duplex channel, real host HTTP/2
// server, real native broker). Fixture copied from native-github-access.test.ts (localDuplexChannel).
// Place in server/src/services/native-runtime/.
import { expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandManagedDuplexChannel, CommandManagedRuntimeRunner } from '@paperclipai/adapter-utils/command-managed-runtime';
import { startAdapterExecutionTargetPaperclipBridge } from '@paperclipai/adapter-utils/execution-target';
import { createNativeGitHubAccess } from './native-github-access.js';

function localDuplexChannel(command: readonly string[], cwd: string): CommandManagedDuplexChannel {
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const buffered: Buffer[] = [];
  let dataListener: ((chunk: Uint8Array) => void) | undefined;
  let exitListener: ((exit: { exitCode: number | null }) => void) | undefined;
  let exit: { exitCode: number | null } | undefined;
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => dataListener ? dataListener(chunk) : buffered.push(chunk));
  const closed = new Promise<void>(resolve => child.once('close', code => { exit = { exitCode: code }; exitListener?.(exit); resolve(); }));
  return {
    write: data => { child.stdin.write(data); },
    onData: listener => { dataListener = listener; for (const chunk of buffered.splice(0)) listener(chunk); },
    onExit: listener => { exitListener = listener; if (exit) listener(exit); },
    stop: () => { child.kill(); },
    close: async () => { child.kill(); await closed; },
  };
}

it('JUDGE HTTP/2 duplex: a request begun by A must not acquire B authority after body delivery straddles release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'judge-http2-'));
  const scope = { companyId: 'judge-company', agentId: 'judge-agent', issueId: 'judge-issue' };
  const resolved: string[] = [];
  const modes: (string | undefined)[] = [];
  const execute: CommandManagedRuntimeRunner['execute'] = async input => {
    const startedAt = new Date().toISOString();
    const child = promisify(execFile)(input.command, input.args ?? [], {
      cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    child.child.stdin?.on('error', () => undefined);
    child.child.stdin?.end(input.stdin ?? '');
    const result = await child;
    return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
  };
  let broker: Awaited<ReturnType<typeof createNativeGitHubAccess>> | undefined;
  let pending: ReturnType<typeof httpRequest> | undefined;
  try {
    broker = await createNativeGitHubAccess({
      scope, cwd: root, env: { PATH: process.env.PATH },
      target: { kind: 'remote', transport: 'sandbox', providerKey: 'judge', remoteCwd: root,
        runner: { execute, openDuplexChannel: async input => localDuplexChannel(input.command, root) }, streamRunLogs: false,
        enableSandboxDuplexBridge: true, effectiveCapabilities: {
          reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false,
          independentControlCommands: true, incrementalSessionOutput: false, concurrentSyncOperations: false,
          duplexCommandStream: true, runnerWebSocketIngress: false } },
      resolveCredentials: async binding => { resolved.push(binding.runId); return { authority: binding.runId }; },
    }, async input => { const bridge = await startAdapterExecutionTargetPaperclipBridge(input); modes.push(bridge?.env.PAPERCLIP_API_BRIDGE_MODE); return bridge; });
    expect(broker.ready).toBe(true);
    expect(modes).toEqual(['http2_v1']);
    const releaseA = await broker.activate({ ...scope, runId: 'run-A' });
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      pending = httpRequest(`${broker!.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
        method: 'POST', headers: {
          authorization: `Bearer ${broker!.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`,
          'content-type': 'application/json', 'content-length': '2',
        },
      }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      pending.on('error', reject);
      pending.flushHeaders();
      pending.write('{');
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    await releaseA();
    const releaseB = await broker.activate({ ...scope, runId: 'run-B' });
    pending!.end('}');
    const received = await response;
    await releaseB();
    let authority: unknown = null; try { authority = JSON.parse(received.body).authority ?? null; } catch { /* non-JSON */ }
    console.log(JSON.stringify({ transport: 'actual http2_v1 gateway + host HTTP/2 server + native broker', modes, status: received.status, resolvedRuns: resolved, responseAuthority: authority }));
    expect(resolved).not.toContain('run-B');
    expect(received.status).not.toBe(200);
  } finally {
    pending?.destroy();
    await broker?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
