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
  completionContracts,
  nativeRunResults,
  nativeRunFinalizations,
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
import { answeredPersonMessageIds, answeredPersonMessageSql, personMessageOwedSql } from "../services/person-message-answer.js";
import { readContinuationCommentInput } from "../services/continuation-comment-input.js";
import { recordSteeredMessageEvidence } from "../services/native-runtime/steered-message-answers.js";
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

  it("(c) a shared-question answer's continuation wake is new input: admitted even though its source message is answered", async () => {
    // agent-chat-projects.spec.ts:508: Paul's message -> the agent's reply ASKS a question (so the message is
    // answered) -> Paul submits answers -> question-response-delivery wakes with wakeCommentIds = [that message].
    const chat = await seedChat();
    const asked = await issueService(db).addComment(chat.issue.id, "which project?", { userId: owner });
    const [done] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId, status: "succeeded",
      startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: chat.issue.id, wakeCommentIds: [asked.id] } }).returning();
    await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent",
      authorAgentId: chat.agentId, createdByRunId: done!.id, body: "Pick a project" });
    const interactionId = randomUUID();
    const key = `question-response:${interactionId}`;
    const run = await heartbeatService(db).wakeup(chat.agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_commented", idempotencyKey: key, requestedByActorType: "user", requestedByActorId: owner,
      payload: { issueId: chat.issue.id, interactionId, interactionKind: "ask_user_questions", interactionStatus: "answered",
        sourceCommentId: asked.id, wakeCommentId: asked.id, wakeCommentIds: [asked.id], mutation: "interaction" },
      contextSnapshot: { issueId: chat.issue.id, taskId: chat.issue.id, interactionId, interactionKind: "ask_user_questions",
        interactionStatus: "answered", mutation: "interaction", sourceCommentId: asked.id, wakeCommentId: asked.id,
        wakeCommentIds: [asked.id], wakeReason: "issue_commented", source: "issue.interaction.respond" } });
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, chat.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    // Admitted: ONE wake row that is not coalesced/skipped (it runs now, or defers behind a live turn).
    expect(wakes.map(w => [w.status, w.error]), "the answer's continuation was coalesced away").toHaveLength(1);
    expect(["coalesced", "skipped", "failed"]).not.toContain(wakes[0]!.status);
    expect(run !== null || wakes[0]!.status === "deferred_issue_execution", `wake ${wakes[0]!.status} has no run`).toBe(true);
  });
});

