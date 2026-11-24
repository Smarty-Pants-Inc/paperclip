import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";

// Real PostgreSQL + production receipt admission/dispatch. Only the provider is
// deterministic: it saves a reply for each delivered comment, not a mock-call assertion.
const provider = vi.hoisted(() => ({ answer: async (_input: AdapterExecutionContext) => {} }));
vi.mock("../adapters/index.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../adapters/index.ts")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: async (input: AdapterExecutionContext) => {
    await provider.answer(input);
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Answered saved message.", provider: "test", model: "test" };
  } }),
}));

describe("resolved-action saved person receipt admission (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("cs0406-resolved-wakes-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    provider.answer = async input => {
      const ids = input.context.wakeCommentIds as string[] | undefined;
      for (const id of ids ?? []) await db.insert(issueComments).values({ companyId: input.agent.companyId,
        issueId: String(input.context.issueId), authorType: "agent", authorAgentId: input.agent.id,
        createdByRunId: input.runId, body: `Reply to saved ${id}` });
    };
  }, 60_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function seed(status = "resolved", outcome = "false_positive", count = 2) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), actionId = randomUUID(), runId = randomUUID(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Saved-message recovery", issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6)}`,
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer saved person input", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId });
    const stoppedAt = new Date(Date.now() - 120_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "cancelled", runtimeMode: "legacy",
      finishedAt: stoppedAt, createdAt: new Date(stoppedAt.getTime() - 1000), errorCode: "cancelled",
      contextSnapshot: { issueId }, resultJson: { executionCancellation: { state: "acknowledged", proof: "preparation_settled" },
        cancellation: { recordedAt: stoppedAt.toISOString(), reason: "Operator stopped this task",
          initiator: { type: "user", id: userId }, source: "operator", expected: true } } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId, kind: "execution_reconciliation", status, outcome,
      resolvedAt: status === "resolved" ? new Date() : null, cause: "legacy_execution_requires_reconciliation", fingerprint: `saved:${runId}`,
      ownerType: "system", nextAction: "Review recovery", evidence: outcome === "blocked"
        ? { runId, automaticRecovery: { replay: "blocked" }, workspaceRestoreFailure: "restore_unsafe_archive" } : { runId } });
    const receipts = [];
    for (let index = 0; index < count; index++) {
      const requestedAt = new Date(stoppedAt.getTime() + 1000 + index * 1000);
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
        body: `Saved message ${index}`, createdAt: requestedAt }).returning();
      const context = { issueId, taskId: issueId, commentId: comment!.id, wakeCommentId: comment!.id, wakeCommentIds: [comment!.id],
        wakeReason: "issue_commented", originalMarker: `context-${index}` };
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
        reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: userId,
        requestedAt, updatedAt: requestedAt, idempotencyKey: `comment:${comment!.id}`, payload: { issueId, commentId: comment!.id,
          originalMarker: `payload-${index}`, _paperclipWakeContext: context, executionWait: { reason: "execution_recovery", recoveryActionId: actionId } } }).returning();
      receipts.push({ wake: wake!, comment: comment! });
    }
    return { companyId, agentId, issueId, actionId, runId, userId, receipts };
  }
  const receiptsFor = (f: Awaited<ReturnType<typeof seed>>) => db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, f.companyId)).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
  function queue() {
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    deps.instanceSettings.getExperimental.mockImplementation(instanceSettingsService(db).getExperimental);
    deps.getAgentInvokability.mockImplementation(agent => evaluateAgentInvokabilityFromDb(db, agent));
    // Keep a newly admitted run queued so oldest selection is directly observable.
    deps.isRunAdmissionClosed = () => true;
    return createHeartbeatQueue(db, deps);
  }

  it("a later receipt hint admits the oldest original person receipt, then answers every message once in order", async () => {
    const f = await seed();
    const q = queue();
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: f.receipts[1]!.wake.id });
    const rows = await receiptsFor(f);
    expect(rows[0]!.runId, "resolved false_positive must reconsider the saved head instead of the cancelled run release").not.toBeNull();
    const [firstRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, rows[0]!.runId!));
    expect(firstRun!.contextSnapshot).toMatchObject({ originalMarker: "context-0", wakeCommentId: f.receipts[0]!.comment.id });
    expect(rows[0]).toMatchObject({ id: f.receipts[0]!.wake.id, requestedByActorId: f.userId,
      idempotencyKey: f.receipts[0]!.wake.idempotencyKey, payload: { originalMarker: "payload-0" } });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await vi.waitFor(async () => {
      const replies = await db.select().from(issueComments).where(and(eq(issueComments.companyId, f.companyId), eq(issueComments.authorType, "agent"), sql`${issueComments.body} like 'Reply to saved %'`)).orderBy(asc(issueComments.createdAt));
      expect(replies.map(reply => reply.body)).toEqual(f.receipts.map(receipt => `Reply to saved ${receipt.comment.id}`));
    }, { timeout: 20_000 });
    await Promise.all([q.resumeDeferredExecutionReceipts({ companyId: f.companyId }), q.resumeDeferredExecutionReceipts({ companyId: f.companyId })]);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(issueComments).where(and(eq(issueComments.companyId, f.companyId),
      eq(issueComments.authorType, "agent"), sql`${issueComments.body} like 'Reply to saved %'`))).toHaveLength(2);
    const delivered = (await receiptsFor(f)).filter(row => f.receipts.some(receipt => receipt.wake.id === row.id));
    expect(delivered.every(row => row.runId !== null)).toBe(true);
    console.info("cs0406 delivered receipt evidence", JSON.stringify(delivered.map(row => ({ id: row.id, status: row.status,
      runId: row.runId, idempotencyKey: row.idempotencyKey, actorId: row.requestedByActorId }))));
  }, 90_000);

  it("a resolved blocked action with an effective hold saves one visible notice, never a run, across concurrent replay", async () => {
    const f = await seed("resolved", "blocked");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    const q = queue();
    await Promise.all([q.resumeDeferredExecutionReceipts({ companyId: f.companyId }), q.resumeDeferredExecutionReceipts({ companyId: f.companyId })]);
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId });
    expect((await receiptsFor(f)).map(wake => ({ status: wake.status, runId: wake.runId }))).toEqual([
      { status: "deferred_issue_execution", runId: null }, { status: "deferred_issue_execution", runId: null }]);
    const notices = await db.select().from(issueComments).where(and(eq(issueComments.companyId, f.companyId), sql`${issueComments.presentation}->>'kind' = 'system_notice'`));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/Couldn't answer.*message is saved.*press Retry/s);
    console.info("cs0406 remaining-hold notice evidence", JSON.stringify({ actionId: f.actionId, noticeId: notices[0]!.id, body: notices[0]!.body }));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

  it("uses receipt ID to break requestedAt ties, even when hinted for the other receipt", async () => {
    const f = await seed();
    const at = f.receipts[0]!.wake.requestedAt;
    await db.update(agentWakeupRequests).set({ requestedAt: at }).where(eq(agentWakeupRequests.companyId, f.companyId));
    const ordered = [...f.receipts].sort((a, b) => a.wake.id.localeCompare(b.wake.id));
    await queue().resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: ordered[1]!.wake.id });
    const rows = await receiptsFor(f);
    expect(rows[0]!.id).toBe(ordered[0]!.wake.id);
    expect(rows[0]!.runId).not.toBeNull();
    expect(rows[1]!.runId).toBeNull();
  }, 30_000);

  it("never launches a later receipt ahead of a refused head or undoes an earlier Stop", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    const q = queue();
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: f.receipts[1]!.wake.id });
    expect((await receiptsFor(f)).every(row => row.runId === null)).toBe(true);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const beforeStop = new Date(Date.now() - 240_000);
    await db.update(agentWakeupRequests).set({ requestedAt: beforeStop }).where(eq(agentWakeupRequests.id, f.receipts[0]!.wake.id));
    await db.update(issueComments).set({ createdAt: beforeStop }).where(eq(issueComments.id, f.receipts[0]!.comment.id));
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: f.receipts[1]!.wake.id });
    expect((await receiptsFor(f)).every(row => row.runId === null)).toBe(true);
  }, 30_000);

  it("removes already-delivered comments from a partly consumed receipt under ordinary admission", async () => {
    const f = await seed();
    const [first, second] = f.receipts;
    const payload = { ...first!.wake.payload, commentId: second!.comment.id, _paperclipWakeContext: {
      ...second!.wake.payload!._paperclipWakeContext as object, wakeCommentIds: [first!.comment.id, second!.comment.id],
    } };
    await db.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, first!.wake.id));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, second!.wake.id));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "succeeded", startedAt: new Date(Date.now() - 90_000), finishedAt: new Date(Date.now() - 80_000),
      contextSnapshot: { issueId: f.issueId, wakeCommentId: first!.comment.id, wakeCommentIds: [first!.comment.id] } });
    const q = queue();
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId });
    const [adopted] = await receiptsFor(f);
    expect(adopted!.runId).not.toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, adopted!.runId!));
    expect(run!.contextSnapshot!.wakeCommentIds).toEqual([second!.comment.id]);
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId });
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
  }, 30_000);

  it.each(["restored", "blocked", "superseded"])("rechecks normal admission for resolved outcome %s rather than treating outcome as authority", async outcome => {
    const f = await seed("resolved", outcome, 1);
    await db.update(issueRecoveryActions).set({ evidence: { runId: f.runId } }).where(eq(issueRecoveryActions.id, f.actionId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    await queue().resumeDeferredExecutionReceipts({ companyId: f.companyId });
    expect((await receiptsFor(f))[0]!.runId).not.toBeNull();
  }, 30_000);

  it("does not overtake a saved person head that normal comment admission cannot resume", async () => {
    const f = await seed();
    const first = f.receipts[0]!;
    await db.update(agentWakeupRequests).set({ payload: { ...first.wake.payload,
      _paperclipWakeContext: { issueId: f.issueId, mutation: "interaction" } } }).where(eq(agentWakeupRequests.id, first.wake.id));
    await queue().resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: f.receipts[1]!.wake.id });
    expect((await receiptsFor(f)).every(row => row.runId === null)).toBe(true);
  }, 30_000);

  it("does not reconsider an unresolved action or a resolved action on another task/company", async () => {
    const f = await seed("active", "blocked");
    const q = queue();
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId });
    const otherId = randomUUID();
    await db.insert(issues).values({ id: otherId, companyId: f.companyId, title: "Different task" });
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "false_positive", evidence: { runId: f.runId }, sourceIssueId: otherId }).where(eq(issueRecoveryActions.id, f.actionId));
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId });
    expect((await receiptsFor(f)).every(row => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
    const other = await seed("resolved", "false_positive", 0);
    await db.update(agentWakeupRequests).set({ payload: { ...f.receipts[0]!.wake.payload,
      executionWait: { reason: "execution_recovery", recoveryActionId: other.actionId } } }).where(eq(agentWakeupRequests.id, f.receipts[0]!.wake.id));
    await q.resumeDeferredExecutionReceipts({ companyId: f.companyId });
    expect((await receiptsFor(f)).every(row => row.runId === null)).toBe(true);
    expect(await db.select().from(issueComments).where(and(eq(issueComments.companyId, f.companyId), sql`${issueComments.presentation}->>'kind' = 'system_notice'`))).toHaveLength(0);
  }, 30_000);
});
