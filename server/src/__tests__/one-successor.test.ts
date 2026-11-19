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
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { settleUnansweredPersonMessage, settleUnansweredPersonMessages, UNANSWERED_MESSAGE_REASON_PREFIX } from "../services/recovery/unanswered-person-message.js";
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

describeEmbeddedPostgres("ONE successor per Interrupt (adopt-one-successor, 390 take)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const owner = "chat-owner";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-one-successor-");
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
  async function finishTurn(chat: Chat, options: { status?: "succeeded" | "failed"; log?: boolean; reply?: boolean } = {}) {
    if (options.log !== false) await answeredLog(chat);
    if (options.reply !== false) await db.insert(issueComments).values({
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

  // ---- adopt-one-successor rows (390 take 11:16-11:20Z: cut run 3d8233e2, carry fd3b9c1f, second wake 41b2b1e4) ----

  const carryWakes = (chat: Chat) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, chat.companyId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${chat.issue.id}`,
    sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`));
  const commentWakes = (chat: Chat, id: string) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, chat.companyId), eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${id}`)));

  /** The take's run log: WORK is the turn's input; STEER is acknowledged and READ (its userMessage), then the
   * model runs a tool with no text. The turn is still running when the person presses Interrupt. */
  async function readNotAnswered(chat: Chat, steerId: string) {
    await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-1" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${steerId}` },
      { eventType: "item.completed", kind: "commandExecution", itemId: "turn-1:tool-1" },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:steered" },
      { eventType: "item.completed", kind: "userMessage", itemId: "turn-1:steered" },
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-2" },
    ]);
  }

  /** Paul's four steps through the real routes: WORK running; STEER steered in (default Send) and READ;
   * Q1, Q2 queued (Ctrl+Cmd+Enter = deliveryIntent queue); then Interrupt with MSG. */
  async function paulsFourSteps(chat: Chat, opts: { steer: boolean; queued: boolean; readIngestedAtPress?: boolean; admitCarryFirst?: boolean }) {
    await attachSteerable(chat);
    let steerId: string | null = null;
    if (opts.steer) {
      const steered = (await postDefault(chat, "STEER: also look at the logs").expect(201)).body;
      expect(steered.steeredIntoRunId).toBe(chat.runId);
      steerId = steered.id;
      if (opts.readIngestedAtPress !== false) await readNotAnswered(chat, steered.id);
      else {
        // The take: at the press only the acknowledgement is ingested; the ordered ingestion is still open.
        await runLog(chat, [
          { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
          { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-1" },
          { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${steered.id}` },
        ]);
        await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
          || '{"nativeSteeringIngestion":{"state":"open"}}'::jsonb` }).where(eq(heartbeatRuns.id, chat.runId));
      }
    }
    const queued = opts.queued ? await send(chat, ["Q1: then this", "Q2: and this"]) : [];
    mocks.cancel.mockImplementationOnce(async (runId: string) => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson ?? {}), nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: chat.companyId, issueId: chat.issue.id,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } } }).where(eq(heartbeatRuns.id, runId));
      return { decision: { stopped: true }, auditId: randomUUID() };
    });
    const msg = (await postDefault(chat, "MSG: stop, do this instead", { deliveryIntent: "interrupt" }).expect(201)).body;
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(cut!.status).toBe("cancelled");
    if (steerId && opts.readIngestedAtPress === false) await runLog(chat, [ // the READ lands after the press
      { eventType: "item.completed", kind: "commandExecution", itemId: "turn-1:tool-1" },
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:steered" },
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-2" },
    ]);
    // The cut run's release (run end), then the take's +65 s: the stranded sweep's conversation outbox
    // (recovery/service.ts reconcileStrandedAssignedIssues -> deliverConversationComments), twice.
    await releaseRun(chat);
    if (opts.admitCarryFirst) {
      // B' bounds (30 s unproven, 60 s receipt) at their best: the carry is admitted BEFORE the +65 s sweep.
      const [carry] = await carryWakes(chat);
      if (carry && !carry.runId && ["deferred_issue_execution", "queued"].includes(carry.status)) {
        const [run] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId, status: "running",
          runtimeMode: "native", startedAt: new Date(), wakeupRequestId: carry.id,
          contextSnapshot: (carry.payload as any)._paperclipWakeContext }).returning();
        await db.update(agentWakeupRequests).set({ status: "completed", runId: run!.id, claimedAt: new Date(), finishedAt: new Date() })
          .where(eq(agentWakeupRequests.id, carry.id));
      }
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
    for (let i = 0; i < 2; i++) await deliverConversationComments(db, issue!, heartbeatService(db).wakeup);
    return { steerId, queued: queued.map(m => m.id), msgId: msg.id as string, cut: cut! };
  }

  /** Every carrier after the cut (pending wakes, and runs other than the cut run), for each id; a run the
   * carry wake started is named by that wake ("carry"), so ONE successor reads ["carry"]. */
  async function carryRunIds(carryId: string) {
    const dispatched = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(sql`${agentWakeupRequests.id} = ${carryId}
      or ${agentWakeupRequests.idempotencyKey} = ${`queued-comment-interrupt:${carryId}`}`);
    return new Set(dispatched.map(w => w.id));
  }
  async function carriersAfterCut(chat: Chat, ids: string[], carryId: string) {
    const carry = await carryRunIds(carryId);
    return Object.fromEntries(await Promise.all(ids.map(async id => {
      const c = await carriersOf(chat, id);
      return [id, c.wakes.map(w => w.id === carryId ? "carry" : `wake:${w.id}`)
        .concat(c.runs.map(r => r.wakeupRequestId && carry.has(r.wakeupRequestId) ? "carry" : `run:${r.id}`))] as const;
    })));
  }

  it("(i) the take's exact shape: ONE carry holds [WORK, STEER, Q1, Q2, MSG] once each, in order; no second wake for STEER", async () => {
    const chat = await seedChat();
    const { steerId, queued, msgId, cut } = await paulsFourSteps(chat, { steer: true, queued: true, readIngestedAtPress: false });
    // The take's DB facts on the cut run.
    expect((cut.resultJson as any).interruptCarriedSteeredCommentIds).toEqual([steerId]);
    expect((cut.resultJson as any).queuedSteeringAcknowledgements[steerId!].status).toBe("acknowledged");
    const carries = await carryWakes(chat);
    expect(carries).toHaveLength(1);
    const order = [chat.first.id, steerId!, ...queued, msgId];
    expect(wakeCommentIds(carries[0]!)).toEqual(order);
    // ONE successor: every message has exactly one carrier after the cut, and it is the carry.
    const carriers = await carriersAfterCut(chat, order, carries[0]!.id);
    for (const id of order) expect(carriers[id], `carriers of ${id}`).toEqual(["carry"]);
    const carry = await carryRunIds(carries[0]!.id);
    const successors = [...(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, chat.companyId),
      sql`${agentWakeupRequests.status} in ('deferred_issue_execution', 'queued')`, sql`${agentWakeupRequests.runId} is null`)))
      .map(w => w.id === carries[0]!.id ? "carry" : `wake:${w.id}`),
      ...(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, chat.companyId),
        sql`${heartbeatRuns.id} <> ${chat.runId}`))).map(r => r.wakeupRequestId && carry.has(r.wakeupRequestId) ? "carry" : `run:${r.id}`)];
    expect(successors, "no second successor").toEqual(["carry"]);
    // 41b2b1e4: nothing else may make a wake for STEER (the outbox's conversation-comment receipt).
    expect((await commentWakes(chat, steerId!)).map(w => ({ id: w.id, status: w.status, reason: w.reason })),
      "a second wake for the Interrupt-carried STEER (41b2b1e4)").toEqual([]);
    expect((await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).map(c => c.id)).not.toContain(steerId);
  });

  it("(iv) +65 s under B' bounds: the carry admitted FIRST, the later sweep still makes no second wake for STEER", async () => {
    const chat = await seedChat();
    const { steerId } = await paulsFourSteps(chat, { steer: true, queued: true, readIngestedAtPress: false, admitCarryFirst: true });
    const [carry] = await carryWakes(chat);
    expect(carry!.runId, "the carry is admitted before the sweep").toBeTruthy();
    expect((await commentWakes(chat, steerId!)).map(w => w.status), "41b2b1e4 after the carry was admitted").toEqual([]);
    expect((await carriersAfterCut(chat, [steerId!], carry!.id))[steerId!]).toEqual(["carry"]);
  });

  it("(ii) a READ-but-unanswered steer + Interrupt with nothing queued: carried once", async () => {
    const chat = await seedChat();
    const { steerId, msgId } = await paulsFourSteps(chat, { steer: true, queued: false });
    const carries = await carryWakes(chat);
    expect(carries).toHaveLength(1);
    expect(wakeCommentIds(carries[0]!)).toEqual([chat.first.id, steerId!, msgId]);
    expect(await commentWakes(chat, steerId!)).toEqual([]);
    const carriers = await carriersAfterCut(chat, [steerId!], carries[0]!.id);
    expect(carriers[steerId!]).toEqual(["carry"]);
  });

  it("(iii) control: an Interrupt with no steer is unchanged (one carry, each message once)", async () => {
    const chat = await seedChat();
    const { queued, msgId, cut } = await paulsFourSteps(chat, { steer: false, queued: true });
    expect((cut.resultJson as any).interruptCarriedSteeredCommentIds).toBeUndefined();
    const carries = await carryWakes(chat);
    expect(carries).toHaveLength(1);
    const order = [chat.first.id, ...queued, msgId];
    expect(wakeCommentIds(carries[0]!)).toEqual(order);
    const carriers = await carriersAfterCut(chat, order, carries[0]!.id);
    for (const id of order) expect(carriers[id]).toEqual(["carry"]);
  });

  it("(b) dispatch re-filter: a comment wake for an Interrupt-carried or answered message arriving at admission completes as coalesced", async () => {
    const chat = await seedChat();
    const { steerId } = await paulsFourSteps(chat, { steer: true, queued: true, readIngestedAtPress: false });
    const [carry] = await carryWakes(chat);
    // The take's 41b2b1e4 request, exactly: user/on_demand issue_commented, commentId = STEER alone.
    const wake = { source: "on_demand" as const, triggerDetail: "manual" as const, reason: "issue_commented",
      idempotencyKey: `conversation-comment:${steerId}`, requestedByActorType: "user" as const, requestedByActorId: owner,
      payload: { issueId: chat.issue.id, commentId: steerId },
      contextSnapshot: { issueId: chat.issue.id, taskKey: chat.issue.id, commentId: steerId, wakeCommentId: steerId,
        wakeCommentIds: [steerId], source: "issue.comment" } };
    expect(await heartbeatService(db).wakeup(chat.agentId, wake)).toBeNull();
    const second = await commentWakes(chat, steerId!);
    expect(second.map(w => [w.status, w.error])).toEqual([["coalesced", "Sent with the chat's other queued messages"]]);
    expect((await carriersAfterCut(chat, [steerId!], carry!.id))[steerId!], "STEER re-carried").toEqual(["carry"]);
    // An ANSWERED message (the ONE answeredPersonMessageIds) that no wake holds is not carried again either.
    const earlier = await issueService(db).addComment(chat.issue.id, "an earlier message, answered", { userId: owner });
    const [done] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId, status: "succeeded",
      startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: chat.issue.id, wakeCommentIds: [earlier.id] } }).returning();
    await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent",
      authorAgentId: chat.agentId, createdByRunId: done!.id, body: "answered it" });
    const first = earlier.id;
    expect(await heartbeatService(db).wakeup(chat.agentId, { ...wake, idempotencyKey: `conversation-comment:${first}`,
      payload: { issueId: chat.issue.id, commentId: first }, contextSnapshot: { ...wake.contextSnapshot, commentId: first,
        wakeCommentId: first, wakeCommentIds: [first] } })).toBeNull();
    expect((await commentWakes(chat, first)).filter(w => w.status !== "coalesced")).toEqual([]);
  });

  // ---- adopt-held-status (guard (a), commentCarriedSql's 'held' arm): only a wake that still owns or delivered a
  // message holds it. A wake the pause CANCELLED names M in wakeCommentIds forever; it must not mark M as sent. ----

  /** Every wake that delivers or will deliver `id` (cancelled, failed and skipped wakes deliver nothing). */
  async function deliveriesOf(chat: Chat, id: string) {
    return (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, chat.companyId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${chat.issue.id}`,
      sql`${agentWakeupRequests.status} not in ('cancelled', 'failed', 'skipped', 'coalesced')`)))
      .filter(wake => wakeCommentIds(wake).includes(id));
  }
  async function wakeDump(chat: Chat) {
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, chat.companyId))
      .orderBy(asc(agentWakeupRequests.requestedAt))).map(w => ({ key: w.idempotencyKey, status: w.status, reason: w.reason,
      runId: w.runId, ids: wakeCommentIds(w), queued: (w.payload as any).queuedCommentIds }));
  }

  /** The real pause and resume: the lifecycle commands, and the real host driver's pause Stop sweep and onReady. */
  function lifecycle() {
    const worker = configureAgentLifecycle(db, { ...createLifecycleDriver(db, {} as never),
      requiredPluginIds: async () => [], runPlugin: async () => "complete" });
    const commands = createAgentLifecycle(db);
    return {
      pause: async (agentId: string) => {
        // The provider acknowledges the native Stop (as the Interrupt rows' cancel does).
        mocks.cancel.mockImplementation(async (runId: string) => {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson ?? {}), nativeCancellation: {
            schema: "paperclip.native-cancellation.v1", runId, companyId: run!.companyId, issueId: (run!.contextSnapshot as any).issueId,
            scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
            intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } }).where(eq(heartbeatRuns.id, runId));
          return { decision: { stopped: true }, auditId: randomUUID() };
        });
        await commands.pauseAgent(agentId); await worker.process(agentId);
        await heartbeatService(db).cancelActiveForAgent(agentId); },
      resume: async (agentId: string) => { await commands.resumeAgent(agentId); await worker.process(agentId); },
      stop: () => worker.stop(),
    };
  }

  it("(held-1) queue M, the agent is paused (its wake cancelled), resume: M is delivered once", async () => {
    const chat = await seedChat();
    const [m] = await send(chat, ["M: queued while you work"]);
    const life = lifecycle();
    try {
      await life.pause(chat.agentId);
      expect((await db.select().from(agents).where(eq(agents.id, chat.agentId)))[0]!.status).toBe("paused");
      expect(await deliveriesOf(chat, m!.id), "the pause cancelled M's wake").toEqual([]);
      await life.resume(chat.agentId);
      const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
      // The outbox after the resume (the run end / the stranded sweep), twice.
      for (let i = 0; i < 2; i++) await deliverConversationComments(db, issue!, heartbeatService(db).wakeup);
      expect(await deliveriesOf(chat, m!.id), `M delivered once after the resume: ${JSON.stringify(await wakeDump(chat))}`)
        .toHaveLength(1);
    } finally { await life.stop(); }
  });

  it("(held-2) control: M in a live deferred wake is not re-sent", async () => {
    const chat = await seedChat();
    const [m] = await send(chat, ["M: queued while you work"]);
    const held = await deliveriesOf(chat, m!.id);
    expect(held.map(w => w.status)).toEqual(["deferred_issue_execution"]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
    for (let i = 0; i < 2; i++) await deliverConversationComments(db, issue!, heartbeatService(db).wakeup);
    expect((await deliveriesOf(chat, m!.id)).map(w => w.id), "M re-sent while a live wake holds it").toEqual(held.map(w => w.id));
    expect((await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).map(c => c.id)).not.toContain(m!.id);
  });

  // ---- adopt-held-floor3: ONE floor (person-message-answer.ts personMessageOwedSql) for the outbox AND the
  // per-message sweep. SMA-4 11-19 13:53:36Z: 16 s after boot, wakes (issue_commented, issue_execution_promoted,
  // conversation-comment:<11-17 ids>) for 3 messages answered on 11-17 by later turns; and 12:52:01Z the sweep's
  // "Your message wasn't answered. Sending it again is safe" card with no new message. ----

  /** An ACTIVE chat the stranded sweep visits (in_review, agent idle, not paused); enableAgentChat is ON (beforeAll). */
  async function seedQuietChat() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Old chat", issuePrefix: `OC${Math.floor(Math.random() * 1e6)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "operator" });
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: owner, membershipRole: "operator", grantedByUserId: null });
    const issue = await issueService(db).create(companyId, { title: "Conversation", conversationAgentId: agentId,
      conversationUserId: owner, assigneeAgentId: agentId, status: "in_review", conversationState: "waiting" });
    return { companyId, agentId, issue };
  }
  type QuietChat = Awaited<ReturnType<typeof seedQuietChat>>;
  const at = (base: number, s: number) => new Date(base + s * 1000);

  /** Older builds' history: person message M (saved through the outbox: clientRequestId), its ONLY wake and its
   * ONLY carrying run both `kind` (cancelled/failed); then the chat moved on: a later person message N, a run that
   * STARTED after M, carried N, SUCCEEDED and posted an agent reply in the thread. */
  async function oldExchange(chat: QuietChat, base: number, kind: "cancelled" | "failed") {
    const person = async (body: string, t: Date) => (await db.insert(issueComments).values({ companyId: chat.companyId,
      issueId: chat.issue.id, authorType: "user", authorUserId: owner, clientRequestId: randomUUID(), body,
      createdAt: t, updatedAt: t }).returning())[0]!;
    const carry = async (id: string, status: string, started: Date) => {
      const context = { issueId: chat.issue.id, taskKey: chat.issue.id, wakeCommentId: id, commentId: id, wakeCommentIds: [id] };
      const [run] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId, status,
        runtimeMode: "native", createdAt: at(started.getTime(), -1), startedAt: started, finishedAt: at(started.getTime(), 20),
        contextSnapshot: context }).returning();
      await db.insert(agentWakeupRequests).values({ companyId: chat.companyId, agentId: chat.agentId, source: "on_demand",
        triggerDetail: "manual", reason: "issue_commented", status: status === "succeeded" ? "completed" : status,
        idempotencyKey: `conversation-comment:${id}`, runId: run!.id, requestedByActorType: "user", requestedByActorId: owner,
        payload: { issueId: chat.issue.id, commentId: id, _paperclipWakeContext: context },
        requestedAt: at(started.getTime(), -2), updatedAt: at(started.getTime(), 20) });
      return run!;
    };
    const m = await person(`M (${kind})`, at(base, 0));
    await carry(m.id, kind, at(base, 2));
    const n = await person("N: the next message", at(base, 60));
    const s = await carry(n.id, "succeeded", at(base, 62));
    await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent",
      authorAgentId: chat.agentId, createdByRunId: s.id, body: "Agent reply", createdAt: at(base, 80), updatedAt: at(base, 80) });
    return m.id;
  }

  /** Every wake for `ids` other than the seeded history's own, and every unanswered-message card naming them. */
  async function resent(chat: QuietChat, ids: string[], since: Date) {
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, chat.companyId)))
      .filter(w => w.requestedAt >= since && (ids.some(id => w.idempotencyKey === `conversation-comment:${id}`)
        || ids.some(id => wakeCommentIds(w).includes(id) || ((w.payload as any)?.queuedCommentIds ?? []).includes(id))));
    const cards = (await db.select().from(issueComments).where(eq(issueComments.companyId, chat.companyId)))
      .filter(c => ids.some(id => (c.metadata as any)?.authorizationReason === `${UNANSWERED_MESSAGE_REASON_PREFIX}${id}`));
    return { wakes: wakes.map(w => `${w.idempotencyKey}:${w.status}:${w.reason}`), cards: cards.map(c => c.body) };
  }

  /** The boot path: the REAL stranded sweep (heartbeat -> recovery reconcileStrandedAssignedIssues -> :5062
   * deliverConversationComments, then the per-message sweep settleUnansweredPersonMessages), over a 10-min clock. */
  async function bootSweeps(chat: QuietChat) {
    for (const ahead of [0, 5 * 60_000, 10 * 60_000]) {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: chat.companyId, issueId: chat.issue.id });
      await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id, now: new Date(Date.now() + ahead) });
    }
  }

  it("(floor-a) RED: an answered-past M (only wake cancelled, only carrier failed, a later succeeded run replied): no wake, no card", async () => {
    const chat = await seedQuietChat();
    const since = new Date();
    const m = await oldExchange(chat, Date.now() - 50 * 60_000, "failed");
    await db.update(agentWakeupRequests).set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${m}`));
    await bootSweeps(chat);
    expect(await resent(chat, [m], new Date(since.getTime() - 1)), "the stranded sweep re-sent or carded M").toEqual({ wakes: [], cards: [] });
    expect((await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).map(c => c.id)).not.toContain(m);
  });

  it("(floor-a') Paul's SMA-4 shape: 3 old messages (2 cancelled + 1 failed wake/run each), each moved past: zero wakes, zero cards (f)", async () => {
    const chat = await seedQuietChat();
    const since = new Date();
    const base = Date.now() - 55 * 60_000;
    const ids = [await oldExchange(chat, base, "cancelled"), await oldExchange(chat, base + 5 * 60_000, "cancelled"),
      await oldExchange(chat, base + 10 * 60_000, "failed")];
    await bootSweeps(chat);
    const after = await resent(chat, ids, new Date(since.getTime() - 1));
    expect(after.wakes, "(a') the 13:53 boot re-send").toEqual([]);
    expect(after.cards, "(f) the 12:52 false 'wasn't answered' card").toEqual([]);
    expect((await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).map(c => c.id)).toEqual([]);
  });

  it("(floor-f) the 12:52 B''a class: the per-message sweep alone (no outbox re-send) writes NO card for Paul's 3 old messages", async () => {
    const chat = await seedQuietChat();
    const since = new Date();
    const base = Date.now() - 55 * 60_000;
    const ids = [await oldExchange(chat, base, "cancelled"), await oldExchange(chat, base + 5 * 60_000, "cancelled"),
      await oldExchange(chat, base + 10 * 60_000, "failed")];
    for (const ahead of [0, 5 * 60_000, 10 * 60_000]) {
      await settleUnansweredPersonMessages(db, { companyId: chat.companyId, issueId: chat.issue.id, now: new Date(Date.now() + ahead) });
      await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id, now: new Date(Date.now() + ahead) });
    }
    expect((await resent(chat, ids, new Date(since.getTime() - 1))).cards, "the 12:52 false 'wasn't answered' card").toEqual([]);
  });

  it("(floor-c) neworg: M queued during T, T replies, a pause cancels M's wake, resume: M delivered once", async () => {
    const chat = await seedChat();
    const [m] = await send(chat, ["M: queued while you work"]);
    await finishTurn(chat); // T (started BEFORE M) replies and succeeds: run START, not reply time, decides
    const life = lifecycle();
    try {
      await life.pause(chat.agentId);
      await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(and(eq(agentWakeupRequests.companyId, chat.companyId),
        eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${m!.id}`)));
      expect(await deliveriesOf(chat, m!.id), "the pause cancelled M's wake").toEqual([]);
      await life.resume(chat.agentId);
      const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
      for (let i = 0; i < 2; i++) await deliverConversationComments(db, issue!, heartbeatService(db).wakeup);
      expect(await deliveriesOf(chat, m!.id), `M delivered once: ${JSON.stringify(await wakeDump(chat))}`).toHaveLength(1);
    } finally { await life.stop(); }
  });

  it("(floor-d) /new: a message before the chat's latest /new boundary is never re-sent; one after it is", async () => {
    const chat = await seedQuietChat();
    const person = async (body: string, t: Date) => (await db.insert(issueComments).values({ companyId: chat.companyId,
      issueId: chat.issue.id, authorType: "user", authorUserId: owner, clientRequestId: randomUUID(), body,
      createdAt: t, updatedAt: t }).returning())[0]!;
    const base = Date.now() - 30 * 60_000;
    const before = await person("before /new", at(base, 0));
    const reset = await person("/new", at(base, 10));
    const after = await person("after /new", at(base, 20));
    await db.update(issues).set({ conversationBoundaryCommentId: reset.id }).where(eq(issues.id, chat.issue.id));
    const owed = (await undeliveredConversationComments(db, chat.companyId, chat.issue.id)).map(c => c.id);
    expect(owed).not.toContain(before.id);
    expect(owed).toContain(after.id);
  });

  it("(floor-e) a NEW chat with nothing answered yet: its message is delivered as today", async () => {
    const chat = await seedQuietChat();
    const response = await request(app(chat.companyId)).post(`/api/issues/${chat.issue.id}/comments`)
      .send({ body: "Hello", clientRequestId: randomUUID(), deliveryIntent: "queue" }).expect(201);
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, chat.companyId)))
      .filter(w => w.idempotencyKey === `conversation-comment:${response.body.id}`);
    expect(wakes.map(w => w.status).filter(s => !["cancelled", "failed", "skipped"].includes(s))).toHaveLength(1);
  });

  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/b68b61e489a927995607617d2f983e57f32b47b8
  // rf-4 C1: real run-end restore and per-message sweep; no outbox/boot re-send in these rows.
  describe("C1 restored-steer notices (neworg-floor-c1)", () => {
    async function restoredSteerWithFailedCarrier() {
      const chat = await seedChat();
      await attachSteerable(chat);
      const m = (await postDefault(chat, "M: read this steer, then the turn ends without answering it").expect(201)).body;
      expect(m.steeredIntoRunId).toBe(chat.runId);
      await readNotAnswered(chat, m.id);
      await finishTurn(chat, { log: false, reply: false });
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
      expect((ended!.resultJson as any).restoredSteeredCommentIds).toEqual([m.id]);
      expect((ended!.contextSnapshot as any).steeredCommentIds).not.toContain(m.id);
      expect(await answered(m.id), "reading the steer was not an answer").toBe(false);
      const restored = await carriersOf(chat, m.id);
      expect(restored.wakes.length + restored.runs.length, "the restored steer has ONE carrier").toBe(1);
      // Admit the real restored wake without launching a provider: the boundary under test is
      // persisted recovery state, not provider execution. Its sole carrying turn R2 fails.
      const base = Date.now() - 50 * 60_000;
      await db.update(issueComments).set({ createdAt: at(base, -10), updatedAt: at(base, -10) })
        .where(eq(issueComments.id, chat.first.id));
      await db.update(issueComments).set({ createdAt: at(base, 10), updatedAt: at(base, 10) })
        .where(eq(issueComments.id, m.id));
      await db.update(heartbeatRuns).set({ createdAt: at(base, -1), startedAt: at(base, 0), finishedAt: at(base, 20) })
        .where(eq(heartbeatRuns.id, chat.runId));
      const carrier = restored.runs[0] ?? (await db.insert(heartbeatRuns).values({
        companyId: chat.companyId, agentId: chat.agentId, status: "running", runtimeMode: "native",
        wakeupRequestId: restored.wakes[0]!.id,
        contextSnapshot: (restored.wakes[0]!.payload as any)._paperclipWakeContext,
      }).returning())[0]!;
      expect((carrier.contextSnapshot as any).wakeCommentIds).toContain(m.id);
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed",
        createdAt: at(base, 29), startedAt: at(base, 30), finishedAt: at(base, 40), updatedAt: at(base, 40) })
        .where(eq(heartbeatRuns.id, carrier.id));
      await db.update(agentWakeupRequests).set({ status: "completed", runId: carrier.id,
        claimedAt: at(base, 30), finishedAt: at(base, 40), updatedAt: at(base, 40) })
        .where(and(eq(agentWakeupRequests.companyId, chat.companyId), sql`(${agentWakeupRequests.runId} = ${carrier.id}
          or ${agentWakeupRequests.id} = ${carrier.wakeupRequestId ?? restored.wakes[0]?.id ?? null}::uuid)`));
      const held = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, chat.companyId)))
        .filter(w => ["queued", "deferred_issue_execution", "claimed"].includes(w.status)
          && (w.idempotencyKey === `conversation-comment:${m.id}` || wakeCommentIds(w).includes(m.id)));
      expect(held, "a terminal carrier must leave no live wake holding M").toEqual([]);
      return { chat, m, carrier, base };
    }

    async function cardsFor(chat: Chat, id: string) {
      return db.select().from(issueComments).where(and(eq(issueComments.companyId, chat.companyId),
        eq(issueComments.issueId, chat.issue.id), eq(issueComments.authorType, "system"),
        sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + id}`));
    }

    async function perMessageSweeps(chat: Chat) {
      for (const ahead of [0, 5 * 60_000, 10 * 60_000]) {
        const input = { companyId: chat.companyId, issueId: chat.issue.id, now: new Date(Date.now() + ahead) };
        await settleUnansweredPersonMessages(db, input);
        await settleUnansweredPersonMessage(db, input);
      }
    }

    it("(c1-old) RED: restored M's carrier R2 fails, then later R3 succeeds with a reply: NO card for M", async () => {
      const { chat, m, carrier, base } = await restoredSteerWithFailedCarrier();
      const [n] = await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id,
        authorType: "user", authorUserId: owner, clientRequestId: randomUUID(), body: "N: the chat has moved on",
        createdAt: at(base, 50), updatedAt: at(base, 50) }).returning();
      const [r3] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId,
        status: "succeeded", runtimeMode: "native", createdAt: at(base, 59), startedAt: at(base, 60), finishedAt: at(base, 80),
        contextSnapshot: { issueId: chat.issue.id, taskKey: chat.issue.id, wakeCommentId: n!.id, wakeCommentIds: [n!.id] },
      }).returning();
      await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent",
        authorAgentId: chat.agentId, createdByRunId: r3!.id, body: "Agent reply to N", createdAt: at(base, 80), updatedAt: at(base, 80) });
      expect(r3!.startedAt!.getTime()).toBeGreaterThan(at(base, 30).getTime());
      expect(await answered(m.id), "M was not directly answered; only the owed floor may skip its notice").toBe(false);
      await perMessageSweeps(chat);
      const cards = await cardsFor(chat, m.id);
      console.info("C1-EVIDENCE", JSON.stringify({ row: "c1-old", messageId: m.id, restorer: chat.runId,
        failedCarrier: carrier.id, laterReplyRun: r3!.id, cards: cards.map(c => ({ id: c.id, body: c.body })) }));
      expect(cards, "the carried-steer sweep carded M after the chat moved on").toHaveLength(0);
    });

    it("(c1-live) restored M's carrier R2 fails, no later run: exactly ONE carried-steer card for M", async () => {
      const { chat, m, carrier } = await restoredSteerWithFailedCarrier();
      await perMessageSweeps(chat);
      const cards = await cardsFor(chat, m.id);
      console.info("C1-EVIDENCE", JSON.stringify({ row: "c1-live", messageId: m.id, restorer: chat.runId,
        failedCarrier: carrier.id, cards: cards.map(c => ({ id: c.id, body: c.body })) }));
      expect(cards, "repeated singular and batched sweeps must not duplicate M's note").toHaveLength(1);
      expect(cards[0]!.deletedAt).toBeNull();
      expect(cards[0]!.body).toBe("Your message (received mid-task) wasn't answered because the run failed. Sending it again is safe.");
    });
  });
});
