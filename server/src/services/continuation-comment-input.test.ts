import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "./continuation-comment-input.js";
import { claimFirstTurnQueuedInput } from "./native-runtime/first-turn-queued-input.js";
import { answeredPersonMessageSql } from "./person-message-answer.js";
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
  });

  // RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118, row 1, ruling row (a). The record names this row 'a FAILED parent's own reply
  // answered the comment': it was the LAST assertion of the row above at 422b8c26 (that row's other assertions stay live).
  // OLD: with the FAILED parent's own reply published, the carry is {} (M answered).
  // NEW: M is OWED (still carried, the one function says not answered) AND M's notice stays.
  // Control: the same reply once that parent SUCCEEDED answers M (carry {}), and M's notice is retired.
  it("supersedes(carries the parent's comment ids as-is; a later reply does not erase them; RFL record SUPERSEDE-ANSWERED-MERGED-OLDRULE-ROWS-1118)", async () => {
    const f = await fixture();
    const answered = async () => (await db.select({ answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
      .from(issueComments).where(eq(issueComments.id, f.message.id)))[0]!.answered;
    const notices = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"),
      sql`${issueComments.metadata}->>'authorizationReason' = ${`unanswered_message:${f.message.id}`}`));
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await settleUnansweredPersonMessage(db, { ...f, now: later(5) })).toMatchObject({ kind: "noticed" });
    expect(await notices(), "M has its ONE notice before the failed parent replies").toHaveLength(1);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: f.run.id, body: "COBALT", createdAt: later(1) });
    // The fixture's parent FAILED: its reply is not an answer. M is owed: answered 0 times, still carried.
    expect(await answered()).toBe(false);
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ wakeCommentIds: [f.message.id] });
    // ... AND its notice stays: the sweep neither retires it nor adds a second one.
    expect(await settleUnansweredPersonMessage(db, { ...f, now: later(6) })).toEqual({ kind: "noticed_before" });
    expect((await notices()).map(n => n.deletedAt), "M's ONE notice stays live").toEqual([null]);
    // Control (still ANSWERED): RFL ruling (1), 20:06Z, on a parent that SUCCEEDED: its OWN published reply answers the
    // comment (carrying it would answer it twice), and the answer retires M's notice.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await answered()).toBe(true);
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toEqual({});
    expect(await settleUnansweredPersonMessage(db, { ...f, now: later(7) })).toEqual({ kind: "answered" });
    expect((await notices()).filter(n => n.deletedAt === null), "the answer retires M's notice").toHaveLength(0);
    expect(await notices(), "and there was only ever one").toHaveLength(1);
  });

  // rf-5's A3 row (judge file rf5-answered-focus.test.ts, "A3 sender Stop covers typed AND card own input after
  // read=<started>"), same seed. TYPED half, live for read=false: the typed message the
  // stopped run never read is carried ([M]), rf-5's exact expectation. For read=true rf-5 expects [] (the sender Stop
  // covers it); this base has no sender Stop (READ at 422b8c26) and carries [M], so that half is a todo below, not a pin.
  for (const started of [false]) it(`A3 typed half: a person-stopped run's own typed input after read=${started} is carried`, async () => {
    const f = await fixture();
    const [asker] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: f.issueId } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, sourceRunId: asker.id,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, addresseeUserId: "board",
      resolvedAt: new Date(), resolvedByUserId: "board", payload: { version: 1, questions: [] } as never }).returning();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled",
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.message.id, interactionIds: [card.id] },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board", stopReason: "cancelled",
        executionCancellation: { state: "requested", requestedAt: new Date().toISOString() },
        cancellation: { source: "operator", expected: true, initiator: { id: "board", type: "user" }, recordedAt: new Date().toISOString() } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    if (started) await db.insert(heartbeatRunEvents).values(["userMessage", "agentMessage"].map((kind, index) => ({
      companyId: f.companyId, agentId: f.agentId, runId: f.run.id, seq: index + 1, eventType: "item.started", sourceEventId: randomUUID(),
      payload: { prpEvent: { eventType: "item.started", turnId: `turn-${f.run.id}`, itemId: `item-${index}`, payload: { kind, item: { type: kind } } } } })));
    const carried = await readContinuationCommentInput(db, { ...f, runId: f.run.id });
    expect(carried.wakeCommentIds ?? []).toEqual(started ? [] : [f.message.id]);
    expect("interactionIds" in carried, "no card-answer carry on this base").toBe(false);
  });
  // CARD half: absent on this base by READ at 422b8c26 (no card-answer carry: readContinuationCommentInput never returns
  // interactionIds; no sender Stop). A gate when the B-line unit ports.
  it.todo("A3 typed half after read=true: the sender Stop covers the typed input the run already read (carried.wakeCommentIds toEqual []); B-line unit 'tA-min card carry (bb/tamin6 5cddd3d1)'");
  it.todo("A3 card half: Stop must also exclude the card answer this run started acting on (carried.interactionIds toEqual started ? [] : [card.id]); B-line unit 'tA-min card carry (bb/tamin6 5cddd3d1)'");

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
