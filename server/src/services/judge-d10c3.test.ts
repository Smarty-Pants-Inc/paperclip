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

  // ===== JUDGE PROBES (rfl-d10c3b) =====
  const CODE = "native_controller_recovery_missing_evidence:snapshot_binding";
  const sysNotes = async (issueId: string) => (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(c => c.authorType === "system");
  const receiptFor = (lease: typeof environmentLeases.$inferSelect, runId: string, confirmedAt: string, state = "stopped") => ({
    schema: "paperclip.remote-termination.v1", companyId, runId, leaseId: lease.id, provider: lease.provider,
    providerLeaseId: lease.providerLeaseId, state, confirmedAt });
  async function seeded(code = CODE) {
    const f = await unfinishedRun({ runtime: "native", errorCode: code });
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    return f;
  }
  const report = (name: string, value: unknown) => appendFileSync("/srv/scratch/paul/tasks/direct/rfl-d10c3b/artifacts/logs/judge-probes-c3prime.jsonl", `JUDGE ${name} ${JSON.stringify(value)}
`);

  it("P1 no lease and no recorded process: what ends the wait?", async () => {
    const f = await seeded();
    const kinds: unknown[] = [];
    for (const now of [new Date(), new Date(Date.now() + 24 * 3600_000), new Date(Date.now() + 30 * 24 * 3600_000)])
      kinds.push(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now }));
    const notes = await sysNotes(f.issueId);
    report("P1", { kinds, notes: notes.map(n => n.body) });
  });

  it.each(["local", "boat-no-provider-lease-id"])("P1b lease that can never carry a receipt (%s)", async shape => {
    const f = await seeded();
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: shape === "local" ? "local" : "boat", providerLeaseId: shape === "local" ? "local-1" : null,
      status: shape === "local" ? "released" : "failed", cleanupStatus: "success", acquiredAt: new Date(Date.now() - 120_000), releasedAt: new Date() });
    const kinds: unknown[] = [];
    for (const now of [new Date(), new Date(Date.now() + 30 * 24 * 3600_000)])
      kinds.push(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now }));
    report(`P1b-${shape}`, { kinds, notes: (await sysNotes(f.issueId)).map(n => n.body) });
  });

  it.each(["active", "expired-old", "retained"])("P2 old execution not proven gone (%s lease, no receipt): no fresh thread, one waiting note", async shape => {
    const f = await seeded();
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: shape === "active" ? "active" : shape === "retained" ? "retained" : "expired",
      cleanupStatus: shape === "expired-old" ? "success" : null, acquiredAt: new Date(Date.now() - 48 * 3600_000),
      releasedAt: shape === "expired-old" ? new Date(Date.now() - 47 * 3600_000) : null,
      expiresAt: new Date(Date.now() - 46 * 3600_000), metadata: { pluginId: "fixture-boat" } }).returning();
    const kinds: unknown[] = [];
    for (const now of [new Date(), new Date(Date.now() + 3600_000), new Date(Date.now() + 30 * 24 * 3600_000)])
      kinds.push((await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now })).kind);
    const notes = await sysNotes(f.issueId);
    const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    report(`P2-${shape}`, { kinds, noteCount: notes.length, note: notes[0]?.body, leaseStatusAfter: after.status,
      stopIntent: Boolean(after.metadata?.sandboxStopAndRetain), hasFresh: Boolean(action.evidence.freshContinuation), successors: (await successors(f.runId)).length });
    expect(kinds).toEqual(["exact_recovery_pending", "exact_recovery_pending", "exact_recovery_pending"]);
    expect(notes).toHaveLength(1);
    expect(action.evidence).not.toHaveProperty("freshContinuation");
    expect(await successors(f.runId)).toHaveLength(0);
  });

  it("P3 proof arrives: two concurrent owners -> one settlement, one note, one successor; in-place note edit recorded", async () => {
    const f = await seeded();
    const acquiredAt = new Date(Date.now() - 120_000);
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: "released", cleanupStatus: "success", acquiredAt, releasedAt: new Date(),
      metadata: { pluginId: "fixture-boat" } }).returning();
    expect((await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" })).kind).toBe("exact_recovery_pending");
    const before = await sysNotes(f.issueId);
    await new Promise(r => setTimeout(r, 30));
    const confirmedAt = new Date().toISOString();
    const [mid] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    report("P3-lease-after-first-check", { status: mid.status, cleanupStatus: mid.cleanupStatus, failureReason: mid.failureReason, stopIntent: Boolean(mid.metadata?.sandboxStopAndRetain) });
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(), metadata: { pluginId: "fixture-boat",
      remoteExecutionTermination: receiptFor(lease, f.runId, confirmedAt) } }).where(eq(environmentLeases.id, lease.id));
    const results = await Promise.all([1, 2, 3, 4].map(() => ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }).then(r => r.kind, e => `ERR:${(e as Error).message}`)));
    const again = (await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" })).kind;
    const after = await sysNotes(f.issueId);
    const actions = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    report("P3", { results, again, before: before.map(n => ({ id: n.id, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt })),
      after: after.map(n => ({ id: n.id, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt, metadata: n.metadata })), freshActions: actions.length });
    expect(results.filter(k => k === "continued")).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(actions).toHaveLength(1);
    await expectOneFreshSuccessor(f);
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
  });

  it("P5 real stop-only settle shape: confirmedAt after releasedAt (intent written first)", async () => {
    const f = await seeded();
    const releasedAt = new Date(Date.now() - 5_000);
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: "released", cleanupStatus: "success", acquiredAt: new Date(Date.now() - 120_000), releasedAt,
      metadata: { pluginId: "fixture-boat" } }).returning();
    await db.update(environmentLeases).set({ metadata: { pluginId: "fixture-boat",
      remoteExecutionTermination: receiptFor(lease, f.runId, new Date().toISOString()) } }).where(eq(environmentLeases.id, lease.id));
    const r = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    report("P5", { kind: r.kind, leaseStatusAfter: after.status, stopIntent: Boolean(after.metadata?.sandboxStopAndRetain), receiptKept: Boolean(after.metadata?.remoteExecutionTermination) });
  });

  it("P6 active turn: an earlier and a NEWER running run on the same session", async () => {
    for (const offset of [-500, +500]) {
      const f = await seeded("native_runner_refresh_required");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
        provider: "boat", providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: "released", cleanupStatus: "success", acquiredAt: new Date(Date.now() - 120_000), releasedAt: new Date(),
        metadata: { pluginId: "fixture-boat" } }).returning();
      await db.update(environmentLeases).set({ metadata: { pluginId: "fixture-boat",
        remoteExecutionTermination: receiptFor(lease, f.runId, new Date(Date.now() - 1000).toISOString()) } }).where(eq(environmentLeases.id, lease.id));
      const [active] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
        nativeSessionId: run.nativeSessionId, runtimeMode: "native", status: "running", createdAt: new Date(run.createdAt.getTime() + offset),
        contextSnapshot: { issueId: f.issueId } }).returning();
      const r = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
      report(`P6-offset${offset}`, { result: r, notes: (await sysNotes(f.issueId)).map(n => n.body), successors: (await successors(f.runId)).length });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, active.id));
    }
  });

  it("P7 a person's Stop is never undone and gets no waiting note", async () => {
    const f = await seeded();
    await db.update(heartbeatRuns).set({ resultJson: { operatorInterrupted: true } }).where(eq(heartbeatRuns.id, f.runId));
    const r = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    report("P7", { result: r, notes: (await sysNotes(f.issueId)).length });
    expect(r.kind).toBe("person_owned");
    expect(await sysNotes(f.issueId)).toHaveLength(0);
  });
  it.each(["newer-succeeded-other-session", "newer-succeeded-same-session"])("P8 the conversation moved on (%s): proof must not start a second thread or post a false note", async shape => {
    const f = await seeded();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: "released", cleanupStatus: "success", acquiredAt: new Date(Date.now() - 120_000), releasedAt: new Date(),
      metadata: { pluginId: "fixture-boat" } }).returning();
    await db.update(environmentLeases).set({ metadata: { pluginId: "fixture-boat",
      remoteExecutionTermination: receiptFor(lease, f.runId, new Date(Date.now() - 1000).toISOString()) } }).where(eq(environmentLeases.id, lease.id));
    const [later] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      nativeSessionId: shape.endsWith("same-session") ? run.nativeSessionId : randomUUID(), runtimeMode: "native", status: "succeeded",
      createdAt: new Date(run.finishedAt!.getTime() + 1000), startedAt: new Date(run.finishedAt!.getTime() + 2000), finishedAt: new Date(run.finishedAt!.getTime() + 20_000),
      contextSnapshot: { issueId: f.issueId } }).returning();
    await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "agent", authorAgentId: agentId, body: "Answered already.", createdByRunId: later.id });
    const direct = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    await settleUnrecoverableExecutions(db);
    const actions = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    await deliver();
    report(`P8-${shape}`, { direct, freshActions: actions.length, notes: (await sysNotes(f.issueId)).map(n => n.body), successors: (await successors(f.runId)).length });
  });
  it.each(["newer-succeeded", "newer-running-other-session", "newer-queued-same-session"])("P9 successor exists but NO stop proof (%s): gate side effects before the successor check?", async shape => {
    const f = await seeded();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: f.runId, issueId: f.issueId,
      provider: "boat", providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: "retained", acquiredAt: new Date(Date.now() - 120_000),
      metadata: { pluginId: "fixture-boat" } }).returning();
    const status = shape === "newer-succeeded" ? "succeeded" : shape === "newer-running-other-session" ? "running" : "queued";
    const [later] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      nativeSessionId: shape.endsWith("same-session") ? run.nativeSessionId : randomUUID(), runtimeMode: "native", status,
      createdAt: new Date(run.finishedAt!.getTime() + 1000), startedAt: status === "queued" ? null : new Date(run.finishedAt!.getTime() + 2000),
      finishedAt: status === "succeeded" ? new Date(run.finishedAt!.getTime() + 20_000) : null,
      contextSnapshot: { issueId: f.issueId } }).returning();
    if (status === "succeeded") await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "agent", authorAgentId: agentId, body: "Answered already.", createdByRunId: later.id });
    const direct = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    await settleUnrecoverableExecutions(db);
    const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    report(`P9-${shape}`, { direct, notes: (await sysNotes(f.issueId)).map(n => n.body), leaseStatusAfter: after.status, stopIntent: Boolean(after.metadata?.sandboxStopAndRetain) });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, later.id));
  });
});
