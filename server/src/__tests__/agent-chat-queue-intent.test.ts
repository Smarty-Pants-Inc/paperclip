import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  issueTreeHolds,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  deliverConversationComments,
  prepareConversationTurn,
  settleConversationTurn,
  undeliveredConversationComments,
} from "../services/agent-conversations.js";
import { answeredPersonMessageSql } from "../services/person-message-answer.js";
import { runningProcesses } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Paul NOTE 6 (smarty-dev#20992) queue UX, design revision 2 + judge D1-D5:
// every waiting message is listed (also behind a /new), each message's
// Steer/Queue mode is stored on the server (comment metadata, no migration),
// the steer route re-reads it, and Interrupt now can send ONE message first
// without ever crossing a /new.
const mocks = vi.hoisted(() => ({
  steer: vi.fn(),
  probe: vi.fn(),
  actual: {} as Record<string, (...args: never[]) => unknown>,
}));
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  mocks.actual = actual as never;
  mocks.steer.mockImplementation(actual.steerNativeSession);
  mocks.probe.mockImplementation(actual.getNativeSessionSteeringState);
  return { ...actual, steerNativeSession: mocks.steer, getNativeSessionSteeringState: mocks.probe };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent chat queue: every message, stored delivery intent, one-message interrupt", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const owner = "chat-owner";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-queue-intent-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 60_000);

  afterEach(async () => {
    for (const id of [...runningProcesses.keys()]) runningProcesses.delete(id);
    mocks.steer.mockReset();
    mocks.steer.mockImplementation(mocks.actual.steerNativeSession as never);
    mocks.probe.mockReset();
    mocks.probe.mockImplementation(mocks.actual.getNativeSessionSteeringState as never);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string, userId = owner, agentActor?: { agentId: string; runId: string }) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: agentActor ? "agent" : "board",
        ...(agentActor ? { ...agentActor, companyId } : {}),
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  /** A chat whose first message is being answered by a running native turn. */
  async function seedChat() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Chat steering", issuePrefix: `CS${Math.floor(Math.random() * 1e6)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Chat agent", role: "engineer", status: "idle", adapterType: "process",
    });
    await db.insert(companyMemberships).values([owner, "other-operator"].map((principalId) => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "operator",
    })));
    const issue = await issueService(db).create(companyId, {
      title: "Conversation",
      conversationAgentId: agentId,
      conversationUserId: owner,
      assigneeAgentId: agentId,
      status: "in_review",
      conversationState: "waiting",
    });
    const first = await issueService(db).addComment(issue.id, "First message", { userId: owner });
    const [inserted] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", runtimeMode: "native",
      startedAt: new Date(),
      contextSnapshot: { issueId: issue.id, taskKey: issue.id, wakeCommentId: first.id, commentId: first.id },
    }).returning();
    await prepareConversationTurn(db, inserted!);
    await db.update(issues).set({ executionRunId: inserted!.id, executionLockedAt: new Date() })
      .where(eq(issues.id, issue.id));
    runningProcesses.set(inserted!.id, { child: {} as never, graceSec: 0, processGroupId: null });
    return { companyId, agentId, issue, first, runId: inserted!.id };
  }

  type Chat = Awaited<ReturnType<typeof seedChat>>;

  /** Sends person messages while the turn runs, through the real chat delivery outbox. */
  async function send(chat: Chat, bodies: string[]) {
    const sent = [];
    for (const body of bodies) {
      sent.push(await issueService(db).addComment(chat.issue.id, body, { userId: owner },
        { clientRequestId: randomUUID() }));
    }
    await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup);
    return sent;
  }

  async function deferredWakes(chat: Chat) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, chat.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${chat.issue.id}`,
    )).orderBy(asc(agentWakeupRequests.requestedAt));
  }

  function wakeCommentIds(wake: typeof agentWakeupRequests.$inferSelect) {
    const context = (wake.payload as Record<string, any>)._paperclipWakeContext ?? {};
    return (context.wakeCommentIds ?? [context.wakeCommentId]) as string[];
  }

  async function answered(commentId: string) {
    const rows = await db.execute(sql`select ${answeredPersonMessageSql({
      id: sql`m.id`, companyId: sql`m.company_id`, issueId: sql`m.issue_id`, createdAt: sql`m.created_at`,
    })} as answered from issue_comments m where m.id = ${commentId}::uuid`);
    return Boolean((rows as unknown as Array<{ answered: boolean }>)[0]?.answered);
  }

  async function steer(chat: Chat, commentId: string, queueId: string, client = app(chat.companyId)) {
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    return request(client)
      .post(`/api/issues/${chat.issue.id}/queued-comments/${commentId}/steer`)
      .send({ queueId, targetRunId: chat.runId, revision: queue.body.revision });
  }

  /** The turn publishes its reply, succeeds and settles. */
  async function finishTurn(chat: Chat) {
    await db.insert(issueComments).values({
      companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent", authorAgentId: chat.agentId,
      createdByRunId: chat.runId, body: "Agent reply",
    });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, chat.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    await settleConversationTurn(db, run!);
    const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
    return issue!;
  }

  const queueRead = (chat: Chat, client = app(chat.companyId)) =>
    request(client).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200).then((res) => res.body);

  const setIntent = (chat: Chat, commentId: string, intent: string, client = app(chat.companyId)) =>
    request(client).patch(`/api/issues/${chat.issue.id}/queued-comments/${commentId}/intent`).send({ intent });

  /** Sends one chat message through the real comment route, as the composer does. */
  const post = (chat: Chat, body: string, deliveryIntent?: "steer" | "queue") =>
    request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/comments`)
      .send({ body, clientRequestId: randomUUID(), ...(deliveryIntent ? { deliveryIntent } : {}) });

  // org RED (Paul's real case): five waiting messages are five rows, never one.
  it("lists all five waiting messages of a chat, in the order sent", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["One", "Two", "Three", "Four", "Five"]);
    const queue = await queueRead(chat);
    expect(queue.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map((comment) => comment.id));
  });

  it("lists all five waiting messages when a /new sits among them, and marks the /new boundary", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["One", "Two", "/new", "Three", "Four"]);
    const queue = await queueRead(chat);
    expect(queue.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map((comment) => comment.id));
    expect(queue.entries.map((entry: any) => Boolean(entry.behindReset))).toEqual([false, false, true, true, true]);
    expect(queue.entries.map((entry: any) => entry.deliveryIntent)).toEqual(["steer", "steer", "queue", "steer", "steer"]);
    // A row behind the head wake names its own wake, so its own Edit/Delete target it.
    const wakes = await deferredWakes(chat);
    expect(queue.entries.map((entry: any) => entry.queueId ?? queue.queueId))
      .toEqual([wakes[0]!.id, wakes[0]!.id, wakes[1]!.id, wakes[2]!.id, wakes[2]!.id]);
  });

  // D3: the mode is stored on the server, set at create.
  it("stores the delivery intent a message is sent with, and the queue read returns it", async () => {
    const chat = await seedChat();
    const queued = await post(chat, "Wait for the turn", "queue");
    expect(queued.status, JSON.stringify(queued.body)).toBe(201);
    const steered = await post(chat, "Steer me", "steer");
    expect(steered.status, JSON.stringify(steered.body)).toBe(201);
    const plain = await post(chat, "No intent sent");
    expect(plain.status).toBe(201);
    await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup);
    const [stored] = await db.select({ metadata: issueComments.metadata }).from(issueComments)
      .where(eq(issueComments.id, queued.body.id));
    expect((stored!.metadata as any)?.deliveryIntent).toBe("queue");
    const queue = await queueRead(chat);
    expect(queue.entries.map((entry: any) => [entry.comment.body, entry.deliveryIntent])).toEqual([
      ["Wait for the turn", "queue"], ["Steer me", "steer"], ["No intent sent", "steer"],
    ]);
  });

  it("rejects an unknown delivery intent at create (validated key)", async () => {
    const chat = await seedChat();
    const response = await post(chat, "Bad", "later" as never);
    expect(response.status).toBe(400);
  });

  // D3: the owner flips the mode; everyone else gets 403; a second tab reads it.
  it("lets only the chat owner change a queued message's mode (403 otherwise), and a second read sees it", async () => {
    const chat = await seedChat();
    const [head] = await send(chat, ["Head"]);
    const changed = await setIntent(chat, head!.id, "queue");
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.entries[0]).toMatchObject({ deliveryIntent: "queue" });
    expect((await queueRead(chat)).entries[0].deliveryIntent).toBe("queue");
    const other = await setIntent(chat, head!.id, "steer", app(chat.companyId, "other-operator"));
    expect(other.status).toBe(403);
    expect((await queueRead(chat)).entries[0].deliveryIntent).toBe("queue");
    expect((await setIntent(chat, head!.id, "sideways")).status).toBe(400);
  });

  it("refuses Steer for a /new and for a message behind a /new (409)", async () => {
    const chat = await seedChat();
    const [, reset, behind] = await send(chat, ["Head", "/new", "Behind"]);
    const onReset = await setIntent(chat, reset!.id, "steer");
    expect(onReset.status).toBe(409);
    expect(onReset.body.code).toBe("conversation_reset_requires_turn_boundary");
    const onBehind = await setIntent(chat, behind!.id, "steer");
    expect(onBehind.status).toBe(409);
    expect(onBehind.body.code).toBe("conversation_behind_reset");
    // Queue is always allowed for the owner.
    expect((await setIntent(chat, behind!.id, "queue")).status).toBe(200);
  });

  // D4: once a steer was acknowledged the message has left the queue.
  it("refuses a mode change for a message that was already steered (409)", async () => {
    const chat = await seedChat();
    const [head] = await send(chat, ["Steer me"]);
    const [wake] = await deferredWakes(chat);
    const queue = await queueRead(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    const steered = await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/${head!.id}/steer`)
      .send({ queueId: wake!.id, targetRunId: chat.runId, revision: queue.revision });
    expect(steered.status, JSON.stringify(steered.body)).toBe(200);
    const response = await setIntent(chat, head!.id, "queue");
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("queued_comment_not_pending");
  });

  // D3: the steer path re-reads the STORED intent: a Queue set in another tab wins.
  it("refuses to steer a message whose stored mode is Queue, without calling the provider", async () => {
    const chat = await seedChat();
    const [head] = await send(chat, ["Keep me queued"]);
    const [wake] = await deferredWakes(chat);
    expect((await setIntent(chat, head!.id, "queue")).status).toBe(200);
    const queue = await queueRead(chat);
    const response = await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/${head!.id}/steer`)
      .send({ queueId: wake!.id, targetRunId: chat.runId, revision: queue.revision });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("queued_comment_intent_queue");
    expect(mocks.steer).not.toHaveBeenCalled();
  });

  // D2 + addendum 2: one-message Interrupt never crosses a /new.
  it.each([["the /new itself", 1], ["a message behind the /new", 2]] as const)(
    "refuses Interrupt now for %s (409) before stopping anything",
    async (_label, index) => {
      const chat = await seedChat();
      const sent = await send(chat, ["Head", "/new", "Behind"]);
      const queue = await queueRead(chat);
      const response = await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
        .send({ queueId: queue.entries[index].queueId ?? queue.queueId, targetRunId: chat.runId,
          revision: queue.entries[index].queueRevision ?? queue.revision, commentId: sent[index]!.id });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe(index === 1 ? "conversation_reset_requires_turn_boundary" : "conversation_behind_reset");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
      expect(run!.status).toBe("running");
      expect((await deferredWakes(chat)).map(wakeCommentIds)).toEqual(sent.map((comment) => [comment.id]));
    },
  );

  it("reorders the head wake and deletes a row behind a /new, answering with the whole chat queue each time", async () => {
    const chat = await seedChat();
    const [one, two, reset, behind] = await send(chat, ["One", "Two", "/new", "Behind"]);
    const queue = await queueRead(chat);
    const reordered = await request(app(chat.companyId)).put(`/api/issues/${chat.issue.id}/queued-comments/order`)
      .send({ queueId: queue.queueId, revision: queue.revision, orderedCommentIds: [two!.id, one!.id] });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body.entries.map((entry: any) => entry.comment.id)).toEqual([two!.id, one!.id, reset!.id, behind!.id]);
    const row = reordered.body.entries[3];
    const deleted = await request(app(chat.companyId)).delete(`/api/issues/${chat.issue.id}/queued-comments/${behind!.id}`)
      .send({ queueId: row.queueId, revision: row.queueRevision });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.queueId).toBe(queue.queueId);
    expect(deleted.body.entries.map((entry: any) => entry.comment.id)).toEqual([two!.id, one!.id, reset!.id]);
  });

  it.each(["non-owner", "agent-paused", "chat-held"] as const)(
    "one-message Interrupt retains the owner and paused/held gates (%s)",
    async (variant) => {
      const chat = await seedChat();
      const sent = await send(chat, ["One", "Two", "Three"]);
      const queue = await queueRead(chat);
      if (variant === "agent-paused" || variant === "non-owner") {
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, chat.agentId));
      } else {
        await db.insert(issueTreeHolds).values({ companyId: chat.companyId, rootIssueId: chat.issue.id,
          mode: "pause", status: "active", createdByActorType: "user", createdByUserId: owner,
          releasePolicy: { strategy: "manual", note: "leaf_pause" } });
      }
      const client = app(chat.companyId, variant === "non-owner" ? "other-operator" : owner);
      const response = await request(client).post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
        .send({ queueId: queue.queueId, targetRunId: chat.runId, revision: queue.revision, commentId: sent[1]!.id });
      expect(response.status, JSON.stringify(response.body)).toBe(variant === "non-owner" ? 403 : 409);
      if (variant !== "non-owner") {
        expect(response.body.code ?? response.body.details?.code).toBe("queued_comment_chat_paused");
        expect(response.body.error).toBe(variant === "agent-paused"
          ? "This agent is paused. Resume it to send these messages."
          : "This chat is paused. Resume it to send these messages.");
      }
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
      expect(run!.status).toBe("running");
      expect((await deferredWakes(chat)).map(wakeCommentIds)).toEqual([sent.map((comment) => comment.id)]);
    },
  );

  it("Interrupt now on one row sends that message first and keeps the rest queued, in order", async () => {
    const chat = await seedChat();
    const [one, two, three] = await send(chat, ["One", "Two", "Three"]);
    // Keep the successor from starting a model in this test: the agent's only slot is taken.
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, chat.agentId));
    runningProcesses.delete(chat.runId);
    // This harness has no native cancellation binding; the stop itself is the existing Interrupt's, tested elsewhere.
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, chat.runId));
    const queue = await queueRead(chat);
    const response = await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, targetRunId: chat.runId, revision: queue.revision, commentId: two!.id });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [interrupted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queue.queueId));
    expect(wakeCommentIds(interrupted!)).toEqual([two!.id]);
    const rest = (await deferredWakes(chat)).filter((wake) => wake.id !== queue.queueId);
    expect(rest.map(wakeCommentIds)).toEqual([[one!.id, three!.id]]);
  });
});
