import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../principal-access-compatibility.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companyMemberships, companies, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issueThreadInteractions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions, workAssessments } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { NATIVE_MODEL_NOT_FOUND_DIAGNOSTIC, NATIVE_MODEL_REJECTION_DIAGNOSTIC, NATIVE_MODEL_REJECTION_MESSAGE } from "./native-provider-failure.js";
import { NATIVE_RUN_FAILED_UNEXPLAINED } from "./native-run-failure-explanation.js";
import { collectRunFailureDiagnostics } from "../run-failure-diagnostics.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readPersistedNativeFailureEvidence, readPersistedNativeModelRejection } from "./native-provider-failure-evidence.js";
import { heartbeatService } from "../heartbeat.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "./native-review-participant.js";
import { claimQueuedNativeReviewRun } from "./native-review-dispatch.js";
import { canResumeNativeReview, resumeNativeReview } from "./resume-native-review.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { persistHeartbeatRunProcessMetadata } from "../heartbeat/run-lifecycle.js";
import { readNativeLocalProcessStop, releaseSettledNativeRunProcess } from "../native-local-process-stop.js";

const EXITED_PID = 4_194_304;

describe("native completed failure diagnostics", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const workerId = randomUUID();
  const model = "test-model";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-model-failure-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Native failure regression", issuePrefix: "NMF" });
    await db.insert(authUsers).values({ id: "review-operator", name: "Review operator", email: "review-operator@fixture.invalid", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "review-operator", status: "active", membershipRole: "owner" });
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: "review-operator", membershipRole: "owner", grantedByUserId: null });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native failure agent", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model } });
    await db.insert(agents).values({ id: workerId, companyId, name: "Review source worker", status: "active", adapterType: "paperclip_runner" });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  function reviewApp(actor: Express.Request["actor"] = {
    type: "board", source: "session", userId: "review-operator", companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false,
  }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function stoppedReview() {
    const issueId = randomUUID(), sourceRunId = randomUUID(), contractId = randomUUID();
    const resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID(), interactionId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Resume a person-stopped review", status: "in_review", statusVersion: 3, assigneeAgentId: workerId, responsibleUserId: "review-operator" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture",
      risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: contractId, createdByActorType: "user", createdByActorId: "review-operator" });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded",
      completionContractId: contractId, completionContractSha256: contractId });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: sourceRunId, completionContractId: contractId,
      serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId, contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress", priorStatusVersion: 2, policyVersion: "fixture", assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId, decisionVersion: 1, policyVersion: "fixture",
      fromStatus: "in_progress", toStatus: "in_review", reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: 3 }, decisionDigest: decisionId, applicationState: "applied" });
    await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, issueId));
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation", sourceRunId,
      addresseeAgentId: agentId, createdByAgentId: workerId, effectiveResolverPolicy: "anyone", resolverPolicyProvenance: "explicit",
      payload: { version: 1, prompt: "Review the completed work.", target: { type: "custom", key: "native_completion_review", revisionId: decisionId } } });
    const contextSnapshot = { issueId, wakeReason: "native_completion_review", nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId };
    const [stopped] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded", finishedAt: new Date(),
      contextSnapshot, resultJson: { personStop: { requestedAt: new Date().toISOString(), userId: "review-operator" } } }).returning();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "native_completion_review", status: "completed", runId: stopped.id,
      requestedByActorType: "system", requestedByActorId: "native-status-committer", idempotencyKey: `native-review:${interactionId}`,
      payload: { issueId, nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId } });
    return { input: { companyId, issueId, interactionId }, stopped, contextSnapshot, decisionId };
  }

  it("resumes a person-stopped native review once through durable dispatch and the existing scoped claim", async () => {
    const f = await stoppedReview();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    expect(await canResumeNativeReview(db, f.input)).toBe(true);
    const [first, second] = await Promise.all([resumeNativeReview(db, f.input), resumeNativeReview(db, f.input)]);
    expect(first).toEqual(second);
    expect(await canResumeNativeReview(db, f.input)).toBe(false);
    const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.wakeId));
    expect(intent).toMatchObject({ idempotencyKey: `native-review:${f.input.interactionId}:resume:1`, payload: {
      nativeReviewInteractionId: f.input.interactionId, nativeReviewDecisionId: f.decisionId,
      _paperclipWakeContext: { nativeReviewInteractionId: f.input.interactionId, nativeReviewDecisionId: f.decisionId, forceFreshSession: true },
    } });
    // Occupy this agent's slot so the real queue creates a run without invoking a provider.
    const [occupied] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", startedAt: new Date() }).returning();
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    try {
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId, requestId: first.wakeId });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId, requestId: first.wakeId });
      const attempts = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter(run => run.contextSnapshot?.nativeReviewInteractionId === f.input.interactionId);
      expect(attempts).toHaveLength(2);
      const resumed = attempts.find(run => run.id !== f.stopped.id)!;
      expect(resumed).toMatchObject({ status: "queued", contextSnapshot: {
        nativeReviewInteractionId: f.input.interactionId, nativeReviewDecisionId: f.decisionId,
      } });
      expect(await canResumeNativeReview(db, f.input)).toBe(false);
      await expect(resumeNativeReview(db, f.input)).rejects.toThrow("cannot be resumed");
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupied.id));
      expect(await claimQueuedNativeReviewRun(db, { run: resumed, agentNameKey: "reviewer", claimedAt: new Date(), claimValues: { runtimeMode: "native", nativeIssueId: f.input.issueId } }))
        .toMatchObject({ id: resumed.id, status: "running" });
      expect(await getNativeReviewAssignment(db, { companyId, issueId: f.input.issueId, agentId, contextSnapshot: f.contextSnapshot,
        actingRunId: resumed.id, issueExecutionRunId: resumed.id })).not.toBeNull();
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.input.issueId));
      expect(issue).toMatchObject({ assigneeAgentId: workerId, status: "in_review", statusVersion: 3, lastStatusDecisionId: f.decisionId, executionState: null });
      const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.input.interactionId));
      expect(card.status).toBe("pending");
      // A second explicit Stop stands down, then a later explicit Resume gets n=2.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), resultJson: { personStop: { requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, resumed.id));
      await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.runId, resumed.id));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.input.issueId));
      expect(await canResumeNativeReview(db, f.input)).toBe(true);
      const again = await resumeNativeReview(db, f.input);
      const [nextIntent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, again.wakeId));
      expect(nextIntent.idempotencyKey).toBe(`native-review:${f.input.interactionId}:resume:2`);
      await db.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.id, again.wakeId));
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupied.id));
    }
  }, 30_000);

  it("exposes and executes the board-only person-stopped native review action on its original card", async () => {
    const f = await stoppedReview();
    const app = reviewApp();
    const url = `/api/issues/${f.input.issueId}/interactions`;
    const before = await request(app).get(url);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body).toMatchObject([{ id: f.input.interactionId, canResumeReview: true }]);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    const [occupied] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", startedAt: new Date() }).returning();
    try {
      const responses = await Promise.all([request(app).post(`${url}/${f.input.interactionId}/resume_review`).send({}),
        request(app).post(`${url}/${f.input.interactionId}/resume_review`).send({})]);
      expect(responses.some(response => response.status === 200), JSON.stringify(responses.map(r => r.body))).toBe(true);
      expect(responses.every(response => response.status === 200 || response.status === 409)).toBe(true);
      const attempts = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter(run => run.contextSnapshot?.nativeReviewInteractionId === f.input.interactionId);
      expect(attempts).toHaveLength(2);
      expect(attempts.find(run => run.id !== f.stopped.id)).toMatchObject({ status: "queued", contextSnapshot: {
        nativeReviewInteractionId: f.input.interactionId, nativeReviewDecisionId: f.decisionId,
      } });
      const after = await request(app).get(url);
      expect(after.body).toMatchObject([{ id: f.input.interactionId, status: "pending", canResumeReview: false }]);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.input.issueId));
      expect(issue).toMatchObject({ assigneeAgentId: workerId, status: "in_review", statusVersion: 3 });
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.agentId, agentId));
      await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.agentId, agentId));
    }
  }, 30_000);

  it.each(["nativeIssueId", "contextIssueId"] as const)("denies GET and POST resume for a competing scheduled retry linked by %s without adding a wake", async link => {
    const f = await stoppedReview();
    const [competing] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native", status: "scheduled_retry",
      nativeIssueId: link === "nativeIssueId" ? f.input.issueId : null,
      contextSnapshot: link === "contextIssueId" ? { issueId: f.input.issueId } : {},
    }).returning();
    const url = `/api/issues/${f.input.issueId}/interactions`;
    const app = reviewApp();
    const wakesBefore = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    try {
      const projection = await request(app).get(url);
      expect(projection.status, JSON.stringify(projection.body)).toBe(200);
      expect(projection.body).toMatchObject([{ id: f.input.interactionId, canResumeReview: false }]);
      const post = await request(app).post(`${url}/${f.input.interactionId}/resume_review`).send({});
      expect(post.status, JSON.stringify(post.body)).toBe(409);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId))).toEqual(wakesBefore);
    } finally {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, competing.id));
    }
  });

  it("serializes a Resume press behind an actual reviewer start paused at its run-row lock", async () => {
    const f = await stoppedReview();
    const intent = await resumeNativeReview(db, f.input);
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.input.issueId,
      runtimeMode: "native", status: "queued", contextSnapshot: f.contextSnapshot, wakeupRequestId: intent.wakeId,
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: queued.id, status: "queued" }).where(eq(agentWakeupRequests.id, intent.wakeId));
    let release!: () => void;
    let locked!: (pid: number) => void;
    const runLocked = new Promise<number>(resolve => { locked = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    // Pause the real claim after it locks the issue and wake, before it locks
    // the run. PostgreSQL's blocking graph, not a sleep, proves the interleaving.
    const holder = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)).for("update");
      locked(backend.pid);
      await barrier;
    });
    const holderPid = await runLocked;
    const starting = claimQueuedNativeReviewRun(db, { run: queued, agentNameKey: "reviewer", claimedAt: new Date(),
      claimValues: { runtimeMode: "native", nativeIssueId: f.input.issueId } });
    let press: Promise<request.Response> | undefined;
    try {
      let starterPid = 0;
      await vi.waitFor(async () => {
        const blocked = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity
          where datname = current_database() and ${holderPid} = any(pg_blocking_pids(pid))`);
        expect(blocked).toHaveLength(1);
        starterPid = blocked[0].pid;
      }, { timeout: 10_000 });
      press = request(reviewApp()).post(`/api/issues/${f.input.issueId}/interactions/${f.input.interactionId}/resume_review`).send({}).then(response => response);
      await vi.waitFor(async () => {
        const blocked = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity
          where datname = current_database() and ${starterPid} = any(pg_blocking_pids(pid))`);
        expect(blocked).toHaveLength(1);
      }, { timeout: 10_000 });
    } finally {
      release();
      await holder;
      // Always settle both operations, even when the barrier observation fails.
      await Promise.allSettled([starting, ...(press ? [press] : [])]);
    }
    expect(await starting).toMatchObject({ id: queued.id, status: "running" });
    expect((await press!).status).toBe(409);
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
      .filter(wake => wake.payload?.nativeReviewInteractionId === f.input.interactionId);
    expect(wakes).toHaveLength(2); // Original Stop wake plus the one explicit Resume.
    const attempts = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
      .filter(run => run.contextSnapshot?.nativeReviewInteractionId === f.input.interactionId);
    expect(attempts).toHaveLength(2); // Stopped attempt plus the one starting attempt.
    expect((await request(reviewApp()).get(`/api/issues/${f.input.issueId}/interactions`)).body)
      .toMatchObject([{ id: f.input.interactionId, canResumeReview: false }]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, queued.id));
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, intent.wakeId));
  }, 30_000);

  it("denies agents and non-audience people the person-stopped native review action", async () => {
    const f = await stoppedReview();
    const url = `/api/issues/${f.input.issueId}/interactions/${f.input.interactionId}/resume_review`;
    const agentApp = reviewApp({ type: "agent", source: "agent_key", agentId, companyId, runId: f.stopped.id });
    expect((await request(agentApp).post(url).send({})).status).toBe(403);
    expect((await request(agentApp).get(`/api/issues/${f.input.issueId}/interactions`)).body)
      .toMatchObject([{ id: f.input.interactionId, canResumeReview: false }]);
    await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "not_creator", resolverPolicyProvenance: "explicit", createdByUserId: "review-operator" })
      .where(eq(issueThreadInteractions.id, f.input.interactionId));
    // Preserve the stock independent-review restriction, including for people.
    const denied = await request(reviewApp()).post(url).send({});
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const projection = await request(reviewApp()).get(`/api/issues/${f.input.issueId}/interactions`);
    expect(projection.body).toMatchObject([{ id: f.input.interactionId, canResumeReview: false }]);
  });

  it("allows an explicit person-stopped native review resume after dispatch skipped without creating a run", async () => {
    const f = await stoppedReview();
    const first = await resumeNativeReview(db, f.input);
    await db.update(agentWakeupRequests).set({ status: "skipped", finishedAt: new Date(), error: "Admission denied before a run" })
      .where(eq(agentWakeupRequests.id, first.wakeId));
    expect(await canResumeNativeReview(db, f.input)).toBe(true);
    const [second, duplicate] = await Promise.all([resumeNativeReview(db, f.input), resumeNativeReview(db, f.input)]);
    expect(second).toEqual(duplicate);
    expect(second.wakeId).not.toBe(first.wakeId);
    const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, second.wakeId));
    expect(intent.idempotencyKey).toBe(`native-review:${f.input.interactionId}:resume:2`);
    await db.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.id, second.wakeId));
  });

  it("revalidates person authority under the person-stopped native review locks before creating a wake", async () => {
    const f = await stoppedReview();
    const authorize = vi.fn(async ({ interaction }: { interaction: typeof issueThreadInteractions.$inferSelect }) => {
      expect(interaction.id).toBe(f.input.interactionId);
      return false;
    });
    await expect(resumeNativeReview(db, { ...f.input, authorize })).rejects.toThrow("no longer act");
    expect(authorize).toHaveBeenCalledOnce();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
      .filter(wake => wake.payload?.nativeReviewInteractionId === f.input.interactionId)).toHaveLength(1);
  });

  it.each(["not stopped", "failed stop", "live", "queued", "newer completion", "other live", "other queued", "resolved", "stale", "wrong target", "reassigned", "human only"] as const)(
    "refuses resume of a person-stopped native review when %s", async changed => {
      const f = await stoppedReview();
      if (changed === "not stopped") await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.stopped.id));
      if (changed === "failed stop") await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.stopped.id));
      if (changed === "live" || changed === "queued") await db.update(heartbeatRuns).set({ status: changed === "live" ? "running" : "queued" }).where(eq(heartbeatRuns.id, f.stopped.id));
      let otherRunId: string | undefined;
      if (changed === "newer completion" || changed === "other live" || changed === "other queued") {
        const [other] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: f.input.issueId, runtimeMode: "native",
          status: changed === "newer completion" ? "succeeded" : changed === "other live" ? "running" : "queued",
          contextSnapshot: changed === "newer completion" ? f.contextSnapshot : { issueId: f.input.issueId },
          finishedAt: changed === "newer completion" ? new Date() : null,
        }).returning();
        otherRunId = other.id;
      }
      if (changed === "resolved") await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, f.input.interactionId));
      if (changed === "stale") await db.update(issues).set({ lastStatusDecisionId: null }).where(eq(issues.id, f.input.issueId));
      if (changed === "wrong target") await db.update(issueThreadInteractions).set({ payload: { version: 1, prompt: "Not a native review" } }).where(eq(issueThreadInteractions.id, f.input.interactionId));
      if (changed === "reassigned") await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, f.input.issueId));
      if (changed === "human only") await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" }).where(eq(issueThreadInteractions.id, f.input.interactionId));
      expect(await canResumeNativeReview(db, f.input)).toBe(false);
      await expect(resumeNativeReview(db, f.input)).rejects.toThrow("cannot be resumed");
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))
        .filter(wake => wake.payload?.nativeReviewInteractionId === f.input.interactionId)).toHaveLength(1);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.stopped.id));
      if (otherRunId) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, otherRunId));
    },
  );

  it.each(["committed", "api-key", "duplicate", "pending-review", "superseded-review", "resolved-review", "reassigned", "successor-race", "different-turn", "unknown-error", "opencode-lost-server", "untrusted-source", "untrusted-run", "untrusted-session", "succeeded", "cancelled"] as const)(
    "preserves accepted results and only labels the matching provider rejection (%s)", async (scenario) => {
      const issueId = randomUUID();
      const runId = randomUUID();
      const opencode = scenario === "opencode-lost-server";
      const executionProvider = opencode ? { kind: "opencode" as const, model: `openrouter/${model}` } : { kind: "codex" as const, model };
      const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Explain a provider rejection", status: "in_progress", workMode: "standard", assigneeAgentId: agentId }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } }).returning();
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
      const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
      const execution: NativeExecutionInputV1 = {
        schema: "paperclip.native-execution-input.v1",
        binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
        provider: executionProvider,
        task: { identifier: issueId, title: issue.title, description: null, prompt: "Reply to the current message.", workMode: "standard" },
        workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: native.normalizedSessionId, driverKind: opencode ? "opencode_server" : "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
        interactionResponses: [], credentialBindings: [],
      };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
      if (scenario.endsWith("-review")) {
        const sourceRunId = randomUUID(), sourceResultId = randomUUID(), assessmentId = randomUUID();
        const decisionId = randomUUID(), interactionId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded", completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 });
        await db.insert(nativeRunResults).values({ id: sourceResultId, companyId, issueId, runId: sourceRunId, completionContractId: contract.id, serverFingerprint: sourceResultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: sourceResultId });
        await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId, contractId: contract.id, resultId: sourceResultId, triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "fixture", assessmentJson: {}, inputDigest: assessmentId });
        const [reviewIssue] = await db.update(issues).set({ status: "in_review", assigneeAgentId: workerId }).where(eq(issues.id, issueId)).returning();
        await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId, decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "explicit_review", decisionJson: { projectedStatusVersion: reviewIssue.statusVersion }, decisionDigest: decisionId, applicationState: "applied" });
        await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, issueId));
        await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation", sourceRunId, addresseeAgentId: agentId, createdByAgentId: workerId,
          continuationPolicy: "wake_assignee",
          status: scenario === "resolved-review" ? "accepted" : "pending",
          ...(scenario === "resolved-review" ? { resolvedByRunId: runId, resolvedByAgentId: agentId } : {}),
          payload: { version: 1, prompt: "Review the completed work.", target: { type: "custom", key: "native_completion_review", revisionId: decisionId } },
        });
        const contextSnapshot = { issueId, wakeReason: "native_completion_review", nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId };
        await db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, runId));
        if (scenario === "superseded-review") await db.update(issues).set({ lastStatusDecisionId: null }).where(eq(issues.id, issueId));
        const review = await getNativeReviewAssignment(db, { companyId, issueId, agentId, contextSnapshot, allowResolvedByRunId: runId });
        if (scenario === "superseded-review") expect(review).toBeNull();
        else expect(review?.interaction.status).toBe(scenario === "resolved-review" ? "accepted" : "pending");
      }
      const event: PrpEvent = {
        schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
        turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "model-terminal", sourceSeq: 1,
        sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
        payload: opencode ? { status: "failed", providerTerminalObserved: false, error: {
          code: "opencode_server_exited", message: "Private stream failure",
          opencodeFailure: { kind: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED" },
        } } : scenario === "api-key" ? { status: "failed", error: {
          // The terminal error codex 0.160.0 app-server sends with API-key auth, after its own retries.
          message: `unexpected status 404 Not Found: The model \`${model}\` does not exist or you do not have access to it., url: https://api.openai.com/v1/responses, cf-ray: a5833f01da2716ce-IAH, request id: req_584e320775c34b2c9c6d98af40e0ea3d`,
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 404 } }, additionalDetails: null, misalignment: null,
        } } : { status: "failed", error: { codexErrorInfo: "other", message: JSON.stringify({
          type: "error", status: 400, error: { type: "invalid_request_error", message: scenario === "unknown-error" ? "Private unknown failure" : `The '${model}' model is not supported when using Codex with a ChatGPT account.` },
        }) } },
      };
      const openInput = { identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock" as const, sourceInstanceId: native.runnerInstanceId };
      if (scenario === "duplicate") {
        const prior = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId, sourceInstanceId: native.runnerInstanceId, controlPlaneSourceInstanceId: "prior-controller", completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 });
        await prior.openRun(openInput);
        expect((await prior.appendEvent(event)).disposition).toBe("committed");
      }
      const turnId = scenario === "different-turn" ? "later-turn" : native.turnId;
      const terminal: PrpTerminalState = {
        schema: "paperclip.prp.terminal.v1", turnTerminalState: scenario === "succeeded" ? "completed" : scenario === "cancelled" ? "cancelled" : "failed",
        runTerminalState: scenario === "succeeded" ? "succeeded" : scenario === "cancelled" ? "cancelled" : "failed", reportedWorkDisposition: "blocked",
      };
      const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "blocked" as const,
        blocker: { reasonCode: "provider_rejected", owner: { kind: "user" as const, name: "Task owner" }, unblockAction: "Select a compatible connection.", scope: "task_wide" as const },
        completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
      provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
        await options.controlPlane.openRun(openInput);
        if (scenario === "untrusted-source") {
          await expect(options.controlPlane.appendEvent({ ...event, sourceInstanceId: "wrong-runner" })).rejects.toThrow("native_event_source_binding_mismatch");
        } else if (scenario === "untrusted-run" || scenario === "untrusted-session") {
          await expect(options.controlPlane.appendEvent({ ...event,
            ...(scenario === "untrusted-run" ? { runId: randomUUID() } : { normalizedSessionId: "wrong-session" }),
          })).rejects.toThrow("native_event_binding_mismatch");
        } else {
          expect((await options.controlPlane.appendEvent(event)).disposition).toBe(scenario === "duplicate" ? "duplicate" : "committed");
        }
        await options.controlPlane.completeRun({ result, terminal, turnId });
        return { result, terminal, turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: execution.session.driverKind, driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
      });
      const adapter = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
        descriptor: async () => { throw new Error("Unexpected provider call"); },
        openSession: async () => { throw new Error("Unexpected provider call"); },
      } });
      const expectedDiagnostic = scenario === "api-key" ? NATIVE_MODEL_NOT_FOUND_DIAGNOSTIC : NATIVE_MODEL_REJECTION_DIAGNOSTIC;
      const classified = scenario === "committed" || scenario === "api-key" || scenario === "duplicate" || scenario.endsWith("-review") || scenario === "reassigned" || scenario === "successor-race";
      const reviewAuthorityEnded = scenario === "superseded-review" || scenario === "resolved-review";
      const ownerChanged = scenario === "reassigned" || scenario === "successor-race";
      expect(adapter.errorCode).toBe(classified ? "native_provider_model_rejected" : undefined);
      // A runner-issued turn failure code names the cause instead of the generic text.
      const openCodeExplanation = "The OpenCode turn failed (opencode_server_exited). Inspect the run events for the last recorded step.";
      expect(adapter.errorMessage).toBe(classified ? NATIVE_MODEL_REJECTION_MESSAGE : scenario === "succeeded" ? null
        : opencode ? openCodeExplanation : `Native session ${terminal.runTerminalState}`);
      expect(adapter.resultJson?.nativeProviderFailure).toEqual(classified ? expectedDiagnostic : undefined);
      // Only a committed, unclassified failure of the terminal turn explains the generic message.
      const turnFailure = scenario === "unknown-error" ? { provider: "codex", category: "turn_failed", codexErrorInfo: "other" }
        : opencode ? { provider: "opencode", category: "turn_failed", runnerFailureCode: "opencode_server_exited", streamFailure: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED" }
          : undefined;
      expect(adapter.resultJson?.nativeTurnFailure).toEqual(turnFailure);
      expect(adapter.nativeFinalization).toMatchObject({ result, terminal, turnId, workspaceFinalizeStatus: "pending" });
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect(execution.provider).toEqual(executionProvider);
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(coordinator).toMatchObject({ phase: "workspace_finalizing", leaseOwner: null, attempt: 1, nextAttemptAt: null });
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toHaveLength(1);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(scenario.startsWith("untrusted-") ? 0 : 1);
      const diagnostics = collectRunFailureDiagnostics({ ...run, resultJson: adapter.resultJson ?? null }, {});
      expect(diagnostics.provider).toEqual(classified ? expectedDiagnostic : turnFailure ?? {});
      expect(JSON.stringify(diagnostics)).not.toContain(model);
      expect(JSON.stringify(diagnostics)).not.toContain("Private");
      const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(persistedRun.errorCode).toBeNull(); // No adapter metadata has been saved yet.
      expect(await readPersistedNativeModelRejection(db, persistedRun, turnId, terminal)).toEqual(classified ? {
        errorCode: "native_provider_model_rejected", errorMessage: NATIVE_MODEL_REJECTION_MESSAGE, diagnostic: expectedDiagnostic,
      } : null);
      expect((await readPersistedNativeFailureEvidence(db, persistedRun, turnId, terminal)).turnFailure).toEqual(turnFailure ?? null);
      if (classified) {
        if (scenario === "committed") {
          // Neither saved display diagnostics nor a different execution binding
          // can confer the right to change the finalizer's retry decision.
          for (const changed of [
            { ...persistedRun, runnerProfileJson: null },
            { ...persistedRun, nativeSessionId: "foreign-session" },
            { ...persistedRun, runnerInstanceId: "foreign-source" },
            { ...persistedRun, companyId: randomUUID() },
            { ...persistedRun, completionContractSha256: "foreign-contract" },
            { ...persistedRun, runnerProfileJson: { nativeExecutionInput: { ...execution, provider: { kind: "codex", model: "different-model" } } } },
            { ...persistedRun, runnerProfileJson: { nativeExecutionInput: { ...execution, binding: { ...execution.binding, runId: randomUUID() } } } },
          ]) expect(await readPersistedNativeModelRejection(db, changed, turnId, terminal)).toBeNull();
          const [stored] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
          await db.update(heartbeatRunEvents).set({ sourcePayloadSha256: "invalid-hash" }).where(eq(heartbeatRunEvents.id, stored.id));
          expect(await readPersistedNativeModelRejection(db, persistedRun, turnId, terminal)).toBeNull();
          await db.update(heartbeatRunEvents).set({ sourcePayloadSha256: stored.sourcePayloadSha256 }).where(eq(heartbeatRunEvents.id, stored.id));
        }
        // Simulate a restart after native result acceptance, before heartbeat's
        // adapter update. Finalization must use durable provider evidence.
        const acceptedBefore = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
        if (scenario === "reassigned") {
          await db.update(issues).set({ assigneeAgentId: workerId, executionRunId: null }).where(eq(issues.id, issueId));
        } else if (scenario === "successor-race") {
          const [snapshot] = await db.select().from(issues).where(eq(issues.id, issueId));
          const newerRunId = randomUUID(), raceAssessmentId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: newerRunId, companyId, agentId, status: "running", nativeIssueId: issueId });
          await db.update(issues).set({ executionRunId: newerRunId }).where(eq(issues.id, issueId));
          const [changed] = await db.select().from(issues).where(eq(issues.id, issueId));
          expect(changed.statusVersion).toBe(snapshot.statusVersion);
          await db.insert(workAssessments).values({ id: raceAssessmentId, companyId, issueId, runId, contractId: contract.id, resultId: acceptedBefore[0].id, triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: snapshot.status, priorStatusVersion: snapshot.statusVersion, policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, assessmentJson: {}, inputDigest: raceAssessmentId });
          await expect(commitNativeStatusDecision({ db, companyId, issueId, runId, assessmentId: raceAssessmentId,
            priorStatus: snapshot.status, priorStatusVersion: snapshot.statusVersion, priorDecisionId: snapshot.lastStatusDecisionId,
            requireModelRejectionOwner: { agentId, reviewContext: null },
            decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "blocked", toStatus: "blocked", reasonCode: "native_provider_model_rejected", unblockDescriptor: { owner: "board", action: NATIVE_MODEL_REJECTION_MESSAGE }, effects: [{ kind: "bind_blocker", owner: "board", action: NATIVE_MODEL_REJECTION_MESSAGE }] },
          })).rejects.toBeInstanceOf(NativeStatusRaceError);
          expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId))).toHaveLength(0);
        }
        for (let retry = 0; retry < 2; retry++) {
          await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
        }
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toEqual(acceptedBefore);
        const [finalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(finalRun).toMatchObject({ status: "failed", errorCode: "native_provider_model_rejected", error: NATIVE_MODEL_REJECTION_MESSAGE });
        expect(finalRun.resultJson?.nativeTurnFailure).toBeUndefined();
        const [finalIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
        expect(finalIssue.status).toBe(scenario.endsWith("-review") ? "in_review" : ownerChanged ? "in_progress" : "blocked");
        const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
        expect(decisions).toHaveLength(1);
        expect(decisions[0].reasonCode).toBe(reviewAuthorityEnded ? "native_review_action_finished" : ownerChanged ? "run_failed_partial_evidence_preserved" : "native_provider_model_rejected");
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
        expect(wakes.filter(wake => wake.payload?.issueId === issueId)).toHaveLength(ownerChanged ? 1 : 0);
        if (!ownerChanged) expect(await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId })).toEqual({ scanned: 0, dispatched: 0, recovered: 0, deferred: 0 });
        expect(provider.execute).toHaveBeenCalledTimes(1);
        if (scenario === "pending-review") {
          const reviewContext = readNativeReviewAssignmentContext(finalRun.contextSnapshot)!;
          expect(finalIssue).toMatchObject({ lastStatusDecisionId: reviewContext.nativeReviewDecisionId, executionRunId: null, checkoutRunId: null });
          const originalReview = await getNativeReviewAssignment(db, { companyId, issueId, agentId, contextSnapshot: reviewContext });
          expect(originalReview?.interaction.status).toBe("pending");
          expect(finalIssue.statusVersion).toBe(originalReview!.sourceDecision.decisionJson.projectedStatusVersion);
          expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

          // Exercise the real release and periodic recovery lanes, rather than
          // assuming that absence of a finalizer wake prevents later retries.
          const unexpected = vi.fn(async () => { throw new Error("Unexpected automatic recovery"); });
          const release = createReleaseIssueExecution({
            issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected, resolveSessionBeforeForWakeup: unexpected }),
            recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected },
          });
          expect((await release({ companyId, runId, now: new Date() })).outcome.kind).toBe("released");
          await heartbeatService(db).reconcileStrandedAssignedIssues();
          expect(unexpected).not.toHaveBeenCalled();
          expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
          expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId)).toHaveLength(0);
          const [afterRecovery] = await db.select().from(issues).where(eq(issues.id, issueId));
          expect(afterRecovery).toMatchObject({ status: "in_review", statusVersion: finalIssue.statusVersion, lastStatusDecisionId: finalIssue.lastStatusDecisionId });

          // The operator repairs configuration and explicitly retries the
          // assigned reviewer. No review rebinding or status reset is needed.
          await db.update(agents).set({ adapterConfig: { provider: "codex", model: "repaired-model" }, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
          // Occupy the execution slot to exercise real wake admission without
          // starting a provider. The normal atomic review claim follows below.
          const occupiedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: occupiedRunId, companyId, agentId, status: "running", startedAt: new Date() });
          const retryRun = await heartbeatService(db, { runtimeEnv: {} }).wakeup(agentId, {
            failedRunId: runId, source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run",
            requestedByActorType: "user", requestedByActorId: "review-repair-operator",
            payload: { issueId }, contextSnapshot: { ...reviewContext },
          });
          expect(retryRun).toMatchObject({ status: "queued", retryOfRunId: runId, contextSnapshot: { issueId, ...reviewContext } });
          const retryRunId = retryRun!.id;
          await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupiedRunId));
          expect(await claimQueuedNativeReviewRun(db, { run: retryRun!, agentNameKey: "reviewer", claimedAt: new Date(), claimValues: { nativeIssueId: issueId, runtimeMode: "native" } }))
            .toMatchObject({ id: retryRunId, status: "running" });
          expect(await getNativeReviewAssignment(db, { companyId, issueId, agentId, contextSnapshot: reviewContext, actingRunId: retryRunId, issueExecutionRunId: retryRunId })).not.toBeNull();
          await issueThreadInteractionService(db).acceptInteraction(
            { id: issueId, companyId, projectId: null, goalId: null, status: "in_review" },
            reviewContext.nativeReviewInteractionId, {}, { agentId, runId: retryRunId },
          );
          const [resolved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, reviewContext.nativeReviewInteractionId));
          expect(resolved).toMatchObject({ status: "accepted", resolvedByAgentId: agentId, resolvedByRunId: retryRunId });
          expect(await db.select().from(issues).where(eq(issues.id, issueId))).toMatchObject([{ status: "done", assigneeAgentId: workerId }]);
          expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toEqual(acceptedBefore);
          expect(provider.execute).toHaveBeenCalledTimes(1);
          await db.update(agents).set({ adapterConfig: { provider: "codex", model } }).where(eq(agents.id, agentId));
        }
      } else if (scenario === "unknown-error" || opencode) {
        // A lookalike diagnostic flag does not alter unknown failed-result policy.
        await db.update(heartbeatRuns).set({ resultJson: { nativeProviderFailure: NATIVE_MODEL_REJECTION_DIAGNOSTIC } }).where(eq(heartbeatRuns.id, runId));
        await persistHeartbeatRunProcessMetadata(db, runId, { pid: EXITED_PID, processGroupId: EXITED_PID, startedAt: new Date().toISOString(), targetKind: "local" });
        await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
        const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
        expect(decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
        // Recovery finalized before heartbeat saved the adapter result, so the
        // turn failure must come from the persisted runner event.
        const [finalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(finalRun.resultJson?.nativeTurnFailure).toEqual(turnFailure);
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
        expect(wakes.filter(wake => wake.payload?.issueId === issueId)).toHaveLength(1);
        if (opencode) {
          // The projected failure names the recorded runner cause, not an unexplained failure.
          await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
          const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          expect(settled).toMatchObject({ status: "failed", errorCode: NATIVE_RUN_FAILED_UNEXPLAINED.errorCode, error: openCodeExplanation });
          expect(settled.error).not.toContain("Private");
        }
        if (scenario === "unknown-error") {
          await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
          const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
          expect(coordinator.phase).toBe("committed");
          // A Codex `other` failure carries no specific cause, so it stays unexplained.
          expect(settled).toMatchObject({ status: "failed", processPid: EXITED_PID, processGroupId: EXITED_PID,
            errorCode: NATIVE_RUN_FAILED_UNEXPLAINED.errorCode, error: NATIVE_RUN_FAILED_UNEXPLAINED.error });
          await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1_000, eventType: "harness.ready" });
          expect(await releaseSettledNativeRunProcess(db, runId)).toBe("released");
          const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          expect(released).toMatchObject({ status: "failed", processPid: null, processGroupId: null, processStartedAt: null });
          expect(await readNativeLocalProcessStop(db, companyId, runId)).toMatchObject({ processPid: EXITED_PID, processGroupId: EXITED_PID });
        }
      }
    },
  );
});
