import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { isCurrentNotice } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../../__tests__/helpers/truncate-with-deadlock-retry.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { continueHeldExecutions, resetBacklogContinuationPacingForTests } from "../fresh-continuation-fallback.js";
import { heartbeatService } from "../heartbeat.js";
import { settleUnansweredPersonMessagesForTask } from "./unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("B' waits for the continuation path (Smarty fork, TEMPORARY)", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", userId = "";
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-bprime-continuation-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "BCP",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);
  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(db, `truncate table issue_recovery_actions, native_run_finalizations, tool_invocations,
      issue_approvals, approvals, issue_thread_interactions, activity_log, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  /** A person's chat message whose native run failed, held the way today's native failure path holds it
   * (fresh-continuation-fallback.test.ts unfinishedRun/unansweredChat, the same rows). */
  async function failedChatTurn(input: { errorCode: string; error: string }) {
    const issueId = randomUUID(), runId = randomUUID();
    const finishedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release notes", status: "blocked",
      assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", responsibleUserId: userId });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Please help with this task.", createdAt: new Date(Date.now() - 12 * 60_000) }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId,
      nativeIssueId: issueId, runtimeMode: "native", status: "failed", errorCode: input.errorCode, error: input.error,
      startedAt: new Date(finishedAt.getTime() - 10 * 60_000), finishedAt, createdAt: new Date(finishedAt.getTime() - 11 * 60_000),
      responsibleUserId: userId, contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: message!.id },
      nativePhase: "terminal_failure" });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-continuation:${runId}`,
      nextAction: "Inspect the original failure and reconcile the previous execution before continuing. Automatic recovery cannot start another incident.",
      maxAttempts: 3, createdAt: finishedAt,
      evidence: { runId, originalFailureCode: input.errorCode, nativeFailureBlock: { runId, statusVersion: 4 } } });
    return { issueId, runId, messageId: message!.id };
  }
  const successors = async (runId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  async function deliver() {
    const heartbeat = heartbeatService(db);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
  }
  async function sweepFallback() { await settleUnrecoverableExecutions(db); await continueHeldExecutions(db); await deliver(); }
  /** The delivered continuation fails at preparation (no provider), as the native path records it. */
  async function failContinuation(run: typeof heartbeatRuns.$inferSelect, errorCode: string, error: string) {
    const finishedAt = new Date();
    const [task] = await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null,
      blockedTransitionAt: finishedAt }).where(eq(issues.id, run.issueId!)).returning();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: task!.id, nativePhase: "terminal_failure",
      errorCode, error, finishedAt }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId, issueId: task!.id,
      phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: task!.id, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-continuation:${run.id}`, nextAction: "The previous conversation cannot continue.",
      evidence: { runId: run.id, nativeFailureBlock: { runId: run.id, statusVersion: Number(task!.statusVersion) } } });
    if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, run.wakeupRequestId));
  }
  const settleB = (issueId: string, aheadMs = 30_000) =>
    settleUnansweredPersonMessagesForTask(db, { companyId, issueId, now: new Date(Date.now() + aheadMs) });
  const strandedSweep = (issueId: string) => heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId });
  const systemComments = async (issueId: string) => db.select().from(issueComments)
    .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));

  const SAFE = /sending it again is safe/i;

  // SMAAA-1907 (rows-1907.json): 4f6650bd failed adapter_failed (Boat 429) at 08:16:12.97; the
  // fallback resolved its hold with a fresh continuation at 08:16:14.42 (continuationDelivery
  // pending, owner system); B' posted "wasn't answered ... Sending it again is safe" at 08:16:28.13;
  // the continuation 2317d629 was created at 08:16:29.48 (issue_recovery_action_restored, retry of
  // 4f6650bd) and failed setup_failed at 08:16:31.74; the stranded sweep then posted "Task could not
  // continue" (stranded_assigned_issue, board) at 08:16:31.89. Two notices; the first was premature.
  it("SMAAA-1907: no note while the fresh continuation is pending or running; the path's own notice is the only one", async () => {
    const f = await failedChatTurn({ errorCode: "adapter_failed", error: "Boat POST /sandboxes/bx_bhm6su92/commands failed (429): http_error" });
    await settleUnrecoverableExecutions(db);
    const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(record).toMatchObject({ status: "resolved", ownerType: "system" });
    expect(record!.evidence).toMatchObject({ continuationDelivery: "pending" });
    // 08:16:28: the continuation is recorded but not yet admitted.
    await settleB(f.issueId);
    expect(await systemComments(f.issueId), "no note while the continuation is about to be admitted").toHaveLength(0);
    // The agent's only slot is busy, so the delivered continuation stays observable as queued
    // (fresh-continuation-fallback.test.ts occupySlot).
    const [other] = await db.insert(issues).values({ companyId, title: "Other work", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running",
      contextSnapshot: { issueId: other!.id } }).returning();
    await deliver();
    const [next] = await successors(f.runId);
    expect(next).toMatchObject({ status: "queued" });
    await settleB(f.issueId);
    expect(await systemComments(f.issueId), "no note while the continuation is queued").toHaveLength(0);
    // 08:16:31: the continuation fails before the agent starts; the stranded sweep speaks.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy!.id));
    const finishedAt = new Date();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: f.issueId,
      errorCode: "setup_failed", startedAt: finishedAt, finishedAt,
      error: "Failed to acquire lease for environment \"boat-hq-prod-pi-smaa\" (sandbox): Boat acquire failed and cleanup of bx_t7rqb424 was not confirmed." })
      .where(eq(heartbeatRuns.id, next!.id));
    if (next!.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt })
      .where(eq(agentWakeupRequests.id, next!.wakeupRequestId));
    await db.update(issues).set({ status: "in_progress", executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    for (let pass = 0; pass < 3; pass++) {
      await strandedSweep(f.issueId);
      await settleB(f.issueId, 60_000 * (pass + 1));
    }
   
    const notices = await systemComments(f.issueId);
    expect(notices.map(n => n.body).filter(body => SAFE.test(body)), "never 'sending again is safe'").toEqual([]);
    expect(notices, "one notice total: the continuation path's own").toHaveLength(1);
    // The stranded sweep's escalation for the failed continuation (stranded_assigned_issue, as 68a54027).
    expect(notices[0]!.metadata).toMatchObject({ sourceRunId: next!.id });
    expect(notices[0]!.metadata?.authorizationReason).toBeUndefined();
    const [stranded] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      eq(issueRecoveryActions.kind, "stranded_assigned_issue")));
    expect(stranded).toMatchObject({ status: "active", ownerType: "board" });
  }, 90_000);

  // SMA-183 (rows-183.json): 9c1eb80b (issue_assigned) failed native_session_interrupted; its fresh
  // continuation dd8c380d failed native_continuation_requires_reconciliation
  // 'native_controller_recovery_missing_evidence:snapshot_binding' and was itself continued (pending);
  // the person's message abedaaec got B''s no-run note (08:21:24), the resend 9fb84818 a SECOND one
  // (08:26:04), both "...Sending it again is safe"; the next continuation b56acf42 carried 9fb84818
  // and failed the same way (08:32:36), and the fallback stopped (freshContinuationCheck). Stuck.
  // Fixture: the same rows; after dd8c380d's refusal the fallback's hold stays active with its check.
  it("SMA-183: after a reconciliation refusal, ONE note per conversation that names the real state and the one action that works", async () => {
    const f = await failedChatTurn({ errorCode: "native_session_interrupted",
      error: "runner_ingress_unavailable: runnerd process failed: Boat POST /sandboxes/bx_33zmdkqu/files/upload-url failed (429): http_error" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } }).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(issueComments).where(eq(issueComments.issueId, f.issueId));
    await sweepFallback();
    const [first] = await successors(f.runId);
    expect(first).toBeDefined();
    await failContinuation(first!, "native_continuation_requires_reconciliation", "native_controller_recovery_missing_evidence:snapshot_binding");
    await settleUnrecoverableExecutions(db);
    // The person writes while the next continuation is recorded; then resends.
    const message = async () => (await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "Are you there?", createdAt: new Date() }).returning())[0]!.id;
    await message();
    await settleB(f.issueId, 3 * 60_000);
    const resend = await message();
    await settleB(f.issueId, 6 * 60_000);
    // org 09:18Z / RFL 09:45Z (M1.4): never a vanishing note. The resend's note supersedes the first;
    // the first stays (not deleted), marked superseded by it; one CURRENT note.
    const all = await systemComments(f.issueId);
    expect(all.map(n => n.body).filter(body => SAFE.test(body)), "never 'sending again is safe'").toEqual([]);
    expect(all, "the superseded note is kept, not deleted").toHaveLength(2);
    const notices = all.filter(n => isCurrentNotice(n.metadata)); // RFL 11:43Z: the shared rule
    expect(notices, "one current note: the resend's note supersedes the first").toHaveLength(1);
    const superseded = all.find(n => n.id !== notices[0]!.id)!;
    expect((superseded.metadata as Record<string, unknown> | null)?.supersededBy).toBe(notices[0]!.id);
    // org 09:11Z: this fixture is a chat, so the held note names a new chat, not a new task.
    expect(notices[0]!.body).toBe("Coder can't continue this chat from its saved state. Start a new chat with Coder; this one stays readable.");
    expect(notices[0]!.presentation).toMatchObject({ title: "This conversation can't continue" });
    expect(notices[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${resend}`);
  }, 90_000);
});
