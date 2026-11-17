import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { recordLegacyWorkspaceRestoreFailure, recordRequiredWorkspaceRestoreFailure, terminalizeLegacyExecution,
  UNRESTORED_FILES_NEXT_ACTION, workspaceRestoreOnlyOwed } from "./legacy-execution-recovery.js";
import { getExecutionBlocker } from "./execution-blocker.js";


// Literal on purpose: the words the person reads while files are only owed.
const RECOVERING_TEXT = "Recovering your saved work; your message is kept and runs when it's back.";

// restore-card5 (rf-3 F1): an ordinary later terminalization of a lease-backed
// owed hold must keep the owed fact on BOTH the run and the hold; only a
// recorded real restore failure clears it (on both, in one transaction).
(recoveryPostgresSupport.supported ? describe : describe.skip)("owed hold survives ordinary re-terminalization", () => {
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
  const currentRun = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  const owedPinned = async () => {
    const f = await seed();
    await recordRequiredWorkspaceRestoreFailure(db, f.run, { workspaceRestoreFailure: "restore_failed" }, f.lease,
      { restorePending: true });
    expect((await currentRun(f.runId)).resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
      workspaceRestorePending: true, workspaceRestoreRecovery: { leaseIds: [f.leaseId] } });
    const action = await hold(f.companyId);
    expect(action.evidence.workspaceRestorePending).toBe(true);
    expect(action.nextAction).toBe(RECOVERING_TEXT);
    return f;
  };
  const expectOwed = async (f: Awaited<ReturnType<typeof seed>>) => {
    expect((await currentRun(f.runId)).resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
      workspaceRestorePending: true });
    const action = await hold(f.companyId);
    expect(action.evidence).toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true });
    expect(action.nextAction).toBe(RECOVERING_TEXT);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker!.nextAction).toContain("Recovering your saved work");
    expect(blocker!.nextAction).not.toContain("could not be put back");
  };

  it("RETERMINALIZE: ordinary terminalization keeps the run and hold owed (recovering words)", async () => {
    const f = await owedPinned();
    const before = await currentRun(f.runId);
    await terminalizeLegacyExecution({ db, run: before, status: "failed" });
    await expectOwed(f);
  }, 120_000);

  it("REPEAT PRODUCER: a producer re-pinning a run that is already owed keeps it owed", async () => {
    const f = await owedPinned();
    const before = await currentRun(f.runId);
    // The producers' own owed marker is not an adapter-reported real failure.
    expect(workspaceRestoreOnlyOwed(before)).toBe(true);
    await terminalizeLegacyExecution({ db, run: before, status: "failed" });
    const again = await currentRun(f.runId);
    await recordRequiredWorkspaceRestoreFailure(db, again, { workspaceRestoreFailure: "restore_failed" }, f.lease,
      { restorePending: workspaceRestoreOnlyOwed(again) });
    await expectOwed(f);
  }, 120_000);

  it("NEGATIVE: an adapter-reported failure after re-terminalization clears run and hold (Retry words)", async () => {
    const f = await owedPinned();
    await terminalizeLegacyExecution({ db, run: await currentRun(f.runId), status: "failed" });
    await recordLegacyWorkspaceRestoreFailure(db, await currentRun(f.runId), { workspaceRestoreFailure: "restore_failed" }, f.lease);
    const run = await currentRun(f.runId);
    expect(run.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed" });
    expect(run.resultJson).not.toHaveProperty("workspaceRestorePending");
    expect(workspaceRestoreOnlyOwed(run)).toBe(false);
    const action = await hold(f.companyId);
    expect(action.evidence.workspaceRestorePending).toBeUndefined();
    expect(action.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).toContain("could not be put back");
    // A later ordinary terminalization does not resurrect the owed fact.
    await terminalizeLegacyExecution({ db, run, status: "failed" });
    expect((await currentRun(f.runId)).resultJson).not.toHaveProperty("workspaceRestorePending");
    expect((await hold(f.companyId)).nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
  }, 120_000);
});
