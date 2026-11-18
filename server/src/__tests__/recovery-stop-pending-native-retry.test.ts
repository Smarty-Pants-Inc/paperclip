import { randomUUID } from "node:crypto";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// Keep reason: #20807 J4 caught a 30-day task with no claimant and no visible
// owner. Real PostgreSQL checks the eligibility read and guarded release, and
// preserves the existing same-run retry path rather than waking a replacement.
describe("native retry phase alone does not own a retained task Stop", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-native-retry-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(status: string, processPid: number | null = null) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const old = new Date(Date.now() - 30 * 86_400_000);
    await db.insert(companies).values({ id: companyId, name: "Native retry ownership", issuePrefix: `N${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Old native owner", adapterType: "paperclip_runner",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(issues).values({ id: issueId, companyId, title: "Native Stop obligation", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status, runtimeMode: "native", nativeIssueId: issueId,
      invocationSource: "manual", executionStage: "dispatching", startedAt: old, finishedAt: status === "running" ? null : old, processPid });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId, executionLockedAt: old }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "retryable_failure",
      resultId: null, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null });
    return { companyId, issueId, runId };
  }
  async function task(issueId: string) { return (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!; }

  it.each(["cancelled", "succeeded", "timed_out", "interrupted"])("escalates a failed Stop inspection for a non-resumable %s run, once", async status => {
    const f = await fixture(status, status === "cancelled" ? null : process.pid);
    const before = await task(f.issueId);
    const coordinator = (await db.select().from(nativeRunFinalizations))[0];
    const enqueueWakeup = vi.fn();
    for (let pass = 0; pass < 3; pass++) {
      expect((await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks()).cleared).toBe(0);
      expect(await task(f.issueId)).toEqual(before);
    }
    const actions = await db.select().from(issueRecoveryActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ cause: "execution_stop_pending", ownerType: "board", status: "escalated", attemptCount: 1, maxAttempts: 1,
      evidence: { stopPending: { code: "execution_stop_pending", runIds: [f.runId], owner: "recovery.sweep_stale_issue_locks" } } });
    expect(actions[0]!.nextAction).toContain("execution_stop_pending");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_stop_pending"))).toHaveLength(1);
    expect((await db.select().from(nativeRunFinalizations))[0]).toEqual(coordinator);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["failed", "running"])("retains the normal %s same-run retry owner without adding a Stop escalation", async status => {
    const f = await fixture(status);
    const before = await task(f.issueId);
    const enqueueWakeup = vi.fn();
    expect((await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks()).cleared).toBe(0);
    expect(await task(f.issueId)).toEqual(before);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("resolves the diagnostic only after positive Stop proof, retaining the native coordinator as history", async () => {
    const f = await fixture("cancelled");
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000 }).where(eq(heartbeatRuns.id, f.runId));
    const runBefore = (await db.select().from(heartbeatRuns))[0];
    const coordinatorBefore = (await db.select().from(nativeRunFinalizations))[0];
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(1);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect((await db.select().from(issueRecoveryActions))[0]).toMatchObject({ status: "resolved", outcome: "restored" });
    expect((await db.select().from(heartbeatRuns))[0]).toEqual(runBefore);
    expect((await db.select().from(nativeRunFinalizations))[0]).toEqual(coordinatorBefore);
  });
});
