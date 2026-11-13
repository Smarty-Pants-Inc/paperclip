import { expect, it, vi } from "vitest";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { taskChatStatusRelevance } from "./status-relevance";

const { addComment } = vi.hoisted(() => ({ addComment: vi.fn() }));
vi.mock("../../../../server/src/services/issues.js", () => ({ issueService: () => ({ addComment }) }));

// Keep reason: recorded F1 catch. Exercise the production notice writer and
// the actual task-chat relevance policy, not a parallel visibility heuristic.
it.each(["missing", "invalid", "foreign", "legacy"] as const)("keeps the projected %s Pi history-loss notice after Done and the next turn", async reason => {
  addComment.mockClear();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const previousId = "33333333-3333-4333-8333-333333333333";
  const nextId = "44444444-4444-4444-8444-444444444444";
  const rows = reason === "legacy" ? [
    [{ id: "issue", conversationAgentId: null }],
    [{ id: runId, companyId: "company", agentId: "agent", nativeIssueId: "issue", status: "running" }],
    [{ id: "session", lastRunId: previousId, sessionParamsJson: { sessionId } }],
    [], // Unverifiable legacy owner: the real writer must take legacyUnverified.
    [], // Typed history-loss provenance has not been projected yet.
  ] : [
    [{ id: "issue", conversationAgentId: null }],
    [{ id: runId, status: "running", nativeSessionId: sessionId, nativeIssueId: "issue" }],
    [{ sessionParamsJson: { __paperclipPiConversation: { schema: "paperclip.pi-conversation.v1", id: sessionId,
      generation: 1, boundary: { provider: "pi_rpc", trust: "trusted", cwd: null, workspaceId: null },
      previousId: null, reason: "first_message", runId } } }],
    [],
  ];
  const db = { transaction: async (fn: (tx: unknown) => unknown) => fn({ select: () => {
    const result = rows.shift();
    const chain = { from: () => chain, where: () => chain, for: async () => result, limit: async () => result,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    return chain;
  }, update: () => ({ set: () => ({ where: async () => {} }) }) }) };
  // Load the real server writer through Vitest, not the browser project's
  // static import graph (which must not typecheck the entire server).
  const { materializePiSessionRecoveryNotice } = await vi.importActual<{
    materializePiSessionRecoveryNotice(input: { db: unknown; execution: unknown; event: unknown }): Promise<unknown>;
  }>("../../../../server/src/services/native-runtime/pi-session-recovery-notice.js");
  if (reason === "legacy") {
    const { selectPiConversation } = await vi.importActual<{
      selectPiConversation(db: unknown, input: unknown): Promise<unknown>;
    }>("../../../../server/src/services/native-runtime/pi-conversation-record.js");
    await selectPiConversation(db, { companyId: "company", agentId: "agent", issueId: "issue", runId,
      boundary: { provider: "pi_rpc", cwd: null, workspaceId: null, trust: "trusted" } });
  } else await materializePiSessionRecoveryNotice({ db,
    execution: { provider: { kind: "pi_rpc" }, binding: { companyId: "company", agentId: "agent", issueId: "issue", runId },
      session: { normalizedSessionId: sessionId } },
    event: { eventType: reason === "missing" ? "session.started" : "session.resumed", runId, normalizedSessionId: sessionId,
      payload: { provider: "pi_rpc", providerSessionId: nextId, providerAccountSessionId: nextId,
        providerDescriptor: { piNativeAdmission: { providerSessionId: nextId, sessionRecovery: reason === "missing"
          ? { code: "pi_session_file_missing", previousDriverSessionId: previousId, driverSessionId: nextId }
          : { reason: "pi_session_file_invalid", normalizedSessionId: sessionId, previousSessionId: previousId,
              preservedFile: `${sessionId}.jsonl.invalid-2026-11-13T01-00-00-000Z-${previousId}` } } } } },
  });
  expect(addComment).toHaveBeenCalledOnce();
  const [issueId, body, actor, options] = addComment.mock.calls[0]!;
  const comment = JSON.parse(JSON.stringify({ id: "notice", companyId: "company", issueId, body,
    authorAgentId: null, authorUserId: null, authorType: options.authorType,
    presentation: options.presentation, metadata: options.metadata,
    createdByRunId: actor.runId ?? null, createdAt: new Date(), updatedAt: new Date() })) as IssueChatComment;
  const oldRun = { id: runId, agentId: "agent", status: "succeeded", createdAt: "2026-11-13T01:00:00Z" };
  const nextRun = { ...oldRun, id: "next", status: "running", createdAt: "2026-11-13T02:00:00Z" };
  for (const [status, runs] of [["done", [oldRun]], ["in_progress", [oldRun, nextRun]], ["done", [oldRun, nextRun]]] as const) {
    expect(taskChatStatusRelevance(status, runs).isHistoricalNotice(comment), `${status}: durable transcript notice remains visible`).toBe(false);
  }
  expect(comment.createdByRunId).toBeNull();
  expect(comment.metadata?.sections).toEqual([{ rows: [{ type: "run_link", runId, agentId: "agent", title: "Fresh conversation" }] }]);
}, 60_000);
