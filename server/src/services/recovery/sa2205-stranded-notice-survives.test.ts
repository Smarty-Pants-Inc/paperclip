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
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_NO_RUN_TEXT } from "./unanswered-person-message.js";

// Keep: SA-2205, stack-lead's live stranded-message shape on Paul's build.
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
describe.skipIf(!support.supported)("SA-2205: a stranded message owns its unanswered notice", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sa2205-stranded-notice-");
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
    return { companyId, issueId, agentId, send, read, sweep, noticesFor, answerState, succeedWithReply };
  }

  async function strandedM2() {
    const f = await fixture();
    const m2 = await f.send("M2: Please investigate the deployment failure.");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId)), "M2 has no carrying run").toHaveLength(0);
    await f.sweep(3);
    await f.sweep(3);
    const initial = await f.noticesFor(m2);
    expect(initial, "M2 gets exactly ONE initial notice").toHaveLength(1);
    expect(initial[0]).toMatchObject({ deletedAt: null, body: UNANSWERED_MESSAGE_NO_RUN_TEXT,
      metadata: { authorizationReason: `unanswered_message:${m2}` } });
    const visible = await f.read();
    expect(visible.find(c => c.id === initial[0].id)).toMatchObject({ deletedAt: null,
      metadata: { authorizationReason: `unanswered_message:${m2}` } });
    return { ...f, m2, noticeId: initial[0].id };
  }

  it("M3's successful reply must not answer stranded M2 or retire M2's ONE notice at +10 min", async () => {
    const f = await strandedM2();
    const m3 = await f.send("M3: Separately, what is the current release version?");
    const run = await f.succeedWithReply(m3, "M3 only: the current release version is 1.2.3.");
    expect(run.contextSnapshot).toMatchObject({ commentId: m3, wakeCommentId: m3, wakeCommentIds: [m3],
      firstTurnQueuedInput: { commentIds: [m3] } });
    expect(JSON.stringify(run.contextSnapshot), "M3's OWN input never names M2").not.toContain(f.m2);
    await f.sweep(10);
    await f.sweep(10);

    // GET is exactly the person's route. Raw metadata is also inspected because
    // ordinary GET deliberately redacts a soft-deleted notice's body/metadata.
    const visible = await f.read();
    const replies = visible.filter(c => c.authorType === "agent" && !c.deletedAt);
    const m2Notices = await f.noticesFor(f.m2);
    const m3Notices = await f.noticesFor(m3);
    const m2Answered = await f.answerState(f.m2), m3Answered = await f.answerState(m3);
    const attributedReplies = (messageId: string) => replies.filter(c => c.createdByRunId === run.id
      && run.contextSnapshot?.wakeCommentIds?.includes(messageId));
    console.info("SA-2205 stranded evidence", JSON.stringify({ m2: f.m2, m3, runId: run.id, replyId: run.replyId,
      input: run.contextSnapshot, m2Answered, m3Answered, m2AttributedReplies: attributedReplies(f.m2).length,
      m3AttributedReplies: attributedReplies(m3).length, noticeId: f.noticeId,
      noticeFromGET: visible.find(c => c.id === f.noticeId), rawM2Notices: m2Notices, rawM3Notices: m3Notices }));

    expect.soft(attributedReplies(f.m2), "M2 answered 0 times: no published reply carries M2").toHaveLength(0);
    expect.soft(attributedReplies(m3), "M3 answered exactly once by its own run").toHaveLength(1);
    expect.soft(replies, "there is exactly one published agent answer").toHaveLength(1);
    expect.soft(m2Answered, "product answer attribution must leave M2 unanswered").toBe(false);
    expect.soft(m3Answered, "product answer attribution must mark M3 answered").toBe(true);
    expect.soft(m2Notices, "no second notice for M2, including retired notices").toHaveLength(1);
    expect.soft(m2Notices[0]?.id, "M2 keeps the SAME notice").toBe(f.noticeId);
    expect.soft(m2Notices[0]?.deletedAt, "M2's notice is STILL PRESENT, not soft-deleted or retired").toBeNull();
    expect.soft(visible.find(c => c.id === f.noticeId), "person's GET still contains M2's visible notice and metadata").toMatchObject({
      deletedAt: null, body: UNANSWERED_MESSAGE_NO_RUN_TEXT,
      metadata: { authorizationReason: `unanswered_message:${f.m2}` },
    });
    expect.soft(m3Notices, "no notice for answered M3").toHaveLength(0);
  }, 60_000);

  it("CONTROL: a successful run whose OWN input names M2 answers it once and retires its notice", async () => {
    const f = await strandedM2();
    const run = await f.succeedWithReply(f.m2, "M2: the deployment failed because the target was unavailable.");
    expect(run.contextSnapshot).toMatchObject({ wakeCommentId: f.m2, wakeCommentIds: [f.m2] });
    await f.sweep(10);
    await f.sweep(10);
    const visible = await f.read();
    const replies = visible.filter(c => c.authorType === "agent" && !c.deletedAt && c.createdByRunId === run.id);
    const notices = await f.noticesFor(f.m2);
    const answered = await f.answerState(f.m2);
    console.info("SA-2205 control evidence", JSON.stringify({ m2: f.m2, runId: run.id, replyIds: replies.map(c => c.id),
      input: run.contextSnapshot, answered, notices, noticeFromGET: visible.find(c => c.id === f.noticeId) }));
    expect(replies, "M2 answered exactly once by its own carrying run").toHaveLength(1);
    expect(answered).toBe(true);
    expect(notices, "retirement never creates a duplicate notice").toHaveLength(1);
    expect(notices[0].id).toBe(f.noticeId);
    expect(notices[0].deletedAt, "M2's own answer retires its notice").not.toBeNull();
    expect(visible.filter(c => c.id === f.noticeId && !c.deletedAt), "the retired notice is no longer visible").toHaveLength(0);
  }, 60_000);
});
