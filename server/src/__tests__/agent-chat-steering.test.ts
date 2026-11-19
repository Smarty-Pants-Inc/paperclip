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
import { waitForPendingCommentSteers } from "../services/conversation-steering.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
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

describeEmbeddedPostgres("agent chat steering and queue shape", () => {
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
    await waitForPendingCommentSteers();
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

  it("S-a/S-e/S-g: default POST goes straight into the same running chat, with zero wakes and an immediate thread receipt", async () => {
    const chat = await seedChat();
    await attachSteerable(chat);
    const started = performance.now();
    const response = await postDefault(chat, "M, sent while working");
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(performance.now() - started).toBeLessThan(1000);
    await waitForPendingCommentSteers(); // POST receipts no longer wait for provider ACK
    expect(mocks.steer).toHaveBeenCalledWith(expect.objectContaining({ runId: chat.runId,
      correlationId: response.body.id, message: "M, sent while working" }));
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, chat.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, chat.companyId))).toHaveLength(1);
    expect(await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).toHaveLength(0);
    const thread = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/comments`).expect(200);
    expect(thread.body.find((entry: any) => entry.id === response.body.id)).toMatchObject({
      steeredIntoRunId: chat.runId, steeringStatus: "accepted", steeredAt: expect.any(String), steeringDeliveryEventSeq: null,
    });
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.entries).toHaveLength(0);
    expect(queue.body.executionWait ?? null).toBeNull();
    expect(await answered(response.body.id)).toBe(false); // acceptance is NOT delivery or an answer
  });

  it.each([true, false])("S-a2: production Pi drivers, proxy and event ingestion prove delivery at the tool boundary (following text=%s)", async reply => {
    const chat = await seedChat(); await attachSteerable(chat);
    const root = await mkdtemp(join(tmpdir(), "chat-pi-boundary-"));
    const peer = await openPiSteeringPeer(root, chat.runId);
    const events: PrpEvent[] = [];
    let port: PaperclipControlPlanePort | undefined;
    let pumpError: unknown;
    const pump = (async () => {
      for await (const event of peer.session.events()) {
        port ??= new PaperclipControlPlanePort(db, { companyId: chat.companyId, issueId: chat.issue.id,
          runId: chat.runId, agentId: chat.agentId, sessionId: event.normalizedSessionId,
          completionContractId: randomUUID(), completionContractSha256: `sha256:${"a".repeat(64)}`,
          sourceInstanceId: event.sourceInstanceId, controlPlaneSourceInstanceId: event.sourceInstanceId });
        await port.appendEvent(event);
        events.push(event);
      }
    })().catch(error => { pumpError = error; });
    try {
      const { turnId } = await peer.session.startTurn({ message: { role: "user", text: chat.first.body } });
      await vi.waitFor(() => {
        if (pumpError) throw pumpError;
        expect(events.some(event => event.eventType === "tool.execution.started")).toBe(true);
      });
      mocks.probe.mockResolvedValue({ disposition: "available", activeTurnId: turnId });
      mocks.steer.mockImplementation(async (input: { message: string; correlationId: string }) => {
        await peer.session.steer!({ turnId, message: { role: "user", text: input.message }, correlationId: input.correlationId });
        return { turnId };
      });
      const started = performance.now();
      const response = await postDefault(chat, "Pi must read this after the held tool").expect(201);
      const postMs = performance.now() - started;
      expect(postMs).toBeLessThan(1000);
      await waitForPendingCommentSteers(); // release the peer's tool only after RPC acceptance
      expect(await deferredWakes(chat)).toHaveLength(0);
      expect(await answered(response.body.id)).toBe(false);
      expect(events.filter(event => event.eventType === "item.started" && event.payload.kind === "userMessage")).toHaveLength(1);
      peer.releaseBoundary(reply);
      await vi.waitFor(async () => {
        if (pumpError) throw pumpError;
        const comments = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/comments`).expect(200);
        expect(comments.body.find((comment: any) => comment.id === response.body.id)).toMatchObject({
          steeredIntoRunId: chat.runId, steeringStatus: "delivered", steeringDeliveryEventSeq: expect.any(Number),
        });
        expect(await answered(response.body.id)).toBe(reply);
      }, { timeout: 5000 });
      // The production facade deliberately projects an input receipt rather
      // than echoing its text. Its second userMessage is paired to M's real
      // correlation acknowledgement by the production evidence reader.
      const ownRead = events.filter(event => event.eventType === "item.started" && event.payload.kind === "userMessage")[1];
      expect(ownRead).toMatchObject({ runId: chat.runId, turnId });
      const toolEnd = events.findIndex(event => event.eventType === "tool.execution.completed" ||
        (event.eventType === "item.completed" && event.payload.kind === "commandExecution"));
      expect(toolEnd).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(ownRead!)).toBeGreaterThan(toolEnd);
      expect(peer.commands.filter(command => ["prompt", "steer", "abort", "follow_up"].includes(command.type)).map(command => command.type)).toEqual(["prompt", "steer"]);
      expect(await deferredWakes(chat)).toHaveLength(0);
      const persisted = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, chat.runId)).orderBy(asc(heartbeatRunEvents.seq));
      if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `S-a2-pi-peer-${reply ? "answered" : "tool-next"}.json`),
        JSON.stringify({ fixture: "real routes + real Pi and Codex facade drivers + proxy + production event ingestion; only native-session registry and Pi RPC peer controlled", postMs,
          comment: response.body, commands: peer.commands, events, persisted }, null, 2));
    } finally {
      await peer.close(); await pump;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("S-a RED: a reply which started before M was read never answers M, even if published afterwards", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const response = await postDefault(chat, "Tuesday's lost message").expect(201);
    await waitForPendingCommentSteers();
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.started", kind: "agentMessage", itemId: "turn-1:old-text", text: "" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${response.body.id}` },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:read-M" },
      { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:old-text", text: "Old answer" },
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
    await finishTurn(chat, { log: false });
    expect(await answered(response.body.id)).toBe(false);
    const carriers = await carriersOf(chat, response.body.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
  });

  it("S-b: two default messages retain sent order, one durable input each and no deferred wakes", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const a = await postDefault(chat, "First steer").expect(201);
    const b = await postDefault(chat, "Second steer").expect(201);
    await waitForPendingCommentSteers();
    expect(mocks.steer.mock.calls.map(([input]: any[]) => input.correlationId)).toEqual([a.body.id, b.body.id]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(run!.contextSnapshot!.steeredCommentIds).toEqual([a.body.id, b.body.id]);
    expect(await deferredWakes(chat)).toHaveLength(0);
    await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup);
    expect(mocks.steer).toHaveBeenCalledTimes(2);
    await finishTurn(chat);
    expect(await answered(a.body.id)).toBe(true); expect(await answered(b.body.id)).toBe(true);
    for (const id of [a.body.id, b.body.id]) {
      const carried = await carriersOf(chat, id); expect(carried.wakes.length + carried.runs.length).toBe(0);
    }
  });

  it.each(["starting", "saving-files", "non-Pi", "stale-turn"] as const)("S-c/S-c2: %s uses the ordinary next-message path once", async variant => {
    const chat = await seedChat(); await attachSteerable(chat);
    if (variant === "starting" || variant === "saving-files") mocks.probe.mockResolvedValue({ disposition: "temporarily_unavailable", activeTurnId: null });
    if (variant === "non-Pi") await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, chat.agentId));
    if (variant === "stale-turn") {
      const { NativeSessionSteeringError } = await import("../services/native-runtime/native-session-executor.js");
      mocks.steer.mockRejectedValue(new NativeSessionSteeringError("steering_stale_turn", "Turn ended"));
    }
    const response = await postDefault(chat, `Fallback ${variant}`).expect(201);
    await waitForPendingCommentSteers();
    await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup);
    const carriers = await carriersOf(chat, response.body.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    expect(await answered(response.body.id)).toBe(false);
    // An RPC refusal occurs after POST's custody decision. Depending on whether
    // its reconciliation beat response projection, the receipt is still pending
    // or already queued; neither is a delivered/Sent claim. The joined GET below
    // must always show the one ordinary queue receipt after refusal.
    if (variant === "stale-turn" && response.body.deliveryOutcome === "steered") {
      expect(response.body).toMatchObject({ steeredIntoRunId: chat.runId, steeringStatus: "accepted",
        steeringDeliveryEventSeq: null, steerDeliveredAt: null, steeringUnavailableReason: null });
    } else expect(response.body).toMatchObject({ deliveryOutcome: "queued", steeringUnavailableReason: expect.any(String) });
    const thread = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/comments`).expect(200);
    expect(thread.body.find((comment: any) => comment.id === response.body.id)).toMatchObject({
      deliveryOutcome: "queued", steeringUnavailableReason: expect.any(String),
    });
  });

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21272
  // A3: exercise the real comment POST and ordinary wake admission/release.
  it.each(["generic", "disconnect", "refusal", "probe", "unexpected-disposition"] as const)("A3: %s steer failure returns 201 and the ordinary successor answers once", async variant => {
    const chat = await seedChat(); await attachSteerable(chat);
    const { NativeSessionSteeringError } = await import("../services/native-runtime/native-session-executor.js");
    let refuseAfter201: (() => void) | undefined;
    if (variant === "generic") mocks.steer.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      refuseAfter201 = () => reject(new Error("private person text must not be logged"));
    }));
    else if (variant === "probe") mocks.probe.mockRejectedValueOnce(new Error("snapshot RPC disconnected"));
    else if (variant === "unexpected-disposition") mocks.steer.mockResolvedValueOnce({ disposition: "unexpected" });
    else mocks.steer.mockRejectedValueOnce(variant === "refusal"
      ? new NativeSessionSteeringError("steering_rejected", "refused")
      : variant === "disconnect" ? new TypeError("RPC disconnected") : new Error("private person text must not be logged"));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = subscribeCompanyLiveEvents(chat.companyId, event => { events.push(event); });
    const response = await postDefault(chat, `A3 ordinary ${variant}`);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    // Async POST reports custody, not the eventual RPC refusal. Keep the
    // original queued-state assertion on the authoritative joined GET.
    if (response.body.deliveryOutcome === "steered") expect(response.body).toMatchObject({
      steeringStatus: "accepted", steeringDeliveryEventSeq: null,
    });
    if (variant === "generic") {
      expect(response.body.deliveryOutcome).toBe("steered");
      await vi.waitFor(() => expect(refuseAfter201).toBeTypeOf("function"));
      refuseAfter201!(); // the refusal cannot happen before the saved 201
    }
    await waitForPendingCommentSteers();
    unsubscribe();
    const messageId = response.body.id;
    const thread = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/comments`).expect(200);
    expect(thread.body.find((comment: any) => comment.id === messageId)).toMatchObject({
      deliveryOutcome: "queued", steeringStatus: null, steeringUnavailableReason: expect.any(String),
    });
    // LiveUpdatesProvider hydrates the exact id via this endpoint, not listComments.
    const hydrated = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/comments/${messageId}`).expect(200);
    expect(hydrated.body).toMatchObject({ deliveryOutcome: "queued", steeringStatus: null,
      steeringUnavailableReason: thread.body.find((comment: any) => comment.id === messageId).steeringUnavailableReason });
    if (variant !== "probe") expect(events.filter(event => event.type === "activity.logged" &&
      event.payload.action === "issue.comment_added" &&
      (event.payload.details as any)?.source === "steering.refused" &&
      (event.payload.details as any)?.commentId === messageId)).toHaveLength(1);
    const [reserved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((reserved!.contextSnapshot as any).steeredCommentIds ?? []).not.toContain(messageId);
    expect((reserved!.contextSnapshot as any).wakeCommentIds ?? []).not.toContain(messageId);
    if (variant !== "probe") expect((reserved!.resultJson as any).queuedSteeringAcknowledgements[messageId].status).toBe("rejected");
    await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup);
    const carriers = await carriersOf(chat, messageId);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    const seen: string[][] = [];
    const responder = createServer(async (req, res) => {
      try {
        let body = ""; for await (const chunk of req) body += chunk;
        const { runId } = JSON.parse(body);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const context = run!.contextSnapshot as any;
        seen.push(context.wakeCommentIds ?? [context.wakeCommentId ?? context.commentId]);
        await issueService(db).addComment(chat.issue.id, `ANSWER:${messageId}`, { agentId: chat.agentId, runId });
        res.end("ok");
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
    responder.listen(0, "127.0.0.1"); await once(responder, "listening");
    const port = (responder.address() as { port: number }).port;
    try {
      const script = `fetch("http://127.0.0.1:${port}/reply",{method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok)throw Error(await r.text())})`;
      await db.update(agents).set({ adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", script] },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, chat.agentId));
      runningProcesses.delete(chat.runId);
      await finishTurn(chat, { log: false });
      // This fixture calls the release adapter directly, outside heartbeat's
      // completion owner. Run the existing queued-run dispatcher after commit.
      await heartbeatService(db).resumeQueuedRunsForAgent(chat.companyId, chat.agentId);
      await vi.waitFor(async () => {
        const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.issue.id),
          eq(issueComments.body, `ANSWER:${messageId}`)));
        expect(replies).toHaveLength(1);
      }, { timeout: 15_000 });
      await joinOwnedWork();
      await releaseRun(chat); await deliverConversationComments(db, chat.issue, heartbeatService(db).wakeup); await joinOwnedWork();
      expect(seen.flat()).toEqual([messageId]);
      expect(await answered(messageId)).toBe(true);
      const remaining = await carriersOf(chat, messageId);
      expect(remaining.wakes).toHaveLength(0);
      expect(remaining.runs).toHaveLength(1);
      expect(remaining.runs[0]!.status).toBe("succeeded");
      const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.issue.id),
        eq(issueComments.body, `ANSWER:${messageId}`)));
      expect(replies).toHaveLength(1);
    } finally {
      if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `A3-${variant}-delivery.json`), JSON.stringify({
        post: response.body, seen,
        runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, chat.companyId)),
        wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, chat.companyId)),
        comments: await db.select().from(issueComments).where(eq(issueComments.issueId, chat.issue.id)),
      }, null, 2));
      responder.close(); await once(responder, "close");
    }
  }, 25_000);

  it("A3 S9: the ONE answered predicate keeps a consumed steer owed after a tool and unrelated final", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const response = await postDefault(chat, "A3 S9 still owed").expect(201);
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${response.body.id}` },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:read-M" },
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:old-work" },
      { eventType: "tool.execution.started", itemId: "turn-1:old-work" },
      { eventType: "tool.execution.completed", itemId: "turn-1:old-work" },
      { eventType: "item.started", kind: "agentMessage", itemId: "turn-1:unrelated-final" },
      { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:unrelated-final", text: "ORIGINAL_WORK_FINISHED" },
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
    expect(await answered(response.body.id)).toBe(false);
    await finishTurn(chat, { log: false }); await releaseRun(chat);
    expect(await answered(response.body.id)).toBe(false);
    const carriers = await carriersOf(chat, response.body.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
  });

  it("A3: uncertain steering timeout returns 201 accepted and end-of-run carries M once", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const { NativeSessionSteeringError } = await import("../services/native-runtime/native-session-executor.js");
    mocks.steer.mockRejectedValueOnce(new NativeSessionSteeringError("steering_timeout", "uncertain receipt"));
    const response = await postDefault(chat, "A3 timeout");
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ deliveryOutcome: "steered", steeringStatus: "accepted", steeredIntoRunId: chat.runId });
    expect(await deferredWakes(chat)).toHaveLength(0);
    expect(await answered(response.body.id)).toBe(false);
    await finishTurn(chat, { log: false }); await releaseRun(chat);
    const carriers = await carriersOf(chat, response.body.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
  });

  it("S-c accepted-then-ended: an unread default steer is restored exactly once at run end", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const response = await postDefault(chat, "Unread default").expect(201);
    await waitForPendingCommentSteers();
    await finishTurn(chat, { log: false });
    await releaseRun(chat);
    const carriers = await carriersOf(chat, response.body.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    expect(await answered(response.body.id)).toBe(false);
  });

  it("S-d: delivery without following assistant text joins the ONE person-Stop hold", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const response = await postDefault(chat, "Stop before answering this").expect(201);
    await waitForPendingCommentSteers();
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${response.body.id}` },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:read-M" },
      { eventType: "turn.cancelled", itemId: "turn-1:end" },
    ]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || '{"cancelledByActorType":"user"}'::jsonb` })
      .where(eq(heartbeatRuns.id, chat.runId));
    await releaseRun(chat);
    const { readPersonStopHold } = await import("../services/acknowledged-native-stop.js");
    expect(await readPersonStopHold(db, { companyId: chat.companyId, issueId: chat.issue.id, agentId: chat.agentId, messageId: response.body.id }))
      .toMatchObject({ stoppedRunId: chat.runId });
    expect(await answered(response.body.id)).toBe(false);
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.entries.map((entry: any) => entry.comment.id)).toContain(response.body.id);
  });

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21272
  it.each([false, true])("S-j/S-x: ordered Pi ingestion delayed past agent_end holds the steer, then answers once (past bound=%s)", async pastBound => {
    const chat = await seedChat(); await attachSteerable(chat);
    const root = await mkdtemp(join(tmpdir(), "chat-pi-late-ingestion-"));
    const peer = await openPiSteeringPeer(root, chat.runId);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let readPaused = false, reads = 0, terminal = false;
    let pumpError: unknown;
    let port: PaperclipControlPlanePort | undefined;
    const pump = (async () => {
      for await (const event of peer.session.events()) {
        port ??= new PaperclipControlPlanePort(db, { companyId: chat.companyId, issueId: chat.issue.id,
          runId: chat.runId, agentId: chat.agentId, sessionId: event.normalizedSessionId,
          completionContractId: randomUUID(), completionContractSha256: `sha256:${"a".repeat(64)}`,
          sourceInstanceId: event.sourceInstanceId, controlPlaneSourceInstanceId: event.sourceInstanceId });
        if (event.eventType === "item.started" && event.payload.kind === "userMessage" && ++reads === 2) {
          readPaused = true; await gate; // Delay the whole ordered suffix, NEVER reorder it.
        }
        await port.appendEvent(event);
        if (event.eventType === "turn.completed") terminal = true;
      }
    })().catch(error => { pumpError = error; });
    try {
      const { turnId } = await peer.session.startTurn({ message: { role: "user", text: chat.first.body } });
      await vi.waitFor(() => expect(reads).toBe(1));
      mocks.probe.mockResolvedValue({ disposition: "available", activeTurnId: turnId });
      mocks.steer.mockImplementation(async (input: { message: string; correlationId: string }) => {
        await peer.session.steer!({ turnId, message: { role: "user", text: input.message }, correlationId: input.correlationId });
        return { turnId };
      });
      const response = await postDefault(chat, "Read before agent_end, ingested afterwards").expect(201);
      await waitForPendingCommentSteers(); // POST returns custody before the native RPC ACK.
      peer.releaseBoundary(true); peer.endTurn(); // Producer has ended while its read is still held.
      await vi.waitFor(() => expect(readPaused).toBe(true));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, chat.runId));
      const release = releaseRun(chat);
      if (pastBound) {
        await release; // Beyond the named wait bound: keep original custody, no wake/successor.
        const carriers = await carriersOf(chat, response.body.id);
        expect(carriers.wakes.length + carriers.runs.length, "a restored carrier would answer M twice").toBe(0);
        const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
        expect((held!.contextSnapshot as any).steeredCommentIds).toContain(response.body.id);
      }
      resume();
      await vi.waitFor(() => { if (pumpError) throw pumpError; expect(terminal).toBe(true); }, { timeout: 5000 });
      await release; await releaseRun(chat);
      expect(await answered(response.body.id)).toBe(true);
      const carriers = await carriersOf(chat, response.body.id);
      expect(carriers.wakes.length + carriers.runs.length, "M must have no second-answer carrier").toBe(0);
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
      expect((ended!.resultJson as any).restoredSteeredCommentIds ?? []).not.toContain(response.body.id);
    } finally { resume(); await peer.close(); await pump; await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it.each([false, true])("S-j no terminal: a closed crashed stream uses only ingested facts, once (read/text retained=%s)", async retained => {
    const chat = await seedChat(); await attachSteerable(chat);
    const response = await postDefault(chat, "Read and answer may both be lost on crash").expect(201);
    await waitForPendingCommentSteers(); // Join dispatch before injecting its later crash facts.
    const sourceInstanceId = randomUUID();
    const port = new PaperclipControlPlanePort(db, { companyId: chat.companyId, issueId: chat.issue.id,
      runId: chat.runId, agentId: chat.agentId, sessionId: "crashed-pi-session",
      completionContractId: randomUUID(), completionContractSha256: `sha256:${"a".repeat(64)}`,
      sourceInstanceId, controlPlaneSourceInstanceId: randomUUID() });
    const events = [
      { eventType: "item.started", itemId: "turn-1:input", payload: { kind: "userMessage" } },
      { eventType: "item.completed", itemId: `turn-1:steer:${response.body.id}`, payload: { kind: "steering_acknowledgement" } },
      ...(retained ? [
        { eventType: "item.started", itemId: "turn-1:read", payload: { kind: "userMessage" } },
        { eventType: "item.started", itemId: "turn-1:reply", payload: { kind: "agentMessage" } },
        { eventType: "item.completed", itemId: "turn-1:reply", payload: { kind: "agentMessage", text: "Answer survived" } },
      ] : []),
    ];
    for (const [index, event] of events.entries()) await port.appendEvent({ schema: "paperclip.prp.event.v1",
      sourceInstanceId, sourceKind: "runner", sourceEventId: `${sourceInstanceId}:${index + 1}`, sourceSeq: index + 1,
      runId: chat.runId, normalizedSessionId: "crashed-pi-session", turnId: "turn-1", schemaVersion: 1,
      priority: 0, emittedAt: new Date().toISOString(), ...event } as PrpEvent);
    // Recovery has joined the failed consumer and saved its true line. No terminal is invented.
    await finishTurn(chat, { status: "failed", log: false });
    const held = await carriersOf(chat, response.body.id);
    expect(held.wakes.length + held.runs.length).toBe(0);
    await port.settleEventIngestion();
    await releaseRun(chat);
    const carriers = await carriersOf(chat, response.body.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(retained ? 0 : 1);
    expect(await answered(response.body.id)).toBe(retained);
  });

  it.each(["interrupt-first", "release-first", "concurrent"] as const)("S-d2: unread steers are carried once under the release lock (%s)", async order => {
    const chat = await seedChat(); await attachSteerable(chat);
    const sent = [];
    for (const text of ["read and answered", "unread first", "unread second"]) sent.push((await postDefault(chat, text).expect(201)).body);
    await waitForPendingCommentSteers(); // Run-log facts follow ordered dispatch, not just custody.
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${sent[0].id}` },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:read" },
      { eventType: "item.started", kind: "agentMessage", itemId: "turn-1:reply" },
      { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:reply", text: "answered" },
      ...sent.slice(1).map(message => ({ eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${message.id}` })),
    ]);
    const { recordSteeredMessageEvidence } = await import("../services/native-runtime/steered-message-answers.js");
    await recordSteeredMessageEvidence(db, { companyId: chat.companyId, runId: chat.runId });
    const reader = await import("../services/native-runtime/unread-steered-messages.js");
    expect(reader).toHaveProperty("readUnreadSteeredForInterrupt");
    const take = () => db.transaction(async tx => {
      const ids = await (reader as any).readUnreadSteeredForInterrupt(tx, { issueId: chat.issue.id, runId: chat.runId });
      if (ids.length) await tx.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId,
        status: "queued", contextSnapshot: { issueId: chat.issue.id, wakeCommentIds: ids } });
      return ids;
    });
    // A person's Stop keeps restored wakes held; no background successor obscures the DB race.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || '{"cancelledByActorType":"user"}'::jsonb` })
      .where(eq(heartbeatRuns.id, chat.runId));
    let taken: string[];
    if (order === "interrupt-first") { taken = await take(); await releaseRun(chat); }
    else if (order === "release-first") { await releaseRun(chat); taken = await take(); }
    else [taken] = await Promise.all([take(), releaseRun(chat)]);
    if (order === "interrupt-first") expect(taken).toEqual(sent.slice(1).map(message => message.id));
    if (order === "release-first") expect(taken).toEqual([]);
    expect(await take()).toEqual([]);
    for (const message of sent.slice(1)) {
      const carriers = await carriersOf(chat, message.id);
      expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    }
    const answeredCarriers = await carriersOf(chat, sent[0].id);
    expect(answeredCarriers.wakes.length + answeredCarriers.runs.length).toBe(0);
    expect(await answered(sent[0].id)).toBe(true);
  });

  it("S-f: explicit Queue never calls steer even on an attached Pi turn", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const response = await postDefault(chat, "Queue deliberately", { deliveryIntent: "queue" }).expect(201);
    expect(mocks.steer).not.toHaveBeenCalled();
    const carriers = await carriersOf(chat, response.body.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
  });

  it("S-f: explicit Interrupt uses the existing stop/admission path, and a POST retry does not stop the successor", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    mocks.cancel.mockImplementationOnce(async (runId: string) => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson ?? {}), nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: chat.companyId, issueId: chat.issue.id,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } } }).where(eq(heartbeatRuns.id, runId));
      return { decision: { stopped: true }, auditId: randomUUID() };
    });
    const clientRequestId = randomUUID();
    const first = await postDefault(chat, "Interrupt deliberately", { deliveryIntent: "interrupt", clientRequestId }).expect(201);
    expect(mocks.steer).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(original!.status).toBe("cancelled");
    const retry = await postDefault(chat, "Interrupt deliberately", { deliveryIntent: "interrupt", clientRequestId }).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    const receipts = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, chat.companyId),
      eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${first.body.id}`)));
    expect(receipts).toHaveLength(1);
    await joinOwnedWork();
  });

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


  // RED 2 (guard part): a reset is never merged, in either direction.
  it("never merges a chat message across a /new reset (guard)", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["Before", "/new", "After"]);
    const wakes = await deferredWakes(chat);
    expect(wakes.map(wakeCommentIds)).toEqual(sent.map((comment) => [comment.id]));
  });

  // RED 2 + RFL (2) merge boundary: plain runs merge on each side of a reset only.


  // RED 3: reorder works on a chat.


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
    // rf5 F1: the steer is recorded by id; it never moves the reply boundary by timestamp.
    expect((run!.contextSnapshot as any).steeredCommentIds).toEqual([steered!.id]);
    expect((run!.contextSnapshot as any).conversationReplyBoundaryCommentId).toBeUndefined();
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
    // The run end promotes it: it waits for the next turn once (a deferred wake, or the run it became).
    const carriers = await carriersOf(chat, next!.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
  });

  // RFL (3): merged messages are each answered once, none lost, none doubled.


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


  // rf5 F1: drag, then steer all three in the final order. The provider gets each
  // once in that order, each is answered, and the chat settles to waiting.


  // rf5 F2: a merged entry is never edited into a /new, at either position.


  // rf5 F2: a merged entry without /new still edits, reorders and runs as one plain turn.
  // (RED at 82b635b4d too: after a reorder the timestamp boundary left the chat stuck active, the F1 cause.)


  // rf5 F2: a single queued message edited into /new keeps its own wake and resets the session.
  it("lets a single queued chat message become /new and keeps the /new boundary", async () => {
    const chat = await seedChat();
    const [solo] = await send(chat, ["Solo"]);
    expect((await edit(chat, solo!.id, "/new")).status).toBe(200);
    const [after] = await send(chat, ["After"]);
    const wakes = await deferredWakes(chat);
    expect(wakes.map(wakeCommentIds)).toEqual([[solo!.id], [after!.id]]);
    await finishTurn(chat);
    const [nextRun] = await db.insert(heartbeatRuns).values({
      companyId: chat.companyId, agentId: chat.agentId, status: "running", runtimeMode: "native",
      contextSnapshot: (wakes[0]!.payload as Record<string, any>)._paperclipWakeContext,
    }).returning();
    await db.update(issues).set({ executionRunId: nextRun!.id }).where(eq(issues.id, chat.issue.id));
    expect((await prepareConversationTurn(db, nextRun!)).reset).toBe(true);
  });

  // rf5 F3: only the owner mutates a chat queue (same rule as Steer).


  it("refuses another board operator's edit of the owner's chat queue (403)", async () => {
    const chat = await seedChat();
    const [head] = await send(chat, ["A"]);
    const response = await edit(chat, head!.id, "Changed", app(chat.companyId, "other-operator"));
    expect(response.status).toBe(403);
    const [row] = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.id, head!.id));
    expect(row!.body).toBe("A");
  });

  it("refuses another board operator's discard from the owner's chat queue (403)", async () => {
    const chat = await seedChat();
    const [head] = await send(chat, ["A"]);
    const { queue } = await queueOf(chat);
    const response = await request(app(chat.companyId, "other-operator"))
      .delete(`/api/issues/${chat.issue.id}/queued-comments/${head!.id}`)
      .send({ queueId: queue.body.queueId, revision: queue.body.revision });
    expect(response.status).toBe(403);
    expect(wakeCommentIds((await deferredWakes(chat))[0]!)).toEqual([head!.id]);
  });

  it("refuses another board operator's interrupt of the owner's chat (403)", async () => {
    const chat = await seedChat();
    await send(chat, ["A"]);
    const { queue } = await queueOf(chat);
    const response = await request(app(chat.companyId, "other-operator"))
      .post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
      .send({ queueId: queue.body.queueId, targetRunId: chat.runId, revision: queue.body.revision });
    expect(response.status).toBe(403);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(run!.status).toBe("running");
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
  it.each(["unread", "read-no-reply", "read-answered"] as const)("after a person's Stop, a steered message the model had not read waits again and one Send delivers it once (%s)", async (variant) => {
    const chat = await seedChat();
    const [b, c] = await send(chat, ["B, steered", "C, waiting"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    expect((await steer(chat, b!.id, wake!.id)).status).toBe(200);
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${b!.id}` },
      // Pi put B into the conversation: the model read it.
      ...(variant !== "unread" ? [{ eventType: "item.started", kind: "userMessage", itemId: "turn-1:steered" }] : []),
      // Pi streams the reply: its text STARTS (item.started), then completes.
      ...(variant === "read-answered" ? [{ eventType: "item.started", kind: "agentMessage", itemId: "turn-1:reply", text: "" },
        { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:reply", text: "B: yes" }] : []),
    ]);
    await personStop(chat);
    const expected = variant === "read-answered" ? [c!.id] : [b!.id, c!.id];
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.entries.map((entry: any) => entry.comment.id)).toEqual(expected);
    expect(queue.body.executionWait).toEqual({ reason: "stopped_by_person", message: STOPPED_LINE });
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((stopped!.contextSnapshot as any).wakeCommentIds)
      .toEqual(variant === "read-answered" ? [chat.first.id, b!.id] : [chat.first.id]);
    // The shared predicate now recognizes durable streamed text immediately;
    // neither an acknowledgement nor a userMessage alone is an answer.
    expect(await answered(b!.id)).toBe(variant === "read-answered");

    // The owner's Send: one turn with the waiting messages, each once, in order.
    const sent = await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
      .send({ queueId: queue.body.queueId, revision: queue.body.revision, targetRunId: null });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, chat.companyId),
      sql`${heartbeatRuns.id} <> ${chat.runId}`));
    expect(successors).toHaveLength(1);
    expect((successors[0]!.contextSnapshot as any).wakeCommentIds).toEqual(expected);
    expect(await deferredWakes(chat)).toHaveLength(0);
    // A repeated Send neither doubles nor reopens it.
    expect((await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/queued-comments/interrupt`)
      .send({ queueId: queue.body.queueId, revision: queue.body.revision, targetRunId: null })).status).toBe(409);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, chat.companyId),
      sql`${heartbeatRuns.id} <> ${chat.runId}`))).toHaveLength(1);
    // This fixture's agent has no runtime: let the successor's own execution
    // settle before the next test truncates its rows.
    await vi.waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id));
      const [agent] = await db.select().from(agents).where(eq(agents.id, chat.agentId));
      expect(["queued", "running"]).not.toContain(run!.status);
      expect(agent!.status).not.toBe("running");
    }, { timeout: 20_000, interval: 100 });
    // rf5 F1: the successor's owned post-commit work (its execution, wakes and failure report) is joined too.
    await joinOwnedWork();
  });

  // S10 C2: A, /new, B behind a person's Stop. One Send runs A, then /new, then
  // B, so the stopped list shows all three, the /new and B marked behind it.
  it("after a person's Stop, the waiting list shows the messages behind a /new too", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["A", "/new", "B"]);
    await personStop(chat);
    const queue = await request(app(chat.companyId)).get(`/api/issues/${chat.issue.id}/queued-comments`).expect(200);
    expect(queue.body.executionWait).toEqual({ reason: "stopped_by_person", message: STOPPED_LINE });
    expect(queue.body.entries.map((entry: any) => entry.comment.id)).toEqual(sent.map((comment) => comment.id));
    expect(queue.body.entries.map((entry: any) => entry.behindReset)).toEqual([false, true, true]);
    const wakes = await deferredWakes(chat);
    expect(queue.body.queueId).toBe(wakes[0]!.id);
    expect(queue.body.entries.slice(1).map((entry: any) => entry.queueId)).toEqual([wakes[1]!.id, wakes[2]!.id]);
  });

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

  it.each([
    ["unread", "succeeded"], ["unread", "failed"],
    ["read-no-reply", "succeeded"], ["read-no-reply", "failed"],
    ["read-answered", "succeeded"], ["read-answered", "failed"],
  ] as const)("at a run end, a steered message is answered only by reply text after its read (%s, %s)", async (shape, status) => {
    const chat = await seedChat();
    const [b] = await send(chat, ["B, steered mid-turn"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    expect((await steer(chat, b!.id, wake!.id)).status).toBe(200);
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      ...SHAPES[shape](b!.id),
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
    await finishTurn(chat, { status, log: false });
    const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    const carriers = await carriersOf(chat, b!.id);
    if (shape === "read-answered") {
      expect(await answered(b!.id)).toBe(true);
      expect((ended!.contextSnapshot as any).answeredSteeredCommentIds).toEqual([b!.id]);
      // No second delivery.
      expect(carriers.wakes.length + carriers.runs.length).toBe(0);
      return;
    }
    // B is NOT answered: the run that never replied to it no longer carries it.
    expect(await answered(b!.id)).toBe(false);
    expect((ended!.contextSnapshot as any).wakeCommentIds).toEqual([chat.first.id]);
    expect((ended!.contextSnapshot as any).steeredCommentIds).toEqual([]);
    expect((ended!.resultJson as any).restoredSteeredCommentIds).toEqual([b!.id]);
    // B waits for the next turn, delivered ONCE: one wake or one successor run carries it.
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    // A repeated release (a stranded-queue retry) neither doubles nor drops it.
    await releaseRun(chat);
    const again = await carriersOf(chat, b!.id);
    expect(again.wakes.length + again.runs.length).toBe(1);
    // The sweep's pending path explains it: NO "not answered / send it again" notice for B.
    const outcome = await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id });
    expect(outcome.kind).not.toBe("noticed");
    const notices = await db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.issue.id),
      sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + b!.id}`));
    expect(notices).toHaveLength(0);
    // The successor answers it: B is answered exactly once (R-ONCE).
    const [successor] = again.runs.length ? again.runs : await db.insert(heartbeatRuns).values({
      companyId: chat.companyId, agentId: chat.agentId, status: "running", runtimeMode: "native",
      contextSnapshot: (again.wakes[0]!.payload as any)._paperclipWakeContext,
    }).returning();
    expect((successor!.contextSnapshot as any).wakeCommentIds).toContain(b!.id);
    await db.insert(issueComments).values({
      companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent", authorAgentId: chat.agentId,
      createdByRunId: successor!.id, body: "B: answered by the next turn",
    });
    expect(await answered(b!.id)).toBe(true);
    const answeringRuns = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, chat.companyId)))
      .filter((run) => ((run.contextSnapshot as any).wakeCommentIds ?? []).includes(b!.id));
    expect(answeringRuns.map((run) => run.id)).toEqual([successor!.id]);
  });
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

  it.each([
    // F1 RED: B is read at the tool boundary; the final reply is a receipt with no streamed start.
    ["completion-only final", { streamed: false }, "succeeded"],
    // F1 positive: the same final, streamed: its text STARTS after B's read and before the turn's end.
    ["streamed final", { streamed: true }, "succeeded"],
    // F2: the reply STARTED after B's read, then Pi's receipt failed it (item.failed); then nothing.
    ["started then failed", { streamed: true, stopReason: "error" }, "failed"],
  ] as const)("at a run end, the real Pi projector's %s answers B only from a started, completed text", async (shape, options, status) => {
    const chat = await seedChat();
    const [b] = await send(chat, ["B, steered mid-turn"]);
    const [wake] = await deferredWakes(chat);
    mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
    expect((await steer(chat, b!.id, wake!.id)).status).toBe(200);
    const projected = await piRunLog(chat, [
      ...PI.user("A", 1),
      ...PI.tool("call-1", "r-1"),
      { ack: b!.id },
      ...PI.user("B, steered mid-turn", 2),
      ...PI.reply(shape === "streamed final" ? "B: yes. A: done." : "A: done.", "r-2", options),
      { end: status === "failed" ? "turn.failed" : "turn.completed" },
    ]);
    // The projector's own shapes: final-only text has no item.started; a failed receipt fails the started block.
    const final = projected.slice(projected.lastIndexOf("item.started:userMessage") + 2, -1)
      .filter((event) => event.endsWith(":agentMessage") && !event.startsWith("item.delta"));
    expect(final).toEqual(shape === "completion-only final" ? ["item.completed:agentMessage"]
      : shape === "streamed final" ? ["item.started:agentMessage", "item.completed:agentMessage"]
        : ["item.started:agentMessage", "item.failed:agentMessage"]);
    await finishTurn(chat, { status, log: false });
    const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    const carriers = await carriersOf(chat, b!.id);
    if (shape === "streamed final") {
      expect(await answered(b!.id)).toBe(true);
      expect((ended!.contextSnapshot as any).answeredSteeredCommentIds).toEqual([b!.id]);
      expect(carriers.wakes.length + carriers.runs.length).toBe(0);
      return;
    }
    // NOT answered: never marked answered with zero carriers; carried ONCE, and a repeated release never doubles it.
    expect(await answered(b!.id)).toBe(false);
    expect((ended!.contextSnapshot as any).answeredSteeredCommentIds ?? []).toEqual([]);
    expect((ended!.resultJson as any).restoredSteeredCommentIds).toEqual([b!.id]);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    await releaseRun(chat);
    const again = await carriersOf(chat, b!.id);
    expect(again.wakes.length + again.runs.length).toBe(1);
    const [twice] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((twice!.resultJson as any).restoredSteeredCommentIds).toEqual([b!.id]);
    await joinOwnedWork();
  });

  // rf5 F3 (R-ONCE "in order"): two steers whose acknowledgements share one timestamp are restored in the order
  // they were steered, never re-sorted by JSONB key order. The person dragged the larger id to the head, so
  // JSONB key order (shorter, then bytewise) disagrees with the steering order.
  it("restores two unanswered steers with tied acknowledgement timestamps in their steered order, ahead of the waiting one", async () => {
    const chat = await seedChat();
    const sent = await send(chat, ["X", "Y", "D, waiting"]);
    const [high, low] = [sent[0]!, sent[1]!].sort((left, right) => (left.id < right.id ? 1 : -1));
    // Pin ONLY this accounting fixture to c3's supported grouped-wake input
    // (the form produced by the existing person's-Stop gather). Cross-wake
    // drag/reorder is builder B's independent scope; no outcome assertion below changes.
    const { withQueuedCommentIdsInWakePayload } = await import("../services/issue-queued-comment-queue.js");
    const [group, ...remaining] = await deferredWakes(chat);
    await db.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(group!.payload,
      [high!.id, low!.id, sent[2]!.id]) }).where(eq(agentWakeupRequests.id, group!.id));
    for (const wake of remaining) await db.update(agentWakeupRequests).set({ status: "coalesced", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wake.id));
    for (const message of [high!, low!]) {
      const [wake] = await deferredWakes(chat);
      mocks.steer.mockResolvedValueOnce({ turnId: "turn-1" });
      const response = await steer(chat, message.id, wake!.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    // The same millisecond for both acknowledgements.
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    const acks = (run!.resultJson as any).queuedSteeringAcknowledgements;
    const tied = acks[high!.id].acknowledgedAt;
    await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson as any), queuedSteeringAcknowledgements: {
      [low!.id]: { ...acks[low!.id], acknowledgedAt: tied }, [high!.id]: { ...acks[high!.id], acknowledgedAt: tied } } } })
      .where(eq(heartbeatRuns.id, chat.runId));
    expect((run!.contextSnapshot as any).steeredCommentIds).toEqual([high!.id, low!.id]);
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${high!.id}` },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${low!.id}` },
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
    await finishTurn(chat, { status: "succeeded", log: false });
    const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect((ended!.resultJson as any).restoredSteeredCommentIds).toEqual([high!.id, low!.id]);
    // ONE carrier holds all three, in the person's order.
    const carriers = await carriersOf(chat, high!.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    const carried = carriers.runs.length ? (carriers.runs[0]!.contextSnapshot as any).wakeCommentIds as string[]
      : wakeCommentIds(carriers.wakes[0]!);
    expect(carried.filter((id) => id !== chat.first.id)).toEqual([high!.id, low!.id, sent[2]!.id]);
    await joinOwnedWork();
  });
  it("row11: tied default steers restore in steer order ahead of separately waiting input", async () => {
    const chat = await seedChat(); await attachSteerable(chat);
    const one = (await postDefault(chat, "First default steer").expect(201)).body;
    const two = (await postDefault(chat, "Second default steer").expect(201)).body;
    await waitForPendingCommentSteers(); // The synthetic tied ACKs must follow actual dispatch.
    const [waiting] = await send(chat, ["Waiting explicit Queue"]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    const acks = (run!.resultJson as any).queuedSteeringAcknowledgements;
    await db.update(heartbeatRuns).set({ resultJson: { ...run!.resultJson, queuedSteeringAcknowledgements: {
      [two.id]: { ...acks[two.id], acknowledgedAt: acks[one.id].acknowledgedAt }, [one.id]: acks[one.id],
    } } }).where(eq(heartbeatRuns.id, chat.runId));
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      ...[one, two].map(message => ({ eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${message.id}` })),
      { eventType: "turn.completed", itemId: "turn-1:end" },
    ]);
    await finishTurn(chat, { log: false });
    const carriers = await carriersOf(chat, one.id);
    expect(carriers.wakes.length + carriers.runs.length).toBe(1);
    const carried = carriers.runs.length ? (carriers.runs[0]!.contextSnapshot as any).wakeCommentIds : wakeCommentIds(carriers.wakes[0]!);
    expect(carried).toEqual([one.id, two.id, waiting!.id]);
    await releaseRun(chat);
    for (const message of [one, two, waiting!]) {
      const again = await carriersOf(chat, message.id);
      expect(again.wakes.length + again.runs.length).toBe(1);
    }
  });
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
  it("labels a carried steer 'received mid-task' in the next turn's input, and never an ordinary queued message", async () => {
    const chat = await seedChat();
    const b = await restoredSteer(chat);
    const [c] = await send(chat, ["C, an ordinary queued message"]);
    const successor = await carryingTurn(chat, b.id);
    const context = { ...(successor.contextSnapshot as Record<string, unknown>), wakeCommentIds: [b.id, c!.id],
      wakeCommentId: c!.id, commentId: c!.id };
    const payload = await buildPaperclipWakePayload({ db, companyId: chat.companyId, agentId: chat.agentId,
      runId: successor.id, contextSnapshot: context });
    const comments = (payload as any).comments as Array<Record<string, unknown>>;
    expect(comments.find((comment) => comment.id === b.id)).toMatchObject({ body: "B, steered mid-turn", receivedMidTask: true });
    expect(comments.find((comment) => comment.id === c!.id)?.receivedMidTask).toBeUndefined();
    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain(`${RECEIVED_MID_TASK}\nB, steered mid-turn`);
    expect(prompt).toContain("C, an ordinary queued message");
    expect(prompt.split(RECEIVED_MID_TASK)).toHaveLength(2);
    // A first turn that takes waiting messages renders the same one line, only for the carried steer.
    const firstTurn = renderFirstTurnQueuedInput([
      { id: b.id, body: "B, steered mid-turn", createdAt: new Date(), receivedMidTask: true },
      { id: c!.id, body: "C, an ordinary queued message", createdAt: new Date() },
    ])!;
    expect(firstTurn).toContain(`${RECEIVED_MID_TASK}\nB, steered mid-turn`);
    expect(firstTurn.split(RECEIVED_MID_TASK)).toHaveLength(2);
    // An ordinary queued message that was never steered is never labelled.
    const plain = await buildPaperclipWakePayload({ db, companyId: chat.companyId, agentId: chat.agentId,
      runId: successor.id, contextSnapshot: { ...context, wakeCommentIds: [c!.id] } });
    expect(renderPaperclipWakePrompt(plain)).not.toContain(RECEIVED_MID_TASK);
  });

  // Follow-up 2: the turn that carried a restored steer ends FAILED or cancelled without answering it. ONE true
  // notice for that message (the sweep's notice path, its own key), never a silent answered-mark, never twice;
  // also when a later message is the latest one.
  it.each([
    ["failed", false], ["cancelled", false], ["failed", true],
  ] as const)("posts exactly one true notice when the turn carrying a restored steer ends %s without answering it (later message: %s)", async (status, later) => {
    const chat = await seedChat();
    const b = await restoredSteer(chat);
    const successor = await carryingTurn(chat, b.id);
    const [c] = later ? await send(chat, ["C, sent after"]) : [];
    await db.update(heartbeatRuns).set({ status, finishedAt: new Date(), ...(status === "failed"
      ? { error: "adapter_failed: the provider exited", errorCode: "adapter_failed" } : {}) })
      .where(eq(heartbeatRuns.id, successor.id));
    const notices = async () => db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.issue.id),
      sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + b.id}`));
    // Before the settle delay nothing is posted yet.
    await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id });
    expect(await notices()).toHaveLength(0);
    const outcome = await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id,
      now: new Date(Date.now() + 60_000) });
    expect(outcome.kind).toBe("noticed");
    const posted = await notices();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe(status === "failed"
      ? "Your message (received mid-task) wasn't answered because the run failed. Sending it again is safe."
      : "Your message (received mid-task) wasn't answered because the run was stopped. Sending it again is safe.");
    expect(posted[0]!.authorType).toBe("system");
    // Never a silent answered-mark.
    expect(await answered(b.id)).toBe(false);
    // Never twice: later passes keep the one notice.
    for (const offset of [120_000, 600_000]) {
      await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id,
        now: new Date(Date.now() + offset) });
    }
    expect(await notices()).toHaveLength(1);
    if (c) {
      // The later message keeps its own path: it waits for its own turn, with no notice of B's kind.
      const forC = await db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.issue.id),
        sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + c.id}`));
      expect(forC.every((notice) => !notice.body.includes("received mid-task"))).toBe(true);
    }
  });
});
