import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { settleUnansweredPersonMessage, settleUnansweredPersonMessagesForTask, unansweredPersonMessageCondition,
  UNANSWERED_MESSAGE_NO_RUN_TEXT, UNANSWERED_MESSAGE_TEXT } from "./unanswered-person-message.js";

// Keep (never-OK rule: no person message is silently unanswered, and never two lines for one message): the sweep
// owes EVERY unanswered person message and writes ONE notice per owed GROUP (RFL ruling B, 11-18 17:50Z): the
// messages one failed or reply-less run carried in its own input, or one no-run batch settled in the same pass.
// Built on the SA-2205 fixture (sa2205-stranded-notice-survives.test.ts); was the merged2 builder's probe.
// Only worker admission is controlled: persist the route's real wake receipt,
// but do not launch a model/runner. Routes, authorization, comments, answer
// attribution, notice retirement and the clocked sweep all use product code.
vi.mock("../heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../heartbeat.js")>();
  return { ...actual, heartbeatService: (db: ReturnType<typeof createDb>) => ({
    ...actual.heartbeatService(db),
    wakeup: async (agentId: string, options: {
      source: string; triggerDetail?: string; reason?: string; idempotencyKey?: string;
      requestedByActorType?: string; requestedByActorId?: string | null;
      payload?: Record<string, unknown>;
    }) => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId, agentId, source: options.source,
        triggerDetail: options.triggerDetail, reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        requestedByActorType: options.requestedByActorType,
        requestedByActorId: options.requestedByActorId, payload: options.payload,
        status: "failed", error: "SA-2205 controlled worker admission: no carrier", finishedAt: new Date(),
      }).returning();
      return { id: wake.id };
    },
  }) };
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`SA-2205 embedded Postgres unsupported: ${support.reason}`);
describe.skipIf(!support.supported)("the sweep owes every unanswered person message: one notice per owed group (RFL ruling B)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sweep-owes-every-message-");
    db = createDb(database.connectionString);
  }, 240_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `sa2205-person-${randomUUID()}`;
    const startedAt = Date.now();
    await db.insert(companies).values({ id: companyId, name: "SA-2205 regression", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stack lead", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with Stack lead", status: "in_progress",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", conversationSessionGeneration: 0 });

    function app(runId?: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = runId
          ? { type: "agent", agentId, runId, companyId, source: "agent_jwt" }
          : { type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
            memberships: [{ companyId, status: "active", membershipRole: "owner" }] };
        next();
      });
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      return app;
    }
    const personApp = app();
    const commentsUrl = `/api/issues/${issueId}/comments`;
    const send = async (body: string) => {
      const response = await request(personApp).post(commentsUrl).send({ body, clientRequestId: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.authorType).toBe("user");
      return response.body.id as string;
    };
    const read = async () => {
      const response = await request(personApp).get(commentsUrl).query({ order: "asc" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body as Array<typeof issueComments.$inferSelect>;
    };
    const sweep = (minutes: number) => settleUnansweredPersonMessage(db, {
      companyId, issueId, now: new Date(startedAt + minutes * 60_000),
    });
    const noticesFor = async (messageId: string) => db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"),
      sql`${issueComments.metadata}->>'authorizationReason' = ${`unanswered_message:${messageId}`}`,
    ));
    const answerState = async (messageId: string) => {
      const [row] = await db.select({ answered: answeredPersonMessageSql({
        id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}`,
      }) }).from(issueComments).where(eq(issueComments.id, messageId));
      return row.answered;
    };
    const succeedWithReply = async (messageId: string, body: string) => {
      const contextSnapshot = { issueId, conversationSessionGeneration: 0,
        wakeReason: "issue_commented", commentId: messageId, wakeCommentId: messageId,
        wakeCommentIds: [messageId], firstTurnQueuedInput: { commentIds: [messageId] } };
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, startedAt: new Date(), contextSnapshot,
      }).returning();
      await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issueId));
      const response = await request(app(run.id)).post(commentsUrl).send({ body });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body).toMatchObject({ authorType: "agent", createdByRunId: run.id });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      await db.update(agentWakeupRequests).set({ status: "completed", runId: run.id, error: null, finishedAt: new Date() }).where(and(
        eq(agentWakeupRequests.companyId, companyId), sql`${agentWakeupRequests.payload}->>'commentId' = ${messageId}`,
      ));
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(finished.status).toBe("succeeded");
      return { ...finished, contextSnapshot: finished.contextSnapshot as typeof contextSnapshot, replyId: response.body.id as string };
    };
    const flagged = async () => (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issueId),
      unansweredPersonMessageCondition(issues.id, issues.companyId)))).length === 1;
    const allNotices = async () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), sql`starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')`));
    /** A run whose OWN input names the message(s); it is left running until the caller ends it. */
    const startRun = async (...messageIds: string[]) => {
      const last = messageIds[messageIds.length - 1];
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, startedAt: new Date(), contextSnapshot: { issueId, conversationSessionGeneration: 0,
          wakeReason: "issue_commented", commentId: last, wakeCommentId: last, wakeCommentIds: messageIds } }).returning();
      for (const messageId of messageIds) {
        await db.update(agentWakeupRequests).set({ status: "completed", runId: run.id, error: null, finishedAt: new Date() }).where(and(
          eq(agentWakeupRequests.companyId, companyId), sql`${agentWakeupRequests.payload}->>'commentId' = ${messageId}`));
      }
      return run.id;
    };
    /** Every notice ever written that covers the message: its key names it, or its still-owed member list does. */
    const coveredBy = async (messageId: string) => (await allNotices()).filter(notice => {
      const metadata = notice.metadata as { authorizationReason?: string; unansweredMessageIds?: string[] };
      return metadata.authorizationReason === `unanswered_message:${messageId}` || (metadata.unansweredMessageIds ?? []).includes(messageId);
    });
    /** What a notice names: [key message, still-owed member list]. */
    const names = (notice: { metadata: unknown }) => {
      const metadata = notice.metadata as { authorizationReason?: string; unansweredMessageIds?: string[] };
      return [metadata.authorizationReason, metadata.unansweredMessageIds];
    };
    const failRun = (runId: string) => db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed",
      error: "adapter_failed: the model call failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    /** The message's own wake is HELD behind the running turn (Paperclip's deferred_issue_execution), not failed. */
    const holdWake = async (messageId: string) => {
      const held = await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", error: null, finishedAt: null }).where(and(
        eq(agentWakeupRequests.companyId, companyId), sql`${agentWakeupRequests.payload}->>'commentId' = ${messageId}`)).returning();
      expect(held, "the message's own wake row exists and is now held").toHaveLength(1);
    };
    const sweepTask = (minutes: number) => settleUnansweredPersonMessagesForTask(db, {
      companyId, issueId, now: new Date(startedAt + minutes * 60_000) });
    return { companyId, issueId, agentId, send, read, sweep, sweepTask, noticesFor, allNotices, answerState, succeedWithReply,
      flagged, startRun, failRun, holdWake, coveredBy, names };
  }

  const live = (rows: Array<{ deletedAt: Date | null }>) => rows.filter(row => row.deletedAt === null);

  it("probe: M1 has no notice yet when a later M2 is answered: M1 still gets its ONE notice, M2 none", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: Please investigate the deployment failure.");
    const m2 = await f.send("M2: Separately, what is the current release version?");
    await f.succeedWithReply(m2, "M2 only: 1.2.3.");
    expect([await f.answerState(m1), await f.answerState(m2)], "the one function: M1 owed, M2 answered").toEqual([false, true]);
    expect(await f.flagged(), "discovery flags the task for M1").toBe(true);
    const first = await f.sweep(3);
    expect(first, "the sweep writes M1's notice although the latest message is answered").toMatchObject({ kind: "noticed", code: "no_run" });
    const again = [await f.sweep(10), await f.sweep(30)];
    expect(again, "no second notice on later passes").toEqual([{ kind: "answered" }, { kind: "answered" }]);
    const m1Notices = await f.noticesFor(m1);
    expect(m1Notices, "M1 has exactly ONE notice").toHaveLength(1);
    expect(m1Notices[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_RUN_TEXT,
      metadata: { authorizationReason: `unanswered_message:${m1}` } });
    expect(await f.noticesFor(m2), "the answered M2 gets no notice").toHaveLength(0);
    expect(await f.allNotices(), "one notice on the task in all").toHaveLength(1);
    expect(await f.flagged(), "discovery stops flagging once every owed message has its notice").toBe(false);
  }, 60_000);

  it("probe: M1 and M2 both unanswered -> each owed message is covered by exactly ONE notice (one for the batch)", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    const m2 = await f.send("M2: second.");
    expect([await f.answerState(m1), await f.answerState(m2)]).toEqual([false, false]);
    expect(await f.sweepTask(3), "one pass, one notice for the no-run batch").toEqual({ noticed: 1, pending: 0 });
    expect([await f.sweepTask(10), await f.sweepTask(30)], "no second notice").toEqual([{ noticed: 0, pending: 0 }, { noticed: 0, pending: 0 }]);
    for (const id of [m1, m2]) expect(await f.coveredBy(id), `message ${id === m1 ? "M1" : "M2"} is covered by exactly ONE notice`).toHaveLength(1);
    expect(await f.allNotices(), "exactly one notice on the task").toHaveLength(1);
    expect(await f.flagged(), "discovery stops flagging").toBe(false);
  }, 60_000);

  it("(i) one failed run carried M1+M2 in its own input -> exactly ONE notice that names both", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    const m2 = await f.send("M2: second.");
    const run = await f.startRun(m1, m2);
    await f.failRun(run);
    expect([await f.answerState(m1), await f.answerState(m2)], "both owed").toEqual([false, false]);
    expect(await f.sweepTask(3)).toEqual({ noticed: 1, pending: 0 });
    expect([await f.sweepTask(10), await f.sweepTask(30)], "no second notice").toEqual([{ noticed: 0, pending: 0 }, { noticed: 0, pending: 0 }]);
    const notices = await f.allNotices();
    expect(notices, "exactly ONE notice for the group").toHaveLength(1);
    expect(notices[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT });
    expect(f.names(notices[0]), "keyed to the latest member; the list names both").toEqual([`unanswered_message:${m2}`, [m1, m2]]);
    expect(JSON.stringify(notices[0].metadata), "it names the failed run").toContain(run);
    for (const id of [m1, m2]) expect(await f.coveredBy(id), "each member is covered exactly once").toHaveLength(1);
    expect(await f.flagged()).toBe(false);
  }, 60_000);

  it("(ii)+(iii) M2 answered by a run whose own input names M2 -> the notice STAYS and names only M1; M1 answered -> it retires, once", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    const m2 = await f.send("M2: second.");
    await f.failRun(await f.startRun(m1, m2));
    expect(await f.sweepTask(3)).toEqual({ noticed: 1, pending: 0 });
    const [notice] = await f.allNotices();
    await f.succeedWithReply(m2, "M2 only.");
    expect([await f.answerState(m1), await f.answerState(m2)], "the one function: M1 owed, M2 answered").toEqual([false, true]);
    expect(await f.flagged(), "discovery flags the notice: a member was answered").toBe(true);
    expect([await f.sweepTask(4), await f.sweepTask(5)]).toEqual([{ noticed: 0, pending: 0 }, { noticed: 0, pending: 0 }]);
    let notices = await f.allNotices();
    expect(notices, "(ii) still exactly one notice, the same one, live").toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: notice.id, deletedAt: null, body: UNANSWERED_MESSAGE_TEXT });
    expect(f.names(notices[0]), "(ii) it never names the answered M2: key and list name M1 only").toEqual([`unanswered_message:${m1}`, [m1]]);
    expect(JSON.stringify(notices[0].metadata), "(ii) no trace of the answered message").not.toContain(m2);
    expect(await f.coveredBy(m2), "(ii) the answered M2 is covered by no notice").toHaveLength(0);
    expect(await f.flagged()).toBe(false);
    await f.succeedWithReply(m1, "M1 now.");
    expect(await f.flagged(), "discovery flags the notice for retirement").toBe(true);
    await f.sweepTask(6);
    await f.sweepTask(7);
    notices = await f.allNotices();
    expect(notices, "(iii) only ever one notice").toHaveLength(1);
    expect(notices[0].id).toBe(notice.id);
    expect(notices[0].deletedAt, "(iii) retired once every member is answered").not.toBeNull();
    const retiredAt = notices[0].deletedAt;
    await f.sweepTask(8);
    expect((await f.allNotices()).map(row => row.deletedAt), "(iii) retired once, not again").toEqual([retiredAt]);
    expect([await f.answerState(m1), await f.answerState(m2)]).toEqual([true, true]);
    expect(await f.flagged()).toBe(false);
  }, 60_000);

  it("(iv) two SEPARATE failed runs (M1's, M2's) -> two notices, one per group, never two for one message", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    const run1 = await f.startRun(m1);
    await f.failRun(run1);
    const m2 = await f.send("M2: second.");
    const run2 = await f.startRun(m2);
    await f.failRun(run2);
    expect(await f.sweepTask(3)).toEqual({ noticed: 2, pending: 0 });
    expect([await f.sweepTask(10), await f.sweepTask(30)]).toEqual([{ noticed: 0, pending: 0 }, { noticed: 0, pending: 0 }]);
    expect(await f.allNotices(), "two notices, one per failed run").toHaveLength(2);
    for (const [id, run] of [[m1, run1], [m2, run2]]) {
      const covering = await f.coveredBy(id);
      expect(covering, "each message is covered by exactly ONE notice").toHaveLength(1);
      expect(covering[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT });
      expect(f.names(covering[0]), "a group of one: keyed to its message, no list").toEqual([`unanswered_message:${id}`, undefined]);
      expect(JSON.stringify(covering[0].metadata), "it names its own failed run").toContain(run);
    }
    expect(await f.flagged()).toBe(false);
  }, 60_000);

  it("(v) a no-run batch of M1+M2 -> ONE notice; M2 answered -> it stays for M1; retired only when both are answered", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    const m2 = await f.send("M2: second.");
    expect(await f.sweepTask(3)).toEqual({ noticed: 1, pending: 0 });
    const [notice] = await f.allNotices();
    expect(notice).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_RUN_TEXT });
    expect(f.names(notice)).toEqual([`unanswered_message:${m2}`, [m1, m2]]);
    await f.succeedWithReply(m2, "M2 only.");
    await f.sweepTask(4);
    await f.sweepTask(5);
    let notices = await f.allNotices();
    expect(notices, "a later message answered never retires the notice an earlier one still needs").toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: notice.id, deletedAt: null, body: UNANSWERED_MESSAGE_NO_RUN_TEXT });
    expect(f.names(notices[0])).toEqual([`unanswered_message:${m1}`, [m1]]);
    expect(await f.flagged()).toBe(false);
    await f.succeedWithReply(m1, "M1 now.");
    expect(await f.flagged(), "discovery flags the notice for retirement").toBe(true);
    await f.sweepTask(6);
    await f.sweepTask(7);
    notices = await f.allNotices();
    expect(notices, "no second notice for either message").toHaveLength(1);
    expect(notices[0].deletedAt, "retired when both are answered").not.toBeNull();
    expect([await f.answerState(m1), await f.answerState(m2)]).toEqual([true, true]);
    expect(await f.flagged()).toBe(false);
  }, 60_000);

  it("(vi) a LATER message's reply answers neither member: the group's notice stays and still names both", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    const m2 = await f.send("M2: second.");
    await f.failRun(await f.startRun(m1, m2));
    expect(await f.sweepTask(3)).toEqual({ noticed: 1, pending: 0 });
    const [notice] = await f.allNotices();
    const m3 = await f.send("M3: a later, separate question.");
    await f.succeedWithReply(m3, "M3 only.");
    expect([await f.answerState(m1), await f.answerState(m2), await f.answerState(m3)]).toEqual([false, false, true]);
    expect(await f.flagged(), "nothing to settle: no member was answered").toBe(false);
    expect([await f.sweepTask(4), await f.sweepTask(30)]).toEqual([{ noticed: 0, pending: 0 }, { noticed: 0, pending: 0 }]);
    const notices = await f.allNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: notice.id, deletedAt: null, body: UNANSWERED_MESSAGE_TEXT });
    expect(f.names(notices[0])).toEqual([`unanswered_message:${m2}`, [m1, m2]]);
    expect(await f.coveredBy(m3), "the answered M3 has no notice").toHaveLength(0);
  }, 60_000);

  it("control: every message answered by its own succeeded run gets no notice", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    await f.succeedWithReply(m1, "M1 answer.");
    const m2 = await f.send("M2: second.");
    await f.succeedWithReply(m2, "M2 answer.");
    expect(await f.flagged()).toBe(false);
    expect([await f.sweep(3), await f.sweep(30)]).toEqual([{ kind: "answered" }, { kind: "answered" }]);
    expect(await f.allNotices(), "no notice for an answered message").toHaveLength(0);
  }, 60_000);

  it("control: only the latest message is owed: it alone gets the one notice (the behaviour before this fix)", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    await f.succeedWithReply(m1, "M1 answer.");
    const m2 = await f.send("M2: second.");
    expect(await f.sweep(3)).toMatchObject({ kind: "noticed", code: "no_run" });
    expect(await f.sweep(10)).toEqual({ kind: "noticed_before" });
    expect(await f.noticesFor(m1)).toHaveLength(0);
    expect(await f.noticesFor(m2)).toHaveLength(1);
    expect(await f.flagged()).toBe(false);
  }, 60_000);

  it("control: an earlier owed message still inside its no-run grace waits; it is not noticed early", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: first.");
    const m2 = await f.send("M2: second.");
    await f.succeedWithReply(m2, "M2 only.");
    // The route's wake for M1 was recorded FAILED (the mock), which is the trigger; clear it so only the grace decides.
    await db.delete(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      sql`${agentWakeupRequests.payload}->>'commentId' = ${m1}`));
    expect(await f.sweep(1), "inside the 120 s no-run grace: pending, no notice").toMatchObject({ kind: "pending" });
    expect(await f.allNotices()).toHaveLength(0);
    expect(await f.sweep(3)).toMatchObject({ kind: "noticed", code: "no_run" });
    expect(await f.noticesFor(m1)).toHaveLength(1);
  }, 60_000);

  it("M2 held: M1's run fails while M2's wake is held -> each message owed, ONE notice each, M2 answered later once", async () => {
    const f = await fixture();
    const m1 = await f.send("M1: Please investigate the deployment failure.");
    const run1 = await f.startRun(m1);
    const m2 = await f.send("M2: Also check the release version.");
    await f.holdWake(m2);
    expect(await f.sweepTask(1), "M1's turn is in progress: both wait, no notice").toEqual({ noticed: 0, pending: 2 });
    await f.failRun(run1);
    expect([await f.answerState(m1), await f.answerState(m2)], "both owed").toEqual([false, false]);
    // M2's held wake is a further attempt: both waits are bounded (2 min from the first deferral).
    expect(await f.sweepTask(1.5), "bounded wait on the held wake: no notice yet").toEqual({ noticed: 0, pending: 2 });
    expect(await f.allNotices()).toHaveLength(0);
    expect(await f.sweepTask(5), "past the bound: one pass, one notice per message").toEqual({ noticed: 2, pending: 0 });
    expect(await f.sweepTask(6)).toEqual({ noticed: 0, pending: 0 });
    const [n1, n2] = [await f.noticesFor(m1), await f.noticesFor(m2)];
    expect(n1, "M1: ONE notice, the failed-run words").toHaveLength(1);
    expect(n1[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_TEXT });
    expect(JSON.stringify(n1[0].metadata), "M1's notice names its failed run").toContain(run1);
    expect(n2, "M2: ONE notice, the no-run words").toHaveLength(1);
    expect(n2[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_RUN_TEXT });
    expect(await f.flagged()).toBe(false);
    // M2 is answered later, once: its notice is retired; M1 stays owed and keeps its notice.
    await f.succeedWithReply(m2, "M2: 1.2.3.");
    await f.sweepTask(7);
    await f.sweepTask(8);
    expect([await f.answerState(m1), await f.answerState(m2)]).toEqual([false, true]);
    expect(live(await f.noticesFor(m1)), "M1's notice stays").toHaveLength(1);
    expect(live(await f.noticesFor(m2)), "M2's notice is retired").toHaveLength(0);
    expect(await f.allNotices(), "never a second notice").toHaveLength(2);
    const agentReplies = (await f.read()).filter(comment => comment.authorType === "agent");
    expect(agentReplies, "exactly one agent reply (M2's)").toHaveLength(1);
    expect(await f.flagged()).toBe(false);
  }, 60_000);
});
