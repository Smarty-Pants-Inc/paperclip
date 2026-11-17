import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues, subscribeDatabaseWork } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { allowLegacyShutdownWorkspaceCleanup } from "./legacy-shutdown-workspace-settlement.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { adoptHistoricalWorkspaceRecoveries } from "./workspace-recovery-backfill.js";
import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SYSTEM_RECOVERY_WINDOW_MS,
  SystemRecoveryFailure } from "./system-recovery-state.js";

// restore-bound: an owed restore hold reaches a bounded true outcome. Every
// producer wakes the workspace-recovery worker in the hold's transaction, the
// worker's schedule sees a hold it has not adopted yet, and an attempt that
// never reports still ends at the existing recovery window.
(recoveryPostgresSupport.supported ? describe : describe.skip)("an owed restore hold is always scheduled", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  async function seed(options: { shutdownMarker?: boolean; status?: string } = {}) {
    if (!database) {
      database = await startRecoveryPostgres("restore-bound-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Bound", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Bound worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Owed files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Bound ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId,
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), status: options.status ?? "failed",
      errorCode: "setup_failed", error: "The run stopped", finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { remoteWorkspace: reference }, resultJson: {},
    });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Owed remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    const marker = options.shutdownMarker ? { legacyShutdownWorkspaceSettlement: {
      schema: "paperclip.legacy-shutdown-workspace-settlement.v1", state: "pending", runId,
      controllerBootId: randomUUID(), deadlineAt: new Date(Date.now() - 60_000).toISOString() } } : {};
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId,
      environmentId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work", ...marker } }).returning();
    return { companyId, runId, lease };
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const producers = [
    ["finalization-state (prepared remote workspace)", async () => {
      const f = await seed();
      expect(await preserveRemoteWorkspacePreparationFailure(db, f.lease)).not.toBeNull();
      return f;
    }],
    ["legacy shutdown settlement", async () => {
      const f = await seed({ status: "interrupted", shutdownMarker: true });
      expect(await allowLegacyShutdownWorkspaceCleanup(db, f.lease)).toBe(true);
      return f;
    }],
  ] as const;

  for (const [name, produce] of producers) {
    it(`(i)+(ii) ${name}: the hold write wakes workspace recovery and the schedule sees it`, async () => {
      if (!db) { database = await startRecoveryPostgres("restore-bound-"); db = createDb(database.connectionString); }
      // Only this test's hold is on the schedule.
      await db.delete(issueRecoveryActions);
      expect(await nextWorkspaceRecoveryAt(db)).toBeNull();
      const events: string[] = [];
      const stop = subscribeDatabaseWork(db, DELIVERY_QUEUES.workspaceRecovery, event => { events.push(event); });
      let f: Awaited<ReturnType<typeof seed>>;
      try { f = await produce(); } finally { stop(); }
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect(action).toMatchObject({ status: "resolved", outcome: "blocked" });
      expect(action.evidence).not.toHaveProperty("systemRecovery");
      // (i) committed in the hold's own transaction.
      expect(events).toContain("settled");
      // (ii) a lost wake still leaves the hold due now on the worker's schedule.
      const due = await nextWorkspaceRecoveryAt(db);
      expect(due).not.toBeNull();
      expect(due!).toBeLessThanOrEqual(Date.now());
      // The worker's first step adopts it, so the "due now" answer is spent once.
      await adoptHistoricalWorkspaceRecoveries(db);
      const [adopted] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(adopted.evidence.systemRecovery).toMatchObject({ state: "scheduled", sourceRunId: f.runId });
    }, 120_000);
  }
});

describe("a recovery attempt that never reports is bounded by the window", () => {
  it("(iii) a reclaimed attempt past the window is not reserved again, so the worker exhausts it", () => {
    const t0 = 1_000_000;
    const running = reserveSystemRecoveryAttempt(createSystemRecovery(randomUUID()), t0)!;
    expect(running.state).toBe("running");
    // Owner lost and reclaimed inside the window: same attempt, still running.
    const reclaimed = reserveSystemRecoveryAttempt(running, t0 + 60_000);
    expect(reclaimed).toMatchObject({ state: "running", attemptId: running.attemptId });
    // Never reported, time past the window: no further reclaim. The caller
    // (workspace-recovery.ts runAttempt) then writes exhausted because deadlineAt passed.
    expect(reserveSystemRecoveryAttempt(reclaimed!, t0 + SYSTEM_RECOVERY_WINDOW_MS + 1)).toBeNull();
    expect(reclaimed!.deadlineAt).not.toBeNull();
    expect(t0 + SYSTEM_RECOVERY_WINDOW_MS + 1 >= reclaimed!.deadlineAt!).toBe(true);
  });

  it("NEGATIVE: a failing attempt keeps the base schedule (nextAttemptAt and deadline from its first failure)", () => {
    const state = createSystemRecovery("00000000-0000-4000-8000-000000000001");
    const fixed = { ...state, generationId: "00000000-0000-4000-8000-000000000002" };
    const t0 = 5_000_000, failedAt = t0 + 10 * 60_000;
    const failed = failSystemRecovery(reserveSystemRecoveryAttempt(fixed, t0)!,
      new SystemRecoveryFailure("export_interrupted", "retry_transient"), { now: failedAt });
    expect(failed.firstFailureAt).toBe(failedAt);
    expect(failed.deadlineAt).toBe(failedAt + SYSTEM_RECOVERY_WINDOW_MS);
    expect(failed.state).toBe("scheduled");
    const nextAt = failed.nextAttemptAt!;
    expect(nextAt - failedAt).toBeGreaterThanOrEqual(24_000);
    expect(nextAt - failedAt).toBeLessThanOrEqual(36_000);
    // Second attempt and failure: deadline stays the first failure's.
    const again = failSystemRecovery(reserveSystemRecoveryAttempt(failed, nextAt)!,
      new SystemRecoveryFailure("export_interrupted", "retry_transient"), { now: nextAt + 1_000 });
    expect(again.deadlineAt).toBe(failedAt + SYSTEM_RECOVERY_WINDOW_MS);
    expect(again.firstFailureAt).toBe(failedAt);
    // Exact values recorded on the base (8e9c7712) with this generation id.
    expect([failed.nextAttemptAt, failed.deadlineAt, again.nextAttemptAt, again.deadlineAt])
      .toEqual([5_630_933, 7_400_000, 5_689_256, 7_400_000]);
  });
});
