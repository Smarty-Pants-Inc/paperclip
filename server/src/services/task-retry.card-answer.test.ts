// A person answers a card; the run carrying that answer fails; they press Retry. The retried agent must SEE the
// answer in its input, once, and its reply must count as the answer (rf-5 f6 row 162, P1).
// REAL: the card resolver (issueThreadInteractionService.answerQuestions), the Retry route's producer and admission
// (requestTaskRetry -> heartbeatService.resumeTaskRetry), the runtime materializer of the successor's native input
// (materializeNativeInteractionResponses), the one carry (readContinuationCommentInput) and the one answered rule
// (answeredPersonMessageSql), on real PostgreSQL.
// PLANTED, named in each row: the company / agent / task, the card row the agent asked, the FAILED run that carried
// the answer (no provider runs here), an unrelated running run that holds the agent's one slot (so the successor
// stays queued and its context is read as admitted), and the successor's completion + reply (no provider runs).
// NAMED outside the judged path: answer delivery is held right after the real resolver commits (the same boundary as
// rf-5's probe), so the answer's own wake is not what delivers it.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issueQuestionResponseDeliveries, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";

vi.mock("./question-response-delivery.js", async original => {
  const actual = await original<typeof import("./question-response-delivery.js")>();
  return { ...actual, questionResponseDeliveryService: (...args: Parameters<typeof actual.questionResponseDeliveryService>) =>
    ({ ...actual.questionResponseDeliveryService(...args), deliver: async () => null }) };
});
import { readContinuationCommentInput } from "./continuation-comment-input.js";
import { heartbeatService } from "./heartbeat.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { materializeNativeInteractionResponses } from "./native-runtime/native-interaction-bridge.js";
import { answeredPersonMessageSql } from "./person-message-answer.js";
import { requestTaskRetry } from "./task-retry.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("Retry after a failed card-answer run: the successor sees the person's answer, once", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("retry-card-answer-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  /** PLANTED task state; the answer itself goes through the REAL resolver. */
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), root = randomUUID(), source = randomUUID();
    const userId = `retry-card-${randomUUID().slice(0, 8)}`;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Retry card answer", issuePrefix: `R${randomUUID().slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue the answered scope", status: "blocked",
      assigneeAgentId: agentId, responsibleUserId: userId, createdByUserId: userId });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Ask me the scope before continuing.", createdAt: at(23) }).returning();
    // PLANTED: the run that asked the card, and the card it asked.
    await db.insert(heartbeatRuns).values({ id: root, companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId,
      contextSnapshot: { issueId, wakeCommentId: message!.id }, createdAt: at(22), finishedAt: at(22) });
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId: root, kind: "ask_user_questions",
      status: "pending", createdByAgentId: agentId, addresseeUserId: userId, continuationPolicy: "none", createdAt: at(21),
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", required: true, selectionMode: "single",
        options: [{ id: "first", label: "First exact scope" }] }] } }).returning();
    // REAL resolver: the person answers the card.
    await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, card!.id,
      { answers: [{ questionId: "scope", optionIds: ["first"] }] }, { userId });
    // PLANTED clock (the answer precedes the run that carried it) and the FAILED run that carried the answer.
    await db.update(issueThreadInteractions).set({ resolvedAt: at(20) }).where(eq(issueThreadInteractions.id, card!.id));
    await db.insert(heartbeatRuns).values({ id: source, companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      nativePhase: "committed", errorCode: "adapter_failed", contextSnapshot: { issueId, interactionId: card!.id, interactionIds: [card!.id],
        source: "issue.interaction.respond", wakeReason: "issue_commented" }, createdAt: at(19), finishedAt: at(18) });
    await db.update(issueQuestionResponseDeliveries).set({ status: "fallback_queued", targetRunId: source, deliveryMode: "wake_fallback" })
      .where(eq(issueQuestionResponseDeliveries.interactionId, card!.id));
    // PLANTED: an unrelated run holds the agent's one slot, so the Retry's successor stays queued.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });
    return { companyId, agentId, issueId, userId, source, cardId: card!.id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** The REAL Retry route: the person's request, then its admission. Returns the runs the Retry admitted. */
  async function pressRetry(f: Fixture) {
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.userId,
      idempotencyKey: randomUUID(), observedRunId: f.source });
    expect(receipt.accepted).toBe(true);
    const admitted = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    return { receipt, admitted };
  }

  /** The successor's card-answer input, as its runtime selection builds it (runtime-selection.ts: interactionId +
   * interactionIds from the run's own context, through the REAL materializer). */
  async function materializedCardAnswers(f: Fixture, run: typeof heartbeatRuns.$inferSelect) {
    const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
    const single = typeof context.interactionId === "string" ? [context.interactionId] : [];
    const interactionIds = Array.isArray(context.interactionIds)
      ? [...new Set([...single, ...context.interactionIds.filter((id): id is string => typeof id === "string")])] : single;
    return materializeNativeInteractionResponses({ db, companyId: f.companyId, issueId: f.issueId, runId: run.id, agentId: f.agentId,
      wakeReason: typeof context.wakeReason === "string" ? context.wakeReason : undefined, interactionIds });
  }

  /** The one answered rule, keyed as its production callers key a card answer: the card's id and its answer time. */
  const cardAnswerAnswered = async (cardId: string) => (await db.select({ answered: sql<boolean>`${answeredPersonMessageSql({
    id: sql`${issueThreadInteractions.id}`, companyId: sql`${issueThreadInteractions.companyId}`,
    issueId: sql`${issueThreadInteractions.issueId}`, createdAt: sql`${issueThreadInteractions.resolvedAt}` })}` })
    .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cardId)))[0]!.answered;

  it("the Retry's successor is given the card answer exactly once, and its reply counts as the answer", async () => {
    const f = await fixture();
    expect(await cardAnswerAnswered(f.cardId), "the failed run answered nothing: the card answer is still owed").toBe(false);

    const { receipt, admitted } = await pressRetry(f);
    const runs = await admitted();
    expect(runs, "one fresh-session successor").toHaveLength(1);
    const successor = runs[0]!;
    const context = successor.contextSnapshot as Record<string, unknown>;
    expect(context).toMatchObject({ forceFreshSession: true, previousRunId: f.source, wakeReason: "task_retry" });
    expect(context.interactionIds, "the still-owed card answer is the successor's own input").toEqual([f.cardId]);
    expect(context.interactionId, "a Retry is not an interaction-continuation wake").toBeUndefined();

    const answers = await materializedCardAnswers(f, successor);
    expect(answers.map(answer => answer.interactionId), "the card answer appears exactly once in the materialized input").toEqual([f.cardId]);
    expect(JSON.stringify(answers[0]!.response), "it is the person's answer").toContain("first");

    // A second admission of the same Retry adds no run and no second copy of the answer.
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const again = await admitted();
    expect(again.map(run => run.id)).toEqual([successor.id]);
    expect((await materializedCardAnswers(f, again[0]!)).map(answer => answer.interactionId)).toEqual([f.cardId]);

    // PLANTED: the successor completes and replies (no provider runs here). The answered rule reads the reply.
    expect(await cardAnswerAnswered(f.cardId), "queued, no reply yet: still owed").toBe(false);
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: at(1), finishedAt: new Date() }).where(eq(heartbeatRuns.id, successor.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: successor.id, body: "Continuing with the first exact scope.", createdAt: new Date() });
    expect(await cardAnswerAnswered(f.cardId), "the successor's own input names the card, so its reply answers it").toBe(true);
    expect(await readContinuationCommentInput(db, { companyId: f.companyId, issueId: f.issueId, runId: successor.id }),
      "answered: never carried again").toEqual({});
  }, 90_000);

  it("a card answer that was already answered is not given to the Retry's successor again", async () => {
    const f = await fixture();
    // PLANTED: a run whose own input names the card succeeded and replied after the answer and before the failed
    // run (which still names the card), so the answer is ANSWERED.
    const [answering] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId, interactionIds: [f.cardId] },
      createdAt: at(19.8), finishedAt: at(19.5) }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: answering!.id, body: "Done with the first exact scope.", createdAt: at(19.5) });
    expect(await cardAnswerAnswered(f.cardId)).toBe(true);

    const { admitted } = await pressRetry(f);
    const runs = await admitted();
    expect(runs).toHaveLength(1);
    expect((runs[0]!.contextSnapshot as Record<string, unknown>).interactionIds, "nothing owed: nothing carried").toBeUndefined();
    expect(await materializedCardAnswers(f, runs[0]!)).toEqual([]);
  }, 90_000);
});
