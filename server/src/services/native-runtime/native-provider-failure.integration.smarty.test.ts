// Fork-only regression ports; upstream intentionally deleted the stock suite.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../../routes/issues.js";
import { errorHandler } from "../../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../principal-access-compatibility.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companyMemberships, companies, completionContracts, createDb, heartbeatRuns, issueThreadInteractions, issues, nativeRunResults, statusDecisions, workAssessments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { getNativeReviewAssignment } from "./native-review-participant.js";
import { claimQueuedNativeReviewRun } from "./native-review-dispatch.js";
import { canResumeNativeReview, resumeNativeReview } from "./resume-native-review.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

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
});
