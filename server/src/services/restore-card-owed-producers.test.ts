import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { allowLegacyShutdownWorkspaceCleanup } from "./legacy-shutdown-workspace-settlement.js";
import { recordLegacyWorkspaceRestoreFailure, recordRequiredWorkspaceRestoreFailure, terminalizeLegacyExecution,
  UNRESTORED_FILES_NEXT_ACTION } from "./legacy-execution-recovery.js";
import { getExecutionBlocker } from "./execution-blocker.js";

// Literal on purpose: the words the person reads while files are only owed.
const RECOVERING_TEXT = "Recovering your saved work; your message is kept and runs when it's back.";

// restore-card2: every producer that pins files which are only OWED (no restore
// was tried) must go through the one authority (workspaceRestoreHoldNextAction).
// Only a recorded restore/copy-back failure keeps "could not be put back ... Retry".
// The hold, its predicates and the run's resultJson stay exactly as before.
(recoveryPostgresSupport.supported ? describe : describe.skip)("owed files read as recovering at every producer", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const fixtures = new Set<string>();
  async function seed(options: { resultJson?: Record<string, unknown>; shutdownMarker?: boolean; lease?: boolean; status?: string } = {}) {
    if (!database) {
      database = await startRecoveryPostgres("restore-card-owed-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    fixtures.add(runId);
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owed card", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owed worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Owed files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Owed ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId,
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), status: options.status ?? "failed",
      errorCode: "setup_failed", error: "The run stopped", finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { remoteWorkspace: reference },
      resultJson: options.resultJson ?? {},
    }).returning();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Owed remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    const marker = options.shutdownMarker ? { legacyShutdownWorkspaceSettlement: {
      schema: "paperclip.legacy-shutdown-workspace-settlement.v1", state: "pending", runId,
      controllerBootId: randomUUID(), deadlineAt: new Date(Date.now() - 60_000).toISOString() } } : {};
    const [lease] = options.lease === false ? [undefined] : await db.insert(environmentLeases).values({ id: leaseId, companyId,
      environmentId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work", ...marker } }).returning();
    return { companyId, agentId, issueId, runId, leaseId, run, lease: lease! };
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(async () => {
    if (fixtures.size) await db.update(heartbeatRuns).set({ status: "failed" }).where(inArray(heartbeatRuns.id, [...fixtures]));
    fixtures.clear();
  });

  const hold = async (companyId: string) => {
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  const runResult = async (runId: string) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].resultJson;
  // Every predicate the card and the dispatch gate read, without the words.
  const holdShape = async (companyId: string, issueId: string) => {
    const blocker = await getExecutionBlocker(db, companyId, issueId);
    return { cause: blocker?.cause, canRetry: blocker?.canRetry, canContinue: blocker?.canContinue,
      workspaceRepairRequired: blocker?.workspaceRepairRequired, canRecordWorkspaceRepair: blocker?.canRecordWorkspaceRepair };
  };
  const LEGACY_SHAPE = { cause: "legacy_execution_requires_reconciliation", canRetry: false, canContinue: false,
    workspaceRepairRequired: true, canRecordWorkspaceRepair: true };
  const HOLD_KEYS = ["automaticRecovery", "continuationDelivery", "originalFailureCode", "runId",
    "workspaceRestoreFailure", "workspaceRestoreRecovery"];
  const evidenceKeys = (evidence: Record<string, unknown>) =>
    Object.keys(evidence).filter(key => evidence[key] !== undefined && key !== "workspaceRestorePending").sort();
  const expectOwedHold = async (f: Awaited<ReturnType<typeof seed>>, pending = false) => {
    // Run row: today's marker unchanged (DB index keys on it); restore-card3
    // adds only the sibling owed fact, set with the hold, absent for a failure.
    expect(await runResult(f.runId)).toEqual({ workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] },
      ...(pending ? { workspaceRestorePending: true } : {}) });
    const action = await hold(f.companyId);
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked", cause: "legacy_execution_requires_reconciliation",
      evidence: { runId: f.runId, workspaceRestoreFailure: "restore_failed", automaticRecovery: { replay: "blocked" } } });
    expect(evidenceKeys(action.evidence)).toEqual(HOLD_KEYS);
    expect(await holdShape(f.companyId, f.issueId)).toEqual(LEGACY_SHAPE);
    return action;
  };

  it("(2) a legacy prepared remote workspace after a failure (files owed) says recovering", async () => {
    const f = await seed();
    expect(await preserveRemoteWorkspacePreparationFailure(db, f.lease)).not.toBeNull();
    const action = await expectOwedHold(f, true);
    expect(action.evidence.workspaceRestorePending).toBe(true);
    expect(action.nextAction).toBe(RECOVERING_TEXT);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).not.toContain("could not be put back");
  }, 120_000);

  it("(3) a legacy shutdown whose export deadline passed (files owed) says recovering", async () => {
    const f = await seed({ status: "interrupted", shutdownMarker: true });
    expect(await allowLegacyShutdownWorkspaceCleanup(db, f.lease)).toBe(true);
    const action = await expectOwedHold(f, true);
    expect(action.evidence.workspaceRestorePending).toBe(true);
    expect(action.nextAction).toBe(RECOVERING_TEXT);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).not.toContain("could not be put back");
  }, 120_000);

  it("NEGATIVE (3): a copy-back failure the adapter already recorded keeps the Retry words at shutdown", async () => {
    const f = await seed({ status: "interrupted", shutdownMarker: true, resultJson: { workspaceRestoreFailure: "restore_failed" } });
    expect(await allowLegacyShutdownWorkspaceCleanup(db, f.lease)).toBe(true);
    const action = await expectOwedHold(f);
    expect(action.evidence).not.toHaveProperty("workspaceRestorePending");
    expect(action.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
  }, 120_000);

  it("NEGATIVE (2): a copy-back failure the adapter already recorded keeps the Retry words", async () => {
    const f = await seed({ resultJson: { workspaceRestoreFailure: "restore_failed" } });
    expect(await preserveRemoteWorkspacePreparationFailure(db, f.lease)).not.toBeNull();
    const action = await expectOwedHold(f);
    expect(action.evidence).not.toHaveProperty("workspaceRestorePending");
    expect(action.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
  }, 120_000);

  it("NEGATIVE: the adapter's reported restore failure keeps the Retry words", async () => {
    const f = await seed();
    await recordLegacyWorkspaceRestoreFailure(db, f.run, { workspaceRestoreFailure: "restore_failed" }, f.lease);
    const action = await expectOwedHold(f);
    expect(action.evidence).not.toHaveProperty("workspaceRestorePending");
    expect(action.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
  }, 120_000);

  it("NEGATIVE (4): upsertSourceScoped for an adapter-reported real failure keeps the Retry words", async () => {
    const f = await seed({ status: "running", lease: false });
    await terminalizeLegacyExecution({ db, run: f.run, status: "failed",
      patch: { resultJson: { workspaceRestoreFailure: "restore_failed" } } });
    const action = await hold(f.companyId);
    expect(action.cause).toBe("legacy_execution_requires_reconciliation");
    expect(action.evidence).toMatchObject({ workspaceRestoreFailure: "restore_failed" });
    expect(action.evidence).not.toHaveProperty("workspaceRestorePending");
    expect(action.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
  }, 120_000);
  // restore-card3 (B): the legacy reconciliation card (upsertSourceScoped) reads
  // the owed fact the hold authority recorded, not the raw failure marker.
  it("(B) the reconciliation card for owed files says recovering", async () => {
    const f = await seed({ status: "running", lease: false });
    await recordRequiredWorkspaceRestoreFailure(db, f.run, { workspaceRestoreFailure: "restore_failed" }, undefined,
      { restorePending: true });
    const [owed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(owed.resultJson).toEqual({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true });
    await terminalizeLegacyExecution({ db, run: owed, status: "failed" });
    const action = await hold(f.companyId);
    expect(action.cause).toBe("legacy_execution_requires_reconciliation");
    expect(action.evidence).toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true });
    expect(action.nextAction).toBe(RECOVERING_TEXT);
  }, 120_000);

  // restore-card3 (C): the run's owed fact is written with the hold and cleared
  // when a real copy-back failure is recorded; the hold then ends failed + Retry.
  it("(C) a pending hold that later really fails ends failed with the Retry words", async () => {
    const f = await seed();
    expect(await preserveRemoteWorkspacePreparationFailure(db, f.lease)).not.toBeNull();
    const pending = await expectOwedHold(f, true);
    expect(pending.nextAction).toBe(RECOVERING_TEXT);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await recordLegacyWorkspaceRestoreFailure(db, run, { workspaceRestoreFailure: "restore_failed" }, f.lease);
    const action = await expectOwedHold(f, false);
    expect(action.evidence).not.toHaveProperty("workspaceRestorePending");
    expect(action.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
    expect(action.nextAction).toContain("Press Retry");
    // The blocker shows the same failure words; execution-blocker (unchanged)
    // only swaps the Retry sentence while the legacy hold disables Retry.
    const blocker = (await getExecutionBlocker(db, f.companyId, f.issueId))!;
    expect(blocker.nextAction).toContain("could not be put back");
    expect(blocker.nextAction).not.toContain("Recovering");
  }, 120_000);
});
