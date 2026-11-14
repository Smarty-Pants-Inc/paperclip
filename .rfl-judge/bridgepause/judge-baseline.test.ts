import { expect, it, vi } from 'vitest';
import { startSandboxCallbackBridgeWorker, type SandboxCallbackBridgeQueueClient } from './sandbox-callback-bridge.js';

it('JUDGE RED: a retained worker makes zero list calls in two minutes without an attached run', async () => {
  vi.useFakeTimers();
  let listCalls = 0;
  const client: SandboxCallbackBridgeQueueClient = {
    makeDir: async () => {}, makeDirs: async () => {},
    listJsonFiles: async () => { listCalls++; return []; },
    readTextFile: async () => '', writeTextFile: async () => {},
    rename: async () => {}, remove: async () => {},
  };
  const worker = await startSandboxCallbackBridgeWorker({
    client, queueDir: '/fixture/retained-session', pollIntervalMs: 500,
    handleRequest: async () => ({ status: 403, body: 'No active GitHub run' }),
  });
  await vi.advanceTimersByTimeAsync(0);
  const before = listCalls;
  await vi.advanceTimersByTimeAsync(120_000);
  const callsWithoutRun = listCalls - before;
  console.log(JSON.stringify({ simulatedMs: 120_000, intervalMs: 500, callsWithoutRun }));
  const stopped = worker.stop({ drainTimeoutMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);
  await stopped;
  vi.useRealTimers();
  expect(callsWithoutRun).toBe(0);
});
