import { describe, expect, it, vi } from "vitest";
vi.mock("../execution-preparation-timing.js", () => ({ getRunExecutionTraceContext: () => undefined }));
vi.mock("../../instrumentation.js", () => ({ getStartupTraceContext: () => { throw new Error("inject a trace context"); } }));
vi.mock("@paperclipai/adapter-utils/acpx-engine/startup-timing", () => ({ runWithRuntimeParent: (_parent: unknown, work: () => unknown) => work() }));
import { parseProviderPerformanceSpans } from "../../vendor/paperclip-runner/index.js";
import { createNativeRunTrace, recordNativeProviderPerformanceSpans } from "./native-run-trace.js";

type TraceInput = Parameters<typeof createNativeRunTrace>[0];
type RunEvent = Parameters<NonNullable<TraceInput["onEvent"]>>[0];
// Keep reason: the runner diagnostic reader and durable native run log are a
// trust boundary. Unknown names/attributes must not silently lose inventory.
describe("native Pi bind exchange reader persistence", () => {
  it.each(["ok", "failed"] as const)("persists tool_inventory with its original duration and %s outcome", async outcome => {
    const events: RunEvent[] = [];
    const traceContext: NonNullable<TraceInput["traceContext"]> = {
      tracer: { startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }) }, contextWithSpan: () => ({}),
    };
    const trace = createNativeRunTrace({ runId: "inventory-run", startedAtMs: 1000, traceContext, onEvent: async event => { events.push(event); } });
    const spans = parseProviderPerformanceSpans({ code: "provider_performance_spans", spans: [{ name: "runner.pi.tool_inventory", startedAtMs: 1200, endedAtMs: 1320, outcome,
      attributes: { timeoutCode: "pi_bind_timeout", prompt: "PRIVATE", nonce: "PRIVATE" } }] }, 1400);
    expect(spans).toHaveLength(1);
    // The production executor records runner diagnostics inside its open
    // native.session.execute scope; without it parentFor() falls back to
    // task.provider_session and the row would not test the native hierarchy.
    const execute = trace.start("native.session.execute", { startedAtMs: 1100 });
    await recordNativeProviderPerformanceSpans(trace, spans);
    await trace.end(execute, { endedAtMs: 1400 });
    await trace.finish("ok");
    const rows = events.filter(event => event.payload?.span === "runner.pi.tool_inventory");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "run.performance.span", level: outcome === "failed" ? "warn" : "info", payload: {
      span: "runner.pi.tool_inventory", parentSpan: "native.session.execute", wallStartedAtMs: 1200, startOffsetMs: 200, durationMs: 120, outcome,
      ...(outcome === "failed" ? { timeoutCode: "pi_bind_timeout" } : {}),
    } });
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|nonce|prompt/);
  });
});
