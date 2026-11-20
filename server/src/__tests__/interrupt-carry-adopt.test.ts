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
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
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
import { recordSteeredMessageEvidence } from "../services/native-runtime/steered-message-answers.js";
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

describeEmbeddedPostgres("Interrupt carry OWNS every unanswered steer (adopt-carry-adopt, neworg-lead 11:56Z)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const owner = "chat-owner";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-interrupt-carry-adopt-");
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
    testApp.use("/api", agentRoutes(db));
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

  // ---- adopt-carry-adopt rows (neworg-lead 11:56Z rule; RED FROM rf-3's shape) ----
  // The press goes through the real comment POST with deliveryIntent "interrupt" (Shift+Cmd+Enter with
  // text): routes/issues.ts -> interruptQueuedComments -> readUnreadSteeredForInterrupt (the ONE carry).

  const STEER = "STEER: also look at the logs";
  const MSG = "MSG: stop, do this instead";

  /** WORK running; STEER steered in by default Send with the given read state; then Interrupt with MSG. */
  async function steerThenInterrupt(chat: Chat, state: "read" | "unread" | "answered",
    opts: { staleWake?: "deferred_issue_execution" | "queued"; whileStopIsSlow?: (carry: typeof agentWakeupRequests.$inferSelect) => Promise<void> } = {}) {
    await attachSteerable(chat);
    const steered = (await postDefault(chat, STEER).expect(201)).body;
    expect(steered.steeredIntoRunId).toBe(chat.runId);
    const steerId = steered.id as string;
    if (state === "read") await readNotAnswered(chat, steerId);
    else if (state === "unread") await runLog(chat, [
      { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
      { eventType: "item.started", kind: "commandExecution", itemId: "turn-1:tool-1" },
      { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${steerId}` },
    ]);
    else {
      await runLog(chat, [
        { eventType: "item.started", kind: "userMessage", itemId: "turn-1:input" },
        { eventType: "item.completed", kind: "steering_acknowledgement", itemId: `turn-1:steer:${steerId}` },
        { eventType: "item.started", kind: "userMessage", itemId: "turn-1:steered" },
        { eventType: "item.started", kind: "agentMessage", itemId: "turn-1:reply", text: "" },
        { eventType: "item.completed", kind: "agentMessage", itemId: "turn-1:reply", text: "Answered STEER in text" },
      ]);
      // The event boundary's own materializer (ingestion calls it per event).
      await recordSteeredMessageEvidence(db, { companyId: chat.companyId, runId: chat.runId });
    }
    if (opts.staleWake) {
      // A leftover non-terminal outbox wake already names STEER (an earlier restore / outbox send).
      await db.insert(agentWakeupRequests).values({ companyId: chat.companyId, agentId: chat.agentId,
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: opts.staleWake,
        requestedByActorType: "user", requestedByActorId: owner, idempotencyKey: `conversation-comment:${steerId}`,
        payload: { issueId: chat.issue.id, commentId: steerId, _paperclipWakeContext: { issueId: chat.issue.id,
          taskKey: chat.issue.id, commentId: steerId, wakeCommentId: steerId, wakeCommentIds: [steerId], source: "issue.comment" } } });
    }
    let slow: Promise<void> | null = null;
    mocks.cancel.mockImplementationOnce(async (runId: string) => {
      // The slow idle close: the stop is confirmed (and the cut run released) only after
      // the ONE successor was admitted, answered and ended (rf-3's timeline).
      if (opts.whileStopIsSlow) await (slow = (async () => {
        let carry: typeof agentWakeupRequests.$inferSelect | undefined;
        for (let i = 0; i < 200 && !carry; i++) { [carry] = await carryWakes(chat); if (!carry) await new Promise(r => setTimeout(r, 10)); }
        await opts.whileStopIsSlow!(carry!);
      })());
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson ?? {}), nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: chat.companyId, issueId: chat.issue.id,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } } }).where(eq(heartbeatRuns.id, runId));
      return { decision: { stopped: true }, auditId: randomUUID() };
    });
    const msg = (await postDefault(chat, MSG, { deliveryIntent: "interrupt" }).expect(201)).body;
    await slow;
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(cut!.status).toBe("cancelled");
    const carries = await carryWakes(chat);
    expect(carries, "ONE carry").toHaveLength(1);
    return { steerId, msgId: msg.id as string, cut: cut!, carry: carries[0]! };
  }

  /** The carry is admitted as the ONE successor (the dispatcher's claim), with the carry's context. */
  async function admitSuccessor(chat: Chat, carry: typeof agentWakeupRequests.$inferSelect) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId, status: "running",
      runtimeMode: "native", startedAt: new Date(), wakeupRequestId: carry.id,
      contextSnapshot: (carry.payload as any)._paperclipWakeContext }).returning();
    await db.update(agentWakeupRequests).set({ status: "completed", runId: run!.id, claimedAt: new Date(), finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, carry.id));
    return run!;
  }

  /** The successor answers (its reply, through the session replay) and ends. */
  async function successorAnswers(chat: Chat, run: typeof heartbeatRuns.$inferSelect) {
    await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id, authorType: "agent",
      authorAgentId: chat.agentId, createdByRunId: run.id, body: "Successor reply to STEER and MSG" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
  }

  /** The successor's prompt, as the adapter renders it for a resumed (same) or a fresh Pi session. */
  async function successorPrompt(chat: Chat, run: typeof heartbeatRuns.$inferSelect, resumedSession: boolean) {
    const payload = await buildPaperclipWakePayload({ db, companyId: chat.companyId, agentId: chat.agentId,
      runId: run.id, contextSnapshot: { ...(run.contextSnapshot as Record<string, unknown>) } });
    return renderPaperclipWakePrompt(payload, { resumedSession });
  }

  /** +3 min: the stranded sweep's conversation outbox twice, then the unanswered sweep; nothing may wake on id again. */
  async function advanceThreeMinutes(chat: Chat) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, chat.issue.id));
    for (let i = 0; i < 2; i++) await deliverConversationComments(db, issue!, heartbeatService(db).wakeup);
    await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id,
      now: new Date(Date.now() + 3 * 60_000) });
  }
  const liveWakesNaming = async (chat: Chat, id: string) => (await carriersOf(chat, id)).wakes.map(w => `${w.idempotencyKey}:${w.status}`);

  it("R1 (rf-3 red): a READ-but-unanswered steer + Interrupt; the slow stop releases the cut run AFTER the successor answered ⇒ answered once, no deferred wake names it, no extra run in +3 min", async () => {
    const chat = await seedChat();
    let successor: typeof heartbeatRuns.$inferSelect | undefined;
    const { steerId, msgId, cut } = await steerThenInterrupt(chat, "read", { whileStopIsSlow: async (carry) => {
      successor = await admitSuccessor(chat, carry);
      await successorAnswers(chat, successor);
    } });
    void msgId;
    expect(successor, "the ONE successor ran while the stop was slow").toBeTruthy();
    expect(await answered(steerId), "the successor's reply answers STEER").toBe(true);
    // The run end's release (run-completion), again: idempotent, must not mint a wake either.
    await releaseRun(chat);
    expect(await liveWakesNaming(chat, steerId), "a stale conversation-comment wake for STEER (rf-3)").toEqual([]);
    await advanceThreeMinutes(chat);
    expect(await liveWakesNaming(chat, steerId), "a later promotion would answer STEER again").toEqual([]);
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, chat.companyId))).map(r => r.id);
    expect(runs.sort(), "no extra run after the ONE successor").toEqual([chat.runId, successor!.id].sort());
    // Ownership, by record: the carry adopted STEER at the press, so the release skipped it.
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, cut.id));
    expect((after!.resultJson as any).interruptCarriedSteeredCommentIds ?? [], "the carry OWNS the read steer").toContain(steerId);
    expect((after!.resultJson as any).restoredSteeredCommentIds ?? []).not.toContain(steerId);
  });

  it("R2: an UNREAD steer + Interrupt ⇒ the same (adopted, answered once, no wake, no extra run)", async () => {
    const chat = await seedChat();
    const { steerId, msgId, cut, carry } = await steerThenInterrupt(chat, "unread");
    expect((cut.resultJson as any).interruptCarriedSteeredCommentIds).toContain(steerId);
    expect((cut.resultJson as any).interruptCarriedReadSteeredCommentIds ?? []).not.toContain(steerId);
    expect(wakeCommentIds(carry)).toEqual([chat.first.id, steerId, msgId]);
    const successor = await admitSuccessor(chat, carry);
    // Unread: injected as explicit carried input on the same session too.
    expect(await successorPrompt(chat, successor, true)).toContain(STEER);
    await successorAnswers(chat, successor);
    await releaseRun(chat);
    expect(await answered(steerId)).toBe(true);
    await advanceThreeMinutes(chat);
    expect(await liveWakesNaming(chat, steerId)).toEqual([]);
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, chat.companyId))).map(r => r.id);
    expect(runs.sort()).toEqual([chat.runId, successor.id].sort());
  });

  it("R3: an ANSWERED steer + Interrupt ⇒ not carried", async () => {
    const chat = await seedChat();
    const { steerId, msgId, cut, carry } = await steerThenInterrupt(chat, "answered");
    expect(await answered(steerId)).toBe(true);
    expect((cut.resultJson as any).interruptCarriedSteeredCommentIds ?? []).not.toContain(steerId);
    expect(wakeCommentIds(carry)).not.toContain(steerId);
    expect(wakeCommentIds(carry)).toContain(msgId);
    await releaseRun(chat);
    expect(await liveWakesNaming(chat, steerId)).toEqual([]);
  });

  it("R4: READ + the successor continues the SAME Pi session ⇒ not injected, answered once", async () => {
    const chat = await seedChat();
    const { steerId, cut, carry } = await steerThenInterrupt(chat, "read");
    const successor = await admitSuccessor(chat, carry);
    const prompt = await successorPrompt(chat, successor, true);
    expect(prompt, "a read steer re-injected into the session that read it (a double)").not.toContain(STEER);
    expect((cut.resultJson as any).interruptCarriedReadSteeredCommentIds).toEqual([steerId]);
    expect(prompt).toContain(MSG);
    await successorAnswers(chat, successor);
    await releaseRun(chat);
    expect(await answered(steerId)).toBe(true);
    await advanceThreeMinutes(chat);
    expect(await liveWakesNaming(chat, steerId)).toEqual([]);
  });

  it("R5: READ + the successor starts a FRESH session (new box, failed resume, /new) ⇒ injected, answered once", async () => {
    const chat = await seedChat();
    const { steerId, carry } = await steerThenInterrupt(chat, "read");
    const successor = await admitSuccessor(chat, carry);
    const prompt = await successorPrompt(chat, successor, false);
    expect(prompt, "a fresh session never saw STEER").toContain(STEER);
    expect(prompt.indexOf(STEER)).toBeLessThan(prompt.indexOf(MSG));
    await successorAnswers(chat, successor);
    await releaseRun(chat);
    expect(await answered(steerId)).toBe(true);
    await advanceThreeMinutes(chat);
    expect(await liveWakesNaming(chat, steerId)).toEqual([]);
  });

  /** The cut turn's tool calls, as run-event ingestion stores them (validated PRP tool.execution.started /
   * tool.execution.completed). `midFlight`: started, cut before any completed receipt. */
  async function toolReceipts(chat: Chat, steps: Array<{ name: string; output: string; status?: string; midFlight?: boolean }>) {
    const events = steps.flatMap((step, index) => {
      const executionId = `${chat.runId}:tool-${index}`;
      const body = { schema: "paperclip.tool.execution.v1", executionId, transport: "process", operation: "execute", name: step.name };
      return [
        { eventType: "tool.execution.started", itemId: executionId, payload: { ...body, status: "running", output: null } },
        ...(step.midFlight ? [] : [{ eventType: "tool.execution.completed", itemId: executionId,
          payload: { ...body, status: step.status ?? "completed", output: step.output } }]),
      ];
    });
    const [allocated] = await db.update(heartbeatRuns)
      .set({ nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + ${events.length}` })
      .where(eq(heartbeatRuns.id, chat.runId)).returning({ next: heartbeatRuns.nextEventSeq });
    const first = Number(allocated!.next) - events.length;
    await db.insert(heartbeatRunEvents).values(events.map((event, index) => ({
      companyId: chat.companyId, runId: chat.runId, agentId: chat.agentId, seq: first + index,
      eventType: event.eventType, sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "turn-1", itemId: event.itemId, payload: event.payload } },
    })));
  }

  /** The admitted successor is now the live turn the person sees running (the dispatcher's start). */
  async function successorRuns(chat: Chat, run: typeof heartbeatRuns.$inferSelect): Promise<Chat> {
    await prepareConversationTurn(db, run);
    await db.update(issues).set({ executionRunId: run.id, executionLockedAt: new Date() }).where(eq(issues.id, chat.issue.id));
    runningProcesses.set(run.id, { child: {} as never, graceSec: 0, processGroupId: null });
    return { ...chat, runId: run.id };
  }

  /** A second Interrupt (real POST, deliveryIntent interrupt) on the live successor; returns its new carry. */
  async function interruptAgain(chat: Chat, body: string) {
    await attachSteerable(chat);
    mocks.cancel.mockImplementationOnce(async (runId: string) => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...(run!.resultJson ?? {}), nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId: chat.companyId, issueId: chat.issue.id,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
      } } }).where(eq(heartbeatRuns.id, runId));
      return { decision: { stopped: true }, auditId: randomUUID() };
    });
    const before = new Set((await carryWakes(chat)).map(wake => wake.id));
    await postDefault(chat, body, { deliveryIntent: "interrupt" }).expect(201);
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(cut!.status).toBe("cancelled");
    expect((cut!.resultJson as any)?.operatorInterrupted).toBe(true);
    const carries = (await carryWakes(chat)).filter(wake => !before.has(wake.id));
    expect(carries, "ONE new carry").toHaveLength(1);
    return carries[0]!;
  }

  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("RF-a (adopt-redo-fresh red): six-step WORK, Interrupt after STEP2, FRESH successor (new box) ⇒ its built request carries STEP1/STEP2 as already done", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [
      { name: "echo STEP1 > /tmp/step1", output: "STEP1-RESULT-wrote-step1" },
      { name: "echo STEP2 > /tmp/step2", output: "STEP2-RESULT-wrote-step2" },
    ]);
    const { carry } = await steerThenInterrupt(chat, "unread");
    const successor = await admitSuccessor(chat, carry);
    const prompt = await successorPrompt(chat, successor, false);
    expect(prompt, "the fresh session never saw STEP1/STEP2; without them it redoes real effects").toContain("STEP1-RESULT-wrote-step1");
    expect(prompt).toContain("STEP2-RESULT-wrote-step2");
    expect(prompt).toContain("echo STEP1 > /tmp/step1");
    expect(prompt).toMatch(/\n## Commands already run in the interrupted turn \(do not run these again\)\nThis list may not include file edits made in that turn; check the files before redoing any edit\.\n[\s\S]*Do not run them again/i);
    expect(prompt).toContain(MSG);
    // The same (resumed) session already holds them: never injected twice.
    expect(await successorPrompt(chat, successor, true)).not.toContain("STEP1-RESULT-wrote-step1");
  });

  it("RF-b: a person's STOP (real cancel route), then a fresh successor ⇒ the same reader carries receipts without Interrupt wording", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [{ name: "echo STEP1", output: "STEP1-RESULT-after-stop" }]);
    mocks.cancel.mockImplementationOnce(async () => ({ decision: { stopped: true }, auditId: randomUUID() }));
    await request(app(chat.companyId)).post(`/api/heartbeat-runs/${chat.runId}/cancel`).send({}).expect(200);
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, chat.runId));
    expect(cut!.status).toBe("cancelled");
    expect((cut!.resultJson as any)?.operatorInterrupted ?? false, "a STOP is not an Interrupt").toBe(false);
    const next = await issueService(db).addComment(chat.issue.id, "After stop", { userId: owner });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId, status: "running",
      runtimeMode: "native", startedAt: new Date(), contextSnapshot: { issueId: chat.issue.id, taskKey: chat.issue.id,
        wakeCommentId: next.id, commentId: next.id } }).returning();
    const prompt = await successorPrompt(chat, run!, false);
    expect(prompt).toContain("## Paperclip Wake Payload");
    expect(prompt).toContain("STEP1-RESULT-after-stop");
    expect(prompt).toContain('"status": "completed"');
    expect(prompt).not.toMatch(/interrupted turn/i);
    expect(prompt).not.toContain("The person interrupted your previous turn");
    expect(await successorPrompt(chat, run!, true)).not.toContain("STEP1-RESULT-after-stop");
  });

  it("RF-c (adopt-receipts2 red): a FAILED call in the cut turn ⇒ listed as failed, with its error; never as done", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [{ name: "echo STEP1", output: "STEP1-FAILED-OUTPUT", status: "failed" }]);
    const { carry } = await steerThenInterrupt(chat, "unread");
    const successor = await admitSuccessor(chat, carry);
    const prompt = await successorPrompt(chat, successor, false);
    expect(prompt).toContain("1. `echo STEP1`: failed\n   error: STEP1-FAILED-OUTPUT");
    expect(prompt).not.toContain("`echo STEP1`: completed");
    expect(prompt).toContain(MSG);
  });

  it("RR-1 (adopt-receipts2 red): six steps, Interrupt after STEP1, then again after STEP2 ⇒ run 3's built request lists STEP1 and STEP2 done, in order, once each", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [{ name: "echo STEP1 > /tmp/step1", output: "STEP1-RESULT-wrote-step1" }]);
    const first = await steerThenInterrupt(chat, "unread");
    const run2 = await admitSuccessor(chat, first.carry);
    const chat2 = await successorRuns(chat, run2);
    const run2Prompt = await successorPrompt(chat2, run2, false);
    expect(run2Prompt).toContain("1. `echo STEP1 > /tmp/step1`: completed");
    await toolReceipts(chat2, [{ name: "echo STEP2 > /tmp/step2", output: "STEP2-RESULT-wrote-step2" }]);
    const carry2 = await interruptAgain(chat2, "MSG2: no wait, carry on from STEP3");
    const run3 = await admitSuccessor(chat2, carry2);
    const prompt = await successorPrompt(chat2, run3, false);
    expect(prompt, "run 3 (fresh) never saw STEP1: the double Interrupt keeps the whole chain")
      .toContain("1. `echo STEP1 > /tmp/step1`: completed\n   result: STEP1-RESULT-wrote-step1");
    expect(prompt).toContain("2. `echo STEP2 > /tmp/step2`: completed\n   result: STEP2-RESULT-wrote-step2");
    expect(count(prompt, "STEP1-RESULT-wrote-step1"), "once each").toBe(1);
    expect(count(prompt, "STEP2-RESULT-wrote-step2")).toBe(1);
    expect(prompt).toContain("MSG2: no wait, carry on from STEP3");
    expect(await successorPrompt(chat2, run3, true)).not.toContain("STEP1-RESULT-wrote-step1");
  });

  it("RR-2 (adopt-receipts2 red): Interrupt DURING STEP3 ⇒ STEP1/STEP2 done; STEP3 'interrupted: it may or may not have taken effect', never done, never dropped", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [
      { name: "echo STEP1 > /tmp/step1", output: "STEP1-RESULT" },
      { name: "echo STEP2 > /tmp/step2", output: "STEP2-RESULT" },
      { name: "echo STEP3 > /tmp/step3", output: "", midFlight: true },
    ]);
    const { carry } = await steerThenInterrupt(chat, "unread");
    const successor = await admitSuccessor(chat, carry);
    const prompt = await successorPrompt(chat, successor, false);
    expect(prompt).toContain("1. `echo STEP1 > /tmp/step1`: completed");
    expect(prompt).toContain("2. `echo STEP2 > /tmp/step2`: completed");
    expect(prompt).toContain("3. `echo STEP3 > /tmp/step3`: interrupted: it may or may not have taken effect");
    expect(prompt).not.toContain("`echo STEP3 > /tmp/step3`: completed");
  });

  it("RR-3 (adopt-receipts2 red): the 'Prior tool calls are history' line is absent when the session is fresh; it says what the input holds", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [{ name: "echo STEP1", output: "STEP1-RESULT" }]);
    const { carry, cut } = await steerThenInterrupt(chat, "unread");
    const successor = await admitSuccessor(chat, carry);
    const { buildExecutionContinuation } = await import("../services/execution-continuation.js");
    const executionContinuation = await buildExecutionContinuation({ db, companyId: chat.companyId, issueId: chat.issue.id,
      agentId: chat.agentId, context: { ...(successor.contextSnapshot as Record<string, unknown>), interruptedRunId: cut.id }, runId: successor.id,
      summary: null, exposeLowTrustRaw: false });
    expect(executionContinuation.interruptedRunId, "the real continuation names the cut run").toBe(cut.id);
    const withContinuation = { ...successor, contextSnapshot: { ...(successor.contextSnapshot as Record<string, unknown>), executionContinuation } };
    const fresh = await successorPrompt(chat, withContinuation, false);
    expect(fresh, "the fresh input holds no conversation history").not.toContain("Prior tool calls are history");
    expect(fresh).not.toContain("using the conversation history");
    expect(fresh).toContain("This is a fresh session: that run's conversation and tool calls are not in this input, except the tool calls listed under \"Commands already run in the interrupted turn (do not run these again)\"");
    expect(await successorPrompt(chat, withContinuation, true)).toContain("Prior tool calls are history, not commands to replay");
  });

  /** Real Pi tool events (tool_execution_start/end) through the REAL Pi projector, stored as the runner stores them. */
  async function piToolReceipts(chat: Chat, calls: Array<{ tool: string; args: Record<string, unknown>; output: string; isError?: boolean }>) {
    const projector = createPiEventProjector({ runId: chat.runId, turnId: `turn-${randomUUID()}` });
    const projected = calls.flatMap((call, index) => {
      const toolCallId = `call-${randomUUID()}-${index}`;
      return [
        ...projector.project({ type: "tool_execution_start", toolCallId, toolName: call.tool, args: call.args }),
        ...projector.project({ type: "tool_execution_end", toolCallId, toolName: call.tool,
          result: { content: [{ type: "text", text: call.output }] }, isError: call.isError === true }),
      ];
    });
    const [allocated] = await db.update(heartbeatRuns)
      .set({ nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + ${projected.length}` })
      .where(eq(heartbeatRuns.id, chat.runId)).returning({ next: heartbeatRuns.nextEventSeq });
    const first = Number(allocated!.next) - projected.length;
    await db.insert(heartbeatRunEvents).values(projected.map((event, index) => ({
      companyId: chat.companyId, runId: chat.runId, agentId: chat.agentId, seq: first + index,
      eventType: event.eventType, sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: event.turnId, itemId: event.itemId, payload: event.payload } },
    })));
  }

  /** The next fresh request on this task: a person's new message and a new run with a fresh session. */
  async function nextFreshRequest(chat: Chat, body: string) {
    const next = await issueService(db).addComment(chat.issue.id, body, { userId: owner });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId, status: "running",
      runtimeMode: "native", startedAt: new Date(), contextSnapshot: { issueId: chat.issue.id, taskKey: chat.issue.id,
        wakeCommentId: next.id, commentId: next.id } }).returning();
    return successorPrompt(chat, run!, false);
  }

  it("RF4-J2 (rf-4 F3 red): Interrupt after STEP1 ⇒ the successor FAILS without a reply ⇒ the next fresh request still lists STEP1 done (the chain walks back to the last run that ended with an agent reply)", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [{ name: "echo STEP1 > /tmp/step1", output: "STEP1-RESULT-wrote-step1" }]);
    const { carry } = await steerThenInterrupt(chat, "unread");
    const run2 = await admitSuccessor(chat, carry);
    const chat2 = await successorRuns(chat, run2);
    await toolReceipts(chat2, [{ name: "echo STEP2 > /tmp/step2", output: "STEP2-FAILED-boom", status: "failed" }]);
    await successorFails(chat2, run2);
    const prompt = await nextFreshRequest(chat2, "MSG3: please carry on");
    expect(prompt, "STEP1 was done before the failed successor; a fresh input without it re-runs STEP1")
      .toContain("1. `echo STEP1 > /tmp/step1`: completed\n   result: STEP1-RESULT-wrote-step1");
    expect(prompt, "the failed successor's own call is listed too, as failed").toContain("2. `echo STEP2 > /tmp/step2`: failed\n   error: STEP2-FAILED-boom");
    expect(count(prompt, "STEP1-RESULT-wrote-step1"), "once").toBe(1);
  });

  it("RF4-J2c (control): Interrupt after STEP1 ⇒ the successor ANSWERS (ends with a reply) ⇒ the next fresh request lists nothing from before that reply", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, [{ name: "echo STEP1 > /tmp/step1", output: "STEP1-RESULT-wrote-step1" }]);
    const { carry } = await steerThenInterrupt(chat, "unread");
    const run2 = await admitSuccessor(chat, carry);
    await successorRuns(chat, run2);
    await successorAnswers(chat, run2);
    const prompt = await nextFreshRequest(chat, "MSG3: next thing");
    expect(prompt).not.toContain("STEP1-RESULT-wrote-step1");
    expect(prompt).not.toMatch(/Commands already run in the interrupted turn/);
  });

  it("RF4-J3 (rf-4 F1 red): a non-bash call keeps its ARGUMENTS (write: path + short content), from the real Pi projector's receipts", async () => {
    const chat = await seedChat();
    await piToolReceipts(chat, [
      { tool: "write", args: { path: "/work/notes/step1.md", content: "STEP1 CONTENT A" }, output: "Successfully wrote 15 bytes to /work/notes/step1.md" },
      { tool: "write", args: { path: "/work/notes/step2.md", content: "STEP2 CONTENT B" }, output: "Successfully wrote 15 bytes" },
      { tool: "bash", args: { command: "echo STEP3 > /tmp/step3" }, output: "STEP3-RESULT" },
    ]);
    const { carry } = await steerThenInterrupt(chat, "unread");
    const successor = await admitSuccessor(chat, carry);
    const prompt = await successorPrompt(chat, successor, false);
    const section = prompt.slice(prompt.indexOf("## Commands already run in the interrupted turn (do not run these again)\nThis list may not include file edits made in that turn; check the files before redoing any edit.\n"));
    expect(section).toMatch(/1\. `write` \(`[^`\n]*\/work\/notes\/step1\.md[^`\n]*STEP1 CONTENT A[^`\n]*`\): completed/);
    expect(section).toMatch(/2\. `write` \(`[^`\n]*\/work\/notes\/step2\.md[^`\n]*STEP2 CONTENT B[^`\n]*`\): completed/);
    expect(section).toContain("3. `echo STEP3 > /tmp/step3`: completed\n   result: STEP3-RESULT");
  });

  it("RF4-J6 (rf-4 F2 red): 33 completed calls ⇒ 32 listed and the input SAYS one more was omitted; it never claims the list is everything", async () => {
    const chat = await seedChat();
    await toolReceipts(chat, Array.from({ length: 33 }, (_, i) => ({ name: `echo STEP${i + 1}`, output: `R${i + 1}` })));
    const { carry } = await steerThenInterrupt(chat, "unread");
    const successor = await admitSuccessor(chat, carry);
    const prompt = await successorPrompt(chat, successor, false);
    expect(prompt).toContain("32. `echo STEP32`: completed");
    expect(prompt).not.toContain("33. `echo STEP33`");
    expect(prompt).toMatch(/1 more tool call[^\n]* omitted/);
    expect(prompt).not.toMatch(/everything recorded/);
    const under = await (async () => { const c = await seedChat();
      await toolReceipts(c, [{ name: "echo ONLY", output: "ONLY-R" }]);
      const s = await admitSuccessor(c, (await steerThenInterrupt(c, "unread")).carry);
      return successorPrompt(c, s, false); })();
    expect(under, "under the cap nothing is said omitted").not.toMatch(/omitted/);
  });

  it("R6: a non-terminal conversation-comment wake for an adopted steer is retired at the press (coalesced into the carry); STEER has ONE carrier, the carry", async () => {
    const chat = await seedChat();
    const { steerId, carry } = await steerThenInterrupt(chat, "read", { staleWake: "deferred_issue_execution" });
    const named = await commentWakes(chat, steerId);
    expect(named).toHaveLength(1);
    // Either the queue's own wake became the carry, or it is retired into the carry: never a second live carrier.
    if (named[0]!.id !== carry.id) expect([named[0]!.status, named[0]!.error]).toEqual(["coalesced", "Sent with the chat's other queued messages"]);
    expect((await carriersAfterCut(chat, [steerId], carry.id))[steerId], "STEER's carriers after the cut").toEqual(["carry"]);
  });

  /** The person's own steer cards (the per-message sweep's system comment naming the id). */
  const cardsFor = async (chat: Chat, id: string) => (await db.select().from(issueComments).where(and(
    eq(issueComments.issueId, chat.issue.id), eq(issueComments.authorType, "system"),
    sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + id}`)));

  /** The carry's ONE successor ends FAILED with no reply (no assistant text, no agent comment), and is released. */
  async function successorFails(chat: Chat, run: typeof heartbeatRuns.$inferSelect) {
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed",
      error: "provider exited" }).where(eq(heartbeatRuns.id, run.id));
    const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    await settleConversationTurn(db, ended!);
    await createWakeQueue(db, releaseDeps as never).releaseIssueExecution({ companyId: chat.companyId, runId: run.id, now: new Date() });
  }

  it("R7 (rf-4 bppc3 F1): a READ steer adopted by the Interrupt; the ONE successor FAILS without answering ⇒ the failed run's Retry (real route) carries STEER; answered once, no card", async () => {
    const chat = await seedChat();
    const { steerId, msgId, cut, carry } = await steerThenInterrupt(chat, "read");
    expect((cut.resultJson as any).interruptCarriedReadSteeredCommentIds).toEqual([steerId]);
    const successor = await admitSuccessor(chat, carry);
    // The real admission of the carry settles the cut run's hold (explicit-native-continuation.ts ~:796:
    // resolved / cancelled); admitSuccessor is the dispatcher's claim only, so the row applies that settlement.
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "cancelled", resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(issueRecoveryActions.sourceIssueId, chat.issue.id), eq(issueRecoveryActions.status, "active")));
    expect((successor.contextSnapshot as any).wakeCommentIds, "the successor's input names the adopted steer").toContain(steerId);
    // The cut run's release first (the press's cancel), then the dispatcher's claim: the successor owns the task's execution.
    await releaseRun(chat);
    await db.update(issues).set({ executionRunId: successor.id, executionAgentNameKey: null, executionLockedAt: new Date() })
      .where(eq(issues.id, chat.issue.id));
    await successorFails(chat, successor);
    expect(await answered(steerId), "a failed successor answered nothing").toBe(false);
    const retried = await request(app(chat.companyId)).post(`/api/agents/${chat.agentId}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: successor.id });
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    const retryRunId = retried.body.id as string;
    expect(retryRunId, `the Retry started a run: cut=${chat.runId} successor=${successor.id} ${JSON.stringify(retried.body)}`).toBeTruthy();
    expect([chat.runId, successor.id]).not.toContain(retryRunId);
    const [retryRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId));
    const ids = (retryRun!.contextSnapshot as any).wakeCommentIds as string[];
    expect(ids, "the Retry's new wake ids carry the adopted READ steer").toContain(steerId);
    expect(ids).toContain(msgId);
    expect(ids.filter(id => id === steerId), "carried once").toHaveLength(1);
    // The Retry answers (reply + run end) ⇒ the ONE answered function says answered; nothing else wakes on it, no card.
    await successorAnswers(chat, retryRun!);
    expect(await answered(steerId)).toBe(true);
    await advanceThreeMinutes(chat);
    expect(await liveWakesNaming(chat, steerId)).toEqual([]);
    expect(await cardsFor(chat, steerId), "no steer card once the Retry answered it").toEqual([]);
  });

  it("R7c (control): READ steer adopted; the successor ANSWERS ⇒ answered once, no card, nothing to retry", async () => {
    const chat = await seedChat();
    const { steerId, carry } = await steerThenInterrupt(chat, "read");
    const successor = await admitSuccessor(chat, carry);
    await successorAnswers(chat, successor);
    await releaseRun(chat);
    expect(await answered(steerId)).toBe(true);
    await advanceThreeMinutes(chat);
    expect(await liveWakesNaming(chat, steerId)).toEqual([]);
    expect(await cardsFor(chat, steerId)).toEqual([]);
  });

  it("R6b: a QUEUED (not yet admitted) conversation-comment wake for STEER is retired into the carry at the press", async () => {
    const chat = await seedChat();
    const { steerId, carry } = await steerThenInterrupt(chat, "read", { staleWake: "queued" });
    const others = (await commentWakes(chat, steerId)).filter(w => w.id !== carry.id);
    expect(others.map(w => [w.status, w.error]), "a second live wake for STEER")
      .toEqual([["coalesced", "Sent with the chat's other queued messages"]]);
  });


});
