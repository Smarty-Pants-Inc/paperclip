import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { resolveHeartbeatRunResponse } from "../services/heartbeat-run-summary.js";
import { presentsAcceptedSummary } from "../services/issues.js";

// H5 (dl-finish-cap; testing-lead gate 2, run 73df6872): the person asked a
// pi_rpc chat for a ~28 KB command output "in a code block, nothing else". The
// prompt said the completion summary IS the answer, so the agent put 28.8k
// characters in paperclip_finish.summary. The runner refuses any summary over
// 12,000 characters (runner-core durable/state.rs, provider_bridge.rs), the
// run never got an accepted result, and the person saw only "Working".
//
// R-LONG-ANSWER: the whole answer is delivered once. The prompt now puts the
// whole answer in the final response and keeps the summary to its verbatim
// opening under the cap; the server already presents the whole final answer
// for that shape. This pins both halves at the real seams.
const RUNNER_SUMMARY_CAP = 12_000; // MAX_COMPLETION_SUMMARY_CHARS (runner-core provider_bridge.rs:33)

const line = "drwxr-xr-x  2 paul paul 4096 Nov 17 12:00 dir-🦀 \"quoted\"\n";
const answer = "```\n" + line.repeat(Math.ceil(28_800 / line.length)) + "```";
const chars = (text: string) => Array.from(text).length;

const externalChatWake = {
  reason: "External chat message received",
  externalChatProvider: "slack",
  checkedOutByHarness: true,
  issue: {
    id: "issue-chat-1", identifier: "CHAT-1", title: "External chat conversation",
    description: "Started from Slack.", descriptionTruncated: false, status: "in_progress", workMode: "standard",
  },
  commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
  commentIds: ["comment-chat-1"],
  latestCommentId: "comment-chat-1",
  comments: [{
    id: "comment-chat-1", issueId: "issue-chat-1", bodyTruncated: false, authorType: "user",
    body: "Run ls -la /srv and give me the output in a code block, nothing else.",
  }],
  fallbackFetchNeeded: false,
};

/** What an agent that follows the rendered contract sends: the summary the
 * contract asks for, and the final response it asks for. */
function followContract(prompt: string, whole: string) {
  if (prompt.includes("The semantic completion summary is the user-visible final answer")) {
    return { summary: whole, finalResponse: whole };
  }
  expect(prompt).toContain("the summary is only the answer's opening, copied verbatim, between 11,000 and 12,000 characters long");
  return { summary: Array.from(whole).slice(0, RUNNER_SUMMARY_CAP - 1).join(""), finalResponse: whole };
}

describe("a long answer is never put whole into the 12,000-character completion summary", () => {
  expect(chars(answer)).toBeGreaterThan(28_000);

  it("the rendered chat contract yields a summary the runner accepts", () => {
    const prompt = renderPaperclipWakePrompt(externalChatWake);
    expect(prompt).toContain("## External chat response contract");
    const { summary } = followContract(prompt, answer);
    // At base the contract makes summary === the 28 KB answer: refused, and the
    // person gets nothing. At head it is under the runner cap.
    expect(chars(summary)).toBeLessThanOrEqual(RUNNER_SUMMARY_CAP);
  });

  for (const disposition of ["done", "yielded"] as const) {
    it(`posts the whole answer once for an accepted ${disposition} finish whose summary is its opening`, () => {
      const { summary, finalResponse } = followContract(renderPaperclipWakePrompt(externalChatWake), answer);
      expect(chars(summary)).toBeLessThanOrEqual(RUNNER_SUMMARY_CAP);
      const resolved = resolveHeartbeatRunResponse({
        resultJson: {
          finalizationPhase: "committed",
          finalizationReasonCode: disposition === "yielded" ? "external_chat_response_waiting" : "completed",
          nativeResult: {
            schema: "paperclip.run_result.v1",
            reportedWorkDisposition: disposition,
            summary,
            evidence: [{ ref: "run-event:reply-1" }],
            ...(disposition === "yielded"
              ? { continuation: { kind: "response_wake", summary: "Wait for the next user message.", idempotencyKey: "conversation-reply:reply-1" } }
              : {}),
          },
        },
        preferFinalResponseOverExistingComment: true,
        externalChatResponseWakeSummaryAuthorized: true,
        externalChatCommittedResponseWakeSummaryAuthorized: true,
        finalAgentMessage: { text: finalResponse, sourceEventId: "reply-1", channel: "final" },
      });
      expect(resolved.decision.commentAction).toBe("create");
      expect(resolved.text).toBe(answer);
      expect(resolved.text).not.toMatch(/truncated/i);
      expect(resolved.text!.split("```").length - 1).toBe(2);
    });
  }

  // A review-gated chat answer (governed_response_waiting) is posted only when
  // its body presents the accepted summary (issues.ts presentsAcceptedSummary).
  // The verbatim opening the contract asks for must authorize the whole answer.
  it("authorizes the whole answer for a review-gated reply whose summary is its verbatim opening", () => {
    const { summary } = followContract(renderPaperclipWakePrompt(externalChatWake), answer);
    expect(presentsAcceptedSummary(summary, answer)).toBe(true);
    // Unchanged: the runner's exact 12,000-character cut, and an exact summary.
    expect(presentsAcceptedSummary(Array.from(answer).slice(0, 12_000).join(""), answer)).toBe(true);
    expect(presentsAcceptedSummary("Short answer.", "Short answer.")).toBe(true);
    // Never: a different answer, a short body that is not the summary, or no summary.
    expect(presentsAcceptedSummary(summary, `Different ${answer}`)).toBe(false);
    expect(presentsAcceptedSummary("Short", "Short answer.")).toBe(false);
    expect(presentsAcceptedSummary("", answer)).toBe(false);
    expect(presentsAcceptedSummary(undefined, answer)).toBe(false);
  });
});
