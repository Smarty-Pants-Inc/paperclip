import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { recordLegacyWorkspaceRestoreFailure, recordRequiredWorkspaceRestoreFailure, terminalizeLegacyExecution,
  UNRESTORED_FILES_NEXT_ACTION, workspaceRestoreOnlyOwed } from "./legacy-execution-recovery.js";
import { adoptSystemRecovery, loadSystemRecovery, updateSystemRecovery } from "./system-recovery.js";
import { executionControlSchedule } from "./execution-control-work.js";
import { STOP_PROOF_MAX_REARMS, STOP_PROOF_RECOVERY_SCHEMA } from "./system-recovery-state.js";
import { activityService } from "./activity.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { requestTaskRetry } from "./task-retry.js";
import { retryRefusedBeforeAdmission } from "./task-retry-eligibility.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";

// Literal on purpose: the words the person reads while files are only owed.
const RECOVERING_TEXT = "Recovering your saved work; your message is kept and runs when it's back.";
const WAIT_TEXT: Record<string, string> = {
  copyback_stop_unconfirmed: "Recovery of saved work is waiting for the previous server's file copy to stop. "
    + "Recovery resumes once Paperclip can confirm that it stopped. No provider turn is submitted.",
  agent_stop_unconfirmed: "Recovery of saved work is waiting to confirm that the previous run stopped. "
    + "Paperclip tries again automatically, and the agent will not repeat its work.",
};
/** What the chat shows for the run (shared workspaceRestoreStopWaitText; literal here). */
const chatWaitWords = (result: Record<string, unknown>) => WAIT_TEXT[String(result.workspaceRestoreStopWait)] ?? null;
// The bound the fallback promises (system-recovery.ts OWED_RESTORE_HOLD_RECHECK_MS), literal on purpose.
const OWED_RECHECK_BOUND_MS = 60_000;

