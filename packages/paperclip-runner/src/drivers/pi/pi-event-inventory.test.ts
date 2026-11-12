import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "./pi-event-projector.js";

// Closed inventory from Pi 1.5.2 docs/json.md:21-207 and rpc.md:23-44.
// These are synthetic boundary checks, not more real-dependency recordings.
describe("Pi RPC non-message event disposition", () => {
  it.each(["response", "session", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "extension_ui_response"])("leaves %s with its owning driver / journal", type => {
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type })).toEqual([]);
  });
  it.each(["queue_update", "entry_appended", "session_info_changed", "thinking_level_changed", "auto_retry_start", "auto_retry_end", "bash_execution_update", "extension_error"])("records bounded %s activity without granting authority", type => {
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type, arbitrary: "private-unstructured-content" })).toEqual([{ runId: "pi-capture", turnId: "t", eventType: "harness.diagnostic", payload: { code: "pi_native_activity", providerMethod: type } }]);
  });
  it.each(["compaction_start", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"])("marks %s spending unknown without a fabricated success", type => {
    const events = createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type });
    expect(events[0].payload.usage).toMatchObject({ source: "pi_summarization_unaccounted", runDeltaComplete: false, costComplete: false });
    if (type === "compaction_start") expect(events).toContainEqual(expect.objectContaining({ eventType: "item.started", payload: { kind: "contextCompaction", channel: "detail", text: "Compacting context." } }));
    else expect(events).toContainEqual(expect.objectContaining({ eventType: "harness.diagnostic", payload: { code: "pi_summarization_activity", providerMethod: type } }));
    expect(events.some(event => event.eventType === "context.compacted")).toBe(false);
  });
  it.each(["select", "confirm", "input", "editor"])("requires driver response/cancellation for extension dialog %s", method => {
    const events = createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "extension_ui_request", id: "dialog-1", method });
    expect(events).toEqual([{ runId: "pi-capture", turnId: "t", eventType: "harness.diagnostic", payload: { code: "pi_extension_ui_requires_response", providerMethod: `extension_ui_request.${method}` } }]);
  });
  it.each(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"])("classifies fire-and-forget extension %s as notice, not a question", method => {
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "extension_ui_request", method })[0]?.payload.code).toBe("pi_extension_ui_notice");
  });
  it.each(["start", "done", "error", "toolcall_delta"])("does not bill/execute nested %s wrappers a second time", type => {
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, delta: "{" } })).toEqual([]);
  });
  it("does not silently drop a new nested assistant event", () => {
    expect(createPiEventProjector({ runId: "pi-capture", turnId: "t" }).project({ type: "message_update", assistantMessageEvent: { type: "future_event" } })[0]?.payload).toMatchObject({ code: "pi_unknown_event", providerMethod: "message_update.future_event" });
  });
});
