// RFL judge pause checks for cl/bridge-pause (bf984a4d / 252222ce). Place in packages/adapter-utils/src/.
import { expect, it, vi } from 'vitest';
import { startSandboxCallbackBridgeWorker, type SandboxCallbackBridgeQueueClient } from './sandbox-callback-bridge.js';

function fixture() {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const handled: string[] = [];
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => { calls.push('makeDir'); }, makeDirs: async () => { calls.push('makeDirs'); },
    listJsonFiles: async dir => { calls.push('list'); return [...files.keys()].filter(f => f.startsWith(`${dir}/`) && f.endsWith('.json')).map(f => f.slice(dir.length + 1)); },
    readTextFile: async file => { calls.push('read'); const v = files.get(file); if (v === undefined) throw new Error('ENOENT'); return v; },
    writeTextFile: async (file, body) => { calls.push(`write:${file.split('/').pop()}`); files.set(file, body); },
    rename: async (from, to) => { calls.push('rename'); const v = files.get(from); if (v !== undefined) { files.set(to, v); files.delete(from); } },
    remove: async file => { calls.push('remove'); files.delete(file); },
  };
  return { calls, files, handled, client };
}
const Q = '/fixture/q';
const reqFile = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, method: 'POST', path: '/runtime-tools/github/credentials', query: '', headers: { 'content-type': 'application/json' }, body: '{}', createdAt: new Date().toISOString(), ...extra });

it('JUDGE-PAUSE: startPaused polls zero; resume polls within one interval; pause -> zero box calls for 10 min; late A request quarantined; B handled', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const worker = await startSandboxCallbackBridgeWorker({
    client: f.client, queueDir: Q, pollIntervalMs: 500, startPaused: true,
    handleRequest: async request => { f.handled.push(`${request.id}:${(request as { bridgeGeneration?: string }).bridgeGeneration ?? 'none'}`); return { status: 200, body: 'ok' }; },
  });
  await vi.advanceTimersByTimeAsync(0);
  const afterStart = f.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  const pausedAtStartCalls = f.calls.slice(afterStart);
  const stateAtStart = f.files.get(`${Q}/run-state.json`);

  // attach A
  const resumeA = worker.resume('gen-A'); await vi.advanceTimersByTimeAsync(0); await resumeA;
  const stateA = f.files.get(`${Q}/run-state.json`);
  const listsBefore = f.calls.filter(c => c === 'list').length;
  await vi.advanceTimersByTimeAsync(5_000);
  const listsWhileAttached5s = f.calls.filter(c => c === 'list').length - listsBefore;
  f.files.set(`${Q}/requests/a1.json`, reqFile('a1', { bridgeGeneration: 'gen-A' }));
  await vi.advanceTimersByTimeAsync(500);
  const handledUnderA = [...f.handled];

  // release A
  const pauseA = worker.pause(); await vi.advanceTimersByTimeAsync(0); await pauseA;
  const stateReleased = f.files.get(`${Q}/run-state.json`);
  const afterPause = f.calls.length;
  // a late run-A request lands in the queue after release (gateway raced the marker)
  f.files.set(`${Q}/requests/late-a.json`, reqFile('late-a', { bridgeGeneration: 'gen-A' }));
  await vi.advanceTimersByTimeAsync(600_000);
  const callsAfterRelease10min = f.calls.slice(afterPause);
  const handledAfterRelease = f.handled.slice(handledUnderA.length);

  // attach B
  const t0 = Date.now();
  const resumeB = worker.resume('gen-B'); await vi.advanceTimersByTimeAsync(0); await resumeB;
  const stateB = f.files.get(`${Q}/run-state.json`);
  const lateResponse = f.files.get(`${Q}/responses/late-a.json`);
  const lateStillQueued = f.files.has(`${Q}/requests/late-a.json`);
  f.files.set(`${Q}/requests/b1.json`, reqFile('b1', { bridgeGeneration: 'gen-B' }));
  let waited = 0; while (!f.handled.some(h => h.startsWith('b1:')) && waited < 5_000) { await vi.advanceTimersByTimeAsync(50); waited += 50; }
  const bHandledAfterMs = Date.now() - t0;
  // double pause / double resume are idempotent
  const p1 = worker.pause(); await vi.advanceTimersByTimeAsync(0); await p1;
  const p2 = worker.pause(); await vi.advanceTimersByTimeAsync(0); await p2;
  const afterDouble = f.calls.length; await vi.advanceTimersByTimeAsync(60_000);
  const callsAfterDoublePause = f.calls.length - afterDouble;
  const stopped = worker.stop({ drainTimeoutMs: 1000 }); await vi.advanceTimersByTimeAsync(1500); await stopped;
  const stopCalls = f.calls.slice(afterDouble);
  vi.useRealTimers();
  console.log(JSON.stringify({ pausedAtStartCalls, stateAtStart, stateA, listsWhileAttached5s, handledUnderA, stateReleased,
    callsAfterRelease10min, handledAfterRelease, stateB, lateResponse: lateResponse ? JSON.parse(lateResponse).status : null,
    lateStillQueued, handled: f.handled, bHandledAfterMs, callsAfterDoublePause, stopCalls }));
  expect(pausedAtStartCalls).toEqual([]);
  expect(stateAtStart).toBe('paused');
  expect(stateA).toBe('attached:gen-A');
  expect(listsWhileAttached5s).toBeGreaterThanOrEqual(9);
  expect(handledUnderA).toEqual(['a1:gen-A']);
  expect(stateReleased).toBe('paused');
  expect(callsAfterRelease10min).toEqual([]);
  expect(handledAfterRelease).toEqual([]);
  expect(stateB).toBe('attached:gen-B');
  expect(f.handled.some(h => h.startsWith('late-a'))).toBe(false);
  expect(lateResponse ? JSON.parse(lateResponse).status : null).toBe(503);
  expect(f.handled).toContain('b1:gen-B');
  expect(bHandledAfterMs).toBeLessThanOrEqual(500);
  expect(callsAfterDoublePause).toBe(0);
});
