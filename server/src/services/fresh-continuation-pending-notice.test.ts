// Keep reason: real production re-wake loop; admission, durable lineage, and user-notice safety.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../__tests__/helpers/truncate-with-deadlock-retry.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { continueHeldExecutions, ensureFreshContinuation, freshContinuationChain, resetBacklogContinuationPacingForTests } from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnansweredPersonMessages, settleUnansweredPersonMessagesForTask, unansweredPersonMessageCommentCondition } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("fresh-continuation pending delivery notice", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
  const evidence: Record<string, unknown> = {};
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("rfl-fallbackcap-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Review user", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "RFL isolated PG acceptance", issuePrefix: "RFL", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", status: "idle", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);
  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(db, "truncate table issue_recovery_actions, native_run_finalizations, tool_invocations, issue_approvals, approvals, issue_thread_interactions, activity_log, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade");
    writeFileSync(`${process.env.TASK_OUT}/pending-notice-observations.json`, JSON.stringify(evidence, null, 2));
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(chat = false) {
    const issueId = randomUUID(), runId = randomUUID();
    const stopped = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Real-shaped refused conversation", status: "blocked", assigneeAgentId: agentId,
      responsibleUserId: userId, statusVersion: 4, blockedTransitionAt: stopped,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", nativePhase: "terminal_failure", status: "failed", invocationSource: "assignment",
      errorCode: "native_session_interrupted", error: "temporary_runner_transport_unavailable", responsibleUserId: userId,
      startedAt: new Date(stopped.getTime() - 600_000), finishedAt: stopped, createdAt: new Date(stopped.getTime() - 660_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Please help with this task.", createdAt: new Date(stopped.getTime() - 670_000) }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: message!.id } })
      .where(eq(heartbeatRuns.id, runId));
    await hold(runId, issueId, 4);
    return { issueId, runId, messageId: message!.id };
  }
  async function hold(runId: string, issueId: string, statusVersion: number) {
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active", ownerType: "board",
      returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${runId}`,
      nextAction: "Inspect the original failure and reconcile the previous execution before continuing.",
      evidence: { runId, nativeFailureBlock: { runId, statusVersion } } });
  }
  async function occupySlot() {
    const [task] = await db.insert(issues).values({ companyId, title: "Slot occupied by ordinary work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: task!.id, status: "running", contextSnapshot: { issueId: task!.id } });
  }
  async function sweep() {
    await settleUnrecoverableExecutions(db);
    await continueHeldExecutions(db);
    await deliverReconciledExecutions(db, heartbeatService(db).wakeup);
  }
  async function children(runId: string) { return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId)); }
  async function fail(run: typeof heartbeatRuns.$inferSelect, error = "temporary_runner_transport_unavailable") {
    const [task] = await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null, blockedTransitionAt: new Date() })
      .where(eq(issues.id, run.issueId!)).returning();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: task!.id, nativePhase: "terminal_failure",
      startedAt: new Date(Date.now() - 5_000), finishedAt: new Date(), errorCode: "native_continuation_requires_reconciliation", error }).where(eq(heartbeatRuns.id, run.id));
    await hold(run.id, task!.id, Number(task!.statusVersion));
    // Match the real lifecycle's terminal wake receipt: failed runs do not retain a queued wake.
    if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, run.wakeupRequestId));
  }
  async function noticeSweep(issueId: string) {
    return settleUnansweredPersonMessagesForTask(db, { companyId, issueId, now: new Date(Date.now() + 30_000) });
  }
  it.each([false, true])("record -> public sweep -> deliver -> terminal preserves one accurate canonical note (earlier notice: %s)", async earlierNotice => {
    const f = await seed(true); await occupySlot();
    let originalNote: typeof issueComments.$inferSelect | undefined;
    if (earlierNotice) {
      await noticeSweep(f.issueId);
      [originalNote] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
      expect(originalNote!.body).toMatch(/Sending it again is safe/i);
    }
    await settleUnrecoverableExecutions(db);
    const beforeActions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const before = await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId, unanswered: true });
    const pendingNotes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
    expect.soft("unansweredMessagesNoticed" in before ? before.unansweredMessagesNoticed : null).toBe(0);
    expect.soft(pendingNotes).toHaveLength(earlierNotice ? 1 : 0);
    await deliverReconciledExecutions(db, heartbeatService(db).wakeup);
    const next = (await children(f.runId))[0]!; expect(next).toBeDefined();
    await fail(next, "native_controller_recovery_unsupported:metadata_format"); await sweep();
    const discovered = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, f.issueId), unansweredPersonMessageCommentCondition()));
    expect.soft(discovered.length).toBeGreaterThan(0);
    await heartbeatService(db).drainActiveRunExecutions();
    await db.$client.end();
    db = createDb(temporary.connectionString);
    await Promise.all(Array.from({ length: 3 }, () => settleUnansweredPersonMessages(db, { companyId, issueId: f.issueId, now: new Date(Date.now() + 30_000) })));
    for (let pass = 0; pass < 3; pass++) await noticeSweep(f.issueId);
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
    evidence[String(earlierNotice)] = { beforeActions: beforeActions.map(a => ({ status: a.status, evidence: a.evidence })), before,
      terminalRunId: next.id, originalNoteId: originalNote?.id, pendingNoteIds: pendingNotes.map(n => n.id), notes: notes.map(n => ({ id: n.id, createdAt: n.createdAt, updatedAt: n.updatedAt, body: n.body, metadata: n.metadata })) };
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).not.toMatch(/sending it again is safe/i);
    expect(notes[0]!.metadata).toMatchObject({ sourceRunId: next.id, authorizationReason: `unanswered_message:${f.messageId}` });
    expect(notes[0]!.body).toBe("Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.");
    if (earlierNotice) {
      expect(notes[0]!.id).toBe(originalNote!.id);
      expect(notes[0]!.createdAt).toEqual(originalNote!.createdAt);
    }
  }, 60_000);

});
