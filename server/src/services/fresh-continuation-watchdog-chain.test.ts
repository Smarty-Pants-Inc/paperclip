import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { continueHeldExecutions } from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { isNativeContinuationRefusal, NATIVE_CONTINUATION_REFUSED_ACTION } from "./native-continuation-refusal.js";
import { settleUnansweredPersonMessagesForTask } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const failure = "native_controller_recovery_missing_evidence:snapshot_binding";
const cause = "native_continuation_requires_reconciliation";

suite("fresh-continuation watchdog snapshot-binding chain", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
  const issueId = randomUUID(), rootRunId = randomUUID(), messageId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-watchdog-chain-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "WCF",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);

  afterAll(async () => {
    try { if (db) await heartbeatService(db).drainActiveRunExecutions(); }
    finally {
      try { await db?.$client.end(); }
      finally { await temporary?.cleanup(); }
    }
  });

  it("stops fresh resolved watchdog actions after two snapshot-binding fallbacks and publishes one real owner note", async () => {
    expect(isNativeContinuationRefusal({ errorCode: cause, error: failure })).toBe(false);
    const startedAt = new Date(Date.now() - 10 * 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Finish the requested work", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId,
      conversationUserId: userId, conversationState: "active" });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Please finish this work.", createdAt: new Date(startedAt.getTime() - 60_000) });
    await db.insert(heartbeatRuns).values({ id: rootRunId, companyId, agentId, issueId, nativeIssueId: issueId,
      invocationSource: "automation", runtimeMode: "native", status: "running", responsibleUserId: userId,
      startedAt, createdAt: startedAt, contextSnapshot: { issueId, wakeReason: "issue_recovery_action_restored",
        source: "execution.reconciled", forceFreshSession: true, wakeCommentId: messageId } });
    const [other] = await db.insert(issues).values({ companyId, title: "Occupied agent slot", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running",
      contextSnapshot: { issueId: other!.id } });

    const successors = (runId: string) => db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
    const systemNotes = () => db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    const deliver = async (database = db) => {
      const heartbeat = heartbeatService(database);
      await deliverReconciledExecutions(database, heartbeat.wakeup);
      await deliverReconciledExecutions(database, heartbeat.wakeup);
    };
    const failPreparation = async (runId: string) => {
      const now = new Date();
      const [task] = await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null,
        blockedTransitionAt: now }).where(eq(issues.id, issueId)).returning();
      const [run] = await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: issueId,
        nativePhase: "terminal_failure", errorCode: cause, error: failure, finishedAt: now })
        .where(eq(heartbeatRuns.id, runId)).returning();
      if (run!.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: now })
        .where(eq(agentWakeupRequests.id, run!.wakeupRequestId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        recoveryState: "blocked", failureCode: cause });
      const hold = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: agentId, cause,
        fingerprint: `snapshot-binding:${runId}`, nextAction: "Continue from the last saved work.",
        evidence: { runId, nativeFailureBlock: { runId, statusVersion: task!.statusVersion } } });
      const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
      await settleUnrecoverableExecutions(db, record!.createdAt);
      return record!.id;
    };

    const delivered: string[] = [];
    let sourceRunId: string = rootRunId;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const actionId = await failPreparation(sourceRunId);
      await deliver();
      const next = await successors(sourceRunId);
      expect(next).toHaveLength(1);
      const run = next[0]!;
      expect(run).toMatchObject({ invocationSource: "automation", retryOfRunId: sourceRunId,
        contextSnapshot: { previousRunId: sourceRunId, forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" } });
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
      expect(wake).toMatchObject({ requestedByActorType: "system", reason: "issue_recovery_action_restored" });
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
      expect(action).toMatchObject({ kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
        attemptCount: 1, maxAttempts: null, cause, resolvedAt: action!.createdAt,
        evidence: { continuationDelivery: "delivered", continuationRunId: run.id,
          freshContinuation: { sourceRunId } } });
      await settleUnansweredPersonMessagesForTask(db, { companyId, issueId, now: new Date(Date.now() + 30_000) });
      expect(await systemNotes()).toHaveLength(0);
      delivered.push(run.id);
      sourceRunId = run.id;
    }

    await failPreparation(sourceRunId);
    const restarted = createDb(temporary!.connectionString);
    try {
      for (let pass = 0; pass < 3; pass++) {
        await settleUnrecoverableExecutions(restarted);
        await continueHeldExecutions(restarted);
        await deliver(restarted);
        await settleUnansweredPersonMessagesForTask(restarted, { companyId, issueId, now: new Date(Date.now() + 30_000) });
      }
    } finally { await restarted.$client.end(); }

    const forbidden = await successors(sourceRunId);
    const records = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, issueId), sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    const notes = await systemNotes();
    if (process.env.PAPERCLIP_WATCHDOG_CHAIN_OBSERVATIONS) {
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId)));
      const actions = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId)));
      writeFileSync(process.env.PAPERCLIP_WATCHDOG_CHAIN_OBSERVATIONS, JSON.stringify({ rootRunId, delivered,
        forbiddenSuccessors: forbidden.map(run => run.id),
        runs: runs.map(run => ({ id: run.id, status: run.status, invocationSource: run.invocationSource,
          retryOfRunId: run.retryOfRunId, errorCode: run.errorCode, error: run.error, contextSnapshot: run.contextSnapshot })),
        actions: actions.map(action => ({ id: action.id, kind: action.kind, status: action.status, outcome: action.outcome, cause: action.cause,
          ownerType: action.ownerType, attemptCount: action.attemptCount, maxAttempts: action.maxAttempts,
          createdAt: action.createdAt, resolvedAt: action.resolvedAt, evidence: action.evidence })),
        notes: notes.map(note => ({ id: note.id, body: note.body, metadata: note.metadata })) }, null, 2) + "\n");
    }
    expect.soft(forbidden).toHaveLength(0);
    expect.soft(records).toHaveLength(2);
    expect.soft(notes).toHaveLength(1);
    // org 09:11Z: this fixture is a chat; B''s held note names a new chat, not a new task.
    expect.soft(notes[0]?.body).toBe("Coder can't continue this chat from its saved state. Start a new chat with Coder; this one stays readable.");
    expect.soft(notes[0]?.metadata).toMatchObject({ authorizationReason: `unanswered_message:${messageId}`,
      recoveryResponsibility: "user" });
  }, 60_000);
});
