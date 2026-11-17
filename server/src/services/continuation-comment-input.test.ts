import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "./continuation-comment-input.js";
import { claimFirstTurnQueuedInput } from "./native-runtime/first-turn-queued-input.js";
import { answeredPersonMessageSql, completedPersonMessageAnswerSql } from "./person-message-answer.js";

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

  it("carries the parent's comment ids as-is; a later reply does not erase them", async () => {
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
      createdByRunId: f.run.id, body: "Looking into COBALT..." });
    // RFL 21:28Z (ANSWERED): the parent FAILED, so its own progress comment is delivered, not answered: the carry still carries it.
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ wakeCommentIds: [f.message.id] });
    // RFL ruling (1), 20:06Z, as ANSWERED: a COMPLETED parent's own final answer answers the comment (carrying it would answer it twice).
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toEqual({});
  });

  // R-ONCE: a live pending owner blocks another carry, but is not an answer.
  it.each(["queued", "running", "scheduled_retry"].flatMap(status =>
    ["wakeCommentIds", "wakeCommentId", "commentId", "firstTurnQueuedInput", "steeredCommentIds"].map(field => ({ status, field }))))
  ("a $status carrier blocks a second wake ($field)", async ({ status, field }) => {
    const f = await fixture();
    const pending = field === "firstTurnQueuedInput" ? { commentIds: [f.message.id] }
      : field.endsWith("Ids") ? [f.message.id] : f.message.id;
    const [live] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, status, contextSnapshot: { [field]: pending } }).returning();
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }), `${status}/${field}: no duplicate`).toEqual({});
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, live.id));
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }), `${status}/${field}: pending is not answered`)
      .toMatchObject({ wakeCommentIds: [f.message.id] });
  });

  it("only a live carrier on the same company, issue and agent blocks; the restored source itself never blocks", async () => {
    const f = await fixture(), foreign = await fixture();
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
    const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Other" }).returning();
    await db.insert(heartbeatRuns).values([
      { companyId: foreign.companyId, agentId: foreign.agentId, nativeIssueId: f.issueId, status: "running" },
      { companyId: f.companyId, agentId: otherAgent.id, nativeIssueId: f.issueId, status: "running" },
      { companyId: f.companyId, agentId: f.agentId, nativeIssueId: otherIssue.id, status: "running" },
      ...["succeeded", "failed", "cancelled", "timed_out"].map(status => ({ companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, status })),
    ].map(run => ({ ...run, contextSnapshot: { wakeCommentIds: [f.message.id] } })));
    for (const status of ["queued", "running", "scheduled_retry"]) {
      await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ wakeCommentIds: [f.message.id] });
    }
    for (const issueBinding of [{ issueId: f.issueId }, { contextSnapshot: { issueId: f.issueId, wakeCommentIds: [f.message.id] } }]) {
      const [live] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "running", contextSnapshot: { wakeCommentIds: [f.message.id] }, ...issueBinding }).returning();
      expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toEqual({});
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, live.id));
    }
  });

  // RFL 21:5xZ (one answered-test): the carry reads ANSWERED alone. The duplicate shape H3 fenced by "the seeding run
  // SUCCEEDED" is green by itself: a card answer whose answer-resume run COMPLETED its final answer is answered; the
  // same run's progress comment before it FAILED is only delivered.
  it("a card answer is ANSWERED only by its answer-resume run's completed final answer, not a failed run's progress", async () => {
    const f = await fixture();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, sourceRunId: f.run.id,
      resolvedByUserId: "board", resolvedAt: new Date(), idempotencyKey: randomUUID(),
      payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single", options: [{ id: "yes", label: "YES" }] }] },
      result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }] } } as never).returning();
    const [resume] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "failed", contextSnapshot: { issueId: f.issueId, interactionId: card.id } }).returning();
    const [reply] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, createdByRunId: resume.id, body: "Continuing with YES...", createdAt: new Date(Date.now() + 1_000) }).returning();
    const state = async () => {
      const m = { id: sql`${card.id}::uuid`, companyId: sql`${f.companyId}::uuid`, issueId: sql`${f.issueId}::uuid`,
        createdAt: sql`${card.resolvedAt!.toISOString()}::timestamptz` };
      const [row] = await db.select({ delivered: answeredPersonMessageSql(m), answered: completedPersonMessageAnswerSql(m) })
        .from(issues).where(eq(issues.id, f.issueId));
      return row;
    };
    expect(await state()).toEqual({ delivered: true, answered: false });
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { presentationDecision: { commentAction: "create", commentId: reply.id } } })
      .where(eq(heartbeatRuns.id, resume.id));
    expect(await state()).toEqual({ delivered: true, answered: true });
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
});
