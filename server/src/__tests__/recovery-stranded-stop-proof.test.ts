import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// Keep reason: #20807 / #20389 F1 data safety. A pause request is not proof that
// its task's provider stopped; releasing the claim can admit a second executor.
describe("stranded recovery retains ownership until execution Stop is confirmed", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stranded-stop-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(status: "running" | "cancelled" = "running") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery stop proof", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopping agent", adapterType: "http",
      status: "paused", pauseReason: "budget", lifecycleState: "pausing", lifecycleHolds: ["budget"],
      lifecycleRequiredPluginIds: [], lifecycleOperation: { id: randomUUID(), attempts: 1, hostComplete: false, completedPluginIds: [] } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status,
      runtimeMode: "legacy", executionStage: "dispatching", startedAt: new Date(Date.now() - 60_000),
      finishedAt: status === "running" ? null : new Date(), contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "http" } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Still owned by its provider", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date() });
    return { companyId, agentId, issueId, runId };
  }
  async function task(id: string) { return (await db.select().from(issues).where(eq(issues.id, id)))[0]!; }
  async function untouched(f: Awaited<ReturnType<typeof fixture>>, before: Awaited<ReturnType<typeof task>>) {
    expect(await task(f.issueId)).toEqual(before);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toEqual([]);
  }

  it.each(["both", "checkout", "execution"] as const)("preserves a running provider's %s task lock despite a non-invokable assignee", async binding => {
    const f = await fixture();
    if (binding !== "both") await db.update(issues).set(binding === "checkout" ? { executionRunId: null } : { checkoutRunId: null }).where(eq(issues.id, f.issueId));
    const before = await task(f.issueId);
    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    await untouched(f, before);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.status).toBe("running");
  });

  it("does not treat terminal cancellation as Stop proof, then releases after durable acknowledgement", async () => {
    const f = await fixture("cancelled");
    const before = await task(f.issueId);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect((await recovery.reconcileStrandedAssignedIssues()).escalated).toBe(0);
    await untouched(f, before);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await recovery.reconcileStrandedAssignedIssues()).escalated).toBe(1);
    expect(await task(f.issueId)).toMatchObject({ status: "blocked", assigneeAgentId: f.agentId, checkoutRunId: null, executionRunId: null });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(1);
    expect((await recovery.reconcileStrandedAssignedIssues()).escalated).toBe(0);
  });

  it("retains a cancelled acknowledged run while its controller still owns execution", async () => {
    const f = await fixture("cancelled");
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 600_000),
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.runId));
    const before = await task(f.issueId);
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues()).escalated).toBe(0);
    await untouched(f, before);
  });

  it("rechecks the owning run in the escalation transaction after the candidate was read", async () => {
    const f = await fixture("cancelled");
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.runId));
    const before = await task(f.issueId);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(), afterStrandedLatestRunRead: async ({ issueId }) => {
      if (issueId === f.issueId) await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    } });
    expect((await recovery.reconcileStrandedAssignedIssues()).escalated).toBe(0);
    await untouched(f, before);
  });

  it("checks both bound owners, not only the latest context-scoped run", async () => {
    const f = await fixture("cancelled"), liveId = randomUUID();
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ id: liveId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "running", startedAt: new Date(), contextSnapshot: { taskId: f.issueId } });
    await db.update(issues).set({ executionRunId: liveId }).where(eq(issues.id, f.issueId));
    const before = await task(f.issueId);
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues()).escalated).toBe(0);
    await untouched(f, before);
  });

  it("retains a terminal acknowledged run whose recorded local process is still alive", async () => {
    const f = await fixture("cancelled");
    await db.update(heartbeatRuns).set({ processPid: process.pid,
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.runId));
    const before = await task(f.issueId);
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues()).escalated).toBe(0);
    await untouched(f, before);
  });

  it("does not accept another company's run as Stop evidence for a bound owner", async () => {
    const f = await fixture("cancelled"), other = await fixture("cancelled");
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, other.runId));
    await db.update(issues).set({ checkoutRunId: other.runId, executionRunId: other.runId }).where(eq(issues.id, f.issueId));
    const before = await task(f.issueId);
    await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues();
    await untouched(f, before);
  });

  it("does not let unrelated execution of the same agent prevent confirmed task recovery", async () => {
    const f = await fixture("cancelled");
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() } });
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues()).escalated).toBe(1);
    expect(await task(f.issueId)).toMatchObject({ status: "blocked", checkoutRunId: null, executionRunId: null });
  });
});
