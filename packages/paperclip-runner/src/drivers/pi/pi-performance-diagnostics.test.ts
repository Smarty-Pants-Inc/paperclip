import { describe, expect, it } from "vitest";
import { piPerformanceEntrySpans } from "./pi-performance-diagnostics.js";

const at = 1_800_000_000_000;
const instant = { name: "pi.request.sent", startedAtMs: at, endedAtMs: at, outcome: "ok" };
const entry = (spans: unknown[]) => ({ type: "custom", customType: "paperclip.provider-performance.v1",
  data: { code: "provider_performance_spans", spans } });

describe("Pi-owned performance entry field projection", () => {
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
