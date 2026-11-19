import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, companyMemberships, createDb, heartbeatRunEvents,
  heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issues, issueThreadInteractions, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { heartbeatService } from "../heartbeat.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { nativeContinuationAttributionContext } from "../native-runtime/status-decision-committer.js";
import { settleUnansweredPersonMessagesForTask, unansweredPersonMessageCommentCondition, UNANSWERED_CARD_ANSWER_NO_REPLY_TEXT, UNANSWERED_CARD_ANSWER_NO_RUN_TEXT,
  UNANSWERED_CARD_ANSWER_TEXT, UNANSWERED_MESSAGE_NO_REPLY_TEXT, UNANSWERED_MESSAGE_TEXT,
} from "./unanswered-person-message.js";

// Keep (never-OK rule: no person message is silently unanswered, and no extra false notice). RFL rulings 8, 2, 3
// (ANSWERED-PAIR-RULINGS-1118):
// - 8: the SENDER'S OWN Stop of the run that was answering M ends M: no unanswered notice (the Stop line is the
//   one note). A stop by anyone else, a timeout, or a stop of a run that had not read M keeps M owed: one notice.
// - 2: a card the agent posted for M answers M while it is ANSWERABLE (pending, or answered by the person),
//   whatever the posting run's later status.
// - 3: a card that EXPIRED unanswered no longer counts: M is owed again and gets the no_reply notice.
// Real disposable PostgreSQL; the person's messages go through the real comment route, Stop through the real
// cancel route (POST /heartbeat-runs/:runId/cancel) and the real cancelRun, the card's answer and expiry through
// the real interaction service, the notice through the real sweep. Only worker admission is controlled: the
// route's wake receipt is persisted, no model or runner is launched; runs and the card row are inserted.
vi.mock("../heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../heartbeat.js")>();
  return { ...actual, heartbeatService: (db: ReturnType<typeof createDb>) => ({
    ...actual.heartbeatService(db),
    wakeup: async (agentId: string, options: { source: string; triggerDetail?: string; reason?: string; idempotencyKey?: string;
      requestedByActorType?: string; requestedByActorId?: string | null; payload?: Record<string, unknown> }) => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId, source: options.source,
        triggerDetail: options.triggerDetail, reason: options.reason, idempotencyKey: options.idempotencyKey,
        requestedByActorType: options.requestedByActorType, requestedByActorId: options.requestedByActorId,
        payload: options.payload, status: "failed", error: "controlled worker admission: no carrier", finishedAt: new Date(),
      }).returning();
      return { id: wake.id };
    },
  }) };
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("the sender's own Stop and an answerable card end the owed message (RFL rulings 8, 2, 3)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("answered-stop-and-card-");
    db = createDb(database.connectionString);
  }, 240_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sender = `sender-${randomUUID()}`, other = `other-${randomUUID()}`;
    const startedAt = Date.now();
    await db.insert(companies).values({ id: companyId, name: "Stop and card rows", issuePrefix: `A${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values([sender, other].map(principalId => ({ companyId, principalType: "user",
      principalId, status: "active", membershipRole: "owner" })));
    await db.insert(agents).values({ id: agentId, companyId, name: "Stack lead", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with Stack lead", status: "in_progress",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: sender,
      conversationState: "active", conversationSessionGeneration: 0 });
    // An unrelated running task holds the agent's one slot, as production's admission queue does: nothing starts.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId: randomUUID() } });

    const app = (userId: string) => {
      const a = express(); a.use(express.json());
      a.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = { type: "board", userId, source: "session", companyIds: [companyId],
          isInstanceAdmin: true, memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
        next();
      });
      a.use("/api", agentRoutes(db));
      a.use("/api", issueRoutes(db, {} as never));
      a.use(errorHandler);
      return a;
    };
    const send = async (body: string) => {
      const response = await request(app(sender)).post(`/api/issues/${issueId}/comments`).send({ body, clientRequestId: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body).toMatchObject({ authorType: "user", authorUserId: sender });
      return response.body.id as string;
    };
    /** The run the message started: its OWN input names it. `read`: the model read it and began to answer. */
    const startRun = async (messageId: string, read = true) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", nativeIssueId: issueId,
        scopeKind: "issue", issueId, responsibleUserId: sender, status: "running", startedAt: new Date(),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", commentId: messageId, wakeCommentId: messageId,
          wakeCommentIds: [messageId] } });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed" });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await db.update(agentWakeupRequests).set({ status: "completed", runId, error: null, finishedAt: new Date() }).where(and(
        eq(agentWakeupRequests.companyId, companyId), sql`${agentWakeupRequests.payload}->>'commentId' = ${messageId}`));
      if (read) await db.insert(heartbeatRunEvents).values(["userMessage", "agentMessage"].map((kind, index) => ({
        companyId, agentId, runId, seq: index + 1, eventType: "item.started", sourceEventId: `source-${randomUUID()}`,
        payload: { prpEvent: { eventType: "item.started", turnId: `turn-${runId}`, itemId: `item-${index}`,
          payload: { kind, item: { type: kind } } } } })));
      return runId;
    };
    const readRun = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
    /** The real Stop route, as `by`. */
    const stop = async (runId: string, by: string) => {
      const response = await request(app(by)).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const run = await readRun(runId);
      expect(run).toMatchObject({ status: "cancelled", resultJson: { cancelledByActorType: "user", cancelledByUserId: by } });
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      return run;
    };
    const end = async (runId: string, status: "succeeded" | "failed" | "timed_out") => {
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date(),
        ...(status === "failed" ? { errorCode: "adapter_failed", error: "adapter_failed: the model call failed" } : {}),
        ...(status === "timed_out" ? { errorCode: "timeout", error: "timeout: the run timed out" } : {}) }).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    };
    /** A question card the agent posted from this run, addressed to the sender. */
    const card = async (runId: string) => {
      const [row] = await db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId: runId, kind: "ask_user_questions",
        status: "pending", createdByAgentId: agentId, addresseeUserId: sender, continuationPolicy: "none",
        payload: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", required: true, selectionMode: "single",
          options: [{ id: "first", label: "First" }] }] } as never }).returning();
      return row!.id;
    };
    const cardStatus = async (cardId: string) => (await db.select({ status: issueThreadInteractions.status,
      resolvedByUserId: issueThreadInteractions.resolvedByUserId }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cardId)))[0]!;
    const sweep = (minutes: number) => settleUnansweredPersonMessagesForTask(db, { companyId, issueId,
      now: new Date(startedAt + minutes * 60_000) });
    const answered = async (messageId: string) => (await db.select({ answered: answeredPersonMessageSql({
      id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`,
      createdAt: sql`${issueComments.createdAt}` }) }).from(issueComments).where(eq(issueComments.id, messageId)))[0]!.answered;
    /** Every unanswered notice EVER written on the task (retired ones too). */
    const notices = async () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    /** The person answers the card through the real interaction service. */
    const answer = async (cardId: string) => {
      await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, cardId,
        { answers: [{ questionId: "scope", optionIds: ["first"] }] } as never, { userId: sender });
      expect(await cardStatus(cardId)).toEqual({ status: "answered", resolvedByUserId: sender });
    };
    /** The run that took the person's card answer as its OWN input (the answer-resume wake context, routes/issues.ts). */
    const resumeRun = async (cardId: string, status: "succeeded" | "failed", reply = false) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", nativeIssueId: issueId,
        scopeKind: "issue", issueId, responsibleUserId: sender, status, startedAt: new Date(), finishedAt: new Date(),
        ...(status === "failed" ? { errorCode: "adapter_failed", error: "adapter_failed: the model call failed" } : {}),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", interactionId: cardId,
          interactionStatus: "answered", source: "issue.interaction.respond" } });
      await db.update(issueQuestionResponseDeliveries).set({ targetRunId: runId, status: "fallback_queued", deliveryMode: "wake_fallback" })
        .where(eq(issueQuestionResponseDeliveries.interactionId, cardId));
      if (reply) await db.insert(issueComments).values({ companyId, issueId, body: "Done, with the first scope.", authorType: "agent",
        authorAgentId: agentId, createdByRunId: runId, createdAt: new Date(Date.now() + 1000) });
      return runId;
    };
    /** The sweeps' clock: `minutes` after the fixture started. */
    const at = (minutes: number) => new Date(startedAt + minutes * 60_000);
    return { companyId, agentId, issueId, sender, other, send, startRun, readRun, stop, end, card, cardStatus, sweep, answered, notices,
      answer, resumeRun, at, app };
  }
  const key = (id: string) => ({ authorizationReason: `unanswered_message:${id}` });
  const PASSES = [1, 3, 11, 30];

  it("ruling 8: the sender's own Stop of the run that was answering M -> no unanswered notice, at any pass", async () => {
    const f = await fixture();
    const m = await f.send("M: write the document.");
    await f.stop(await f.startRun(m), f.sender);
    expect(await f.answered(m), "a stopped run answered nothing: M is not ANSWERED, it is ended by its sender's Stop").toBe(false);
    for (const minutes of PASSES) expect(await f.sweep(minutes)).toEqual({ noticed: 0, pending: 0 });
    expect(await f.notices(), "no notice was ever written").toHaveLength(0);
  }, 60_000);

  it("negative: ANOTHER user's Stop of the run -> M is still owed: exactly one notice", async () => {
    const f = await fixture();
    const m = await f.send("M: write the document.");
    const run = await f.startRun(m);
    await f.stop(run, f.other);
    const counts = [];
    for (const minutes of PASSES) counts.push((await f.sweep(minutes)).noticed);
    expect(counts.reduce((a, b) => a + b, 0), "one notice written over all passes").toBe(1);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT, metadata: { ...key(m), sourceRunId: run } });
  }, 60_000);

  it("negative: the SYSTEM cancels the run (no user attribution) -> M is still owed: exactly one notice", async () => {
    const f = await fixture();
    const m = await f.send("M: write the document.");
    const run = await f.startRun(m);
    await heartbeatService(db).cancelRun(run, "Cancelled by system", { errorCode: "cancelled" });
    expect(await f.readRun(run)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect((await f.readRun(run)).resultJson?.cancelledByUserId, "no user stopped it").toBeUndefined();
    for (const minutes of PASSES) await f.sweep(minutes);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT, metadata: { ...key(m), sourceRunId: run } });
  }, 60_000);

  it("negative: the run TIMED OUT -> M is still owed: exactly one notice", async () => {
    const f = await fixture();
    const m = await f.send("M: write the document.");
    const run = await f.startRun(m);
    await f.end(run, "timed_out");
    for (const minutes of PASSES) await f.sweep(minutes);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT, metadata: { ...key(m), sourceRunId: run } });
  }, 60_000);

  it("negative: the sender's own Stop of a run that had NOT read M -> M is still owed: exactly one notice", async () => {
    const f = await fixture();
    const m = await f.send("M: write the document.");
    const run = await f.startRun(m, false);
    await f.stop(run, f.sender);
    for (const minutes of PASSES) await f.sweep(minutes);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, metadata: { ...key(m), sourceRunId: run } });
  }, 60_000);

  it("own-Stop M1 plus an unanswered M2 in another group -> exactly one notice, M2's", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: write the document.");
    await f.stop(await f.startRun(m1), f.sender);
    const m2 = await f.send("M2: what is the release version?");
    const run2 = await f.startRun(m2);
    await f.end(run2, "failed");
    expect([await f.answered(m1), await f.answered(m2)]).toEqual([false, false]);
    const counts = [];
    for (const minutes of PASSES) counts.push((await f.sweep(minutes)).noticed);
    expect(counts.reduce((a, b) => a + b, 0), "one notice written over all passes").toBe(1);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT, metadata: { ...key(m2), sourceRunId: run2 } });
    expect((all[0]!.metadata as { unansweredMessageIds?: string[] }).unansweredMessageIds, "it does not name M1").toBeUndefined();
  }, 60_000);

  it.each(["succeeded", "failed"] as const)(
    "ruling 2: a PENDING card the agent posted for M answers M, whatever the run's later status (%s) -> no notice", async status => {
      const f = await fixture();
      const m = await f.send("M: deploy it.");
      const run = await f.startRun(m);
      const cardId = await f.card(run);
      await f.end(run, status);
      expect(await f.cardStatus(cardId)).toMatchObject({ status: "pending" });
      expect(await f.answered(m), "the answerable card is M's response").toBe(true);
      for (const minutes of PASSES) expect(await f.sweep(minutes)).toEqual({ noticed: 0, pending: 0 });
      expect(await f.notices(), "no notice was ever written").toHaveLength(0);
    }, 60_000);

  // RFL ruling 4, the CARD-ANSWER DUTY. Superseded am5 row (old -> new): "ruling 2: a card ANSWERED by the person
  // answers M -> no notice" asserted NO notice at +1/+3/+11/+30 min although no run ever took the answer. New: M
  // still gets none (the card answers M), and the ANSWER, which no run started for, gets its ONE no-run line.
  const cardFixture = async () => {
    const f = await fixture();
    const m = await f.send("M: deploy it.");
    const run = await f.startRun(m);
    const cardId = await f.card(run);
    await f.end(run, "succeeded");
    await f.answer(cardId);
    expect(await f.answered(m), "the card the person answered is M's response").toBe(true);
    return { ...f, m, run, cardId };
  };
  it("ruling 4: card answered, the run that took the answer SUCCEEDS with a reply -> no line, at any pass", async () => {
    const f = await cardFixture();
    await f.resumeRun(f.cardId, "succeeded", true);
    for (const minutes of PASSES) expect(await f.sweep(minutes)).toEqual({ noticed: 0, pending: 0 });
    expect(await f.notices(), "no notice was ever written").toHaveLength(0);
  }, 60_000);

  it("ruling 4: card answered, the run that took the answer FAILS -> exactly one 'your answer' line, none for M", async () => {
    const f = await cardFixture();
    const resume = await f.resumeRun(f.cardId, "failed");
    const counts = [];
    for (const minutes of PASSES) counts.push((await f.sweep(minutes)).noticed);
    expect(counts.reduce((a, b) => a + b, 0), "one notice written over all passes").toBe(1);
    const all = await f.notices();
    expect(all, "exactly one notice, ever: the answer's, never one for M too").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_CARD_ANSWER_TEXT, metadata: { ...key(f.cardId), sourceRunId: resume } });
    expect(all[0]!.body).toBe("Your answer wasn't acted on: the run that picked it up failed. Retry is safe; if it fails again, assign this agent a new task.");
    expect((all[0]!.presentation as { title?: string } | null)?.title).toBe("Your answer wasn't acted on");
    // A later run that takes the answer as its own input and replies retires the line; nothing new is written.
    await f.resumeRun(f.cardId, "succeeded", true);
    expect(await f.sweep(31)).toEqual({ noticed: 0, pending: 0 });
    const after = await f.notices();
    expect(after).toHaveLength(1);
    expect(after[0]!.deletedAt, "the answered answer's line is retired").not.toBeNull();
  }, 60_000);

  it("ruling 4: the answer's run FAILS and a native-status continuation that carries the answer for attribution replies -> no line", async () => {
    const f = await cardFixture();
    await f.resumeRun(f.cardId, "failed");
    // The schedule_retry successor continues the same conversation: it names the answer in attributionInteractionIds only
    // (status-decision-committer.ts nativeContinuationAttributionContext), never as prompt input.
    const successor = await f.resumeRun(f.cardId, "succeeded", true);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_status_changed",
      source: "native_status_decision", attributionInteractionIds: [f.cardId] } }).where(eq(heartbeatRuns.id, successor));
    for (const minutes of PASSES) expect(await f.sweep(minutes)).toEqual({ noticed: 0, pending: 0 });
    expect(await f.notices(), "no notice was ever written").toHaveLength(0);
    // Control: a successor that does NOT name the answer does not answer it (never ancestry): the answer keeps its one line.
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_status_changed",
      source: "native_status_decision" } }).where(eq(heartbeatRuns.id, successor));
    expect((await f.sweep(31)).noticed).toBe(1);
    expect(await f.notices()).toMatchObject([{ deletedAt: null, body: UNANSWERED_CARD_ANSWER_TEXT, metadata: key(f.cardId) }]);
  }, 60_000);

  // merged9 item 1, the TWO-HOP carry, card half (onm1-13rows.md 'GAP (probe D)': continuation-comment-input.ts:41
  // ignored attributionInteractionIds). Both successors' contexts are built by the REAL producer
  // (nativeContinuationAttributionContext, the schedule_retry effect, status-decision-committer.ts:962) over the run
  // each continues; only the run rows and their outcomes are planted.
  it("merged9 two-hop carry, card half: a native-status continuation of a native-status continuation still names the card answer (attribution only) -> no line", async () => {
    const f = await cardFixture();
    const resume = await f.resumeRun(f.cardId, "failed");
    const hop = async (origin: string, status: "succeeded" | "failed", reply: boolean) => {
      const carried = await nativeContinuationAttributionContext(db, { companyId: f.companyId, issueId: f.issueId, originRunId: origin });
      const runId = await f.resumeRun(f.cardId, status, reply);
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, taskId: f.issueId, ...carried,
        wakeReason: "issue_status_changed", source: "native_status_decision" } }).where(eq(heartbeatRuns.id, runId));
      return { runId, carried };
    };
    const hop1 = await hop(resume, "failed", false);
    expect(hop1.carried, "hop 1: the real producer names the answer").toEqual({ attributionInteractionIds: [f.cardId] });
    const hop2 = await hop(hop1.runId, "succeeded", true);
    expect(hop2.carried, "hop 2: still named, and only for attribution (never interactionId(s): no second prompt)")
      .toEqual({ attributionInteractionIds: [f.cardId] });
    for (const minutes of PASSES) expect(await f.sweep(minutes)).toEqual({ noticed: 0, pending: 0 });
    expect(await f.notices(), "no notice was ever written").toHaveLength(0);
  }, 60_000);

  it("ruling 4: card answered, the run that took the answer FINISHES WITHOUT A REPLY -> exactly one finished-without-a-reply line", async () => {
    const f = await cardFixture();
    const resume = await f.resumeRun(f.cardId, "succeeded");
    for (const minutes of PASSES) await f.sweep(minutes);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_CARD_ANSWER_NO_REPLY_TEXT, metadata: { ...key(f.cardId), sourceRunId: resume } });
    expect(all[0]!.body).toBe("This run finished without a reply to your answer. Sending it again is safe.");
  }, 60_000);

  it("ruling 4: card answered, NO RUN starts for the answer -> nothing while its delivery may still start, then exactly one no-run line", async () => {
    const f = await cardFixture();
    expect(await db.select({ status: issueQuestionResponseDeliveries.status }).from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, f.cardId)), "the real answer left its delivery waiting for a run")
      .toEqual([{ status: "pending" }]);
    const counts = [];
    for (const minutes of PASSES) counts.push((await f.sweep(minutes)).noticed);
    expect(counts, "none at +1 and +3 min; one at +11 min (10 min after the answer); never a second").toEqual([0, 0, 1, 0]);
    const all = await f.notices();
    expect(all, "exactly one notice, ever: the answer's, never one for M").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_CARD_ANSWER_NO_RUN_TEXT, metadata: key(f.cardId) });
    expect(all[0]!.body).toBe("Your answer is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.");
  }, 60_000);

  it("ruling 4 edge: a newer typed message after the answer is the owed input, not the answer", async () => {
    const f = await cardFixture();
    await f.resumeRun(f.cardId, "failed");
    const later = await f.send("Hello?");
    const run2 = await f.startRun(later);
    await f.end(run2, "failed");
    for (const minutes of PASSES) await f.sweep(minutes);
    const all = await f.notices();
    expect(all, "exactly one notice, ever: the later message's").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT, metadata: { ...key(later), sourceRunId: run2 } });
  }, 60_000);

  it("ruling 3: a card that EXPIRED unanswered no longer counts -> M is owed again: exactly one no_reply notice", async () => {
    const f = await fixture();
    const m = await f.send("M: deploy it.");
    const run = await f.startRun(m);
    const cardId = await f.card(run);
    await f.end(run, "succeeded");
    expect(await f.answered(m)).toBe(true);
    expect(await f.sweep(3)).toEqual({ noticed: 0, pending: 0 });
    expect(await f.notices(), "while the card is answerable: no notice").toHaveLength(0);
    const expired = await issueThreadInteractionService(db).expirePendingInteractionsForTerminalIssue(
      { id: f.issueId, companyId: f.companyId, status: "cancelled" }, { systemId: "expiry" } as never);
    expect(expired.map(row => row.id)).toEqual([cardId]);
    expect(await f.cardStatus(cardId)).toEqual({ status: "expired", resolvedByUserId: null });
    expect(await f.answered(m), "the visible next step is gone: M is owed again").toBe(false);
    const counts = [];
    for (const minutes of [5, 11, 30]) counts.push((await f.sweep(minutes)).noticed);
    expect(counts, "one notice, on the first pass after the expiry").toEqual([1, 0, 0]);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_REPLY_TEXT, metadata: { ...key(m), sourceRunId: run } });
  }, 60_000);

  // Ruling (b): a card CANCELLED by the PERSON's own skip or withdrawal (resolved_by_user_id is that person's actor
  // id) counts as answered: no notice. A cancel with no person behind it (system / agent) does not: M is owed.
  // The person's rows go through the REAL board routes (routes/issues.ts POST /issues/:id/interactions/:id/skip,
  // /withdraw and /cancel -> skipInteraction / withdrawInteraction / cancelQuestions); the system row calls the REAL
  // withdrawInteraction service with a non-person actor, as tool-gateway.ts expireElicitationRound does (agent id,
  // no user). The message, the run and the card row are inserted, as in the rows above.
  it.each([["skip", "skipped"], ["withdraw", "withdrawn"], ["cancel", null]] as const)(
    "ruling (b): the PERSON's own %s of the card (real route, by the person's actor id) counts as answered -> 0 notices", async (route, outcome) => {
      const f = await fixture();
      const m = await f.send("M: deploy it.");
      const run = await f.startRun(m);
      const cardId = await f.card(run);
      await f.end(run, "succeeded");
      const response = await request(f.app(f.sender)).post(`/api/issues/${f.issueId}/interactions/${cardId}/${route}`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cardId));
      expect(row, "the route cancelled the card BY THE PERSON").toMatchObject({ status: "cancelled", resolvedByUserId: f.sender,
        resolvedByAgentId: null });
      if (outcome) expect((row!.result as unknown as Record<string, unknown>).outcome).toBe(outcome);
      else expect((row!.result as unknown as Record<string, unknown>).cancelled).toBe(true);
      expect(await f.answered(m), "the person's own skip / withdrawal is their answer to the card").toBe(true);
      const counts = [];
      for (const minutes of PASSES) counts.push((await f.sweep(minutes)).noticed);
      expect(counts).toEqual([0, 0, 0, 0]);
      expect(await f.notices(), "no notice, ever").toHaveLength(0);
    }, 60_000);

  it("ruling (b): a SYSTEM cancel of the card (the real withdrawInteraction service, no person actor) does not count -> M is owed: exactly 1 notice", async () => {
    const f = await fixture();
    const m = await f.send("M: deploy it.");
    const run = await f.startRun(m);
    const cardId = await f.card(run);
    await f.end(run, "succeeded");
    expect(await f.answered(m), "while the card is pending it answers M").toBe(true);
    await issueThreadInteractionService(db).withdrawInteraction({ id: f.issueId, companyId: f.companyId }, cardId,
      { reason: "The app's question expired before it was answered." }, { agentId: f.agentId });
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cardId));
    expect(row, "the SAME cancelled shape as the person's withdrawal, but no person resolved it").toMatchObject({ status: "cancelled",
      resolvedByUserId: null, result: { outcome: "withdrawn" } });
    expect(await f.answered(m), "a card nobody can answer and no person closed: M is owed again").toBe(false);
    const counts = [];
    for (const minutes of [5, 11, 30]) counts.push((await f.sweep(minutes)).noticed);
    expect(counts, "one notice on the first pass after the cancel, never another").toEqual([1, 0, 0]);
    const all = await f.notices();
    expect(all, "exactly one notice, ever").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_REPLY_TEXT, metadata: { ...key(m), sourceRunId: run } });
  }, 60_000);

  // Ruling (b), tightened (am7 gap 6): the skip counts only when the message's SENDER did it, by actor id. Another
  // board user's skip of the card (the same REAL route, as that user) is not the sender's answer: M is owed.
  it.each(["skip", "withdraw", "cancel"] as const)(
    "ruling (b), sender only: ANOTHER board user's %s of the card (real route, their actor id) does not count -> M is owed: exactly 1 notice", async route => {
      const f = await fixture();
      const m = await f.send("M: deploy it.");
      const run = await f.startRun(m);
      const cardId = await f.card(run);
      await f.end(run, "succeeded");
      expect(await f.answered(m), "while the card is pending it answers M").toBe(true);
      const response = await request(f.app(f.other)).post(`/api/issues/${f.issueId}/interactions/${cardId}/${route}`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cardId));
      expect(row, "the route cancelled the card BY THE OTHER USER, not by the sender").toMatchObject({ status: "cancelled",
        resolvedByUserId: f.other, resolvedByAgentId: null });
      expect(f.other).not.toBe(f.sender);
      expect(await f.answered(m), "another user's skip is not the sender's answer: M is owed").toBe(false);
      const counts = [];
      for (const minutes of [5, 11, 30]) counts.push((await f.sweep(minutes)).noticed);
      expect(counts, "one notice on the first pass after the skip, never another").toEqual([1, 0, 0]);
      const all = await f.notices();
      expect(all, "exactly one notice, ever").toHaveLength(1);
      expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_REPLY_TEXT, metadata: { ...key(m), sourceRunId: run } });
    }, 60_000);

  it("ruling 3, am5 gap 17: M's notice retired while a card answered M; the card then EXPIRES -> M gets its no_reply notice again", async () => {
    const f = await fixture();
    const m = await f.send("M: deploy it.");
    const run1 = await f.startRun(m);
    await f.end(run1, "failed");
    expect((await f.sweep(1)).noticed, "M's failed run: its one notice").toBe(1);
    // A later run takes M again and asks the person a question: the card answers M, so the notice retires.
    const run2 = await f.startRun(m);
    const cardId = await f.card(run2);
    await f.end(run2, "succeeded");
    expect(await f.answered(m)).toBe(true);
    expect(await f.sweep(3)).toEqual({ noticed: 0, pending: 0 });
    const retired = await f.notices();
    expect(retired).toHaveLength(1);
    expect(retired[0]!.deletedAt, "the notice retired while the card stood").not.toBeNull();
    // The card expires unanswered, after the notice retired (on the sweeps' clock): M is owed again (ruling 3).
    await issueThreadInteractionService(db).expirePendingInteractionsForTerminalIssue(
      { id: f.issueId, companyId: f.companyId, status: "cancelled" }, { systemId: "expiry" } as never);
    expect(await f.cardStatus(cardId)).toEqual({ status: "expired", resolvedByUserId: null });
    await db.update(issueThreadInteractions).set({ resolvedAt: f.at(4), updatedAt: f.at(4) }).where(eq(issueThreadInteractions.id, cardId));
    expect(await f.answered(m)).toBe(false);
    expect(await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.id, m),
      unansweredPersonMessageCommentCondition())), "discovery flags M again: the retired notice no longer stands").toHaveLength(1);
    const counts = [];
    for (const minutes of [5, 11, 30]) counts.push((await f.sweep(minutes)).noticed);
    expect(counts, "one new notice on the first pass after the expiry, never another").toEqual([1, 0, 0]);
    const all = (await f.notices()).sort((x, y) => Number(x.deletedAt === null) - Number(y.deletedAt === null));
    expect(all, "the retired notice and the ONE live one").toHaveLength(2);
    expect(all[0]!.deletedAt).not.toBeNull();
    expect(all[1]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_REPLY_TEXT, metadata: { ...key(m), sourceRunId: run2 } });
  }, 60_000);

  it("ruling 2 edge: a card posted for a LATER message, or before M, does not answer M -> M keeps its one notice", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: deploy it.");
    const run1 = await f.startRun(m1);
    await f.end(run1, "failed");
    const m2 = await f.send("M2: and the release version?");
    const run2 = await f.startRun(m2);
    await f.card(run2);
    await f.end(run2, "succeeded");
    expect([await f.answered(m1), await f.answered(m2)], "the card answers only its own run's input").toEqual([false, true]);
    for (const minutes of PASSES) await f.sweep(minutes);
    const all = await f.notices();
    expect(all, "exactly one notice, ever: M1's").toHaveLength(1);
    expect(all[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT, metadata: { ...key(m1), sourceRunId: run1 } });
  }, 60_000);
});
