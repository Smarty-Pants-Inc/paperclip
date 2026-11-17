/** Independent S048 acceptance: real PG + real retained-release call site + real admission.
 * Only the Runner exit answer is doubled, matching the existing timing test.
 * The active lease has this run's proof; export ownership initially parks the Send.
 * Clearing ownership alone invokes no wake. Actual releaseRunLeases must admit it.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments,
  issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async () => true,
}));
const { heartbeatService } = await import("./heartbeat.js");
const { environmentRuntimeService } = await import("./environment-runtime.js");
const { HANDED_OFF_WARM_EXIT_KEY } = await import("./native-runtime/handed-off-warm-lease.js");
const { wakeAfterCleanupSettled, resetCleanupSettledWakesForTest, registerCleanupSettledResumer } = await import("./native-runtime/cleanup-settled-wake.js");

const FINALIZE_AFTER_MS = Number(process.env.S048_FINALIZE_AFTER_MS ?? 20_000);
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("S048 judge: real retained-release call site wakes a saved Send", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("s048-wake-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 1_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `S${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    const leaseId = randomUUID(), providerLeaseId = `bx_s048_${leaseId.slice(0, 8)}`;
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      // The with-work Stop's export still owns the run's workspace (cancelled-warm-workspace-export.ts).
      runnerProfileJson: { nativeResourceDisposition: "keep_running",
        nativeWorkspaceFinalizationOwner: { token: randomUUID(), at: stoppedAt.toISOString() } },
      resultJson: { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board", executionCancellation: { state: "acknowledged" }, nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
        issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // Own runner-exit marker, active before release. The finalization owner is the remaining cleanup gate.
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: `judge retained-release ${environmentId}`, driver: "sandbox", status: "active", config: {} });
    await db.insert(environmentLeases).values({ id: leaseId, environmentId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "reuse_by_environment", metadata: {
        driver: "sandbox", [HANDED_OFF_WARM_EXIT_KEY]: { runId: sourceRunId, provenAt: new Date().toISOString() },
      } });
    const comment = { id: randomUUID(), companyId, issueId, authorType: "user" as const, authorUserId: "board", body: "next",
      createdAt: new Date(stoppedAt.getTime() - 1_000) };
    await db.insert(issueComments).values([comment]);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: [comment.id] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
    return { companyId, issueId, sourceRunId, queueId, leaseId };
  }
  const receiptOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  async function until<T>(read: () => Promise<T | null | undefined | false>, ms: number) {
    const end = Date.now() + ms;
    for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 100)); }
  }

  it("parked Send -> real releaseRunLeases retains at +20 s -> ONE successor within 5 s, no false cleanup notice", async () => {
    resetCleanupSettledWakesForTest();
    const f = await seed();
    let transactionDepth = 0;
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        transactionDepth++;
        try { return await target.transaction(...args); } finally { transactionDepth--; }
      };
    }});
    const svc = heartbeatService(observed);
    const independentReader = createDb(database.connectionString);
    const observations: { transactionDepth: number; status: string | undefined; cleanupStatus: string | null | undefined }[] = [];
    const unregister = registerCleanupSettledResumer(async ({ companyId, runId }) => {
      const [row] = await independentReader.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      observations.push({ transactionDepth, status: row?.status, cleanupStatus: row?.cleanupStatus });
      const run = await svc.getRun(runId);
      if (run && run.companyId === companyId) await svc.resumeRemoteStopComments(run);
    });
    try {
    await svc.resumeQueuedCommentInterrupt(f.companyId, f.queueId, { retryCleanup: true });
    // Held, with the honest line.
    const held = await until(async () => {
      const r = await receiptOf(f.queueId);
      return (r.payload?.executionWait as { reason?: string } | undefined)?.reason === "cleanup_pending" ? r : null;
    }, 10_000);
    expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await new Promise(r => setTimeout(r, FINALIZE_AFTER_MS));
    // The export finalizes: the owner is released and the finalized mark committed (no transaction held).
    await db.update(heartbeatRuns).set({ runnerProfileJson: sql`(${heartbeatRuns.runnerProfileJson} - 'nativeWorkspaceFinalizationOwner')
      || ${JSON.stringify({ nativeCancelledWarmExport: { state: "finalized", at: new Date().toISOString() } })}::jsonb` })
      .where(eq(heartbeatRuns.id, f.sourceRunId));
    // DO NOT call the wake helper here: this must exercise environment-runtime.ts's actual call site.
    const finalizedAt = Date.now();
    const released = await environmentRuntimeService(db).releaseRunLeases(f.sourceRunId, "released", undefined, "keep_running");
    expect(released).toHaveLength(1);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease).toMatchObject({ status: "retained", cleanupStatus: "success" });
    const admitted = await until(async () => { const r = await receiptOf(f.queueId); return r.runId ? r : null; }, 5_000);
    // Base: null (the message waits for the 30 s re-poll, or forever behind the retained execution-workspace lease).
    expect(admitted).toMatchObject({ status: "coalesced" });
    expect(observations).toEqual([{ transactionDepth: 0, status: "retained", cleanupStatus: "success" }]);
    expect(Date.now() - finalizedAt).toBeLessThan(5_000);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    // R-ONCE: the same event again starts nothing more.
    expect(await wakeAfterCleanupSettled({ companyId: f.companyId, runId: f.sourceRunId, event: "lease_released" })).toBe(false);
    // The other event also cannot create another successor, even though the registry invokes the resumer again.
    await wakeAfterCleanupSettled({ companyId: f.companyId, runId: f.sourceRunId, event: "export_finalized" });
    await new Promise(r => setTimeout(r, 500));
    const after = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(after.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    // No "Waiting for the previous run to finish cleanup" line after the finalization.
    const lines = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(lines.filter(line => line.createdAt.getTime() >= finalizedAt && /finish cleanup/.test(line.body))).toEqual([]);
    expect((await receiptOf(f.queueId)).status).toBe("coalesced");
    } finally { unregister(); await independentReader.$client.end(); }
  }, 90_000);

  it("retained release does NOT send pre-Stop held input that has no Send", async () => {
    resetCleanupSettledWakesForTest();
    const f = await seed();
    // The seed comment predates Stop, but this wake has NO queuedCommentInterrupt/Send authorization.
    const before = await receiptOf(f.queueId);
    const payload = { ...before.payload };
    delete payload.queuedCommentInterrupt;
    await db.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, f.queueId));
    const svc = heartbeatService(db);
    let completed = false;
    const unregister = registerCleanupSettledResumer(async ({ runId }) => {
      const run = await svc.getRun(runId);
      if (run) await svc.resumeRemoteStopComments(run);
      completed = true;
    });
    try {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeResourceDisposition: "keep_running" } })
        .where(eq(heartbeatRuns.id, f.sourceRunId));
      await environmentRuntimeService(db).releaseRunLeases(f.sourceRunId, "released", undefined, "keep_running");
      expect(await until(async () => completed, 5_000)).toBe(true);
      expect(await receiptOf(f.queueId)).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(run => run.id)).toEqual([f.sourceRunId]);
    } finally { unregister(); }
  }, 30_000);
});