// restore-card7: rf-3's last three open items on the restore card.
(recoveryPostgresSupport.supported ? describe : describe.skip)("restore-card7: the restore hold the person sees is true", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  async function base(options: { runStatus?: string; leaseStatus?: string; leasePolicy?: string } = {}) {
    if (!database) {
      database = await startRecoveryPostgres("restore-card7-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Card7", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Card7 worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Owed files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Card7 ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId,
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), status: options.runStatus ?? "failed",
      errorCode: "setup_failed", error: "The run stopped", finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { remoteWorkspace: reference }, resultJson: {} }).returning();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Owed remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId,
      environmentId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId,
      status: options.leaseStatus ?? "active", leasePolicy: options.leasePolicy ?? "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } }).returning();
    return { companyId, agentId, issueId, runId, leaseId, run: run!, lease: lease! };
  }
  /** The lease-backed owed hold, adopted by the worker. */
  async function owedHold() {
    const f = await base();
    expect(await preserveRemoteWorkspacePreparationFailure(db, f.lease)).not.toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    expect(action.evidence).toMatchObject({ runId: f.runId, workspaceRestorePending: true });
    const source = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: action.id };
    await adoptSystemRecovery(db, source);
    return { ...f, ...source };
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const currentRun = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  const holds = (companyId: string) => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
  const chatRunResult = async (f: { companyId: string; issueId: string; runId: string }) => {
    const runs = await activityService(db).runsForIssue(f.companyId, f.issueId, null, undefined, undefined,
      { skipLivenessBackfill: true });
    const run = runs.find(row => row.runId === f.runId);
    expect(run).toBeDefined();
    return (run!.resultJson ?? {}) as Record<string, unknown>;
  };

  // ITEM A (rf-3 ad0eabf3 F1): the producer pins files that are only owed, but
  // a released reusable LEGACY source is not retained (native-only / ephemeral-only),
  // so no lease-backed hold exists. The later reconcile terminalization reaches
  // the watchdog card in terminalizeLegacyExecution.
  async function owedUnretained() {
    const f = await base({ runStatus: "running", leaseStatus: "released", leasePolicy: "reuse_by_environment" });
    const owed = workspaceRestoreOnlyOwed(f.run);
    expect(owed).toBe(true);
    await recordRequiredWorkspaceRestoreFailure(db, f.run, { workspaceRestoreFailure: "restore_failed" }, undefined,
      { restorePending: owed });
    const pinned = await currentRun(f.runId);
    expect(pinned.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true });
    expect(pinned.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
    expect(await holds(f.companyId)).toEqual([]);
    return f;
  }

  it("ITEM A: a released reusable legacy source with files owed -> the card and chat say recovering", async () => {
    const f = await owedUnretained();
    // The terminal patch carries the adapter's ordinary result, no restore failure.
    await terminalizeLegacyExecution({ db, run: await currentRun(f.runId), status: "failed", fromStatuses: ["running"],
      reconcileIfNeeded: true, patch: { errorCode: "process_lost", resultJson: { stopReason: "process_lost" } } });
    const run = await currentRun(f.runId);
    expect(run.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true,
      stopReason: "process_lost" });
    const [action] = await holds(f.companyId);
    expect(action?.evidence).toMatchObject({ runId: f.runId, workspaceRestorePending: true });
    expect(action?.nextAction).toBe(RECOVERING_TEXT);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker!.nextAction).toContain("Recovering your saved work");
    expect(blocker!.nextAction).not.toContain("could not be put back");
    expect((await chatRunResult(f)).workspaceRestorePending).toBe(true);
  }, 120_000);

  it("ITEM A NEGATIVE: a recorded real failure keeps UNRESTORED + Retry", async () => {
    const f = await owedUnretained();
    // The adapter reports a real copy-back failure (no owed flag).
    await recordLegacyWorkspaceRestoreFailure(db, await currentRun(f.runId), { workspaceRestoreFailure: "restore_failed" });
    expect((await currentRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestorePending");
    await terminalizeLegacyExecution({ db, run: await currentRun(f.runId), status: "failed", fromStatuses: ["running"],
      reconcileIfNeeded: true, patch: { errorCode: "process_lost", resultJson: { stopReason: "process_lost", workspaceRestoreFailure: "restore_failed" } } });
    const [action] = await holds(f.companyId);
    expect(action?.evidence.workspaceRestorePending).toBeUndefined();
    expect(action?.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker!.nextAction).toContain("could not be put back");
    expect(blocker!.canRetry).toBe(true);
  }, 120_000);

  // ITEM B (rf-3 15:30Z (2)): the owed hold's wake was lost and the coordinator
  // went idle. The hold was written while its run was still finishing (the
  // restore-only record keeps the run's status); the run then ended without a
  // wake reaching the worker. The schedule must still bring the worker back.
  it("ITEM B: an owed hold with its wake lost and the coordinator idle is re-checked within the bound", async () => {
    const f = await owedHold();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    // Only this hold is on the schedule.
    await db.delete(issueRecoveryActions).where(ne(issueRecoveryActions.companyId, f.companyId));
    const before = Date.now();
    const next = await executionControlSchedule(db).workspaceRecovery();
    expect(next).not.toBeNull();
    expect(next!).toBeLessThanOrEqual(before + OWED_RECHECK_BOUND_MS + 5_000);
  }, 120_000);

  it("ITEM B NEGATIVE: a settled (exhausted) owed hold adds no re-check", async () => {
    const f = await owedHold();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(issueRecoveryActions).where(ne(issueRecoveryActions.companyId, f.companyId));
    const current = (await loadSystemRecovery(db, f))!;
    expect(await updateSystemRecovery(db, f, current, { ...current, revision: current.revision + 1, state: "exhausted",
      nextAttemptAt: null, failure: { code: "copyback_stop_unconfirmed", retryClass: "recheck_evidence", evidenceFingerprint: "x" } })).toBe(true);
    expect(await executionControlSchedule(db).workspaceRecovery()).toBeNull();
  }, 120_000);

  // ITEM C (rf-3 15:30Z (3)): an exhausted unconfirmed stop. Retry cannot release
  // it (the stop must be proven first), so card and chat both say waiting, no Retry.
  async function exhaustOnStop(f: Awaited<ReturnType<typeof owedHold>>, code: "copyback_stop_unconfirmed" | "agent_stop_unconfirmed") {
    const current = (await loadSystemRecovery(db, f))!;
    expect(await updateSystemRecovery(db, f, current, { ...current, revision: current.revision + 1, state: "exhausted",
      nextAttemptAt: null, failure: { code, retryClass: "recheck_evidence", evidenceFingerprint: "x" } })).toBe(true);
  }
  for (const code of ["copyback_stop_unconfirmed", "agent_stop_unconfirmed"] as const) {
    it(`ITEM C: exhausted ${code} -> card and chat show the same words and the same (no) Retry; the API agrees`, async () => {
      const f = await owedHold();
      await exhaustOnStop(f, code);
      const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
      const result = await chatRunResult(f);
      const chatWords = chatWaitWords(result);
      expect(chatWords).not.toBeNull();
      expect(blocker!.workspaceRecovery?.message).toBe(chatWords);
      expect(chatWords).toBe(WAIT_TEXT[code]);
      expect(blocker!.canRetry).toBe(false);
      expect(blocker!.workspaceRecovery?.canRetry).toBe(false);
      // The chat's Retry rule (TaskChatThread: retryable = !marker.pending) reads
      // this as waiting; ui/src/lib/workspace-restore-marker.test.ts pins that.
      expect(result).not.toHaveProperty("workspaceRestorePending");
      const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "user-1",
        actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
      expect(retry).toMatchObject({ accepted: false });
    }, 120_000);
  }

  it("ITEM C NEGATIVE: agent stop with every re-arm spent is not a wait", async () => {
    const f = await owedHold();
    await exhaustOnStop(f, "agent_stop_unconfirmed");
    await db.update(issueRecoveryActions).set({ evidence: { ...(await holds(f.companyId))[0].evidence,
      stopProofRecovery: { schema: STOP_PROOF_RECOVERY_SCHEMA, rearms: STOP_PROOF_MAX_REARMS } } })
      .where(and(eq(issueRecoveryActions.id, f.actionId)));
    expect(chatWaitWords(await chatRunResult(f))).toBeNull();
  }, 120_000);

  // fam-retry STEP 2: card7's exhausted stop wait and the fold's
  // retryRefusedBeforeAdmission are ONE decision. The API (a new click and a
  // repeat of an unrun click), the chat's pre-admission check and the card all
  // read the same authority and say card7's words.
  for (const code of ["copyback_stop_unconfirmed", "agent_stop_unconfirmed"] as const) {
    it(`ONE DECISION: exhausted ${code} -> API, repeat, chat check and card refuse with card7's words`, async () => {
      const f = await owedHold();
      const repeatKey = randomUUID();
      // An earlier click that never got a run (its idempotent repeat comes later).
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
        triggerDetail: "manual", reason: "task_retry", status: "deferred_issue_execution",
        idempotencyKey: `task-retry:${repeatKey}`, requestedByActorType: "user", requestedByActorId: "user-1",
        payload: { issueId: f.issueId, taskRetry: { schema: "paperclip.task-retry.v1", generationId: randomUUID(),
          sourceRunId: f.runId, actorId: "user-1", actorSource: "local_implicit", strategy: "evaluate" } } });
      await exhaustOnStop(f, code);
      const words = WAIT_TEXT[code];
      const input = { db, companyId: f.companyId, issueId: f.issueId, actorId: "user-1",
        actorSource: "local_implicit" as const, observedRunId: f.runId };
      const refused = { reason: "workspace_restore_stop_wait", message: words };
      expect(await requestTaskRetry({ ...input, idempotencyKey: randomUUID() }))
        .toMatchObject({ accepted: false, waitingOnStop: true, refused });
      expect(await requestTaskRetry({ ...input, idempotencyKey: repeatKey }))
        .toMatchObject({ accepted: false, waitingOnStop: true, refused });
      // The chat Retry's pre-admission check is the same function.
      expect(await retryRefusedBeforeAdmission(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId }))
        .toMatchObject({ canRetry: false, userAction: "wait", reason: "workspace_restore_stop_wait", cardText: words });
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const card = await taskInterruptionPresentation(db, issue!);
      expect(card?.canRetry).toBe(false);
      expect(card?.retryWait?.message).toBe(words);
      // No wake was queued by either click.
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(wakes).toHaveLength(1);
    }, 120_000);
  }

  it("ONE DECISION NEGATIVE: agent stop with every re-arm spent is not the stop-wait refusal", async () => {
    const f = await owedHold();
    await exhaustOnStop(f, "agent_stop_unconfirmed");
    await db.update(issueRecoveryActions).set({ evidence: { ...(await holds(f.companyId))[0].evidence,
      stopProofRecovery: { schema: STOP_PROOF_RECOVERY_SCHEMA, rearms: STOP_PROOF_MAX_REARMS } } })
      .where(and(eq(issueRecoveryActions.id, f.actionId)));
    const authority = await retryRefusedBeforeAdmission(db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId });
    expect(authority?.reason).not.toBe("workspace_restore_stop_wait");
  }, 120_000);
});
