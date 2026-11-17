import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// pl/interrupt-handoff: a person's Interrupt (errorCode operator_interrupted) of a
// warm (keep_running) native turn must end on the SAME shape as a Stop: the box is
// handed off, no file-preservation hold, and the queued message is admitted onto
// the retained lease at once. Real lease release (heartbeat.releaseEnvironmentLeasesForRun)
// and real admission (resumeQueuedCommentInterrupt) on embedded Postgres. Only the
// provider edges are scripted: the orchestrator's releaseForRun, and the s3 fence's
// runner-exited boolean (needs a live Boat Runner; see explicit-native-send-after-stop).
const proof = vi.hoisted(() => ({ exited: true, calls: [] as Array<{ runId: string; providerLeaseId: string | null }> }));
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async (input: { runId: string; providerLeaseId: string | null }) => {
    proof.calls.push(input);
    return proof.exited;
  },
}));
const environmentOrchestrator = await import("./environment-run-orchestrator.js");
const { heartbeatService } = await import("./heartbeat.js");
const { buildExecutionContinuation } = await import("./execution-continuation.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pl/interrupt-handoff: Interrupt on a warm box hands it off like Stop", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("interrupt-handoff-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(errorCode: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const stoppedAt = new Date(Date.now() - 1_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Interrupt", defaultResponsibleUserId: "board", issuePrefix: `I${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    const leaseId = randomUUID(), providerLeaseId = "bx_warm";
    // What issues.ts operatorInterruptCancelOptions + cancelRun record for a person's
    // Interrupt: errorCode operator_interrupted, user attribution, and the same
    // acknowledged run-only native cancellation a Stop records (scope "run").
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode, contextSnapshot: { issueId }, finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: "keep_running", nativeWorkspaceSync: { state: "prepared",
        schema: "paperclip.native-workspace-sync/v3", leaseId, remoteCwd: "/home/user/paperclip-workspace", workspaceId: randomUUID(),
        baselineSha256: "a".repeat(64), finalHostSha256: null, providerLeaseId, descriptorSha256: "b".repeat(64),
        resourceDisposition: "keep_running" } },
      resultJson: { stopReason: "cancelled", operatorInterrupted: true, interruptionSource: "issue_comment_interrupt",
        interruptedIssueId: issueId, interruptedByActorType: "user", interruptedByActorId: "board",
        cancelledByActorType: "user", cancelledByUserId: "board",
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId,
          issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    // The warm box while the interrupted turn unwinds: still active, reusable.
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/home/user/paperclip-workspace" } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    const comment = { id: randomUUID(), companyId, issueId, authorType: "user" as const, authorUserId: "board",
      body: "Do this instead.", createdAt: new Date(stoppedAt.getTime() - 500) };
    await db.insert(issueComments).values(comment);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: [comment.id] },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
    return { companyId, agentId, issueId, runId, queueId, leaseId, providerLeaseId, commentId: comment.id };
  }

  async function interrupt(errorCode: string, exited = true) {
    proof.exited = exited; proof.calls.length = 0;
    const f = await seed(errorCode);
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
    // Provider edge of release (as heartbeat-warm-stop-hold): keep_running hands the
    // box back retained; any other disposition releases it.
    const release = vi.fn(async (input: { heartbeatRunId: string; providerResourceDisposition?: string }) => {
      await db.update(environmentLeases).set(input.providerResourceDisposition === "keep_running"
        ? { status: "retained", cleanupStatus: "success" }
        : { status: "released", cleanupStatus: "success", releasedAt: new Date() })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
      return { released: [], errors: [] };
    });
    const factory = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args), releaseForRun: release,
    }));
    try {
      const heartbeat = heartbeatService(db);
      // The executor's teardown release with the admitted warm disposition.
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: f.runId, companyId: f.companyId, agentId: f.agentId,
        status: "cancelled", providerResourceDisposition: "keep_running" });
      // One dispatch pass for the queued message.
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, f.queueId);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.queueId));
      const hold = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      return { f, receipt, hold, lease, runs, release };
    } finally {
      factory.mockRestore();
    }
  }

  it("a person's Interrupt hands the warm box off; the queued message runs once on the same retained lease", async () => {
    const r = await interrupt("operator_interrupted");
    // Same shape as a Stop: released keep_running, never stop_and_retain, no preservation hold.
    expect.soft(r.release).toHaveBeenCalledWith(expect.objectContaining({ heartbeatRunId: r.f.runId, providerResourceDisposition: "keep_running" }));
    expect.soft(r.release).not.toHaveBeenCalledWith(expect.objectContaining({ providerResourceDisposition: "stop_and_retain" }));
    expect.soft(r.hold).toEqual([]);
    expect.soft(r.lease).toMatchObject({ status: "retained", releasedAt: null, providerLeaseId: r.f.providerLeaseId });
    // Admitted in this one dispatch pass, no wait.
    expect(r.receipt.payload?.executionWait).toBeUndefined();
    expect(r.receipt.status).toBe("coalesced");
    expect(r.runs.filter(run => run.id !== r.f.runId)).toHaveLength(1);
    const [successor] = r.runs.filter(run => run.id === r.receipt.runId);
    expect(successor!.contextSnapshot).toMatchObject({ previousRunId: r.f.runId });
    // The base's handoff-settled rule was the path: the s3 fence proof for this run on this box.
    expect(proof.calls).toContainEqual({ runId: r.f.runId, providerLeaseId: r.f.providerLeaseId });
    // The queued message, once.
    const envelope = await buildExecutionContinuation({ db, companyId: r.f.companyId, issueId: r.f.issueId, agentId: successor!.agentId,
      runId: successor!.id, context: successor!.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.originCommentIds).toEqual([r.f.commentId]);
    expect(envelope.messages.filter(message => message.id === r.f.commentId)).toHaveLength(1);
  }, 60_000);

  it("waits while the interrupted run's Runner is not proven exited", async () => {
    const r = await interrupt("operator_interrupted", false);
    expect(r.receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(["remote_cleanup", "workspace_repair_required"]).toContain((r.receipt.payload?.executionWait as { reason?: string })?.reason);
    expect(r.runs.map(run => run.id)).toEqual([r.f.runId]);
  }, 60_000);

  it("an integrity failure code (native_restart_recovery_blocked) still stops and retains the box", async () => {
    const r = await interrupt("native_restart_recovery_blocked");
    expect(r.release).toHaveBeenCalledWith(expect.objectContaining({ heartbeatRunId: r.f.runId, providerResourceDisposition: "stop_and_retain" }));
    expect(r.receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(r.runs.map(run => run.id)).toEqual([r.f.runId]);
  }, 60_000);
});
