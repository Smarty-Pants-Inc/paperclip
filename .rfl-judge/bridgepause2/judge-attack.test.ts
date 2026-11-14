// RFL judge attack tests for cl/bridge-pause 252222ce (generation binding).
// Real file gateway + host worker + native GitHub broker, same harness as the
// staged judge-gateway-cross-run.test.ts. Place in
// server/src/services/native-runtime/ and run with vitest.
import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, rename, stat, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandManagedRuntimeRunner } from '@paperclipai/adapter-utils/command-managed-runtime';
import { createNativeGitHubAccess } from './native-github-access.js';

type Broker = Awaited<ReturnType<typeof createNativeGitHubAccess>>;
const scope = { companyId: 'judge-company', agentId: 'judge-agent', issueId: 'judge-issue' };
let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined); });

async function findFile(dir: string, name: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const hit = await findFile(full, name); if (hit) return hit; }
    else if (entry.name === name) return full;
  }
  return null;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'judge-attack-'));
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
  const broker: Broker = await createNativeGitHubAccess({
    scope, cwd: root, env: { PATH: process.env.PATH },
    target: { kind: 'remote', transport: 'sandbox', providerKey: 'judge', remoteCwd: root,
      runner: { execute }, streamRunLogs: false },
    resolveCredentials: async binding => { resolved.push(binding.runId); return { authority: binding.runId }; },
  });
  cleanup.push(async () => { await broker.stop(); await rm(root, { recursive: true, force: true }); });
  expect(broker.ready).toBe(true);
  const runStatePath = (await findFile(root, 'run-state.json'))!;
  expect(runStatePath).toBeTruthy();
  const queueDir = path.dirname(runStatePath);
  const post = (timeoutMs = 8000) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(`${broker.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
      method: 'POST', timeout: timeoutMs, headers: {
        authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`,
        'content-type': 'application/json', 'content-length': '2',
      },
    }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('client timeout')); });
    req.end('{}');
  });
  // A process inside the box that bypasses the gateway and writes a queue entry itself.
  const forge = async (extra: Record<string, unknown>, headers: Record<string, string> = {}, waitMs = 6000) => {
    const id = randomUUID();
    const payload = { id, method: 'POST', path: '/runtime-tools/github/credentials', query: '',
      headers: { 'content-type': 'application/json', ...headers }, body: '{}',
      createdAt: new Date().toISOString(), ...extra };
    const requestPath = path.join(queueDir, 'requests', `${id}.json`);
    await writeFile(`${requestPath}.tmp`, `${JSON.stringify(payload)}\n`, 'utf8');
    await rename(`${requestPath}.tmp`, requestPath);
    const responsePath = path.join(queueDir, 'responses', `${id}.json`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const raw = await readFile(responsePath, 'utf8').catch(() => null);
      if (raw) { const parsed = JSON.parse(raw); return { status: parsed.status as number, body: String(parsed.body ?? '') }; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { status: -1, body: 'NO RESPONSE (still queued)' };
  };
  const runState = async () => (await readFile(runStatePath, 'utf8')).trim();
  return { root, broker, resolved, runStatePath, queueDir, post, forge, runState };
}

it('JUDGE-ATTACK 1: accepted under A works as A; paused between runs is 503; accepted under B works as B', async () => {
  const h = await setup();
  expect(await h.runState()).toBe('paused');
  const releaseA = await h.broker.activate({ ...scope, runId: 'run-A' });
  const genA = (await h.runState()).replace(/^attached:/, '');
  const a = await h.post();
  await releaseA();
  const pausedState = await h.runState();
  const between = await h.post();
  const releaseB = await h.broker.activate({ ...scope, runId: 'run-B' });
  const genB = (await h.runState()).replace(/^attached:/, '');
  const b = await h.post();
  await releaseB();
  const mode = (await stat(h.runStatePath)).mode & 0o777;
  console.log(JSON.stringify({ case: 1, a: a.status, aBody: a.body, pausedState, between: between.status, betweenBody: between.body,
    b: b.status, bBody: b.body, genDiffers: genA !== genB, genLooksUuid: /^[0-9a-f-]{36}$/.test(genA), runStateMode: mode.toString(8), resolved: h.resolved }));
  expect(a.status).toBe(200); expect(JSON.parse(a.body).authority).toBe('run-A');
  expect(pausedState).toBe('paused'); expect(between.status).toBe(503);
  expect(b.status).toBe(200); expect(JSON.parse(b.body).authority).toBe('run-B');
  expect(genA).not.toBe(genB);
  expect(h.resolved).toEqual(['run-A', 'run-B']);
}, 60000);

it('JUDGE-ATTACK 2: forged queue entries under B: no generation -> refused; replayed A generation -> refused; random -> refused', async () => {
  const h = await setup();
  const releaseA = await h.broker.activate({ ...scope, runId: 'run-A' });
  const genA = (await h.runState()).replace(/^attached:/, '');
  await releaseA();
  const releaseB = await h.broker.activate({ ...scope, runId: 'run-B' });
  const none = await h.forge({});
  const replayA = await h.forge({ bridgeGeneration: genA });
  const random = await h.forge({ bridgeGeneration: randomUUID() });
  const headerReplayA = await h.forge({}, { 'x-paperclip-bridge-generation': genA });
  const headerTransport = await h.forge({}, { 'x-paperclip-bridge-transport': 'http2_v1' });
  await releaseB();
  console.log(JSON.stringify({ case: 2, none, replayA, random, headerReplayA, headerTransport, resolved: h.resolved }));
  for (const r of [none, replayA, random, headerReplayA, headerTransport]) expect(r.status).toBe(403);
  expect(h.resolved).toEqual([]);
}, 60000);

it('JUDGE-ATTACK 3 (RESIDUAL PROBE): a box process that re-reads run-state.json after B attaches can stamp B itself', async () => {
  const h = await setup();
  const releaseA = await h.broker.activate({ ...scope, runId: 'run-A' });
  await releaseA();
  const releaseB = await h.broker.activate({ ...scope, runId: 'run-B' });
  const genB = (await h.runState()).replace(/^attached:/, ''); // plain file in the box queue dir
  const forgedField = await h.forge({ bridgeGeneration: genB });
  const forgedHeader = await h.forge({}, { 'x-paperclip-bridge-generation': genB });
  await releaseB();
  console.log(JSON.stringify({ case: 3, forgedField, forgedHeader, resolved: h.resolved }));
  // Recorded, not asserted as a pass/fail of the fix: this is the box trust model.
  expect([200, 403]).toContain(forgedField.status);
}, 60000);

it('JUDGE-ATTACK 4: box process rewrites run-state.json while paused -> queued entry is never handled as B', async () => {
  const h = await setup();
  const releaseA = await h.broker.activate({ ...scope, runId: 'run-A' });
  const genA = (await h.runState()).replace(/^attached:/, '');
  await releaseA();
  // Box-side tamper: un-pause the gateway marker with the old generation and with a bare marker.
  await writeFile(h.runStatePath, `attached:${genA}`, 'utf8');
  const viaGatewayOldGen = h.post(9000).catch(error => ({ status: -2, body: String(error) }));
  await new Promise(resolve => setTimeout(resolve, 700));
  const resolvedWhilePaused = [...h.resolved];
  const releaseB = await h.broker.activate({ ...scope, runId: 'run-B' });
  const late = await viaGatewayOldGen;
  // Tamper during B: strip the generation; gateway then stamps none.
  await writeFile(h.runStatePath, 'attached', 'utf8');
  const bare = await h.post();
  await releaseB();
  console.log(JSON.stringify({ case: 4, resolvedWhilePaused, late, bare, resolved: h.resolved }));
  expect(resolvedWhilePaused).toEqual([]);
  expect(late.status).not.toBe(200);
  expect(bare.status).toBe(403);
  expect(h.resolved).toEqual([]);
}, 60000);

it('JUDGE-ATTACK 5: body straddles release A -> activate B -> release B -> activate C (two hops) is refused', async () => {
  const h = await setup();
  const releaseA = await h.broker.activate({ ...scope, runId: 'run-A' });
  let pending: ReturnType<typeof httpRequest> | undefined;
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    pending = httpRequest(`${h.broker.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
      method: 'POST', headers: { authorization: `Bearer ${h.broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`,
        'content-type': 'application/json', 'content-length': '2' },
    }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', p => { body += p; }); res.on('end', () => resolve({ status: res.statusCode!, body })); });
    pending.on('error', reject); pending.flushHeaders(); pending.write('{');
  });
  cleanup.push(async () => { pending?.destroy(); });
  await new Promise(resolve => setTimeout(resolve, 250));
  await releaseA();
  const releaseB = await h.broker.activate({ ...scope, runId: 'run-B' });
  await releaseB();
  const releaseC = await h.broker.activate({ ...scope, runId: 'run-C' });
  pending!.end('}');
  const received = await response;
  const fresh = await h.post();
  await releaseC();
  console.log(JSON.stringify({ case: 5, straddle: received, fresh: fresh.status, resolved: h.resolved }));
  expect(received.status).not.toBe(200);
  expect(fresh.status).toBe(200);
  expect(h.resolved).toEqual(['run-C']);
}, 60000);
