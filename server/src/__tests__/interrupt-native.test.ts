import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-interrupt-native (Paul 11-19 06:09, run 4ab771de on bx_2zh7rjqa): a person's
// Interrupt of a LIVE native paperclip_runner turn on a warm (keep_running) box, with a
// held message. Real Interrupt route (GET queue + POST /issues/:id/queued-comments/interrupt,
// as the UI calls it), real cancelRun, the executor's real teardown release
// (heartbeat.releaseEnvironmentLeasesForRun with the admitted keep_running disposition),
// the real cancelled-workspace sweep (preserveCancelledNativeWorkspaces) and real
// admission (resumeQueuedCommentInterrupt). Scripted provider edges only: the Runner's
// acknowledgement of the run-only cancel (as interrupt-rows' settleInterrupt) and the
// orchestrator's releaseForRun (keep_running hands the box back retained, any other
// disposition stops/releases it), as explicit-native-interrupt-handoff did.
// Provider edge: the interrupted turn's Runner session is live in this process, so
// the run-only cancel is dispatched to it (dispatched: true), as on Paul's box
// (no native-continuation card at the 06:09:37 click; the card came at 06:09:42
// from the stop_and_retain release's file preservation).
const runnerExitedProof = vi.hoisted(() => ({ exited: true, calls: [] as Array<{ runId: string; providerLeaseId: string | null }> }));
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  const { createDb: connect, heartbeatRuns: runs } = await import("@paperclipai/db");
  const { eq: same } = await import("drizzle-orm");
  return {
    ...actual,
    // Provider edge (needs a live Boat Runner, as explicit-native-send-after-stop):
    // the s3 fence's proof that the handed-off warm owner's Runner exited.
    handedOffWarmOwnerRunnerExited: async (input: { runId: string; providerLeaseId: string | null }) => {
      runnerExitedProof.calls.push(input);
      return runnerExitedProof.exited;
    },
    cancelNativeSession: (async (...args: Parameters<typeof actual.cancelNativeSession>) => {
      const result = await actual.cancelNativeSession(...args);
      const db = args[2]?.db as ReturnType<typeof connect> | undefined;
      if (db && typeof result === "object" && result) {
        const [run] = await db.select().from(runs).where(same(runs.id, args[0]));
        const intent = run?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        if (intent?.dispatchState === "acknowledged") await db.update(runs).set({ resultJson: { ...run!.resultJson,
          nativeCancellation: { ...intent, dispatched: true } } }).where(same(runs.id, args[0]));
        return { ...result, dispatched: true };
      }
      return result;
    }) as typeof actual.cancelNativeSession,
  };
});
const environmentOrchestrator = await import("../services/environment-run-orchestrator.js");
const { heartbeatService } = await import("../services/heartbeat.js");
const { issueRoutes } = await import("../routes/issues.js");
const { errorHandler } = await import("../middleware/index.js");
const { instanceSettingsService } = await import("../services/instance-settings.js");
const { preserveCancelledNativeWorkspaces } = await import("../services/native-runtime/native-failed-workspace-recovery.js");
const { unansweredPersonMessageCommentCondition } = await import("../services/recovery/unanswered-person-message.js");

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("Interrupt of a live native turn (Paul 11-19 06:09)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "in-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-native-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "in@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.IN_EVIDENCE) await fs.appendFile(process.env.IN_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };

  async function seedLiveNativeTurn() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), liveRunId = randomUUID();
    const wakeId = randomUUID(), leaseId = randomUUID(), providerLeaseId = "bx_2zh7rjqa";
    const [own, held] = [randomUUID(), randomUUID()];
    const issuePrefix = `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "IN", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Boat Pi", role: "engineer", status: "running",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000);
    // The live native turn on the warm box: admitted keep_running, its workspace prepared there.
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", runtimeMode: "native", startedAt: t(3), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: own, commentId: own, wakeCommentIds: [own], responsibleUserId: userId },
      runnerProfileJson: { nativeResourceDisposition: "keep_running", nativeWorkspaceSync: { state: "prepared",
        schema: "paperclip.native-workspace-sync/v3", leaseId, remoteCwd: "/home/user/paperclip-workspace", workspaceId: randomUUID(),
        baselineSha256: "a".repeat(64), finalHostSha256: null, providerLeaseId, descriptorSha256: "b".repeat(64),
        resourceDisposition: "keep_running" } } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, title: "Chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", responsibleUserId: userId, executionRunId: liveRunId });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId }).where(eq(heartbeatRuns.id, liveRunId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: liveRunId, provider: "daytona",
      providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/home/user/paperclip-workspace" } });
    await db.insert(issueComments).values([[own, "OWN", 2], [held, "MSG 1", 4]].map(([id, body, m]) => ({
      id: id as string, companyId, issueId, authorType: "user" as const, authorUserId: userId, body: body as string,
      createdAt: t(m as number), updatedAt: t(m as number) })));
    // The live turn answered its own message before the Interrupt; MSG 1 is held.
    await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId, authorType: "agent",
      createdByRunId: liveRunId, origin: "comment", body: "answer to OWN", createdAt: t(3), updatedAt: t(3) });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: userId, payload: { issueId, commentId: held,
        _paperclipWakeContext: { commentId: held, wakeCommentId: held, wakeCommentIds: [held] } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: liveRunId, phase: "observed" });
    // Keeps the successor in the ordinary queue (no provider launch), as interrupt-rows does.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use(errorHandler);
    return { companyId, agentId, issueId, liveRunId, wakeId, leaseId, providerLeaseId, held, client };
  }

  it("the successor carrying the held message is admitted on the same box, answered once, with no reconciliation card", async () => {
    const f = await seedLiveNativeTurn();
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
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
      // 1. The person's real Interrupt click on the live turn.
      const queue = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      const pressed = await request(f.client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
        .send({ queueId: queue.body.queueId, targetRunId: f.liveRunId, revision: queue.body.revision });
      expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
      expect(stopped.status).toBe("cancelled");
      expect(stopped.errorCode).toBe("operator_interrupted");
      await evidence("stopped_native_cancellation", stopped.resultJson?.nativeCancellation ?? null);
      await evidence("cards_after_click", (await db.select().from(issueRecoveryActions).where(
        eq(issueRecoveryActions.sourceIssueId, f.issueId))).map(card => card.fingerprint));
      // 2. The Runner acknowledges the run-only cancel (provider edge), then the
      //    executor's teardown releases the lease with the admitted disposition.
      // The Runner had launched (its process identity), as 4ab771de's had.
      await db.update(heartbeatRuns).set({ processPid: 999_999_999, processGroupId: null })
        .where(eq(heartbeatRuns.id, f.liveRunId));
      await db.update(heartbeatRuns).set({ resultJson: { ...stopped.resultJson,
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.liveRunId, companyId: f.companyId,
          issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: new Date().toISOString() } } })
        .where(eq(heartbeatRuns.id, f.liveRunId));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, failureCode: "native_retry_cancelled" })
        .where(eq(nativeRunFinalizations.runId, f.liveRunId));
      const heartbeat = heartbeatService(db);
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: f.liveRunId, companyId: f.companyId, agentId: f.agentId,
        status: "cancelled", providerResourceDisposition: "keep_running" });
      // 3. The cancelled-workspace sweep (the other producer of the native-workspace hold).
      await preserveCancelledNativeWorkspaces(db);
      // 4. The receipt worker resumes the Interrupt (dispatch pass).
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, pressed.body.queueId ?? queue.body.queueId);
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queue.body.queueId);

      const cards = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, f.issueId)));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      await evidence("release_calls", release.mock.calls.map(([input]) => input.providerResourceDisposition));
      await evidence("cards", cards.map(card => ({ cause: card.cause, fingerprint: card.fingerprint, status: card.status })));
      await evidence("lease", { status: lease.status, providerLeaseId: lease.providerLeaseId, releasedAt: lease.releasedAt });
      await evidence("wake", { status: wake.status, runId: wake.runId, executionWait: wake.payload?.executionWait ?? null });
      await evidence("runs", runs.map(run => ({ id: run.id === f.liveRunId ? "interrupted" : run.id, status: run.status,
        errorCode: run.errorCode, wakeCommentIds: run.contextSnapshot?.wakeCommentIds ?? null })));

      // No card for the person's own Interrupt (no native_continuation_requires_reconciliation hold).
      expect.soft(cards.map(card => card.cause)).toEqual([]);
      // The warm box is handed off, not stopped: same box for the successor.
      expect.soft(release).not.toHaveBeenCalledWith(expect.objectContaining({ providerResourceDisposition: "stop_and_retain" }));
      expect.soft(lease).toMatchObject({ status: "retained", releasedAt: null, providerLeaseId: f.providerLeaseId });
      // The successor carrying MSG 1 is admitted (not waiting) and never fails the retirement fence.
      const successors = runs.filter(run => run.id !== f.liveRunId);
      expect(successors.map(run => run.errorCode)).not.toContain("native_predecessor_retirement_unproven");
      const carrying = successors.filter(run => ((run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(f.held));
      expect(carrying).toHaveLength(1);
      expect(wake).toMatchObject({ status: "coalesced", runId: carrying[0]!.id });
      expect(["queued", "running"]).toContain(carrying[0]!.status);
      // The base's handoff-settled rule was the path: the s3 fence proof for the interrupted run on this box.
      expect(runnerExitedProof.calls).toContainEqual({ runId: f.liveRunId, providerLeaseId: f.providerLeaseId });
      // The successor answers: MSG 1 is answered exactly once.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, carrying[0]!.id));
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
        authorType: "agent", createdByRunId: carrying[0]!.id, origin: "comment", body: "answer to MSG 1" });
      const unanswered = await db.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.issueId, f.issueId), inArray(issueComments.id, [f.held]), unansweredPersonMessageCommentCondition()));
      expect(unanswered).toEqual([]);
    } finally {
      factory.mockRestore();
    }
  }, 120_000);
});
