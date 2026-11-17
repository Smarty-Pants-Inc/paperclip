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

// Agent Chat steering and queue shape (Paul P0, 11-17): plain chat messages
// sent during a running turn share one ordered queue, the owner can steer its
// head into the live native turn, and nothing crosses a /new reset.
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

describeEmbeddedPostgres("agent chat steering and queue shape", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const owner = "chat-owner";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-steering-");
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

  // RED 1: one deferred wake for plain chat messages.
  it("keeps plain chat messages sent during a turn in one ordered queue the owner can see and edit", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["Second", "Third", "Fourth"]);
    const wakes = await deferredWakes(chat);
    expect(wakes).toHaveLength(1);
    expect(wakeCommentIds(wakes[0]!)).toEqual(sent.map((comment) => comment.id));
    expect(await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).toHaveLength(0);
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.queueId).toBe(wakes[0]!.id);
    expect(queue.body.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map((comment) => comment.id));
    expect(queue.body.entries.every((entry: any) => entry.canEdit && entry.canDiscard)).toBe(true);
  });

  // RED 2 (guard part): a reset is never merged, in either direction.
  it("never merges a chat message across a /new reset (guard)", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["Before", "/new", "After"]);
    const wakes = await deferredWakes(chat);
    expect(wakes.map(wakeCommentIds)).toEqual(sent.map((comment) => [comment.id]));
  });

  // RED 2 + RFL (2) merge boundary: plain runs merge on each side of a reset only.
  it("merges plain messages on each side of a /new without crossing it", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["One", "Two", "/new", "Three", "Four"]);
    const wakes = await deferredWakes(chat);
    expect(wakes.map(wakeCommentIds)).toEqual([
      [sent[0]!.id, sent[1]!.id], [sent[2]!.id], [sent[3]!.id, sent[4]!.id],
    ]);
  });

  // RED 3: reorder works on a chat.
  it("reorders the queued messages of a chat", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["Second", "Third", "Fourth"]);
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    const order = sent.map((comment) => comment.id).reverse();
    const reordered = await request(app(chat.companyId))
      .put(`/api/issues/${chat.issue.id}/queued-comments/order`)
      .send({ queueId: queue.body.queueId, revision: queue.body.revision, orderedCommentIds: order });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body.entries.map((entry: any) => entry.comment.id)).toEqual(order);
  });

  // RED 4: the live native probe decides for a chat.
  it("reports the live probe's 'available' to the chat owner", async () => {
    const chat = await seedChat();
    await send(chat, ["Second"]);
    mocks.probe.mockResolvedValue({ disposition: "available", activeTurnId: "turn-1" });
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body).toMatchObject({ protocol: "paperclip_runner_v1", steeringDisposition: "available", targetRunId: chat.runId });
    expect(mocks.probe).toHaveBeenCalledWith(chat.runId);
  });

  // Guard: a /new head is never offered for steering.
  it("keeps a /new at the head of a chat queue unsupported for steering (guard)", async () => {
    const chat = await seedChat();
    await send(chat, ["/new"]);
    mocks.probe.mockResolvedValue({ disposition: "available", activeTurnId: "turn-1" });
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.steeringDisposition).toBe("unsupported");
  });

  // RED 5 + code-lead (b) + GAP A: owner steer of the head.
  it("lets the owner steer the head of a chat queue into the live turn and records it as carried by that turn", async () => {
    const chat = await seedChat();
    const [steered] = await send(chat, ["Steer me"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    const response = await steer(chat, steered!.id, wake!.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mocks.steer).toHaveBeenCalledOnce();
    expect(mocks.steer).toHaveBeenCalledWith(expect.objectContaining({
      runId: chat.runId, message: "Steer me", correlationId: steered!.id,
    }));
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
    expect(after!.status).toBe("cancelled");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((run!.resultJson as any).queuedSteeringAcknowledgements[steered!.id]).toMatchObject({ status: "acknowledged", turnId: "turn-1" });
    expect((run!.contextSnapshot as any).wakeCommentIds).toEqual([chat.first.id, steered!.id]);
    expect((run!.contextSnapshot as any).conversationReplyBoundaryCommentId).toBe(steered!.id);
  });

  // RED 7 + GAP A: settlement is not stuck 'active' and the steered message counts as answered.
  it("settles the chat after a steered turn and counts the steered message as answered", async () => {
    const chat = await seedChat();
    const [steered] = await send(chat, ["Steer me"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    expect((await steer(chat, steered!.id, wake!.id)).status).toBe(200);
    const issue = await finishTurn(chat);
    expect(issue).toMatchObject({ status: "in_review", conversationState: "waiting" });
    expect(await answered(chat.first.id)).toBe(true);
    expect(await answered(steered!.id)).toBe(true);
  });

  // RFL (1): turn order. The steered head joins the running turn; the next
  // message keeps its place and is answered by the next turn, not this one.
  it("answers a steered message in its sent order and leaves later messages for the next turn", async () => {
    const chat = await seedChat();
    const [head, next] = await send(chat, ["Joins this turn", "Waits for the next turn"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    const response = await steer(chat, head!.id, wake!.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.entries.map((entry: any) => entry.comment.id)).toEqual([next!.id]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((run!.contextSnapshot as any).wakeCommentIds).toEqual([chat.first.id, head!.id]);
    const issue = await finishTurn(chat);
    // The next message is still pending, so the chat stays active for its turn.
    expect(issue).toMatchObject({ status: "in_progress", conversationState: "active" });
    expect(await answered(head!.id)).toBe(true);
    expect(await answered(next!.id)).toBe(false);
    const [remaining] = await deferredWakes(chat);
    expect(wakeCommentIds(remaining!)).toEqual([next!.id]);
  });

  // RFL (3): merged messages are each answered once, none lost, none doubled.
  it("answers each merged message once: none lost and none doubled", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["Second", "Third", "Fourth"]);
    // A repeated delivery pass is idempotent.
    await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup);
    const wakes = await deferredWakes(chat);
    expect(wakes).toHaveLength(1);
    expect(wakeCommentIds(wakes[0]!)).toEqual(sent.map((comment) => comment.id));
    for (const comment of sent) {
      const receipts = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, chat.companyId),
        eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${comment.id}`),
      ));
      expect(receipts).toHaveLength(1);
    }
    // The next turn carries the merged queue's saved context: one run answers all three.
    await finishTurn(chat);
    const deferredContext = (wakes[0]!.payload as Record<string, any>)._paperclipWakeContext;
    const [nextRun] = await db.insert(heartbeatRuns).values({
      companyId: chat.companyId, agentId: chat.agentId, status: "running", runtimeMode: "native",
      contextSnapshot: deferredContext,
    }).returning();
    await db.update(issues).set({ executionRunId: nextRun!.id }).where(eq(issues.id, chat.issue.id));
    const prepared = await prepareConversationTurn(db, nextRun!);
    expect(prepared.reset).toBe(false);
    for (const comment of sent) expect(await answered(comment.id)).toBe(false);
    const issue = await finishTurn({ ...chat, runId: nextRun!.id });
    expect(issue).toMatchObject({ status: "in_review", conversationState: "waiting" });
    for (const comment of sent) expect(await answered(comment.id)).toBe(true);
  });

  // RED 6 + code-lead ORDER: only the head, never a /new, never behind a /new.
  it("refuses to steer the second entry of a chat queue without calling the provider", async () => {
    const chat = await seedChat();
    const [, second] = await send(chat, ["Head", "Second"]);
    const [wake] = await deferredWakes(chat);
    const response = await steer(chat, second!.id, wake!.id);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("conversation_steer_out_of_order");
    expect(mocks.steer).not.toHaveBeenCalled();
  });

  it("refuses to steer a /new or a message behind it without calling the provider", async () => {
    const chat = await seedChat();
    const [reset, behind] = await send(chat, ["/new", "After reset"]);
    const [resetWake, behindWake] = await deferredWakes(chat);
    const resetResponse = await steer(chat, reset!.id, resetWake!.id);
    expect(resetResponse.status).toBe(409);
    expect(resetResponse.body.code).toBe("conversation_reset_requires_turn_boundary");
    const behindResponse = await steer(chat, behind!.id, behindWake!.id);
    expect(behindResponse.status).toBe(409);
    expect(behindResponse.body.code).toBe("conversation_steer_out_of_order");
    expect(mocks.steer).not.toHaveBeenCalled();
    expect((await deferredWakes(chat)).map(wakeCommentIds)).toEqual([[reset!.id], [behind!.id]]);
  });

  it("refuses to steer into a turn from an earlier chat session", async () => {
    const chat = await seedChat();
    const [head] = await send(chat, ["Head"]);
    const [wake] = await deferredWakes(chat);
    await db.update(issues).set({ conversationSessionGeneration: sql`${issues.conversationSessionGeneration} + 1` })
      .where(eq(issues.id, chat.issue.id));
    const response = await steer(chat, head!.id, wake!.id);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("conversation_steer_stale_session");
    expect(mocks.steer).not.toHaveBeenCalled();
  });

  it("refuses chat steering to another board user (403)", async () => {
    const chat = await seedChat();
    const [head] = await send(chat, ["Head"]);
    const [wake] = await deferredWakes(chat);
    const response = await steer(chat, head!.id, wake!.id, app(chat.companyId, "other-operator"));
    expect(response.status).toBe(403);
    expect(mocks.steer).not.toHaveBeenCalled();
  });

  it("refuses chat steering to the assignee's manager agent (403)", async () => {
    const chat = await seedChat();
    const managerId = randomUUID();
    await db.insert(agents).values({ id: managerId, companyId: chat.companyId, name: "Manager", role: "manager" });
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, chat.agentId));
    const [head] = await send(chat, ["Head"]);
    const [wake] = await deferredWakes(chat);
    const manager = app(chat.companyId, "manager", { agentId: managerId, runId: randomUUID() });
    const response = await steer(chat, head!.id, wake!.id, manager);
    expect(response.status).toBe(403);
    expect(mocks.steer).not.toHaveBeenCalled();
  });

  // RFL (4): a runner that cannot take a mid-turn steer reports it through the
  // live probe, and the message is never dropped: it stays queued for the turn boundary.
  it.each([
    ["unsupported", "steering_unsupported"],
    ["temporarily_unavailable", "steering_temporarily_unavailable"],
  ] as const)("keeps the message queued when the native runner reports %s (guard)", async (disposition, code) => {
    const chat = await seedChat();
    const [head] = await send(chat, ["Head"]);
    const [wake] = await deferredWakes(chat);
    mocks.probe.mockResolvedValue({ disposition, activeTurnId: null });
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.steeringDisposition).toBe(disposition);
    const { NativeSessionSteeringError } = mocks.actual as unknown as {
      NativeSessionSteeringError: new (code: string, message: string) => Error;
    };
    mocks.steer.mockRejectedValueOnce(new NativeSessionSteeringError(code, "The runner cannot take this steer."));
    const response = await steer(chat, head!.id, wake!.id);
    expect(response.status).toBe(409);
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
    expect(after!.status).toBe("deferred_issue_execution");
    expect(wakeCommentIds(after!)).toEqual([head!.id]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((run!.resultJson as any)?.queuedSteeringAcknowledgements?.[head!.id]).toBeUndefined();
    expect(await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).toHaveLength(0);
  });
});
