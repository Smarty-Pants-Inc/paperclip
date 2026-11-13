import { describe, expect, it } from "vitest";
import type { ProviderPerformanceSpan } from "../../contracts/provider-performance.js";
import { PiPerformance, piRpcPerformancePhase } from "./pi-performance.js";

describe("Pi content-free performance observations", () => {
  it("keeps exact elapsed bounds, finishes once, and buffers only 128 completed rows", () => {
    let now = 1000;
    const performance = new PiPerformance(() => now);
    const finish = performance.start("provider.pi.admission");
    now = 1017;
    finish("failed");
    now = 900; // A reversed observation is absent, not a fabricated zero.
    finish("ok");
    performance.start("provider.pi.admission", 1000)("ok");
    now = 1050;
    for (let i = 0; i < 200; i++) performance.start("provider.pi.rpc.get_state")("ok");
    const spans: ProviderPerformanceSpan[] = [];
    performance.setSink(span => { spans.push(span); });
    expect(spans).toHaveLength(128);
    expect(spans[0]).toEqual({ name: "provider.pi.admission", startedAtMs: 1000, endedAtMs: 1017, outcome: "failed" });
    expect(spans.every(span => Object.keys(span).sort().join() === "endedAtMs,name,outcome,startedAtMs")).toBe(true);
  });

  it("drops invalid bounds and isolates throwing sinks without repeating work", () => {
    const performance = new PiPerformance(() => 1100);
    let calls = 0;
    performance.setSink(() => { calls++; throw new Error("sink sentinel"); });
    expect(() => performance.start("provider.pi.admission", 1000)("ok")).not.toThrow();
    for (const start of [NaN, Infinity, -1, 1200, 1100 - 86_400_001]) {
      performance.start("provider.pi.admission", start)("failed");
    }
    expect(calls).toBe(1);
    performance.setSink();
    performance.start("provider.pi.admission", 1000)("ok");
    const spans: ProviderPerformanceSpan[] = [];
    performance.setSink(span => { spans.push(span); });
    expect(spans).toHaveLength(1);
  });

  it("observes rejected async sink callbacks without waiting on them", async () => {
    const performance = new PiPerformance(() => 1100);
    performance.setSink(async () => { throw new Error("async sink sentinel"); });
    expect(() => performance.start("provider.pi.admission", 1000)("ok")).not.toThrow();
    await Promise.resolve();
  });

  it("uses only the agreed real RPC names, never prompts, payloads or optional imports", () => {
    expect(["get_state", "set_model", "get_available_thinking_levels", "set_thinking_level", "get_commands"].map(piRpcPerformancePhase))
      .toEqual(["provider.pi.rpc.get_state", "provider.pi.rpc.set_model", "provider.pi.rpc.get_available_thinking_levels", "provider.pi.rpc.set_thinking_level", "provider.pi.rpc.get_commands"]);
    expect(piRpcPerformancePhase("prompt")).toBeUndefined();
    expect(piRpcPerformancePhase("/secret/path")).toBeUndefined();
  });
});
