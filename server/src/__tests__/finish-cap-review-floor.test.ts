import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt, stringifyPaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";
import {
  COMPLETION_SUMMARY_CAP_CODE_POINTS,
  COMPLETION_SUMMARY_OPENING_MARGIN_CODE_POINTS,
  presentsAcceptedSummary,
} from "../services/issues.js";

// H5 finish-cap round 2 (RFL FAIL on 9a75d258).
//
// (b) Review-gate floor. Round 1 let ANY non-empty verbatim prefix authorize a
// body over 12,000 UTF-16 units, so a one-character summary authorized a long,
// unrelated answer. A summary now authorizes a body only when it is the whole
// body, or a verbatim opening of at least cap - margin code points (the unit the
// runner's cap counts: runner-core provider_bridge.rs `chars().count()`).
//
// (c) Prompt-hunk mutation pins. Every instruction sentence of the chat
// contract hunk (adapter-utils server-utils.ts renderPaperclipWakePromptBody)
// is pinned in the rendered prompt; deleting any one turns a test red
// (artifacts/mutations.log runs each deletion).

const floor = COMPLETION_SUMMARY_CAP_CODE_POINTS - COMPLETION_SUMMARY_OPENING_MARGIN_CODE_POINTS;
const codePoints = (text: string) => Array.from(text).length;
const opening = (text: string, n: number) => Array.from(text).slice(0, n).join("");

describe("review gate: a summary authorizes a long body only as its whole or near-cap opening", () => {
  it("names the floor in code points: 12,000 less a 1,000 margin", () => {
    expect(COMPLETION_SUMMARY_CAP_CODE_POINTS).toBe(12_000);
    expect(COMPLETION_SUMMARY_OPENING_MARGIN_CODE_POINTS).toBe(1_000);
    expect(floor).toBe(11_000);
  });

  it("ASCII: a one-character or short opening is refused; a near-cap opening and the whole body are accepted", () => {
    const body = "drwxr-xr-x paul paul 4096 Nov 17 output\n".repeat(720); // 28,800 chars
    expect(body.length).toBeGreaterThan(28_000);
    expect(presentsAcceptedSummary("d", body)).toBe(false); // round 1: true
    expect(presentsAcceptedSummary(opening(body, 2_000), body)).toBe(false); // round 1: true
    expect(presentsAcceptedSummary(opening(body, floor - 1), body)).toBe(false); // round 1: true
    expect(presentsAcceptedSummary(opening(body, floor), body)).toBe(true); // pre-round-1: false
    expect(presentsAcceptedSummary(opening(body, 11_999), body)).toBe(true); // pre-round-1: false
    expect(presentsAcceptedSummary(opening(body, 12_000), body)).toBe(true);
    expect(presentsAcceptedSummary(body, body)).toBe(true);
    // Not a verbatim opening, or an empty / missing summary.
    expect(presentsAcceptedSummary(opening(body, 11_999), `x${body}`)).toBe(false);
    expect(presentsAcceptedSummary("", body)).toBe(false);
    expect(presentsAcceptedSummary(undefined, body)).toBe(false);
    // A short answer is presented only by itself.
    expect(presentsAcceptedSummary("Short", "Short answer.")).toBe(false);
    expect(presentsAcceptedSummary("Short answer.", "Short answer.")).toBe(true);
  });

  it("emoji: the floor counts code points, not UTF-16 units", () => {
    const body = "🦀".repeat(15_000); // 15,000 code points, 30,000 UTF-16 units
    expect(presentsAcceptedSummary("🦀", body)).toBe(false); // round 1: true
    // 6,500 code points = 13,000 UTF-16 units: over the cap in UTF-16, far under it in code points.
    const short = opening(body, 6_500);
    expect(short.length).toBeGreaterThan(12_000);
    expect(presentsAcceptedSummary(short, body)).toBe(false); // round 1 and pre-round-1: true
    expect(presentsAcceptedSummary(opening(body, floor - 1), body)).toBe(false);
    expect(presentsAcceptedSummary(opening(body, floor), body)).toBe(true);
    // A body of 11,000..12,000 code points is not over the cap (though it is
    // over 12,000 UTF-16 units): only the whole body presents it.
    const atCap = "🦀".repeat(11_500);
    expect(atCap.length).toBeGreaterThan(12_000);
    expect(presentsAcceptedSummary(opening(atCap, 11_000), atCap)).toBe(false);
    expect(presentsAcceptedSummary(atCap, atCap)).toBe(true);
    expect(codePoints(opening(body, floor))).toBe(11_000);
  });
});

