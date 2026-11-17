import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueComments,
  issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// pl/send-after-stop3 (rf-4 row 12): after a controller restart this process
// holds NO warm session for the stopped run, so the s3 fence's proof is
// unavailable. Everything is real (the empty warm-session map, the admission,
// the stop-only owner and its receipt settle). Only the "runner proven busy"
// negative stands in for a busy warm entry, which needs a live Boat Runner.
const owner = vi.hoisted(() => ({ busy: false }));
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, handedOffWarmOwnerProofUnavailable: (input: unknown) => !owner.busy
    && (real.handedOffWarmOwnerProofUnavailable as ((input: unknown) => boolean) | undefined)?.(input) === true };
});
const { heartbeatService } = await import("./heartbeat.js");
const { buildExecutionContinuation } = await import("./execution-continuation.js");
const { admitExplicitNativeContinuation } = await import("./explicit-native-continuation.js");
const { settleStopOnlyCleanup } = await import("./sandbox-stop-and-retain.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pl/send-after-stop3: Send after Stop on a handed-off warm box after a controller restart", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("send-after-stop3-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  type Variant = "restart" | "busy" | "non_retained";
  async function seed(variant: Variant) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 1_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    const leaseId = randomUUID(), providerLeaseId = `bx_${randomUUID().slice(0, 8)}`;
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: { stopReason: "cancelled", nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
        issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // The warm policy's handoff (retained, cleanup success, NO stop receipt) on a plugin (Boat) box.
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: sourceRunId, provider: "boat", providerLeaseId,
      status: variant === "non_retained" ? "active" : "retained", leasePolicy: "reuse_by_environment",
      cleanupStatus: "success", metadata: { pluginId: "boat-plugin" } });
    const comments = ["A", "B", "C"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(stoppedAt.getTime() - 3_000 + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id) },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
    return { companyId, agentId, issueId, sourceRunId, queueId, leaseId, providerLeaseId, commentIds: comments.map(c => c.id as string) };
  }
  const lease = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const wake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const runsOf = async (companyId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));

  it("requests ONE stop-and-retain of the handed-off box at once, then admits ONE successor on its receipt", async () => {
    owner.busy = false;
    const f = await seed("restart");
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    expect(await wake(f.queueId)).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "remote_cleanup" } } });
    // At once (not at warm-window expiry): the stop-only owner's intent on THIS lease.
    const stopping = await lease(f.leaseId);
    expect(stopping).toMatchObject({ status: "pending_cleanup", providerLeaseId: f.providerLeaseId });
    const intent = stopping.metadata?.sandboxStopAndRetain as Record<string, unknown> | undefined;
    expect(intent).toMatchObject({ runId: f.sourceRunId, leaseId: f.leaseId, providerLeaseId: f.providerLeaseId,
      pluginId: "boat-plugin", handedOffWarmProofUnavailable: true });
    // Idempotent: a second refusal requests no second stop.
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    expect((await lease(f.leaseId)).metadata?.sandboxStopAndRetain).toEqual(intent);
    expect((await runsOf(f.companyId)).map(run => run.id)).toEqual([f.sourceRunId]);
    // The provider's stop receipt arrives through the real stop-only settle.
    const settled = await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } });
    expect(settled).toMatchObject({ status: "released", providerLeaseId: f.providerLeaseId });
    // ...and the sweep's receipt path admits the successor (heartbeat/recovery.ts resumeRemoteStopComments after the receipt).
    await heartbeatService(db).resumeRemoteStopComments((await runsOf(f.companyId)).find(run => run.id === f.sourceRunId)!);
    const receipt = await wake(f.queueId);
    // The saved Send is coalesced into the ONE successor of the stopped run.
    expect(receipt).toMatchObject({ status: "coalesced", payload: { queuedCommentInterrupt: { continuation: {
      previousRunId: f.sourceRunId, queuedCommentInterruptId: f.queueId } } } });
    const runs = await runsOf(f.companyId);
    expect(runs.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    const [successor] = runs.filter(run => run.id === receipt.runId);
    expect(successor).toBeDefined();
    expect(successor.contextSnapshot).toMatchObject({ previousRunId: f.sourceRunId });
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: successor.agentId,
      runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect([...envelope.originCommentIds].sort()).toEqual([...f.commentIds].sort());
    expect(envelope.messages.filter(message => f.commentIds.includes(message.id)).map(message => message.body)).toEqual(["A", "B", "C"]);
  });

  it.each(["busy", "non_retained"] as const)("requests no stop and still waits: %s", async variant => {
    owner.busy = variant === "busy";
    const f = await seed(variant);
    const before = await lease(f.leaseId);
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    expect(await wake(f.queueId)).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "remote_cleanup" } } });
    expect(await lease(f.leaseId)).toMatchObject({ status: before.status, metadata: before.metadata });
    expect((await runsOf(f.companyId)).map(run => run.id)).toEqual([f.sourceRunId]);
    owner.busy = false;
  });

  it("a dryRun preview requests no stop", async () => {
    owner.busy = false;
    const f = await seed("restart");
    const before = await lease(f.leaseId);
    let wait: string | null = null;
    const decision = await admitExplicitNativeContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      actorType: "user", actorId: "board", reason: "issue_commented", commentId: f.commentIds[2]!, successorRunId: randomUUID(),
      queuedCommentInterruptId: f.queueId, dryRun: true, onBlocked: reason => { wait = reason; } });
    expect(decision).toBeNull();
    expect(wait).toBe("remote_cleanup");
    expect(await lease(f.leaseId)).toMatchObject({ status: "retained", metadata: before.metadata });
  });
});
