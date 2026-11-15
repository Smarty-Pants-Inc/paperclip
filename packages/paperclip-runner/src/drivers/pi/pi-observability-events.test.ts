import { describe, expect, it } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { createPiObservabilityEvents } from "./pi-observability-events.js";

const event = (eventType: PrpEvent["eventType"], payload: Record<string, unknown> = {}, runId = "run", turnId = "turn"): PrpEvent => ({
  schema: "paperclip.prp.event.v1", sourceEventId: "event", sourceSeq: 1, sourceInstanceId: "runner", sourceKind: "runner",
  runId, normalizedSessionId: "normalized", turnId, eventType, schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(), payload,
});
const receipt = (payload: Record<string, unknown> = {}, runId = "run", turnId = "turn") => event("usage.reported", {
  runDeltaAvailable: true, accountingComplete: true, runDelta: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, providerCostUsd: 0.125 }, ...payload,
}, runId, turnId);
describe("Pi observability-only pure event projection", () => {
  it("A2.1: maps only usage.reported and drops EVERY cumulative usage item", () => {
    const project = createPiObservabilityEvents();
    project(event("turn.started"));
    const results = project(receipt({ providerRequestId: "provider-id" }));
    expect(results.at(-1)?.payload).toMatchObject({ kind: "usage", usageMessageId: "provider-id", usage: { input: 10, output: 2, cache: { read: 3, write: 4 }, costUsd: 0.125 } });
    expect(project(event("item.completed", { kind: "usage", usage: { total: { inputTokens: 999 } } }))).toEqual([]);
  });
  it("A2.2: absent provider ids get deterministic run-scoped ordinals, including across warm turns", () => {
    const project = createPiObservabilityEvents();
    project(event("turn.started"));
    const keys = [project(receipt()).at(-1)?.payload.usageMessageId, project(receipt()).at(-1)?.payload.usageMessageId];
    project(event("turn.completed")); project(event("turn.started", {}, "run", "turn2"));
    keys.push(project(receipt({}, "run", "turn2")).at(-1)?.payload.usageMessageId);
    expect(keys).toEqual(["run:1", "run:2", "run:3"]);
  });
  it.each([{ runDeltaAvailable: false }, { runDeltaAvailable: false, runDelta: {} }])("A2.3: skipped/compaction receipt marks incompleteness without a zero usage span: %j", payload => {
    const project = createPiObservabilityEvents(); project(event("turn.started"));
    const projected = project(receipt(payload));
    expect(projected.some(e => e.payload.kind === "usage")).toBe(false);
    expect(projected).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: "usageAccounting", incomplete: true, skipped: true }) }));
  });
  it("A2.4: pending subagent accounting is incomplete, not exact", () => {
    const project = createPiObservabilityEvents(); project(event("turn.started"));
    expect(project(receipt({ childUsage: "unknown", accountingComplete: false })).at(-1)?.payload).toMatchObject({ accountingComplete: false });
  });
  it("A2.5: provider cost wins over a catalog estimate", () => {
    const project = createPiObservabilityEvents(); project(event("turn.started"));
    expect(project(receipt({ estimatedCostUsd: 99 })).at(-1)?.payload).toMatchObject({ usage: { costUsd: 0.125 }, costProvenance: "provider_reported" });
  });
  it("A2.6/7: ONE submission, then consumed prompt fragments; no mutation of source events", () => {
    const project = createPiObservabilityEvents();
    const start = event("turn.started");
    const first = event("item.completed", { kind: "userMessage", text: "first" });
    const steer = event("item.completed", { kind: "userMessage", text: "steer" });
    const copy = structuredClone([start, first, steer]);
    const projected = [...project(start), ...project(first), ...project(receipt()), ...project(steer), ...project(event("turn.completed"))];
    expect(projected.filter(e => e.eventType === "turn.submitted")).toHaveLength(1);
    expect(projected.find(e => e.eventType === "turn.submitted")?.payload.text).toBe("first");
    expect(projected).toContainEqual(steer);
    expect([start, first, steer]).toEqual(copy);
  });
  it("empty prompt fallback precedes the first non-user turn event", () => {
    const project = createPiObservabilityEvents(); project(event("turn.started"));
    const output = project(receipt());
    expect(output[0]).toMatchObject({ eventType: "turn.submitted", payload: { text: "" } });
    expect(project(event("turn.completed")).some(e => e.eventType === "turn.submitted")).toBe(false);
  });
});
