import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { runExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { recoveryService } from "../services/recovery/service.js";

// Keep reason: #20807 RFL F1's independent PostgreSQL reproduction caught a
// data-safety failure: the ordinary sweep released a still-executing owner's
// claims immediately after guarded stranded-assignment recovery retained them.
describe("stale-lock sweep requires execution Stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-stop-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Independent ownership check", issuePrefix: `J${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopping owner", adapterType: "http",
      status: "paused", pauseReason: "budget", lifecycleState: "pausing", lifecycleHolds: ["budget"],
      lifecycleRequiredPluginIds: [], lifecycleOperation: { id: randomUUID(), attempts: 1, hostComplete: false, completedPluginIds: [] } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "cancelled",
      runtimeMode: "legacy", executionStage: "dispatching", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "http" } }, resultJson: {},
      controllerLeaseExpiresAt: new Date(Date.now() + 600_000), processPid: process.pid });
    await db.insert(issues).values({ id: issueId, companyId, title: "Unconfirmed stopped task", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date() });
    return { companyId, agentId, issueId, runId };
  }
  async function task(id: string) { return (await db.select().from(issues).where(eq(issues.id, id)))[0]!; }
  async function acknowledgeStop(runId: string) {
    await db.update(heartbeatRuns).set({ processPid: null, controllerLeaseExpiresAt: null,
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, runId));
  }

  it("retains both claims after guarded recovery when cancellation has no Stop proof and the PID is live", async () => {
    const f = await fixture();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    const before = await task(f.issueId);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    expect((await recovery.reconcileStrandedAssignedIssues()).escalated).toBe(0);
    expect(await task(f.issueId)).toEqual(before);
    const swept = await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
    expect(swept).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
  });

  it("clears both claims once durable cancellation acknowledgement and released execution establish Stop", async () => {
    const f = await fixture();
    await acknowledgeStop(f.runId);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(true);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect(await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId }))
      .toEqual({ cleared: 1, issueIds: [f.issueId], terminalizedRunIds: [] });
    expect(await task(f.issueId)).toMatchObject({ status: "in_progress", checkoutRunId: null, executionRunId: null, executionLockedAt: null });
  });

  it("rechecks Stop proof in the clear transaction rather than trusting the candidate read", async () => {
    const f = await fixture();
    await acknowledgeStop(f.runId);
    const before = await task(f.issueId);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(), beforeStaleLockClear: async () => {
      await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.runId));
    } });
    expect((await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).cleared).toBe(0);
    expect(await task(f.issueId)).toEqual(before);
  });

  it("requires Stop proof for both distinct bound owners", async () => {
    const f = await fixture(), executionRunId = randomUUID();
    await acknowledgeStop(f.runId);
    await db.insert(heartbeatRuns).values({ id: executionRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "cancelled", runtimeMode: "legacy", executionStage: "dispatching",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), processPid: process.pid, contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId }).where(eq(issues.id, f.issueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect((await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).cleared).toBe(0);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId });
    await acknowledgeStop(executionRunId);
    expect((await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).cleared).toBe(1);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
  });
});
