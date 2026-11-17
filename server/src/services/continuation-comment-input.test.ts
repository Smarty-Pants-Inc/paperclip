import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "./continuation-comment-input.js";
import { claimFirstTurnQueuedInput } from "./native-runtime/first-turn-queued-input.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { requestTaskRetry } from "./task-retry.js";
import { heartbeatService } from "./heartbeat.js";
import { completedPersonMessageAnswerSql } from "./person-message-answer.js";
import { settleUnansweredPersonMessage } from "./recovery/unanswered-person-message.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";

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

  // KEEP: rf5 A3-card (03:20Z): the same sender's Stop after answering started excluded typed input but still carried
  // the CARD answer the stopped run carried. The card is excluded the same way; an unrelated typed input still rides.
  it.each([true, false])("A3-card: a sender-stopped CARD answer is excluded only after answering started (%s)", async (started) => {
    const f = await fixture();
    const [asker] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "succeeded", contextSnapshot: { issueId: f.issueId } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, sourceRunId: asker.id,
      resolvedByUserId: "board", resolvedAt: new Date(), idempotencyKey: randomUUID(),
      payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single", options: [{ id: "yes", label: "YES" }] }] },
      result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }] } } as never).returning();
    const [next] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Unrelated next message" }).returning();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled",
      contextSnapshot: { issueId: f.issueId, interactionIds: [card.id] }, resultJson: {
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
      contextSnapshot: { interactionIds: [card.id], wakeCommentIds: [next.id] },
      liveOwner: { agentId: f.agentId, runId: f.run.id } });
    console.log("A3_CARD_EVIDENCE", JSON.stringify({ started, sourceRunId: f.run.id, stoppedCardId: card.id,
      unrelatedMessageId: next.id, input }));
    // supersedes(c1x answer-first carry; C3-2 rf-5): the typed batch rides beside a carried card answer, so the
    // unrelated typed input rides in both cases; only the stopped card's own exclusion depends on `started`.
    expect(input.wakeCommentIds, "the unrelated typed input rides beside the card or alone").toEqual([next.id]);
    expect(input.interactionIds ?? []).toEqual(started ? [] : [card.id]);
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

  // C3-2 (rf-5): a predecessor with a pending CARD answer AND a typed batch carries BOTH into its successor's own
  // input. RED on the card-first early return: the typed message M was dropped beside the card, so the successor's
  // completed answer never attributed to M and the sweep posted a false notice for it.
  it("C3-2: a mixed [typed M, card C] continuation carries both; answering both answers M by own input, no notice for M or C, M not re-sent", async () => {
    const f = await fixture();
    const t0 = f.message.createdAt.getTime();
    const [asker] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "succeeded", contextSnapshot: { issueId: f.issueId, wakeCommentId: f.message.id } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, sourceRunId: asker.id,
      resolvedByUserId: "board", resolvedAt: new Date(t0 + 1_000), idempotencyKey: randomUUID(),
      payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single", options: [{ id: "yes", label: "YES" }] }] },
      result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }] } } as never).returning();
    // The failed predecessor's own pending input: the typed message M (typed after the question) and the card
    // answer C. The asking turn's own comment (f.message, older than the card) is named too and must not ride.
    const [m] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "board", body: "Typed M beside the card answer" }).returning();
    await db.update(heartbeatRuns).set({ finishedAt: new Date(t0 + 2_000),
      contextSnapshot: { issueId: f.issueId, wakeCommentId: m.id, wakeCommentIds: [f.message.id, m.id], interactionId: card.id } })
      .where(eq(heartbeatRuns.id, f.run.id));
    const input = await readContinuationCommentInput(db, { ...f, runId: f.run.id });
    expect(input.interactionIds, "the card answer rides").toEqual([card.id]);
    expect(input.wakeCommentIds, "the typed batch rides beside the card; the asking turn's comment does not").toEqual([m.id]);
    expect(input).toMatchObject({ interactionId: card.id, wakeCommentId: m.id, commentId: m.id, firstTurnQueuedInput: null });
    // Each side keeps its own live-owner fence: a live run already owning the card blocks the card only.
    const [liveCard] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, status: "running", contextSnapshot: { issueId: f.issueId, interactionIds: [card.id] } }).returning();
    const fenced = await readContinuationCommentInput(db, { ...f, runId: f.run.id });
    expect(fenced.interactionIds, "card live-owner fence").toBeUndefined();
    expect(fenced.wakeCommentIds, "the typed batch is not fenced by a card owner").toEqual([m.id]);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, liveCard.id));
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, status: "succeeded", retryOfRunId: f.run.id, finishedAt: new Date(t0 + 4_000),
      contextSnapshot: { issueId: f.issueId, ...input } }).returning();
    const [reply] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "agent", authorAgentId: f.agentId, createdByRunId: successor.id,
      body: "COBALT; acted on YES.", createdAt: new Date(t0 + 3_000) }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: reply.id } } })
      .where(eq(heartbeatRuns.id, successor.id));
    const answered = async (id: string, at: Date) => (await db.select({ answered: completedPersonMessageAnswerSql({ id: sql`${id}::uuid`,
      companyId: sql`${f.companyId}::uuid`, issueId: sql`${f.issueId}::uuid`,
      createdAt: sql`${at.toISOString()}::timestamptz` }) }).from(issues).where(eq(issues.id, f.issueId)))[0].answered;
    expect(await answered(m.id, m.createdAt), "M is ANSWERED through the successor's OWN input").toBe(true);
    expect(await answered(card.id, card.resolvedAt!), "C is ANSWERED").toBe(true);
    await settleUnansweredPersonMessage(db, { ...f, now: new Date(t0 + 20 * 60_000) });
    await settleUnansweredPersonMessage(db, { ...f, now: new Date(t0 + 40 * 60_000) });
    const notices = await db.select({ id: issueComments.id, body: issueComments.body }).from(issueComments)
      .where(and(eq(issueComments.issueId, f.issueId), sql`${issueComments.authorType} <> 'user'`, sql`${issueComments.id} <> ${reply.id}`));
    expect(notices, "no notice for M or C").toEqual([]);
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }), "M and C are never re-sent").toEqual({});
    expect(await readContinuationCommentInput(db, { ...f, runId: successor.id }), "nor from the successor").toEqual({});
  });

  it("does not manufacture comment intent for ordinary work", async () => {
    const f = await fixture();
    expect(await pendingContinuationCommentInput(db, { ...f, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } })).toEqual({});
    // No source run is an initial assignment, not a comment continuation.
    expect(await readContinuationCommentInput(db, { ...f, runId: null })).toEqual({});
  });
  it("a held refusal restores M13, M14 and M15 as pending once, in order, but never answered M12", async () => {
    const f = await fixture(), sessionId = randomUUID();
    const t0 = Date.now() - 60_000;
    const at = (n: number) => new Date(t0 + n * 100);
    const generation = { conversationSessionGeneration: 1 };
    await db.update(issueComments).set({ body: "M12", createdAt: at(0) }).where(eq(issueComments.id, f.message.id));
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId, createdAt: at(1), finishedAt: at(2),
      contextSnapshot: { ...f.run.contextSnapshot, ...generation } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, createdByRunId: f.run.id, body: "ACK M12", createdAt: at(3) });
    const messages = await db.insert(issueComments).values([13, 14, 15].map(n => ({
      companyId: f.companyId, issueId: f.issueId, authorType: "user" as const, authorUserId: "board", body: `M${n}`, createdAt: at(n),
    }))).returning();
    const [r13] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", nativeSessionId: sessionId, status: "failed", createdAt: at(20), finishedAt: at(21),
      contextSnapshot: { issueId: f.issueId, ...generation, wakeCommentId: messages[0].id } }).returning();
    const r14Id = randomUUID();
    const [r14] = await db.insert(heartbeatRuns).values({ id: r14Id, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", nativeSessionId: sessionId, status: "failed", createdAt: at(22), finishedAt: at(23),
      contextSnapshot: { issueId: f.issueId, ...generation, firstTurnQueuedInput: { schema: "paperclip.first-turn-queued-input.v1",
        runId: r14Id, commentIds: [messages[1].id, messages[0].id], wakeupRequestIds: [], claimedAt: at(22).toISOString() } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", nativeSessionId: sessionId, status: "failed", createdAt: at(24), finishedAt: at(25),
      errorCode: "native_controller_recovery_missing_evidence:snapshot_binding", retryOfRunId: r14.id,
      contextSnapshot: { issueId: f.issueId, ...generation, wakeCommentId: messages[2].id } }).returning();
    const [unrelated] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Not in this chain", createdAt: at(4) }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: otherAgent.id, nativeIssueId: f.issueId,
      nativeSessionId: sessionId, createdAt: at(5), contextSnapshot: { issueId: f.issueId, ...generation, wakeCommentId: unrelated.id } });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: f.agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `carry:${source.id}`, nextAction: "Continue from saved work.",
      evidence: { runId: source.id, continuationDelivery: "pending", executionReconciliation: { runId: source.id },
        freshContinuation: { schema: "paperclip.fresh-continuation.v1", sourceRunId: source.id, recordedAt: at(26).toISOString() } } });
    await deliverReconciledExecutions(db, async () => null);
    const restored: Array<typeof heartbeatRuns.$inferSelect> = [];
    const wake: ReturnType<typeof heartbeatService>["wakeup"] = async (agentId, opts) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, nativeIssueId: f.issueId,
        runtimeMode: "native", status: "queued", responsibleUserId: "board", contextSnapshot: opts?.contextSnapshot }).returning();
      restored.push(run);
      return run;
    };
    await deliverReconciledExecutions(db, wake);
    await deliverReconciledExecutions(db, wake);
    expect(restored).toHaveLength(1);
    const successor = restored[0], expected = messages.map(m => m.id);
    console.log("H3_CARRY_PENDING", JSON.stringify({ labels: messages.map(m => m.body), expected,
      actual: successor.contextSnapshot?.wakeCommentIds, answeredM12: f.message.id, source: source.id, earlier: [r13.id, r14.id] }));
    expect(successor.contextSnapshot).toMatchObject({ forceFreshSession: true, wakeReason: "issue_recovery_action_restored",
      wakeCommentIds: expected, wakeCommentId: messages[2].id, commentId: messages[2].id, firstTurnQueuedInput: null });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, successor.id));
    await db.update(issues).set({ executionRunId: successor.id }).where(eq(issues.id, f.issueId));
    const binding = { ...f, runId: successor.id };
    const text = await claimFirstTurnQueuedInput(db, binding);
    expect(text).toContain("M13"); expect(text).toContain("M14"); expect(text).toContain("M15");
    expect(text).not.toContain("M12"); expect(text).not.toContain(unrelated.body);
    const [sealed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
    expect(sealed.contextSnapshot?.firstTurnQueuedInput).toMatchObject({ runId: successor.id, commentIds: expected });
    expect(await claimFirstTurnQueuedInput(db, binding)).toBe(text);
    console.log("H3_CARRY_SEALED", JSON.stringify({ runId: successor.id, receipt: sealed.contextSnapshot?.firstTurnQueuedInput }));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, createdByRunId: successor.id, body: "ACK M13, M14, M15" });
    expect(await readContinuationCommentInput(db, { ...f, runId: successor.id })).toEqual({});
  });

  it("follows previous/retry edges across fresh sessions without crossing company, task, agent or reset fences", async () => {
    const f = await fixture(), foreign = await fixture();
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
    const [otherTask] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
    const [pending, outside, reset] = await db.insert(issueComments).values(["Pending ancestor", "Outside chain", "Before reset"].map(body => ({
      companyId: f.companyId, issueId: f.issueId, authorType: "user" as const, authorUserId: "board", body,
      createdAt: new Date(f.message.createdAt.getTime() - 1_000),
    }))).returning();
    const [, otherTaskRun, otherAgentRun, resetRun] = await db.insert(heartbeatRuns).values([
      { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, contextSnapshot: { wakeCommentId: outside.id } },
      { companyId: f.companyId, agentId: f.agentId, issueId: otherTask.id, contextSnapshot: { wakeCommentId: outside.id } },
      { companyId: f.companyId, agentId: otherAgent.id, issueId: f.issueId, contextSnapshot: { wakeCommentId: outside.id } },
      { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        contextSnapshot: { wakeCommentId: reset.id, conversationSessionGeneration: 2 } },
    ]).returning();
    const [ancestor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, retryOfRunId: otherAgentRun.id, contextSnapshot: { wakeCommentId: pending.id,
        previousRunId: foreign.run.id, retryOfRunId: otherTaskRun.id } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      nativeSessionId: randomUUID(), retryOfRunId: resetRun.id, contextSnapshot: { issueId: f.issueId, wakeCommentId: f.message.id,
        previousRunId: ancestor.id.toUpperCase(), retryOfRunId: otherTaskRun.id } }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...ancestor.contextSnapshot, retryOfRunId: source.id } })
      .where(eq(heartbeatRuns.id, ancestor.id));
    const input = await readContinuationCommentInput(db, { ...f, runId: source.id });
    expect(input.wakeCommentIds).toEqual([pending.id, f.message.id]);
    expect(await pendingContinuationCommentInput(db, { ...f, runId: source.id, contextSnapshot: source.contextSnapshot }))
      .toEqual(input);
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
