import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, costEvents, budgetPolicies,
  createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { createWakeQueue } from "../../modules/wake-queue/index.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { getNativeAddressedInteractionGrant } from "../native-runtime/native-addressed-interaction.js";
import { mergeCoalescedContextSnapshot } from "./run-preparation.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "./queue.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_QUEUE_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping addressed queue database tests: ${support.reason}`);
describe.skipIf(!support.supported)("pending addressed response execution reconstruction", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-addressed-queue");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function fixture() {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board owner", email: `${userId}@queue.test`, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Addressed queue", issuePrefix: "AQ", defaultResponsibleUserId: userId }).returning();
    const people = await db.insert(agents).values(["KA", "KP"].map(name => ({ companyId: company.id, name, role: "engineer",
      status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } } }))).returning();
    const [ka, kp] = people;
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" },
      ...people.map(agent => ({ companyId: company.id, principalType: "agent", principalId: agent.id, status: "active", membershipRole: "member" })),
    ]);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "KA owns the task", status: "in_progress",
      workMode: "standard", assigneeAgentId: ka.id, responsibleUserId: userId }).returning();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableNativeRunner: true, enableIsolatedWorkspaces: false } as
      Awaited<ReturnType<typeof deps.instanceSettings.getExperimental>>);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: deps.filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(wakeQueue.createAdmissionTransactionScope);
    deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(wakeQueue.admitWakeBehindIssueExecution);
    const held = new Map<string, () => void>();
    deps.executeRun.mockImplementation(id => new Promise<void>(resolve => { held.set(id, resolve); }));
    const queue = createHeartbeatQueue(db, deps);
    const task = async () => (await db.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
    const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    const freshKaWake = async () => {
      const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
        authorType: "user", authorUserId: userId, body: "Fresh board instruction for KA." }).returning();
      return queue.enqueueWakeup(ka.id, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: userId, allowRunCoalescing: false,
        idempotencyKey: `fresh-ka:${randomUUID()}`, payload: { issueId: issue.id, commentId: comment.id },
        contextSnapshot: { issueId: issue.id, wakeCommentId: comment.id, forceFreshSession: true } });
    };
    const close = async () => { for (const resolve of held.values()) resolve(); await Promise.all([...deps.activeRunExecutionPromises]); };
    return { userId, company, ka, kp, issue, deps, wakeQueue, queue, held, task, run, freshKaWake, close };
  }

  async function promotedResponder(f: Awaited<ReturnType<typeof fixture>>) {
    const ka1 = await f.freshKaWake();
    expect(ka1).not.toBeNull();
    f.deps.getSchedulingSuppression.mockResolvedValue({ suppressed: false, reason: null });
    expect(await f.queue.startNextQueuedRunForAgent(f.ka.id)).toEqual([expect.objectContaining({ id: ka1!.id, status: "running" })]);
    expect(f.held.has(ka1!.id)).toBe(true);
    expect(await f.task()).toMatchObject({ assigneeAgentId: f.ka.id, executionRunId: ka1!.id });
    const card = await issueThreadInteractionService(db).create(f.issue, { kind: "request_confirmation", title: "Bounded approval",
      addresseeAgentId: f.kp.id, resolverPolicy: "not_creator", continuationPolicy: "none", sourceRunId: ka1!.id,
      payload: { version: 1, prompt: "Approve the bounded plan?" } }, { agentId: f.ka.id, runId: ka1!.id, userId: null });
    const context = { issueId: f.issue.id, taskId: f.issue.id, interactionId: card.id, interactionKind: card.kind,
      sourceCommentId: card.sourceCommentId, sourceRunId: card.sourceRunId, wakeReason: "interaction_pending", source: "issue.interaction.created" };
    expect(await f.queue.enqueueWakeup(f.kp.id, { source: "automation", triggerDetail: "system", reason: "interaction_pending",
      requestedByActorType: "agent", requestedByActorId: f.ka.id, idempotencyKey: `interaction-pending:${card.id}`,
      payload: { issueId: f.issue.id, interactionId: card.id, interactionKind: card.kind, sourceRunId: card.sourceRunId,
        sourceCommentId: card.sourceCommentId, mutation: "interaction" }, contextSnapshot: context })).toBeNull();
    const [deferred] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.kp.id));
    expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
    const [finished] = await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, ka1!.id)).returning();
    f.held.get(ka1!.id)!();
    await Promise.all([...f.deps.activeRunExecutionPromises]);
    const released = await f.wakeQueue.releaseIssueExecution({ companyId: f.company.id, runId: finished.id, now: new Date(), suppressImmediateRecovery: true });
    expect(released.outcome.kind).toBe("promoted");
    const [promotedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred.id));
    expect(promotedWake).toMatchObject({ status: "queued", reason: "issue_execution_promoted", runId: expect.any(String) });
    expect(await f.task()).toMatchObject({ assigneeAgentId: f.ka.id, executionRunId: null, checkoutRunId: null });
    expect(await f.queue.startNextQueuedRunForAgent(f.kp.id)).toEqual([expect.objectContaining({ id: promotedWake.runId, status: "running" })]);
    const responder = await f.run(promotedWake.runId!);
    expect(responder).toMatchObject({ status: "running", runtimeMode: "legacy", nativeIssueId: null,
      contextSnapshot: { ...context } });
    expect(f.held.has(responder.id)).toBe(true);
    expect(await f.task()).toMatchObject({ executionRunId: null, checkoutRunId: null, assigneeAgentId: f.ka.id });
    expect(await getNativeAddressedInteractionGrant(db, { companyId: f.company.id, issueId: f.issue.id,
      agentId: f.kp.id, runId: responder.id })).toBeNull();
    f.deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    return { card, responder, source: finished };
  }

  it("does not infer the held pre-native responder as task execution when fresh KA2 arrives", async () => {
    const f = await fixture();
    try {
      const { card, responder } = await promotedResponder(f);
      const ka2 = await f.freshKaWake();
      expect.soft(await f.task()).toMatchObject({ assigneeAgentId: f.ka.id, checkoutRunId: null, executionRunId: null });
      expect(ka2, "KA2 must not be deferred behind the response-only pre-native KP run").not.toBeNull();
      expect(await f.queue.claimQueuedRun(ka2!)).toMatchObject({ id: ka2!.id, status: "running" });
      expect(await f.task()).toMatchObject({ assigneeAgentId: f.ka.id, checkoutRunId: null, executionRunId: ka2!.id });
      expect(await f.run(responder.id)).toMatchObject({ status: "running", runtimeMode: "legacy", nativeIssueId: null });
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)))[0])
        .toMatchObject({ status: "pending", sourceRunId: card.sourceRunId });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, ka2!.id)))[0])
        .toMatchObject({ requestedByActorType: "user" });
    } finally { await f.close(); }
  });

  it.each([false, true])("reconstructs the next legitimate ordinary owner (earlier responder: %s)", async earlierResponder => {
    const f = await fixture();
    try {
      if (earlierResponder) {
        const { responder } = await promotedResponder(f);
        await db.update(heartbeatRuns).set({ createdAt: new Date(0) }).where(eq(heartbeatRuns.id, responder.id));
      }
      const [owner] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.ka.id,
        status: "running", invocationSource: "on_demand", responsibleUserId: f.userId,
        contextSnapshot: { issueId: f.issue.id }, createdAt: new Date(1000) }).returning();
      expect(await f.freshKaWake()).toBeNull();
      expect(await f.task()).toMatchObject({ executionRunId: owner.id, checkoutRunId: null, assigneeAgentId: f.ka.id });
      const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.ka.id));
      expect(deferred.some(wake => wake.status === "deferred_issue_execution" && wake.runId === null)).toBe(true);
    } finally { await f.close(); }
  });

  it("preserves reconstruction for an ordinary nonassignee mention", async () => {
    const f = await fixture();
    try {
      const [mention] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.kp.id,
        status: "running", contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_comment_mentioned" } }).returning();
      expect(await f.freshKaWake()).toBeNull();
      expect(await f.task()).toMatchObject({ executionRunId: mention.id, checkoutRunId: null, assigneeAgentId: f.ka.id });
    } finally { await f.close(); }
  });

  it("preserves a deferred fresh KA wake through clean ordinary-source release and promotion", async () => {
    const f = await fixture();
    try {
      const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.ka.id,
        status: "running", responsibleUserId: f.userId, contextSnapshot: { issueId: f.issue.id } }).returning();
      expect(await f.freshKaWake()).toBeNull();
      const [before] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.ka.id));
      expect(before).toMatchObject({ status: "deferred_issue_execution", runId: null,
        payload: { _paperclipWakeContext: { forceFreshSession: true, issueId: f.issue.id } } });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.id));
      const result = await f.wakeQueue.releaseIssueExecution({ companyId: f.company.id, runId: source.id,
        now: new Date(), suppressImmediateRecovery: true });
      expect(result.outcome.kind).toBe("promoted");
      const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, before.id));
      expect(after).toMatchObject({ id: before.id, status: "queued", reason: "issue_execution_promoted", runId: expect.any(String),
        idempotencyKey: before.idempotencyKey, requestedByActorId: f.userId });
      expect(await f.run(after.runId!)).toMatchObject({ agentId: f.ka.id, status: "queued",
        contextSnapshot: { issueId: f.issue.id, forceFreshSession: true } });
      expect(await f.task()).toMatchObject({ executionRunId: after.runId, assigneeAgentId: f.ka.id });
    } finally { await f.close(); }
  });

  it.each(["revoked", "wrong card", "malformed card", "malformed review", "wrong addressee", "creator", "human only", "governed", "private", "closed", "paused", "budget", "wrong source", "foreign card"] as const)(
    "does not turn invalid addressed context into ordinary execution: %s", async invalid => {
      const f = await fixture();
      try {
        const { card, responder } = await promotedResponder(f);
        if (invalid === "revoked") await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, card.id));
        if (invalid === "wrong card") await db.update(heartbeatRuns).set({ contextSnapshot: { ...responder.contextSnapshot, interactionId: randomUUID() } }).where(eq(heartbeatRuns.id, responder.id));
        if (invalid === "malformed card") await db.update(heartbeatRuns).set({ contextSnapshot: { ...responder.contextSnapshot, interactionId: "not-a-card-id" } }).where(eq(heartbeatRuns.id, responder.id));
        if (invalid === "malformed review") await db.update(heartbeatRuns).set({ contextSnapshot: { ...responder.contextSnapshot, nativeReviewInteractionId: "not-a-review-id" } }).where(eq(heartbeatRuns.id, responder.id));
        if (invalid === "wrong addressee") await db.update(issueThreadInteractions).set({ addresseeAgentId: f.ka.id }).where(eq(issueThreadInteractions.id, card.id));
        if (invalid === "creator") await db.update(issueThreadInteractions).set({ createdByAgentId: f.kp.id }).where(eq(issueThreadInteractions.id, card.id));
        if (invalid === "human only") await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" }).where(eq(issueThreadInteractions.id, card.id));
        if (invalid === "governed") await db.update(issueThreadInteractions).set({ payload: { version: 1, prompt: "Governed", target: { type: "custom", key: "native_completion_review", revisionId: randomUUID() } } }).where(eq(issueThreadInteractions.id, card.id));
        if (invalid === "private") await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issue.id));
        if (invalid === "closed") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issue.id));
        if (invalid === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.kp.id));
        if (invalid === "budget") {
          await db.insert(budgetPolicies).values({ companyId: f.company.id, scopeType: "agent", scopeId: f.kp.id,
            windowKind: "lifetime", amount: 1, hardStopEnabled: true, isActive: true });
          await db.insert(costEvents).values({ companyId: f.company.id, agentId: f.kp.id, provider: "test", model: "test", costCents: 5, occurredAt: new Date() });
        }
        if (invalid === "wrong source") await db.update(heartbeatRuns).set({ contextSnapshot: { ...responder.contextSnapshot, sourceRunId: randomUUID() } }).where(eq(heartbeatRuns.id, responder.id));
        if (invalid === "foreign card") {
          const [foreign] = await db.insert(companies).values({ name: "Other company", issuePrefix: "OTHER" }).returning();
          await db.update(issueThreadInteractions).set({ companyId: foreign.id }).where(eq(issueThreadInteractions.id, card.id));
        }
        await f.freshKaWake().catch(error => { expect([403, 409]).toContain(error.status); return null; });
        expect((await f.task()).executionRunId).not.toBe(responder.id);
        expect((await f.task()).checkoutRunId).not.toBe(responder.id);
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issue.id }).where(eq(heartbeatRuns.id, responder.id));
        expect(await getNativeAddressedInteractionGrant(db, { companyId: f.company.id,
          issueId: f.issue.id, agentId: f.kp.id, runId: responder.id })).toBeNull();
      } finally { await f.close(); }
    });
});
