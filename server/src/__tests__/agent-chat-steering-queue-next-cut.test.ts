import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  heartbeatRunEvents,
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
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_REASON_PREFIX } from "../services/recovery/unanswered-person-message.js";
import { getServerAdapter, registerServerAdapter, runningProcesses } from "../adapters/index.js";
import { buildPaperclipWakePayload } from "../services/heartbeat/run-preparation.js";
import { renderFirstTurnQueuedInput } from "../services/native-runtime/first-turn-queued-input.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { createPiEventProjector } from "../../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.js";
import { openPiSteeringPeer } from "./helpers/pi-steering-peer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import type { PrpEvent } from "../vendor/paperclip-runner/index.js";
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
  cancel: vi.fn(),
  actual: {} as Record<string, (...args: never[]) => unknown>,
}));
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  mocks.actual = actual as never;
  mocks.steer.mockImplementation(actual.steerNativeSession);
  mocks.probe.mockImplementation(actual.getNativeSessionSteeringState);
  mocks.cancel.mockImplementation(actual.cancelNativeSession);
  return { ...actual, steerNativeSession: mocks.steer, getNativeSessionSteeringState: mocks.probe,
    cancelNativeSession: mocks.cancel };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// RFL SUPERSEDE-STEER-DEFAULT-PARKED-QUEUE-ROWS-1119: merged-entry/drag/per-row-steer queue UX is next cut. Assertions retained unchanged.
