import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// pl/no-default-wait: the Runner-exit proof needs a live Boat Runner; the test
// stands in only for its boolean answer. Everything else is the real code.
const proof = vi.hoisted(() => ({ exited: false }));
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async () => proof.exited,
  // The same live controller holds the warm session, so its proof is
  // obtainable (not sas3's restart case): consistent with the stand-in above.
  handedOffWarmOwnerProofUnavailable: () => false,
}));
const { heartbeatService } = await import("./heartbeat.js");
const { issueRoutes } = await import("../routes/issues.js");
const { errorHandler } = await import("../middleware/index.js");
const { buildExecutionContinuation } = await import("./execution-continuation.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pl/no-default-wait: Stop with held messages on a warm handed-off box", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("no-default-wait-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "board", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  // M2-M4 held behind a running turn, then the person's Stop on a warm handed-off box.
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 60_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `W${companyId.replaceAll("-", "")}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: "board", conversationState: "active" });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board",
        executionCancellation: { state: "acknowledged" },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
          issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    const leaseId = randomUUID(), providerLeaseId = "bx_warm";
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId,
      status: "retained", leasePolicy: "reuse_by_environment", cleanupStatus: "success", metadata: {} });
    const base = stoppedAt.getTime() - 3_000;
    const comments = ["M2", "M3", "M4"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(base + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      requestedAt: new Date(base + 10),
      payload: { issueId, commentId: comments.at(-1)!.id, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id), wakeReason: "issue_commented" } } });
    return { companyId, agentId, issueId, sourceRunId, queueId, providerLeaseId, commentIds: comments.map(c => c.id as string) };
  }

  const wakeOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const readQueue = async (f: { companyId: string; issueId: string }) =>
    (await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;

  it("the automatic resume after Stop saves no default wait, keeps the Send line, and Send delivers M2-M4 once", async () => {
    const f = await seed();
    proof.exited = false; // the automatic pass ran before the Runner's exit was proven
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeatService(db).resumeRemoteStopComments(run);
    vi.setSystemTime(Date.now() + 60_000);
    await heartbeatService(db).resumeRemoteStopComments(run);
    vi.useRealTimers();
    const held = await wakeOf(f.queueId);
    expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(held.payload?.executionWait).toBeUndefined();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(r => r.id)).toEqual([f.sourceRunId]);
    const queue = await readQueue(f);
    expect(queue.executionWait?.reason).toBe("stopped_by_person");
    expect(queue.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(f.commentIds);

    // The person's Send: one successor through the existing admission.
    proof.exited = true;
    const sent = await request(app(f.companyId)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(sent.status).toBeLessThan(300);
    await vi.waitFor(async () => {
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.sourceRunId);
      expect(runs).toHaveLength(1);
    }, { timeout: 15_000, interval: 200 });
    const [successor] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.sourceRunId);
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.messages.filter(message => f.commentIds.includes(message.id)).map(message => message.body)).toEqual(["M2", "M3", "M4"]);
    const done = await wakeOf(f.queueId);
    expect(done.status).not.toBe("deferred_issue_execution");
    expect((done.payload?.executionWait as { reason?: string } | undefined)?.reason).not.toBe("execution_recovery");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  }, 60_000);
});
