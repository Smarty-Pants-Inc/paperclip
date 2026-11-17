import { randomUUID } from "node:crypto";
import { assignedWorkSweep } from "./recovery/assigned-work-sweep.js";
import { currentNotices } from "./rfl-current-notice-assertions.js";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations, activityLog, agentTaskSessions, agentWakeupRequests, agents, approvals, authUsers, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueApprovals, issueRecoveryActions, issueThreadInteractions,
  heartbeatRunEvents, issueComments, issues, nativeRunFinalizations, toolInvocations, companyMemberships,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { PENDING_CONTINUATION_BOUND_MS } from "./recovery-continuation-pacing.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import {
  FRESH_CONTINUATIONS_PER_HOUR, FRESH_CONTINUATION_SCHEMA, PERSON_OWNED_FAILURE_CODES, continueHeldExecutions, ensureFreshContinuation,
  resetBacklogContinuationPacingForTests,
  freshContinuationNote, heldExecutionsAwaitingFreshContinuation, nextFreshContinuationCheckAt, recordFreshContinuationCheck, FRESH_CONTINUATION_PENDING_BOUND_MS, FRESH_CONTINUATION_PROGRESS_BOUND_MS, FRESH_CONTINUATION_SAVED_WORK_BOUND_MS,
} from "./fresh-continuation-fallback.js";
import { deriveTaskKeyWithHeartbeatFallback, heartbeatService, shouldResetTaskSessionForWake } from "./heartbeat.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { currentProcessSpaceHash, observedProcessStartedAt } from "./controller-process-identity.js";
import { executionControlSchedule } from "./execution-control-work.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { agentRunWritesRevoked, assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { loadAgentRunAuthentication } from "../middleware/agent-run-authentication.js";
import { SERVER_RESTART_RETRY_MAX_ATTEMPTS, SERVER_RESTART_RETRY_WINDOW_MS } from "./execution-recovery-attempt.js";
import { FRESH_CONTINUATION_WINDOW_MS } from "./fresh-continuation-fallback.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { createSystemRecovery } from "./system-recovery-state.js";
import { requestTaskRetry, taskRetryMutationAllowed } from "./task-retry.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
const NATIVE_CONTINUATION_REFUSED_ACTION = "Your message and saved work are kept, but the previous run of this conversation did not finish. Send a new message to try again.";
import { readFreshThreadStopProof, FRESH_THREAD_STARTED_NOTE } from "./native-runtime/fresh-thread-stop-gate.js";
import { selectFreshContinuationThread } from "./native-runtime/pi-conversation-record.js";
import { prepareSupersededWarmSandboxStop } from "./sandbox-stop-and-retain.js";
import { createReusableLeaseHandoff } from "./environment-lease-handoff.js";
import { sharedContinuationAttempts } from "./recovery/continuation-ledger.js";
import { taskAutomaticAttempts } from "./recovery/task-automatic-attempts.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// Copy shown to people never asks them to inspect or repair a sandbox, workspace or run.
const adminText = /sandbox|inspect|repair|administrator|reconcile/i;

type Seed = {
  runtime: "native" | "legacy"; status?: "failed" | "interrupted" | "timed_out" | "cancelled";
  errorCode: string; error?: string;
  /** How today's code leaves the run: an active hold (before disposition) or a settled-but-blocked hold (older releases). */
  hold?: "active" | "settled_blocked" | "none";
  coordinatorState?: string;
};

