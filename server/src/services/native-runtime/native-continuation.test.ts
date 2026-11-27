import { describe, expect, it } from "vitest";
import { buildNativeContinuationPrompt } from "./native-continuation.js";

const issue = { title: "Original task", description: "Retain my long task brief." };
const message = { id: "new", body: "Yes, please proceed.", authorType: "user", authorId: "board", sourceTrust: "user", createdByRunId: null };
const answeredOld = { id: "old", updatedAt: "2026-01-01T00:00:00Z", receivedAt: "2026-01-01T00:00:00Z", answered: true };
const wake = {
  reason: "issue_commented",
  executionContinuation: {
    version: 1,
    objective: message.body,
    messages: [{ ...message, id: "old", body: "OLD_HISTORY" }, message],
    resumeDelta: { baseRunId: "prior", messages: [message] },
    completedWork: { summary: "OLD_SUMMARY" },
    humanResponses: [{ id: "old-question", result: { answer: "OLD_ANSWER" } }],
  },
  comments: [message], continuationSummary: { markdown: "OLD_SUMMARY" },
};
// Keep the original external-chat parameter fixtures byte-for-byte stable:
// their serialized values are part of the existing exact test names.
const receivedWake = { ...wake, executionContinuation: { ...wake.executionContinuation,
  messages: [{ ...wake.executionContinuation.messages[0]!, createdAt: answeredOld.receivedAt, updatedAt: answeredOld.updatedAt }, message],
  resumeDelta: { ...wake.executionContinuation.resumeDelta, receivedComments: [answeredOld] },
} };
const build = (value: unknown = receivedWake, previousIssue = issue) => buildNativeContinuationPrompt({ wakePayload: value, previousRunId: "prior", issue, previousIssue });

describe("native continuation event projection", () => {
  it("sends a new comment once without the unchanged brief, objective, history or summary", () => {
    const text = build()!;
    expect(text.split(message.body)).toHaveLength(2);
    for (const old of [issue.description, issue.title, "OLD_HISTORY", "OLD_SUMMARY", "OLD_ANSWER"]) expect(text).not.toContain(old);
    expect(JSON.parse(text).messages[0]).toMatchObject({ authorType: "user", body: message.body });
    expect(text.length).toBeLessThan(600);
  });
  it("uses the retained delta even when an already received steer remains in prompt-only wake IDs", () => {
    const text = buildNativeContinuationPrompt({ wakePayload: { ...receivedWake, commentIds: ["old", "new"] },
      promptOnly: true, previousRunId: "prior", issue, previousIssue: issue });
    expect(text).toBe(message.body);
    expect(text).not.toContain("OLD_HISTORY");
  });
  it("preserves the empty prompt-only fallback without a verified delta", () => {
    expect(buildNativeContinuationPrompt({ wakePayload: { ...wake, commentIds: [],
      executionContinuation: { ...wake.executionContinuation, resumeDelta: undefined } },
      promptOnly: true, previousRunId: "prior", issue, previousIssue: issue })).toBe("");
  });
  it.each([false, true])("keeps an empty retained delta off the full-bootstrap path (promptOnly=%s)", promptOnly => {
    const text = buildNativeContinuationPrompt({ wakePayload: { ...receivedWake, commentIds: ["old"], comments: [],
      executionContinuation: { ...receivedWake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [], receivedComments: [answeredOld] } } },
      promptOnly, previousRunId: "prior", issue, previousIssue: issue });
    if (promptOnly) expect(text).toBe("");
    else expect(JSON.parse(text!)).toEqual({ messages: [] });
    expect(text).not.toContain("OLD_HISTORY");
  });
  it("uses exactly the run's own wake text when its verified plain-text delta is empty", () => {
    const body = "Own wake text: $& $' $` $$ — keep this exact.";
    const text = buildNativeContinuationPrompt({ wakePayload: { ...wake, commentIds: ["new"],
      comments: [{ ...message, body, fullBody: body }],
      executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] } } },
      promptOnly: true, previousRunId: "prior", issue, previousIssue: issue });
    expect(text).toBe(body);
  });
  it("tells a resumed turn which delivered comments an earlier turn already read", () => {
    const comment = { id: "new", body: message.body, author: { type: "user", id: "board" } };
    const marked = JSON.parse(build({ ...receivedWake, comments: [{ ...comment, readByEarlierTurn: true }] })!);
    expect(marked.readByEarlierTurn).toEqual({ messageIds: ["new"], note: expect.stringContaining("may have applied it") });
    expect(JSON.parse(build({ ...wake, comments: [comment] })!).readByEarlierTurn).toBeUndefined();
  });
  it("keeps the task widgets' app context on a resumed turn", () => {
    const appContext = "## App context (untrusted)\n\n```json\n{\"app\":\"Circleback\",\"text\":\"Selected m2\"}\n```";
    const events = JSON.parse(build({ ...wake, mcpAppContext: appContext })!);
    expect(events.appContext).toBe(appContext);
    expect(events.messages[0]).toMatchObject({ body: message.body });
    expect(JSON.parse(build()!).appContext).toBeUndefined();
  });
  it("only uses a delta whose base matches the actual previous run", () => {
    expect(build({ ...wake, executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "different", messages: [message] } } })).toBeNull();
    expect(build({ ...wake, executionContinuation: null })).toBeNull();
  });
  it("delivers the current authenticated answer once, not all prior answers", () => {
    const text = build({ ...wake, interactionId: "new-question", executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] }, humanResponses: [...wake.executionContinuation.humanResponses, { id: "new-question", kind: "ask_user_questions", status: "answered", resolvedByUserId: "board", result: { answer: "NEW_ANSWER" } }] } })!;
    expect(text.split("NEW_ANSWER")).toHaveLength(2);
    expect(text).not.toContain("OLD_ANSWER");
    expect(JSON.parse(text).humanResponses[0].resolvedByUserId).toBe("board");
  });
  it("includes external child completion and actual brief edits", () => {
    const text = build({ ...wake, reason: "issue_children_completed", childIssueSummaries: [{ id: "child", status: "done", summary: "CHILD_RESULT" }] }, { ...issue, description: "old brief" })!;
    expect(JSON.parse(text).taskChanges).toEqual({ description: issue.description });
    expect(text).toContain("CHILD_RESULT");
  });
  it.each([{ fallbackFetchNeeded: true }, { recovery: { cause: "interrupted" } }, { externalChatExecutionBound: true }, { reason: "issue_assigned" }])("retains bootstrap framing for special wakes: %j", (extra) => {
    expect(build({ ...wake, ...extra })).toBeNull();
  });
});


