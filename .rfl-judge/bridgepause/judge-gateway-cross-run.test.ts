import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandManagedRuntimeRunner } from '@paperclipai/adapter-utils/command-managed-runtime';
import { createNativeGitHubAccess } from './native-github-access.js';

it('JUDGE actual file gateway: a request begun by A must not acquire B authority after body delivery straddles release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'judge-real-gateway-'));
  const scope = { companyId: 'judge-company', agentId: 'judge-agent', issueId: 'judge-issue' };
  const resolved: string[] = [];
  const execute: CommandManagedRuntimeRunner['execute'] = async input => {
    const startedAt = new Date().toISOString();
    const child = promisify(execFile)(input.command, input.args ?? [], {
      cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
    });
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
        runner: { execute }, streamRunLogs: false },
      resolveCredentials: async binding => { resolved.push(binding.runId); return { authority: binding.runId }; },
    });
    expect(broker.ready).toBe(true);
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
      pending.write('{'); // Gateway authenticates/checks marker, then waits for remaining body.
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    await releaseA();
    const releaseB = await broker.activate({ ...scope, runId: 'run-B' });
    pending!.end('}');
    const received = await response;
    await releaseB();
    console.log(JSON.stringify({ transport: 'actual queue_v1 gateway + worker + native broker', status: received.status, resolvedRuns: resolved, responseAuthority: JSON.parse(received.body).authority ?? null }));
    expect(resolved).not.toContain('run-B');
    expect(received.status).not.toBe(200);
  } finally {
    pending?.destroy();
    await broker?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
