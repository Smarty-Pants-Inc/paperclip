/**
 * S048 (ii) RED, real embedded Postgres + the real Send admission
 * (heartbeatService.resumeQueuedCommentInterrupt): a person's message after a
 * with-work warm Stop is parked behind "Waiting for the previous run to finish
 * cleanup" while the Stop's workspace export still owns the run; when the
 * export finalizes (+20 s) the committed finalization WAKES the message by
 * that event (cleanup-settled-wake.ts; the real call site is
 * finishCancelledWarmWorkspaceExport, proven in cancel-finalize-warm-stop.test.ts),
 * so ONE successor starts within 5 s, not after the 30 s re-poll.
 * Doubled: only the Boat Runner's runner-exit answer (as proof-out-of-tx.test.ts).
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueComments,
  issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async () => true,
}));
const { heartbeatService } = await import("./heartbeat.js");
const { wakeAfterCleanupSettled, resetCleanupSettledWakesForTest } = await import("./native-runtime/cleanup-settled-wake.js");

const FINALIZE_AFTER_MS = Number(process.env.S048_FINALIZE_AFTER_MS ?? 20_000);
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("S048: a message parked behind a warm Stop's export is woken by the finalization", () => {
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
      resultJson: { stopReason: "cancelled", nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
        issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // The handed-off warm box, reused by its execution workspace: retained/success, no stop receipt.
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
      status: "retained", leasePolicy: "reuse_by_execution_workspace", cleanupStatus: "success", metadata: {} });
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

  it("held -> export finalizes at +20 s -> ONE successor within 5 s of the finalization, no cleanup line after it", async () => {
    resetCleanupSettledWakesForTest();
    const f = await seed();
    const svc = heartbeatService(db);
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
    const finalizedAt = Date.now();
    void wakeAfterCleanupSettled({ companyId: f.companyId, runId: f.sourceRunId, event: "export_finalized" });
    const admitted = await until(async () => { const r = await receiptOf(f.queueId); return r.runId ? r : null; }, 5_000);
    // Base: null (the message waits for the 30 s re-poll, or forever behind the retained execution-workspace lease).
    expect(admitted).toMatchObject({ status: "coalesced" });
    expect(Date.now() - finalizedAt).toBeLessThan(5_000);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    // R-ONCE: the same event again starts nothing more.
    expect(await wakeAfterCleanupSettled({ companyId: f.companyId, runId: f.sourceRunId, event: "export_finalized" })).toBe(false);
    await new Promise(r => setTimeout(r, 500));
    const after = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(after.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    // No "Waiting for the previous run to finish cleanup" line after the finalization.
    const lines = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(lines.filter(line => line.createdAt.getTime() >= finalizedAt && /finish cleanup/.test(line.body))).toEqual([]);
    expect((await receiptOf(f.queueId)).status).toBe("coalesced");
  }, 90_000);
});
