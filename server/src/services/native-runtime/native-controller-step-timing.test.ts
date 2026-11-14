import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterRuntimeEvent } from "../../adapters/index.js";
import { createNativeRunTrace } from "./native-run-trace.js";
import { createNativeControllerStepTiming, measureNativeControllerStep, runWithNativeControllerSteps } from "./native-controller-step-timing.js";
import { measureRunnerOperation } from "./runner-operation-timing.js";

afterEach(() => vi.restoreAllMocks());

function spanPayloads(events: AdapterRuntimeEvent[]): Record<string, unknown>[] {
  return events.flatMap(event => event.eventType === "run.performance.span.batch" && Array.isArray(event.payload?.spans)
    ? event.payload.spans as Record<string, unknown>[] : []);
}

describe("controller warm-start wait attribution", () => {
  it("partitions nested waits across warm resume and submitted-to-started without double counting", async () => {
    let now = 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({ runId: "warm", startedAtMs: now, onEvent: async event => { events.push(event); } });
    const timing = createNativeControllerStepTiming(trace);
    await runWithNativeControllerSteps(timing, () => measureRunnerOperation("runner.transport.attach", async () => {
      now = 110;
      await measureNativeControllerStep("owner_read", async () => { now = 125; });
      now = 140;
    }));
    let finishRpc!: () => void;
    const rpc = runWithNativeControllerSteps(timing, () => measureRunnerOperation("runner.transport.turn_start", () => new Promise<void>(resolve => { finishRpc = resolve; })));
    now = 160;
    // The Runner emitted turn.submitted at 150; controller observation is later.
    await trace.record({ name: "runner.session.resume", startedAtMs: 100, endedAtMs: 150 });
    timing.flush("resume", 100, 150);
    await Promise.resolve();
    expect(spanPayloads(events).some(payload => String(payload.span).startsWith("native.controller."))).toBe(false);
    await runWithNativeControllerSteps(timing, () => measureNativeControllerStep("event_write", async () => { now = 175; }));
    now = 180;
    await trace.record({ name: "runner.turn.submitted_to_started", startedAtMs: 150, endedAtMs: 180 });
    timing.flush("submit", 150, 180);
    finishRpc();
    await rpc;
    await trace.finish("ok");
    const payloads = spanPayloads(events);
    for (const [phase, wrapperName] of [["resume", "runner.session.resume"], ["submit", "runner.turn.submitted_to_started"]] as const) {
      const wrapper = payloads.find(row => row.span === wrapperName)!;
      const children = payloads.filter(row => String(row.span).startsWith(`native.controller.${phase}.`));
      expect(children.length).toBeGreaterThan(0);
      expect(children.reduce((sum, row) => sum + Number(row.durationMs), 0)).toBeLessThanOrEqual(Number(wrapper.durationMs));
      for (const child of children) {
        expect(child.parentSpan).toBe(wrapperName);
        expect(child.schema).toBe("paperclip.run-performance-span.v1");
        expect(child.durationMs).toBeGreaterThanOrEqual(0);
        expect(child.wallStartedAtMs).toBeGreaterThanOrEqual(Number(wrapper.wallStartedAtMs));
        expect(Number(child.wallStartedAtMs) + Number(child.durationMs)).toBeLessThanOrEqual(Number(wrapper.wallStartedAtMs) + Number(wrapper.durationMs));
      }
    }
    expect(payloads.find(row => row.span === "native.controller.resume.owner_read")?.durationMs).toBe(15);
    expect(payloads.find(row => row.span === "native.controller.submit.event_write")?.durationMs).toBe(15);
  });

  it("keeps zero-duration receipts and clamps a backwards milestone like the wrapper", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const events: AdapterRuntimeEvent[] = [];
    const trace = createNativeRunTrace({ runId: "zero", onEvent: async event => { events.push(event); } });
    const timing = createNativeControllerStepTiming(trace);
    await timing.measure("env_resolution", async () => undefined);
    timing.flush("resume", 100, 90);
    timing.finish();
    await trace.finish("ok");
    expect(spanPayloads(events).find(payload => payload.span === "native.controller.resume.env_resolution"))
      .toMatchObject({ durationMs: 0, wallStartedAtMs: 100, outcome: "ok" });
  });

  it("preserves results and failures, and never waits for the diagnostic sink", async () => {
    let now = 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const events: AdapterRuntimeEvent[] = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const trace = createNativeRunTrace({ runId: "warm", onEvent: async event => { events.push(event); await barrier; } });
    const timing = createNativeControllerStepTiming(trace);
    const failure = new Error("private credential failure");
    await expect(timing.measure("credential_projection", async () => { now = 110; throw failure; })).rejects.toBe(failure);
    await expect(timing.measure("env_resolution", async () => { now = 120; return 42; })).resolves.toBe(42);
    timing.flush("resume", 100, 120);
    timing.finish();
    // Flush/finish returned although every diagnostic write is blocked.
    release();
    await trace.finish("ok");
    expect(spanPayloads(events).some(payload => payload.span === "native.controller.resume.credential_projection" && payload.outcome === "failed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(failure.message);
  });

  it("binds a retained operation to the current attempt and tolerates a failed sink", async () => {
    const first = vi.fn(async (_event: AdapterRuntimeEvent) => {}), second = vi.fn(async (_event: AdapterRuntimeEvent) => { throw new Error("sink unavailable"); });
    const a = createNativeRunTrace({ runId: "a", onEvent: first });
    const b = createNativeRunTrace({ runId: "b", onEvent: second });
    const timingA = createNativeControllerStepTiming(a), timingB = createNativeControllerStepTiming(b);
    let now = 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const retained = () => measureRunnerOperation("runner.transport.resume", async () => { now += 10; return "same session"; });
    await expect(runWithNativeControllerSteps(timingA, retained)).resolves.toBe("same session");
    await expect(runWithNativeControllerSteps(timingB, retained)).resolves.toBe("same session");
    timingA.flush("resume", 100, 110);
    timingB.flush("resume", 110, 120);
    timingA.finish();
    timingB.finish();
    await a.finish("ok");
    await b.finish("ok");
    expect(first.mock.calls[0]![0].payload?.spans).toEqual(expect.arrayContaining([expect.objectContaining({ span: "native.controller.resume.transport_resume", wallStartedAtMs: 100 })]));
    expect(second.mock.calls[0]![0].payload?.spans).toEqual(expect.arrayContaining([expect.objectContaining({ span: "native.controller.resume.transport_resume", wallStartedAtMs: 110 })]));
  });
});
