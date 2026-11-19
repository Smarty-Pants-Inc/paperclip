import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueComments,
  issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// review-fleet-4's required row (rf-4 row 22, the 11-17 gate-3 wedge): hold the
// handed-off warm Runner-exit proof SLOW (a Boat whose RPCs take ~30 s) during an
// Interrupt hand-off while ANOTHER admission and a heartbeat write proceed. The
// tx-network guard is switched OFF here on purpose: this row measures the
// database itself (pg_stat_activity), so it is red on a proof inside a
// transaction whether or not the guard is present.
const proof = vi.hoisted(() => {
  process.env.PAPERCLIP_TX_NETWORK_GUARD = "off";
  return { holdMs: Number(process.env.PROOF_HOLD_MS ?? 30_000), slow: new Set<string>(),
    calls: [] as Array<{ runId: string; providerLeaseId: string | null; at: number }>, landedAt: 0 };
});
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async (input: { runId: string; providerLeaseId: string | null }) => {
    proof.calls.push({ ...input, at: Date.now() });
    if (input.providerLeaseId && proof.slow.has(input.providerLeaseId)) {
      await new Promise(resolve => setTimeout(resolve, proof.holdMs));
      proof.landedAt = Date.now();
    }
    return true;
  },
}));
const { heartbeatService } = await import("./heartbeat.js");
const { sql } = await import("drizzle-orm");
// The product bound (20 s) turns a slower proof into the stop_and_retain intent; this row
// wants the ~30 s proof to LAND, so the bound is raised above the hold (not on the base,
// which has no bound: there the proof simply runs inside the transaction).
const handedOff = await import("./native-runtime/handed-off-warm-lease.js") as { handedOffWarmProofTimeout?: { ms: number } };
if (handedOff.handedOffWarmProofTimeout) handedOff.handedOffWarmProofTimeout.ms = proof.holdMs + 15_000;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("rf-4 row 22 probe: a slow Runner-exit proof during an Interrupt hand-off never holds a DB transaction", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("interrupt-handoff-tx-probe-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  type Variant = "handoff" | "with_file" | "runner_alive" | "stop_in_flight" | "ephemeral";
  async function seed(variant: Variant) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 1_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `W${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    const leaseId = randomUUID(), providerLeaseId = `bx_${variant}_${leaseId.slice(0, 8)}`;
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: variant === "ephemeral" ? "destroy" : "keep_running",
        ...(variant === "with_file" ? { nativeWorkspaceSync: { state: "prepared", schema: "paperclip.native-workspace-sync/v3",
          leaseId, remoteCwd: "/home/user/paperclip-workspace", workspaceId: randomUUID(), baselineSha256: "a".repeat(64),
          finalHostSha256: null, providerLeaseId, descriptorSha256: "b".repeat(64), resourceDisposition: "keep_running" } } : {}) },
      resultJson: { stopReason: "cancelled", nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
        issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // The warm policy's handoff: lease retained, cleanup success, NO stop receipt (S10nofile rows, lease afdb2aa2).
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
      status: variant === "ephemeral" ? "active" : "retained", leasePolicy: variant === "ephemeral" ? "ephemeral" : "reuse_by_environment",
      cleanupStatus: "success", metadata: variant === "stop_in_flight" ? { pendingCleanupInFlight: true, pendingCleanupReason: "warm_window_expired" } : {} });
    const comments = ["A", "B", "C"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(stoppedAt.getTime() - 3_000 + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id) },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
    return { companyId, issueId, sourceRunId, queueId, leaseId, providerLeaseId, commentIds: comments.map(c => c.id as string) };
  }

  const within = <T,>(promise: Promise<T>, ms: number) => Promise.race([promise.then(value => ({ value })),
    new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms))]);
  const receiptOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  async function until<T>(read: () => Promise<T | null | undefined | false>, ms: number) {
    const end = Date.now() + ms;
    for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 100)); }
  }
  type Idle = { pid: number; idle_ms: number; xact_ms: number; query: string };
  const idleInTransaction = async () => (await db.execute(sql`select pid, (extract(epoch from now() - state_change) * 1000)::int as idle_ms,
      (extract(epoch from now() - xact_start) * 1000)::int as xact_ms, left(query, 160) as query
    from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
      and state like 'idle in transaction%'`)) as unknown as Idle[];

  it("probe: no connection idle in transaction > 1 s, another admission and a heartbeat write complete, then ONE successor on the same box within seconds", async () => {
    const f = await seed("handoff");
    const other = await seed("handoff");
    proof.slow.add(f.providerLeaseId); proof.calls.length = 0; proof.landedAt = 0;
    const worst: Idle[] = [];
    let probing = true;
    const probe = (async () => { while (probing) {
      for (const row of await idleInTransaction()) if (row.idle_ms > 1_000) worst.push(row);
      await new Promise(r => setTimeout(r, 200));
    } })();
    const started = Date.now();
    const post = heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId, { retryCleanup: true });
    try {
      expect(await until(async () => proof.calls.some(call => call.providerLeaseId === f.providerLeaseId), 5_000)).toBeTruthy();
      // While the slow proof is running: the Send's own POST returns (<= 2 s)...
      expect.soft(await within(post, Math.max(0, 2_000 - (Date.now() - started)))).not.toBe("timeout");
      // ...ANOTHER admission (a second Send on another box) admits its successor...
      expect.soft(await within(heartbeatService(db).resumeQueuedCommentInterrupt(other.companyId, other.queueId, { retryCleanup: true }), 5_000)).not.toBe("timeout");
      expect.soft((await receiptOf(other.queueId)).runId).toBeTruthy();
      // ...and a heartbeat write on the stopped run's row, the task row and the wake row all complete at once.
      expect.soft(await within(db.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.sourceRunId)), 2_000)).not.toBe("timeout");
      expect.soft(await within(db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, f.issueId)), 2_000)).not.toBe("timeout");
      expect.soft(await within(db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(eq(agentWakeupRequests.id, f.queueId)), 2_000)).not.toBe("timeout");
      // Keep probing pg_stat_activity for the rest of the slow proof.
      await until(async () => proof.landedAt > 0, proof.holdMs + 5_000);
    } finally { probing = false; await probe; }
    expect(worst.slice(0, 3), `idle-in-transaction samples > 1 s: ${worst.length}, max idle ${Math.max(0, ...worst.map(row => row.idle_ms))} ms`).toEqual([]);
    expect(proof.landedAt).toBeGreaterThan(0);
    // The proof landed outside any transaction: ONE successor, same box (lease retained, proof persisted), no wait/card left.
    const admitted = await until(async () => { const r = await receiptOf(f.queueId); return r.runId ? r : null; }, 10_000);
    expect(admitted).toMatchObject({ status: "coalesced" });
    expect(admitted!.updatedAt.getTime() - proof.landedAt).toBeLessThan(10_000);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease).toMatchObject({ status: "retained", releasedAt: null, providerLeaseId: f.providerLeaseId });
    expect(lease.metadata?.handedOffWarmOwnerRunnerExited).toMatchObject({ runId: f.sourceRunId });
  }, 120_000);
});
