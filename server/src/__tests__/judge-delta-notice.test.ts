import { appendFile } from "node:fs/promises";
import { issueService } from "./issues.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { randomUUID } from "node:crypto";
import { currentNotices } from "./rfl-current-notice-assertions.js";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, approvals, authUsers, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueApprovals, issueRecoveryActions, issueThreadInteractions,
  heartbeatRunEvents, issueComments, issues, nativeRunFinalizations, toolInvocations, companyMemberships,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../__tests__/helpers/truncate-with-deadlock-retry.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { PENDING_CONTINUATION_BOUND_MS } from "./recovery-continuation-pacing.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import {
  FRESH_CONTINUATIONS_PER_HOUR, FRESH_CONTINUATION_SCHEMA, PERSON_OWNED_FAILURE_CODES, continueHeldExecutions, ensureFreshContinuation,
  resetBacklogContinuationPacingForTests,
  freshContinuationNote, heldExecutionsAwaitingFreshContinuation, nextFreshContinuationCheckAt, recordFreshContinuationCheck, FRESH_CONTINUATION_PENDING_BOUND_MS, FRESH_CONTINUATION_PROGRESS_BOUND_MS, FRESH_CONTINUATION_SAVED_WORK_BOUND_MS,
} from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { currentProcessSpaceHash } from "./controller-process-identity.js";
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
import { NATIVE_CONTINUATION_REFUSED_ACTION, isNativeContinuationRefusal } from "./native-continuation-refusal.js";
import { freshContinuationChain } from "./fresh-continuation-chain.js";
import { settleUnansweredPersonMessagesForTask, UNANSWERED_MESSAGE_BOUND_REACHED_TEXT } from "./recovery/unanswered-person-message.js";
import { readFreshThreadStopProof, FRESH_THREAD_STARTED_NOTE } from "./native-runtime/fresh-thread-stop-gate.js";
import { selectFreshContinuationThread } from "./native-runtime/pi-conversation-record.js";
import { prepareSupersededWarmSandboxStop } from "./sandbox-stop-and-retain.js";
import { createReusableLeaseHandoff } from "./environment-lease-handoff.js";

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
    await truncateTablesWithDeadlockRetry(db, `truncate table issue_recovery_actions, native_run_finalizations, tool_invocations,
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


  it.each(["raw", "notification", "named"] as const)("JUDGE real notice %s", async shape => {
    const failure = "runner_process_termination_unconfirmed: runnerd process supervision failed: Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): result_unconfirmed, evidence=unknown (possibly ran)";
    const error = shape === "named" ? "runner_process_supervision_budget_exhausted: Paperclip could not verify the previous runner within the supervision allowance." : shape === "notification" ? `Notification transport failed closed: ${failure}` : failure;
    const f = await unfinishedRun({ runtime: "native", error, errorCode: shape === "named" ? "runner_process_supervision_budget_exhausted" : "notification_transport_failed", hold: "none" });
    const [message] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: userId, body: "Please continue my work", createdAt: new Date(Date.now() - 900_000) }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeCommentId: message.id }, finishedAt: new Date(Date.now() - 600_000) }).where(eq(heartbeatRuns.id, f.runId));
    const result = await settleUnansweredPersonMessagesForTask(db, { companyId, issueId: f.issueId });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const task = await issue(f.issueId);
    const presentation = await taskInterruptionPresentation(db, task);
    await appendFile(`${process.env.TASK_OUT}/judge-consumers.jsonl`, JSON.stringify({ shape, f, result, comments, presentation, task }) + "\n");
    expect(comments.filter(c => c.authorType === "system")).toHaveLength(1);
  }, 60_000);

  it("JUDGE same-field independent refusal", () => {
    const error = "runner_process_termination_unconfirmed: runnerd process supervision failed: boat_command_possibly_ran: unavailable; runner_state_identity_mismatch: prior_owner_active";
    const refused = isNativeContinuationRefusal({ error });
    console.log("JUDGE same-field refusal", JSON.stringify({ error, refused }));
    expect(refused).toBe(true);
  });

  it.each(["raw", "notification", "saved_code"] as const)("JUDGE next person message real dispatch %s", async shape => {
    const failure = "runner_process_termination_unconfirmed: runnerd process supervision failed: Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): result_unconfirmed, evidence=unknown (possibly ran)";
    const f = await unfinishedRun({ runtime: "native", error: shape === "saved_code" ? "Saved supervision failure" : shape === "notification" ? `Notification transport failed closed: ${failure}` : failure, errorCode: shape === "saved_code" ? failure : "notification_transport_failed", hold: "none" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.update(agents).set({ adapterType: "codex_local", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    const executions: string[] = [];
    registerServerAdapter({ type: "codex_local", supportsLocalAgentJwt: false, execute: async input => {
      executions.push(input.runId);
      await issueService(db).addComment(f.issueId, "JUDGE successor answer", { agentId, runId: input.runId }, { completionReply: true });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
    }, testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    const old = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await once(old, "spawn");
    const hb = heartbeatService(db);
    try {
      await db.update(heartbeatRuns).set({ processPid: old.pid }).where(eq(heartbeatRuns.id, f.runId));
      const message = await issueService(db).addComment(f.issueId, "NEXT PERSON ASK", { userId }, { clientRequestId: randomUUID() });
      const admitted = await hb.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: f.issueId, commentId: message.id }, contextSnapshot: { issueId: f.issueId, wakeCommentId: message.id, wakeReason: "issue_commented" } });
      await hb.drainActiveRunExecutions();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId));
      let late: unknown = null;
      try { late = await issueService(db).addComment(f.issueId, "OLD RUN LATE ANSWER", { agentId, runId: f.runId }, { completionReply: true }); }
      catch (e) { late = { rejected: true, message: (e as Error).message, status: (e as any).status, details: (e as any).details }; }
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      await appendFile(`${process.env.TASK_OUT}/judge-next-message.jsonl`, JSON.stringify({ shape, f, message, admitted, executions, runs, comments, late, oldAlive: (()=>{try { process.kill(old.pid!,0); return true; } catch { return false; }})() }) + "\n");
      expect(executions).toHaveLength(1);
      expect(comments.filter(c => c.authorType === "agent")).toHaveLength(1);
      expect(late).toMatchObject({ rejected: true });
    } finally {
      const done = once(old, "exit"); old.kill("SIGKILL"); await done;
      await hb.drainActiveRunExecutions(); unregisterServerAdapter("codex_local");
    }
  }, 90_000);
});
