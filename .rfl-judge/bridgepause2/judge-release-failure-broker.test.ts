// RFL judge: real gateway + worker + native broker; the box exec starts failing while run A is
// attached (box stopped / provider exec error). What does release (called in the executor's
// `finally`, native-session-executor.ts:14282) do? Place in server/src/services/native-runtime/.
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandManagedRuntimeRunner } from '@paperclipai/adapter-utils/command-managed-runtime';
import { createNativeGitHubAccess } from './native-github-access.js';

it('JUDGE-RELEASE-FAILURE (broker): release must not throw when the box cannot be written; next activate must not throw', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'judge-release-'));
  const scope = { companyId: 'c', agentId: 'a', issueId: 'i' };
  let boxDown = false;
  const execute: CommandManagedRuntimeRunner['execute'] = async input => {
    if (boxDown) throw new Error('sandbox is stopped');
    const startedAt = new Date().toISOString();
    const child = promisify(execFile)(input.command, input.args ?? [], {
      cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    child.child.stdin?.on('error', () => undefined);
    child.child.stdin?.end(input.stdin ?? '');
    const result = await child;
    return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
  };
  const broker = await createNativeGitHubAccess({
    scope, cwd: root, env: { PATH: process.env.PATH },
    target: { kind: 'remote', transport: 'sandbox', providerKey: 'judge', remoteCwd: root, runner: { execute }, streamRunLogs: false },
    resolveCredentials: async binding => ({ authority: binding.runId }),
  });
  try {
    const releaseA = await broker.activate({ ...scope, runId: 'run-A' });
    boxDown = true;
    const release = await releaseA().then(() => 'resolved', error => `REJECTED: ${(error as Error).message}`.slice(0, 160));
    const activateB = await broker.activate({ ...scope, runId: 'run-B' }).then(() => 'resolved', error => `REJECTED: ${(error as Error).message}`.slice(0, 160));
    console.log(JSON.stringify({ release, activateB, ready: broker.ready }));
    expect(release).toBe('resolved');
  } finally { boxDown = false; await broker.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
}, 60000);