describe("plain-text external chat continuation projection", () => {
  const slackComment = { ...message, author: { type: "user", id: "board" } };
  const slackWake = {
    ...wake,
    reason: "External chat message received",
    issue: { id: "task", title: "OLD_EXACT_REPLY", description: "Started from Slack", workMode: "standard" },
    externalChatProvider: "slack", checkedOutByHarness: true,
    comments: [slackComment],
    commentIds: [message.id], latestCommentId: message.id,
    commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
    attachmentOmissions: [],
  };
  const buildChat = (value: unknown = slackWake) => buildNativeContinuationPrompt({
    wakePayload: value, previousRunId: "prior", issue: slackWake.issue,
    previousIssue: slackWake.issue,
    allowExternalChat: true,
  });
  it.each(["slack", "github"])("sends the new %s message once without prior titles, history or instructions", (externalChatProvider) => {
    const text = buildChat({ ...slackWake, externalChatProvider })!;
    expect(text).not.toBeNull();
    expect(JSON.parse(text)).toEqual({ messages: [message] });
    expect(text).not.toContain("OLD_EXACT_REPLY");
    expect(text).not.toContain("OLD_HISTORY");
    expect(text.length).toBeLessThan(600);
  });
  it("excludes edited history and prior agent output outside the current Slack delivery", () => {
    const text = buildChat({ ...slackWake, executionContinuation: {
      ...wake.executionContinuation,
      resumeDelta: { baseRunId: "prior", messages: [
        { ...message, id: "old-edited", body: "STALE_DIRECTION" },
        { ...message, id: "old-reply", authorType: "agent", body: "OLD_AGENT_REPLY" },
        message,
      ] },
    } });
    expect(JSON.parse(text!).messages).toEqual([message]);
    expect(text).not.toContain("STALE_DIRECTION");
    expect(text).not.toContain("OLD_AGENT_REPLY");
  });
  it("preserves an actual task brief edit beside the current message", () => {
    const text = buildNativeContinuationPrompt({
      wakePayload: slackWake, previousRunId: "prior", allowExternalChat: true,
      issue: { ...slackWake.issue, description: "Updated scope" }, previousIssue: slackWake.issue,
    });
    expect(JSON.parse(text!).taskChanges).toEqual({ description: "Updated scope" });
  });
  it("delivers changed GitHub configuration while retaining unchanged configuration in the provider session", () => {
    const config = { key: "a".repeat(64), instructions: "CURRENT_REVIEW_POLICY" };
    const args = { wakePayload: { ...slackWake, externalChatProvider: "github", githubReviewConfigurations: [config] },
      previousRunId: "prior", issue: slackWake.issue, previousIssue: slackWake.issue, allowExternalChat: true };
    const changed = buildNativeContinuationPrompt(args)!;
    expect(JSON.parse(changed).reviewConfigurations).toEqual([config]);
    const unchanged = buildNativeContinuationPrompt({ ...args, previousGitHubReviewConfigurationKeys: [config.key] })!;
    expect(unchanged).not.toContain(config.instructions);
    expect(JSON.parse(unchanged).messages).toEqual([message]);
    expect(buildNativeContinuationPrompt({ ...args, previousRunId: "wrong" })).toBeNull();
  });
  it("accepts the verified non-assignee chat binding", () => {
    expect(buildChat({ ...slackWake, checkedOutByHarness: false, externalChatExecutionBound: true })).not.toBeNull();
  });
  it.each([
    { comments: [{ ...slackComment, attachments: [{ id: "file" }] }] },
    { comments: [{ ...slackComment, attachments: "malformed" }] },
    { comments: [{ ...slackComment, body: "EDITED_SINCE_DELTA" }] },
    { comments: [{ ...slackComment, author: { type: "user", id: "different-user" } }] },
    { attachmentOmissions: [{ commentId: message.id, notice: "Unavailable input" }] },
    { externalChatProvider: "discord" },
    { checkedOutByHarness: false },
    { truncated: true },
    { fallbackFetchNeeded: true },
    { comments: [{ ...slackComment, bodyTruncated: true }] },
    { interactionId: "approval", interactionKind: "request_confirmation" },
    { recovery: { cause: "interrupted" } },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "wrong", messages: [message] } } },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [] } } },
    { commentIds: [message.id, "missing"], latestCommentId: "missing" },
    { commentIds: [message.id, message.id], latestCommentId: message.id },
    { executionContinuation: { ...wake.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [message, message] } } },
  ])("keeps specialized or incomplete input on the full path: %j", (extra) => {
    expect(buildChat({ ...slackWake, ...extra })).toBeNull();
  });
  it("requires the constructor to explicitly opt into chat continuation", () => {
    expect(build(slackWake)).toBeNull();
  });
});
