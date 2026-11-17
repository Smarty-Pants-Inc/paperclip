import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { adoptSystemRecovery, loadSystemRecovery, updateSystemRecovery } from "./system-recovery.js";
import { activityService } from "./activity.js";

// restore-card4: an owed run ("Recovering saved work", no Retry) must end in a
// true outcome. The label the chat reads follows the hold the recovery worker
// records (updateSystemRecovery): exhausted/blocked -> failed words + Retry
// eligible; complete/recovered -> recovered, no failure words; in progress ->
// still recovering, no Retry. Literal keys on purpose: these are the words and
// keys the UI reads.
(recoveryPostgresSupport.supported ? describe : describe.skip)("an owed run's chat label follows its hold's end", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  async function seedOwed() {
    if (!database) {
      database = await startRecoveryPostgres("restore-card-terminal-");
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
    await adoptSystemRecovery(db, source);
    return source;
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  // What TaskChatThread reads: the issue's linked runs.
  const chatRunResult = async (f: { companyId: string; issueId: string; runId: string }) => {
    const runs = await activityService(db).runsForIssue(f.companyId, f.issueId, null, undefined, undefined,
      { skipLivenessBackfill: true });
    const run = runs.find(row => row.runId === f.runId);
    expect(run).toBeDefined();
    return (run!.resultJson ?? {}) as Record<string, unknown>;
  };
  const storedRun = async (runId: string) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].resultJson;
  const advance = async (f: Awaited<ReturnType<typeof seedOwed>>, state: "running" | "exhausted" | "complete") => {
    const current = (await loadSystemRecovery(db, f))!;
    expect(await updateSystemRecovery(db, f, current, { ...current, revision: current.revision + 1, state,
      phase: state === "complete" ? "reconcile_effects" : "preserve_files", nextAttemptAt: null })).toBe(true);
  };

  it("(1) the worker records the hold exhausted: the chat no longer says recovering; failed + Retry eligible", async () => {
    const f = await seedOwed();
    await advance(f, "exhausted");
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action.evidence).toMatchObject({ systemRecovery: { state: "exhausted" }, workspaceRecovery: { status: "blocked" } });
    const result = await chatRunResult(f);
    expect(result.workspaceRestoreFailure).toBe("restore_failed");
    // Not pending: TaskChatThread labels it "Workspace restore failed" with
    // Retry (retryable = !pending && not unsafe/invalid metadata).
    expect(result).not.toHaveProperty("workspaceRestorePending");
    expect(result).not.toHaveProperty("workspaceRestoreRecovered");
    // The stored run values are untouched (no worker or marker change).
    expect(await storedRun(f.runId)).toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true });
  }, 120_000);

  it("(2) the worker recovers the files: the chat says recovered, not recovering and not failed", async () => {
    const f = await seedOwed();
    await advance(f, "complete");
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action.evidence).toMatchObject({ workspaceRecovery: { status: "recovered" } });
    const result = await chatRunResult(f);
    expect(result.workspaceRestoreFailure).toBe("restore_failed");
    expect(result).not.toHaveProperty("workspaceRestorePending");
    expect(result.workspaceRestoreRecovered).toBe(true);
  }, 120_000);

  it("NEGATIVE (3): a hold still in progress keeps recovering with no Retry", async () => {
    const f = await seedOwed();
    expect(await chatRunResult(f)).toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true });
    await advance(f, "running");
    const result = await chatRunResult(f);
    expect(result).toMatchObject({ workspaceRestoreFailure: "restore_failed", workspaceRestorePending: true });
    expect(result).not.toHaveProperty("workspaceRestoreRecovered");
  }, 120_000);
});
