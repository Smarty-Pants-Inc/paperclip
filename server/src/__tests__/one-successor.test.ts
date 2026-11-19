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

  describe("F2: every carry field suppresses a moved-on message's false unanswered card", () => {
    // Keep reason: rf-4 F2, one real-Postgres sweep row per carry field. No outbox,
    // failed carrier (G1), or old-message discovery (F1) participates in these rows.
    const fields = [
      { row: 1, field: "wake payload._paperclipWakeContext.commentId", location: "wake", key: "_paperclipWakeContext" },
      { row: 2, field: "wake payload.commentIds", location: "wake", key: "commentIds" },
      { row: 3, field: "run context_snapshot.steeredCommentIds", location: "context", key: "steeredCommentIds" },
      { row: 4, field: "run context_snapshot.carriedSteeredCommentIds", location: "context", key: "carriedSteeredCommentIds" },
      { row: 5, field: "run result_json.restoredSteeredCommentIds", location: "result", key: "restoredSteeredCommentIds" },
      { row: 6, field: "run result_json.stopRestoredSteeredCommentIds", location: "result", key: "stopRestoredSteeredCommentIds" },
      { row: 7, field: "run result_json.interruptCarriedSteeredCommentIds", location: "result", key: "interruptCarriedSteeredCommentIds" },
      { row: 8, field: "run result_json.queuedSteeringAcknowledgements", location: "result", key: "queuedSteeringAcknowledgements" },
    ] as const;
    type CarryField = typeof fields[number];

    async function movedOnRow(field: CarryField | null) {
      const chat = await seedChat();
      const m = chat.first.id;
      const now = new Date();
      const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
      await db.update(issueComments).set({ createdAt: ago(20), updatedAt: ago(20) })
        .where(eq(issueComments.id, m));
      const context: Record<string, unknown> = { issueId: chat.issue.id, taskKey: chat.issue.id };
      const result: Record<string, unknown> = {};
      const payload: Record<string, unknown> = { issueId: chat.issue.id };
      if (field?.location === "context") context[field.key] = [m];
      if (field?.location === "result") result[field.key] = field.row === 8
        ? { [m]: { status: "acknowledged" } } : [m];
      if (field?.location === "wake") {
        payload[field.key] = field.row === 1 ? { commentId: m } : [m];
        await db.insert(agentWakeupRequests).values({ companyId: chat.companyId, agentId: chat.agentId,
          source: "on_demand", status: "completed", idempotencyKey: `f2-field-${field.row}:${randomUUID()}`,
          payload, requestedAt: ago(20), finishedAt: ago(19) });
      }
      // Replace the seed's ordinary input keys completely: m occurs ONLY in F.
      // A succeeded earlier turn avoids making this a failed-carrier/G1 row.
      await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: ago(21), finishedAt: ago(19),
        createdAt: ago(21), updatedAt: ago(19), contextSnapshot: context, resultJson: result })
        .where(eq(heartbeatRuns.id, chat.runId));
      runningProcesses.delete(chat.runId);
      await db.update(issues).set({ executionRunId: null, executionLockedAt: null, conversationState: "waiting" })
        .where(eq(issues.id, chat.issue.id));
      const laterContext = { issueId: chat.issue.id, taskKey: chat.issue.id };
      const [later] = await db.insert(heartbeatRuns).values({ companyId: chat.companyId, agentId: chat.agentId,
        status: "succeeded", runtimeMode: "native", startedAt: ago(10), finishedAt: ago(9),
        createdAt: ago(10), updatedAt: ago(9), contextSnapshot: laterContext }).returning();
      await db.insert(issueComments).values({ companyId: chat.companyId, issueId: chat.issue.id,
        authorType: "agent", authorAgentId: chat.agentId, createdByRunId: later!.id,
        body: "The chat has since moved on; here is the later turn's reply.", createdAt: ago(9), updatedAt: ago(9) });

      // Check the persisted shape, not just fixture construction: no ordinary
      // comment/wake input keys or conversation-comment receipt can mask F.
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, chat.companyId))
        .orderBy(asc(heartbeatRuns.startedAt));
      expect(runs.map(r => r.contextSnapshot)).toEqual([context, laterContext]);
      expect(runs.map(r => r.resultJson)).toEqual([result, null]);
      expect(runs.every(r => r.status === "succeeded")).toBe(true);
      expect(later!.startedAt!.getTime()).toBeGreaterThan(ago(20).getTime());
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, chat.companyId));
      expect(wakes.map(w => ({ key: w.idempotencyKey?.startsWith("conversation-comment:"), payload: w.payload })))
        .toEqual(field?.location === "wake" ? [{ key: false, payload }] : []);
      expect(await answered(m), "exercise the moved-on floor, not the direct-answer predicate").toBe(false);
      const sweeps = [];
      for (let pass = 0; pass < 2; pass++) {
        // Boot/sweep entry includes discovery and the real fenced notice writer.
        sweeps.push(await settleUnansweredPersonMessages(db, { companyId: chat.companyId, issueId: chat.issue.id, now }));
      }
      // Also exercise the worker's per-task decision even if discovery skipped it.
      const direct = await settleUnansweredPersonMessage(db, { companyId: chat.companyId, issueId: chat.issue.id, now });
      const cards = await db.select({ id: issueComments.id, body: issueComments.body, deletedAt: issueComments.deletedAt })
        .from(issueComments).where(and(eq(issueComments.companyId, chat.companyId), eq(issueComments.issueId, chat.issue.id),
          eq(issueComments.authorType, "system"),
          sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + m}`));
      console.log("F2_ROW " + JSON.stringify({ row: field?.row ?? "control", field: field?.field ?? "never carried",
        messageId: m, messageCreatedAt: ago(20).toISOString(), carryRunId: chat.runId, laterRunId: later!.id,
        laterStartedAt: later!.startedAt, runs: runs.map(r => ({ id: r.id, context: r.contextSnapshot, result: r.resultJson })),
        wakes: wakes.map(w => ({ id: w.id, key: w.idempotencyKey, payload: w.payload })), sweeps, direct,
        cards: cards.map(c => ({ ...c, deletedAt: c.deletedAt?.toISOString() ?? null })), cardCount: cards.length }));
      expect(cards, field ? `${field.field}: no false card after the chat moved on` : "never carried: exactly one true card")
        .toHaveLength(field ? 0 : 1);
      if (!field) {
        expect(cards[0]!.deletedAt).toBeNull();
        expect(sweeps.map(s => s.noticed)).toEqual([1, 0]);
        expect(direct.kind).toBe("noticed_before");
      } else {
        expect(sweeps).toEqual([{ noticed: 0, pending: 0 }, { noticed: 0, pending: 0 }]);
        expect(direct.kind).toBe("answered");
      }
    }

    it.each(fields)("F2-$row: carried ONLY by $field => no unanswered card", async (field) => {
      await movedOnRow(field);
    });

    it("F2-control: recent NEVER-carried message + later succeeded replying run => exactly ONE true card", async () => {
      await movedOnRow(null);
    });
  });
});
