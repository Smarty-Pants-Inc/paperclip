import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, issueThreadInteractions, nativeRunFinalizations,
} from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { conversationReplyRunsForLastMessages } from "../services/agent-conversations.js";
import { ensureFreshContinuation } from "../services/fresh-continuation-fallback.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { readFirstTurnQueuedInputReceipt } from "../services/native-runtime/first-turn-queued-input.js";
import { firstTurnDeliveredCommentIds } from "../services/queued-comment-delivery.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const suite = recoveryPostgresSupport.supported ? describe : describe.skip;
const HOUR = 3_600_000;

// Independent judge checks. These exercise the actual selector, answer facts,
// and fresh-continuation delivery, not just the pure invariant.
suite("RFL chat-gap independent acceptance", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("rfl-chat-gap-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 240_000);
  afterAll(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    const runId = randomUUID(), messageId = randomUUID();
    const at = (hours: number) => new Date(Date.now() - hours * HOUR);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.test`, emailVerified: true,
      createdAt: at(6), updatedAt: at(6) });
    await db.insert(companies).values({ id: companyId, name: "RFL fixture", issuePrefix: `J${companyId.slice(0, 7)}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", adapterType: "paperclip_runner", status: "idle",
      adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Unanswered person message", status, assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting", createdAt: at(6), updatedAt: at(3) });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorUserId: userId, authorType: "user",
      body: "Please answer this question.", createdAt: at(5), updatedAt: at(5) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "native", nativeIssueId: issueId,
      status: "failed", errorCode: "native_continuation_requires_reconciliation", nativePhase: "terminal_failure",
      responsibleUserId: userId, createdAt: at(4.9), startedAt: at(4.8), finishedAt: at(4),
      contextSnapshot: { issueId, taskId: issueId, wakeCommentId: messageId } });
    return { companyId, agentId, issueId, userId, runId, messageId, at };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  function queue(f: Fixture) {
    const enqueueWakeup = vi.fn(async (_agentId: string, opts?: { payload?: Record<string, unknown> | null }) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, status: "queued",
        source: "automation", triggerDetail: "system", payload: opts?.payload ?? { issueId: f.issueId } }).returning();
      return { id: wake!.id } as never;
    });
    return { enqueueWakeup, service: recoveryService(db, { enqueueWakeup }) };
  }
  async function reply(f: Fixture, runId = f.runId) {
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: runId, origin: "comment", body: "Here is the answer.", createdAt: f.at(3) });
  }
  async function ownCard(f: Fixture, kind: string) {
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId,
      createdByAgentId: f.agentId, addresseeUserId: f.userId, kind, status: "pending", title: "Please decide",
      payload: { version: 1, questions: [] } as never, createdAt: f.at(3) });
  }
  async function finalizeFixture(f: Fixture) {
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
  }

  it.each(["todo", "in_progress", "blocked"])("the production selector discovers an unanswered %s conversation", async status => {
    const f = await seed(status);
    const q = queue(f);
    const suspects = await q.service.assignedWork.listSuspects({ companyId: f.companyId }, null, 100);
    expect(suspects.map(row => row.id)).toContain(f.issueId);
    // This is the same selector -> checker sequence used by recovery/work.ts.
    for (const suspect of suspects) await q.service.assignedWork.checkIssue({ companyId: suspect.companyId, issueId: suspect.id });
    expect(q.enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 60_000);

  it.each(["wakeCommentId", "commentId", "firstTurnQueuedInput"])("no duplicate answer after prose via %s", async carrier => {
    const f = await seed();
    const context = carrier === "firstTurnQueuedInput" ? { firstTurnQueuedInput: {
      schema: "paperclip.first-turn-queued-input.v1", runId: f.runId, commentIds: [f.messageId], wakeupRequestIds: [], claimedAt: f.at(4.8).toISOString(),
    } } : { [carrier]: f.messageId };
    await db.update(heartbeatRuns).set({ status: "queued", errorCode: null, contextSnapshot: { issueId: f.issueId, ...context } })
      .where(eq(heartbeatRuns.id, f.runId));
    if (carrier === "firstTurnQueuedInput") {
      expect(await firstTurnDeliveredCommentIds(db, { ...f, commentIds: [f.messageId] })).toEqual(new Set());
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.runId, agentId: f.agentId,
        seq: 1, eventType: "turn.accepted", payload: {} });
      expect(await firstTurnDeliveredCommentIds(db, { ...f, commentIds: [f.messageId] })).toEqual(new Set([f.messageId]));
    }
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await reply(f);
    const q = queue(f);
    expect(await q.service.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "waiting", reason: "conversation" } });
    expect(q.enqueueWakeup).not.toHaveBeenCalled();
  }, 60_000);

  it.each(["ask_user_questions", "request_confirmation"])("own %s card remains a wait without prose", async kind => {
    const f = await seed();
    await ownCard(f, kind);
    const q = queue(f);
    expect(await q.service.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "waiting", reason: "question" } });
    expect(q.enqueueWakeup).not.toHaveBeenCalled();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId));
    await finalizeFixture(f);
    expect(await ensureFreshContinuation(db, { companyId: f.companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "person_owned", reason: "question_pending" });
  }, 60_000);

  it("does not treat another run's prose as answering this message", async () => {
    const f = await seed();
    const other = randomUUID();
    await db.insert(heartbeatRuns).values({ id: other, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      createdAt: f.at(4.5), finishedAt: f.at(4), contextSnapshot: { issueId: f.issueId } });
    await reply(f, other);
    const q = queue(f);
    expect(await q.service.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ outcome: "repaired", verdict: { kind: "violation" } });
    expect(q.enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("does not accept an inherited first-turn receipt as this run's input", async () => {
    const f = await seed();
    const predecessorId = randomUUID();
    const inherited = { schema: "paperclip.first-turn-queued-input.v1", runId: predecessorId, commentIds: [f.messageId],
      wakeupRequestIds: [], claimedAt: f.at(4.96).toISOString() };
    const contextSnapshot = { issueId: f.issueId, firstTurnQueuedInput: inherited };
    await db.insert(heartbeatRuns).values({ id: predecessorId, companyId: f.companyId, agentId: f.agentId,
      status: "failed", createdAt: f.at(5.1), startedAt: f.at(5.1), finishedAt: f.at(4.95), contextSnapshot });
    await db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, f.runId));
    await reply(f);
    // Upstream explicitly treats a retry's copied predecessor receipt as inert.
    expect(readFirstTurnQueuedInputReceipt({ id: f.runId, contextSnapshot })).toBeNull();
    expect(await conversationReplyRunsForLastMessages(db, { companyId: f.companyId,
      issues: [{ issueId: f.issueId, agentId: f.agentId }] })).toEqual([]);
    const q = queue(f);
    expect(await q.service.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ verdict: { kind: "violation" } });
  }, 60_000);

  it.each(["queued", "running", "intent"])("preserves existing %s work as a wait", async kind => {
    const f = await seed();
    if (kind === "intent") {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        status: "queued", payload: { issueId: f.issueId } });
    } else {
      await db.update(heartbeatRuns).set({ status: kind, errorCode: null, finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    }
    const q = queue(f);
    expect(await q.service.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ outcome: "ok", verdict: { clause: kind === "intent" ? "pending_intent" : "live_run" } });
    expect(q.enqueueWakeup).not.toHaveBeenCalled();
  }, 60_000);

  it("a system notice does not answer the person or create a second continuation", async () => {
    const f = await seed();
    await issueService(db).addComment(f.issueId, "The previous work stopped. It will be retried.", {}, {
      authorType: "system", presentation: { kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false },
      metadata: { version: 1, authorizationReason: "rfl-system-notice", sections: [{ rows: [
        { type: "run_link", runId: f.runId, agentId: f.agentId, title: "Interrupted work" },
      ] }] },
    });
    const q = queue(f);
    expect(await q.service.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ outcome: "repaired", verdict: { kind: "violation" } });
    expect(await q.service.assignedWork.checkIssue({ companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "pending_intent" } });
    expect(q.enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 60_000);

  it.each([
    { status: "in_progress", state: "active" },
    { status: "in_review", state: "waiting" },
    { status: "in_review", state: "active" },
  ])("holds an unanswered failed $status/$state chat until its executor is proven gone", async ({ status, state }) => {
    const f = await seed(status);
    await db.update(issues).set({ conversationState: state }).where(eq(issues.id, f.issueId));
    await finalizeFixture(f);
    expect(await ensureFreshContinuation(db, { companyId: f.companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "person_owned", reason: "chat_executor_not_proven_gone" });
    const heartbeat = heartbeatService(db);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
    const records = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      eq(issueRecoveryActions.sourceIssueId, f.issueId)));
    expect(successors).toHaveLength(0);
    expect(records.some(row => row.evidence.freshContinuation)).toBe(false);
  }, 60_000);

  it("does not admit a legacy forceFreshSession chat recovery without recorded executor proof", async () => {
    const f = await seed("in_review");
    await finalizeFixture(f);
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
      returnOwnerAgentId: f.agentId, cause: "native_continuation_requires_reconciliation", fingerprint: `legacy-chat-gap:${f.runId}`,
      nextAction: "The previous chat attempt stopped.", resolvedAt: new Date(), attemptCount: 1,
      evidence: { runId: f.runId, continuationDelivery: "pending", freshContinuation: { schema: "paperclip.fresh-continuation.v1",
        sourceRunId: f.runId, recordedAt: new Date().toISOString(), isolation: "fresh_isolated_workspace" },
        executionReconciliation: { runId: f.runId, providerStopped: true, actionOutcome: "mixed", outcomeEvidence: "legacy candidate" } } }).returning();
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_recovery_action_restored",
      idempotencyKey: `execution-reconciliation:${action!.id}`, payload: { issueId: f.issueId, recoveryActionId: action!.id },
      requestedByActorType: "system", requestedByActorId: "execution-recovery",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, recoveryActionId: action!.id, previousRunId: f.runId,
        retryOfRunId: f.runId, forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId))).toHaveLength(0);
  }, 60_000);
});
