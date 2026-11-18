import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "./continuation-comment-input.js";
import { claimFirstTurnQueuedInput } from "./native-runtime/first-turn-queued-input.js";
import { answeredPersonMessageSql, completedPersonMessageAnswerSql } from "./person-message-answer.js";
import { settleUnansweredPersonMessage } from "./recovery/unanswered-person-message.js";

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

  // RFL F2 (22:41Z): ANSWERED is attributed through the answering run's OWN pending input only (comment ids AND card
  // interaction ids). Continuation ancestry collects candidates; it never attributes an answer.
  it("RFL F2: a completed successor whose own input is only M2 answers neither the comment nor the card its failed ancestors carried", async () => {
    const f = await fixture();
    const t0 = f.message.createdAt.getTime();
    // The card's asking run carries no person input, so the presented card answers nothing here (card point 1 stays).
    const [asker] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "succeeded", contextSnapshot: { issueId: f.issueId } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, sourceRunId: asker.id,
      resolvedByUserId: "board", resolvedAt: new Date(t0 + 1_000), idempotencyKey: randomUUID(),
      payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single", options: [{ id: "yes", label: "YES" }] }] },
      result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }] } } as never).returning();
    const [resume] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "failed", retryOfRunId: f.run.id, contextSnapshot: { issueId: f.issueId, interactionId: card.id } }).returning();
    const [m2] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "board", body: "M2 is different work", createdAt: new Date(t0 + 2_000) }).returning();
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "succeeded", retryOfRunId: resume.id, contextSnapshot: { issueId: f.issueId, wakeCommentId: m2.id } }).returning();
    const [reply] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, createdByRunId: successor.id, body: "Done with M2.", createdAt: new Date(t0 + 3_000) }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: reply.id } } })
      .where(eq(heartbeatRuns.id, successor.id));
    const answered = async (id: string, createdAt: Date) => {
      const m = { id: sql`${id}::uuid`, companyId: sql`${f.companyId}::uuid`, issueId: sql`${f.issueId}::uuid`,
        createdAt: sql`${createdAt.toISOString()}::timestamptz` };
      const [row] = await db.select({ delivered: answeredPersonMessageSql(m), answered: completedPersonMessageAnswerSql(m) })
        .from(issues).where(eq(issues.id, f.issueId));
      return row;
    };
    expect(await answered(m2.id, m2.createdAt), "M2 is the successor's own input").toEqual({ delivered: true, answered: true });
    expect(await answered(f.message.id, f.message.createdAt), "M1 only through ancestry").toEqual({ delivered: false, answered: false });
    expect(await answered(card.id, card.resolvedAt!), "card only through ancestry").toEqual({ delivered: false, answered: false });
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }), "M1 still rides").toMatchObject({ wakeCommentIds: [f.message.id] });
    // Control: once the completed run's OWN pending input holds M1 and the card, its final answer answers both.
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeCommentIds: [f.message.id, m2.id],
      wakeCommentId: m2.id, interactionId: card.id } }).where(eq(heartbeatRuns.id, successor.id));
    expect(await answered(f.message.id, f.message.createdAt)).toEqual({ delivered: true, answered: true });
    expect(await answered(card.id, card.resolvedAt!)).toEqual({ delivered: true, answered: true });
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

  // KEEP: rf5 A3, Stop means stop; an unrelated later input must still survive the same carry.
  it.each([true, false])("A3: sender-stopped input is excluded only after answering started (%s)", async (started) => {
    const f = await fixture();
    const [next] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Unrelated next message" }).returning();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "board", stopReason: "cancelled",
      executionCancellation: { state: "requested", requestedAt: new Date().toISOString() },
      cancellation: { source: "operator", expected: true, initiator: { id: "board", type: "user" },
        recordedAt: new Date().toISOString() },
    } }).where(eq(heartbeatRuns.id, f.run.id));
    if (started) await db.insert(heartbeatRunEvents).values(["userMessage", "agentMessage"].map((kind, index) => ({
      companyId: f.companyId, agentId: f.agentId, runId: f.run.id, seq: index + 1,
      eventType: "item.started", sourceEventId: randomUUID(), payload: { prpEvent: {
        eventType: "item.started", turnId: `turn-${f.run.id}`, itemId: `item-${index}`,
        payload: { kind, item: { type: kind } },
      } },
    })));
    const input = await pendingContinuationCommentInput(db, { ...f,
      contextSnapshot: { wakeCommentIds: [f.message.id, next.id] },
      liveOwner: { agentId: f.agentId, runId: f.run.id } });
    expect(input.wakeCommentIds).toEqual(started ? [next.id] : [f.message.id, next.id]);
    console.log("A3_EVIDENCE", JSON.stringify({ started, sourceRunId: f.run.id, stoppedMessageId: f.message.id,
      unrelatedMessageId: next.id, input }));
  });

  // KEEP: rf5 A2 caught lost card input and false safe-to-retry advice on a failed resume.
  it.each(["interactionId", "interactionIds", "respondWake", "respondWakeContext"])("A2: failed card resume carries %s into its successor's OWN input and suppresses a false notice", async (field) => {
    const f = await fixture();
    const t0 = f.message.createdAt.getTime();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, sourceRunId: f.run.id,
      resolvedByUserId: "board", resolvedAt: new Date(t0 + 1_000), idempotencyKey: randomUUID(),
      payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single", options: [{ id: "yes", label: "YES" }] }] },
      result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }] } } as never).returning();
    const [resume] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, status: "failed", finishedAt: new Date(t0 + 2_000),
      contextSnapshot: { issueId: f.issueId, interactionId: card.id } }).returning();
    // An array-only source is supported too, while the original respond run remains durable.
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, status: "failed", retryOfRunId: resume.id,
      contextSnapshot: { issueId: f.issueId,
        ...(!field.startsWith("respondWake") ? { [field]: field === "interactionIds" ? [card.id] : card.id } : {}) } }).returning();
    if (field.startsWith("respondWake")) {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "on_demand", reason: "issue_interaction_responded", status: "completed", runId: source.id,
        payload: { issueId: f.issueId, ...(field === "respondWake" ? { interactionId: card.id }
          : { _paperclipWakeContext: { interactionId: card.id } }) } }).returning();
      await db.update(heartbeatRuns).set({ wakeupRequestId: wake.id }).where(eq(heartbeatRuns.id, source.id));
    }
    // An existing live owner blocks promotion under either card-input spelling; its failure releases the input.
    for (const status of ["queued", "running", "scheduled_retry"]) {
      const [live] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, status, contextSnapshot: { interactionIds: [card.id] } }).returning();
      expect(await readContinuationCommentInput(db, { ...f, runId: source.id }), `live ${status} card owner`).toEqual({});
      await db.update(heartbeatRuns).set({ contextSnapshot: { interactionId: card.id } }).where(eq(heartbeatRuns.id, live.id));
      expect(await readContinuationCommentInput(db, { ...f, runId: source.id }), `live ${status} singular card owner`).toEqual({});
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, live.id));
    }
    const input = await readContinuationCommentInput(db, { ...f, runId: source.id });
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, status: "succeeded", retryOfRunId: source.id,
      contextSnapshot: { issueId: f.issueId, ...input } }).returning();
    const [reply] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "agent", authorAgentId: f.agentId, createdByRunId: successor.id,
      body: "Acted on YES.", createdAt: new Date(t0 + 3_000) }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: reply.id } } })
      .where(eq(heartbeatRuns.id, successor.id));
    const [state] = await db.select({ answered: completedPersonMessageAnswerSql({ id: sql`${card.id}::uuid`,
      companyId: sql`${f.companyId}::uuid`, issueId: sql`${f.issueId}::uuid`,
      createdAt: sql`${card.resolvedAt!.toISOString()}::timestamptz` }) }).from(issues).where(eq(issues.id, f.issueId));
    const sweep = await settleUnansweredPersonMessage(db, { ...f, now: new Date(t0 + 20 * 60_000) });
    const notices = await db.select({ id: issueComments.id, body: issueComments.body }).from(issueComments)
      .where(sql`${issueComments.issueId} = ${f.issueId} and ${issueComments.body} like '%wasn''t acted on%'`);
    console.log("A2_EVIDENCE", JSON.stringify({ field, cardId: card.id, sourceRunId: source.id,
      successorRunId: successor.id, input, state, sweep, notices }));
    expect.soft(input.interactionIds).toEqual([card.id]);
    expect.soft(state.answered).toBe(true);
    expect(notices).toHaveLength(0);
    expect(await readContinuationCommentInput(db, { ...f, runId: source.id }), "ANSWERED is never re-carried").toEqual({});
  });

  it("does not manufacture comment intent for ordinary work", async () => {
    const f = await fixture();
    expect(await pendingContinuationCommentInput(db, { ...f, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } })).toEqual({});
    // No source run is an initial assignment, not a comment continuation.
    expect(await readContinuationCommentInput(db, { ...f, runId: null })).toEqual({});
  });
});
