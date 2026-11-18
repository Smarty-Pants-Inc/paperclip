import { describe, expect, it } from "vitest";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import { createPiEventProjector, type PiEventOrigin } from "./pi-event-projector.js";

const origin = { runId: "driver-run", turnId: "driver-turn" };
const usage = { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.01 } };

// Keep reason: ownership/data-safety boundary. All output constructors must
// preserve driver attribution, including non-item diagnostics and accounting.
describe("driver-owned Pi projection origin", () => {
  it("stamps every output family, ignoring ownership claimed by native payloads", () => {
    const projector = createPiEventProjector({ ...origin, includeThinking: true });
    const events = [
      { type: "message_start", message: { role: "user", timestamp: 42, content: [{ type: "text", text: "steering-marker" }] } },
      { type: "message_end", message: { role: "user", timestamp: 42, content: [{ type: "text", text: "steering-marker" }] } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "reason" } },
      { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "exit 7" } },
      { type: "tool_execution_update", toolCallId: "call", toolName: "bash", partialResult: { content: [{ type: "text", text: "working" }] } },
      { type: "tool_execution_end", toolCallId: "call", toolName: "bash", result: { content: [{ type: "text", text: "failed" }] }, isError: true },
      { type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", responseId: "reply", stopReason: "stop", usage, content: [{ type: "text", text: "final" }, { type: "thinking", thinking: "reason" }] } },
      { type: "message_end", message: { role: "toolResult", toolCallId: "call", toolName: "bash", usage, content: [] } },
      { type: "compaction_start" },
      { type: "compaction_end", reason: "threshold", result: { tokensBefore: 100, estimatedTokensAfter: 20 } },
      { type: "extension_ui_request", method: "confirm" },
      { type: "queue_update" },
      { type: "message_update", assistantMessageEvent: { type: "future_nested_event" } },
      { type: "future_event" },
    ].flatMap(event => projector.project({ ...event, runId: "untrusted-run", turnId: "untrusted-turn" }));
    expect(new Set(events.map(event => event.eventType))).toEqual(new Set([
      "item.started", "item.delta", "item.failed", "item.completed", "usage.reported",
      "tool.execution.started", "tool.execution.progressed", "tool.execution.completed",
      "context.compacted", "harness.diagnostic",
    ]));
    for (const [index, event] of events.entries()) {
      expect(event).toMatchObject(origin);
      expect(validatePrpEvent({
        schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `origin-${index}`,
        sourceSeq: index + 1, sourceInstanceId: "origin-regression", sourceKind: "runner",
        normalizedSessionId: "session", priority: 1, emittedAt: "2026-11-12T06:50:00.000Z", ...event,
      })).toMatchObject({ ok: true });
    }
  });

  it("does not let mutation of a returned record change the captured origin", () => {
    const projector = createPiEventProjector(origin);
    const first = projector.project({ type: "unknown-first" })[0];
    first.runId = "changed-run"; first.turnId = "changed-turn";
    expect(projector.project({ type: "unknown-next" })[0]).toMatchObject(origin);
  });

  it("keeps the origin on the bounded diagnostic suppression record", () => {
    const projector = createPiEventProjector(origin);
    const events = Array.from({ length: 20 }, (_, index) => projector.project({ type: `unknown-${index}` })).flat();
    expect(events).toHaveLength(17);
    expect(events.at(-1)).toMatchObject({ ...origin, payload: { code: "pi_diagnostics_suppressed" } });
  });

  it.each(["runId", "turnId"] as const)("requires an explicit bounded driver %s", field => {
    for (const value of [undefined, null, 0, "", "x".repeat(241)]) {
      const invalid = { ...origin, [field]: value } as unknown as PiEventOrigin;
      expect(() => createPiEventProjector(invalid)).toThrow(`pi_projection_${field === "runId" ? "run" : "turn"}_id_invalid`);
    }
    expect(() => createPiEventProjector({ ...origin, [field]: "x".repeat(240) })).not.toThrow();
  });
});
