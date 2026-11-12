import { describe, expect, it, vi } from "vitest";

// Keep this recorder test independent of server boot, the DB and exporter initialization.
// The writer and trace under test are real; only ambient parent/exporter discovery is cut.
vi.mock("../execution-preparation-timing.js", () => ({ getRunExecutionTraceContext: () => undefined }));
vi.mock("../../instrumentation.js", () => ({ getStartupTraceContext: () => { throw new Error("inject a trace context"); } }));
vi.mock("@paperclipai/adapter-utils/acpx-engine/startup-timing", () => ({ runWithRuntimeParent: (_parent: unknown, work: () => unknown) => work() }));
import { createNativeRunTrace, recordNativeProviderPerformanceSpans } from "./native-run-trace.js";

type TraceInput = Parameters<typeof createNativeRunTrace>[0];
type RunEvent = Parameters<NonNullable<TraceInput["onEvent"]>>[0];
type RecordedSpan = { name: string; parentName: string | null; endedAtMs: unknown };
function context() {
  const spans: RecordedSpan[] = [];
  const records = new WeakMap<object, RecordedSpan>();
  const traceContext: NonNullable<TraceInput["traceContext"]> = {
    tracer: {
      startSpan(name, _options, parentContext) {
        const parent = (parentContext as { span?: RecordedSpan } | undefined)?.span;
        const record: RecordedSpan = { name, parentName: parent?.name ?? null, endedAtMs: null };
        spans.push(record);
        const span = { setAttribute() {}, setStatus() {}, end(at?: unknown) { record.endedAtMs = at; } };
        records.set(span, record);
        return span;
      },
    },
    contextWithSpan(span) { return { span: typeof span === "object" && span !== null ? records.get(span) : undefined }; },
  };
  return { traceContext, spans };
}
const instant = (at: number) => ({ name: "pi.request.sent", startedAtMs: at, endedAtMs: at, outcome: "ok" as const });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const requestRows = (events: RunEvent[]) => events.filter(event => event.eventType === "run.performance.span" && event.payload?.span === "pi.request.sent");

// Keep reason: the durable diagnostic -> local run-log boundary currently disables all child writes.
// These inputs are already normalized; source/provider authorization belongs to the executor, not this recorder.
describe("native Pi logical-request instant persistence (not physical wire/internal HTTP-attempt evidence)", () => {
  it("writes the Pi instant once with its original wall time, zero duration and native execution hierarchy, while OpenCode phases remain nonduplicated", async () => {
    const events: RunEvent[] = [];
    const { traceContext, spans } = context();
    const trace = createNativeRunTrace({ runId: "pi-request-run", startedAtMs: 1000, traceContext, onEvent: async event => { events.push(event); } });
    const execute = trace.start("native.session.execute", { startedAtMs: 1100 });
    await recordNativeProviderPerformanceSpans(trace, [
      { name: "provider.context.environment", startedAtMs: 1150, endedAtMs: 1200 },
      { ...instant(1234), attributes: { prompt: "PRIVATE_PROMPT", provider: "forged-provider", runId: "forged-run" } },
      { name: "provider.model.stream", startedAtMs: 1250, endedAtMs: 1300 },
    ]);
    await trace.end(execute, { endedAtMs: 1400 });
    await trace.finish("ok");
    const rows = requestRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "run.performance.span", stream: "system", level: "info", payload: {
      schema: "paperclip.run-performance-span.v1", span: "pi.request.sent", parentSpan: "provider.runtime",
      startOffsetMs: 234, durationMs: 0, wallStartedAtMs: 1234, outcome: "ok",
    } });
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|forged|prompt|attributes/);
    expect(events.filter(event => ["provider.runtime", "provider.context.environment", "provider.model.stream"].includes(String(event.payload?.span)))).toEqual([]);
    expect(spans.find(span => span.name === "provider.runtime")).toMatchObject({ parentName: "native.session.execute", endedAtMs: 1300 });
    expect(spans.find(span => span.name === "pi.request.sent")).toMatchObject({ parentName: "provider.runtime", endedAtMs: 1234 });
  });

  it("settles 24 distinct per-hook instants including same-millisecond requests instead of a 16-per-run cap or timestamp dedupe", async () => {
    const events: RunEvent[] = [];
    const trace = createNativeRunTrace({ runId: "long-pi-turn", startedAtMs: 1000, traceContext: context().traceContext, onEvent: async event => { events.push(event); } });
    for (let index = 0; index < 24; index++) await recordNativeProviderPerformanceSpans(trace, [instant(1200 + Math.floor(index / 2))]);
    await trace.finish("ok");
    expect(requestRows(events).map(event => ({ at: event.payload?.wallStartedAtMs, duration: event.payload?.durationMs })))
      .toEqual(Array.from({ length: 24 }, (_, index) => ({ at: 1200 + Math.floor(index / 2), duration: 0 })));
  });

  it("does not hold native event progress behind a blocked Pi run-log sink, but finish drains the accepted instant", async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const events: RunEvent[] = [];
    const trace = createNativeRunTrace({ runId: "blocked-pi-sink", startedAtMs: 1000, traceContext: context().traceContext,
      onEvent: async event => { events.push(event); if (event.payload?.span === "pi.request.sent") await barrier; },
    });
    let returned = false;
    const work = recordNativeProviderPerformanceSpans(trace, [instant(1234)]).then(() => { returned = true; });
    try {
      await tick();
      expect(returned, "diagnostic persistence must not stall the committed-event observer").toBe(true);
      expect(requestRows(events)).toHaveLength(1);
    } finally { release(); await work; await trace.finish("ok"); }
    expect(requestRows(events)).toHaveLength(1);
  });

  it("fails open on a rejected Pi diagnostic sink and does not synthesize Pi measurements for absent/OpenCode-only diagnostics", async () => {
    const events: RunEvent[] = [];
    const trace = createNativeRunTrace({ runId: "failed-pi-sink", startedAtMs: 1000, traceContext: context().traceContext,
      onEvent: async event => { events.push(event); if (event.payload?.span === "pi.request.sent") throw new Error("sink unavailable"); },
    });
    await expect(recordNativeProviderPerformanceSpans(trace, [instant(1234)])).resolves.toBeUndefined();
    await expect(trace.finish("ok")).resolves.toBeUndefined();
    expect(requestRows(events)).toHaveLength(1);
    const absentEvents: RunEvent[] = [];
    const absent = createNativeRunTrace({ runId: "no-pi-feature", startedAtMs: 1000, traceContext: context().traceContext, onEvent: async event => { absentEvents.push(event); } });
    await recordNativeProviderPerformanceSpans(absent, []);
    await recordNativeProviderPerformanceSpans(absent, [{ name: "provider.model.stream", startedAtMs: 1100, endedAtMs: 1200 }]);
    await absent.finish("ok");
    expect(requestRows(absentEvents)).toEqual([]);
    expect(absentEvents.filter(event => event.payload?.span === "provider.model.stream")).toEqual([]);
  });
});
