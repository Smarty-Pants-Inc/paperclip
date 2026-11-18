import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, companyMemberships, createDb, heartbeatRunEvents,
  heartbeatRuns, issueComments, issues, issueThreadInteractions, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { heartbeatService } from "../heartbeat.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { settleUnansweredPersonMessagesForTask, UNANSWERED_MESSAGE_NO_REPLY_TEXT, UNANSWERED_MESSAGE_TEXT,
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
    return { companyId, agentId, issueId, sender, other, send, startRun, readRun, stop, end, card, cardStatus, sweep, answered, notices };
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
});
