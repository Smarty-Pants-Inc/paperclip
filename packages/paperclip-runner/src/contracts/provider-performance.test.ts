import { describe, expect, it } from "vitest";
import { parseProviderPerformanceSpans } from "./provider-performance.js";

const now = 1_800_000_000_000;
const day = 86_400_000;
const instant = (at = now) => ({ name: "pi.request.sent", startedAtMs: at, endedAtMs: at, outcome: "ok" });
const parse = (spans: unknown[], observedAtMs = now) => parseProviderPerformanceSpans({ code: "provider_performance_spans", spans }, observedAtMs);
// Independent literals are the acceptance contract, not a copy of an implementation's allowlist.
const existingPhases = [
  "provider.context.environment", "provider.context.instructions", "provider.skills.discovery",
  "provider.tools.resolve", "provider.model.resolve", "provider.model.stream",
  "provider.workspace.snapshot.track", "provider.workspace.snapshot.patch", "provider.workspace.snapshot.diff",
  "provider.workspace.git.discover", "provider.workspace.git.default_branch",
  "provider.dependencies.install", "provider.plugins.initialize",
];

// Keep reason: data safety and a cross-provider closed diagnostic contract at server/facade ingress.
describe("closed provider-performance timing admission", () => {
  it("admits the exact Pi pre-dispatch logical-request instant (not a physical-wire/internal HTTP-attempt duration) and projects timing fields only", () => {
    const row = { ...instant(), prompt: "PRIVATE_PROMPT", provider: "forged", runId: "forged", attributes: { Authorization: "PRIVATE_TOKEN" } };
    const before = JSON.stringify(row);
    expect(parse([row])).toEqual([instant()]);
    expect(JSON.stringify(row)).toBe(before);
    expect(parse(existingPhases.map(name => ({ name, startedAtMs: now - 20, endedAtMs: now, outcome: "failed", prompt: "PRIVATE" }))))
      .toEqual(existingPhases.map(name => ({ name, startedAtMs: now - 20, endedAtMs: now, outcome: "failed" })));
  });

  it("retains freshness edges and rejects lookalike phases, malformed times and nonzero Pi durations", () => {
    expect(parse([instant(now - day), instant(now + 1000)])).toEqual([instant(now - day), instant(now + 1000)]);
    const invalid: unknown[] = [
      null, [], "pi.request.sent", {},
      { ...instant(), name: "pi.request.sent.extra" }, { ...instant(), name: "pi.request" },
      { ...instant(), name: "pi.request.sent " }, { ...instant(), name: "Pi.request.sent" },
      { ...instant(), name: "__proto__" }, { ...instant(), name: "toString" },
      { ...instant(), startedAtMs: String(now) }, { ...instant(), endedAtMs: String(now) },
      { ...instant(), startedAtMs: NaN }, { ...instant(), endedAtMs: Infinity },
      { ...instant(), startedAtMs: -Infinity },
      { ...instant(), endedAtMs: now + 1 }, { ...instant(), startedAtMs: now + 1 },
      instant(now - day - 1), instant(now + 1001),
    ];
    expect(parse(invalid)).toEqual([]);
    expect(parseProviderPerformanceSpans({ code: "other", spans: [instant()] }, now)).toEqual([]);
    expect(parseProviderPerformanceSpans({ code: "provider_performance_spans", spans: {} }, now)).toEqual([]);
  });

  it("admits 24 per-hook batches including distinct same-millisecond requests, while retaining per-batch caps", () => {
    const result = Array.from({ length: 24 }, (_, index) => parse([instant(now + Math.floor(index / 2))])).flat();
    expect(result).toEqual(Array.from({ length: 24 }, (_, index) => instant(now + Math.floor(index / 2))));
    expect(parse(Array.from({ length: 40 }, () => instant()))).toEqual(Array.from({ length: 16 }, () => instant()));
    const rows = Array.from({ length: 140 }, (_, index) => ({
      name: existingPhases[index % existingPhases.length]!, startedAtMs: now - 20, endedAtMs: now, outcome: "ok",
    }));
    expect(parse(rows)).toEqual(rows.slice(0, 128));
  });
});