suite("fresh-continuation fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-fresh-continuation-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "FCF",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);

  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.principalType, "user")));
    // The drain covers every background run, wake and resume dispatch, so
    // nothing still holds these tables. A deadlock here is a leak to fix.
    await db.execute(sql`truncate table issue_recovery_actions, native_run_finalizations, tool_invocations,
      issue_approvals, approvals, issue_thread_interactions, activity_log, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  /** A run that ended without finishing, in the shape today's release leaves it. */
  async function unfinishedRun(seed: Seed) {
    const issueId = randomUUID(), runId = randomUUID();
    const finishedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release notes", status: "blocked",
      assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId,
      nativeIssueId: seed.runtime === "native" ? issueId : null, runtimeMode: seed.runtime,
      status: seed.status ?? "failed", errorCode: seed.errorCode, error: seed.error ?? seed.errorCode,
      startedAt: new Date(finishedAt.getTime() - 10 * 60_000), finishedAt, createdAt: new Date(finishedAt.getTime() - 11 * 60_000),
      responsibleUserId: userId, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      ...(seed.runtime === "native" ? { nativePhase: "terminal_failure" }
        : { runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } } }) });
    if (seed.runtime === "native") {
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        recoveryState: seed.coordinatorState ?? "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    }
    let actionId: string | null = null;
    if ((seed.hold ?? "active") !== "none") {
      const native = seed.runtime === "native";
      const settled = seed.hold === "settled_blocked";
      const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        status: settled ? "resolved" : "active", outcome: settled ? "blocked" : null, resolvedAt: settled ? finishedAt : null,
        ownerType: "board", returnOwnerAgentId: agentId,
        cause: native ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
        fingerprint: native ? `native-continuation:${runId}` : `legacy-execution:${runId}`,
        nextAction: "Inspect the original failure and reconcile the previous execution before continuing. Automatic recovery cannot start another incident.",
        maxAttempts: 3, createdAt: finishedAt,
        evidence: { runId, originalFailureCode: seed.errorCode, nativeFailureBlock: { runId, statusVersion: 4 },
          ...(settled ? { automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked",
            actionOutcome: "unknown", recordedAt: finishedAt.toISOString() } } : {}) } }).returning();
      actionId = action!.id;
    }
    return { issueId, runId, actionId };
  }

  const issue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const successors = async (runId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  /** Keeps the agent's only slot busy, so a delivered continuation stays observable as queued. */
  async function occupySlot() {
    const [other] = await db.insert(issues).values({ companyId, title: "Other work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running", contextSnapshot: { issueId: other!.id } });
  }
  async function deliver() {
    const heartbeat = heartbeatService(db);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
  }

  async function expectOneFreshSuccessor(f: { issueId: string; runId: string }) {
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    expect(await issue(f.issueId)).toMatchObject({ status: "todo" });
    await occupySlot();
    await deliver();
    const next = await successors(f.runId);
    expect(next).toHaveLength(1);
    expect(next[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId, previousRunId: f.runId, forceFreshSession: true,
      wakeReason: "issue_recovery_action_restored" });
    const [record] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    expect(record!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: next[0]!.id,
      freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: f.runId },
      executionReconciliation: { runId: f.runId, providerStopped: true, actionOutcome: "mixed" } });
    expect(record!.nextAction).not.toMatch(adminText);
    expect(record!.ownerType).toBe("system");
    return next[0]!;
  }

  /** A failed native thread whose saved identity can be linked at selection. */
  async function unfinishedThread(seed: Seed) {
    const f = await unfinishedRun(seed);
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    return f;
  }

  /** The note is owed at actual thread selection, not fallback recording. */
  async function selectFreshSuccessor(f: { issueId: string; runId: string }) {
    const next = await expectOneFreshSuccessor(f);
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.issueId })
      .where(eq(heartbeatRuns.id, next.id));
    const input = { companyId, agentId, issueId: f.issueId, runId: next.id };
    const selected = await selectFreshContinuationThread(db, input);
    expect(selected).toEqual(expect.any(String));
    expect(await selectFreshContinuationThread(db, input)).toBe(selected);
    expect(await successors(f.runId)).toHaveLength(1);
    return next;
  }

  // rf-3 R-SILENT (stack135, RFL 09:01Z). Keep reason: never-OK person-facing
  // guarantee. An accepted person message whose run succeeded with no published
  // answer is answered, or gets a successor or one truthful notice, within 120 s.
  // Synthetic DB shape, real heartbeat wrapper + assigned-work checker. NOT live proof.
  it("R-SILENT: succeeded chat with no published answer has a visible notice or successor after 121 seconds", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "adapter_failed", hold: "none" });
    const ended = new Date(Date.now() - 121_000);
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId,
      body: "Please answer this accepted request.", createdAt: new Date(ended.getTime() - 60_000) }).returning();
    await db.update(issues).set({ status: "in_progress", conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", blockedTransitionAt: null }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: ended, createdAt: new Date(ended.getTime() - 30_000),
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message.id } }).where(eq(heartbeatRuns.id, f.runId));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
    const upstreamSweep = assignedWorkSweep(db, { enqueueWakeup: async () => { throw new Error("unexpected unobserved wake"); } });
    const result = await upstreamSweep.checkIssue({ companyId, issueId: f.issueId });
    const card = await taskInterruptionPresentation(db, await issue(f.issueId));
    const notices = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"))))
      .filter(comment => !comment.deletedAt);
    const live = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId), inArray(heartbeatRuns.status, ["queued", "running"])));
    console.info(JSON.stringify({ rSilent: { messageId: message.id, elapsed: Date.now() - ended.getTime(), result, card, notices: notices.length, live: live.length } }));
    expect(notices.length > 0 || live.length > 0 || ["failed", "retry_scheduled"].includes(card?.state ?? ""),
      "a succeeded run is not evidence of an answer; conversation wait cannot silently retire accepted input").toBe(true);
  }, 120_000);

  // R-SILENT owner check (stack135 F1): the re-homed rule lives in upstream's
  // conversation outbox, fires once per message, waits out the finalizer's
  // grace, and stays quiet once anything answered.
  it.each(["silent", "inside_grace", "answered", "newer_message"] as const)("R-SILENT redelivers a succeeded-but-unanswered message exactly once: %s", async shape => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "adapter_failed", hold: "none" });
    const ended = new Date(Date.now() - (shape === "inside_grace" ? 30_000 : 121_000));
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId,
      body: "Please answer this accepted request.", createdAt: new Date(ended.getTime() - 60_000) }).returning();
    await db.update(issues).set({ status: "in_progress", conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", blockedTransitionAt: null }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: ended, createdAt: new Date(ended.getTime() - 30_000),
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message.id } }).where(eq(heartbeatRuns.id, f.runId));
    if (shape === "answered") await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "agent", authorAgentId: agentId,
      body: "Here is the answer.", createdAt: new Date(ended.getTime() - 1_000) });
    if (shape === "newer_message") await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId,
      body: "And one more thing.", createdAt: new Date(ended.getTime() + 1_000) });
    const deadlines: number[] = [];
    const heartbeat = heartbeatService(db);
    for (let pass = 0; pass < 3; pass++) {
      await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId, onDeferredDeadline: at => { deadlines.push(at); } });
    }
    const redeliveries = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, `conversation-comment-redelivery:${message.id}`)));
    const original = (await db.select().from(issueComments).where(eq(issueComments.id, message.id)))[0];
    console.info(JSON.stringify({ rSilentOwner: { shape, redeliveries: redeliveries.length, deadlines: deadlines.length,
      runs: redeliveries.map(row => row.runId) } }));
    expect(original).toMatchObject({ body: "Please answer this accepted request.", authorUserId: userId, deletedAt: null });
    if (shape === "silent") {
      expect(redeliveries).toHaveLength(1);
      expect(redeliveries[0]).toMatchObject({ reason: "issue_commented", requestedByActorType: "user", requestedByActorId: userId });
      const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, redeliveries[0]!.id));
      expect(next?.contextSnapshot).toMatchObject({ issueId: f.issueId, wakeCommentId: message.id });
    } else expect(redeliveries).toHaveLength(0);
    if (shape === "inside_grace") expect(deadlines).toContain(ended.getTime() + 90_000);
  }, 120_000);

  /** A person's message whose own conversation turn succeeded with no reply, ended at `ended`. */
  async function silentConversationTurn(ended: Date, person = userId) {
    const f = await unfinishedRun({ runtime: "native", errorCode: "adapter_failed", hold: "none" });
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: person,
      body: "Please answer this accepted request.", createdAt: new Date(ended.getTime() - 60_000) }).returning();
    await db.update(issues).set({ status: "in_progress", conversationAgentId: agentId, conversationUserId: person,
      conversationState: "active", blockedTransitionAt: null }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: ended, createdAt: new Date(ended.getTime() - 30_000),
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message!.id } }).where(eq(heartbeatRuns.id, f.runId));
    const redeliveries = async () => db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, `conversation-comment-redelivery:${message!.id}`)));
    return { ...f, messageId: message!.id, redeliveries };
  }

  // RFL DESIGN-F1 condition 1 (R-REPLAY): the redelivered turn continues the
  // SAME provider session as the silent run (the comment-wake path resumes the
  // task session keyed by the issue; nothing forces a fresh session), so the
  // model sees its own earlier turn and no tool of that turn runs again.
  it("R-REPLAY: the redelivered turn resumes the silent run's provider session, never a fresh one", async () => {
    const f = await silentConversationTurn(new Date(Date.now() - 121_000));
    const sessionId = `pi-session-${randomUUID()}`;
    await db.update(heartbeatRuns).set({ sessionIdBefore: sessionId, sessionIdAfter: sessionId }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner", taskKey: f.issueId,
      sessionDisplayId: sessionId, sessionParamsJson: { sessionId }, lastRunId: f.runId });
    await occupySlot(); // keep the redelivered run queued, as admitted
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
    const [wake] = await f.redeliveries();
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wake!.id));
    const [silent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    // The same resolvers heartbeat.ts uses at run start (taskKey -> getTaskSession; reset gate).
    const nextKey = deriveTaskKeyWithHeartbeatFallback(next!.contextSnapshot, null);
    expect(nextKey).toBe(deriveTaskKeyWithHeartbeatFallback(silent!.contextSnapshot, null));
    expect(next!.contextSnapshot?.forceFreshSession).toBeUndefined();
    expect(shouldResetTaskSessionForWake(next!.contextSnapshot)).toBe(false);
    const [resumed] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, nextKey!)));
    console.info(JSON.stringify({ rReplay: { silentSession: silent!.sessionIdAfter, redeliveredSession: resumed?.sessionDisplayId, nextRunId: next!.id } }));
    expect(resumed?.sessionDisplayId).toBe(silent!.sessionIdAfter);
    // session-preparation resumes only a session whose last run is another run.
    expect(resumed?.lastRunId).toBe(f.runId);
    expect(resumed?.lastRunId).not.toBe(next!.id);
  }, 120_000);

  // D109/D131 (isolation) + D159 (race), re-homed onto the R-SILENT owner: one
  // unscoped stranded sweep over a mixed population, run by two workers at
  // once, neither throws nor starves a conversation, and each silent message
  // gets exactly one redelivery (wake key under the conversation-delivery lock).
  it("R-SILENT: two racing unscoped sweeps over mixed conversations give each silent message exactly one redelivery", async () => {
    const ended = new Date(Date.now() - 121_000);
    const people: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = randomUUID(); people.push(id);
      await db.insert(authUsers).values({ id, name: `Person ${i}`, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    }
    const silent = [];
    for (let i = 0; i < 4; i++) silent.push(await silentConversationTurn(ended, people[i]));
    const answered = await silentConversationTurn(ended, people[4]);
    await db.insert(issueComments).values({ companyId, issueId: answered.issueId, authorType: "agent", authorAgentId: agentId,
      body: "Here is the answer.", createdAt: new Date(ended.getTime() - 1_000) });
    const grace = await silentConversationTurn(new Date(Date.now() - 10_000), people[5]);
    await occupySlot();
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.reconcileStrandedAssignedIssues({ companyId }), heartbeatService(db).reconcileStrandedAssignedIssues({ companyId })]);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId });
    const counts = { silent: await Promise.all(silent.map(async s => (await s.redeliveries()).length)),
      answered: (await answered.redeliveries()).length, grace: (await grace.redeliveries()).length };
    console.info(JSON.stringify({ rSilentMixedRace: counts }));
    expect(counts).toEqual({ silent: [1, 1, 1, 1], answered: 0, grace: 0 });
  }, 120_000);

  // RFL DESIGN-F1 condition 2 (the clock), on a fake clock: the run ends at t,
  // nothing happens before t+90 s, ONE wake lands by t+120 s, and a second
  // recovery pass is a no-op (wake idempotency key).
  it("R-SILENT clock: nothing before t+90 s, one wake by t+120 s, a second pass is a no-op", async () => {
    const t = new Date(Date.now() - 600_000);
    const f = await silentConversationTurn(t);
    await occupySlot();
    const heartbeat = heartbeatService(db);
    const deadlines: number[] = [];
    const pass = (at: number) => { vi.setSystemTime(at);
      return heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId, onDeferredDeadline: d => { deadlines.push(d); } }); };
    vi.useFakeTimers({ toFake: ["Date"] });
    const seen: Array<{ at: number; wakes: number }> = [];
    try {
      for (const offset of [0, 45_000, 89_999]) {
        await pass(t.getTime() + offset);
        seen.push({ at: offset, wakes: (await f.redeliveries()).length });
      }
      await pass(t.getTime() + 120_000);
      seen.push({ at: 120_000, wakes: (await f.redeliveries()).length });
      await pass(t.getTime() + 120_000);
      await pass(t.getTime() + 600_000);
      seen.push({ at: 600_000, wakes: (await f.redeliveries()).length });
    } finally { vi.useRealTimers(); }
    console.info(JSON.stringify({ rSilentClock: { seen, deadlines: deadlines.map(d => d - t.getTime()) } }));
    expect(seen).toEqual([{ at: 0, wakes: 0 }, { at: 45_000, wakes: 0 }, { at: 89_999, wakes: 0 }, { at: 120_000, wakes: 1 }, { at: 600_000, wakes: 1 }]);
    expect(deadlines.length).toBeGreaterThanOrEqual(3);
    expect(deadlines.every(d => d === t.getTime() + 90_000)).toBe(true);
  }, 120_000);

  // stack135 FIX3 item 2 (D129/D150/D151/D183): the rule is keyed on the run
  // that carried the person's message, not the latest run. An unrelated timer
  // run that succeeds afterwards must not hide the silent turn.
  it("R-SILENT keys on the message's own run: an unrelated later success still gets exactly one redelivery", async () => {
    const ended = new Date(Date.now() - 200_000);
    const f = await silentConversationTurn(ended);
    const [timer] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, invocationSource: "timer",
      status: "succeeded", createdAt: new Date(ended.getTime() + 5_000), startedAt: new Date(ended.getTime() + 10_000),
      finishedAt: new Date(ended.getTime() + 20_000), responsibleUserId: userId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "heartbeat_timer", wakeSource: "timer" } }).returning();
    await occupySlot();
    const heartbeat = heartbeatService(db);
    for (let pass = 0; pass < 3; pass++) await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
    const wakes = await f.redeliveries();
    const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.wakeupRequestId, wakes.map(w => w.id)));
    console.info(JSON.stringify({ rSilentLaterSuccess: { timerRunId: timer!.id, redeliveries: wakes.length, carried: runs.map(r => r.contextSnapshot?.wakeCommentId) } }));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.payload).toMatchObject({ commentId: f.messageId, redeliveredAfterRunId: f.runId });
    expect(runs.map(r => r.contextSnapshot?.wakeCommentId)).toEqual([f.messageId]);
  }, 120_000);

  // Item 2 boundary (stack135 r3): upstream keeps a failed turn while it is the
  // task's latest attempt (the card offers Retry), and a person's Stop is never
  // restarted. The redelivery re-offers only a failed turn the card no longer shows.
  it.each(["failed_is_latest", "cancelled_then_unrelated_success"] as const)("a person's %s turn is left to its upstream owner, never redelivered", async shape => {
    const t = new Date(Date.now() - 600_000);
    const f = await silentConversationTurn(t);
    await db.update(heartbeatRuns).set({ status: shape === "failed_is_latest" ? "failed" : "cancelled", errorCode: shape === "failed_is_latest" ? "adapter_failed" : "cancelled",
      error: "adapter failed before an answer" }).where(eq(heartbeatRuns.id, f.runId));
    if (shape !== "failed_is_latest") await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, invocationSource: "timer",
      status: "succeeded", createdAt: new Date(t.getTime() + 5_000), startedAt: new Date(t.getTime() + 10_000), finishedAt: new Date(t.getTime() + 20_000),
      responsibleUserId: userId, contextSnapshot: { issueId: f.issueId, wakeReason: "heartbeat_timer", wakeSource: "timer" } });
    await occupySlot();
    const heartbeat = heartbeatService(db);
    for (let pass = 0; pass < 3; pass++) await heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
    const card = await taskInterruptionPresentation(db, await issue(f.issueId));
    console.info(JSON.stringify({ rSilentUpstreamOwner: { shape, redeliveries: (await f.redeliveries()).length, card: card && { state: card.state, canRetry: card.canRetry } } }));
    expect(await f.redeliveries()).toHaveLength(0);
    if (shape === "failed_is_latest") expect(card).toMatchObject({ state: "failed", canRetry: true });
  }, 120_000);

  // RFL 12:36Z regression probes. Keep reasons: executor exclusion is a data
  // safety boundary; these reproduce the recorded D10 failure paths.
  it.each(["queued", "succeeded", "older_answer"])("RFL F1 checks %s before any stop or note", async shape => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const sessionId = randomUUID();
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, f.runId));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      nativeSessionId: sessionId, status: shape === "queued" ? "queued" : "succeeded",
      createdAt: new Date(source.createdAt.getTime() + (shape === "older_answer" ? -1000 : 1000)),
      finishedAt: shape === "queued" ? null : new Date() });
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `rfl-f1-${randomUUID()}`, status: "retained", metadata: { pluginId: "fixture-boat" } }).returning();
    const result = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    if (shape === "older_answer") {
      // follow-Paperclip Cut B R1/R2/R5: an earlier answer does not block this follow-up or request a stop; selection owns its note.
      expect(result).toMatchObject({ kind: "continued" });
      expect(await successors(f.runId)).toHaveLength(0);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
      await selectFreshSuccessor(f);
      expect(currentNotices(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))))
        .toMatchObject([{ body: FRESH_THREAD_STARTED_NOTE }]);
    } else {
      expect(result).toMatchObject({ kind: "successor_exists" });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0])
        .toMatchObject({ status: "retained", metadata: { pluginId: "fixture-boat" } });
    }
  });

  it("RFL extra legacy code-only rows use the ordinary fallback without physical stop", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "native_controller_recovery_unsupported:metadata_format" });
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      provider: "boat", providerLeaseId: `legacy-d10-${randomUUID()}`, status: "retained", metadata: { pluginId: "fixture-boat" } }).returning();
    // follow-Paperclip Cut B R1/R5: diagnostic-only refusals no longer require stop proof or rearm cleanup.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now: new Date(Date.now() + 30 * 24 * 3600_000) }))
      .toMatchObject({ kind: "already_continued" });
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
    await expectOneFreshSuccessor(f);
  });

  it.each(["no_lease", "local", "no_provider_id"])("RFL F2 nothing to stop ends and delivers (%s)", async shape => {
    const f = await unfinishedThread({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    if (shape !== "no_lease") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId,
      issueId: f.issueId, provider: shape === "local" ? "local" : "boat", providerLeaseId: null, status: "released" });
    // follow-Paperclip Cut B R1/R2: missing stop proof permits ordinary fallback; the one note moves to selection.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    expect(await successors(f.runId)).toHaveLength(0);
    if (shape === "no_provider_id") expect(await requestTaskRetry({ db, companyId, issueId: f.issueId,
      actorId: userId, actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() }))
      .toMatchObject({ accepted: true });
    await selectFreshSuccessor(f);
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(FRESH_THREAD_STARTED_NOTE);
  });

  it.each(["missing_allocation", "foreign_launch", "process_read_failed"])("RFL round5 F2-end truthful end and working Retry (%s)", async shape => {
    const f = await unfinishedThread({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const [lease] = shape === "missing_allocation" ? await db.insert(environmentLeases).values({ companyId,
      heartbeatRunId: f.runId, issueId: f.issueId, provider: "boat", providerLeaseId: null,
      status: "released", metadata: { pluginId: "fixture-boat" } }).returning() : [];
    if (shape === "foreign_launch") await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId,
      seq: 1, eventType: "native.process_start_requested", stream: "system", level: "info", message: "Remote launch requested",
      payload: { targetKind: "remote", hostname: "earlier-controller" } });
    const root = await mkdtemp(join(tmpdir(), "d10-end-process-read-"));
    await writeFile(join(root, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    try {
      if (shape === "process_read_failed") vi.stubEnv("PATH", root);
      // follow-Paperclip Cut B R1/R2/R8: ordinary continuation replaces the stop wait; keep one note at selection.
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
        .toMatchObject({ kind: "continued" });
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now: new Date(Date.now() + 30 * 24 * 3600_000) }))
        .toMatchObject({ kind: "already_continued" });
      const task = await issue(f.issueId);
      expect(await taskInterruptionPresentation(db, { id: task.id, companyId, status: task.status,
        assigneeAgentId: task.assigneeAgentId, projectId: task.projectId }))
        .toMatchObject({ state: "working", canRetry: false });
      const click = () => requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId, actorSource: "local_implicit",
        observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(await click()).toMatchObject({ accepted: true, stale: false });
      expect(await successors(f.runId)).toHaveLength(0);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0].evidence)
        .toHaveProperty("freshContinuation");
      if (lease) expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
      vi.unstubAllEnvs();
      const key = randomUUID();
      const repairedClick = () => requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId, actorSource: "local_implicit",
        observedRunId: f.runId, idempotencyKey: key });
      expect(await repairedClick()).toMatchObject({ accepted: true });
      expect(await repairedClick()).toMatchObject({ accepted: true });
      await selectFreshSuccessor(f);
      const currentNotes = currentNotices(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)));
      expect(currentNotes).toHaveLength(1);
      expect(currentNotes[0].body).toBe(FRESH_THREAD_STARTED_NOTE);
      const receipts = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "task_retry")));
      expect(receipts.every(receipt => receipt.status === "coalesced")).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it("RFL round5 F2-end ordinary Retry does not re-arm the existing stop owner", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `retry-stop-${randomUUID()}`, status: "retained", metadata: { pluginId: "fixture-boat" } }).returning();
    // follow-Paperclip Cut B R1/R3/R5: Retry joins the ordinary continuation and never rearms stop-only cleanup.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    const [pending] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    const metadata: Record<string, unknown> = { ...pending.metadata, pendingCleanupRetryAttempts: 5, pendingCleanupRetryCapWarned: true,
      pendingCleanupRetryAfterMs: Date.now() + 3600_000 };
    await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, lease.id));
    await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    const task = await issue(f.issueId);
    expect(await taskInterruptionPresentation(db, { id: task.id, companyId, status: task.status,
      assigneeAgentId: task.assigneeAgentId, projectId: task.projectId })).toMatchObject({ state: "working", canRetry: false });
    const retryInput = { db, companyId, issueId: f.issueId, actorId: userId, actorSource: "local_implicit",
      observedRunId: f.runId, idempotencyKey: randomUUID() };
    // An automatic restart hook cannot renew a deliberately exhausted budget.
    expect(await requestTaskRetry({ ...retryInput, initiatedBy: "restart_recovery" })).toMatchObject({ accepted: true });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0].metadata)
      .toMatchObject({ pendingCleanupRetryAttempts: 5 });
    expect(await requestTaskRetry({ ...retryInput, idempotencyKey: randomUUID() })).toMatchObject({ accepted: true });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0])
      .toMatchObject({ providerLeaseId: lease.providerLeaseId, status: "retained", metadata });
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0].evidence)
      .toHaveProperty("freshContinuation");
    await expectOneFreshSuccessor(f);
  });

  it("RFL round5 F2-end Retry refuses a principal without task access before touching cleanup", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `no-access-${randomUUID()}`, status: "retained", metadata: { pluginId: "fixture-boat" } }).returning();
    // follow-Paperclip Cut B R3 (RFL 08:06Z ruling (a)): the removed typed Retry branch (task-retry.ts, D10) refused
    // here with 403. As upstream, access is refused at the route (issue-agent-mutation-ownership-routes.test.ts
    // "admits ordinary Retry only for a board actor with task mutation permission") and again at delivery
    // (task-retry.ts taskRetryMutationAllowed). The access hard line moves; it does not vanish.
    const actorId = randomUUID();
    expect(await taskRetryMutationAllowed(db, { companyId, issueId: f.issueId, actorId, actorSource: "session" })).toBe(false);
    await requestTaskRetry({ db, companyId, issueId: f.issueId, actorId,
      observedRunId: f.runId, idempotencyKey: randomUUID() }).catch(() => undefined);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    await deliver();
    // No run is ever created from that principal's wake.
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.requestedByActorId, actorId)));
    expect(wakes.filter(wake => wake.runId !== null)).toEqual([]);
    const fromWakes = wakes.length ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.wakeupRequestId, wakes.map(wake => wake.id)))) : [];
    expect(fromWakes).toEqual([]);
  });

  it("RFL F2 an unbound local process is not stop proof, but permits isolated continuation", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "runner_remote_state_unavailable" });
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.runId));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    // follow-Paperclip Cut B R1/R5: the retained proof reader still rejects an unbound PID; fallback does not demand its proof.
    expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
    expect(await successors(f.runId)).toHaveLength(0);
    await expectOneFreshSuccessor(f);
  });

  // Keep: executor exclusion/data safety, RFL's refused-predecessor catch.
  it.each([true, false])("RFL round4 F6 checks earlier-process settlement proof without gating fresh admission (nativeIssueId=%s)", async nativeIssue => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const sessionId = randomUUID();
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(dead.status).toBe(0);
    const [source] = await db.update(heartbeatRuns).set({ nativeSessionId: sessionId, processPid: Number(dead.stdout.trim()) })
      .where(eq(heartbeatRuns.id, f.runId)).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId,
      nativeIssueId: nativeIssue ? f.issueId : null, nativeSessionId: sessionId,
      runtimeMode: "native", status: "failed", processPid: process.pid,
      createdAt: new Date(source.createdAt.getTime() - 1000), finishedAt: source.finishedAt });
    // follow-Paperclip Cut B R1/R5: earlier-process proof stays false at settlement, not a veto on a fresh continuation.
    expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    expect(await successors(f.runId)).toHaveLength(0);
    await expectOneFreshSuccessor(f);
  });

  it.each(["refused", "earlier"])("RFL round4 F2-positive live %s runner fails stop proof without vetoing fresh continuation", async which => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    let ownerId = f.runId;
    if (which === "earlier") {
      const sessionId = randomUUID(); ownerId = randomUUID();
      const [source] = await db.update(heartbeatRuns).set({ nativeSessionId: sessionId })
        .where(eq(heartbeatRuns.id, f.runId)).returning();
      await db.insert(heartbeatRuns).values({ id: ownerId, companyId, agentId, nativeSessionId: sessionId,
        runtimeMode: "native", status: "failed", contextSnapshot: { issueId: f.issueId },
        createdAt: new Date(source.createdAt.getTime() - 1000), finishedAt: source.finishedAt });
    }
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)", "--", "--run-id", ownerId],
      { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout!, "data");
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      // follow-Paperclip Cut B R1/R5: positive process-table proof is retained for settlement, not fresh admission.
      expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
        .toMatchObject({ kind: "continued" });
      expect(await successors(f.runId)).toHaveLength(0);
    } finally {
      const exited = once(child, "exit"); child.kill(); await exited;
    }
    // The same positive process-table read now proves no local owner exists.
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: true });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "already_continued" });
    await expectOneFreshSuccessor(f);
  });

  it("RFL round4 F2-positive a failed process-table read is not an empty owner set", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const root = await mkdtemp(join(tmpdir(), "d10-process-table-failure-"));
    await writeFile(join(root, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    try {
      vi.stubEnv("PATH", root);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      // follow-Paperclip Cut B R1/R5: a failed process read is not death proof, but fresh continuation no longer requires death.
      expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
        .toMatchObject({ kind: "continued" });
      expect(await successors(f.runId)).toHaveLength(0);
      vi.unstubAllEnvs();
      await expectOneFreshSuccessor(f);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["remote", "other-host"])("RFL round4 F2-positive a missing row cannot turn a %s launch into local proof", async shape => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId,
      seq: 1, eventType: "native.process_start_requested", stream: "system", level: "info",
      message: "Prior launch requested", payload: { targetKind: shape === "remote" ? "remote" : "local", hostname: "another-host" } });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    // follow-Paperclip Cut B R1/R5: missing remote/foreign launch proof still fails settlement, not the ordinary fallback.
    expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    expect(await successors(f.runId)).toHaveLength(0);
    await expectOneFreshSuccessor(f);
  });

  it.each(["native_runner_refresh_required", "runner_remote_state_unavailable", "native_runner_launch_profile_mismatch"])(
    "RFL round4 F9 final wording distinguishes skill refresh from generic refusal (%s)", async code => {
      const f = await unfinishedThread({ runtime: "native", errorCode: code });
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
        .toMatchObject({ kind: "continued" });
      // follow-Paperclip Cut B R2: preserve the exactly-one wording assertion at actual thread selection.
      await selectFreshSuccessor(f);
      const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(notes).toHaveLength(1);
      if (code === "native_runner_refresh_required") {
        expect(notes[0].body).toContain("your skill change is in effect; Coder restarted its working thread");
        expect(notes[0].body).not.toContain("could not be safely restored");
      } else {
        expect(notes[0].body).toBe(FRESH_THREAD_STARTED_NOTE);
        expect(notes[0].body).not.toMatch(/skill change/);
      }
    });

  it.each(["missing-allocation", "failed-process-read", "bound-remote"])("D10 cold restore backup_without_reusable_lease continues without positive stop proof (%s)", async shape => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_harness_state_mismatch: backup_without_reusable_lease",
      error: "runner_harness_state_mismatch: backup_without_reusable_lease" });
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = shape === "failed-process-read" ? [] : await db.insert(environmentLeases).values({ companyId,
      heartbeatRunId: f.runId, issueId: f.issueId, provider: "boat",
      providerLeaseId: shape === "missing-allocation" ? null : `cold-restore-${randomUUID()}`,
      status: "released", metadata: { pluginId: "fixture-boat" } }).returning();
    const root = await mkdtemp(join(tmpdir(), "d10-cold-restore-positive-proof-"));
    await writeFile(join(root, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    try {
      if (shape === "failed-process-read") vi.stubEnv("PATH", root);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      // follow-Paperclip Cut B R1/R2/R5: cold-restore refusal uses the fallback without stop repair; the one note belongs to selection.
      expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
        .toMatchObject({ kind: "continued" });
      expect(await successors(f.runId)).toHaveLength(0);
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now: new Date(Date.now() + 30 * 24 * 3600_000) }))
        .toMatchObject({ kind: "already_continued" });
      vi.unstubAllEnvs();
      await selectFreshSuccessor(f);
      const before = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(before).toHaveLength(1);
      expect(before[0].body).toBe(FRESH_THREAD_STARTED_NOTE);
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
        .toMatchObject({ kind: "already_continued" });
      const after = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(currentNotices(after, before)).toHaveLength(1);
      if (lease) expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it("RFL F3 appends changed notes, supersedes without rewriting another owner's note, and is idempotent", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const sessionId = randomUUID();
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, f.runId));
    const [held] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "system",
      body: "The prior owner is held.", metadata: { version: 1, authorizationReason: `native_prior_owner_held:${sessionId}`,
        sections: [{ rows: [{ type: "text", text: "Original held notice" }] }] } }).returning();
    // follow-Paperclip Cut B R2/R5: remove the gate's intermediate note, but keep append-only history and one current note at selection.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    await selectFreshSuccessor(f);
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(notes).toHaveLength(2);
    expect(notes.find(note => note.id === held.id)).toMatchObject({ body: held.body,
      metadata: { authorizationReason: held.metadata!.authorizationReason, supersededByCommentId: expect.any(String) } });
    expect(notes.filter(note => !note.metadata?.supersededByCommentId).map(note => note.body))
      .toEqual([FRESH_THREAD_STARTED_NOTE]);
    expect(currentNotices(notes, [held])).toHaveLength(1);
  });

  it.each([
    ["runner_remote_state_unavailable", undefined],
    ["native_controller_recovery_missing_evidence:snapshot_binding", undefined],
    ["native_controller_recovery_unsupported:metadata_format", undefined],
    ["native_runner_refresh_required", "provider_live_descendants"],
    ["native_runner_refresh_required", "provider_active_goal"],
    ["native_runner_launch_profile_mismatch", "provider_launch_profile_mismatch"],
  ])("RFL F4 preserves the actual live owner for %s / %s", async (code, prepareRefusalCode) => {
    const f = await unfinishedRun({ runtime: "native", errorCode: code });
    const sessionId = randomUUID();
    const [source] = await db.update(heartbeatRuns).set({ nativeSessionId: sessionId,
      resultJson: { nativeFreshContinuationRefusal: { code, prepareRefusalCode, waitForTurn: true } } })
      .where(eq(heartbeatRuns.id, f.runId)).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      nativeSessionId: sessionId, status: "running", createdAt: new Date(source.createdAt.getTime() - 1000) });
    // follow-Paperclip Cut B R1/R5: the ordinary actual-owner guard replaces the gate's turn-wait narration.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "successor_exists" });
    expect(await successors(f.runId)).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId), eq(heartbeatRuns.status, "running")))))
      .toHaveLength(1);
  });

  it("RFL F7 retained cleanup owns stop-and-keep independently of one fresh wake across a reuse chain", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    const sessionId = randomUUID(), predecessorId = randomUUID();
    const [source] = await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, f.runId)).returning();
    await db.insert(heartbeatRuns).values({ id: predecessorId, companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      nativeSessionId: sessionId, status: "failed", createdAt: new Date(source.createdAt.getTime() - 60_000),
      finishedAt: new Date(source.createdAt.getTime() - 30_000) });
    const [environment] = await db.insert(environments).values({ name: "RFL stop boundary", driver: "sandbox", config: {} }).returning();
    const acquiredAt = new Date(Date.now() - 60_000), providerLeaseId = `rfl-chain-${randomUUID()}`;
    const common = { companyId, issueId: f.issueId, environmentId: environment.id, provider: "boat", providerLeaseId,
      leasePolicy: "reuse_by_environment", metadata: { agentId, pluginId: "fixture-boat" } };
    const [predecessor] = await db.insert(environmentLeases).values({ ...common, heartbeatRunId: predecessorId,
      status: "expired", cleanupStatus: "success", acquiredAt: new Date(acquiredAt.getTime() - 60_000), releasedAt: acquiredAt }).returning();
    const [tip] = await db.insert(environmentLeases).values({ ...common, heartbeatRunId: f.runId, status: "retained", acquiredAt }).returning();
    const handoff = createReusableLeaseHandoff(predecessor, tip);
    await db.update(environmentLeases).set({ metadata: { ...common.metadata, reusableLeaseSuccessor: handoff } })
      .where(eq(environmentLeases.id, predecessor.id));
    await db.update(environmentLeases).set({ metadata: { ...common.metadata, reusableLeasePredecessor: handoff } })
      .where(eq(environmentLeases.id, tip.id));
    const [historical] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, predecessor.id));
    const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, tip.id));
    // follow-Paperclip Cut B R1/R5: fallback does not dispatch stop; retained cleanup still independently owns stop-and-keep.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, predecessor.id)))[0]).toEqual(historical);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, tip.id)))[0]).toEqual(retained);
    // The retained warm box's real stop-only owner (warm expiry / Cut A stop-and-keep), not the removed gate.
    expect(await prepareSupersededWarmSandboxStop(db, retained, { reason: "sandbox_source_changed" })).not.toBeNull();
    // Fake only the external provider boundary. The real sweep claims cleanup,
    // consumes this provider response, binds/persists proof, and emits its work
    // notifications; no test writes remoteExecutionTermination metadata.
    const providerStop = vi.fn(async ({ lease }: { lease: typeof environmentLeases.$inferSelect }) => {
      expect(lease.id).toBe(tip.id);
      expect(lease.metadata).toHaveProperty("sandboxStopAndRetain");
      return { providerLeaseId: lease.providerLeaseId!, state: "stopped" };
    });
    const runtime = { retryPendingSandboxTeardown: providerStop } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"];
    const cleanup = heartbeatService(db, { environmentRuntime: runtime });
    expect(await cleanup.sweepPendingCleanupLeases()).toMatchObject({ destroyed: 1 });
    expect(providerStop).toHaveBeenCalledOnce();
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.issueId, f.issueId));
    expect(rows.find(row => row.id === predecessor.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(rows.find(row => row.id === tip.id)).toMatchObject({ status: "released", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { state: "stopped", leaseId: tip.id, runId: f.runId } } });
    expect(rows.find(row => row.id === predecessor.id)).toEqual(historical);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "already_continued" });
    await expectOneFreshSuccessor(f);
    await db.delete(environmentLeases).where(eq(environmentLeases.environmentId, environment.id));
    await db.delete(environments).where(eq(environments.id, environment.id));
  });

  it.each([
    "native_controller_recovery_missing_evidence:snapshot_binding",
    "native_controller_recovery_unsupported:metadata_format",
  ].flatMap(code => ["void-release", "stopping", "foreign-run", "foreign-lease", "bad-time", "live-peer"]
    .map(shape => [code, shape] as const)))(
    "impossible reconciliation %s preserves invalid %s proof while continuing once", async (errorCode, shape) => {
    const f = await unfinishedRun({ runtime: "native", errorCode });
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    const acquiredAt = new Date(Date.now() - 120_000), releasedAt = new Date();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `fresh-stop-${randomUUID()}`, status: "released", cleanupStatus: "success", acquiredAt, releasedAt,
      metadata: { pluginId: "fixture-boat" } }).returning();
    const receipt = { schema: "paperclip.remote-termination.v1", companyId, runId: f.runId, leaseId: lease.id,
      provider: lease.provider, providerLeaseId: lease.providerLeaseId, state: "stopped", confirmedAt: releasedAt.toISOString() };
    await db.update(environmentLeases).set({ metadata: { pluginId: "fixture-boat", ...(shape === "void-release" ? {} : {
      remoteExecutionTermination: { ...receipt, ...(shape === "stopping" ? { state: "stopping" } : {}),
        ...(shape === "foreign-run" ? { runId: randomUUID() } : {}), ...(shape === "foreign-lease" ? { leaseId: randomUUID() } : {}),
        ...(shape === "bad-time" ? { confirmedAt: "not a time" } : {}) } }) } }).where(eq(environmentLeases.id, lease.id));
    let peerId: string | undefined;
    if (shape === "live-peer") {
      const [peer] = await db.insert(environmentLeases).values({ companyId, issueId: f.issueId, provider: lease.provider,
        providerLeaseId: lease.providerLeaseId, status: "active" }).returning();
      peerId = peer.id;
    }
    const beforeLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.issueId, f.issueId));
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    // follow-Paperclip Cut B R1/R2/R5: invalid receipts stay invalid and immutable at settlement; fresh admission needs no physical-stop upgrade.
    expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now: new Date(Date.now() + 24 * 3600_000) }))
      .toMatchObject({ kind: "already_continued" });
    await selectFreshSuccessor(f);
    const beforeNotes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(beforeNotes).toHaveLength(1);
    expect(beforeNotes[0].body).toBe(FRESH_THREAD_STARTED_NOTE);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "already_continued" });
    const allNotes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(allNotes).toHaveLength(1);
    expect(currentNotices(allNotes, beforeNotes)).toHaveLength(1);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.issueId, f.issueId))).toEqual(beforeLeases);
    if (peerId) expect(beforeLeases.find(row => row.id === peerId)).toMatchObject({ status: "active" });
  });

  // The five most frequent endings on staging (2026-11-12): each left the task
  // Blocked for a person with no successor run.
  it.each([
    { errorCode: "native_continuation_requires_reconciliation", error: "runner_remote_process_identity_unavailable", runtime: "native" as const },
    { errorCode: "controller_lease_lost", error: "Legacy controller lease lost", runtime: "legacy" as const },
    { errorCode: "process_lost", error: "Process lost -- server may have restarted; retrying once", runtime: "legacy" as const },
    { errorCode: "server_shutdown_interrupted", error: "Interrupted by graceful server shutdown (SIGTERM)", runtime: "legacy" as const,
      status: "interrupted" as const },
    { errorCode: "native_session_interrupted", error: "runner_ingress_auth_failed: Runner ingress did not complete PRP authentication",
      runtime: "native" as const },
  ])("continues a task whose run ended with $errorCode in exactly one fresh run from saved work", async seed => {
    const f = await unfinishedRun(seed);
    await settleUnrecoverableExecutions(db);
    const hold = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!;
    expect(hold).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(hold.evidence.automaticRecovery).toBeUndefined();
    await expectOneFreshSuccessor(f);
  }, 60_000);

  // The only native swap failure left on a later staging swap: the Runner
  // resumed a harness that was not suspended or was gone.
  // Exact resume is fixed elsewhere; whatever still fails must fall back.
  it.each([
    { errorCode: "native_session_interrupted",
      error: "runner_ingress_unavailable: runnerd process failed: runner_harness_state_mismatch: resumed_not_suspended" },
    { errorCode: "native_session_interrupted",
      error: "runner_ingress_unavailable: runnerd process failed: runner_harness_state_mismatch: resumed_unavailable" },
    { errorCode: "runner_harness_state_mismatch", error: "runner_harness_state_mismatch: resumed_unavailable" },
  ])("continues a task whose resumed Runner harness was in the wrong state ($error)", async seed => {
    const f = await unfinishedRun({ runtime: "native", ...seed });
    await settleUnrecoverableExecutions(db);
    await expectOneFreshSuccessor(f);
  }, 60_000);

  // Staging: the person had already pressed Retry, and the automatic successor
  // could not carry that authorization forward. That is the system's failure,
  // not the person's: the task continues under its responsible user.
  it("starts the continuation when the failed run's exhaustion hold lands after the continuation was recorded", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_runner_process_exited",
      error: "native_session_recovery_failed: Error: runner_local_connect_failed: runnerd exited unexpectedly" });
    await settleUnrecoverableExecutions(db);
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", returnOwnerAgentId: agentId, cause: "native_session_retry_exhausted", fingerprint: `native-retry:${f.runId}`,
      nextAction: "Automatic recovery stopped.", maxAttempts: 3,
      evidence: { runId: f.runId, coordinatorAttempt: 3, recoveryDisposition: "native_session_retry_exhausted" } });
    await deliver();
    await continueHeldExecutions(db); await settleUnrecoverableExecutions(db); await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
  }, 60_000);

  it("keeps a person's newer block when the failed run's exhaustion hold lands after the continuation was recorded", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_runner_process_exited",
      error: "native_session_recovery_failed: Error: runner_local_connect_failed: runnerd exited unexpectedly" });
    await settleUnrecoverableExecutions(db);
    const decisionId = randomUUID();
    await db.update(issues).set({ status: "blocked", statusVersion: 9, lastStatusDecisionId: decisionId, blockedTransitionAt: new Date() })
      .where(eq(issues.id, f.issueId));
    const [late] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", returnOwnerAgentId: agentId, cause: "native_session_retry_exhausted", fingerprint: `native-retry:${f.runId}`,
      nextAction: "Automatic recovery stopped.", maxAttempts: 3,
      evidence: { runId: f.runId, coordinatorAttempt: 3, recoveryDisposition: "native_session_retry_exhausted", nativeFailureBlock: { runId: f.runId, statusVersion: 4 } } }).returning();
    await settleUnrecoverableExecutions(db);
    expect(await issue(f.issueId)).toMatchObject({ status: "blocked", lastStatusDecisionId: decisionId });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, late!.id)))[0]).toMatchObject({ status: "resolved", ownerType: "system" });
  }, 60_000);

  it("continues a task whose automatic retry lost the person's continuation authorization", async () => {
    expect(PERSON_OWNED_FAILURE_CODES).not.toContain("continuation_user_authorization_missing");
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "continuation_user_authorization_missing",
      error: "The automatic retry could not revalidate the original user continuation" });
    await settleUnrecoverableExecutions(db);
    const next = await expectOneFreshSuccessor(f);
    expect(next.responsibleUserId).toBe(userId);
  }, 60_000);

  it("falls back for a failure code nobody has classified yet", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_new_failure_added_next_week" });
    await settleUnrecoverableExecutions(db);
    await expectOneFreshSuccessor(f);
  }, 60_000);

  /** Reproduce a delivered fallback failing at preparation, without starting a provider. */
  async function refuseContinuation(run: typeof heartbeatRuns.$inferSelect, error: string) {
    const finishedAt = new Date();
    const [task] = await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null,
      blockedTransitionAt: finishedAt }).where(eq(issues.id, run.issueId!)).returning();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: task!.id, nativePhase: "terminal_failure",
      errorCode: "native_continuation_requires_reconciliation", error, finishedAt }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId, issueId: task!.id,
      phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: task!.id, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-continuation:${run.id}`, nextAction: "The previous conversation cannot continue.",
      evidence: { runId: run.id, nativeFailureBlock: { runId: run.id, statusVersion: Number(task!.statusVersion) } } });
  }

  // Keep: failure path reproduced by the K=2 policy; no provider is needed to
  // prove the recovery sweep and durable wake admission boundary.
  it("step 1 RED: a third system-owned failure starts a third continuation without person input", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    await settleUnrecoverableExecutions(db);
    let source = await expectOneFreshSuccessor(f);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await refuseContinuation(source, "temporary_runner_transport_unavailable");
      await finishFailedWake(source);
      const result = await ensureFreshContinuation(db, { companyId, runId: source.id, trigger: "recovery_refused" });
      expect(result, `system-owned continuation ${attempt}`).toMatchObject({ kind: "continued" });
      await deliver();
      const next = await successors(source.id);
      expect(next).toHaveLength(1);
      source = next[0]!;
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, source.wakeupRequestId!));
      expect(wake).toMatchObject({ requestedByActorType: "system", reason: "issue_recovery_action_restored" });
    }
  }, 60_000);

  it.each(["direct", "watchdog"] as const)("step 1 loop: %s refusal backs off at upstream's rolling-hour brake", async path => {
    const failure = path === "watchdog" ? "native_controller_recovery_missing_evidence:snapshot_binding"
      : "temporary_runner_transport_unavailable";
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation", error: failure });
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId,
      body: "Please finish the requested work.", createdAt: new Date(Date.now() - 12 * 60_000) }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message.id } })
      .where(eq(heartbeatRuns.id, f.runId));
    await occupySlot();
    let sourceId: string = f.runId;
    for (let attempt = 1; attempt <= FRESH_CONTINUATIONS_PER_HOUR; attempt++) {
      if (path === "watchdog") {
        // Production disposition consumes a fresh active_run_watchdog action
        // on every failed preparation; it must not get a new allowance per hold.
        await settleUnrecoverableExecutions(db);
      } else {
        expect(await ensureFreshContinuation(db, { companyId, runId: sourceId, trigger: "recovery_refused" }),
          `deterministic failure ${attempt}`).toMatchObject({ kind: "continued" });
      }
      await deliver();
      const next = await successors(sourceId);
      expect(next).toHaveLength(1);
      sourceId = next[0]!.id;
      await refuseContinuation(next[0]!, failure);
      await finishFailedWake(next[0]!);
    }
    const now = new Date();
    expect(await ensureFreshContinuation(db, { companyId, runId: sourceId, trigger: "recovery_refused", now }))
      .toMatchObject({ kind: "backoff", retryAt: expect.any(Date) });
    await settleUnrecoverableExecutions(db);
    await continueHeldExecutions(db);
    await deliver();
    expect(await successors(sourceId)).toHaveLength(0);
    const records = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    expect(records).toHaveLength(FRESH_CONTINUATIONS_PER_HOUR);
    expect(records.every(record => !/Send a new message|tried to continue this task twice/.test(record.nextAction))).toBe(true);
    // Step 5 deletes the temporary message-owner wait. The upstream scheduled
    // retry remains the only instruction, including after controller restart.
    const scheduled = await taskInterruptionPresentation(db, await issue(f.issueId));
    expect(scheduled).toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: expect.any(String) });
    const restarted = createDb(temporary!.connectionString);
    try {
      for (let pass = 0; pass < 3; pass++) {
        await settleUnrecoverableExecutions(restarted); await continueHeldExecutions(restarted);
        await deliverReconciledExecutions(restarted, heartbeatService(restarted).wakeup);
        expect(await successors(sourceId)).toHaveLength(0);
      }
    } finally { await restarted.$client.end(); }
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
    expect(notes).toHaveLength(0); // At most one: the sweep adds none to the card/transcript's one instruction.
    if (process.env.PAPERCLIP_STEP1B_OBSERVATIONS) await writeFile(
      join(process.env.PAPERCLIP_STEP1B_OBSERVATIONS, `loop-${path}.json`),
      JSON.stringify({ path, failure, rootRunId: f.runId, stoppedSourceRunId: sourceId, continuations: records.length,
        scheduled, sweepNotes: notes.length, forbiddenSuccessors: (await successors(sourceId)).length }, null, 2) + "\n");
  }, 60_000);

  // follow-Paperclip Cut B R1/R5: preserve the unproven retained source, not the removed stop-before-fresh upgrade.
  async function retainClass2Source(f: { runId: string; issueId: string }) {
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `class2-${randomUUID()}`, status: "retained", metadata: { pluginId: "fixture-boat" } }).returning();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(await readFreshThreadStopProof(db, source, f.issueId)).toMatchObject({ gone: false });
    expect(await successors(f.runId)).toHaveLength(0);
    return lease;
  }

  it.each([
    "native_controller_recovery_unsupported:metadata_format",
    "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; retirement_refused=journal_terminal_unsettled",
  ])("continues a terminal continuation refusal again: %s", async error => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    await settleUnrecoverableExecutions(db);
    const next = await expectOneFreshSuccessor(f);
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, next.id));
    await refuseContinuation(next, error);
    const d10 = error === "native_controller_recovery_unsupported:metadata_format";
    const lease = d10 ? await retainClass2Source({ runId: next.id, issueId: f.issueId }) : null;
    if (!d10) await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "system",
      body: NATIVE_CONTINUATION_REFUSED_ACTION });
    const before = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    // Exercise the actual sweep and delivery, repeatedly, not a classifier mock.
    for (let pass = 0; pass < 3; pass++) {
      await settleUnrecoverableExecutions(db); await continueHeldExecutions(db); await deliver();
    }
    // follow-Paperclip Cut B R1/R4: neither typed refusal nor historical prose permanently vetoes the second bounded attempt.
    const following = await successors(next.id);
    expect(following).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(before.length);
    if (d10) {
      await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.issueId })
        .where(eq(heartbeatRuns.id, following[0].id));
      const input = { companyId, agentId, issueId: f.issueId, runId: following[0].id };
      const selected = await selectFreshContinuationThread(db, input);
      expect(selected).toEqual(expect.any(String));
      expect(await selectFreshContinuationThread(db, input)).toBe(selected);
    }
    if (lease) expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
    const notes = currentNotices(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(d10 ? FRESH_THREAD_STARTED_NOTE : NATIVE_CONTINUATION_REFUSED_ACTION);
  }, 60_000);

  async function finishFailedWake(run: typeof heartbeatRuns.$inferSelect) {
    if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, run.wakeupRequestId));
  }

  it("delivers an older pending terminal fallback once without upgrading physical-stop proof", async () => {
    const f = await unfinishedThread({ runtime: "native", errorCode: "native_session_interrupted" });
    await settleUnrecoverableExecutions(db);
    // follow-Paperclip Cut B R1/R2/R4: old pending settlements are valid without the removed typed stop-proof upgrade.
    await db.update(heartbeatRuns).set({ error: "native_controller_recovery_unsupported:metadata_format" })
      .where(eq(heartbeatRuns.id, f.runId));
    const lease = await retainClass2Source(f);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "already_continued" });
    await selectFreshSuccessor(f);
    expect(await successors(f.runId)).toHaveLength(1);
    const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(record.evidence).toMatchObject({ continuationDelivery: "delivered",
      freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: f.runId } });
    expect(record.evidence.freshContinuation).not.toHaveProperty("previousExecutionGone");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
    const notes = currentNotices(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(FRESH_THREAD_STARTED_NOTE);
  }, 60_000);

  it("leaves a successful delivered continuation unchanged", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    await settleUnrecoverableExecutions(db);
    const next = await expectOneFreshSuccessor(f);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, next.id));
    expect(await ensureFreshContinuation(db, { companyId, runId: next.id, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "not_applicable", reason: "run_not_unfinished" });
    await settleUnrecoverableExecutions(db); await deliver();
    expect(await successors(next.id)).toHaveLength(0);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!.evidence)
      .toMatchObject({ continuationDelivery: "delivered", continuationRunId: next.id });
  }, 60_000);

  it("creates one successor when two servers call it at once", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable" });
    const results = await Promise.all([
      ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }),
      ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }),
      settleUnrecoverableExecutions(db).then(() => null),
    ]);
    expect(results.filter(result => result?.kind === "continued")).toHaveLength(1);
    expect(results.filter(result => result && result.kind !== "continued").map(result => result!.kind))
      .toEqual([expect.stringMatching(/already_continued|successor_exists/)]);
    await expectOneFreshSuccessor(f);
    // A later call, from either server or a sweep, adds nothing.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: expect.stringMatching(/already_continued|successor_exists/) });
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
  }, 60_000);

  // Upgrade safety: rows saved by the previous release (a settled-but-blocked
  // no-replay hold, its coordinator still awaiting a runner reattach) and a
  // task already Blocked continue on the first pass after deploy, without Retry.
  it("continues tasks that older releases left blocked by these codes", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", hold: "settled_blocked", coordinatorState: "awaiting_runner_reattach" });
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    await settleUnrecoverableExecutions(db);
    await expectOneFreshSuccessor(f);
  }, 60_000);

  /** A held record from an older release (settled blocked), its source run ended `ageMs` ago with `errorCode`. */
  async function heldBacklog(errorCode: string, ageMs: number) {
    const f = await unfinishedRun({ runtime: "native", errorCode, hold: "settled_blocked" });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - ageMs) }).where(eq(heartbeatRuns.id, f.runId));
    return f;
  }
  const continuedFrom = async (runId: string) => db.select().from(issueRecoveryActions)
    .where(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${runId}`);
  const evidenceOf = async (actionId: string) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))[0]!;

  it("continues only recent interruptions from the held backlog, newest first, and leaves the rest untouched (staging herd)", async () => {
    // paperclip.staging, 22:53Z: the first release with the fallback continued 176 held tasks in 30 minutes;
    // 74 had a source run that ended more than 7 days ago, many with configuration or provider failures.
    const HOUR = 60 * 60_000;
    const recentOld = await heldBacklog("native_restart_recovery_blocked", 6 * HOUR);
    const recentNew = await heldBacklog("native_continuation_requires_reconciliation", 1 * HOUR);
    const weekOld = await heldBacklog("native_restart_recovery_blocked", 3 * 24 * HOUR);
    const monthOld = await heldBacklog("native_session_interrupted", 28 * 24 * HOUR);
    const providerFailure = await heldBacklog("runner_remote_provider_artifact_incompatible", 2 * HOUR);
    const adapterFailure = await heldBacklog("adapter_failed", 2 * HOUR);
    const untouched = [weekOld, monthOld, providerFailure, adapterFailure];
    const before = await Promise.all(untouched.map(f => evidenceOf(f.actionId!)));

    expect(await continueHeldExecutions(db, new Date(), 1)).toMatchObject({ continued: 1 });
    expect(await continuedFrom(recentNew.runId)).toHaveLength(1);
    expect(await continuedFrom(recentOld.runId)).toHaveLength(0);
    for (let pass = 0; pass < 3; pass += 1) await continueHeldExecutions(db, new Date());
    expect(await continuedFrom(recentOld.runId)).toHaveLength(1);
    for (const [index, f] of untouched.entries()) {
      expect(await continuedFrom(f.runId)).toHaveLength(0);
      const after = await evidenceOf(f.actionId!);
      expect({ status: after.status, evidence: after.evidence, updatedAt: after.updatedAt })
        .toEqual({ status: before[index]!.status, evidence: before[index]!.evidence, updatedAt: before[index]!.updatedAt });
    }
  }, 120_000);

  it("paces the held backlog to ten continuations a minute per server", async () => {
    const records = [];
    for (let index = 0; index < 12; index += 1) records.push(await heldBacklog("native_restart_recovery_blocked", (index + 1) * 60_000));
    const now = new Date();
    for (let pass = 0; pass < 4; pass += 1) await continueHeldExecutions(db, now);
    const started = (await Promise.all(records.map(f => continuedFrom(f.runId)))).filter(rows => rows.length > 0).length;
    expect(started).toBe(10);
    // The next minute has room again.
    await continueHeldExecutions(db, new Date(now.getTime() + 61_000));
    expect((await Promise.all(records.map(f => continuedFrom(f.runId)))).filter(rows => rows.length > 0).length).toBe(12);
  }, 180_000);

  const sweepWake = (issueId: string) => heartbeatService(db).wakeup(agentId, { source: "automation", triggerDetail: "system",
    reason: "issue_continuation_needed", payload: { issueId }, requestedByActorType: "system",
    requestedByActorId: "idle-task-sweep", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_continuation_needed" } });
  const pendingRecord = async (issueId: string) => (await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.sourceIssueId, issueId), sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`)))[0];

  // An ordinary system wake (the idle-task sweep's) reaches the fallback. The
  // continuation is recorded pending and counts as delivered only once a run
  // for it exists.
  it("records a pending continuation for an ordinary continuation wake and delivers it once", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", hold: "settled_blocked" });
    await occupySlot();
    expect(await sweepWake(f.issueId)).toBeNull();
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "pending",
      freshContinuation: { sourceRunId: f.runId, trigger: "continuation_wake", delivery: "recorded" } });
    // A second sweep wake adds nothing.
    expect(await sweepWake(f.issueId)).toBeNull();
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
    expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("delivered");
  }, 60_000);

  it("runs a person's Retry pressed before delivery as the recorded isolated continuation, never in the shared directory", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
    await occupySlot();
    const taskRuns = async () => db.select().from(heartbeatRuns).where(and(
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
    const retry = await requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId, observedRunId: f.runId, idempotencyKey: randomUUID() })
      .catch((error: unknown) => ({ error: String(error) }));
    await deliver();
    expect(retry).toMatchObject({ accepted: true });
    const retryWake = async () => (await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, (retry as { requestId: string }).requestId)))[0];
    const runs = await taskRuns();
    expect(runs).toHaveLength(1);
    expect(await retryWake()).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
    expect(runs[0]!.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId });
    expect(await readFreshWorkspaceReadiness(db, runs[0]!)).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: f.actionId });
    const endedAt = new Date();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: endedAt })
      .where(and(eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.contextSnapshot}->>'issueId' <> ${f.issueId}`));
    await heartbeatService(db).cancelRun(runs[0]!.id);
    await heartbeatService(db).resumeQueuedRuns();
    await deliver();
    const later = (await taskRuns()).filter(run => run.id !== runs[0]!.id);
    expect(later.filter(run => run.wakeupRequestId === (retry as { requestId: string }).requestId
      || run.contextSnapshot?.wakeReason === "task_retry")).toEqual([]);
    expect(await retryWake()).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
  }, 60_000);

  it("consumes a person's Retry exactly once when the server stops right after admitting the isolated continuation", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
    await occupySlot();
    const retry = await requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId, observedRunId: f.runId, idempotencyKey: randomUUID() });
    expect(retry).toMatchObject({ accepted: true });
    const retryWake = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!)))[0];
    const taskRuns = async () => db.select().from(heartbeatRuns).where(and(
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
    const admitted = await heartbeatService(db).wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_recovery_action_restored", idempotencyKey: `execution-reconciliation:${f.actionId}`,
      payload: { issueId: f.issueId, recoveryActionId: f.actionId }, requestedByActorType: "system", requestedByActorId: "execution-recovery",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, recoveryActionId: f.actionId, previousRunId: f.runId, retryOfRunId: f.runId,
        forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled",
        freshContinuationIsolation: f.actionId } });
    expect(admitted).toBeTruthy();
    expect(await retryWake()).toMatchObject({ status: "coalesced", runId: admitted!.id });
    await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", runId: null, finishedAt: null })
      .where(eq(agentWakeupRequests.id, retry.requestId!));
    await deliver();
    expect((await taskRuns()).map(run => run.id)).toEqual([admitted!.id]);
    expect(await retryWake()).toMatchObject({ status: "coalesced", runId: admitted!.id });
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: admitted!.id });
  }, 60_000);

  it("never folds a Retry for the admitted continuation's own failure into that ended continuation", async () => {
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user",
      status: "active", membershipRole: "member" });
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
    const admitted = await heartbeatService(db).wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_recovery_action_restored", idempotencyKey: `execution-reconciliation:${f.actionId}`,
      payload: { issueId: f.issueId, recoveryActionId: f.actionId }, requestedByActorType: "system", requestedByActorId: "execution-recovery",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, recoveryActionId: f.actionId, previousRunId: f.runId, retryOfRunId: f.runId,
        forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled",
        freshContinuationIsolation: f.actionId } });
    await heartbeatService(db).cancelRun(admitted!.id);
    const retry = await requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId, observedRunId: admitted!.id, idempotencyKey: randomUUID() });
    expect(retry).toMatchObject({ accepted: true });
    await deliver();
    await heartbeatService(db).resumeQueuedRuns();
    await vi.waitFor(async () => {
      const [retryWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!));
      expect(retryWake!.runId, JSON.stringify(retryWake)).toBeTruthy();
      expect(retryWake!.runId).not.toBe(admitted!.id);
    }, { timeout: 20_000, interval: 200 });
  }, 60_000);

  it("re-drives an isolated continuation pending past the bound itself; a repair wake never replaces it", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
    await occupySlot();
    const taskRuns = async () => db.select().from(heartbeatRuns).where(and(
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
    expect(await sweepWake(f.issueId)).toBeNull();
    expect(await taskRuns()).toHaveLength(0);
    const recordedAt = new Date(Date.now() - PENDING_CONTINUATION_BOUND_MS - 60_000).toISOString();
    await db.update(issueRecoveryActions).set({ resolvedAt: new Date(recordedAt), evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuation,recordedAt}', to_jsonb(${recordedAt}::text))` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await sweepWake(f.issueId)).toBeNull();
    expect(await taskRuns()).toHaveLength(0);
    await deliver();
    const runs = await taskRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId, forceFreshSession: true });
    expect(await readFreshWorkspaceReadiness(db, runs[0]!)).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: f.actionId });
    const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(record!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: runs[0]!.id });
    await sweepWake(f.issueId);
    await deliver();
    expect(await taskRuns()).toHaveLength(1);
  }, 60_000);

  // A gate after the hook must never consume the recovery: it stays pending
  // and is delivered once the gate clears.
  it("keeps the continuation pending while the agent's daily run limit declines it, then delivers it", async () => {
    // The daily limit counts runs started in the current UTC day, and it reads
    // the clock on every check. Freeze Date (timers stay real) so every check in
    // this test sees the same day, even when UTC midnight passes mid-test.
    const now = new Date();
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted", hold: "settled_blocked" });
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 1 } } }).where(eq(agents.id, agentId));
      // Pin the runs to that day so the result does not depend on the hour:
      // the source run started yesterday (as it does just after 00:00 UTC), and
      // another run started today used the single run.
      const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      await db.update(heartbeatRuns).set({ startedAt: new Date(todayStart - 60_000), createdAt: new Date(todayStart - 120_000) })
        .where(eq(heartbeatRuns.id, f.runId));
      const [other] = await db.insert(issues).values({ companyId, title: "Used today's run", status: "done", assigneeAgentId: agentId }).returning();
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "succeeded",
        startedAt: now, finishedAt: now, contextSnapshot: { issueId: other!.id } });
      expect(await sweepWake(f.issueId)).toBeNull();
      await deliver();
      expect(await successors(f.runId)).toHaveLength(0);
      expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("pending");
      // The limit clears: the next pass delivers it.
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
      await occupySlot();
      await deliver();
      expect(await successors(f.runId)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    }
  }, 60_000);

  it("leaves a paused agent's task waiting with that reason, not idle and not consumed", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted", hold: "settled_blocked" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    try {
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "continuation_wake" }))
        .toEqual({ kind: "person_owned", reason: "agent_not_available" });
      expect(await pendingRecord(f.issueId)).toBeUndefined();
      expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    } finally {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    }
  }, 60_000);

  // The chaos repro: the agent's only slot is held. The delivered continuation
  // waits queued (never lost) and starts as soon as the slot frees.
  it("leaves the delivered continuation queued while the agent's slot is full and starts it when the slot frees", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [other] = await db.insert(issues).values({ companyId, title: "Holds the slot", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [holder] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running",
      contextSnapshot: { issueId: other!.id } }).returning();
    await deliver();
    const [next] = await successors(f.runId);
    expect(next).toMatchObject({ status: "queued" });
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: next!.id });
    // The slot frees: the queued continuation is dispatched.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holder!.id));
    await heartbeatService(db).resumeQueuedRuns();
    await vi.waitFor(async () => {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id));
      expect(current!.status).not.toBe("queued");
    }, { timeout: 20_000, interval: 100 });
  }, 60_000);

  // The Retry banner never shows while Paperclip is continuing the task itself.
  it("presents a task whose continuation is recorded or scheduled as continuing, with no Retry", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const presentation = async () => {
      const task = await issue(f.issueId);
      return taskInterruptionPresentation(db, { id: task.id, companyId, status: task.status,
        assigneeAgentId: task.assigneeAgentId, projectId: task.projectId });
    };
    // A scheduled check (exact recovery still has its chance): a timed wait, no Retry.
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! },
      { kind: "exact_recovery_pending", reason: "native_finalizer_active", retryAt: new Date(Date.now() + 60_000) });
    expect(await presentation()).toMatchObject({ state: "retry_scheduled", canRetry: false });
    // Recorded, not yet started: continuing, no Retry.
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} - 'freshContinuationCheck'` })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    expect(await presentation()).toMatchObject({ state: "working", canRetry: false });
  }, 60_000);

  it("never starts a second run when a person's Retry already continued the task", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    // A person's Retry started a run before the continuation was delivered.
    const [retry] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      status: "queued", contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry" } }).returning();
    await deliver();
    expect(await successors(f.runId)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId))).toHaveLength(2);
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: retry!.id });
  }, 60_000);

  /** The continuation's own wake, exactly as the delivery worker sends it, without its pre-check. */
  async function deliveryWake(f: { issueId: string; runId: string }) {
    const record = (await pendingRecord(f.issueId))!;
    return heartbeatService(db).wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_recovery_action_restored", idempotencyKey: `execution-reconciliation:${record.id}`,
      payload: { issueId: f.issueId, recoveryActionId: record.id }, requestedByActorType: "system", requestedByActorId: "execution-recovery",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, recoveryActionId: record.id, previousRunId: f.runId,
        retryOfRunId: f.runId, forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" } });
  }

  it("lets a run that started and finished in the delivery window consume the continuation under the task lock", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    // Between the worker's pre-check and admission, saved input ran and finished.
    const [intervening] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented" } }).returning();
    await occupySlot();
    expect(await deliveryWake(f)).toBeNull();
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: intervening!.id });
  }, 60_000);

  it("starts no run for a task that moved to review in the delivery window", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId));
    await occupySlot();
    expect(await deliveryWake(f)).toBeNull();
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("invalidated");
  }, 60_000);

  it("settles coalesced holds with their primary, so a task back in todo is not shown as working and the sweep sees it", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    // A second no-replay hold of the same run, settled together with the first.
    const [sibling] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "blocked", ownerType: "board", cause: "native_restart_recovery_blocked",
      fingerprint: `native-restart:${f.runId}`, nextAction: "held", resolvedAt: new Date(),
      evidence: { runId: f.runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked" } } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, sibling!.id)))[0]!.evidence.continuationDelivery)
      .toBe("coalesced");
    // The task moves to review before delivery: the primary is cancelled, and so is its sibling.
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId));
    await occupySlot();
    expect(await deliveryWake(f)).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, sibling!.id)))[0]!.evidence.continuationDelivery)
      .toBe("invalidated");
    // Back to todo with nothing pending: a failed attempt with Retry, not "working".
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const task = await issue(f.issueId);
    expect(await taskInterruptionPresentation(db, { id: task.id, companyId, status: task.status,
      assigneeAgentId: task.assigneeAgentId, projectId: task.projectId })).toMatchObject({ state: "failed", canRetry: true });
    // The assigned-work sweep sees it as left with nothing pending: inside its
    // settle window after the recent change it schedules the recheck, never "ok".
    const check = await heartbeatService(db).checkAssignedWorkInvariant({ companyId, issueId: f.issueId });
    expect(["violation", "settling"]).toContain(check?.verdict.kind);
  }, 60_000);

  // The agent is told to check, redo what is missing, and ask only through the
  // normal approval step; never that someone must restore the previous attempt.
  it("guides the agent to check and redo, never to wait for an operator to recover the previous attempt", async () => {
    for (const unverified of [[], ["github.merge_pull_request"]]) {
      const note = freshContinuationNote({ runId: randomUUID(), unverified, workspace: "restored_last_save" });
      if (unverified.length) expect(note).toContain("first check whether it took effect");
      expect(note).toContain("do it again and continue the task");
      // It does not contradict "do not repeat completed actions": it scopes itself to unknown outcomes.
      expect(note).toContain("Completed actions with recorded results are still not repeated");
      expect(note).toContain("request it through the normal approval step");
      expect(note).not.toMatch(/operator|recover its result|execution state|authorize rerunning/i);
    }
    // The same holds for the continuation context the agent actually receives.
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const continuation = await buildExecutionContinuation({ db, companyId, issueId: f.issueId, agentId,
      context: { previousRunId: f.runId }, summary: null, exposeLowTrustRaw: false });
    const text = JSON.stringify(continuation);
    expect(text).toContain("was cut off before it finished");
    expect(text).not.toMatch(/operator must|recover its result|recover .*execution state|authorize rerunning/i);
  }, 60_000);

  // A task whose run completes normally gets no fallback activity at all, even
  // with an older hold on the task (a run queued across a swap that then ran).
  it("leaves a task that completes normally alone, even with an older run's hold", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation", hold: "settled_blocked" });
    const [later] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      status: "succeeded", startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" })).toEqual({ kind: "successor_exists" });
    expect(await ensureFreshContinuation(db, { companyId, runId: later!.id, trigger: "held_recovery" }))
      .toEqual({ kind: "not_applicable", reason: "run_not_unfinished" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await settleUnrecoverableExecutions(db);
    await occupySlot();
    expect(await sweepWake(f.issueId)).toBeNull();
    await deliver();
    expect(await pendingRecord(f.issueId)).toBeUndefined();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId))).toHaveLength(2);
  }, 60_000);

  it("starts no run for a task that finished while its continuation was pending", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await deliver();
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("invalidated");
  }, 60_000);

  // Crash between writes: the decision committed, the process died before any
  // run was created. Nothing is lost: the next delivery pass starts it.
  it("delivers a committed continuation after a crash before its run was created", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    expect(await successors(f.runId)).toHaveLength(0);
    // A new process: a fresh service instance and worker pass.
    await occupySlot();
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
  }, 60_000);

  // The cut-off run's agent may still be alive in its old, unreachable sandbox.
  // Once the continuation is recorded it can neither write to the task through
  // the API nor publish its workspace, and the next run restores the last save
  // into a new root on a new allocation.
  it("fences the cut-off run: its API writes are refused and its workspace epoch is abandoned", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable" });
    const workspaceId = randomUUID(), snapshotId = null, leaseId = randomUUID(), environmentId = randomUUID();
    const location = { environmentId, leaseId, providerLeaseId: "sandbox-1", remoteCwd: "/home/daytona/.paperclip-workspaces/a" };
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: f.issueId, mode: "isolated",
      strategyType: "remote", name: "Task workspace", providerType: "remote", providerRef: location.remoteCwd,
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 3, snapshotId,
        source: { kind: "empty" }, location, writerRunId: f.runId, dirty: true } } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1",
      workspaceId, leaseId, providerLeaseId: location.providerLeaseId, remoteCwd: location.remoteCwd, epoch: 3,
      state: "prepared", snapshotId } } }).where(eq(heartbeatRuns.id, f.runId));
    // Today a failed run's token still writes.
    const [before] = await loadAgentRunAuthentication(db, { runId: f.runId, companyId, agentId });
    expect(agentRunWritesRevoked(before)).toBe(false);

    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });

    // The auth middleware's own row read refuses every write of the old token.
    const [after] = await loadAgentRunAuthentication(db, { runId: f.runId, companyId, agentId });
    expect(agentRunWritesRevoked(after)).toBe(true);
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, companyId, { agentId, runId: f.runId })))
      .rejects.toMatchObject({ status: 403, details: { code: "agent_run_superseded" } });
    // The workspace writer is fenced out and the next preparation starts from the last save in a new root.
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    expect(workspace!.metadata!.remoteWorkspace).toMatchObject({ epoch: 4, writerRunId: null, dirty: false, location: null });
    expect(workspace!.providerRef).toBeNull();
    expect(workspace!.metadata!.remoteWorkspaceAbandonedEpochs).toEqual([expect.objectContaining({ epoch: 3, runId: f.runId, location })]);
    // The continuation's own token is unaffected.
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, companyId, { agentId, runId: next!.id })))
      .resolves.toBeTruthy();
  }, 60_000);

  // The staging shape: the new server cannot re-reach the old Runner, so the old
  // run's sandbox lease is still active (or its cleanup is pending) with no stop
  // receipt. The continuation must still start, not wait behind that cleanup.
  it.each(["active", "pending_cleanup"] as const)("starts the continuation while the unreachable old lease is %s", async leaseStatus => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable" });
    const [environment] = await db.insert(environments).values({ name: `sandbox-${f.runId}`, driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      environmentId: environment!.id, provider: "daytona", providerLeaseId: `sandbox-${f.runId}`, status: leaseStatus,
      leasePolicy: "retain_on_failure", metadata: { remoteCwd: "/home/daytona/work", driver: "sandbox" } });
    await settleUnrecoverableExecutions(db);
    await deliver();
    const [next] = await successors(f.runId);
    expect(next).toBeTruthy();
    // Admission claims it: it leaves the queue instead of being declined for the old run's cleanup.
    await vi.waitFor(async () => {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id));
      expect(current!.status).not.toBe("queued");
    }, { timeout: 20_000, interval: 100 });
    // The abandoned allocation stays fenced: the old run still cannot write.
    const [old] = await loadAgentRunAuthentication(db, { runId: f.runId, companyId, agentId });
    expect(agentRunWritesRevoked(old)).toBe(true);
  }, 60_000);

  // A legacy run whose local process may still be alive: the continuation must
  // never write the same directory. It gets a new isolated workspace and the
  // decision records the stop as unproven.
  it("gives the continuation a new isolated workspace while the old local writer may be alive", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    // Its controller ran on another host (the replaced server), so no probe from here can prove it gone.
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence).toMatchObject({ freshContinuation: { isolation: "fresh_isolated_workspace", stopProof: "unproven_isolated" },
      executionReconciliation: { providerStopProof: "isolated" } });
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    expect(next!.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId });
    // Workspace selection gives it a new isolated workspace, never the old directory.
    expect(await readFreshWorkspaceReadiness(db, next!)).toEqual({ mode: "fresh_isolated_workspace", retryIntentId: f.actionId,
      sourceRunId: f.runId, retainedSourceIds: [] });
  }, 60_000);

  // The recorded process identity (host, PID space, start time) of this process.
  const liveIdentity = async () => {
    const startedAt = await observedProcessStartedAt(process.pid);
    if (startedAt === null) throw new Error("This host cannot report this process's start time");
    return { processPid: process.pid, processHostHash: currentProcessSpaceHash(), processStartedAt: new Date(startedAt) };
  };

  /** Moves the recorded start of the pending wait into the past. */
  async function waitedFor(actionId: string, ms: number) {
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuationCheck,firstPendingAt}', to_jsonb(${Date.now() - ms}::bigint))` }).where(eq(issueRecoveryActions.id, actionId));
  }

  it("lets a previous process still running on this host settle first, for about ten minutes at most", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    await db.update(heartbeatRuns).set(await liveIdentity()).where(eq(heartbeatRuns.id, f.runId));
    const first = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" });
    expect(first).toMatchObject({ kind: "exact_recovery_pending", reason: "previous_process_running" });
    // Rechecks back off from one minute.
    expect((first as { retryAt: Date }).retryAt.getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, first);
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence.freshContinuationCheck).toMatchObject({ checks: 1, firstPendingAt: expect.any(Number) });
    // Past the bound it stops waiting and continues in a new isolated workspace.
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("keeps waiting up to fifteen minutes while the exact-recovery owner shows progress", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost" });
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 365 * 86_400_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    const waiting = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" });
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, waiting);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    // The owner renewed its lease since the last check: progress.
    await db.update(heartbeatRuns).set({ lastOutputAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "controller_lease_live" });
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PROGRESS_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("does not mistake a recycled PID for the old writer", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    // The PID is alive now, but it belongs to a process that started after the old one was recorded.
    await db.update(heartbeatRuns).set({ ...(await liveIdentity()), processStartedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued" });
  }, 60_000);

  /** A saved-work (workspace) recovery generation on the run's hold, as workspace recovery records it. */
  async function savedWorkRecovery(f: { runId: string; actionId: string | null }, state: "awaiting_evidence" | "running") {
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
      systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, phase: "reconcile_effects", state,
        sourceRunId: f.runId, attempts: 1, retriesUsed: 0, revision: 2, failure: null, intentId: null, deadlineAt: null,
        nextAttemptAt: null, firstFailureAt: null, freshAttemptRunId: null, providerCooldownAt: null,
        attemptId: randomUUID(), generationId: randomUUID(), preservationOperationIds: [] } } })
      .where(eq(issueRecoveryActions.id, f.actionId!));
  }

  it("bounds a saved-work recovery that is waiting with no progress, on a scheduled deadline", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "server_shutdown_interrupted", status: "interrupted" });
    await savedWorkRecovery(f, "awaiting_evidence");
    // The held-run scan selects it: exact recovery keeps its first chance.
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 0 });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence.freshContinuationCheck).toMatchObject({ kind: "exact_recovery_pending", reason: "saved_work_recovery_running" });
    // With no other event, the worker is scheduled for the next check.
    expect(await nextFreshContinuationCheckAt(db)).toBe((hold!.evidence.freshContinuationCheck as { nextCheckAt: number }).nextCheckAt);
    // No progress by the bound: the task continues fresh in a new root, and the
    // preempted recovery is no longer scheduled (its hold carries the decision),
    // so a late result cannot reach the new workspace.
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuationCheck,nextCheckAt}', to_jsonb(${Date.now() - 1_000}::bigint))` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 1 });
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(settled!.evidence).toMatchObject({ executionReconciliation: { runId: f.runId },
      freshContinuation: { isolation: "fresh_isolated_workspace" } });
  }, 60_000);

  it("lets a running saved-work recovery that keeps advancing use its own budget", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "server_shutdown_interrupted", status: "interrupted" });
    await savedWorkRecovery(f, "running");
    const first = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, first);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PROGRESS_BOUND_MS + 1_000);
    // The recovery advanced (a new attempt) since the last check: it keeps going past 15 minutes.
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(Date.now() + 1_000),
      evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{systemRecovery,attempts}', '2'::jsonb)` })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "saved_work_recovery_running" });
    // Its 30-minute budget is the cap.
    await waitedFor(f.actionId!, FRESH_CONTINUATION_SAVED_WORK_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("bounds every exact-recovery wait, here a controller lease that never lapses", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost" });
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 365 * 86_400_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    const waiting = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" });
    expect(waiting).toMatchObject({ kind: "exact_recovery_pending", reason: "controller_lease_live" });
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, waiting);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("keeps the task workspace when the old local writer is proven gone", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "writer_ended" });
  }, 60_000);

  it("settles only the reconciliation holds it owns and leaves restore holds and history alone", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    const [history] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "cancelled", outcome: "cancelled", ownerType: "board", cause: "native_restart_recovery_blocked",
      fingerprint: `history:${f.runId}`, nextAction: "Old note", resolutionNote: "kept", resolvedAt: new Date(),
      evidence: { runId: f.runId } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [untouched] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, history!.id));
    expect(untouched).toMatchObject({ status: "cancelled", nextAction: "Old note", resolutionNote: "kept", ownerType: "board" });
    expect(untouched!.evidence).toEqual({ runId: f.runId });

    // A restore hold that workspace recovery has not finished keeps the task with it.
    const g = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    const [restore] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: g.issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "blocked", ownerType: "system", cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-workspace:${g.runId}`, nextAction: "Recovering saved work", resolvedAt: new Date(),
      evidence: { runId: g.runId, workspaceRestoreFailure: "restore_unsafe_archive",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: g.runId, replay: "blocked" } } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: g.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "workspace_recovery_owns_restore" });
    const [kept] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, restore!.id));
    expect(kept!.evidence).toMatchObject({ workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" } });
    expect(kept!.evidence.executionReconciliation).toBeUndefined();
  }, 60_000);

  it("schedules no recheck for a held task nothing would act on", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted", hold: "settled_blocked" });
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
      freshContinuationCheck: { kind: "person_owned", reason: "approval_pending", checkedAt: Date.now() - 7_200_000,
        nextCheckAt: Date.now() - 3_600_000 } })}::jsonb` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await nextFreshContinuationCheckAt(db)).not.toBeNull();
    // The task was cancelled after that check: the schedule goes quiet.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    expect(await nextFreshContinuationCheckAt(db)).toBeNull();
    expect(await heldExecutionsAwaitingFreshContinuation(db, new Date(), 10)).toEqual([]);
    expect(await executionControlSchedule(db).disposition()).toBeNull();
  }, 60_000);

  it("schedules no disposition scan for a held record the backlog pass leaves alone, and still does for an eligible one", async () => {
    const overdueCheck = (actionId: string) => db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
      freshContinuationCheck: { kind: "backoff", checkedAt: Date.now() - 7_200_000, nextCheckAt: Date.now() - 3_600_000 } })}::jsonb` })
      .where(eq(issueRecoveryActions.id, actionId));
    const old = await heldBacklog("native_restart_recovery_blocked", 3 * 24 * 60 * 60_000);
    await overdueCheck(old.actionId!);
    expect(await nextFreshContinuationCheckAt(db)).toBeNull();
    expect(await executionControlSchedule(db).disposition()).toBeNull();
    const recent = await heldBacklog("native_restart_recovery_blocked", 60 * 60_000);
    await overdueCheck(recent.actionId!);
    expect(await nextFreshContinuationCheckAt(db)).not.toBeNull();
  }, 60_000);

  it("tells the agent the previous attempt was cut off and which actions are unverified", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    await db.insert(toolInvocations).values({ companyId, agentId, issueId: f.issueId, runId: f.runId, toolName: "github.create_pull_request",
      riskLevel: "write", status: "executing", startedAt: new Date() } as typeof toolInvocations.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const decision = hold!.evidence.executionReconciliation as Record<string, string>;
    expect(decision.outcomeEvidence).toContain(`run ${f.runId}) was cut off`);
    expect(decision.outcomeEvidence).toContain("github.create_pull_request");
    expect(decision.outcomeEvidence).not.toMatch(adminText);
  }, 60_000);

  it("names the subtasks, comments and documents the cut-off run already created, so the fresh run does not repeat them", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    for (const title of ["SM sub 1 b3d70e77s1", "SM sub 2 b3d70e77s2"])
      await db.insert(issues).values({ companyId, title, status: "todo", assigneeAgentId: agentId, parentId: f.issueId,
        originRunId: f.runId } as typeof issues.$inferInsert);
    await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorAgentId: agentId, createdByRunId: f.runId,
      body: "DONE-0d981334" } as typeof issueComments.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const decision = hold!.evidence.executionReconciliation as Record<string, string>;
    expect(decision.outcomeEvidence).toContain('"SM sub 1 b3d70e77s1"');
    expect(decision.outcomeEvidence).toContain('"SM sub 2 b3d70e77s2"');
    expect(decision.outcomeEvidence).toContain('"DONE-0d981334"');
    expect(decision.outcomeEvidence).toContain("Do not create or post them again");
    expect(hold!.evidence.freshContinuation).toMatchObject({ createdObjects: { subtasks: expect.arrayContaining([expect.stringContaining("SM sub 1")]) } });
  }, 60_000);

  it("names the follow-up the cut-off run had read and its own final comment, so the agent answers once (t003)", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const [followUp] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "board-user", body: "Additional requirement: include the line FOLLOWUP-0d981334" } as typeof issueComments.$inferInsert).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1, eventType: "task_history.read",
      stream: "system", level: "info", payload: { comments: { [followUp!.id]: followUp!.updatedAt.toISOString() } },
    } as typeof heartbeatRunEvents.$inferInsert);
    await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorAgentId: agentId, createdByRunId: f.runId,
      body: "DONE-0d981334" } as typeof issueComments.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const note = (hold!.evidence.executionReconciliation as Record<string, string>).outcomeEvidence;
    expect(note).toContain("had already read these messages");
    expect(note).toContain("FOLLOWUP-0d981334");
    expect(note).toContain('posted comments "DONE-0d981334"');
    expect(note.indexOf("had already read")).toBeLessThan(note.indexOf("DONE-0d981334"));
  }, 60_000);

  it("does not list a follow-up edited after the cut-off run read it as already read; it is marked as changed", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const [followUp] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "board-user", body: "Additional requirement: include the line FOLLOWUP-OLD" } as typeof issueComments.$inferInsert).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1, eventType: "task_history.read",
      stream: "system", level: "info", payload: { comments: { [followUp!.id]: followUp!.updatedAt.toISOString() } },
    } as typeof heartbeatRunEvents.$inferInsert);
    await db.update(issueComments).set({ body: "Additional requirement: include the line FOLLOWUP-NEW",
      updatedAt: new Date(followUp!.updatedAt.getTime() + 60_000) }).where(eq(issueComments.id, followUp!.id));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const note = (hold!.evidence.executionReconciliation as Record<string, string>).outcomeEvidence;
    expect(note).not.toContain("had already read");
    expect(note).toContain("edited these messages after that run read them");
    expect(note).toContain("FOLLOWUP-NEW");
  }, 60_000);

  it.each([true, false])("relies on saved input only while it still holds an undelivered message (already taken by the cut-off run: %s)", async taken => {
    // R2 cell t003: the cut-off run had taken the follow-up into its turn; the fallback chose saved_input,
    // promotion settled the message as delivered, and no run followed.
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "Additional requirement: include FOLLOWUP-1" } as typeof issueComments.$inferInsert).returning();
    if (taken) await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeCommentIds: [comment!.id] } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId: f.issueId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [comment!.id] } },
    } as typeof agentWakeupRequests.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", delivery: taken ? "recorded" : "saved_input" });
  }, 60_000);

  it.each(["native", "legacy"] as const)("starts a run for the person's message once the task continues from saved work (%s)", async runtime => {
    const f = await unfinishedRun({ runtime, errorCode: runtime === "native" ? "native_provider_terminal_failed" : "process_lost" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "try again" } as typeof issueComments.$inferInsert).returning();
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment!.id, mutation: "comment" },
      requestedByActorType: "user", requestedByActorId: userId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment!.id, wakeCommentId: comment!.id,
        source: "issue.comment", wakeReason: "issue_commented" } });
    const wakes = () => db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`);
    expect((await wakes()).map(w => w.status)).toEqual(["deferred_issue_execution"]);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", delivery: "saved_input" });
    await occupySlot();
    await deliver();
    await heartbeat.resumeQueuedRuns();
    const runs = await db.select().from(heartbeatRuns).where(and(
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
    const saved = await wakes();
    expect(runs, JSON.stringify({ issue: await issue(f.issueId),
      wakes: saved.map(w => ({ status: w.status, error: w.error, runId: w.runId, payload: w.payload })) })).toHaveLength(1);
    expect(runs[0]!.contextSnapshot?.wakeCommentIds).toContain(comment!.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.runId).toBe(runs[0]!.id);
  }, 60_000);

  it.each([
    { title: "a pending approval", setup: "approval" as const, errorCode: "native_continuation_requires_reconciliation" },
    { title: "a credential the person has not shared", setup: "none" as const, errorCode: "configuration_incomplete" },
    { title: "a budget stop", setup: "none" as const, errorCode: "budget_blocked" },
  ])("leaves a task waiting on $title for the person", async ({ setup, errorCode }) => {
    expect(PERSON_OWNED_FAILURE_CODES).toContain("configuration_incomplete");
    const f = await unfinishedRun({ runtime: "native", errorCode });
    if (setup === "approval") {
      const [approval] = await db.insert(approvals).values({ companyId, type: "approve_ceo_strategy", status: "pending",
        payload: {} } as typeof approvals.$inferInsert).returning();
      await db.insert(issueApprovals).values({ companyId, issueId: f.issueId, approvalId: approval!.id } as typeof issueApprovals.$inferInsert);
    }
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "person_owned" });
    await settleUnrecoverableExecutions(db);
    expect(await issue(f.issueId)).toMatchObject({ status: "blocked" });
    await deliver();
    expect(await successors(f.runId)).toHaveLength(0);
  }, 60_000);

  it("bounds continuations with the server-restart lane's hourly cap", () => {
    expect(FRESH_CONTINUATIONS_PER_HOUR).toBe(SERVER_RESTART_RETRY_MAX_ATTEMPTS);
    expect(FRESH_CONTINUATION_WINDOW_MS).toBe(SERVER_RESTART_RETRY_WINDOW_MS);
  });

  // Governance gates are never retired or bypassed by the fallback.
  it.each(["question_pending", "user_owned_hold", "operator_continuation_recorded", "owner_gone_attestation"] as const)(
    "leaves a task behind a real governance gate (%s) for the person", async gate => {
      const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation" });
      if (gate === "question_pending") await db.insert(issueThreadInteractions).values({ companyId, issueId: f.issueId,
        kind: "ask_user_questions", status: "pending", payload: { questions: [] } } as unknown as typeof issueThreadInteractions.$inferInsert);
      if (gate === "user_owned_hold") await db.update(issueRecoveryActions).set({ ownerType: "user", ownerUserId: userId })
        .where(eq(issueRecoveryActions.id, f.actionId!));
      if (gate === "operator_continuation_recorded" || gate === "owner_gone_attestation") {
        const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
        await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
          ...(gate === "owner_gone_attestation" ? { ownerGoneAttestation: { actorId: userId } } : { explicitUserContinuation: { actorId: userId } }) } })
          .where(eq(issueRecoveryActions.id, f.actionId!));
      }
      const before = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!;
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
        .toMatchObject({ kind: "person_owned" });
      const after = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!;
      expect(after.evidence).toEqual(before.evidence);
      expect(after.status).toBe(before.status);
      await deliver();
      expect(await successors(f.runId)).toHaveLength(0);
    }, 60_000);

  // Interruption with an unknown outcome is not a governance gate: the task
  // continues, but as a fresh run, never a replay, and with an audit trail.
  it("continues an interrupted governed action as a fresh run, never a replay, and keeps the audit trail", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", hold: "settled_blocked" });
    const [inFlight] = await db.insert(toolInvocations).values({ companyId, agentId, issueId: f.issueId, runId: f.runId,
      toolName: "github.merge_pull_request", riskLevel: "write", status: "executing", startedAt: new Date() } as typeof toolInvocations.$inferInsert)
      .returning();
    const original = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!.evidence.automaticRecovery;
    await settleUnrecoverableExecutions(db);
    const next = await expectOneFreshSuccessor(f);
    // A fresh session: the interrupted turn is not re-sent.
    expect(next.contextSnapshot).toMatchObject({ forceFreshSession: true });
    expect(next.sessionIdBefore).toBeNull();
    // The cut-off tool call is not re-executed: it stays as recorded and no new invocation exists.
    const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.issueId, f.issueId));
    expect(invocations).toEqual([expect.objectContaining({ id: inFlight!.id, runId: f.runId, status: "executing" })]);
    // The earlier no-replay decision stays as history beside the attributed fallback decision.
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence.automaticRecoveryHistory).toEqual(original);
    expect(hold!.evidence.freshContinuationSettlement).toMatchObject({ actorType: "system", actorId: "fresh-continuation",
      decision: "continue_in_fresh_run", replay: "none", reason: "exact_resumption_unavailable",
      unverifiedActions: ["github.merge_pull_request"], recordedAt: expect.any(String) });
    expect((hold!.evidence.executionReconciliation as Record<string, string>).outcomeEvidence).toContain("github.merge_pull_request");
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, "issue.continued_from_saved_work")))).toHaveLength(1);
  }, 60_000);

  // The isolation decision is a property of the task's next run, whatever path starts it.
  it("moves the task off the old writer's workspace and runs the isolated continuation before saved input", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: f.issueId, mode: "isolated",
      strategyType: "git_worktree", name: "Task workspace", cwd: "/tmp/old-writer" }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id, workspaceBindingRevision: 2 }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000),
      contextSnapshot: { issueId: f.issueId, executionWorkspaceId: workspace!.id } }).where(eq(heartbeatRuns.id, f.runId));
    // A person's saved message is waiting. It carries no isolation marker, so it cannot prepare the
    // new workspace (a projectless task would be refused at admission once the binding is cleared):
    // the isolated continuation runs first and the saved message follows it.
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: f.issueId } });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
    // No delivery path can reach the old directory: the task is no longer bound to it.
    expect(await issue(f.issueId)).toMatchObject({ executionWorkspaceId: null, workspaceBindingRevision: 3 });
    const [kept] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id));
    expect(kept!.cwd).toBe("/tmp/old-writer");
  }, 60_000);

  it("records its own isolated continuation when saved input could not avoid a shared directory", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost" });
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: f.issueId } });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
  }, 60_000);

  it("backs off instead of blocking once a task used its hourly continuations", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    for (let index = 0; index < FRESH_CONTINUATIONS_PER_HOUR; index++) {
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved",
        outcome: "restored", ownerType: "system", cause: "fresh_continuation", fingerprint: `fresh-continuation:${randomUUID()}`,
        nextAction: "continued", evidence: { runId: randomUUID(), continuationDelivery: "delivered",
          freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: randomUUID(),
            recordedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString() } } });
    }
    await settleUnrecoverableExecutions(db);
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    // Not blocked for a person: the hold stays with the system and is checked again when the window frees a slot.
    expect(hold).toMatchObject({ status: "active" });
    expect(hold!.evidence.freshContinuationCheck).toMatchObject({ kind: "backoff", nextCheckAt: expect.any(Number) });
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 0 });
    // With no other event, the disposition worker is scheduled for exactly the
    // moment the window has room again.
    const retryAt = (hold!.evidence.freshContinuationCheck as { nextCheckAt: number }).nextCheckAt;
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(await nextFreshContinuationCheckAt(db)).toBe(retryAt);
    expect(await executionControlSchedule(db).disposition()).toBe(retryAt);
    // The hour passes (the window's records age out and the check falls due);
    // the scheduled pass alone continues the task.
    await db.execute(sql`update issue_recovery_actions set evidence = jsonb_set(evidence, '{freshContinuation,recordedAt}',
      to_jsonb((now() - interval '2 hours')::text)) where evidence ? 'freshContinuation'`);
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuationCheck,nextCheckAt}', to_jsonb(${Date.now() - 1_000}::bigint))` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await executionControlSchedule(db).disposition()).toBeLessThanOrEqual(Date.now() + 60_000);
    await settleUnrecoverableExecutions(db);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "already_continued" });
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(0);
  }, 60_000);

  async function heldByOlderRun(options: { endedAgoMs?: number; recovery?: "exhausted" | "running"; humanGate?: boolean } = {}) {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    const endedAt = new Date(Date.now() - (options.endedAgoMs ?? 60_000));
    await db.update(heartbeatRuns).set({ finishedAt: endedAt, startedAt: new Date(endedAt.getTime() - 600_000),
      createdAt: new Date(endedAt.getTime() - 660_000), processPid: 4242, processHostHash: "replaced-server",
      processStartedAt: new Date(endedAt.getTime() - 600_000) }).where(eq(heartbeatRuns.id, f.runId));
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: f.issueId, mode: "isolated",
      strategyType: "git_worktree", name: "Task workspace", providerType: "local_fs", cwd: "/workspaces/old-task-dir" }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, f.issueId));
    const recovery = { ...createSystemRecovery(f.runId), state: options.recovery ?? "exhausted", attempts: 3,
      failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "export" } };
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    await db.update(issueRecoveryActions).set({ ownerUserId: options.humanGate ? userId : null,
      createdAt: endedAt, updatedAt: endedAt,
      evidence: { ...hold!.evidence, workspaceRestoreFailure: "restore_unsafe_archive", systemRecovery: recovery } })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    return { ...f, workspaceId: workspace!.id, endedAt };
  }

  async function refusedAtDispatch(f: { issueId: string }, options: { createdAt?: Date; wakeReason?: string } = {}) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", issueId: f.issueId,
      runtimeMode: "legacy", status: "queued", createdAt: options.createdAt ?? new Date(),
      contextSnapshot: { issueId: f.issueId, wakeReason: options.wakeReason ?? "issue_continuation_needed" } }).returning();
    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId, runId: run!.id,
      expectedStatus: "queued", now: options.createdAt ?? new Date() });
    return { run: run!, outcome };
  }

  const holdRow = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const makeDue = (id: string) => db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
    '{freshContinuationCheck,nextCheckAt}', to_jsonb(${Date.now() - 1_000}::bigint))` }).where(eq(issueRecoveryActions.id, id));

  it("continues a task held by an older run's saved-work hold in a new isolated workspace, after it refused a run at dispatch", async () => {
    const f = await heldByOlderRun();
    const refused = await refusedAtDispatch(f);
    expect(refused.outcome).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    expect((await holdRow(f.actionId!)).evidence.freshContinuationCheck)
      .toMatchObject({ kind: "exact_recovery_pending", firstPendingAt: expect.any(Number) });
    expect(await heldExecutionsAwaitingFreshContinuation(db, new Date(Date.now() + 10 * 60_000), 10))
      .toEqual([expect.objectContaining({ id: f.actionId, runId: f.runId })]);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    await makeDue(f.actionId!);
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 1 });
    const settled = await holdRow(f.actionId!);
    expect(settled).toMatchObject({ status: "resolved", ownerType: "system" });
    expect(settled.evidence).toMatchObject({ workspaceRestoreFailure: "restore_unsafe_archive",
      systemRecovery: { state: "exhausted" },
      freshContinuation: { sourceRunId: f.runId, isolation: "fresh_isolated_workspace" },
      freshContinuationSettlement: { actorType: "system", actorId: "fresh-continuation", heldFiles: "kept_not_applied",
        refusedAtDispatchRunId: refused.run.id, requestedBy: "system" } });
    expect((await issue(f.issueId)).executionWorkspaceId).toBeNull();
    const [old] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(old).toMatchObject({ status: "active", cwd: "/workspaces/old-task-dir" });
    const [oldRun] = await loadAgentRunAuthentication(db, { runId: f.runId, companyId, agentId });
    expect(agentRunWritesRevoked(oldRun)).toBe(true);
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    expect(next!.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId });
    expect(await readFreshWorkspaceReadiness(db, next!)).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.runId });
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId, runId: next!.id,
      expectedStatus: "queued", now: new Date() })).not.toMatchObject({ errorCode: "execution_reconciliation_required" });
  }, 60_000);

  it("keeps the wait of a saved-work recovery that is still advancing, even behind a run it refused", async () => {
    const f = await heldByOlderRun({ recovery: "running" });
    await refusedAtDispatch(f);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PROGRESS_BOUND_MS + 1_000);
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(Date.now() + 1_000),
      evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{systemRecovery,attempts}', '4'::jsonb)` })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "saved_work_recovery_running" });
    expect((await issue(f.issueId)).executionWorkspaceId).toBe(f.workspaceId);
    await refusedAtDispatch(f, { wakeReason: "task_retry" });
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(Date.now() + 2_000),
      evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{systemRecovery,attempts}', '5'::jsonb)` })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "exact_recovery_pending" });
  }, 60_000);

  it("keeps a hold a person owns blocking, behind any number of refused runs", async () => {
    const f = await heldByOlderRun({ humanGate: true });
    await refusedAtDispatch(f, { wakeReason: "task_retry" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "person_owned" });
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    expect((await holdRow(f.actionId!)).status).toBe("active");
  }, 60_000);

  it("leaves an old hold for a person's Retry, and that Retry runs isolated (refused run)", async () => {
    const f = await heldByOlderRun({ endedAgoMs: 3 * 86_400_000 });
    await refusedAtDispatch(f, { createdAt: new Date(Date.now() - 30 * 3_600_000) });
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 0 });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "continuation_wake" }))
      .toEqual({ kind: "person_owned", reason: "retry_needed" });
    expect((await holdRow(f.actionId!)).status).toBe("active");
    const retry = await refusedAtDispatch(f, { wakeReason: "task_retry" });
    expect(retry.outcome).toMatchObject({ outcome: "cancelled" });
    expect((await holdRow(f.actionId!)).evidence).toMatchObject({
      freshContinuation: { isolation: "fresh_isolated_workspace" },
      freshContinuationSettlement: { requestedBy: "person_retry", heldFiles: "kept_not_applied" } });
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    expect(await readFreshWorkspaceReadiness(db, next!)).toMatchObject({ mode: "fresh_isolated_workspace" });
  }, 60_000);

  it("leaves an old hold for a person's Retry, and that Retry runs isolated (waiting Retry)", async () => {
    const f = await heldByOlderRun({ endedAgoMs: 3 * 86_400_000 });
    const old = await refusedAtDispatch(f, { createdAt: new Date(Date.now() - 30 * 3_600_000) });
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 0 });
    const receipt = await requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId,
      idempotencyKey: randomUUID(), observedRunId: old.run.id });
    expect(receipt).toMatchObject({ accepted: true });
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 1 });
    expect((await holdRow(f.actionId!)).evidence).toMatchObject({ freshContinuation: { isolation: "fresh_isolated_workspace" },
      freshContinuationSettlement: { requestedBy: "person_retry" } });
    await occupySlot();
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
    const [retryWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    expect(retryWake!.status).toBe("coalesced");
  }, 60_000);

  async function preparedRemoteRunStoppedBeforeDispatch(options: { endedAgoMs?: number } = {}) {
    const issueId = randomUUID(), runId = randomUUID();
    const endedAt = new Date(Date.now() - (options.endedAgoMs ?? 60_000));
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release notes", status: "in_progress", assigneeAgentId: agentId });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId, mode: "isolated",
      strategyType: "git_worktree", name: "Task workspace", cwd: "/work/remote-task" }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, issueId));
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId,
      runtimeMode: "legacy", status: "running", startedAt: new Date(endedAt.getTime() - 120_000),
      createdAt: new Date(endedAt.getTime() - 180_000), responsibleUserId: userId,
      contextSnapshot: { issueId, executionWorkspaceId: workspace!.id, wakeReason: "issue_assigned" } }).returning();
    const [environment] = await db.insert(environments).values({ name: `sandbox-${runId}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, executionWorkspaceId: workspace!.id,
      heartbeatRunId: runId, environmentId: environment!.id, status: "active", leasePolicy: "ephemeral", provider: "daytona",
      providerLeaseId: `sandbox-${runId}`, metadata: { remoteCwd: "/work/remote-task", driver: "sandbox",
        workspaceRealization: { authoritativeRoot: "/work/remote-task" } } }).returning();
    await terminalizeLegacyExecution({ db, run: run!, status: "interrupted", patch: { errorCode: "server_shutdown_interrupted",
      error: "Interrupted by graceful server shutdown (SIGTERM)", finishedAt: endedAt,
      resultJson: { workspaceRestoreFailure: "restore_failed" } } });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return { issueId, runId, actionId: hold!.id, leaseId: lease!.id, workspaceId: workspace!.id };
  }

  it("continues a recent restart-stopped run whose prepared remote workspace could not be restored, in a new isolated workspace", async () => {
    const f = await preparedRemoteRunStoppedBeforeDispatch();
    const held = await holdRow(f.actionId);
    await settleUnrecoverableExecutions(db);
    await waitedFor(f.actionId, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000).catch(() => undefined);
    if ((await holdRow(f.actionId)).evidence.freshContinuationCheck) await makeDue(f.actionId);
    await settleUnrecoverableExecutions(db);
    const settled = await holdRow(f.actionId);
    expect(settled.evidence).toMatchObject({ freshContinuation: { sourceRunId: f.runId, isolation: "fresh_isolated_workspace" },
      workspaceRestoreRecovery: { leaseIds: [f.leaseId] }, freshContinuationSettlement: { heldFiles: "kept_not_applied" } });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease!.leasePolicy).toBe("retain_on_failure");
    expect((await issue(f.issueId)).executionWorkspaceId).toBeNull();
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    expect(await readFreshWorkspaceReadiness(db, next!)).toMatchObject({ mode: "fresh_isolated_workspace", sourceRunId: f.runId });
    expect(held.nextAction).not.toMatch(/stop receipt|recover the missing files|workspaceRepairEvidence|allocation|repair|inspect|_/i);
    expect(held.nextAction).toContain("Retry");
  }, 60_000);

  it("leaves an older restart-stopped remote restore failure for a person's Retry, which then runs isolated", async () => {
    const f = await preparedRemoteRunStoppedBeforeDispatch({ endedAgoMs: 30 * 3_600_000 });
    await settleUnrecoverableExecutions(db);
    await settleUnrecoverableExecutions(db);
    const kept = await holdRow(f.actionId);
    expect(kept.evidence.freshContinuation).toBeUndefined();
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    await refusedAtDispatch(f, { wakeReason: "task_retry" });
    expect((await holdRow(f.actionId)).evidence).toMatchObject({ freshContinuation: { isolation: "fresh_isolated_workspace" },
      freshContinuationSettlement: { requestedBy: "person_retry" } });
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    expect(await readFreshWorkspaceReadiness(db, next!)).toMatchObject({ mode: "fresh_isolated_workspace" });
  }, 60_000);
  // smarty-dev#20925 (TES-468 chain b5064b28 -> 72aca045 -> f93bf1b8 -> 193fb0eb):
  // a native run that died in workspace PREPARATION never reached the controller
  // (no finalization owner row, no nativeControllerRecovery). Its follow-up that
  // tried exact controller recovery was refused with a FRESH_THREAD code. The
  // task must go straight to one fresh thread from saved history, promptly,
  // with no blank notice, no "send a new message" note and no person message.
  async function preparationDeathChain() {
    const f = await unfinishedRun({ runtime: "native", errorCode: "adapter_failed",
      error: "Could not exclude agent files from task Git staging" });
    const sessionId = randomUUID();
    await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", responsibleUserId: userId }).where(eq(issues.id, f.issueId));
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "What did we decide about the release notes?", createdAt: new Date(Date.now() - 7 * 60_000) }).returning();
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const failedAt = new Date(Date.now() - 6 * 60_000);
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId, executionStage: "preparing", nativePhase: null,
      finishedAt: failedAt, startedAt: new Date(failedAt.getTime() - 30_000), createdAt: new Date(failedAt.getTime() - 40_000),
      resultJson: { stopReason: "adapter_failed" }, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message!.id } })
      .where(eq(heartbeatRuns.id, f.runId));
    const refusedAt = new Date(Date.now() - 30_000);
    const [refused] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", issueId: f.issueId,
      nativeIssueId: f.issueId, nativeSessionId: sessionId, runtimeMode: "native", status: "failed", retryOfRunId: f.runId,
      errorCode: "native_controller_recovery_missing_evidence:retained_sandbox_binding",
      error: "native_controller_recovery_missing_evidence:retained_sandbox_binding",
      createdAt: new Date(failedAt.getTime() + 1_000), startedAt: new Date(refusedAt.getTime() - 7_000), finishedAt: refusedAt,
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_continuation_needed", retryReason: "issue_continuation_needed",
        wakeCommentId: message!.id } }).returning();
    // The DB shape of hold b7a25c82: the refused follow-up's reconciliation
    // hold, its saved-work recovery exhausted, workspace restore evidence kept.
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    await db.update(issueRecoveryActions).set({ createdAt: refusedAt, updatedAt: refusedAt,
      fingerprint: `native-continuation:${refused!.id}`,
      evidence: { ...hold!.evidence, runId: refused!.id, originalFailureCode: refused!.errorCode,
        nativeFailureBlock: { runId: refused!.id, statusVersion: 4 }, workspaceRestoreFailure: "restore_unsafe_archive",
        systemRecovery: { ...createSystemRecovery(refused!.id), state: "exhausted", attempts: 3,
          failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "export" } } } })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    return { ...f, sessionId, refusedRunId: refused!.id, messageId: message!.id };
  }

  it("#20925 a preparation death refused at exact recovery continues on a fresh thread at once, with no blank or resend note", async () => {
    const f = await preparationDeathChain();
    const personMessages = async () => db.select().from(issueComments)
      .where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "user")));
    // The held sweep's first check, about a minute after the refusal: no
    // exact-recovery wait remains for a run that never reached the controller.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.refusedRunId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    await occupySlot();
    await deliver();
    const next = await successors(f.refusedRunId);
    expect(next).toHaveLength(1);
    expect(next[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId, previousRunId: f.refusedRunId, forceFreshSession: true,
      wakeReason: "issue_recovery_action_restored" });
    // Exactly once: later checks and sweeps add nothing.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.refusedRunId, trigger: "held_recovery" }))
      .toMatchObject({ kind: expect.stringMatching(/^(already_continued|successor_exists)$/) });
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 0 });
    await deliver();
    expect(await successors(f.refusedRunId)).toHaveLength(1);
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    for (const note of notes) expect(note.body.trim()).not.toBe("");
    expect(notes.map(note => note.body).join("\n")).not.toMatch(/Send a new message to try again/);
    expect(await personMessages()).toHaveLength(1);
  }, 60_000);

  it("#20925 while the fresh continuation is due, no note tells the person to send a new message to try again", async () => {
    const f = await preparationDeathChain();
    const visible = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system")))).filter(note => !note.deletedAt);
    await continueHeldExecutions(db);
    await occupySlot();
    await deliver();
    expect(await successors(f.refusedRunId)).toHaveLength(1);
    for (const note of await visible()) {
      expect(note.body.trim()).not.toBe("");
      // RFL (e): the held-conversation note that told TES-468 to resend. The
      // ordinary "wasn't answered" note stays as judged (see result.md).
      expect(note.body).not.toMatch(/Send a new message to try again/i);
      expect(JSON.stringify(note.metadata ?? {})).not.toMatch(/Send a new message to try again/i);
    }
  }, 60_000);

  it("#20925 the held sweep picks up a preparation death refused at exact recovery and continues it within its first pass", async () => {
    const f = await preparationDeathChain();
    expect(await heldExecutionsAwaitingFreshContinuation(db, new Date(), 10))
      .toEqual([expect.objectContaining({ id: f.actionId, runId: f.refusedRunId })]);
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 1 });
    expect((await holdRow(f.actionId!)).evidence).toMatchObject({ freshContinuation: { sourceRunId: f.refusedRunId } });
  }, 60_000);

  it("#20925 a refused follow-up of a run that DID reach the controller keeps the bounded exact-recovery wait", async () => {
    const f = await preparationDeathChain();
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId, issueId: f.issueId, phase: "terminal_failure",
      recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.refusedRunId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "workspace_recovery_owns_restore" });
  }, 60_000);

  async function followUpFailedBeforeProviderWork(options: { restoreFailed?: boolean } = {}) {
    const issueId = randomUUID(), runId = randomUUID();
    const endedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Summarize the subtasks", status: "in_progress", assigneeAgentId: agentId });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: issueId, mode: "isolated",
      strategyType: "git_worktree", name: "Task workspace", cwd: "/work/remote-task" }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, issueId));
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", issueId,
      runtimeMode: "legacy", status: "running", startedAt: new Date(endedAt.getTime() - 10_000),
      createdAt: new Date(endedAt.getTime() - 60_000), responsibleUserId: userId,
      contextSnapshot: { issueId, executionWorkspaceId: workspace!.id, wakeReason: "issue_children_completed" } }).returning();
    const [environment] = await db.insert(environments).values({ name: `sandbox-${runId}`, driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId, issueId, executionWorkspaceId: workspace!.id,
      heartbeatRunId: runId, environmentId: environment!.id, status: "active", leasePolicy: "reuse_by_environment", provider: "daytona",
      providerLeaseId: `sandbox-${runId}`, metadata: { remoteCwd: "/work/remote-task", driver: "sandbox",
        workspaceRealization: { authoritativeRoot: "/work/remote-task" } } });
    await terminalizeLegacyExecution({ db, run: run!, status: "failed", patch: { errorCode: "adapter_failed",
      error: "native_instruction_materialization_handoff_unavailable", finishedAt: endedAt,
      resultJson: options.restoreFailed === false ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }
        : { workspaceRestoreFailure: "restore_failed" } } });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    return { issueId, runId, actionId: hold?.id ?? null };
  }

  async function savedWorkRecoveryState(actionId: string, runId: string, state: "running" | "complete") {
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(),
      evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ systemRecovery: { ...createSystemRecovery(runId), state } })}::jsonb` })
      .where(eq(issueRecoveryActions.id, actionId));
  }

  async function systemRetryAtClaim(f: { issueId: string; runId: string }) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", issueId: f.issueId,
      runtimeMode: "legacy", status: "queued", retryOfRunId: f.runId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_continuation_needed", retryReason: "issue_continuation_needed",
        retryOfRunId: f.runId } }).returning();
    const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId, runId: run!.id,
      expectedStatus: "queued", now: new Date() });
    return { run: run!, outcome };
  }

  async function deliveredContinuationIsClaimable(f: { issueId: string; runId: string; actionId: string | null }, refusedRunId: string) {
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
    expect((await issue(f.issueId)).status).not.toBe("blocked");
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    await occupySlot();
    await deliver();
    const next = (await successors(f.runId)).filter(run => run.id !== refusedRunId);
    expect(next).toHaveLength(1);
    expect(next[0]!.status).toBe("queued");
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId, runId: next[0]!.id,
      expectedStatus: "queued", now: new Date() })).toEqual({ outcome: "not_stale" });
    return next[0]!;
  }

  it("continues a follow-up that failed before provider work with unrestored files, when the saved work was recovered before the system retry was refused at claim", async () => {
    const f = await followUpFailedBeforeProviderWork();
    expect(f.actionId).not.toBeNull();
    await savedWorkRecoveryState(f.actionId!, f.runId, "complete");
    const refused = await systemRetryAtClaim(f);
    expect(refused.outcome).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    expect((await holdRow(f.actionId!)).evidence).toMatchObject({
      freshContinuation: { sourceRunId: f.runId }, continuationDelivery: "pending",
      freshContinuationSettlement: { refusedAtDispatchRunId: refused.run.id, requestedBy: "system" } });
    await deliveredContinuationIsClaimable(f, refused.run.id);
  }, 60_000);

  it("continues a follow-up that failed before provider work with unrestored files, when the saved work was recovered after the system retry was refused at claim", async () => {
    const f = await followUpFailedBeforeProviderWork();
    await savedWorkRecoveryState(f.actionId!, f.runId, "running");
    const refused = await systemRetryAtClaim(f);
    expect(refused.outcome).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    expect((await holdRow(f.actionId!)).evidence.freshContinuationCheck)
      .toMatchObject({ kind: "exact_recovery_pending", reason: "saved_work_recovery_running" });
    await savedWorkRecoveryState(f.actionId!, f.runId, "complete");
    await makeDue(f.actionId!);
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 1 });
    expect((await holdRow(f.actionId!)).evidence).toMatchObject({ freshContinuation: { sourceRunId: f.runId },
      freshContinuationSettlement: { refusedAtDispatchRunId: refused.run.id, requestedBy: "system" } });
    await deliveredContinuationIsClaimable(f, refused.run.id);
  }, 60_000);

  it("continues a follow-up that failed before provider work with its files in place, after its system retry was refused at claim", async () => {
    const f = await followUpFailedBeforeProviderWork({ restoreFailed: false });
    const refused = await systemRetryAtClaim(f);
    expect(refused.outcome).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    expect((await holdRow(f.actionId!)).evidence).toMatchObject({ freshContinuation: { sourceRunId: f.runId },
      freshContinuationSettlement: { refusedAtDispatchRunId: refused.run.id, requestedBy: "system" } });
    await deliveredContinuationIsClaimable(f, refused.run.id);
  }, 60_000);

  it("counts only automatic retries that started, or still may, against the task's hourly budget", async () => {
    const f = await followUpFailedBeforeProviderWork();
    for (let index = 0; index < FRESH_CONTINUATIONS_PER_HOUR; index++) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", issueId: f.issueId, runtimeMode: "legacy",
        status: "cancelled", errorCode: "execution_reconciliation_required", finishedAt: new Date(), retryOfRunId: f.runId,
        scheduledRetryReason: "transient_failure", contextSnapshot: { issueId: f.issueId, wakeReason: "transient_failure_retry" } });
    }
    expect(await sharedContinuationAttempts(db, companyId, f.issueId, new Date())).toHaveLength(0);
    expect((await taskAutomaticAttempts(db, companyId, f.issueId, new Date())).started).toHaveLength(0);
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", issueId: f.issueId, runtimeMode: "legacy",
      status: "failed", errorCode: "adapter_failed", startedAt: new Date(), finishedAt: new Date(), retryOfRunId: f.runId,
      scheduledRetryReason: "transient_failure", contextSnapshot: { issueId: f.issueId, wakeReason: "transient_failure_retry" } });
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", issueId: f.issueId, runtimeMode: "legacy",
      status: "scheduled_retry", retryOfRunId: f.runId,
      scheduledRetryReason: "transient_failure", contextSnapshot: { issueId: f.issueId, wakeReason: "transient_failure_retry" } });
    expect(await sharedContinuationAttempts(db, companyId, f.issueId, new Date())).toHaveLength(2);
    expect((await taskAutomaticAttempts(db, companyId, f.issueId, new Date())).started).toHaveLength(2);
  }, 60_000);

  it("still leaves a person's failed Retry of a follow-up for that person after its successor is refused at claim", async () => {
    const f = await followUpFailedBeforeProviderWork();
    await savedWorkRecoveryState(f.actionId!, f.runId, "complete");
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || '{"wakeReason":"task_retry"}'::jsonb` })
      .where(eq(heartbeatRuns.id, f.runId));
    const refused = await systemRetryAtClaim(f);
    expect(refused.outcome).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    expect((await holdRow(f.actionId!)).evidence.freshContinuation).toBeUndefined();
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toEqual({ kind: "person_owned", reason: "retry_needed" });
  }, 60_000);

  // D054 re-homed (never-OK, stack135 F2). The fork lineage walk
  // (fresh-continuation-chain.ts) is gone; the per-task automatic-attempt
  // ledgers that replaced it own scope and bounded input now.
  it("company/task scope and malformed or unbounded ledger input stay bounded at the automatic-attempt ledgers", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    const at = new Date();
    const recordedAt = new Date(at.getTime() - 5 * 60_000).toISOString();
    const record = (sourceIssueId: string, fingerprint: string, when: string) => ({ companyId, sourceIssueId,
      kind: "active_run_watchdog" as const, status: "resolved" as const, cause: "fresh_continuation", fingerprint, nextAction: "Continue",
      evidence: { freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: f.runId, recordedAt: when, trigger: "held_recovery" } } });
    await db.insert(issueRecoveryActions).values(record(f.issueId, `scope-${randomUUID()}`, recordedAt));
    expect(await sharedContinuationAttempts(db, companyId, f.issueId, at)).toHaveLength(1);
    expect((await taskAutomaticAttempts(db, companyId, f.issueId, at)).all).toHaveLength(1);
    // Another company or another task never sees, or is charged by, this task's records.
    expect(await sharedContinuationAttempts(db, randomUUID(), f.issueId, at)).toEqual([]);
    expect(await sharedContinuationAttempts(db, companyId, randomUUID(), at)).toEqual([]);
    expect((await taskAutomaticAttempts(db, randomUUID(), f.issueId, at)).all).toEqual([]);
    expect((await taskAutomaticAttempts(db, companyId, randomUUID(), at)).all).toEqual([]);
    const [other] = await db.insert(issues).values({ companyId, title: "Sibling", status: "todo", assigneeAgentId: agentId }).returning();
    expect(await sharedContinuationAttempts(db, companyId, other!.id, at)).toEqual([]);
    // Malformed durable input is ignored, never thrown and never counted.
    await db.insert(issueRecoveryActions).values(record(f.issueId, `bad-${randomUUID()}`, "9999-not-a-date"));
    await expect(sharedContinuationAttempts(db, companyId, f.issueId, at)).resolves.toHaveLength(1);
    await expect(taskAutomaticAttempts(db, companyId, f.issueId, at)).resolves.toMatchObject({ all: [expect.any(Date)] });
    // Unbounded history is read with a bound, so a long-lived task cannot make the brake read unbounded rows.
    await db.insert(issueRecoveryActions).values(Array.from({ length: 80 }, () => record(f.issueId, `many-${randomUUID()}`, recordedAt)));
    const many = await sharedContinuationAttempts(db, companyId, f.issueId, at);
    expect(many.length).toBeGreaterThanOrEqual(6);
    expect(many.length).toBeLessThanOrEqual(64 * 3);
  }, 60_000);

  // F4 migration: old U5 notes are history, not current instructions. Exercise
  // the upgrade executor, continuation card and the API's comment read service.
  async function migrateLegacyNotes() {
    // The fixture starts at head. Rewind ONLY the new data-migration receipt
    // so its persisted rows have the same shape as an upgraded database.
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at > 1794877714216`);
    await applyPendingMigrations(temporary!.connectionString);
  }

  it("an upgraded send-it-again note is hidden after migration but still retrievable by API", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" })
      .where(eq(issues.id, f.issueId));
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "Please finish the notes.", createdAt: new Date(Date.now() - 5 * 60_000) }).returning();
    const [otherMessage] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "An older, separate request.", createdAt: new Date(Date.now() - 50 * 60_000) }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message!.id } })
      .where(eq(heartbeatRuns.id, f.runId));
    const legacy = (messageId: string, body: string) => ({ companyId, issueId: f.issueId, authorType: "system" as const, body,
      presentation: { kind: "system_notice" as const, tone: "warning" as const, density: "compact" as const, detailsDefaultOpen: true },
      metadata: { version: 1 as const, authorizationReason: `unanswered_message:${messageId}`, recoveryResponsibility: "user" as const,
        sections: [{ rows: [{ type: "key_value" as const, label: "Next action", value: "Send a new message to try again." }] }] } });
    const before = await db.insert(issueComments).values([
      legacy(message!.id, "Your message wasn't answered. Sending it again is safe."),
      legacy(otherMessage!.id, "Your earlier message wasn't answered. Sending it again is safe."),
    ]).returning();
    await migrateLegacyNotes();
    await settleUnrecoverableExecutions(db);
    const card = await taskInterruptionPresentation(db, await issue(f.issueId));
    expect(card).toMatchObject({ responsibility: "system", canRetry: false });
    expect(["working", "retry_scheduled"]).toContain(card!.state);
    const after = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
    const current = currentNotices(after, before);
    expect(current).toEqual([]);
    expect(JSON.stringify({ card, current })).not.toMatch(/send (it|a new message).*again/i);
    const retired = after.find(note => note.id === before[0]!.id)!;
    expect(retired).toMatchObject({ body: before[0]!.body, deletedAt: null });
    expect(retired.metadata?.supersededByMigration).toEqual({ migration: "0495_retire_legacy_message_notes" });
    expect(retired.metadata?.supersededByIncident).toBeUndefined();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      membershipRole: "owner", status: "active" });
    const [{ default: express }, { default: request }, { issueRoutes }] = await Promise.all([
      import("express"), import("supertest"), import("../routes/issues.js"),
    ]);
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    const apiResponse = await request(app).get(`/api/issues/${f.issueId}/comments/${retired.id}`).expect(200);
    const apiNote = apiResponse.body;
    expect(apiNote).toMatchObject({ id: retired.id, body: before[0]!.body, deletedAt: null,
      metadata: { authorizationReason: before[0]!.metadata!.authorizationReason,
        supersededByMigration: { migration: "0495_retire_legacy_message_notes" } } });
    console.info(JSON.stringify({ legacyMigration: { hidden: before.map(note => note.id),
      apiStatus: apiResponse.status, apiNote: { id: apiNote.id, body: apiNote.body, metadata: apiNote.metadata }, card } }));
    // The journal makes a second startup a no-op.
    await applyPendingMigrations(temporary!.connectionString);
    await settleUnrecoverableExecutions(db); await deliver();
    const again = await db.select().from(issueComments).where(eq(issueComments.id, before[0]!.id));
    expect(again[0]!.metadata).toEqual(retired.metadata);
  }, 60_000);

  // Never-OK history/attribution guard: only the removed U5 system notes may
  // be marked. Authored comments and similar-looking system notices survive.
  it("the one-time migration marks only legacy U5 system notes, never people, agents or other notices", async () => {
    const [task] = await db.insert(issues).values({ companyId, title: "Answer the question", status: "in_progress",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" }).returning();
    const issueId = task!.id;
    const [answered] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "What is the status?", createdAt: new Date(Date.now() - 10 * 60_000) }).returning();
    const [later] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "And a follow-up written after the answer.", createdAt: new Date(Date.now() + 60 * 60_000) }).returning();
    const legacy = (reason: string, body: string) => ({ companyId, issueId, authorType: "system" as const, body,
      presentation: { kind: "system_notice" as const, tone: "warning" as const, density: "compact" as const, detailsDefaultOpen: true },
      metadata: { version: 1 as const, authorizationReason: reason, recoveryResponsibility: "user" as const,
        sections: [{ rows: [{ type: "key_value" as const, label: "Next action", value: "Send a new message to try again." }] }] } });
    // Cross multiple 500-row keyset batches, including both UUID extremes.
    await db.insert(issueComments).values(Array.from({ length: 1001 }, (_, index) =>
      legacy(`other_notice:${index}`, "Retained unrelated history.")));
    const before = await db.insert(issueComments).values([
      { ...legacy(`unanswered_message:${answered!.id}`, "Your message wasn't answered. Sending it again is safe."),
        id: "00000000-0000-0000-0000-000000000000" },
      legacy(`retrying_message:${answered!.id}`, "Your message is being retried."),
      { ...legacy(`unanswered_message:${later!.id}`, "Your later message wasn't answered. Sending it again is safe."),
        id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    ]).returning();
    const controls = await db.insert(issueComments).values([
      { ...legacy(`unanswered_message:${answered!.id}`, "A person's own words."), authorType: "user", authorUserId: userId },
      { ...legacy(`retrying_message:${answered!.id}`, "Here is the agent's answer."), authorType: "agent", authorAgentId: agentId },
      legacy(`unansweredXmessage:${answered!.id}`, "Not the literal U5 prefix."),
      legacy(`retryingXmessage:${answered!.id}`, "Also not the literal U5 prefix."),
      legacy(`other_notice:${answered!.id}`, "An unrelated system notice."),
    ]).returning();
    const comments = async () => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    await migrateLegacyNotes();
    const after = await comments();
    for (const old of before) {
      const retired = after.find(note => note.id === old.id)!;
      expect(retired).toMatchObject({ body: old.body, deletedAt: null });
      expect(retired.metadata).toEqual({ ...old.metadata,
        supersededByMigration: { migration: "0495_retire_legacy_message_notes" } });
    }
    const current = currentNotices(after, before);
    for (const old of before) expect(current.map(note => note.id)).not.toContain(old.id);
    expect(current).toHaveLength(1008); // 1001 other notices, 5 controls, 2 person messages.
    for (const old of controls) expect(after.find(note => note.id === old.id)).toEqual(old);
    // Re-running both startup and the idempotent SQL does not rewrite anything.
    await applyPendingMigrations(temporary!.connectionString);
    const { readFile } = await import("node:fs/promises");
    await db.$client.unsafe(await readFile(new URL("../../../packages/db/src/migrations/0495_retire_legacy_message_notes.sql", import.meta.url), "utf8"));
    const again = await comments();
    expect(again.sort((a, b) => a.id.localeCompare(b.id))).toEqual(after.sort((a, b) => a.id.localeCompare(b.id)));
    const receipt = await db.execute(sql`select count(*)::int as count from drizzle.__drizzle_migrations where created_at > 1794877714216`);
    expect(receipt[0]!.count).toBe(1);
    console.info(JSON.stringify({ migrationScope: { marked: before.length, untouched: current.length, receipts: receipt[0]!.count } }));
  }, 60_000);

  // stack135 F3 re-home of D002/D010/D013/D018/D171 (S1-pause). The U5 paused
  // note is gone; the card owns the one truthful explanation: the agent is
  // paused, a person resumes it, and nothing asks to send the message again.
  it("a paused agent's unanswered message shows one resume instruction, never send-again, across repeated passes", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "agent_paused", status: "cancelled", hold: "none" });
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId,
      body: "Please keep going.", createdAt: new Date(Date.now() - 5 * 60_000) }).returning();
    await db.update(issues).set({ status: "in_progress", blockedTransitionAt: null }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message!.id } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(agents).set({ status: "paused", pauseReason: "manual", lifecycleHolds: ["manual"] }).where(eq(agents.id, agentId));
    try {
      const cards = [];
      for (let pass = 0; pass < 3; pass++) {
        await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
        cards.push(await taskInterruptionPresentation(db, await issue(f.issueId)));
      }
      expect(cards[0]).toMatchObject({ responsibility: "user", state: "waiting_for_user", userAction: "resume", canRetry: false });
      expect(cards[2]).toEqual(cards[0]);
      const visible = JSON.stringify({ cards, notices: await db.select().from(issueComments).where(and(
        eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"))) });
      expect(visible).not.toMatch(/send (it|a new message)|again/i);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId),
        inArray(heartbeatRuns.status, ["queued", "running"])))).toHaveLength(0);
      expect((await db.select().from(issueComments).where(eq(issueComments.id, message!.id)))[0]).toMatchObject({ deletedAt: null });
    } finally {
      await db.update(agents).set({ status: "idle", pauseReason: null, lifecycleHolds: [] }).where(eq(agents.id, agentId));
    }
  }, 60_000);

  // D146 re-homed (never-OK, stack135 F2). The U5 notice that owned this is
  // deleted; the person-visible card and any recovery notice now own it.
  it.each([
    ["adapter_failed", "Something exploded at /srv/secret/path with token abc123", /exploded|secret|abc123/],
    ["brand_new_failure_code", "brand_new_failure_code: provider said something private", /brand_new|private/],
  ])("raw error text never shows on the card or a notice for a person's failed message: %s", async (errorCode, error, raw) => {
    const f = await unfinishedRun({ runtime: "native", errorCode, error, hold: "none" });
    const ended = new Date(Date.now() - 121_000);
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId,
      body: "Please answer this.", createdAt: new Date(ended.getTime() - 60_000) }).returning();
    await db.update(issues).set({ status: "in_progress", conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", blockedTransitionAt: null }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ finishedAt: ended,
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: message!.id } }).where(eq(heartbeatRuns.id, f.runId));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId: f.issueId });
    await settleUnrecoverableExecutions(db);
    const card = await taskInterruptionPresentation(db, await issue(f.issueId));
    const blocker = await getExecutionBlocker(db, companyId, f.issueId);
    const notices = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
    const visible = JSON.stringify({ card, blocker, notices: notices.map(n => ({ body: n.body, presentation: n.presentation, metadata: n.metadata })) });
    expect(card ?? blocker ?? notices[0], "the failure is shown to the person somewhere").toBeTruthy();
    expect(visible).not.toMatch(raw);
    expect(visible).not.toMatch(/\/srv\/|token/);
  }, 60_000);
  // Judge-only: same accepted native-result schema as the five-pass hardened gate.
  // Original message has a consumed durable outbox receipt; run chronology is real.
  it.each(["failed_then_unrelated_success", "array_only_then_unrelated_success", "array_only_no_timer"] as const)("named gap hardened %s has a truthful outcome by 120 seconds", async (shape) => {
    const { completionContracts, nativeRunResults } = await import("@paperclipai/db");
    const t = new Date(Date.now()-600_000), failed=shape==="failed_then_unrelated_success";
    const f=await silentConversationTurn(t);
    await db.update(issues).set({createdAt:new Date(t.getTime()-120_000),updatedAt:t}).where(eq(issues.id,f.issueId));
    await db.update(issueComments).set({clientRequestId:randomUUID(),updatedAt:new Date(t.getTime()-60_000)}).where(eq(issueComments.id,f.messageId));
    const nativeSessionId=randomUUID();
    await db.update(heartbeatRuns).set({invocationSource:"on_demand",nativeSessionId,sessionIdBefore:nativeSessionId,sessionIdAfter:nativeSessionId,
      createdAt:new Date(t.getTime()-30_000),startedAt:new Date(t.getTime()-29_000),
      finishedAt:t,updatedAt:t,status:failed?"failed":"succeeded",error:failed?"adapter failed before an answer":null,
      errorCode:failed?"adapter_failed":null,nativePhase:failed?"terminal_failure":"committed",
      contextSnapshot:failed?{issueId:f.issueId,wakeReason:"issue_commented",wakeCommentId:f.messageId}:
        {issueId:f.issueId,wakeReason:"issue_commented",wakeCommentIds:[f.messageId]}}).where(eq(heartbeatRuns.id,f.runId));
    const [wake]=await db.insert(agentWakeupRequests).values({companyId,agentId,source:"on_demand",reason:"issue_commented",
      status:failed?"failed":"completed",requestedByActorType:"user",requestedByActorId:userId,
      idempotencyKey:`conversation-comment:${f.messageId}`,payload:{issueId:f.issueId,commentId:f.messageId},
      createdAt:new Date(t.getTime()-30_000),finishedAt:t,runId:f.runId}).returning();
    await db.update(heartbeatRuns).set({wakeupRequestId:wake!.id}).where(eq(heartbeatRuns.id,f.runId));
    if (!failed) {
      const contractId=randomUUID(),resultId=randomUUID();
      await db.insert(completionContracts).values({id:contractId,companyId,issueId:f.issueId,revision:1,
        schemaVersion:"paperclip.completion-contract.v1",policyVersion:"rf3-silent-v1",risk:"standard",
        completionAuthority:"server_arbiter",incompleteCriteriaPolicy:"preserve_non_terminal",
        contractJson:{objective:"answer the accepted person message"},canonicalSha256:`contract-${contractId}`,
        createdByActorType:"system",createdByActorId:"rf3-judge",createdAt:new Date(t.getTime()-50_000)});
      await db.update(heartbeatRuns).set({completionContractId:contractId,resultJson:null}).where(eq(heartbeatRuns.id,f.runId));
      await db.insert(nativeRunResults).values({id:resultId,companyId,issueId:f.issueId,runId:f.runId,
        completionContractId:contractId,serverFingerprint:`result-${resultId}`,schemaStatus:"accepted",
        resultJson:{},canonicalSha256:`result-${resultId}`,createdAt:new Date(t.getTime()-1_000)});
      await db.update(nativeRunFinalizations).set({phase:"committed",resultId,recoveryState:null,
        failureCode:null,failureDetail:null,nextAttemptAt:null,updatedAt:t}).where(eq(nativeRunFinalizations.runId,f.runId));
    }
    if (shape!=="array_only_no_timer") await db.insert(heartbeatRuns).values({companyId,agentId,issueId:f.issueId,
      invocationSource:"timer",runtimeMode:"legacy",status:"succeeded",errorCode:null,error:null,
      createdAt:new Date(t.getTime()+5_000),startedAt:new Date(t.getTime()+10_000),finishedAt:new Date(t.getTime()+20_000),
      responsibleUserId:userId,contextSnapshot:{issueId:f.issueId,wakeReason:"heartbeat_timer",wakeSource:"timer"}});
    await occupySlot();
    vi.useFakeTimers({toFake:["Date"]});
    try {
      const heartbeat=heartbeatService(db);
      for (const elapsed of [90_001,119_999,120_000]) {
        vi.setSystemTime(t.getTime()+elapsed);
        await heartbeat.reconcileStrandedAssignedIssues({companyId,issueId:f.issueId});
      }
      const card=await taskInterruptionPresentation(db,await issue(f.issueId));
      const [message]=await db.select().from(issueComments).where(eq(issueComments.id,f.messageId));
      const notes=(await db.select().from(issueComments).where(and(eq(issueComments.companyId,companyId),
        eq(issueComments.issueId,f.issueId),eq(issueComments.authorType,"system")))).filter(c=>!c.deletedAt&&!(c.metadata as any)?.supersededByIncident);
      const live=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,inArray(heartbeatRuns.status,["queued","running","scheduled_retry"])));
      const [actual]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
      const [finalization]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
      const observation={shape,messageId:f.messageId,runId:f.runId,at:Date.now()-t.getTime(),body:message?.body,
        authorUserId:message?.authorUserId,deletedAt:message?.deletedAt,actualStatus:actual?.status,
        nativePhase:actual?.nativePhase,nativeSessionId:actual?.nativeSessionId,sessionIdAfter:actual?.sessionIdAfter,
        finalizationPhase:finalization?.phase,card,
        notes:notes.map(n=>({id:n.id,body:n.body})),live:live.map(r=>({id:r.id,status:r.status})),
        redeliveries:(await f.redeliveries()).length,trueOutcomes:notes.length+live.length+(card&&["failed","retry_scheduled"].includes(card.state)?1:0)};
      console.info(JSON.stringify({namedGapHardened:observation}));
      if (process.env.RF3_OBSERVATIONS_PATH) (await import("node:fs")).appendFileSync(process.env.RF3_OBSERVATIONS_PATH,JSON.stringify({namedGapHardened:observation})+"\n");
      expect(message).toMatchObject({body:"Please answer this accepted request.",authorUserId:userId,deletedAt:null});
      expect(actual).toMatchObject({nativeSessionId,sessionIdBefore:nativeSessionId,sessionIdAfter:nativeSessionId});
      expect(observation.trueOutcomes,"exactly one truth, never zero or two").toBe(1);
    } finally {vi.useRealTimers();}
  },120_000);
});
