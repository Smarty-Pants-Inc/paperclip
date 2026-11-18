// RFL judge 3 (d28057c0): an ORDINARY adapter bridge (no startPaused; the generic agent -> Paperclip API
// callback bridge every adapter uses) with the duplex setting on, whose duplex channel fails to open, so it
// falls back to the file bridge. Does the fallback still serve requests? (d28057c0 writes run-state.json
// "paused" before the channel open, for every caller.) Also the same bridge with HTTP/2 healthy.
// Place in server/src/services/native-runtime/ (uses the server vitest config).
import { expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandManagedDuplexChannel, CommandManagedRuntimeRunner } from '@paperclipai/adapter-utils/command-managed-runtime';
import { startAdapterExecutionTargetPaperclipBridge } from '@paperclipai/adapter-utils/execution-target';

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
async function findFile(dir: string, name: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath, entry.name);
  }
  return null;
}

for (const duplexOpens of [false, true]) {
  it(`JUDGE3 generic adapter bridge, duplex setting on, duplex channel ${duplexOpens ? 'opens' : 'FAILS to open -> file bridge fallback'}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'judge3-generic-'));
    const hostHits: string[] = [];
    const host = createServer((req, res) => { hostHits.push(`${req.method} ${req.url}`); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'agent-1' })); });
    await new Promise<void>(resolve => host.listen(0, '127.0.0.1', () => resolve()));
    const hostUrl = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
    const execute: CommandManagedRuntimeRunner['execute'] = async input => {
      const startedAt = new Date().toISOString();
      const child = promisify(execFile)(input.command, input.args ?? [], { cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      child.child.stdin?.on('error', () => undefined); child.child.stdin?.end(input.stdin ?? '');
      const result = await child;
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
    };
    const logs: string[] = [];
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: 'judge3-generic-run', adapterKey: 'judge-adapter', hostApiToken: 'host-token', hostApiUrl: hostUrl,
      enableSandboxDuplexBridge: true,
      target: { kind: 'remote', transport: 'sandbox', providerKey: 'judge', remoteCwd: root,
        runner: { execute, openDuplexChannel: async input => { if (!duplexOpens) throw new Error('duplex channel refused'); return localDuplexChannel(input.command, root); } },
        streamRunLogs: false, enableSandboxDuplexBridge: true, effectiveCapabilities: { reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false,
          persistentProcessSessions: false, independentControlCommands: true, incrementalSessionOutput: false, concurrentSyncOperations: false,
          duplexCommandStream: true, runnerWebSocketIngress: false } },
      onLog: async (_stream, chunk) => { logs.push(chunk.trim()); },
    } as Parameters<typeof startAdapterExecutionTargetPaperclipBridge>[0]);
    try {
      expect(bridge).toBeTruthy();
      const mode = bridge!.env.PAPERCLIP_API_BRIDGE_MODE;
      const statePath = await findFile(root, 'run-state.json');
      const marker = statePath ? await readFile(statePath, 'utf8') : null;
      const got = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(`${bridge!.env.PAPERCLIP_API_URL}/api/agents/me`, { method: 'GET', headers: { authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}`, accept: 'application/json' } },
          res => { let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode!, body })); });
        req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('timeout'))); req.end();
      });
      console.log(JSON.stringify({ duplexOpens, mode, marker, status: got.status, body: got.body.slice(0, 160), hostHits, fallbackLog: logs.filter(line => /file bridge|duplex/i.test(line)) }));
      expect(got.status).toBe(200); // an ordinary adapter's agent -> Paperclip API call must work
    } finally {
      await bridge?.stop();
      await new Promise<void>(resolve => { host.closeAllConnections(); host.close(() => resolve()); });
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
}
