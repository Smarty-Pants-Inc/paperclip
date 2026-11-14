import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, approvals, authUsers, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueApprovals, issueRecoveryActions, issueThreadInteractions,
  heartbeatRunEvents, issueComments, issues, nativeRunFinalizations, toolInvocations,
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
import { requestTaskRetry } from "./task-retry.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";

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

  it.each(["native_controller_recovery_missing_evidence:snapshot_binding", "generic_unclassified_recovery"])("J-CLASS3 generic envelope control %s", async error => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation", error });
    await db.insert(environmentLeases).values({ companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      provider: "boat", providerLeaseId: `control-${randomUUID()}`, status: "retained", metadata: { pluginId: "fixture-boat" } });
    const result = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    if (error.startsWith("native_controller")) {
      expect(result).toMatchObject({ kind: "exact_recovery_pending" });
      expect(await successors(f.runId)).toHaveLength(0);
    } else {
      expect(result).toMatchObject({ kind: "continued" });
      await expectOneFreshSuccessor(f);
    }
  });

  it("J-CLASS3 generic prepare channel must not claim a skill edit happened", async () => {
    const { freshThreadRefusalCode } = await import("./native-runtime/runner-reconciliation-refusal.js");
    const { runnerPrepareRefusalCode } = await import("../vendor/paperclip-runner/index.js");
    const legacyReceipt = Object.assign(new Error("Legacy runner refused preparation; no structured reason"), {
      runnerCommandResult: { commandType: "run.prepare", status: "failed", result: { code: "command_execution_failed" } },
    });
    const code = freshThreadRefusalCode(legacyReceipt);
    const prepareRefusalCode = runnerPrepareRefusalCode(legacyReceipt);
    expect(code).toBe("native_runner_refresh_required");
    expect(prepareRefusalCode).toBe("provider_prepare_refused");
    const f = await unfinishedRun({ runtime: "native", errorCode: code! });
    await db.update(heartbeatRuns).set({ resultJson: { nativeFreshContinuationRefusal: {
      code, prepareRefusalCode, waitForTurn: false,
    } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued" });
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).not.toMatch(/your skill change is in effect/i);
  });

  it("J-REMOTE-ABSENCE current-controller launch payload plus missing remote lease is NOT local absence proof", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_remote_state_unavailable" });
    // Exact production start-intent payload: the controller's hostname, NOT the
    // remote target kind (native-session-executor.ts:12962). Durable profile says remote.
    const { hostname } = await import("node:os");
    await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1,
      eventType: "native.process_start_requested", stream: "system", payload: {
        hostname: hostname(), providerAttempt: 1, requestedAt: new Date().toISOString(),
      } });
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID(), runnerProfileJson: { remoteWorkspace: {
      schema: "paperclip.remote-workspace-run.v1", workspaceId: randomUUID(), leaseId: randomUUID(),
      providerLeaseId: "still-uninspected-remote-allocation", remoteCwd: "/workspace", epoch: 1, state: "prepared", snapshotId: null,
    } } }).where(eq(heartbeatRuns.id, f.runId));
    const result = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    expect.soft(result).toMatchObject({ kind: "exact_recovery_pending" });
    const record = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0];
    expect.soft(record.evidence).not.toHaveProperty("freshContinuation");
    const [next] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "running", createdAt: new Date(Date.now() + 1000), contextSnapshot: {
        issueId: f.issueId, previousRunId: f.runId, recoveryActionId: record.id,
      } }).returning();
    const { readFreshContinuationSessionBoundary } = await import("./fresh-continuation-fallback.js");
    const boundary = await readFreshContinuationSessionBoundary(db, next, f.issueId);
    appendFileSync(process.env.TASK_OUT + "/logs/remote-absence-authority.jsonl", JSON.stringify({ result,
      fresh: record.evidence.freshContinuation, boundary }) + "\n");
    expect(boundary).toBeNull();
  });

});
