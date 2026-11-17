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
(support.supported ? describe : describe.skip)("pl/send-after-stop2: Stop with queued messages on a warm box, NO Send: the automatic remote-stop resume", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("send-after-stop2-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  type Timing = "before_stop" | "after_stop";
  async function seed(timing: Timing) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 10_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `V${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    const leaseId = randomUUID(), providerLeaseId = "bx_warm";
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board",
        executionCancellation: { state: "acknowledged" },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
          issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // The warm policy's handoff: lease retained, cleanup success, NO stop receipt.
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
      status: "retained", leasePolicy: "reuse_by_environment", cleanupStatus: "success", metadata: {} });
    const base = timing === "before_stop" ? stoppedAt.getTime() - 3_000 : stoppedAt.getTime() + 3_000;
    const comments = ["A", "B", "C"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(base + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      requestedAt: new Date(base + 10),
      payload: { issueId, commentId: comments.at(-1)!.id, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id), wakeReason: "issue_commented" } } });
    return { companyId, issueId, sourceRunId, queueId, leaseId, providerLeaseId, commentIds: comments.map(c => c.id as string) };
  }

  async function resume(timing: Timing, exited: boolean) {
    proof.exited = exited; proof.calls.length = 0;
    const f = await seed(timing);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeatService(db).resumeRemoteStopComments(run);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.queueId));
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    return { f, receipt, runs };
  }

  // Messages saved AFTER the Stop resume automatically; older input stays with the Stop (Stop means stop).
  it("admits ONE successor on the handed-off warm box, comments once in order", async () => {
    const { f, receipt, runs } = await resume("after_stop", true);
    expect(receipt.payload?.executionWait).toBeUndefined();
    expect(runs.filter(run => run.id !== f.sourceRunId)).toHaveLength(1);
    const [successor] = runs.filter(run => run.id !== f.sourceRunId);
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: successor.agentId,
      runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect([...envelope.originCommentIds].sort()).toEqual([...f.commentIds].sort());
    expect(envelope.messages.filter(message => f.commentIds.includes(message.id)).map(message => message.body)).toEqual(["A", "B", "C"]);
    expect(proof.calls).toContainEqual({ runId: f.sourceRunId, providerLeaseId: f.providerLeaseId });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease).toMatchObject({ status: "retained", releasedAt: null, providerLeaseId: f.providerLeaseId });
  });

  it("still waits when the stopped run's Runner is not proven exited", async () => {
    const { f, receipt, runs } = await resume("after_stop", false);
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(runs.map(run => run.id)).toEqual([f.sourceRunId]);
  });
});