const chatWake = {
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

const marker = {
  schema: "paperclip.external_chat_question_response.v1",
  interactionId: "10000000-0000-4000-8000-000000000001",
  responseDeliveryId: "20000000-0000-4000-8000-000000000002",
  sourceRunId: "30000000-0000-4000-8000-000000000003",
  sourceCommentId: "40000000-0000-4000-8000-000000000004",
  endpointId: "50000000-0000-4000-8000-000000000005",
  conversationId: "60000000-0000-4000-8000-000000000006",
  bindingSha256: "a".repeat(64),
};
const questionWake = JSON.parse(stringifyPaperclipWakePayload({
  ...chatWake,
  reason: "issue_commented",
  externalChatProvider: "discord",
  checkedOutByHarness: false,
  externalChatExecutionBound: true,
  issue: { ...chatWake.issue, status: "in_review" },
  interactionId: marker.interactionId,
  sourceRunId: marker.sourceRunId,
  interactionKind: "ask_user_questions",
  interactionStatus: "answered",
  externalInteractionContinuation: true,
  externalChatQuestionResponse: marker,
  questionResponse: { interactionId: marker.interactionId, summaryMarkdown: "Color: Cobalt", truncated: false },
  commentIds: [marker.sourceCommentId],
  latestCommentId: marker.sourceCommentId,
  comments: [{ ...chatWake.comments[0], id: marker.sourceCommentId, body: "Ask for a color, then reply with exactly COLOR-<chosen color>." }],
}) ?? "{}");

// Each instruction sentence of the hunk, verbatim (server-utils.ts :2451, :2452, :2461).
const FINAL_ANSWER_SENTENCES = [
  "Your final assistant response, sent after the semantic completion succeeds, is the user-visible final answer; Paperclip delivers it whole at any length.",
  "Include every requested answer, exact value, description, and any actionable file-access or delivery limitation there; a statement that you read, checked, or prepared something is not a substitute.",
  "Private progress commentary is not delivered as the final answer.",
];
const SUMMARY_CAP_SENTENCES = [
  "The semantic completion summary is limited to 12,000 characters; a longer summary is rejected and nothing is delivered.",
  "When the answer fits, the summary is the answer itself.",
  "When the answer is longer, the summary is only the answer's opening, copied verbatim, between 11,000 and 12,000 characters long, and the whole answer is your final response.",
  "If a completion is refused as too long, do not shorten the answer and retry: send the opening as the summary once, then the whole answer as your final response.",
  "Never shorten the answer or mark it as truncated to fit the summary.",
];
const ANSWERED_QUESTION_SENTENCES = [
  "Use the authoritative answer below to complete the original request; do not repeat or re-ask the resolved question.",
  "Preserve the original request's exact-output constraints literally.",
  "Put the requested result, including the chosen value, in the final answer as described above—not an acknowledgment that the answer was received or that the task was updated.",
];

describe("chat contract hunk: every instruction sentence is pinned", () => {
  const chatPrompt = renderPaperclipWakePrompt(chatWake);
  const questionPrompt = renderPaperclipWakePrompt(questionWake);

  it("renders both contracts", () => {
    expect(chatPrompt).toContain("## External chat response contract");
    expect(questionPrompt).toContain("## External chat answered-question contract");
  });

  for (const sentence of [...FINAL_ANSWER_SENTENCES, ...SUMMARY_CAP_SENTENCES]) {
    it(`chat and answered-question prompts carry: ${sentence.slice(0, 72)}`, () => {
      expect(chatPrompt).toContain(sentence);
      expect(questionPrompt).toContain(sentence);
    });
  }

  for (const sentence of ANSWERED_QUESTION_SENTENCES) {
    it(`answered-question prompt carries: ${sentence.slice(0, 72)}`, () => {
      expect(questionPrompt).toContain(sentence);
      expect(chatPrompt).not.toContain(sentence);
    });
  }

  it("the old instructions are gone", () => {
    for (const prompt of [chatPrompt, questionPrompt]) {
      expect(prompt).not.toContain("The semantic completion summary is the user-visible final answer");
      expect(prompt).not.toContain("in the semantic completion summary—not an acknowledgment");
      expect(prompt).not.toContain("copied verbatim and under 12,000 characters");
    }
  });

  it("the opening the prompt asks for clears the review-gate floor and the runner cap", () => {
    const body = "line of a long command output\n".repeat(1_000);
    expect(SUMMARY_CAP_SENTENCES[2]).toContain(`between ${floor.toLocaleString("en-US")} and ${COMPLETION_SUMMARY_CAP_CODE_POINTS.toLocaleString("en-US")}`);
    expect(presentsAcceptedSummary(opening(body, floor), body)).toBe(true);
    expect(presentsAcceptedSummary(opening(body, COMPLETION_SUMMARY_CAP_CODE_POINTS), body)).toBe(true);
  });
});
