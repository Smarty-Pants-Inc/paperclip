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
const proof = vi.hoisted(() => ({ exited: true, calls: [] as Array<{ runId: string; providerLeaseId: string | null }> }));
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async (input: { runId: string; providerLeaseId: string | null }) => {
    proof.calls.push(input);
    return proof.exited;
  },
}));
const { heartbeatService } = await import("./heartbeat.js");
const { buildExecutionContinuation } = await import("./execution-continuation.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pl/send-after-stop: Stop with queued messages, then Send on a warm box", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("send-after-stop-");
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

  async function send(variant: Variant, exited = true) {
    proof.exited = exited; proof.calls.length = 0;
    const f = await seed(variant);
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.queueId));
    return { f, receipt };
  }

  it("catches the real Send enqueue transaction awaiting the handed-off warm Runner proof", async () => {
    const f = await seed("handoff");
    proof.calls.length = 0;
    await expect(heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId))
      .rejects.toThrow("network_call_in_db_transaction: runner:handedOffWarmOwnerRunnerExited");
    expect(proof.calls).toEqual([]); // Guard stops the real path before the mocked network proof.
  });

  it.each(["handoff", "with_file"] as const)("admits ONE successor onto the handed-off warm box at once: %s", async variant => {
    const { f, receipt } = await send(variant);
    expect(receipt.payload?.executionWait).toBeUndefined();
    expect(receipt.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.sourceRunId });
    // The queued messages only, in order, once; the stopped turn is not resumed.
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: successor.agentId,
      runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.interruptedRunId).toBe(f.sourceRunId);
    expect([...envelope.originCommentIds].sort()).toEqual([...f.commentIds].sort());
    expect(envelope.messages.filter(message => f.commentIds.includes(message.id)).map(message => message.body)).toEqual(["A", "B", "C"]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    // The proof asked was the s3 fence's, for this run on this box.
    expect(proof.calls).toContainEqual({ runId: f.sourceRunId, providerLeaseId: f.providerLeaseId });
    // The box is not stopped or released: the successor reuses the same lease (same provider box).
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease).toMatchObject({ status: "retained", releasedAt: null, providerLeaseId: f.providerLeaseId });
  });

  it.each([
    ["runner_alive", false],
    ["stop_in_flight", true],
    ["ephemeral", true],
  ] as const)("still waits for the previous environment: %s", async (variant, exited) => {
    const { f, receipt } = await send(variant, exited);
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: { executionWait: { reason: "remote_cleanup" } } });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.map(run => run.id)).toEqual([f.sourceRunId]);
    if (variant !== "runner_alive") expect(proof.calls).toEqual([]);
  });
});
