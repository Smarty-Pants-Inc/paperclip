import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { adoptSystemRecovery, loadSystemRecovery, updateSystemRecovery } from "./system-recovery.js";
import { activityService } from "./activity.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { requestTaskRetry } from "./task-retry.js";
import { adoptHistoricalWorkspaceRecoveries } from "./workspace-recovery-backfill.js";
import { unadoptedWorkspaceRecoveryCondition } from "./system-recovery.js";
import { vi } from "vitest";

// An adoption that throws every time (ITEM 2), toggled per test.
const adoptionFault = vi.hoisted(() => ({ on: false }));
vi.mock("./system-recovery.js", async (original) => {
  const actual = await original<typeof import("./system-recovery.js")>();
  return { ...actual, adoptSystemRecovery: (...args: Parameters<typeof actual.adoptSystemRecovery>) =>
    adoptionFault.on ? Promise.reject(new Error("adoption broke")) : actual.adoptSystemRecovery(...args) };
});

// restore-card6 (RFL 15:09Z): the PERSON's card for an owed hold turns into a
// true actionable state within WORKSPACE_RESTORE_PERSON_BOUND_MS (60 min) of the
// hold being written, whatever the worker keeps doing; the files stay kept.
// (Base comment from restore-card4 follows.)
// restore-card4: an owed run ("Recovering saved work", no Retry) must end in a
// true outcome. The label the chat reads follows the hold the recovery worker
// records (updateSystemRecovery): exhausted/blocked -> failed words + Retry
// eligible; complete/recovered -> recovered, no failure words; in progress ->
// still recovering, no Retry. Literal keys on purpose: these are the words and
// keys the UI reads.
(recoveryPostgresSupport.supported ? describe : describe.skip)("restore-card6: the person bound on an owed hold", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  async function seedOwed(adopt = true) {
    if (!database) {
      database = await startRecoveryPostgres("restore-card6-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owed end", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owed worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Owed files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Owed ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId,
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), status: "failed",
      errorCode: "setup_failed", error: "The run stopped", finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { remoteWorkspace: reference }, resultJson: {} });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Owed remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId,
      environmentId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } }).returning();
    // The real producer: files are pinned before any restore was tried (owed).
    expect(await preserveRemoteWorkspacePreparationFailure(db, lease!)).not.toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(action.evidence).toMatchObject({ runId, workspaceRestorePending: true });
    const source = { companyId, issueId, runId, actionId: action.id };
    // The recovery worker's first step on the hold (recoverRetainedWorkspace).
    if (adopt) await adoptSystemRecovery(db, source);
    return { ...source, leaseId };
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const chatRunResult = async (f: { companyId: string; issueId: string; runId: string }) => {
    const runs = await activityService(db).runsForIssue(f.companyId, f.issueId, null, undefined, undefined,
      { skipLivenessBackfill: true });
    const run = runs.find(row => row.runId === f.runId);
    expect(run).toBeDefined();
    return (run!.resultJson ?? {}) as Record<string, unknown>;
  };
  const advanceRunning = async (f: Awaited<ReturnType<typeof seedOwed>>) => {
    const current = (await loadSystemRecovery(db, f))!;
    expect(await updateSystemRecovery(db, f, current, { ...current, revision: current.revision + 1, state: "running",
      phase: "preserve_files", nextAttemptAt: null })).toBe(true);
  };
  // The clock advanced past the bound: the hold was written 61 minutes ago.
  const ageHold = (f: { actionId: string }, minutes: number) => db.update(issueRecoveryActions)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) }).where(eq(issueRecoveryActions.id, f.actionId));
  const hold = async (f: { actionId: string }) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId)))[0];

  it("ITEM 1: an owed hold still in progress past 60 min reads delayed with a Retry the server accepts; files kept", async () => {
    const f = await seedOwed();
    await advanceRunning(f);
    await ageHold(f, 61);
    const result = await chatRunResult(f);
    expect(result).not.toHaveProperty("workspaceRestorePending");
    expect(result.workspaceRestoreDelayed).toBe(true);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.canRetry).toBe(true);
    expect(blocker?.nextAction).toContain("Recovering your saved work is taking longer than expected.");
    const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "user-1",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    expect(retry).toMatchObject({ accepted: true, stale: false });
    // The kept files: the hold still protects them and the source stays retained.
    const after = await hold(f);
    expect(after.evidence).toMatchObject({ runId: f.runId, workspaceRestorePending: true,
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1" } });
    expect((after.evidence as Record<string, any>).systemRecovery.state).not.toBe("complete");
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease.leasePolicy).toBe("retain_on_failure");
  }, 120_000);

  it("ITEM 1 NEGATIVE: under 60 min the hold stays recovering with no Retry", async () => {
    const f = await seedOwed();
    await advanceRunning(f);
    await ageHold(f, 59);
    const result = await chatRunResult(f);
    expect(result.workspaceRestorePending).toBe(true);
    expect(result).not.toHaveProperty("workspaceRestoreDelayed");
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.canRetry).toBe(false);
  }, 120_000);

  it("ITEM 2: an adoption that throws 5 times is exhausted with a recorded cause; due-now stops; card failed + Retry", async () => {
    const f = await seedOwed(false);
    adoptionFault.on = true;
    try {
      for (let i = 0; i < 5; i++) await adoptHistoricalWorkspaceRecoveries(db).catch(() => undefined);
    } finally { adoptionFault.on = false; }
    const after = await hold(f);
    expect(after.evidence).toMatchObject({ systemRecoveryAdoptionFailures: 5,
      systemRecovery: { state: "exhausted", failure: { cause: { label: "adoption_failed" } } },
      workspaceRecovery: { status: "blocked", retryable: true }, workspaceRestorePending: true });
    // Due-now stops: the row has left the unadopted set nextWorkspaceRecoveryAt reads.
    expect(await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, f.actionId), unadoptedWorkspaceRecoveryCondition()))).toEqual([]);
    const result = await chatRunResult(f);
    expect(result).not.toHaveProperty("workspaceRestorePending");
    expect(result).not.toHaveProperty("workspaceRestoreDelayed");
  }, 120_000);
});
