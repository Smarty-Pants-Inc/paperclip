// RFL judge: what happens to release/activate when the box cannot take the run-state write
// (box stopped / exec channel dead at run end). Place in packages/adapter-utils/src/.
import { expect, it, vi } from 'vitest';
import { startSandboxCallbackBridgeWorker, type SandboxCallbackBridgeQueueClient } from './sandbox-callback-bridge.js';

it('JUDGE-RELEASE-FAILURE: pause()/resume() reject when the box write fails; a hung write blocks pause', async () => {
  vi.useFakeTimers();
  let boxDown = false; let hang = false; let lists = 0;
  const files = new Map<string, string>();
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => {}, makeDirs: async () => {},
    listJsonFiles: async () => { lists++; if (boxDown) throw new Error('sandbox is stopped'); return []; },
    readTextFile: async () => '',
    writeTextFile: async (file, body) => {
      if (hang) await new Promise(() => undefined);
      if (boxDown) throw new Error('sandbox is stopped');
      files.set(file, body);
    },
    rename: async () => {}, remove: async () => {},
  };
  const worker = await startSandboxCallbackBridgeWorker({ client, queueDir: '/q', pollIntervalMs: 500, startPaused: true,
    handleRequest: async () => ({ status: 200, body: 'ok' }) });
  const r = worker.resume('gen-A'); await vi.advanceTimersByTimeAsync(0); await r;
  boxDown = true; // the box stops while run A is attached; run A ends and releases
  const pauseOutcome = await Promise.race([
    worker.pause().then(() => 'resolved', error => `REJECTED: ${(error as Error).message}`),
    vi.advanceTimersByTimeAsync(60_000).then(() => 'still pending after 60 s'),
  ]);
  const listsAtPause = lists; await vi.advanceTimersByTimeAsync(120_000);
  const listsAfterFailedPause = lists - listsAtPause;
  const resumeOutcome = await Promise.race([
    worker.resume('gen-B').then(() => 'resolved', error => `REJECTED: ${(error as Error).message}`),
    vi.advanceTimersByTimeAsync(60_000).then(() => 'still pending after 60 s'),
  ]);
  const listsAtResume = lists; await vi.advanceTimersByTimeAsync(120_000);
  const listsAfterFailedResume = lists - listsAtResume;
  // second worker: the write hangs (dead channel, no reject)
  boxDown = false;
  const w2 = await startSandboxCallbackBridgeWorker({ client, queueDir: '/q2', pollIntervalMs: 500, startPaused: true,
    handleRequest: async () => ({ status: 200, body: 'ok' }) });
  const r2 = w2.resume('gen-A'); await vi.advanceTimersByTimeAsync(0); await r2;
  hang = true;
  const hungPause = await Promise.race([
    w2.pause().then(() => 'resolved', error => `REJECTED: ${(error as Error).message}`),
    vi.advanceTimersByTimeAsync(600_000).then(() => 'STILL PENDING after 600 s (no timeout in the worker around the run-state write)'),
  ]);
  console.log(JSON.stringify({ pauseOutcome, listsAfterFailedPause, resumeOutcome, listsAfterFailedResume, stateFile: files.get('/q/run-state.json'), hungPause }));
  vi.useRealTimers();
  expect(pauseOutcome).toBe('resolved'); // a release must not throw into the executor's finally
  expect(hungPause).toBe('resolved');
});
