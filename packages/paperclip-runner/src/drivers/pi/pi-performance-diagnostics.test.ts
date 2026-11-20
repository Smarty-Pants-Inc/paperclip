import { describe, expect, it, vi } from "vitest";
import { measurePiExtensionOpen, piExtensionOpenPerformanceSpans, piPerformanceEntrySpans, piPerformanceSpanBatches, startPiExtensionOpenSpan } from "./pi-performance-diagnostics.js";
import { parseProviderPerformanceSpans, type ProviderPerformanceSpan } from "../../contracts/provider-performance.js";

const at = 1_800_000_000_000;
const instant = { name: "pi.request.sent", startedAtMs: at, endedAtMs: at, outcome: "ok" };
const entry = (spans: unknown[]) => ({ type: "custom", customType: "paperclip.provider-performance.v1",
  data: { code: "provider_performance_spans", spans } });

describe("Pi-owned performance entry field projection", () => {
  // Unit test agreed in task brief: startup spans need a deterministic clock to
  // prove ordering, containment/sums, failure outcome and no diagnostic effects.
  it("emits ordered extension siblings whose non-negative durations sum to at most the factory", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let clock = at;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    const sentinel = new Error("unchanged factory failure");
    try {
      const result = measurePiExtensionOpen("runner.pi.open.extension_factory", () => {
        measurePiExtensionOpen("runner.pi.open.extension_initial_read", () => 1);
        return measurePiExtensionOpen("runner.pi.open.extension_composition", () => 42);
      });
      expect(result).toBe(42);
      const spans = log.mock.calls.flatMap(([line]) => piExtensionOpenPerformanceSpans(String(line), at + 100));
      expect(spans.map(span => span.name)).toEqual(["runner.pi.open.extension_initial_read", "runner.pi.open.extension_composition", "runner.pi.open.extension_factory"]);
      const parent = spans.at(-1)!;
      const children = spans.slice(0, -1);
      for (const span of spans) {
        expect(span.endedAtMs - span.startedAtMs).toBeGreaterThanOrEqual(0);
        expect(span.startedAtMs).toBeGreaterThanOrEqual(parent.startedAtMs);
        expect(span.endedAtMs).toBeLessThanOrEqual(parent.endedAtMs);
      }
      expect(children.reduce((sum, span) => sum + span.endedAtMs - span.startedAtMs, 0))
        .toBeLessThanOrEqual(parent.endedAtMs - parent.startedAtMs);
      expect(() => measurePiExtensionOpen("runner.pi.open.extension_factory", () => { throw sentinel; })).toThrow(sentinel);
      expect(piExtensionOpenPerformanceSpans(String(log.mock.calls.at(-1)![0]), at + 100)[0]?.outcome).toBe("failed");
      now.mockReturnValue(at + 200);
      const finish = startPiExtensionOpenSpan("runner.pi.open.extension_tools");
      now.mockReturnValue(at + 100); finish();
      const backwards = piExtensionOpenPerformanceSpans(String(log.mock.calls.at(-1)![0]), at + 200)[0]!;
      expect(backwards.endedAtMs).toBe(backwards.startedAtMs);
      log.mockImplementation(() => { throw new Error("logging unavailable"); });
      expect(measurePiExtensionOpen("runner.pi.open.extension_factory", () => 42)).toBe(42);
      expect(() => measurePiExtensionOpen("runner.pi.open.extension_factory", () => { throw sentinel; })).toThrow(sentinel);
    } finally { now.mockRestore(); log.mockRestore(); }
  });

  it("accepts only bounded, closed extension startup timing fields from stderr", () => {
    const span = { name: "runner.pi.open.extension_factory", startedAtMs: at - 10, endedAtMs: at, outcome: "ok" };
    const line = (value: unknown) => "pi.open.span " + JSON.stringify({ code: "provider_performance_spans", spans: [value] });
    expect(piExtensionOpenPerformanceSpans(line({ ...span, apiKey: "PRIVATE", instructions: "PRIVATE" }), at)).toEqual([span]);
    for (const value of ["ordinary private stderr", "pi.open.span {bad}", line({ ...span, name: "provider.model.stream" }),
      line({ ...span, name: "runner.pi.open.get_state" }), line({ ...span, endedAtMs: at - 20 }), line({ ...span, name: "runner.pi.open.extension_unknown" }),
      line({ ...span, extra: "x".repeat(1024) })]) expect(piExtensionOpenPerformanceSpans(value, at)).toEqual([]);
  });
  // Keep reason: RFL's spanbatch review caught producer/consumer loss; these
  // boundaries must stay covered even when idle admissions drain individually.
  it.each(["repeated", "mixed"])("splits %s spans into lossless reader-visible diagnostics", shape => {
    const names = ["provider.context.environment", "provider.context.instructions", "provider.skills.discovery",
      "provider.tools.resolve", "provider.model.resolve", "provider.model.stream",
      "provider.workspace.snapshot.track", "provider.workspace.snapshot.patch", "provider.workspace.snapshot.diff",
      "provider.workspace.git.discover"] as const;
    const spans: ProviderPerformanceSpan[] = Array.from({ length: shape === "mixed" ? 214 : 40 }, (_, index) => ({
      name: shape === "mixed" && index < 140 ? names[index % names.length]! : "runner.pi.admission.get_state",
      startedAtMs: at - 1, endedAtMs: at, outcome: index % 2 ? "ok" : "failed",
    }));
    const diagnostics = [...piPerformanceSpanBatches(spans)].map(batch => ({ code: "provider_performance_spans", spans: batch }));
    expect(diagnostics.flatMap(diagnostic => diagnostic.spans)).toEqual(spans);
    const visible = diagnostics.flatMap(diagnostic => parseProviderPerformanceSpans(diagnostic, at));
    expect(visible).toEqual(spans);
    for (const name of new Set(spans.map(span => span.name))) {
      expect(visible.filter(span => span.name === name)).toHaveLength(spans.filter(span => span.name === name).length);
    }
    for (const diagnostic of diagnostics) {
      expect(diagnostic.spans.length).toBeLessThanOrEqual(128);
      for (const name of new Set(diagnostic.spans.map(span => span.name))) {
        expect(diagnostic.spans.filter(span => span.name === name).length).toBeLessThanOrEqual(16);
      }
    }
    if (shape === "mixed") expect(diagnostics[0]!.spans).toHaveLength(128);
    expect([...piPerformanceSpanBatches([])]).toEqual([]);
  });

  // Keep reason: opaque extension data must not enter JSON/redaction traversal.
  it("ignores opaque getters at every unowned field level", () => {
    const opaque = { enumerable: true, get() { throw new Error("PRIVATE"); } };
    const value = entry([Object.defineProperty({ ...instant }, "attributes", opaque)]);
    Object.defineProperty(value, "timestamp", opaque);
    Object.defineProperty(value.data, "payload", opaque);
    expect(piPerformanceEntrySpans(value, at)).toEqual([instant]);
  });
  it("keeps batch caps and excludes other providers' phases from this owned entry", () => {
    expect(piPerformanceEntrySpans(entry(Array.from({ length: 200 }, () => instant)), at)).toEqual(Array.from({ length: 16 }, () => instant));
    expect(piPerformanceEntrySpans(entry([{ ...instant, name: "provider.model.stream" }, { ...instant, endedAtMs: at + 1 }]), at)).toEqual([]);
  });
  it("fails closed for malformed owned timing getters and never reads foreign data", () => {
    const opaque = { enumerable: true, get() { throw new Error("PRIVATE"); } };
    expect(piPerformanceEntrySpans(entry([Object.defineProperty({ ...instant }, "startedAtMs", opaque)]), at)).toEqual([]);
    expect(piPerformanceEntrySpans(Object.defineProperty({ type: "custom", customType: "foreign" }, "data", opaque), at)).toEqual([]);
  });
});
