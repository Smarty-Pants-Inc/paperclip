import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../config.js";
import { createLifecycleWorker } from "../application/worker.js";
import type { LifecycleStore } from "../application/ports.js";

async function observedConcurrency(concurrency: number) {
  let active = 0;
  let maximum = 0;
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const store = {
    async pending() { return Array.from({ length: 16 }, (_, index) => `agent-${index}`); },
    async claim() {
      active++;
      started++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return null;
    },
  } as unknown as LifecycleStore;
  const worker = createLifecycleWorker(store, {
    requiredPluginIds: async () => [],
    runHost: async () => "complete",
    runPlugin: async () => "complete",
  }, () => {}, undefined, concurrency);
  const sweep = worker.sweep();
  while (started < Math.min(concurrency, 16)) await new Promise(resolve => setTimeout(resolve, 0));
  release();
  await sweep;
  await worker.stop();
  return maximum;
}

describe("agent lifecycle worker concurrency", () => {
  it("defaults to four loops and honors PAPERCLIP_AGENT_LIFECYCLE_CONCURRENCY=16", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_LIFECYCLE_CONCURRENCY", "");
    expect(loadConfig().agentLifecycleConcurrency).toBe(4);
    expect(await observedConcurrency(loadConfig().agentLifecycleConcurrency)).toBe(4);

    vi.stubEnv("PAPERCLIP_AGENT_LIFECYCLE_CONCURRENCY", "16");
    expect(loadConfig().agentLifecycleConcurrency).toBe(16);
    expect(await observedConcurrency(loadConfig().agentLifecycleConcurrency)).toBe(16);
    vi.unstubAllEnvs();
  });
});
