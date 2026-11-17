import { describe, expect, it } from "vitest";
import { resolveHeartbeatRunResponse } from "../services/heartbeat-run-summary.js";

// pack-n5 (i), Paul NOTE 5: the run result summary is capped at 12,000
// characters by its schema (it is a preview label). The person's posted reply
// must be the WHOLE final answer, never the first 12,000 characters of it.
describe("a native conversation reply is posted whole, not cut to the 12,000-character summary", () => {
  const unit = "Line \"quoted\" 🦀 naïve\n";
  const answer = Array.from(unit.repeat(Math.ceil(40_000 / Array.from(unit).length))).slice(0, 40_000).join("").trim();
  const summary = answer.slice(0, 12_000);
  const resultJson = {
    finalizationPhase: "committed",
    finalizationReasonCode: "external_chat_response_waiting",
    nativeResult: {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary,
      evidence: [{ ref: "run-event:reply-1" }],
      continuation: { kind: "response_wake", summary: "Wait for the next user message in this conversation.", idempotencyKey: "conversation-reply:reply-1" },
    },
  };
  it("posts the whole 40,000-character answer for an external chat response wake", () => {
    const resolved = resolveHeartbeatRunResponse({
      resultJson,
      preferFinalResponseOverExistingComment: true,
      externalChatResponseWakeSummaryAuthorized: true,
      externalChatCommittedResponseWakeSummaryAuthorized: true,
      finalAgentMessage: { text: answer, sourceEventId: "reply-1", channel: "final" },
    });
    expect(resolved.text?.length).toBe(answer.length);
    expect(Buffer.from(resolved.text!, "utf8").equals(Buffer.from(answer, "utf8"))).toBe(true);
    expect(resolved.decision.commentAction).toBe("create");
  });
  it("keeps the summary when the final message is not the answer the summary was cut from", () => {
    const resolved = resolveHeartbeatRunResponse({
      resultJson,
      preferFinalResponseOverExistingComment: true,
      externalChatResponseWakeSummaryAuthorized: true,
      externalChatCommittedResponseWakeSummaryAuthorized: true,
      finalAgentMessage: { text: `Different ${answer}`, sourceEventId: "other", channel: "final" },
    });
    expect(resolved.text).toBe(summary);
  });
});
