import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_PROVIDER_PERFORMANCE_SPANS,
  PROVIDER_PERFORMANCE_DIAGNOSTIC,
  PROVIDER_PERFORMANCE_PHASES,
  parseProviderPerformanceSpans,
} from "./provider-performance.js";

const piPhases = [
  "provider.pi.proxy.ready", "provider.pi.facade.initialize",
  "provider.pi.thread.start", "provider.pi.thread.resume", "provider.pi.process.spawn",
  "provider.pi.admission", "provider.pi.rpc.get_state", "provider.pi.rpc.set_model",
  "provider.pi.rpc.get_available_thinking_levels", "provider.pi.rpc.set_thinking_level",
  "provider.pi.rpc.get_commands",
];
const observedAtMs = 100_000_000;
const row = (name: string, extra: Record<string, unknown> = {}) => ({
  name, startedAtMs: observedAtMs - 10, endedAtMs: observedAtMs, outcome: "ok", ...extra,
});
const parse = (spans: unknown[]) => parseProviderPerformanceSpans({
  code: PROVIDER_PERFORMANCE_DIAGNOSTIC, spans,
}, observedAtMs);

describe("provider performance carrier", () => {
  it("admits exactly the agreed Pi names and keeps the Rust carrier allowlist synchronized", () => {
    expect(PROVIDER_PERFORMANCE_PHASES.filter(name => name.startsWith("provider.pi."))).toEqual(piPhases);
    expect(parse(piPhases.map(name => row(name))).map(span => span.name)).toEqual(piPhases);
    // Trust-boundary contract guard, in addition to both normalizers' behavioral tests.
    const rust = readFileSync(new URL("../../runner/crates/runner-core/src/provider_events.rs", import.meta.url), "utf8");
    const sanitizer = rust.slice(rust.indexOf("fn provider_performance_spans("), rust.indexOf("/// A Codex reasoning"));
    const rustNames = [...sanitizer.matchAll(/"(provider\.[a-z_.]+)"/g)].map(match => match[1]);
    expect([...new Set(rustNames)].sort()).toEqual([...PROVIDER_PERFORMANCE_PHASES].sort());
    expect(parse([
      row("provider.pi.rpc.unknown"), row("provider.pi.extension.import"), row("provider.pi.probe.hello"),
    ])).toEqual([]);
  });

  it("projects only four existing fields, strips private sentinels, and retains failure", () => {
    const spans = parseProviderPerformanceSpans({
      code: PROVIDER_PERFORMANCE_DIAGNOSTIC,
      prompt: "private-sentinel",
      spans: [row("provider.pi.admission", {
        outcome: "failed", prompt: "private-sentinel", path: "private-sentinel",
        threadId: "private-sentinel", attributes: { token: "private-sentinel" },
      }), row("provider.pi.rpc.get_state", { outcome: "private-sentinel" })],
    }, observedAtMs);
    expect(spans).toEqual([
      { name: "provider.pi.admission", startedAtMs: observedAtMs - 10, endedAtMs: observedAtMs, outcome: "failed" },
      { name: "provider.pi.rpc.get_state", startedAtMs: observedAtMs - 10, endedAtMs: observedAtMs, outcome: "ok" },
    ]);
    expect(JSON.stringify(spans)).not.toContain("private-sentinel");
  });

  it("preserves finite ordered bounds, freshness, duration and per-name caps", () => {
    expect(parse([
      row("provider.pi.admission", { startedAtMs: Number.NaN }),
      row("provider.pi.admission", { endedAtMs: Number.POSITIVE_INFINITY }),
      row("provider.pi.admission", { startedAtMs: observedAtMs + 1 }),
      row("provider.pi.admission", { startedAtMs: observedAtMs - 86_400_001 }),
      row("provider.pi.admission", { endedAtMs: observedAtMs + 1_001 }),
      row("provider.pi.admission", { startedAtMs: observedAtMs - 86_400_000, endedAtMs: observedAtMs + 1 }),
      null, [], "private-sentinel",
    ])).toEqual([]);
    expect(parse(Array.from({ length: 30 }, () => row("provider.pi.rpc.get_state")))).toHaveLength(16);
    const boundary = row("provider.pi.admission", { startedAtMs: observedAtMs - 86_400_000 });
    expect(parse([boundary, row("provider.pi.rpc.get_state", { endedAtMs: observedAtMs + 1_000 })])).toHaveLength(2);
  });

  it("inspects at most 128 rows and rejects unrelated diagnostic envelopes", () => {
    const spans = Array.from({ length: MAX_PROVIDER_PERFORMANCE_SPANS }, (_, index) =>
      row(PROVIDER_PERFORMANCE_PHASES[index % PROVIDER_PERFORMANCE_PHASES.length]));
    expect(parse([...spans, row("provider.pi.admission")])).toHaveLength(MAX_PROVIDER_PERFORMANCE_SPANS);
    for (const payload of [null, [], { code: "other", spans }, { code: PROVIDER_PERFORMANCE_DIAGNOSTIC, spans: {} }]) {
      expect(parseProviderPerformanceSpans(payload, observedAtMs)).toEqual([]);
    }
  });
});
