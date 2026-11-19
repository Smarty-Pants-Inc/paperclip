import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, environmentLeases, environments, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, workspaceOperations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_REASON_PREFIX, unansweredPersonMessageCondition } from "../services/recovery/unanswered-person-message.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { recordRequiredWorkspaceRestoreFailure } from "../services/legacy-execution-recovery.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-resolved-nothing2 (gate 7, chat 888e5d1d; a 2nd chat be142497, 11-19
// 13:09-13:33Z): a person presses Interrupt ONCE; the successor eea1226b fails
// before provider work (providerWorkStarted false). Its files are pinned, which
// resolves its hold b79f0559 'blocked' / continuationDelivery 'invalidated' with
// "Recovering your saved work; your message is kept and runs when it's back."
// (nativeFailureBlock present). The saved work is recovered
// (issue.workspace_recovered 13:10:29). Then NOTHING: the carrying wake failed
// with the run, so the 3 owed messages had no wake and no run until Retry.
// Real comment/queue/Interrupt routes, real resumeQueuedCommentInterrupt, the
// real producer of the pin (recordRequiredWorkspaceRestoreFailure, as
// native-failed-workspace-recovery calls it), the real release
// (recordNativeTerminalRecoveryIfNeeded), the real workers
// (settleUnrecoverableExecutions, deliverReconciledExecutions, the per-message
// sweep) and the real post-recovery dispatch the workspace-recovery worker
// calls (reconcileRetainedWorkspaces → onRecovered = resumeRemoteStopComments).
// Seeded: the successor's provider failure and the recovery's own receipts
// (systemRecovery complete, workspace_recovery + workspace_finalize operations).
const support = await getEmbeddedPostgresTestSupport();

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("Interrupt: after a failed successor's saved work is recovered, the kept message runs", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "irn-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-resolved-nothing-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.invalid`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.IRN_EVIDENCE) await fs.appendFile(process.env.IRN_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  /** A chat whose live turn was started by M0. `aged`: the chat was left 'blocked' by an earlier incident. */
  async function seedLiveTurn(options: { aged?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const liveRunId = randomUUID(), m0 = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "IRN", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active",
      membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } },
      permissions: {} });
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000);
    const old = (h: number) => new Date(Date.now() - h * 3_600_000);
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", runtimeMode: "native", startedAt: t(3), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: m0, commentId: m0, wakeCommentIds: [m0], responsibleUserId: userId } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, issueNumber: 1, title: "Chat",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: userId, executionRunId: liveRunId,
      executionLockedAt: t(3), startedAt: t(2), conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId, issueId }).where(eq(heartbeatRuns.id, liveRunId));
    await db.insert(issueComments).values({ id: m0, companyId, issueId, authorType: "user", authorUserId: userId, body: "work",
      createdAt: t(2), updatedAt: t(2) });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: liveRunId, phase: "observed" });
    if (options.aged) {
      // An aged chat: days of answered turns before this one.
      for (const h of [72, 48, 24]) {
        const [turn] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", runtimeMode: "native",
          nativeIssueId: issueId, issueId, startedAt: old(h), finishedAt: old(h), createdAt: old(h),
          contextSnapshot: { issueId } }).returning();
        const asked = randomUUID();
        await db.insert(issueComments).values({ id: asked, companyId, issueId, authorType: "user", authorUserId: userId,
          body: `earlier ${h}`, createdAt: old(h), updatedAt: old(h) });
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, wakeCommentIds: [asked], wakeCommentId: asked } })
          .where(eq(heartbeatRuns.id, turn!.id));
        await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId,
          createdByRunId: turn!.id, body: `answer ${h}`, createdAt: old(h), updatedAt: old(h) });
      }
    }
    // Keeps every successor in the ordinary queue (no provider launch).
    const blockerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: blockerRunId, companyId, agentId, status: "running",
      contextSnapshot: { issueId: randomUUID() } });
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use("/api", agentRoutes(db, {}));
    client.use(errorHandler);
    return { companyId, agentId, issueId, liveRunId, blockerRunId, m0, client, aged: options.aged === true };
  }
  type F = Awaited<ReturnType<typeof seedLiveTurn>>;

  const deferredWakes = async (f: F) => (await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"))))
    .map(w => ({ id: w.id, ids: (w.payload as any)?._paperclipWakeContext?.wakeCommentIds as string[] ?? [],
      wait: (w.payload as any)?.executionWait ?? null, key: w.idempotencyKey }))
    .filter(w => w.ids.length > 0);

  async function type(f: F, bodies: string[]) {
    const ids: string[] = [];
    for (const body of bodies) {
      const before = (await deferredWakes(f)).flatMap(w => w.ids);
      const posted = await request(f.client).post(`/api/issues/${f.issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      ids.push(posted.body.id);
      await waitFor(async () => (await deferredWakes(f)).flatMap(w => w.ids).length > before.length);
    }
    return ids;
  }

  async function barInterrupt(f: F) {
    const queue = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
    const pressed = await request(f.client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: queue.targetRunId });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
  }

  async function acknowledge(f: F, runId: string) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, processGroupId: null, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: "intent", acknowledgementAuditId: "ack" } } }).where(eq(heartbeatRuns.id, runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null })
      .where(eq(nativeRunFinalizations.runId, runId));
  }

  async function resumeInterrupts(f: F) {
    const heartbeat = heartbeatService(db);
    for (let pass = 0; pass < 2; pass += 1) {
      const saved = (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).filter(w => (w.payload as any)?.queuedCommentInterrupt);
      for (const wake of saved) await heartbeat.resumeQueuedCommentInterrupt(f.companyId, wake.id);
    }
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.contextSnapshot?.issueId === f.issueId && !["cancelled", "succeeded", "failed"].includes(run.status));
  }

  /** The successor starts (native), fails before any provider work; finalization pins its files (the real
   * producer), then the run end releases it (the real release). */
  async function successorFails(f: F, runId: string) {
    const errorCode = "native_predecessor_retirement_unproven";
    const started = new Date(Date.now() - 30_000);
    await db.update(heartbeatRuns).set({ status: "running", startedAt: started, runtimeMode: "native", nativeIssueId: f.issueId,
      issueId: f.issueId }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, executionLockedAt: started }).where(eq(issues.id, f.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId, phase: "observed" })
      .onConflictDoNothing();
    const leaseId = randomUUID();
    const [failed] = await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), nativePhase: "terminal_failure",
      error: `${errorCode}: The previous run's session on this sandbox could not be retired`, errorCode,
      resultJson: { stopReason: "adapter_failed", failureCause: errorCode,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] } } })
      .where(eq(heartbeatRuns.id, runId)).returning();
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, failureCode: errorCode })
      .where(eq(nativeRunFinalizations.runId, runId));
    // gate 7: the carrying wake FAILED with the run.
    await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), error: errorCode })
      .where(eq(agentWakeupRequests.runId, runId));
    // native-failed-workspace-recovery: native_execution_failed_before_workspace_export pins owed files.
    await recordRequiredWorkspaceRestoreFailure(db, failed!, { workspaceRestoreFailure: "restore_failed" }, undefined,
      { restorePending: true });
    const releaseDeps = {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    };
    await createWakeQueue(db, releaseDeps as never).releaseIssueExecution({ companyId: f.companyId, runId, now: new Date() });
    const [hold] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      eq(issueRecoveryActions.fingerprint, `native-workspace:${runId}`)));
    return hold!;
  }

  /** The workspace-recovery service's own completion (receipts as recoverRetainedWorkspace writes them), then
   * its post-recovery dispatch: reconcileRetainedWorkspaces calls onRecovered = heartbeat.resumeRemoteStopComments. */
  async function workspaceRecovered(f: F, runId: string, holdId: string) {
    // The saved remote workspace the recovery committed (snapshot, clean authority, run reference "saved").
    const workspaceId = randomUUID(), snapshotId = randomUUID(), providerLeaseId = `bx_${runId.slice(0, 8)}`;
    // The failed run's sandbox allocation; recovery attempt 2 confirmed its stop (attempt 1: agent_stop_unconfirmed).
    const [environment] = await db.insert(environments).values({ name: `env-${runId}`, driver: "sandbox" }).returning();
    const [allocated] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: runId,
      environmentId: environment!.id, provider: "daytona", providerLeaseId, leasePolicy: "retain_on_failure", status: "released",
      cleanupStatus: "success", releasedAt: new Date(), metadata: { remoteCwd: "/workspace", driver: "sandbox" } }).returning();
    await db.update(environmentLeases).set({ metadata: { ...allocated!.metadata,
      remoteExecutionTermination: remoteTerminationReceipt(allocated as never, { providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, allocated!.id));
    const leaseId = allocated!.id;
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId, sourceIssueId: f.issueId,
      name: "Chat workspace", cwd: "/workspace", providerType: "cloud_sandbox", mode: "isolated_workspace",
      strategyType: "project_primary", status: "active", metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1",
        epoch: 1, snapshotId, source: { kind: "empty" }, location: null, writerRunId: null, dirty: false } } });
    const [saved] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: runId,
      executionWorkspaceId: workspaceId, phase: "workspace_recovery", status: "succeeded", finishedAt: new Date(),
      metadata: { recoveryActionId: holdId, leaseId, providerLeaseId, snapshotId, generation: 1, sha256: "a".repeat(64),
        storage: "remote_workspace", epoch: 1 } }).returning();
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId: f.companyId, executionWorkspaceId: workspaceId,
      sourceOperationId: saved!.id, sourceRunId: runId, generation: 1, epoch: 1, status: "committed", sha256: "a".repeat(64) });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source!.runnerProfileJson, remoteWorkspace: {
      schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId, remoteCwd: "/workspace", epoch: 1,
      state: "saved", snapshotId } } }).where(eq(heartbeatRuns.id, runId));
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "succeeded", finishedAt: new Date(),
      metadata: { owningService: "workspace_recovery", preservationOperationIds: [saved!.id] } });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, holdId));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
      systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, sourceRunId: runId, phase: "reconcile_effects",
        state: "complete", attempts: 2, nextAttemptAt: null, freshAttemptRunId: null, preservationOperationIds: [saved!.id],
        failure: { code: "agent_stop_unconfirmed", retryClass: "recheck_evidence" } },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId, status: "recovered", stage: "saving_receipts",
        attempt: 2, attemptLimit: 6, requestIds: [] } } }).where(eq(issueRecoveryActions.id, holdId));
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "workspace-recovery",
      action: "issue.workspace_recovered", entityType: "issue", entityId: f.issueId, runId,
      details: { recoveryActionId: holdId, summary: "Saved work recovered." } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return run!;
  }

  const cards = async (f: F) => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
    eq(issueComments.authorType, "system")))).filter(c => !c.deletedAt &&
    String((c.metadata as any)?.authorizationReason ?? "").startsWith(UNANSWERED_MESSAGE_REASON_PREFIX))
    .map(c => String((c.metadata as any).authorizationReason).slice(UNANSWERED_MESSAGE_REASON_PREFIX.length));

  async function state(f: F, failedRunId: string, holdId?: string) {
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => r.id !== failedRunId && r.id !== f.liveRunId && r.id !== f.blockerRunId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [hold] = holdId ? await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, holdId)) : [];
    return {
      issueStatus: issue!.status,
      live: runs.filter(r => ["queued", "running", "scheduled_retry"].includes(r.status))
        .map(r => ({ id: r.id, status: r.status, ids: (r.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? [],
          reason: r.contextSnapshot?.wakeReason })),
      hold: hold ? { status: hold.status, outcome: hold.outcome, delivery: hold.evidence.continuationDelivery,
        nextAction: hold.nextAction, nativeFailureBlock: hold.evidence.nativeFailureBlock,
        workspaceRestorePending: hold.evidence.workspaceRestorePending, requeue: hold.evidence.recoveredWorkspaceRequeue } : null,
      wakes: await deferredWakes(f),
      cards: await cards(f),
    };
  }

  /** Every worker the server runs on its own, once, `minutes` after the failure. */
  async function workersPass(f: F, minutes: number) {
    const heartbeat = heartbeatService(db);
    const now = new Date(Date.now() + minutes * 60_000);
    await settleUnrecoverableExecutions(db, new Date());
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now });
  }

  /** gate 7's chain up to issue.workspace_recovered. */
  async function chain(aged: boolean) {
    const f = await seedLiveTurn({ aged });
    const owed = await type(f, ["work more", "6 x 7?", "capital of France?"]);
    await barInterrupt(f);
    await acknowledge(f, f.liveRunId);
    const successors = await resumeInterrupts(f);
    expect(successors, "ONE successor").toHaveLength(1);
    const successor = successors[0]!;
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.blockerRunId));
    const hold = await successorFails(f, successor.id);
    await workersPass(f, 0);
    const afterFailure = await state(f, successor.id, hold.id);
    // b79f0559's shape: resolved 'blocked', 'invalidated', nativeFailureBlock present, the kept-message promise.
    expect(afterFailure.hold, JSON.stringify(afterFailure)).toMatchObject({ status: "resolved", outcome: "blocked",
      delivery: "invalidated", workspaceRestorePending: true,
      nextAction: "Recovering your saved work; your message is kept and runs when it's back.",
      nativeFailureBlock: { runId: successor.id } });
    expect(afterFailure.issueStatus).toBe("blocked");
    expect(afterFailure.live).toEqual([]);
    return { f, owed, successor, hold, afterFailure };
  }

  async function recoveredRow(label: string, aged: boolean) {
    const { f, owed, successor, hold, afterFailure } = await chain(aged);
    const t0 = Date.now();
    const failed = await workspaceRecovered(f, successor.id, hold.id);
    await heartbeatService(db).resumeRemoteStopComments(failed as never);
    await workersPass(f, 1);
    const at60s = await state(f, successor.id, hold.id);
    const elapsedMs = Date.now() - t0;
    await workersPass(f, 30);
    await workersPass(f, 60);
    // A second recovery pass (the worker revisits) never makes a second run.
    await heartbeatService(db).resumeRemoteStopComments(failed as never);
    const later = await state(f, successor.id, hold.id);
    await evidence(label, { owed, successor: successor.id, afterFailure, at60s, elapsedMs, later });
    expect(elapsedMs).toBeLessThan(60_000);
    expect(at60s.live, `within 60 s ONE run carrying every owed message, in order: ${JSON.stringify(at60s)}`)
      .toEqual([expect.objectContaining({ ids: [f.m0, ...owed] })]);
    expect(later.live, `still ONE run: ${JSON.stringify(later)}`).toEqual([expect.objectContaining({ id: at60s.live[0]!.id })]);
    expect(later.cards, "no card for a carried message").toEqual([]);
    expect(later.issueStatus, "the hold's own block is lifted").not.toBe("blocked");
    expect(later.hold?.requeue, "the dispatch is recorded on the hold").toMatchObject({ outcome: "enqueued",
      runId: at60s.live[0]!.id, commentIds: [f.m0, ...owed] });
    return { f, owed };
  }

  it("R1 aged chat: failed successor (no provider work), recovery 'blocked'/'invalidated', workspace_recovered ⇒ within 60 s ONE run carrying all 3, no Retry", async () => {
    await recoveredRow("R1", true);
  }, 180_000);

  it("R3 new chat: same chain ⇒ ONE run carrying all 3", async () => {
    await recoveredRow("R3", false);
  }, 180_000);

  it("C2 control: the owed messages were answered meanwhile ⇒ no run", async () => {
    const { f, owed, successor, hold } = await chain(true);
    // An earlier turn that carried all 3 answered them (an AGENT reply from a run carrying them).
    const [answerer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, issueId: f.issueId, createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId: f.issueId, wakeCommentIds: [f.m0, ...owed], wakeCommentId: owed.at(-1) } }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: answerer!.id, body: "answers to all three" });
    const failed = await workspaceRecovered(f, successor.id, hold.id);
    await heartbeatService(db).resumeRemoteStopComments(failed as never);
    await workersPass(f, 1);
    const at60s = await state(f, successor.id, hold.id);
    await evidence("C2", { owed, at60s });
    expect(at60s.live, JSON.stringify(at60s)).toEqual([]);
    expect(at60s.hold?.requeue).toBeUndefined();
  }, 180_000);

  it("R4 the person presses Retry at the same time as recovery completes ⇒ still ONE run", async () => {
    const { f, owed, successor, hold } = await chain(true);
    const failed = await workspaceRecovered(f, successor.id, hold.id);
    const [retry] = await Promise.all([
      request(f.client).post(`/api/issues/${f.issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: successor.id }),
      heartbeatService(db).resumeRemoteStopComments(failed as never),
    ]);
    await new Promise(resolve => setTimeout(resolve, 500));
    await heartbeatService(db).resumeRemoteStopComments(failed as never);
    await workersPass(f, 1);
    const at60s = await state(f, successor.id, hold.id);
    const all = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => ![successor.id, f.liveRunId, f.blockerRunId].includes(r.id) && r.contextSnapshot?.issueId === f.issueId)
      .map(r => ({ id: r.id, status: r.status, error: r.errorCode, reason: r.contextSnapshot?.wakeReason,
        ids: r.contextSnapshot?.wakeCommentIds, createdAt: r.createdAt }));
    await evidence("R4", { owed, retry: { status: retry.status, body: retry.body }, at60s, all });
    // Runs created after the failure, in any status: the route's own dispatch may already have started it
    // (this test server has no local runtime listener, so a started run fails there; that is not a second run).
    const [failedRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
    const after = all.filter(r => r.createdAt > failedRow!.finishedAt!);
    expect(retry.status, JSON.stringify(retry.body)).toBeLessThan(500);
    expect(after, `ONE run: ${JSON.stringify({ at60s, all, retry: retry.body })}`)
      .toEqual([expect.objectContaining({ ids: [f.m0, ...owed] })]);
  }, 180_000);

  /** adopt-requeue-boot: the real stranded sweep's visit, as recovery/work.ts makes it. Its page load visits a
   * 'blocked' task only while unansweredPersonMessageCondition holds; the check is owner.stranded
   * (heartbeat.ts: reconcileStrandedAssignedIssues with these options). */
  async function strandedSweepVisit(f: F) {
    const visited = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, f.issueId),
      eq(issues.status, "blocked"), unansweredPersonMessageCondition(issues.id, issues.companyId)));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId,
      unanswered: true, skipExternalConversationSettlement: true, skipRelatedRecovery: true } as never);
    return visited.length === 1;
  }

  /** gate 7's 888e5d1d as the new build finds it: recovery completed (workspace_recovered) under the OLD build,
   * whose onRecovered queued nothing; the workers have passed; the chat sits 'blocked', untouched. */
  async function bootShape() {
    const { f, owed, successor, hold } = await chain(true);
    const failed = await workspaceRecovered(f, successor.id, hold.id);
    await workersPass(f, 1);
    const atBoot = await state(f, successor.id, hold.id);
    expect(atBoot.live, JSON.stringify(atBoot)).toEqual([]);
    expect(atBoot.hold?.requeue, "the old build never dispatched").toBeUndefined();
    return { f, owed, successor, hold, failed, atBoot };
  }

  it("B1 boot: a chat already left 'blocked' after workspace_recovered (nothing queued) ⇒ the stranded sweep's visit makes ONE run carrying all owed, in order; a second pass adds none", async () => {
    const { f, owed, successor, hold, atBoot } = await bootShape();
    const t0 = Date.now();
    const visitedBlocked = await strandedSweepVisit(f);
    const afterSweep = await state(f, successor.id, hold.id);
    const elapsedMs = Date.now() - t0;
    await strandedSweepVisit(f);
    await workersPass(f, 30);
    await strandedSweepVisit(f);
    const later = await state(f, successor.id, hold.id);
    // Every run created after the failure, in any status: the sweep's own dispatch may already have started it
    // (this test server has no local runtime listener, so a started run fails there; that is not a second run).
    const [failedRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
    const runsAfter = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => r.contextSnapshot?.issueId === f.issueId && r.createdAt > failedRow!.finishedAt!)
      .map(r => ({ id: r.id, status: r.status, ids: r.contextSnapshot?.wakeCommentIds }));
    await evidence("B1", { owed, successor: successor.id, atBoot, visitedBlocked, afterSweep, elapsedMs, later, runsAfter });
    expect(atBoot.issueStatus, "the boot shape is 'blocked'").toBe("blocked");
    expect(visitedBlocked, "the sweep's page load visits this blocked task").toBe(true);
    expect(afterSweep.live, `ONE run carrying every owed message, in order: ${JSON.stringify(afterSweep)}`)
      .toEqual([expect.objectContaining({ ids: [f.m0, ...owed] })]);
    expect(runsAfter, `still ONE run after three sweep passes: ${JSON.stringify({ later, runsAfter })}`)
      .toEqual([expect.objectContaining({ id: afterSweep.live[0]!.id, ids: [f.m0, ...owed] })]);
    const keyed = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.idempotencyKey, `recovered-workspace-requeue:${hold.id}`)));
    expect(keyed, "ONE keyed wake").toHaveLength(1);
    expect(later.issueStatus, "the hold's own block is lifted").not.toBe("blocked");
    expect(later.hold?.requeue).toMatchObject({ outcome: "enqueued", runId: afterSweep.live[0]!.id, commentIds: [f.m0, ...owed] });
  }, 180_000);

  it("B2 boot control: the owed messages were answered meanwhile ⇒ the sweep's visit makes nothing", async () => {
    const { f, owed, successor, hold } = await chain(true);
    const [answerer] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, issueId: f.issueId, createdAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId: f.issueId, wakeCommentIds: [f.m0, ...owed], wakeCommentId: owed.at(-1) } }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: answerer!.id, body: "answers to all three" });
    await workspaceRecovered(f, successor.id, hold.id);
    await workersPass(f, 1);
    await strandedSweepVisit(f);
    await strandedSweepVisit(f);
    const after = await state(f, successor.id, hold.id);
    await evidence("B2", { owed, after });
    expect(after.live, JSON.stringify(after)).toEqual([]);
    expect(after.hold?.requeue).toBeUndefined();
  }, 180_000);
});
