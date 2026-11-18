import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
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
import { getServerAdapter, registerServerAdapter, runningProcesses } from "../adapters/index.js";
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
    await db.insert(authUsers).values({ id: owner, name: "Chat owner", email: "chat-owner@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
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
    await db?.delete(authUsers).where(eq(authUsers.id, owner));
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
  async function seedChat(initialProcessCwd?: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Chat steering", issuePrefix: `CS${Math.floor(Math.random() * 1e6)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Chat agent", role: "engineer", status: "idle",
      adapterType: initialProcessCwd ? "codex_local" : "process",
      ...(initialProcessCwd ? { adapterConfig: { command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"], cwd: initialProcessCwd },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } } : {}),
    });
    await db.insert(companyMemberships).values([owner, "other-operator"].map((principalId) => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "operator",
    })));
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: owner,
      membershipRole: "operator", grantedByUserId: null });
    const issue = await issueService(db).create(companyId, {
      title: "Conversation",
      conversationAgentId: agentId,
      conversationUserId: owner,
      assigneeAgentId: agentId,
      status: "in_review",
      conversationState: "waiting",
    });
    const first = await issueService(db).addComment(issue.id, "First message", { userId: owner });
    if (initialProcessCwd) {
      const heartbeat = heartbeatService(db);
      try {
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", reason: "issue_commented",
          payload: { issueId: issue.id, commentId: first.id },
          contextSnapshot: { issueId: issue.id, taskKey: issue.id, wakeCommentId: first.id, commentId: first.id },
          requestedByActorType: "user", requestedByActorId: owner, idempotencyKey: `initial:${first.id}` });
        if (!run) throw Error("Initial process was not admitted");
        const deadline = Date.now() + 10_000;
        while (true) {
          const [started] = await db.select({ processPid: heartbeatRuns.processPid }).from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, run.id));
          // runningProcesses is set before onSpawn persists process identity.
          // Wait for that real startup boundary, not a partially prepared run.
          if (runningProcesses.has(run.id) && started?.processPid) break;
          if (Date.now() > deadline) throw Error("Initial process did not finish startup");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return { companyId, agentId, issue, first, runId: run.id };
      } catch (error) {
        // The caller has not received its Chat yet, so startup owns cleanup.
        await heartbeat.cancelActiveForAgent(agentId).catch(() => undefined);
        await heartbeat.drainActiveRunExecutions();
        throw error;
      }
    }
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

  /** Observe actual adapter input while the real HTTP + Postgres queue drains. */
  async function drain(chat: Chat, expected: string[], deleted: string[] = [], selectedId?: string,
    onStarted?: () => Promise<void>) {
    const seen: { ids: string[]; input: string }[] = [];
    const [agent] = await db.select({ adapterType: agents.adapterType }).from(agents).where(eq(agents.id, chat.agentId));
    const adapter = getServerAdapter(agent!.adapterType);
    const received = new Map<string, Record<string, unknown>>();
    registerServerAdapter({ ...adapter, execute: async ctx => {
      received.set(ctx.runId, structuredClone(ctx.context));
      await onStarted?.();
      return adapter.execute(ctx);
    } });
    const responder = createServer(async (req, res) => {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { runId } = JSON.parse(body);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const context = run!.contextSnapshot as Record<string, any>;
        const ids: string[] = context.wakeCommentIds ?? [context.wakeCommentId ?? context.commentId];
        seen.push({ ids, input: JSON.stringify(received.get(runId)) });
        await issueService(db).addComment(chat.issue.id, JSON.stringify({ answers: ids }), { agentId: chat.agentId, runId });
        res.end("ok");
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
    responder.listen(0, "127.0.0.1");
    await once(responder, "listening");
    const port = (responder.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/reply",{method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok)throw Error(await r.text())})`;
    const heartbeat = heartbeatService(db);
    const cwd = await mkdtemp(join(tmpdir(), "queue-intent-witness-"));
    try {
      await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, chat.agentId));
      if (!selectedId) {
        await finishTurn(chat);
        runningProcesses.delete(chat.runId);
      }
      const dispatch = async () => {
        const queue = await queueRead(chat);
        return request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
          .send({ queueId: queue.queueId, revision: queue.revision,
            targetRunId: selectedId ? chat.runId : null, ...(selectedId ? { commentId: selectedId } : {}) });
      };
      let dispatchResponse = await dispatch();
      // Edit may win the optimistic revision race before dispatch acquires its
      // lock. That is a refused dispatch, not a refused edit: refresh and Send.
      if (dispatchResponse.status === 409 && dispatchResponse.body.code === "queued_comment_revision_conflict") {
        dispatchResponse = await dispatch();
      }
      expect(dispatchResponse.status, JSON.stringify(dispatchResponse.body)).toBe(200);
      const deadline = Date.now() + 20_000;
      while (true) {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, chat.agentId));
        // Promotion can happen between the runs and wakes reads. A mixed
        // empty snapshot is not completion until all expected answers arrived.
        if (seen.flatMap(turn => turn.ids).length >= expected.length &&
            !(await deferredWakes(chat)).length && !runs.some(run => ["running", "queued"].includes(run.status))) break;
        if (Date.now() > deadline) throw Error(JSON.stringify({ seen, runs, wakes: await deferredWakes(chat),
          issue: (await db.select().from(issues).where(eq(issues.id, chat.issue.id)))[0] }));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(seen.flatMap(turn => turn.ids)).toEqual(expected);
      expect(new Set(seen.flatMap(turn => turn.ids)).size).toBe(expected.length);
      for (const id of expected) expect(await answered(id)).toBe(true);
      for (const id of deleted) { expect(seen.flatMap(turn => turn.ids)).not.toContain(id); expect(await answered(id)).toBe(false); }
      expect((await queueRead(chat)).entries).toEqual([]);
      return seen;
    } finally {
      await heartbeat.cancelActiveForAgent(chat.agentId).catch(() => undefined);
      await heartbeat.drainActiveRunExecutions();
      registerServerAdapter(adapter);
      responder.closeAllConnections();
      await new Promise<void>((resolve, reject) => responder.close(error => error ? reject(error) : resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }

  // org RED (Paul's real case): five waiting messages are five rows, never one.
  it("lists all five waiting messages of a chat, in the order sent", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["One", "Two", "Three", "Four", "Five"]);
    const queue = await queueRead(chat);
    expect(queue.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map((comment) => comment.id));
  });

  it("supersedes(lists all five waiting messages when a /new sits among them, and marks the /new boundary; RFL record SUPERSEDE-QUEUEUX-WAKE-SHAPE-1118)", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["One", "Two", "/new", "Three", "Four"]);
    const queue = await queueRead(chat);
    expect(queue.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map((comment) => comment.id));
    expect(queue.entries.map((entry: any) => Boolean(entry.behindReset))).toEqual([false, false, true, true, true]);
    expect(queue.entries.map((entry: any) => entry.deliveryIntent)).toEqual(["steer", "steer", "queue", "steer", "steer"]);
    await drain(chat, [sent[0]!.id, sent[1]!.id, sent[3]!.id, sent[4]!.id]);
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

  it("supersedes(reorders the head wake and deletes a row behind a /new, answering with the whole chat queue each time; RFL record SUPERSEDE-QUEUEUX-WAKE-SHAPE-1118)", async () => {
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
    expect(deleted.body.entries.map((entry: any) => entry.comment.id)).toEqual([two!.id, one!.id, reset!.id]);
    expect(deleted.body.entries.some((entry: any) => entry.comment.id === behind!.id)).toBe(false);
    await drain(chat, [two!.id, one!.id], [behind!.id]);
  });

  it("supersedes(Interrupt now on one row sends that message first and keeps the rest queued, in order; RFL record SUPERSEDE-QUEUEUX-WAKE-SHAPE-1118)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "queue-interrupt-source-"));
    // A conversational adapter owns normal Stop -> next-turn admission. Use a
    // real child as its deterministic execution boundary, without provider auth.
    const conversationAdapter = getServerAdapter("codex_local");
    registerServerAdapter({ ...conversationAdapter, execute: getServerAdapter("process").execute });
    let chat: Chat | undefined;
    try {
      chat = await seedChat(cwd);
      const [one, two, three] = await send(chat, ["One", "Two", "Three"]);
      expect((await queueRead(chat)).entries.map((entry: any) => entry.comment.id)).toEqual([one!.id, two!.id, three!.id]);
      const started = Date.now();
      const turns = await drain(chat, [two!.id, one!.id, three!.id], [], two!.id);
      expect(turns[0]?.ids).toEqual([two!.id]);
      console.log("QUEUE_INTERRUPT_WITNESS", JSON.stringify({ selected: two!.id,
        answered: turns.map(turn => turn.ids), elapsedMs: Date.now() - started }));
    } finally {
      if (chat) await heartbeatService(db).cancelActiveForAgent(chat.agentId).catch(() => undefined);
      await heartbeatService(db).drainActiveRunExecutions();
      registerServerAdapter(conversationAdapter);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  const edit = async (chat: Chat, commentId: string, body: string, target?: any) => {
    const queue = await queueRead(chat);
    const row = target ?? queue.entries.find((entry: any) => entry.comment.id === commentId);
    return request(app(chat.companyId)).patch(`/api/issues/${chat.issue.id}/queued-comments/${commentId}`)
      .send({ body, queueId: row?.queueId ?? queue.queueId, revision: row?.queueRevision ?? queue.revision });
  };

  it("Edit (a): ordinary later-wake edit reaches the actual answering adapter as edited text", async () => {
    const chat = await seedChat();
    const [one, later] = await send(chat, ["First queued", "ORIGINAL later input"]);
    const result = await edit(chat, later!.id, "EDITED later input");
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, later!.id));
    expect(stored!.body).toBe("EDITED later input");
    const turns = await drain(chat, [one!.id, later!.id]);
    const answering = turns.find(turn => turn.ids.includes(later!.id))!;
    expect(answering.input).toContain("EDITED later input");
    expect(answering.input).not.toContain("ORIGINAL later input");
  }, 30_000);

  it("Edit (b): a started run refuses Edit with no write", async () => {
    const chat = await seedChat();
    const [later] = await send(chat, ["Input captured at dispatch"]);
    const before = await queueRead(chat);
    const target = { ...before.entries[0], queueId: before.entries[0].queueId ?? before.queueId,
      queueRevision: before.entries[0].queueRevision ?? before.revision };
    await drain(chat, [later!.id], [], undefined, async () => {
      const response = await edit(chat, later!.id, "Must not land", target);
      expect(response.status).toBe(409);
      const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, later!.id));
      expect(stored!.body).toBe("Input captured at dispatch");
      expect((await queueRead(chat)).entries.find((row: any) => row.comment.id === later!.id)?.canEdit ?? false).toBe(false);
    });
  }, 30_000);

  it("Edit (b,d): an acknowledged row refuses Edit with no write", async () => {
    const chat = await seedChat();
    const [message] = await send(chat, ["Acknowledged original"]);
    const before = await queueRead(chat);
    const target = { ...before.entries[0], queueId: before.entries[0].queueId ?? before.queueId,
      queueRevision: before.entries[0].queueRevision ?? before.revision };
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-edit" });
    expect((await steer(chat, message!.id, target.queueId ?? (await queueRead(chat)).queueId)).status).toBe(200);
    const response = await edit(chat, message!.id, "Must not land", target);
    expect(response.status).toBe(409);
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, message!.id));
    expect(stored!.body).toBe("Acknowledged original");
    expect((await queueRead(chat)).entries.some((entry: any) => entry.comment.id === message!.id)).toBe(false);
  });

  it.each([1, 2])("Edit (d): disabled and refused on /new or behind it (row %i)", async index => {
    const chat = await seedChat();
    const sent = await send(chat, ["Before", "/new", "Behind"]);
    const queue = await queueRead(chat);
    expect(queue.entries[index].canEdit).toBe(false);
    const response = await edit(chat, sent[index]!.id, "Must not land");
    expect(response.status).toBe(409);
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, sent[index]!.id));
    expect(stored!.body).toBe(sent[index]!.body);
  });

  it("Edit (c): dispatch race either lands first or refuses; the screen matches actual answering input", async () => {
    const chat = await seedChat();
    const [message] = await send(chat, ["Race original"]);
    const before = await queueRead(chat);
    const target = { ...before.entries[0], queueId: before.entries[0].queueId ?? before.queueId,
      queueRevision: before.entries[0].queueRevision ?? before.revision };
    const [response, turns] = await Promise.all([
      edit(chat, message!.id, "Race edited", target), drain(chat, [message!.id]),
    ]);
    expect([200, 409]).toContain(response.status);
    const screen = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/comments`).expect(200);
    const shown = screen.body.find((comment: any) => comment.id === message!.id).body;
    console.log("QUEUE_EDIT_DISPATCH_RACE", JSON.stringify({ editStatus: response.status, shown,
      adapterInput: turns.find(turn => turn.ids.includes(message!.id))!.input }));
    expect(shown).toBe(response.status === 200 ? "Race edited" : "Race original");
    expect(turns.find(turn => turn.ids.includes(message!.id))!.input).toContain(shown);
    expect(turns.find(turn => turn.ids.includes(message!.id))!.input).not.toContain(response.status === 200 ? "Race original" : "Race edited");
  }, 30_000);
});
