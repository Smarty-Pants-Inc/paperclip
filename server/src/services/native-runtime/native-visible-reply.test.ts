import { describe, expect, it } from "vitest";
import { composeNativeVisibleReply } from "./native-visible-reply.js";

// Pure replay is the cheapest proof of delta/completion and segment identity.
const scope = { runId: "run", normalizedSessionId: "session" };
function row(seq: number, eventType: string, itemId: string, payload: Record<string, unknown>, turnId = "turn") {
  return { seq, eventType, payload: { prpEvent: { ...scope, turnId, eventType, itemId, sourceEventId: `source-${seq}`, payload } } };
}
const message = (text: string, channel = "progress") => ({ kind: "agentMessage", channel, text });

describe("visible assistant reply composition", () => {
  it("deduplicates source events and completion receipts without merging identical distinct items", () => {
    const delta = row(1, "item.delta", "first", message("Check "));
    const events = [delta, { ...delta, seq: 2 }, row(3, "item.delta", "first", message("this.")),
      row(4, "item.completed", "first", message("Check this.")), row(5, "item.completed", "first", message("Check this.")),
      row(6, "item.completed", "second", message("Check this.", "commentary")),
      row(7, "item.completed", "final", message("Done.", "final"))];
    expect(composeNativeVisibleReply(events.reverse(), scope)?.text).toBe("Check this.\n\nCheck this.\n\nDone.");
  });
  it.each(["", "Partial", "Partial…[truncated]"])("never erases visible partial deltas with receipt %j", receipt => {
    const events = [row(1, "item.completed", "intro", message("Before tool.")),
      row(2, "item.completed", "tool", { kind: "toolCall", text: "private tool JSON" }),
      row(3, "item.delta", "answer", message("Partial answer", "final")),
      row(4, "item.completed", "answer", message(receipt, "final"))];
    expect(composeNativeVisibleReply(events, scope)?.text).toBe("Before tool.\n\nPartial answer");
  });
  it("can recover a bounded commentary receipt only when the full deltas survived", () => {
    const full = "Visible ".repeat(700);
    const events = [row(1, "item.delta", "intro", message(full.slice(0, 3000))),
      row(2, "item.delta", "intro", message(full.slice(3000))),
      row(3, "item.completed", "intro", message(`${full.slice(0, 4000)}…[truncated]`))];
    expect(composeNativeVisibleReply(events, scope)?.text).toBe(full);
    expect(composeNativeVisibleReply(events.slice(2), scope)?.text).toBe(`${full.slice(0, 4000)}…[truncated]`);
  });
  it("retains incomplete deltas and their settled redactor output tail at interruption", () => {
    const events = [row(1, "item.started", "answer", { kind: "assistant_message", channel: "progress" }),
      row(2, "item.delta", "answer", { text: "Visible " }), row(3, "turn.interrupted", "terminal", {
        outputTails: [{ itemId: "answer", payload: { kind: "agentMessage", channel: "progress", text: "tail" } }],
      })];
    expect(composeNativeVisibleReply(events, scope)).toMatchObject({ text: "Visible tail", channel: "final" });
  });
  it("separates finals in a held run, including identical final text, and ignores a repeated receipt", () => {
    const events = [row(1, "item.completed", "a", message("First.")), row(2, "item.completed", "f1", message("OK", "final")),
      row(3, "item.completed", "f1", message("OK", "final")), row(4, "item.completed", "b", message("Second.")),
      row(5, "item.completed", "f2", message("OK", "final"))];
    expect(composeNativeVisibleReply(events, { ...scope, throughSeq: 2 })?.text).toBe("First.\n\nOK");
    expect(composeNativeVisibleReply(events, scope)).toMatchObject({ text: "Second.\n\nOK", replyKey: "native-final:run:f2" });
  });
  it("does not cross a turn or include hidden channels, reasoning, tools or other session content", () => {
    const events = [row(1, "item.completed", "old", message("Old turn."), "old"), row(2, "turn.started", "turn", {}),
      row(3, "item.completed", "hidden", message("Hidden", "analysis")),
      row(4, "item.completed", "reasoning", { kind: "reasoning", text: "Hidden reasoning" }),
      row(5, "item.completed", "tool", { kind: "toolCall", text: "Hidden JSON" }),
      row(6, "item.delta", "partial", message("Shown")),
      { ...row(7, "item.completed", "wrong", message("Wrong session")), payload: { prpEvent: {
        ...scope, normalizedSessionId: "other", payload: message("Wrong session"), eventType: "item.completed" } } }];
    expect(composeNativeVisibleReply(events, scope)?.text).toBe("Shown");
  });
  it("leaves recorded plans to their document and rejects semantic control JSON", () => {
    const events = [row(1, "plan.proposed", "plan", { proposalId: "plan", status: "completed" }),
      row(2, "item.completed", "plan", message("Before\n<proposed_plan>\nPlan\n</proposed_plan>\nAfter")),
      row(3, "item.completed", "control", message('{"schema":"paperclip.run_result.v1"}')),
      row(4, "item.completed", "final", message("Done.", "final"))];
    expect(composeNativeVisibleReply(events, scope)?.text).toBe("Before\nAfter\n\nDone.");
  });
  it("keeps the work turn rather than disposition-only semantic recovery text", () => {
    const events = [row(1, "item.completed", "intro", message("Shown.")), row(2, "item.completed", "final", message("Done.", "final")),
      { seq: 3, eventType: "lifecycle", payload: { retryReasonCode: "semantic_result_missing" } },
      row(4, "item.completed", "recovery", message("Recovery only", "final"), "recovery")];
    expect(composeNativeVisibleReply(events, scope)?.text).toBe("Shown.\n\nDone.");
  });
});
