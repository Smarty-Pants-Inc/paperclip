import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { preserveCancelledNativeWorkspaces } from "./native-failed-workspace-recovery.js";
import { recordRequiredWorkspaceRestoreFailure, UNRESTORED_FILES_NEXT_ACTION } from "../legacy-execution-recovery.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { requestWorkspaceRecovery } from "../workspace-recovery.js";

// The person-facing text for files that are still owed (no restore was tried).
// Kept literal here so the test reads the same words the person sees.
const RECOVERING_TEXT = "Recovering your saved work; your message is kept and runs when it's back.";

// Gate 3, S1 +30 s case 3: after a person's Stop the card said the saved files
// "could not be put back" although no restore had been tried. The hold, its
// predicates and the recovery worker are unchanged; only the stored words follow
// the recorded state: owed files read as recovering, a recorded failure keeps
// the "could not be put back ... Retry" words.
(recoveryPostgresSupport.supported ? describe : describe.skip)("restore card text follows the recorded restore state", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const fixtures = new Set<string>();
  async function seed() {
    if (!database) {
      database = await startRecoveryPostgres("stopped-restore-card-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    fixtures.add(runId);
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped card", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stop then send", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Card ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    // A person's Stop (not warm: the sandbox is destroyed, the lease is ephemeral).
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId,
      scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: false,
      intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), acknowledgedAt: new Date().toISOString(),
      effects: ["release_run_resources"] };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", runtimeModeResolvedAt: new Date(), nativePhase: "observed", status: "cancelled",
      errorCode: "cancelled", error: "Stopped by the person", finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { remoteWorkspace: reference, nativeResourceDisposition: "destroy" },
      resultJson: { nativeCancellation, cancelledByActorType: "user", cancelledByUserId: "person",
        startupCancellation: { beforeNativeSelection: false } },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_continuation_requires_reconciliation", recoveryState: "blocked" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Owed remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } }).returning();
    return { companyId, agentId, issueId, runId, leaseId, run, lease };
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
  // Every hold predicate the card and the dispatch gate read, without the words.
  const holdShape = (blocker: Awaited<ReturnType<typeof getExecutionBlocker>>) => ({
    cause: blocker?.cause, canRetry: blocker?.canRetry, canContinue: blocker?.canContinue,
    workspaceRepairRequired: blocker?.workspaceRepairRequired, canRecordWorkspaceRepair: blocker?.canRecordWorkspaceRepair,
  });

  it("(a) a Stop whose files are only owed says recovering, not 'could not be put back'", async () => {
    const f = await seed();
    await preserveCancelledNativeWorkspaces(db);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    // The hold marker on the run is exactly today's: the same value every reader keys on.
    expect(run.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] } });
    const action = await hold(f.companyId);
    expect(action).toMatchObject({ status: "resolved", outcome: "blocked", cause: "native_continuation_requires_reconciliation",
      evidence: { runId: f.runId, workspaceRestoreFailure: "restore_failed", automaticRecovery: { replay: "blocked" } } });
    expect(action.nextAction).toBe(RECOVERING_TEXT);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).not.toBeNull();
    expect(blocker!.nextAction).toBe(RECOVERING_TEXT);
    expect(blocker!.nextAction).not.toContain("could not be put back");
    expect(holdShape(blocker)).toEqual({ cause: "native_continuation_requires_reconciliation", canRetry: false,
      canContinue: false, workspaceRepairRequired: true, canRecordWorkspaceRepair: true });
  }, 120_000);

  // retry-fold5 (RESTORE HOLD): the card reads restore-card's words through the
  // one Retry authority (decideRetryAuthority delegates to
  // workspaceRestoreHoldNextAction); no second mapping says something else.
  it("(a2) retry-fold5: the card for a restore hold whose files are only owed says the hold's own words, offers no Retry", async () => {
    const f = await seed();
    await preserveCancelledNativeWorkspaces(db);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const card = await taskInterruptionPresentation(db, issue!);
    expect(card?.canRetry).toBe(false);
    expect(card?.retryWait?.message).toBe(RECOVERING_TEXT);
    expect(JSON.stringify(card)).not.toContain("could not be put back");
  }, 120_000);

  it("(b) a recorded restore failure keeps the 'could not be put back ... Retry' words and the same hold", async () => {
    const f = await seed();
    await recordRequiredWorkspaceRestoreFailure(db, f.run, { workspaceRestoreFailure: "restore_failed" }, f.lease);
    const action = await hold(f.companyId);
    expect(action.nextAction).toBe(UNRESTORED_FILES_NEXT_ACTION);
    expect(action.nextAction).toContain("could not be put back");
    expect(action.evidence).not.toHaveProperty("workspaceRestorePending");
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker!.nextAction).toContain("could not be put back");
    expect(holdShape(blocker)).toEqual({ cause: "native_continuation_requires_reconciliation", canRetry: false,
      canContinue: false, workspaceRepairRequired: true, canRecordWorkspaceRepair: true });
  }, 120_000);

  it("(c) a non-warm Stop with owed files says recovering, then the recovery worker owns the card as today", async () => {
    const f = await seed();
    await preserveCancelledNativeWorkspaces(db);
    const action = await hold(f.companyId);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))!.nextAction).toBe(RECOVERING_TEXT);
    expect(await requestWorkspaceRecovery({ db, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      actionId: action.id, idempotencyKey: randomUUID(), actorId: "person" })).toMatchObject({ actionId: action.id, status: "queued" });
    const queued = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(queued).toMatchObject({ nextAction: "Recovering saved work…", workspaceRecovery: { status: "queued" } });
    // Recovery completed: the worker's recorded state, not the stored words, decides the card.
    const [current] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    const recovery = current.evidence.workspaceRecovery as Record<string, unknown>;
    await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence,
      workspaceRecovery: { ...recovery, status: "recovered", stage: "saving_receipts" } } }).where(eq(issueRecoveryActions.id, action.id));
    const recovered = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(recovered?.workspaceRecovery).toMatchObject({ status: "recovered" });
    expect(recovered!.nextAction).not.toContain("could not be put back");
    expect(recovered!.nextAction).not.toBe(RECOVERING_TEXT);
  }, 120_000);
});