// RFL 19:05Z: the floor uses claimed PERSON input, not a later run's start clock.
// Persist the stopped/failed/revived history; exercise the actual per-message
// sweep (discovery + settle) and continuation reader, never a copied predicate.
describeEmbeddedPostgres("person-message floor after Stop (RFL 19:05Z)", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const person = "floor-person";
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("person-message-floor-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(start = Date.now() - 30 * 60_000) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const receiptIds: string[] = [];
    const at = (minute: number) => new Date(start + minute * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Person floor", issuePrefix: `FP${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Work saved before Stop", status: "in_progress",
      assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: person, conversationState: "active",
      createdAt: at(0), updatedAt: at(0) });
    const message = async (body: string, minute: number) => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: person,
        body, clientRequestId: randomUUID(), origin: "comment", createdAt: at(minute), updatedAt: at(minute) }).returning();
      return row!;
    };
    const run = async (status: "cancelled" | "failed" | "succeeded" | "timed_out", minute: number, ids: string[] = [],
      context: Record<string, unknown> = {}, resultJson: Record<string, unknown> = {}) => {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId,
        runtimeMode: "native", status, createdAt: at(minute), updatedAt: at(minute + 0.5),
        startedAt: at(minute), finishedAt: at(minute + 0.5),
        errorCode: status === "failed" ? "adapter_failed" : status === "cancelled" ? "cancelled" : null,
        contextSnapshot: { issueId, taskKey: issueId, ...(ids.length ? { wakeCommentId: ids.at(-1), commentId: ids.at(-1), wakeCommentIds: ids } : {}), ...context },
        resultJson }).returning();
      return row!;
    };
    const reply = async (runId: string, minute: number, body = "Continued the saved work.") => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId,
        createdByRunId: runId, body, createdAt: at(minute), updatedAt: at(minute) }).returning();
      return row!;
    };
    const claimedReceipt = async (messageId: string, runId: string, minute: number) => {
      const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand",
        status: "completed", reason: "issue_commented", runId, requestedAt: at(minute), claimedAt: at(minute + 0.1),
        finishedAt: at(minute + 0.5), idempotencyKey: `conversation-comment:${messageId}`,
        payload: { issueId, commentId: messageId, _paperclipWakeContext: { issueId, wakeCommentIds: [messageId] } } }).returning();
      receiptIds.push(receipt!.id);
      await db.update(heartbeatRuns).set({ wakeupRequestId: receipt!.id }).where(eq(heartbeatRuns.id, runId));
    };
    const sweep = () => settleUnansweredPersonMessages(db, { companyId, issueId, now: at(60) });
    const cards = () => db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"),
      sql`starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})`));
    const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const owed = async (id: string) => {
      const rows = await db.execute(sql`select ${personMessageOwedSql({ id: sql`m.id`, companyId: sql`m.company_id`,
        issueId: sql`m.issue_id`, createdAt: sql`m.created_at` })} as owed from issue_comments m where m.id = ${id}::uuid`);
      return (rows as unknown as Array<{ owed: boolean }>)[0]!.owed;
    };
    return { companyId, agentId, issueId, at, message, run, reply, claimedReceipt, receiptIds, sweep, cards, wakes, runs, owed };
  }
  type FloorFixture = Awaited<ReturnType<typeof fixture>>;
  const evidence = (label: string, value: unknown) => console.log(`FLOOR_ROW ${label} ${JSON.stringify(value)}`);

  async function stoppedThenFailed() {
    const f = await fixture();
    const stop = await f.run("cancelled", 1, [], {}, { cancelledByActorType: "user", cancelledByUserId: person });
    const m = await f.message("9 + 10?", 2);
    const first = await f.run("failed", 3, [m.id]);
    await f.claimedReceipt(m.id, first.id, 3);
    const second = await f.run("failed", 4, [m.id]);
    return { ...f, stop, m, first, second };
  }
  async function revivedOldWork() {
    const f = await stoppedThenFailed();
    // The recovery continuation resumes OLD work, not either failed question
    // carrier. No direct/receipt/continuation input edge claims M or a newer N.
    const revived = await f.run("succeeded", 6, [], { wakeReason: "issue_continuation_needed", previousRunId: f.stop.id });
    await f.reply(revived.id, 7);
    return { ...f, revived };
  }
  async function answeredNewerPerson() {
    const f = await stoppedThenFailed();
    // Paul's 11-17 shape includes both a cancelled and a failed carrier.
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled" }).where(eq(heartbeatRuns.id, f.first.id));
    const n = await f.message("Next question, please", 5);
    const later = await f.run("succeeded", 6, [n.id]);
    await f.reply(later.id, 7, "Answer to the next question.");
    return { ...f, n, later };
  }
  async function noResend(f: FloorFixture, before: string[]) {
    expect((await f.runs()).map(r => r.id).sort(), "the sweep never starts another run").toEqual(before.sort());
    expect((await f.wakes()).map(w => w.id).sort(), "the sweep creates no new wake").toEqual([...f.receiptIds].sort());
    expect(await undeliveredConversationComments(db, f.companyId, f.issueId), "the real crash-window outbox never re-sends claimed input").toEqual([]);
  }

  it("fp-888: two failed question carriers, then old work succeeds without claiming person input: ONE named note, no resend, idempotent", async () => {
    const f = await revivedOldWork();
    const before = (await f.runs()).map(r => r.id);
    const floor = await f.owed(f.m.id);
    const swept = await f.sweep(), cards = await f.cards();
    evidence("fp-888", { m: f.m.id, body: f.m.body, failed: [f.first.id, f.second.id], revived: f.revived.id,
      revivedInput: f.revived.contextSnapshot, floor, swept, cards });
    expect(cards, "the revived run did not answer 9 + 10").toHaveLength(1);
    expect(floor).toBe(true);
    expect(cards[0]!.deletedAt).toBeNull();
    expect(cards[0]!.metadata?.authorizationReason).toBe(`${UNANSWERED_MESSAGE_REASON_PREFIX}${f.m.id}`);
    expect(cards[0]!.body, "the true note names the saved question using the approved naming words").toContain('Your message is saved: “9 + 10?”.');
    await f.sweep();
    expect((await f.cards()).map(c => c.id), "one note ever, not merely one live note").toEqual([cards[0]!.id]);
    await noResend(f, before);
  });

  it("fp-1117: cancelled/failed M, then a succeeded replying run CLAIMS newer N: zero cards or wakes for M", async () => {
    const f = await answeredNewerPerson();
    const before = (await f.runs()).map(r => r.id);
    const floor = await f.owed(f.m.id), swept = await f.sweep();
    evidence("fp-1117", { m: f.m.id, n: f.n.id, claimed: f.later.contextSnapshot, floor, swept, cards: await f.cards() });
    expect(floor).toBe(false);
    expect(await f.cards()).toEqual([]);
    await f.sweep();
    await noResend(f, before);
  });

  it("fp-1252: G1 re-pin, older failed M and newer claimed+answered N still leave no stray card", async () => {
    const f = await answeredNewerPerson();
    // G1's failed (not merely cancelled) predecessor cannot be treated as an
    // agent answer, but a genuinely claimed newer input moves the floor on.
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, f.first.id));
    const before = (await f.runs()).map(r => r.id);
    await f.sweep(); await f.sweep();
    evidence("fp-1252", { m: f.m.id, n: f.n.id, floor: await f.owed(f.m.id), cards: await f.cards() });
    expect(await f.cards()).toEqual([]);
    await noResend(f, before);
  });

  it("fp-stop: Stop-held README survives 9 + 10's answer, then a later README carrier answers once without a card", async () => {
    const f = await fixture();
    const readme = await f.message("Read the README", 0.5);
    await f.run("failed", 0.7, [readme.id]);
    const stop = await f.run("cancelled", 1, [], {}, { cancelledByActorType: "user", cancelledByUserId: person });
    const m = await f.message("9 + 10?", 2);
    const answer = await f.run("succeeded", 3, [m.id]);
    await f.reply(answer.id, 4, "19");
    const [held] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", status: "deferred_issue_execution", reason: "issue_commented", requestedAt: f.at(0.6),
      idempotencyKey: `conversation-comment:${readme.id}`, payload: { issueId: f.issueId, commentId: readme.id,
        personStopHold: { runId: stop.id }, _paperclipWakeContext: { issueId: f.issueId, wakeCommentIds: [readme.id] } } }).returning();
    expect(await f.owed(readme.id), "person Stop custody is not stale after the newer answer").toBe(true);
    await f.sweep();
    expect(await f.cards()).toEqual([]);
    // Claim the surviving receipt; the later-carrier clause preserves README
    // even after custody ends and before that run publishes its answer.
    const carrier = await f.run("succeeded", 6, [readme.id]);
    await db.update(heartbeatRuns).set({ wakeupRequestId: held!.id }).where(eq(heartbeatRuns.id, carrier.id));
    await db.update(agentWakeupRequests).set({ status: "completed", runId: carrier.id, claimedAt: f.at(6), finishedAt: f.at(6.5) })
      .where(eq(agentWakeupRequests.id, held!.id));
    expect(await f.owed(readme.id), "the later carrier still owns README").toBe(true);
    await f.reply(carrier.id, 7, "The README describes setup.");
    await f.sweep(); await f.sweep();
    const replies = await db.select().from(issueComments).where(and(eq(issueComments.createdByRunId, carrier.id), eq(issueComments.authorType, "agent")));
    evidence("fp-stop", { readme: readme.id, carrier: carrier.id, replies: replies.map(r => r.body), cards: await f.cards(), wakes: await f.wakes() });
    expect(replies.map(r => r.body)).toEqual(["The README describes setup."]);
    expect(await f.owed(readme.id)).toBe(false);
    expect(await f.cards()).toEqual([]);
    expect((await f.wakes()).map(w => w.id)).toEqual([held!.id]);
  });

  it("fp-cr-888: the continuation reader still returns M after unrelated revived work replied", async () => {
    const f = await revivedOldWork();
    const pending = await readContinuationCommentInput(db, { ...f, runId: f.second.id });
    evidence("fp-cr-888", { m: f.m.id, pending });
    expect(pending).toMatchObject({ wakeCommentIds: [f.m.id], wakeCommentId: f.m.id, commentId: f.m.id });
    expect((await f.wakes()).map(w => w.id), "reading pending input does not auto-send it").toEqual(f.receiptIds);
  });

  it("fp-progress: newer steered N got only a progress note, not an answer: old failed X stays owed with ONE card", async () => {
    const f = await fixture();
    const x = await f.message("Old held X", 1);
    const failed = await f.run("failed", 2, [x.id]);
    await f.claimedReceipt(x.id, failed.id, 2);
    const n = await f.message("Newer N, steered mid-task", 4);
    const progress = await f.run("succeeded", 3, [n.id], { steeredCommentIds: [n.id] });
    await db.update(heartbeatRuns).set({ finishedAt: f.at(5.5), updatedAt: f.at(5.5) }).where(eq(heartbeatRuns.id, progress.id));
    // A progress note without the streamed answer receipt is not an answer
    // to the steer (THE answered function's requireSteeredText guard).
    await f.reply(progress.id, 5, "Still working on the saved task.");
    const answered = await answeredPersonMessageIds(db, { ...f, commentIds: [x.id, n.id] });
    expect([...answered]).toEqual([]);
    const before = (await f.runs()).map(r => r.id);
    const floor = await f.owed(x.id), swept = await f.sweep(), cards = await f.cards();
    const forX = cards.filter(c => c.metadata?.authorizationReason === `${UNANSWERED_MESSAGE_REASON_PREFIX}${x.id}`);
    evidence("fp-progress", { x: x.id, n: n.id, answered: [...answered], floor, swept, forX, cards });
    expect(floor).toBe(true);
    expect(forX).toHaveLength(1);
    await f.sweep();
    expect((await f.cards()).filter(c => c.metadata?.authorizationReason === `${UNANSWERED_MESSAGE_REASON_PREFIX}${x.id}`)
      .map(c => c.id)).toEqual([forX[0]!.id]);
    await noResend(f, before);
  });

  it("fp-cr-1117: the continuation reader returns {} once a newer person input was claimed and answered", async () => {
    const f = await answeredNewerPerson();
    const pending = await readContinuationCommentInput(db, { ...f, runId: f.second.id });
    evidence("fp-cr-1117", { m: f.m.id, n: f.n.id, pending });
    expect(pending).toEqual({});
    expect((await f.wakes()).map(w => w.id)).toEqual(f.receiptIds);
  });

  describe("RULE-ANSWERED-MEANS-ANSWERED-1119", () => {
  it("F4: streamed progress materializes read/text evidence, publication withheld, terminal run owes ONE naming card", async () => {
    const f = await fixture();
    const m = await f.message("F4 saved README question", 1);
    const r = await f.run("succeeded", 2, [], { steeredCommentIds: [m.id] });
    await f.claimedReceipt(m.id, r.id, 2);
    const events = [
      { type: "item.started", itemId: "turn-f4:input", kind: "userMessage" },
      { type: "item.completed", itemId: `turn-f4:steer:${m.id}`, kind: "steering_acknowledgement" },
      { type: "item.started", itemId: "turn-f4:read", kind: "userMessage" },
      { type: "item.started", itemId: "turn-f4:progress", kind: "agentMessage" },
      { type: "item.completed", itemId: "turn-f4:progress", kind: "agentMessage", text: "I'm checking; I'll get back to you.", channel: "final" },
      { type: "turn.completed", itemId: "turn-f4:end", kind: "turn" },
    ];
    for (const [index, e] of events.entries()) await db.insert(heartbeatRunEvents).values({
      companyId: f.companyId, runId: r.id, agentId: f.agentId, seq: index + 1,
      eventType: e.type, sourceEventId: randomUUID(), createdAt: f.at(2 + index / 100),
      payload: { prpEvent: { type: e.type, turnId: "turn-f4", itemId: e.itemId,
        payload: { kind: e.kind, text: "text" in e ? e.text : undefined, channel: "channel" in e ? e.channel : undefined } } },
    });
    await recordSteeredMessageEvidence(db, { companyId: f.companyId, runId: r.id });
    const [materialized] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.id));
    expect(materialized!.contextSnapshot?.answeredSteeredCommentIds).toEqual([m.id]);
    const posted = await db.select().from(issueComments).where(and(eq(issueComments.createdByRunId, r.id), eq(issueComments.authorType, "agent")));
    expect(posted).toEqual([]);
    const answered = [...await answeredPersonMessageIds(db, { ...f, commentIds: [m.id] })];
    const owed = await f.owed(m.id), before = (await f.runs()).map(run => run.id);
    await f.sweep(); await f.sweep();
    const cards = (await f.cards()).filter(c => c.metadata?.authorizationReason === UNANSWERED_MESSAGE_REASON_PREFIX + m.id);
    evidence("F4-publication-withheld", { messageId: m.id, runId: r.id, materialized: materialized!.contextSnapshot,
      posted, answered, owed, cards });
    expect.soft(answered).toEqual([]);
    expect.soft(owed).toBe(true);
    expect.soft(cards).toHaveLength(1);
    if (cards[0]) expect.soft(cards[0].body).toContain(m.body);
    await noResend(f, before);
  });
  it("INSTALL three boots: seeded 3-day answered-to-owed history gets one note per owed PERSON, zero new runs", async () => {
    const f = await fixture(Date.now() - 3 * 24 * 60 * 60_000);
    const expected: { messageId: string; body: string; notes: number }[] = [];
    for (const [index, row] of [
      { status: "succeeded", progress: false, owed: false, label: "P3 real final" },
      { status: "failed", progress: true, owed: true, label: "P1 progress FAIL" },
      { status: "succeeded", progress: true, owed: true, label: "P2 progress SUCCEED" },
      { status: "failed", progress: false, owed: true, label: "failed partial" },
      { status: "timed_out", progress: false, owed: true, label: "timed out partial" },
      { status: "cancelled", progress: false, owed: true, label: "cancelled partial" },
    ].entries()) {
      const minute = index * 4 + 1;
      const m = await f.message(row.label + ": please answer my README question", minute);
      const r = await f.run(row.status as "succeeded" | "failed" | "timed_out" | "cancelled", minute + 1, [m.id]);
      await f.claimedReceipt(m.id, r.id, minute + 1);
      const a = await f.reply(r.id, minute + 2, row.progress ? "I'm checking, I'll get back to you." : "Saved answer text.");
      if (row.progress) await db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: {
        p: { operationId: "report_progress", result: { commentId: a.id } },
      } } }).where(eq(heartbeatRuns.id, r.id));
      expected.push({ messageId: m.id, body: m.body, notes: row.owed ? 1 : 0 });
    }
    const before = (await f.runs()).map(r => r.id).sort();
    console.log("AMMA-INSTALL-EXPECTED", JSON.stringify(expected));
    for (let boot = 0; boot < 3; boot++) {
      const bootDb = createDb(database.connectionString);
      try {
        const [issue] = await bootDb.select().from(issues).where(eq(issues.id, f.issueId));
        await deliverConversationComments(bootDb, issue!, heartbeatService(bootDb).wakeup);
        await deliverConversationComments(bootDb, issue!, heartbeatService(bootDb).wakeup);
        for (let pass = 0; pass < 2; pass++) await settleUnansweredPersonMessages(bootDb, { companyId: f.companyId, issueId: f.issueId });
      } finally { await bootDb.$client.end(); }
    }
    const cards = await f.cards();
    const actual = expected.map(m => ({ ...m, actualNotes: cards.filter(c => c.metadata?.authorizationReason === UNANSWERED_MESSAGE_REASON_PREFIX + m.messageId).length }));
    console.log("AMMA-INSTALL-ACTUAL", JSON.stringify({ actual, before, after: (await f.runs()).map(r => r.id).sort() }));
    for (const m of actual) expect.soft(m.actualNotes, m.body).toBe(m.notes);
    expect((await f.runs()).map(r => r.id).sort()).toEqual(before);
  });
  // D3 port: persisted PG rows for RFL 20:14Z (2), review-fleet-5 rf5-d3gap.
  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/97a09117
  it.each([
    { label: "d3-fail (P1)", status: "failed", progress: true, accepted: false, answered: false },
    { label: "d3-progress (P2)", status: "succeeded", progress: true, accepted: false, answered: false },
    { label: "d3-failed-reply", status: "failed", progress: false, accepted: false, answered: false },
    { label: "d3-timeout", status: "timed_out", progress: false, accepted: false, answered: false },
    { label: "d3-cancel", status: "cancelled", progress: false, accepted: false, answered: false },
    { label: "d3-accepted", status: "failed", progress: false, accepted: true, answered: true },
    { label: "d3-plain (P3)", status: "succeeded", progress: false, accepted: false, answered: true },
  ] as const)("$label: only a succeeded final reply or accepted publication answers M", async row => {
    const f = await fixture();
    const m = await f.message(`${row.label}: please answer my question`, 1);
    const r = await f.run(row.status, 2, [m.id]);
    await f.claimedReceipt(m.id, r.id, 2);
    const a = await f.reply(r.id, 3, row.progress ? "I'm still working on it." : "The answer is 19.");
    if (row.progress) await db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: {
      "progress-1": { operationId: "report_progress", result: { commentId: a.id } },
    } } }).where(eq(heartbeatRuns.id, r.id));
    if (row.accepted) await acceptedPublication(f, r.id, a.id);
    const answered = [...await answeredPersonMessageIds(db, { ...f, commentIds: [m.id] })];
    const owed = await f.owed(m.id);
    const pending = await readContinuationCommentInput(db, { ...f, runId: r.id });
    const before = (await f.runs()).map(run => run.id);
    await f.sweep(); await f.sweep();
    const cards = await f.cards();
    evidence(row.label, { messageId: m.id, runId: r.id, replyId: a.id, status: row.status,
      progress: row.progress, accepted: row.accepted, answered, owed, pending, cards });
    expect(answered).toEqual(row.answered ? [m.id] : []);
    expect(owed).toBe(!row.answered);
    if (row.answered) expect(pending).toEqual({});
    else expect(pending).toMatchObject({ wakeCommentIds: [m.id], wakeCommentId: m.id, commentId: m.id });
    expect(cards).toHaveLength(row.answered ? 0 : 1);
    if (!row.answered) expect(cards[0]!.metadata?.authorizationReason).toBe(`${UNANSWERED_MESSAGE_REASON_PREFIX}${m.id}`);
    await noResend(f, before);
  });

  async function acceptedPublication(f: FloorFixture, runId: string, commentId: string) {
    const contractId = randomUUID(), resultId = randomUUID(), canonicalSha256 = "a".repeat(64);
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "1", policyVersion: "d3", risk: "low", completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: "b".repeat(64),
      createdByActorType: "system", createdByActorId: "d3-row" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId,
      completionContractId: contractId, serverFingerprint: randomUUID(), schemaStatus: "accepted",
      resultJson: { response: "The answer is 19." }, canonicalSha256 });
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId,
      phase: "committed", resultId });
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentId },
      nativeCommittedChatResponse: { resultId, canonicalSha256 } } }).where(eq(heartbeatRuns.id, runId));
    return { resultId, canonicalSha256 };
  }

  it.each(["not-published", "not-accepted", "wrong-result", "wrong-hash", "different-finalization", "progress"] as const)(
    "d3-accepted-guard: %s is not the accepted result's published final answer", async shape => {
      const f = await fixture();
      const m = await f.message("An accepted result must actually be published", 1);
      const r = await f.run("failed", 2, [m.id]);
      const a = await f.reply(r.id, 3);
      const accepted = await acceptedPublication(f, r.id, a.id);
      const resultJson: Record<string, unknown> = { presentationDecision: { commentId: a.id },
        nativeCommittedChatResponse: accepted };
      if (shape === "not-published") resultJson.presentationDecision = { commentId: randomUUID() };
      if (shape === "wrong-result") resultJson.nativeCommittedChatResponse = { ...accepted, resultId: randomUUID() };
      if (shape === "wrong-hash") resultJson.nativeCommittedChatResponse = { ...accepted, canonicalSha256: "c".repeat(64) };
      if (shape === "progress") resultJson.semanticToolReceipts = { p: { operationId: "report_progress", result: { commentId: a.id } } };
      await db.update(heartbeatRuns).set({ resultJson }).where(eq(heartbeatRuns.id, r.id));
      if (shape === "not-accepted") await db.update(nativeRunResults).set({ schemaStatus: "rejected" })
        .where(eq(nativeRunResults.id, accepted.resultId));
      if (shape === "different-finalization") {
        const [original] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, accepted.resultId));
        const otherId = randomUUID();
        await db.insert(nativeRunResults).values({ ...original!, id: otherId, serverFingerprint: randomUUID() });
        await db.update(nativeRunFinalizations).set({ resultId: otherId }).where(eq(nativeRunFinalizations.runId, r.id));
      }
      const answered = [...await answeredPersonMessageIds(db, { ...f, commentIds: [m.id] })];
      evidence(`d3-accepted-guard-${shape}`, { messageId: m.id, runId: r.id, answered });
      expect(answered).toEqual([]);
      expect(await f.owed(m.id)).toBe(true);
    });

  it("d3-days-old: boot outbox + two sweeps never resurrect a two-day-old progress-only message after later answers", async () => {
    const f = await fixture(Date.now() - 2 * 24 * 60 * 60_000);
    const old = await f.message("Read the README from two days ago", 1);
    const progress = await f.run("succeeded", 2, [old.id]);
    await f.claimedReceipt(old.id, progress.id, 2);
    const note = await f.reply(progress.id, 3, "I'm reading it now.");
    await db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: {
      p: { operationId: "report_progress", result: { commentId: note.id } },
    } } }).where(eq(heartbeatRuns.id, progress.id));
    for (const [minute, question, answer] of [[24 * 60, "What is 9 + 10?", "19"], [25 * 60, "What is 2 + 2?", "4"]] as const) {
      const newer = await f.message(question, minute);
      const r = await f.run("succeeded", minute + 1, [newer.id]);
      await f.claimedReceipt(newer.id, r.id, minute + 1);
      await f.reply(r.id, minute + 2, answer);
    }
    const beforeRuns = (await f.runs()).map(r => r.id).sort();
    const beforeWakes = (await f.wakes()).map(w => w.id).sort();
    // New Db client over the saved history: the boot crash-window outbox and
    // per-message discovery/settle run against persisted state, not cached objects.
    const bootDb = createDb(database.connectionString);
    try {
      const [issue] = await bootDb.select().from(issues).where(eq(issues.id, f.issueId));
      await deliverConversationComments(bootDb, issue!, heartbeatService(bootDb).wakeup);
      for (let pass = 0; pass < 2; pass++) await settleUnansweredPersonMessages(bootDb, {
        companyId: f.companyId, issueId: f.issueId, now: new Date(),
      });
    } finally { await bootDb.$client.end(); }
    const cards = await f.cards(), runs = (await f.runs()).map(r => r.id).sort(), wakes = (await f.wakes()).map(w => w.id).sort();
    evidence("d3-days-old", { oldMessageId: old.id, createdAt: old.createdAt, simulatedBoot: new Date(),
      beforeRuns, runs, beforeWakes, wakes, cards });
    expect(runs, "NO new run at boot").toEqual(beforeRuns);
    expect(wakes, "NO new wake at boot").toEqual(beforeWakes);
    expect(cards.length, "at most ONE true note").toBeLessThanOrEqual(1);
    expect(await f.owed(old.id)).toBe(false);
    expect(await undeliveredConversationComments(db, f.companyId, f.issueId)).toEqual([]);
  });

  it.each([23, 25, 72])("HALF 2 boot: %sh owed input, outbox twice + two sweeps never starts a run after 24h", async hours => {
    const now = Date.now();
    const f = await fixture(now - hours * 60 * 60_000 - 60_000);
    const m = await f.message(`Read my saved ${hours}-hour-old README request`, 1);
    await db.update(issues).set({ status: "in_review", conversationState: "waiting" }).where(eq(issues.id, f.issueId));
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "process.stdout.write('done')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).where(eq(agents.id, f.agentId));
    const bootDb = createDb(database.connectionString), heartbeat = heartbeatService(bootDb);
    try {
      const [issue] = await bootDb.select().from(issues).where(eq(issues.id, f.issueId));
      console.log("HALF2-stage", hours, "before outbox", f.issueId);
      await deliverConversationComments(bootDb, issue!, heartbeat.wakeup);
      console.log("HALF2-stage", hours, "after outbox", (await f.runs()).map(r => ({ id: r.id, status: r.status, runtimeMode: r.runtimeMode })));
      await heartbeat.drainActiveRunExecutions();
      console.log("HALF2-stage", hours, "after drain");
      await waitForPendingRunFailureReports();
      await deliverConversationComments(bootDb, issue!, heartbeat.wakeup);
      await heartbeat.drainActiveRunExecutions();
      for (let pass = 0; pass < 2; pass++) await settleUnansweredPersonMessages(bootDb, {
        companyId: f.companyId, issueId: f.issueId, now: new Date(now + 5 * 60_000),
      });
      const runs = await f.runs(), wakes = await f.wakes(), cards = await f.cards();
      evidence(`HALF2-boot-${hours}h`, { messageId: m.id, body: m.body, createdAt: m.createdAt,
        runs: runs.map(r => ({ id: r.id, status: r.status, startedAt: r.startedAt })),
        wakes: wakes.map(w => ({ id: w.id, status: w.status, runId: w.runId })), cards });
      expect.soft(await f.owed(m.id), "unanswered input stays owed").toBe(true);
      expect.soft(runs, hours > 24 ? "NO run may start for an old person message" : "23h input is still inside the delivery window")
        .toHaveLength(hours > 24 ? 0 : 1);
      expect.soft(cards.length, "outbox + two sweeps writes at most ONE note").toBeLessThanOrEqual(1);
      if (hours === 72) {
        expect.soft(cards, "a three-day-old owed message gets ONE true naming note").toHaveLength(1);
        if (cards[0]) expect.soft(cards[0].body).toContain(m.body);
      }
    } finally {
      await drainHeartbeatRunsToQuiescence(bootDb, heartbeat);
      await waitForPendingRunFailureReports();
      await heartbeat.drainActiveRunExecutions();
      await bootDb.$client.end();
    }
  }, 60_000); // Includes the existing 30s owned-run drain; keep the three-phase row joined.
  });
});
