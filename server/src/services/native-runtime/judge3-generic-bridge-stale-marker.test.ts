// RFL judge 3 (d28057c0): ordinary adapter bridge. Run 1 uses HTTP/2 (healthy) and stops. Run 2 in the SAME
// workspace uses the file bridge (duplex setting off, or the channel refused). Does run 1's marker outlive it?
// Place in server/src/services/native-runtime/.
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

it('JUDGE3 generic adapter bridge: HTTP/2 run, stop, then a file-bridge run in the same workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'judge3-stale-'));
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
  const start = (runId: string, duplex: boolean) => startAdapterExecutionTargetPaperclipBridge({
    runId, adapterKey: 'judge-adapter', runtimeRootDir: root, hostApiToken: 'host-token', hostApiUrl: hostUrl, enableSandboxDuplexBridge: duplex,
    target: { kind: 'remote', transport: 'sandbox', providerKey: 'judge', remoteCwd: root,
      runner: { execute, openDuplexChannel: async input => localDuplexChannel(input.command, root) },
      streamRunLogs: false, enableSandboxDuplexBridge: duplex, effectiveCapabilities: { reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false,
        persistentProcessSessions: false, independentControlCommands: true, incrementalSessionOutput: false, concurrentSyncOperations: false,
        duplexCommandStream: duplex, runnerWebSocketIngress: false } },
    onLog: async () => {},
  } as Parameters<typeof startAdapterExecutionTargetPaperclipBridge>[0]);
  const get = (bridge: NonNullable<Awaited<ReturnType<typeof start>>>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(`${bridge.env.PAPERCLIP_API_URL}/api/agents/me`, { method: 'GET', headers: { authorization: `Bearer ${bridge.env.PAPERCLIP_API_KEY}`, accept: 'application/json' } },
      res => { let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode!, body })); });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('timeout'))); req.end();
  });
  try {
    const run1 = (await start('run-1', true))!;
    const mode1 = run1.env.PAPERCLIP_API_BRIDGE_MODE; const got1 = await get(run1);
    await run1.stop();
    const statePath = await findFile(root, 'run-state.json');
    const markerAfterRun1Stop = statePath ? await readFile(statePath, 'utf8') : null;
    const run2 = (await start('run-2', false))!;
    const mode2 = run2.env.PAPERCLIP_API_BRIDGE_MODE; const got2 = await get(run2);
    await run2.stop();
    console.log(JSON.stringify({ run1: { mode: mode1, status: got1.status }, markerAfterRun1Stop, run2: { mode: mode2, status: got2.status, body: got2.body.slice(0, 120) }, hostHits }));
    expect(got1.status).toBe(200);
    expect(got2.status).toBe(200);
  } finally {
    await new Promise<void>(resolve => { host.closeAllConnections(); host.close(() => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
