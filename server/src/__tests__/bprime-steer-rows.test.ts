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

// B' steering rows (rf-4 / neworg-lead, 11-19). The harness below is cut A's
// steering harness (agent-chat-steering.test.ts), reused unchanged: real PG, the
// real POST comment and steer routes, the real run-end release, the real sweep
// (settleUnansweredPersonMessage: settleCarriedSteerNotices + the unanswered
// sweep) and the ONE answeredPersonMessageSql.
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

describeEmbeddedPostgres("B' steering rows: live carrier (i) and ignored steer at a normal end (b2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const owner = "chat-owner";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bprime-steer-rows-");
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

  const notices = (chat: Chat, id: string) => db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.issue.id),
    eq(issueComments.authorType, "system"), sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + id}`));
  const sweep = (chat: Chat, offsetMs = 0) => settleUnansweredPersonMessage(db, { companyId: chat.companyId,
    issueId: chat.issue.id, now: new Date(Date.now() + offsetMs) });

  /** m is steered into the live turn R through the real steer route; R's run log is the given shape; R ends and is released. */
  async function steerAndEnd(chat: Chat, shape: keyof typeof SHAPES, status: "succeeded" | "failed") {
    const [m] = await send(chat, ["m, steered mid-turn"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    expect((await steer(chat, m!.id, wake!.id)).status).toBe(200);
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      ...SHAPES[shape](m!.id),
      { eventType: status === "failed" ? "turn.failed" : "turn.completed", itemId: "turn-1:end" },
    ]);
    await finishTurn(chat, { status, log: false });
    const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    return { m: m!, ended: ended! };
  }

  // (i) live carrier (PERSON CASE i): a steer the server carried INTO a live successor gets NO
  // "not answered" card while that successor is live; once it ends without answering, exactly ONE card.
  it.each(["failed", "cancelled"] as const)("(i) live carrier: m carried into a live successor S gets no card while S runs; ONE card once S ends %s unanswered", async (endS) => {
    const chat = await seedChat();
    const { m, ended } = await steerAndEnd(chat, "unread", "failed");
    // R ended FAILED without answering m: m is restored and carried into the next turn, never answered-marked.
    expect((ended.resultJson as any).restoredSteeredCommentIds).toEqual([m.id]);
    expect(await answered(m.id)).toBe(false);
    const successor = await carryingTurn(chat, m.id);
    if (successor.status !== "running") {
      await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, successor.id));
    }
    const [live] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
    expect(live!.status).toBe("running");
    expect((live!.contextSnapshot as any).wakeCommentIds).toContain(m.id);
    // The real sweep pass, now and well past every settle/wait bound: S is live, so no card for m.
    for (const offset of [0, 60_000, 600_000]) {
      const outcome = await sweep(chat, offset);
      expect(outcome.kind).not.toBe("noticed");
      expect(await notices(chat, m.id)).toHaveLength(0);
    }
    // S ends without answering m: exactly ONE card for m, on every later pass too.
    await db.update(heartbeatRuns).set({ status: endS, finishedAt: new Date(), ...(endS === "failed"
      ? { error: "adapter_failed: the provider exited", errorCode: "adapter_failed" } : {}) })
      .where(eq(heartbeatRuns.id, successor.id));
    expect((await sweep(chat, 60_000)).kind).toBe("noticed");
    for (const offset of [120_000, 600_000]) await sweep(chat, offset);
    const posted = await notices(chat, m.id);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("received mid-task");
    expect(await answered(m.id)).toBe(false);
  });

  /** The run that carries `id` replies (a published agent comment by that run). */
  async function replyBy(chat: Chat, runId: string, body: string) {
    await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent",
      authorAgentId: chat.agentId, createdByRunId: runId, body });
  }

  // (b2) ignored, normal end (PERSON CASE b2): m was delivered and READ, the model IGNORED it (no answering
  // text after its read), and R ended SUCCEEDED with a reply to the earlier work. A plain later M2 is then
  // answered by a run carrying M2. That reply does NOT answer m: m stays owed (carried next, or one true card).
  it("(b2) ignored steer, normal end, real release: m is carried next and a reply to the later M2 does not answer it", async () => {
    const chat = await seedChat();
    const { m, ended } = await steerAndEnd(chat, "read-no-reply", "succeeded");
    expect(ended.status).toBe("succeeded");
    // R's own reply (to the earlier work) is published.
    expect((await db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.issue.id),
      eq(issueComments.createdByRunId, chat.runId), eq(issueComments.authorType, "agent")))).length).toBe(1);
    expect((ended.contextSnapshot as any).answeredSteeredCommentIds ?? []).not.toContain(m.id);
    expect((ended.resultJson as any).restoredSteeredCommentIds).toEqual([m.id]);
    expect(await answered(m.id)).toBe(false);
    // m is carried next, ONCE.
    const mCarriers = await carriersOf(chat, m.id);
    expect(mCarriers.wakes.length + mCarriers.runs.length).toBe(1);
    // M2, plain and later, by the real POST route. m stays owed: carried next, ONCE, in the turn that holds the
    // task (S), ahead of M2, which waits behind it. (A reply to M2 can only come from a run after S; S's own
    // outcome decides m: its answer, or the carried-steer card, row (i).)
    const [m2] = await send(chat, ["M2, a plain later message"]);
    expect(await answered(m.id)).toBe(false);
    const [s] = mCarriers.runs;
    const [task] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
    expect(s).toBeTruthy();
    expect((s!.contextSnapshot as any).wakeCommentIds).toEqual([m.id]);
    expect(task!.executionRunId).toBe(s!.id);
    const m2Carriers = await carriersOf(chat, m2!.id);
    expect(m2Carriers.runs).toHaveLength(0);
    expect(m2Carriers.wakes).toHaveLength(1);
    expect(m2Carriers.wakes[0]!.status).toBe("deferred_issue_execution");
    expect((await carriersOf(chat, m.id)).runs.map((run) => run.id)).toEqual([s!.id]);
    expect(await answered(m.id)).toBe(false);
  });

  // (b2) the same ignored steer while R still carries it as a steer (its read is in R's input,
  // steeredCommentIds, and it is NOT in answeredSteeredCommentIds): R ended SUCCEEDED and replied to the
  // earlier work; its release (the restore) has not run. A reply to the later M2 by a run carrying M2 does not
  // answer m: Pi's read alone is not "reached" (the reached term's carriesCommentSql(rc, m.id, TRUE)).
  // Control: m READ and answered in-run (answeredSteeredCommentIds has m) is answered.
  it.each(["ignored", "answered-in-run"] as const)("(b2) reached term: a steer R read but %s, R ended SUCCEEDED, and a reply to a later M2", async (variant) => {
    const chat = await seedChat();
    const [m] = await send(chat, ["m, steered mid-turn"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    expect((await steer(chat, m!.id, wake!.id)).status).toBe(200);
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      ...SHAPES[variant === "ignored" ? "read-no-reply" : "read-answered"](m!.id),
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
    // R ends SUCCEEDED with its reply and settles (finishTurn without its release step).
    await replyBy(chat, chat.runId, "Agent reply to the earlier work");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, chat.runId));
    const [r] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    await settleConversationTurn(db, r!);
    if (variant === "answered-in-run") {
      // The run-end accounting records the answered steer (the same release, run for real here).
      await releaseRun(chat);
      const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
      expect((released!.contextSnapshot as any).answeredSteeredCommentIds).toEqual([m!.id]);
      expect(await answered(m!.id)).toBe(true);
      return;
    }
    const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((held!.contextSnapshot as any).steeredCommentIds).toContain(m!.id);
    expect((held!.contextSnapshot as any).wakeCommentIds).toContain(m!.id);
    expect((held!.contextSnapshot as any).answeredSteeredCommentIds ?? []).not.toContain(m!.id);
    const [m2] = await send(chat, ["M2, a plain later message"]);
    const [m2Run] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId,
      status: "succeeded", runtimeMode: "native", startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId: chat.issue.id, taskKey: chat.issue.id, wakeCommentId: m2!.id, commentId: m2!.id,
        wakeCommentIds: [m2!.id] } }).returning();
    await replyBy(chat, m2Run!.id, "M2: done.");
    expect(await answered(m2!.id)).toBe(true);
    // m stays OWED: the reply to M2 does not answer the steer the model ignored.
    expect(await answered(m!.id)).toBe(false);
  });
});