describe.skip("agent chat steering queue next cut", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const owner = "chat-owner";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-steering-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(authUsers).values({ id: owner, name: "Chat owner", email: "chat-owner@example.test", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);

  /**
   * rf5 F1: join every piece of work a test started before its rows are truncated. A Send dispatches its
   * successor fire-and-forget; that run's execution, its wakes and its post-commit failure report keep writing
   * after the successor leaves queued/running. Joined, never caught: a deadlock still fails the test.
   */
  async function joinOwnedWork() {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await waitForPendingRunFailureReports();
    await heartbeatService(db).drainActiveRunExecutions();
  }

  afterEach(async () => {
    await joinOwnedWork();
    for (const id of [...runningProcesses.keys()]) runningProcesses.delete(id);
    mocks.steer.mockReset();
    mocks.steer.mockImplementation(mocks.actual.steerNativeSession as never);
    mocks.probe.mockReset();
    mocks.probe.mockImplementation(mocks.actual.getNativeSessionSteeringState as never);
    mocks.cancel.mockReset();
    mocks.cancel.mockImplementation(mocks.actual.cancelNativeSession as never);
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

  /** Legacy Queue/Interrupt rows opt into Queue explicitly. Every message is
   * saved by the real HTTP route and the real chat outbox, never by a test-only
   * delivery selector. The S-* default rows intentionally omit this mode. */
  async function send(chat: Chat, bodies: string[]) {
    const sent: Array<{ id: string; body: string }> = [];
    for (const body of bodies) {
      const response = await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/comments`)
        .send({ body, clientRequestId: randomUUID(), deliveryIntent: "queue" }).expect(201);
      sent.push(response.body);
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

  async function steer(chat: Chat, commentId: string, _queueId: string, client = app(chat.companyId)) {
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    return request(client)
      .post(`/api/issues/${chat.issue.id}/queued-comments/${commentId}/steer`)
      .send({ queueId: queue.body.queueId, targetRunId: chat.runId, revision: queue.body.revision });
  }

  /** The run log of a turn that read each steered message and replied to it in text before anything else. */
  async function answeredLog(chat: Chat) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    const steered = ((run!.contextSnapshot as any).steeredCommentIds ?? []) as string[];
    if (steered.length === 0) return;
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      ...steered.flatMap((id, index) => [
        { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${id}` },
        { eventType: "item.started", kind: "userMessage", itemId: `turn-1:steered-${index}` },
        { eventType: "item.started", kind: "agentMessage", itemId: `turn-1:reply-${index}`, text: "" },
        { eventType: "item.completed", kind: "agentMessage", itemId: `turn-1:reply-${index}`, text: `Reply ${index}` },
      ]),
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
  }

  const releaseDeps = {
    resolveResponsibleUserId: async () => owner,
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  };
  /** The run end's real release (run-completion.ts: settle, then releaseIssueExecutionAndPromote). */
  async function releaseRun(chat: Chat) {
    return createWakeQueue(db, releaseDeps as never).releaseIssueExecution({
      companyId: chat.companyId, runId: chat.runId, now: new Date() });
  }

  /** The turn publishes its reply, ends (succeeded by default), settles and is released. */
  async function finishTurn(chat: Chat, options: { status?: "succeeded" | "failed"; log?: boolean } = {}) {
    if (options.log !== false) await answeredLog(chat);
    await db.insert(issueComments).values({
      companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent", authorAgentId: chat.agentId,
      createdByRunId: chat.runId, body: "Agent reply",
    });
    await db.update(heartbeatRuns).set({ status: options.status ?? "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, chat.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    await settleConversationTurn(db, run!);
    const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
    await releaseRun(chat);
    return issue!;
  }

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21272
  // S-a..S-g are route/accounting RED tools, not installed-screen acceptance.
  function postDefault(chat: Chat, body: string, extra: Record<string, unknown> = {}) {
    return request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/comments`)
      .send({ body, clientRequestId: randomUUID(), ...extra });
  }

  async function attachSteerable(chat: Chat) {
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } })
      .where(eq(agents.id, chat.agentId));
    mocks.probe.mockResolvedValue({ disposition: "available", activeTurnId: "turn-1" });
    mocks.steer.mockResolvedValue({ turnId: "turn-1" });
  }

  

  

  

  

  

  

  

  

  

  /** Real admission + process-adapter drain. Replies record the exact carried
   * input ids and session; no saved wake shape is assumed by this witness. */
  async function drainVisibleQueue(chat: Chat, expected: string[], deleted: string[] = [], selectedId?: string) {
    const seen: { runId: string; ids: string[]; generation: number; input: string }[] = [];
    const adapter = getServerAdapter("process");
    const received = new Map<string, Record<string, unknown>>();
    registerServerAdapter({ ...adapter, execute: async ctx => {
      received.set(ctx.runId, structuredClone(ctx.context));
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
        seen.push({ runId, ids, generation: context.conversationSessionGeneration,
          input: JSON.stringify(received.get(runId)) });
        await issueService(db).addComment(chat.issue.id, JSON.stringify({ answers: ids }),
          { agentId: chat.agentId, runId });
        res.end("ok");
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
    responder.listen(0, "127.0.0.1");
    await once(responder, "listening");
    const port = (responder.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/reply",{method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok)throw Error(await r.text())})`;
    const heartbeat = heartbeatService(db);
    const cwd = await mkdtemp(join(tmpdir(), "chat-queue-witness-"));
    try {
      await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, chat.agentId));
      if (selectedId) {
        runningProcesses.delete(chat.runId);
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, chat.runId));
      } else {
        await finishTurn(chat);
        runningProcesses.delete(chat.runId);
      }
      const queue = (await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200)).body;
      if (selectedId) expect(queue.entries.map((entry: any) => entry.comment.id).sort()).toEqual([...expected].sort());
      else expect(queue.entries.map((entry: any) => entry.comment.id)).toEqual(expected);
      await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
        .send({ queueId: queue.queueId, revision: queue.revision,
          targetRunId: selectedId ? chat.runId : null, ...(selectedId ? { commentId: selectedId } : {}) }).expect(200);
      const deadline = Date.now() + 20_000;
      while (true) {
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, chat.agentId));
        const waiting = await deferredWakes(chat);
        if (!waiting.length && !runs.some(run => ["running", "queued"].includes(run.status))) break;
        if (Date.now() > deadline) throw Error(JSON.stringify({ seen, waiting, runs }));
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, chat.issue.id));
      const byId = new Map(comments.map(comment => [comment.id, comment]));
      const messages = expected.filter(id => !/^\s*\/new\s*$/.test(byId.get(id)!.body));
      expect(seen.flatMap(turn => turn.ids)).toEqual(messages);
      expect(new Set(seen.flatMap(turn => turn.ids)).size).toBe(messages.length);
      const replies = comments.filter(comment => seen.some(turn => turn.runId === comment.createdByRunId));
      expect(replies).toHaveLength(seen.length);
      for (const turn of seen) {
        const reply = replies.find(comment => comment.createdByRunId === turn.runId)!;
        expect(JSON.parse(reply.body).answers).toEqual(turn.ids);
        for (const id of turn.ids) {
          expect(await answered(id)).toBe(true);
          const reset = expected.findIndex(id => /^\s*\/new\s*$/.test(byId.get(id)!.body));
          expect(turn.generation).toBe(reset >= 0 && expected.indexOf(id) > reset ? 1 : 0);
        }
      }
      for (const id of deleted) {
        expect(seen.flatMap(turn => turn.ids)).not.toContain(id);
        expect(await answered(id)).toBe(false);
      }
      expect((await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200)).body.entries).toEqual([]);
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

  // RFL SUPERSEDE-QUEUEUX-WAKE-SHAPE-1118: outcomes, not persisted wake count.
  it("supersedes(keeps plain chat messages sent during a turn in one ordered queue the owner can see and edit; RFL record SUPERSEDE-QUEUEUX-WAKE-SHAPE-1118)", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["Second", "Third", "Fourth"]);
    const wakes = await deferredWakes(chat);
    expect(await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).toHaveLength(0);
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.queueId).toBe(wakes[0]!.id);
    expect(queue.body.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map((comment) => comment.id));
    expect(queue.body.entries.every((entry: any) => entry.canEdit && entry.canDiscard)).toBe(true);
    await drainVisibleQueue(chat, sent.map(comment => comment.id));
  }, 30_000);

  // RED 2 (guard part): a reset is never merged, in either direction.
  

  // RED 2 + RFL (2) merge boundary: plain runs merge on each side of a reset only.
  it("supersedes(merges plain messages on each side of a /new without crossing it; RFL record SUPERSEDE-QUEUEUX-WAKE-SHAPE-1118)", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["One", "Two", "/new", "Three", "Four"]);
    const queue = (await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200)).body;
    expect(queue.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map(comment => comment.id));
    expect(queue.entries.map((entry: any) => Boolean(entry.behindReset))).toEqual([false, false, true, true, true]);
    await drainVisibleQueue(chat, sent.map(comment => comment.id));
  }, 30_000);

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
  

  // Guard: a /new head is never offered for steering.
  

  // RED 5 + code-lead (b) + GAP A: owner steer of the head.
  

  // RED 7 + GAP A: settlement is not stuck 'active' and the steered message counts as answered.
  

  // RFL (1): turn order. The steered head joins the running turn; the next
  // message keeps its place and is answered by the next turn, not this one.
  

  // RFL (3): merged messages are each answered once, none lost, none doubled.
  it("supersedes(answers each merged message once: none lost and none doubled; RFL record SUPERSEDE-QUEUEUX-WAKE-SHAPE-1118)", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["Second", "Third", "Fourth"]);
    // A repeated delivery pass is idempotent.
    await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup);
    const queue = (await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200)).body;
    expect(queue.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map(comment => comment.id));
    for (const comment of sent) {
      const receipts = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, chat.companyId),
        eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${comment.id}`),
      ));
      expect(receipts).toHaveLength(1);
    }
    for (const comment of sent) expect(await answered(comment.id)).toBe(false);
    const order = sent.map(comment => comment.id).reverse();
    await request(app(chat.companyId)).put(`/api/issues/${chat.issue.id}/queued-comments/order`)
      .send({ queueId: queue.queueId, revision: queue.revision, orderedCommentIds: order }).expect(200);
    const turns = await drainVisibleQueue(chat, order);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, chat.agentId));
    for (const turn of turns) {
      const context = runs.find(run => run.id === turn.runId)!.contextSnapshot as Record<string, any>;
      expect(context.wakeCommentIds ?? [context.wakeCommentId]).toEqual(turn.ids);
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
    expect(issue).toMatchObject({ status: "in_review", conversationState: "waiting" });
    for (const comment of sent) expect(await answered(comment.id)).toBe(true);
  }, 30_000);

  // RED 6 + code-lead ORDER: only the head, never a /new, never behind a /new.
  

  

  

  

  

  // RFL (4): a runner that cannot take a mid-turn steer reports it through the
  // live probe, and the message is never dropped: it stays queued for the turn boundary.
  

  async function queueOf(chat: Chat) {
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    return { queue };
  }

  async function reorder(chat: Chat, orderedCommentIds: string[], client = app(chat.companyId)) {
    const { queue } = await queueOf(chat);
    return request(client).put(`/api/issues/${chat.issue.id}/queued-comments/order`)
      .send({ queueId: queue.body.queueId, revision: queue.body.revision, orderedCommentIds });
  }

  async function edit(chat: Chat, commentId: string, body: string, client = app(chat.companyId)) {
    const { queue } = await queueOf(chat);
    return request(client).patch(`/api/issues/${chat.issue.id}/queued-comments/${commentId}`)
      .send({ queueId: queue.body.queueId, revision: queue.body.revision, body });
  }

  // rf5 F1: drag, then steer only the new head. The earlier messages are still
  // queued: the chat stays active and only the steered message is answered.
  it("after a drag, steering only the head leaves the earlier messages pending and unanswered", async () => {
    const chat = await seedChat();
    const [a, b, c] = await send(chat, ["A", "B", "C"]);
    expect((await reorder(chat, [c!.id, b!.id, a!.id])).status).toBe(200);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    const response = await steer(chat, c!.id, wake!.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.entries.map((entry: any) => entry.comment.id)).toEqual([b!.id, a!.id]);
    const issue = await finishTurn(chat);
    expect(issue).toMatchObject({ status: "in_progress", conversationState: "active" });
    expect(await answered(c!.id)).toBe(true);
    expect(await answered(b!.id)).toBe(false);
    expect(await answered(a!.id)).toBe(false);
  });

  // rf5 F1: drag, then steer all three in the final order. The provider gets each
  // once in that order, each is answered, and the chat settles to waiting.
  it("after a drag, steering every message in the final order answers each once and settles the chat", async () => {
    const chat = await seedChat();
    const [a, b, c] = await send(chat, ["A", "B", "C"]);
    expect((await reorder(chat, [c!.id, b!.id, a!.id])).status).toBe(200);
    for (const target of [c!, b!, a!]) {
      const [wake] = await deferredWakes(chat);
      mocks.steer.mockResolvedValueOnce({ turnId: `turn-${target.body}` });
      const response = await steer(chat, target.id, wake!.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    expect(mocks.steer.mock.calls.map(([input]: any[]) => input.message)).toEqual(["C", "B", "A"]);
    expect(await deferredWakes(chat)).toHaveLength(0);
    const issue = await finishTurn(chat);
    expect(issue).toMatchObject({ status: "in_review", conversationState: "waiting" });
    for (const comment of [a!, b!, c!]) expect(await answered(comment.id)).toBe(true);
  });

  // rf5 F2: a merged entry is never edited into a /new, at either position.
  it.each([["first", 0], ["last", 1]] as const)(
    "refuses to edit the %s message of a merged chat entry into /new (409) and keeps the queue unchanged",
    async (_position, index) => {
      const chat = await seedChat();
      const sent = await send(chat, ["One", "Two"]);
      const response = await edit(chat, sent[index]!.id, "/new");
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.code).toBe("conversation_reset_requires_own_message");
      expect(response.body.error).toBe("A /new must be sent on its own: delete this message and send /new.");
      const wakes = await deferredWakes(chat);
      expect(wakes.map(wakeCommentIds)).toEqual([sent.map((comment) => comment.id)]);
      const bodies = await db.select({ body: issueComments.body }).from(issueComments)
        .where(eq(issueComments.id, sent[index]!.id));
      expect(bodies[0]!.body).toBe(index === 0 ? "One" : "Two");
    },
  );

  // rf5 F2: a merged entry without /new still edits, reorders and runs as one plain turn.
  // (RED at 82b635b4d too: after a reorder the timestamp boundary left the chat stuck active, the F1 cause.)
  it("keeps a merged chat entry editable and reorderable when no /new is involved, and settles it after the turn", async () => {
    const chat = await seedChat();
    const [one, two] = await send(chat, ["One", "Two"]);
    expect((await edit(chat, one!.id, "One, edited")).status).toBe(200);
    expect((await reorder(chat, [two!.id, one!.id])).status).toBe(200);
    const [wake] = await deferredWakes(chat);
    expect(wakeCommentIds(wake!)).toEqual([two!.id, one!.id]);
    await finishTurn(chat);
    const [nextRun] = await db.insert(heartbeatRuns).values({
      companyId: chat.companyId, agentId: chat.agentId, status: "running", runtimeMode: "native",
      contextSnapshot: (wake!.payload as Record<string, any>)._paperclipWakeContext,
    }).returning();
    await db.update(issues).set({ executionRunId: nextRun!.id }).where(eq(issues.id, chat.issue.id));
    expect((await prepareConversationTurn(db, nextRun!)).reset).toBe(false);
    const issue = await finishTurn({ ...chat, runId: nextRun!.id });
    expect(issue).toMatchObject({ status: "in_review", conversationState: "waiting" });
    expect(await answered(one!.id)).toBe(true);
    expect(await answered(two!.id)).toBe(true);
  });

  // rf5 F2: a single queued message edited into /new keeps its own wake and resets the session.
  

  // rf5 F3: only the owner mutates a chat queue (same rule as Steer).
  it("refuses another board operator's reorder of the owner's chat queue (403)", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["A", "B"]);
    const response = await reorder(chat, sent.map((comment) => comment.id).reverse(), app(chat.companyId, "other-operator"));
    expect(response.status).toBe(403);
    expect(wakeCommentIds((await deferredWakes(chat))[0]!)).toEqual(sent.map((comment) => comment.id));
  });

  

  

  

  /** The runner's durable run log for the live turn (validated PRP events, in order). */
  async function runLog(chat: Chat, events: Array<{ eventType: string; kind?: string; itemId: string; text?: string }>) {
    // Allocate sequences as run-event ingestion does (heartbeat_runs.next_event_seq).
    const [allocated] = await db.update(heartbeatRuns)
      .set({ nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + ${events.length}` })
      .where(eq(heartbeatRuns.id, chat.runId)).returning({ next: heartbeatRuns.nextEventSeq });
    const first = Number(allocated!.next) - events.length;
    await db.insert(heartbeatRunEvents).values(events.map((event, index) => ({
      companyId: chat.companyId, runId: chat.runId, agentId: chat.agentId, seq: first + index,
      eventType: event.eventType, sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "turn-1", itemId: event.itemId,
        payload: event.kind ? { kind: event.kind, ...(event.text === undefined ? {} : { text: event.text }) } : {} } },
    })));
  }

  /** The person's square Stop: the native session acknowledges a run-only stop, then the run is released. */
  async function personStop(chat: Chat) {
    mocks.cancel.mockImplementationOnce(async (runId: string) => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson ?? {}), nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: chat.companyId, issueId: run!.nativeIssueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } } }).where(eq(heartbeatRuns.id, runId));
      return { decision: { stopped: true }, auditId: randomUUID() };
    });
    await heartbeatService(db).cancelRun(chat.runId, "Cancelled by a board operator",
      { resultJson: { cancelledByActorType: "user", cancelledByUserId: owner } });
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(stopped!.status).toBe("cancelled");
  }

  const STOPPED_LINE = "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it.";

  // S10 C1 (never-OK): a message steered into the running turn that the model
  // had not read yet is dropped by Stop's clear_queue. After a person's Stop it
  // waits again, at its place, and one Send delivers it once. A steer the model
  // read (Pi's userMessage receipt) stays with the stopped turn: no double answer.
  // The answered rule: read is not answered. Only text after the read, before the next tool or the end, answers it.
  

  // S10 C2: A, /new, B behind a person's Stop. One Send runs A, then /new, then
  // B, so the stopped list shows all three, the /new and B marked behind it.
  

  // NEVER-OK (PV2 s3, run 0bf8d84e): a steered message the run did not answer is
  // never counted answered at a normal run end, and is never lost. The busy run has
  // a tool chain; B is steered mid-turn and its ack recorded; the run replies to A
  // and ends. The answered rule decides from the run log, for EVERY run end.
  const SHAPES = {
    // Pi never emits B's userMessage.
    unread: (b: string) => [
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-1" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${b}` },
      { eventType: "tool.execution.completed", itemId: "turn-1:tool-1" },
      { eventType: "item.started", kind: "agentMessage", itemId: "turn-1:final", text: "" },
      { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:final", text: "A: done." },
    ],
    // THE LIVE SHAPE: Pi reads B at the tool boundary (seq 283), the model reasons
    // (seq 290) and starts the next shell call (seq 294) with no reply text, then
    // its final reply falsely claims B was answered.
    "read-no-reply": (b: string) => [
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-1" },
      { eventType: "tool.execution.started", itemId: "turn-1:tool-1" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${b}` },
      { eventType: "tool.execution.completed", itemId: "turn-1:tool-1" },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:steered" },
      { eventType: "item.completed", kind: "userMessage", itemId: "turn-1:steered" },
      { eventType: "item.started", kind: "reasoning", itemId: "turn-1:thinking" },
      { eventType: "item.completed", kind: "reasoning", itemId: "turn-1:thinking", text: "I'll reply to it first, with no tools" },
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-2" },
      { eventType: "tool.execution.started", itemId: "turn-1:tool-2" },
      { eventType: "tool.execution.completed", itemId: "turn-1:tool-2" },
      { eventType: "item.started", kind: "agentMessage", itemId: "turn-1:final", text: "" },
      { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:final", text: "A done; M0006 was answered at the boundary." },
    ],
    // Positive: B is read and reply text follows before the next tool. Pi streams the
    // tool call's start before the message ends, so the text block STARTS first.
    "read-answered": (b: string) => [
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-1" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${b}` },
      { eventType: "tool.execution.completed", itemId: "turn-1:tool-1" },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:steered" },
      { eventType: "item.started", kind: "agentMessage", itemId: "turn-1:b-reply", text: "" },
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-2" },
      { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:b-reply", text: "B: yes, after this." },
      { eventType: "tool.execution.started", itemId: "turn-1:tool-2" },
      { eventType: "tool.execution.completed", itemId: "turn-1:tool-2" },
      { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:final", text: "A: done." },
    ],
  };

  /** Every place B can wait for its delivery: deferred/queued wakes and runs other than the steered one. */
  async function carriersOf(chat: Chat, id: string) {
    const wakes = (await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, chat.companyId),
      sql`${agentWakeupRequests.status} in ('deferred_issue_execution', 'queued')`,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${chat.issue.id}`,
    ))).filter((wake) => !wake.runId).filter((wake) => wakeCommentIds(wake).includes(id) || ((wake.payload as any).queuedCommentIds ?? []).includes(id));
    const runs = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, chat.companyId),
      sql`${heartbeatRuns.id} <> ${chat.runId}`))).filter((run) => {
      const context = run.contextSnapshot as any;
      return [...(context.wakeCommentIds ?? []), ...(context.firstTurnQueuedInput?.commentIds ?? [])].includes(id);
    });
    return { wakes, runs };
  }

  
  // rf5 F1/F2 (never-OK): the answered rule reads what the REAL Pi projector (pi-event-projector.ts) emits.
  // A streamed reply projects item.started agentMessage at its text_start, then item.completed (or
  // item.failed) at message_end. A receipt with no streamed text (final-only) projects ONLY item.completed:
  // nothing says when that text began, so it is no evidence of an answer after B's read.
  const PI = {
    user: (text: string, timestamp: number) => ["message_start", "message_end"].map((type) => ({ type,
      message: { role: "user", timestamp, content: [{ type: "text", text }] } })),
    tool: (id: string, responseId: string) => [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id, toolName: "bash" } },
      { type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", timestamp: 3, responseId,
        stopReason: "toolUse", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }] } },
      { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
    ],
    reply: (text: string, responseId: string, options: { streamed: boolean; stopReason?: "stop" | "error" }) => [
      { type: "message_start", message: { role: "assistant" } },
      ...(options.streamed ? [
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
      ] : []),
      { type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", timestamp: 4, responseId,
        stopReason: options.stopReason ?? "stop", ...(options.stopReason === "error" ? { errorMessage: "provider error" } : {}),
        content: [{ type: "text", text }] } },
    ],
  };
  /** Replays native Pi events through the real projector into the run log; the steer ack is the (mocked) native steer transport's. */
  async function piRunLog(chat: Chat, steps: Array<Record<string, unknown> | { ack: string } | { end: string }>) {
    const projector = createPiEventProjector({ runId: chat.runId, turnId: "turn-1" });
    const events = steps.flatMap((step): Array<{ eventType: string; itemId: string; payload: Record<string, unknown> }> => "ack" in step
      ? [{ eventType: "item.completed", itemId: `turn-1:steer:${step.ack}`, payload: { kind: "steering_acknowledgement" } }]
      : "end" in step ? [{ eventType: String(step.end), itemId: "turn-1:end", payload: {} }]
        : projector.project(step).map(({ eventType, itemId, payload }) => ({ eventType, itemId: String(itemId), payload })));
    const [allocated] = await db.update(heartbeatRuns)
      .set({ nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + ${events.length}` })
      .where(eq(heartbeatRuns.id, chat.runId)).returning({ next: heartbeatRuns.nextEventSeq });
    const first = Number(allocated!.next) - events.length;
    await db.insert(heartbeatRunEvents).values(events.map((event, index) => ({
      companyId: chat.companyId, runId: chat.runId, agentId: chat.agentId, seq: first + index,
      eventType: event.eventType, sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "turn-1", itemId: event.itemId, payload: event.payload } },
    })));
    return events.map((event) => `${event.eventType}:${(event.payload as any).kind ?? ""}`);
  }

  

  // rf5 F3 (R-ONCE "in order"): two steers whose acknowledgements share one timestamp are restored in the order
  // they were steered, never re-sorted by JSONB key order. The person dragged the larger id to the head, so
  // JSONB key order (shorter, then bytewise) disagrees with the steering order.
  
  const RECEIVED_MID_TASK = "Received mid-task (while you were working):";

  /** B is steered mid-turn, never read, and the turn ends: B is restored and carried into the next turn. */
  async function restoredSteer(chat: Chat) {
    const [b] = await send(chat, ["B, steered mid-turn"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    expect((await steer(chat, b!.id, wake!.id)).status).toBe(200);
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      ...SHAPES.unread(b!.id),
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
    await finishTurn(chat, { status: "succeeded", log: false });
    const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((ended!.resultJson as any).restoredSteeredCommentIds).toEqual([b!.id]);
    return b!;
  }

  /** The turn that carries B after its restore: the promoted run, or a run started from B's waiting wake. */
  async function carryingTurn(chat: Chat, id: string) {
    const carriers = await carriersOf(chat, id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    if (carriers.runs.length) return carriers.runs[0]!;
    const wake = carriers.wakes[0]!;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: chat.companyId, agentId: chat.agentId, status: "running", runtimeMode: "native",
      wakeupRequestId: wake.id, contextSnapshot: (wake.payload as any)._paperclipWakeContext,
    }).returning();
    await db.update(agentWakeupRequests).set({ status: "completed", runId: run!.id, finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    return run!;
  }

  // Follow-up 1: the carried steer's turn input says, in one prefix line, that it was received mid-task, then the
  // person's text unchanged. Only the carried steer: an ordinary queued message in the same turn has no label.
  

  // Follow-up 2: the turn that carried a restored steer ends FAILED or cancelled without answering it. ONE true
  // notice for that message (the sweep's notice path, its own key), never a silent answered-mark, never twice;
  // also when a later message is the latest one.
  
});
