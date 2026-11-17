import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "./continuation-comment-input.js";
import { claimFirstTurnQueuedInput } from "./native-runtime/first-turn-queued-input.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { requestTaskRetry } from "./task-retry.js";
import { heartbeatService } from "./heartbeat.js";

// DREA-31 / data safety: exercise persisted input and answer attribution, not SQL text.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("continuation pending person input", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("continuation-input-"); db = createDb(database.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Carry input", issuePrefix: `C${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [message] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "board", body: "Recall COBALT" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id,
      runtimeMode: "native", status: "failed", responsibleUserId: "board", contextSnapshot: { issueId: issue.id, wakeCommentId: message.id } }).returning();
    return { companyId: company.id, issueId: issue.id, agentId: agent.id, run, message };
  }

  it("carries first-turn input ids and source wake ids without copying the parent's receipt", async () => {
    const f = await fixture();
    const wakeId = randomUUID();
    const input = await pendingContinuationCommentInput(db, { ...f, contextSnapshot: { issueId: f.issueId,
      firstTurnQueuedInput: { schema: "paperclip.first-turn-queued-input.v1", runId: f.run.id,
        claimedAt: new Date().toISOString(), commentIds: [f.message.id], wakeupRequestIds: [wakeId] } } });
    expect(input).toMatchObject({ wakeCommentId: f.message.id, wakeCommentIds: [f.message.id],
      queuedCommentSourceWakeIds: [wakeId], firstTurnQueuedInput: null, commentContinuation: true });
  });

  it("supersedes(ANSWERED blob, RFL 21:28Z/22:41Z): carries the parent's comment ids as-is; a later reply does not erase them", async () => {
    // Reason: the carry reads ANSWERED (completedPersonMessageAnswerSql). The FAILED parent's own reply is a
    // progress reply, DELIVERED only, so the comment is still carried (RFL F1); a completed run's final answer ends it.
    const f = await fixture();
    const [other] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, contextSnapshot: { issueId: f.issueId } }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: other.id, body: "Unrelated work" });
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ wakeCommentIds: [f.message.id] });
    // RFL 20:06Z (J3'/J6'): a reply by a run whose context held only an EARLIER person comment does not answer this one.
    const [earlier] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "board",
      body: "Earlier", createdAt: new Date(f.message.createdAt.getTime() - 60_000) }).returning();
    const [earlierRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      contextSnapshot: { issueId: f.issueId, wakeCommentId: earlier.id } }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: earlierRun.id, body: "Answer to the earlier one" });
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ wakeCommentIds: [f.message.id] });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: f.run.id, body: "COBALT (progress)" });
    // RFL F1 21:28Z: the FAILED parent's own reply is DELIVERED, not ANSWERED: the carry still carries the comment.
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ wakeCommentIds: [f.message.id] });
    const [done] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "succeeded", contextSnapshot: { issueId: f.issueId, wakeCommentIds: [f.message.id] } }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: done.id, body: "COBALT" });
    // A completed run that carried the comment as its OWN input published the final answer: ANSWERED, never carried again.
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toEqual({});
  });

  it("keeps all live comment authors within the source company and task", async () => {
    const f = await fixture(), foreign = await fixture();
    const [deleted, agentComment] = await db.insert(issueComments).values([
      { companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "board", body: "Deleted", deletedAt: new Date() },
      { companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId, body: "Agent work", createdAt: new Date(Date.now() - 60_000) },
    ]).returning();
    expect(await pendingContinuationCommentInput(db, { ...f, contextSnapshot: {
      wakeCommentIds: ["malformed-id", foreign.message.id, deleted.id, agentComment.id, f.message.id, f.message.id],
    } })).toMatchObject({ wakeCommentIds: [agentComment.id, f.message.id] });
    expect(await readContinuationCommentInput(db, { ...foreign, runId: f.run.id })).toEqual({});
    expect(await readContinuationCommentInput(db, { ...f, issueId: foreign.issueId, runId: f.run.id })).toEqual({});
  });

  it("does not claim carried input when another run owns the task", async () => {
    const f = await fixture();
    const context = await readContinuationCommentInput(db, { ...f, runId: f.run.id });
    await db.update(heartbeatRuns).set({ status: "running", contextSnapshot: { issueId: f.issueId, ...context } })
      .where(eq(heartbeatRuns.id, f.run.id));
    expect(await claimFirstTurnQueuedInput(db, { ...f, runId: f.run.id })).toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.contextSnapshot?.firstTurnQueuedInput).toMatchObject({ commentIds: [] });
  });

  it("does not manufacture comment intent for ordinary work", async () => {
    const f = await fixture();
    expect(await pendingContinuationCommentInput(db, { ...f, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } })).toEqual({});
    // No source run is an initial assignment, not a comment continuation.
    expect(await readContinuationCommentInput(db, { ...f, runId: null })).toEqual({});
  });
  // H3 (A), RFL verdict: the ONE shared seam carries a person's answer for every caller.
  async function answeredFixture() {
    const [c] = await db.insert(companies).values({ name: "SRA", issuePrefix: "SRA" + randomUUID().slice(0, 5) }).returning();
    const [a] = await db.insert(agents).values({ companyId: c.id, name: "Question owner", adapterType: "process" }).returning();
    const [b] = await db.insert(agents).values({ companyId: c.id, name: "Foreign agent", adapterType: "process" }).returning();
    const [i, j] = await db.insert(issues).values([{ companyId: c.id, title: "This task", status: "in_progress", assigneeAgentId: a.id },
      { companyId: c.id, title: "Other task", assigneeAgentId: a.id }]).returning();
    const [m] = await db.insert(issueComments).values({ companyId: c.id, issueId: i.id, authorType: "user", authorUserId: "board", body: "Old asking turn" }).returning();
    const base = { companyId: c.id, issueId: i.id, kind: "ask_user_questions", status: "answered", createdByAgentId: a.id, resolvedByUserId: "board",
      resolvedAt: new Date(), title: "Continue?", payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", required: true, selectionMode: "single",
        options: [{ id: "yes", label: "YES" }] }] }, result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }], summaryMarkdown: "YES" } };
    const [good, foreign, other, pending, stale, agentResolved] = await db.insert(issueThreadInteractions).values([
      { ...base, idempotencyKey: randomUUID() }, { ...base, idempotencyKey: randomUUID(), createdByAgentId: b.id },
      { ...base, idempotencyKey: randomUUID(), issueId: j.id },
      { ...base, idempotencyKey: randomUUID(), status: "pending", resolvedByUserId: null, resolvedAt: null, result: null },
      { ...base, idempotencyKey: randomUUID(), status: "expired", result: { outcome: "stale_target" } },
      { ...base, idempotencyKey: randomUUID(), resolvedByUserId: null, resolvedByAgentId: b.id },
    ] as never).returning();
    const context = { issueId: i.id, interactionId: good.id, interactionIds: [good.id, foreign.id, other.id, pending.id, stale.id, agentResolved.id, "bad-id"],
      wakeCommentId: m.id, wakeCommentIds: [m.id] };
    const [r] = await db.insert(heartbeatRuns).values({ companyId: c.id, agentId: a.id, nativeIssueId: i.id, status: "failed", runtimeMode: "native",
      responsibleUserId: "board", contextSnapshot: context, finishedAt: new Date() }).returning();
    return { companyId: c.id, issueId: i.id, agentId: a.id, runId: r.id, contextSnapshot: context, good, m, r };
  }
  /** The successor's built input holds the answer and does not re-request the old turn. */
  function expectAnswerSeed(context: unknown, f: Awaited<ReturnType<typeof answeredFixture>>) {
    expect(context).toMatchObject({ interactionIds: [f.good.id], interactionId: f.good.id });
    const seed = context as Record<string, unknown>;
    expect([seed.wakeCommentId, seed.commentId, ...((seed.wakeCommentIds as unknown[] | undefined) ?? [])]).not.toContain(f.m.id);
  }

  // The judge's third test (rfl-sra judge-carry.test.ts), name kept.
  it("direct pendingContinuationCommentInput path must carry the answer, not just the asking comment", async () => {
    const f = await answeredFixture(); const actual = await pendingContinuationCommentInput(db, f);
    console.log("SRA_DIRECT_PENDING_ACTUAL", JSON.stringify(actual));
    expect(actual).toMatchObject({ interactionIds: [f.good.id] });
    expect(actual.wakeCommentIds).toBeUndefined();
  });

  // (i) immediate recovery by execution reconciliation: production entry is
  // execution-recovery-resolution.ts (fresh successor seed from readContinuationCommentInput
  // with the reconciled source run id), which now only delegates to the shared seam.
  it("an execution-reconciliation successor seeds from the person's answer, not the asking turn", async () => {
    const f = await answeredFixture();
    expectAnswerSeed(await readContinuationCommentInput(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId }), f);
  });

  // (ii) review / watchdog recovery: production entry is the wake-queue Postgres port
  // (adapters/postgres.ts pendingContinuationCommentInput, which use-cases.ts seeds the
  // fresh continuation recovery from; queueReviewParticipantRecoveryRun; queueImmediateRecoveryRun).
  it("review and watchdog recovery successors seed from the person's answer, not the asking turn", async () => {
    const f = await answeredFixture();
    // The finishing run (e.g. a reviewer's) ended while the task still needs it; the
    // wake-queue port is entered under the task lock as run finalization does.
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    const adapter = createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: async () => "board", getRoutineEnv: async () => ({}),
      resolveSessionBeforeForWakeup: async () => null } as never);
    const recoveryAgent = { id: f.agentId, name: "Question owner" } as never;
    const seeds: Record<string, unknown> = {};
    const released = await adapter.withIssueExecutionLock({ companyId: f.companyId, runId: f.runId, now: new Date() }, async (locked, { transaction }) => {
      // The adapter's own trusted snapshots of the finishing run and its task (as use-cases.ts receives them).
      const issue = locked.primaryIssue!, finishingRun = locked.run;
      seeds.continuation = await transaction.pendingContinuationCommentInput({ companyId: finishingRun.companyId, issueId: issue.id,
        agentId: finishingRun.agentId, contextSnapshot: finishingRun.contextSnapshot });
      const review = await transaction.queueReviewParticipantRecoveryRun({ companyId: f.companyId, issue, finishingRun,
        recoveryAgent, sessionBefore: null, now: new Date() });
      seeds.reviewId = review.id;
      const watchdog = await transaction.queueImmediateRecoveryRun({ companyId: f.companyId, issue, finishingRun, recoveryAgent,
        reason: "issue_continuation_needed", contextSnapshot: { issueId: f.issueId, ...(seeds.continuation as object) },
        responsibleUserId: "board", sessionBefore: null, now: new Date() } as never);
      seeds.watchdogId = watchdog.id;
      return { outcome: { kind: "released" }, postCommitEffects: [] } as never;
    });
    expect(seeds.continuation, JSON.stringify({ seeds, outcome: released.outcome })).toBeDefined();
    expectAnswerSeed(seeds.continuation, f);
    for (const id of [seeds.reviewId, seeds.watchdogId] as string[]) {
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, id), eq(heartbeatRuns.companyId, f.companyId)));
      expectAnswerSeed(successor.contextSnapshot, f);
    }
  });

  // (iii) person Retry: production entry is requestTaskRetry (POST /issues/:id/retry) then
  // heartbeat resumeTaskRetry -> enqueueWakeup (heartbeat/queue.ts task-retry admission).
  it("a person's Retry successor seeds from the person's answer, not the asking turn", async () => {
    const f = await answeredFixture();
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, f.agentId));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    // Hold dispatch: the built seed is the assertion, not a live turn.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    const [wake] = receipt.requestId ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId)) : [];
    expect(queued, JSON.stringify({ receipt, wake: wake && { status: wake.status, payload: wake.payload, error: wake.error } })).toHaveLength(1);
    expect(queued[0].contextSnapshot).toMatchObject({ taskRetryRequestId: receipt.requestId, previousRunId: f.runId });
    expectAnswerSeed(queued[0].contextSnapshot, f);
  });
});
