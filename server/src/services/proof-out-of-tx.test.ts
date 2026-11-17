import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueComments,
  issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// pl/send-after-stop: the s3 fence's runner-exited proof (supersededOwnerRunnerExited,
// reached through handedOffWarmOwnerRunnerExited) needs a live Boat Runner; the test
// stands in only for its boolean answer. Everything else is the real admission.
const proof = vi.hoisted(() => ({ pending: null as null | ((v: boolean) => void), mode: "hang" as "hang" | "never", calls: [] as Array<{ runId: string; providerLeaseId: string | null }> }));
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async (input: { runId: string; providerLeaseId: string | null }) => {
    proof.calls.push(input);
    // A Boat Runner whose ingress is failing (400/502 retries): the stop-and-prove-exit never returns
    // until the test releases it ("hang"), or never at all ("never").
    return new Promise<boolean>(resolve => { if (proof.mode === "hang") proof.pending = resolve; });
  },
}));
const { heartbeatService } = await import("./heartbeat.js");
const { sql } = await import("drizzle-orm");
const handedOff = await import("./native-runtime/handed-off-warm-lease.js");
const { hasStopOnlyCleanup } = await import("./sandbox-stop-and-retain.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("rf-4 row 22: the runner-exit proof never runs inside the Send's enqueue transaction", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("proof-out-of-tx-");
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
    const leaseId = randomUUID(), providerLeaseId = "bx_warm";
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
  const lockWithin1s = (table: "issues" | "agent_wakeup_requests", id: string) => db.transaction(async tx => {
    await tx.execute(sql.raw("set local lock_timeout = '1s'"));
    await tx.execute(sql`select id from ${sql.raw(table)} where id = ${id} for update`);
    return "locked";
  });
  const receiptOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  async function until<T>(read: () => Promise<T | null | undefined | false>, ms: number) {
    const end = Date.now() + ms;
    for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 100)); }
  }

  it("22b: a hanging Runner -> the Send returns within 2 s, no transaction waits on it, the dispatcher admits once the proof lands", async () => {
    proof.mode = "hang"; proof.pending = null; proof.calls.length = 0;
    const f = await seed("handoff");
    const started = Date.now();
    const post = heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId, { retryCleanup: true });
    try {
      // While the Runner hangs, a concurrent FOR UPDATE on the task and on the wake row gets its lock within 1 s.
      await until(async () => proof.calls.length > 0, 3_000);
      expect(await lockWithin1s("issues", f.issueId)).toBe("locked");
      expect(await lockWithin1s("agent_wakeup_requests", f.queueId)).toBe("locked");
      const returned = await within(post, Math.max(0, 2_000 - (Date.now() - started)));
      expect(returned).not.toBe("timeout");
      // Committed and honest: deferred with the handoff wait, nothing admitted yet.
      expect(await receiptOf(f.queueId)).toMatchObject({ status: "deferred_issue_execution", runId: null,
        payload: { executionWait: { reason: "interrupt_handoff" } } });
    } finally { proof.pending?.(true); }
    // The proof lands outside any transaction; its persisted evidence admits ONE successor (bound: warm+60).
    const admitted = await until(async () => { const r = await receiptOf(f.queueId); return r.runId ? r : null; }, 60_000);
    expect(admitted).toMatchObject({ status: "coalesced" });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease.metadata?.[handedOff.HANDED_OFF_WARM_EXIT_KEY]).toMatchObject({ runId: f.sourceRunId });
    expect(lease).toMatchObject({ status: "retained", releasedAt: null });
  }, 90_000);

  it("22b/22f: a Runner that never answers -> the bounded proof times out into the stop_and_retain intent, never a hang", async () => {
    proof.mode = "never"; proof.pending = null; proof.calls.length = 0;
    handedOff.handedOffWarmProofTimeout.ms = 1_500;
    try {
      const f = await seed("handoff");
      const started = Date.now();
      expect(await within(heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId, { retryCleanup: true }), 2_000)).not.toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await lockWithin1s("issues", f.issueId)).toBe("locked");
      const lease = await until(async () => {
        const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
        return hasStopOnlyCleanup(row) ? row : null;
      }, 10_000);
      // sas3's stop-only intent (upstream's stop_and_retain shape); its provider receipt then admits through the receipt path.
      expect(lease).toBeTruthy();
      expect(JSON.stringify(lease!.metadata)).toContain(handedOff.HANDED_OFF_WARM_STOP_KEY);
      const receipt = await receiptOf(f.queueId);
      expect(receipt.status).toBe("deferred_issue_execution");
      expect(["interrupt_handoff", "remote_cleanup"]).toContain((receipt.payload?.executionWait as { reason?: string })?.reason);
    } finally { handedOff.handedOffWarmProofTimeout.ms = 20_000; }
  }, 30_000);
});
