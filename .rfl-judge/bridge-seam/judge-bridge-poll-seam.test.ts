import { afterEach, describe, expect, it, vi } from "vitest";
import { startSandboxCallbackBridgeWorker } from "./sandbox-callback-bridge.js";

const ENV = "PAPERCLIP_SANDBOX_CALLBACK_BRIDGE_POLL_INTERVAL_MS";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function withWorker(
  env: string | undefined,
  check: (state: { list: ReturnType<typeof vi.fn>; ready: () => void; responses: number[]; handled: () => number; warnings: ReturnType<typeof vi.spyOn> }) => Promise<void>,
  explicitInterval?: number | null,
) {
  vi.stubEnv(ENV, env);
  vi.useFakeTimers();
  let ready = false;
  let handled = 0;
  const responses: number[] = [];
  const list = vi.fn(async () => ready ? ["judge-request.json"] : []);
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const worker = await startSandboxCallbackBridgeWorker({
    client: {
      makeDir: async () => {}, makeDirs: async () => {}, listJsonFiles: list,
      readTextFile: async () => JSON.stringify({ id: "judge-request", method: "POST", path: "/api/issues/judge/comments", query: "", headers: {}, body: "{}" }),
      writeTextFile: async (_path, body) => { responses.push(JSON.parse(body).status); },
      rename: async () => {}, remove: async () => { ready = false; },
    },
    queueDir: "/judge-only/queue",
    ...(explicitInterval === undefined ? {} : { pollIntervalMs: explicitInterval }),
    authorizeRequest: async () => null,
    handleRequest: async () => { handled++; return { status: 200, body: "ok" }; },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await check({ list, ready: () => { ready = true; }, responses, handled: () => handled, warnings });
  } finally {
    const stopped = worker.stop();
    await vi.runAllTimersAsync();
    await stopped;
  }
}

describe("independent RFL interval safety", () => {
  for (const env of ["0", "-1", "not-a-number", "Infinity", "", "2147483648", "1e12", "0.5"]) {
    it(`invalid/unsafe ${JSON.stringify(env)} must not produce a near-zero poll storm`, async () => {
      await withWorker(env, async ({ list }) => {
        await vi.advanceTimersByTimeAsync(99);
        console.info(JSON.stringify({ env, elapsedMs: 99, queueLists: list.mock.calls.length }));
        // Default/fallback is 100 ms. A safe larger clamp also satisfies this.
        expect(list.mock.calls.length).toBe(1);
      });
    });
  }
  it("a large finite configuration must not falsely fail a healthy queued callback", async () => {
    await withWorker("60000", async ({ ready, responses, handled, warnings }) => {
      await vi.advanceTimersByTimeAsync(1000);
      ready();
      await vi.advanceTimersByTimeAsync(19000);
      console.info(JSON.stringify({ env: "60000", elapsedMs: 20000, responses, handled: handled(), warnings: warnings.mock.calls }));
      expect(warnings).not.toHaveBeenCalled();
      expect(responses).not.toContain(503);
    });
  });
  it("a request arriving just after a 1000 ms poll is handled at the next poll, exactly once", async () => {
    await withWorker("1000", async ({ list, ready, handled, responses }) => {
      await vi.advanceTimersByTimeAsync(1);
      ready();
      await vi.advanceTimersByTimeAsync(998);
      expect(handled()).toBe(0);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(handled()).toBe(1);
      expect(responses).toEqual([200]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(handled()).toBe(1);
    });
  });
  it("an explicit upstream parameter takes precedence over the environment", async () => {
    await withWorker("1000", async ({ list }) => {
      await vi.advanceTimersByTimeAsync(99);
      expect(list).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledTimes(2);
    }, 100);
  });
});
