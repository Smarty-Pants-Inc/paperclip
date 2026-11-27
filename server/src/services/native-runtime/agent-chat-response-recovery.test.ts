import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, completionContracts, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunResults, issueThreadInteractions, chatTaskHandoffs, chatCompletionDeliveries, agentWakeupRequests, statusDecisions, type Db, approvals, issueApprovals, issueQuestionResponseDeliveries } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun, recoverCommittedNativeChatResponse } from "./native-run-finalizer.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";
import { chatCompletionDeliveryService, existingChatCompletionReply } from "../chat-completion-delivery.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueService } from "../issues.js";
import * as nativeResponseNotifications from "../native-response-presentation-notifications.js";
import { compactRunLogChunk } from "../heartbeat/run-log.js";
import { publishContinuousNativeReply } from "./native-continuous-reply.js";
import { answeredContinuousHeldRun, readContinuousSessionInput } from "./continuous-session-input.js";
import { requeueContinuousUnanswered } from "./native-continuous-unanswered.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { drainContinuousPersonMessages } from "./native-continuous-drain.js";
import { readBoardQueuedComments } from "../../modules/wake-queue/adapters/queued-comment-board-postgres.js";
import { claimFirstTurnQueuedInput } from "./first-turn-queued-input.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { questionResponseDeliveryService, type QuestionResponseDeliveryServiceOptions } from "../question-response-delivery.js";
import { deliverConversationComments } from "../agent-conversations.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";

const heldSteering = vi.hoisted(() => ({ available: false, reject: false, sent: [] as string[], ack: undefined as Promise<void> | undefined,
  onSend: undefined as ((commentId: string) => Promise<void>) | undefined,
  userMessages: null as string[] | null, userInputIds: null as string[] | null }));
vi.mock("./native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native-session-executor.js")>();
  return { ...actual,
    readNativeSessionUserMessages: async () => heldSteering.userMessages,
    readNativeSessionUserInputIds: async () => heldSteering.userInputIds,
    getNativeSessionSteeringState: async () => ({ disposition: heldSteering.available ? "available" : "temporarily_unavailable", activeTurnId: heldSteering.available ? "held-turn" : null }),
    steerNativeSession: async (input: { correlationId: string }) => {
      if (heldSteering.reject) throw new actual.NativeSessionSteeringError("steering_stale_turn", "This held turn is closing. Your message stays queued for the next run.");
      await heldSteering.onSend?.(input.correlationId);
      heldSteering.sent.push(input.correlationId); await heldSteering.ack; return { turnId: "held-turn" };
    },
  };
});
const runLogReads = vi.hoisted(() => [] as unknown[]);
vi.mock("../run-log-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-log-store.js")>();
  return { ...actual, getRunLogStore: () => {
    const store = actual.getRunLogStore();
    return { ...store, read: (...args: Parameters<typeof store.read>) => { runLogReads.push(args[0]); return store.read(...args); } };
  } };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_CHAT_RESPONSE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("committed Agent Chat reply recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("agent-chat-response-");
    db = createDb(external ?? database!.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(conversation = true, options: { succeed?: boolean; failed?: boolean; disposition?: "done" | "needs_review" | "yielded"; channel?: "final" | "unknown";
    beforeFinalize?: (ids: { companyId: string; issueId: string; runId: string; agentId: string }) => Promise<void>;
    reply?: string; logRef?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), runnerId = randomUUID(), userId = `fixture-${randomUUID()}`, wakeId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Conversation owner", email: `${userId}@example.test`,
      createdAt: new Date("2020-01-01T00:00:00Z"), updatedAt: new Date("2020-01-01T00:00:00Z") });
    await db.insert(companies).values({ id: companyId, name: "Reply recovery fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Conversation agent", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Conversation reply", status: "in_progress", assigneeAgentId: agentId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", conversationSessionGeneration: 0 } : {}) });
    await db.insert(issueComments).values({ id: wakeId, companyId, issueId, authorUserId: userId, body: "Hire one teammate and tell me when ready.",
      createdAt: new Date("2020-01-01T00:00:00Z") });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Answer the user", criteria: [] },
      canonicalSha256: "fixture-conversation-contract", createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", responsibleUserId: userId,
      ...(options.logRef ? { logStore: "local_file", logRef: options.logRef } : {}),
      contextSnapshot: { issueId, source: "issue.comment", wakeCommentId: wakeId, ...(conversation ? { conversationSessionGeneration: 0 } : {}) } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    const reply = options.reply ?? "The teammate is hired and ready for your next instruction.";
    const prpEvent = { runId, normalizedSessionId: sessionId, turnId: "hire-turn", sourceEventId: "fixture-final-answer",
      payload: { kind: "agentMessage", channel: "final", providerPhase: "final", text: reply } };
    if (options.channel) prpEvent.payload.channel = options.channel;
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 170, eventType: "item.completed", payload: { prpEvent } });
    const disposition = options.disposition ?? "done";
    await options.beforeFinalize?.({ companyId, issueId, runId, agentId });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: disposition,
      summary: "A completed hire, with its final message preserved separately.",
      ...(disposition === "yielded" ? { continuation: { kind: "response_wake" as const, summary: "Wait for the next human message", idempotencyKey: "conversation-next-message" } } : {}),
      completionClaim: { contractRevision: "test",
        objectiveSatisfied: true, criteria: [], remainingWork: [] }, evidence: [], verification: [],
      attentionRequests: disposition === "needs_review" ? [{ kind: "review", ownerClass: "human", summary: "Review the completed work." }] : [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: options.failed ? "failed" : "succeeded", turnTerminalState: options.failed ? "failed" : "completed", reportedWorkDisposition: disposition }, turnId: "hire-turn" });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase).toBe("committed");
    if (options.succeed !== false) await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date("2020-01-01T00:02:00Z") }).where(eq(heartbeatRuns.id, runId));
    const input = { companyId, issueId, runId };
    return { ...input, input, agentId, userId, wakeId, prpEvent, reply };
  }
  it("settles the exact claimed wake when recovery projects a committed native run", async () => {
    // The provider and result are already committed. Recovery owns terminal
    // projection because the live executor will not return to completeRun.
    const f = await fixture(false, { succeed: false });
    const sourceWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: sourceWakeId, companyId: f.companyId,
      agentId: f.agentId, source: "issue", reason: "issue_assigned", status: "claimed",
      runId: f.runId, claimedAt: new Date(), payload: { issueId: f.issueId } });
    await db.update(heartbeatRuns).set({ wakeupRequestId: sourceWakeId }).where(eq(heartbeatRuns.id, f.runId));

    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, sourceWakeId));
    expect(run).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    expect(run.finishedAt).not.toBeNull();
    expect(wake).toMatchObject({ status: "completed", runId: f.runId });
    expect(wake.finishedAt).not.toBeNull();
  });

  it("hold seam v2: a fenced steering race preserves the wake for an answered next run at the new level", async () => {
    const { createQueuedCommentSteeringAdapter, readBoardQueuedComments } = await import("../../modules/wake-queue/adapters/queued-comment-board-postgres.js");
    const { createSteerQueuedComment } = await import("../../modules/wake-queue/application/queued-comment-use-cases.js");
    const { agentService } = await import("../agents.js");
    const steeringFlag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.available = true; heldSteering.reject = true; heldSteering.sent = [];
    let queued!: { id: string; commentId: string };
    const { getServerAdapter, registerServerAdapter } = await import("../../adapters/index.js");
    const nativeMode = await import("./runtime-mode.js");
    const savedAdapter = getServerAdapter("paperclip_runner");
    let heartbeat: ReturnType<typeof import("../heartbeat.js").heartbeatService> | undefined;
    let worker: ReturnType<NonNullable<typeof heartbeat>["registerDeferredReceiptWork"]> | undefined;
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let restoreMode: (() => void) | undefined;
    try {
      const f = await fixture(true, { beforeFinalize: async scope => {
        await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "paperclip/gpt-6.1-sol", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
        const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
        const [comment] = await db.insert(issueComments).values({ companyId: scope.companyId, issueId: scope.issueId,
          authorType: "user", authorUserId: opening.authorUserId, body: "Use the new level on the next run" }).returning();
        const [wake] = await db.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
          source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution",
          requestedByActorType: "user", requestedByActorId: opening.authorUserId,
          payload: { issueId: scope.issueId, _paperclipWakeContext: { wakeReason: "issue_commented", wakeCommentIds: [comment.id] } } }).returning();
        queued = { id: wake.id, commentId: comment.id };
        const actor = { actorType: "agent" as const, actorId: scope.agentId, agentId: scope.agentId, runId: scope.runId, agentApiKeyId: null };
        const before = await readBoardQueuedComments({ executor: db, issue, activeRun: run, actor });
        await agentService(db).update(scope.agentId, { adapterConfig: {
          provider: "pi_rpc", model: "paperclip/gpt-6.1-sol", sessionContinuity: "continuous", piRpcThinkingLevel: "high",
        } });
        // Eligibility was read before the commit; the actual delivery now refuses.
        const steer = createSteerQueuedComment(createQueuedCommentSteeringAdapter(db));
        await expect(steer({ issue, actor, queueId: wake.id, commentId: comment.id, targetRunId: run.id, revision: before.revision }))
          .rejects.toMatchObject({ code: "steering_stale_turn", message: expect.stringContaining("stays queued for the next run") });
        const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
        expect(pending).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: wake.payload });
        const visible = await readBoardQueuedComments({ executor: db, issue, activeRun: run, actor });
        expect(visible.entries.map(entry => entry.comment.id)).toEqual([comment.id]);
        expect(visible.state).toBe("deferred");
        const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        expect(saved.resultJson?.heldNativeConfigurationEnd).toBe(true);
        expect(saved.resultJson?.queuedSteeringAcknowledgements).toBeUndefined();
        expect(heldSteering.sent).toEqual([]);
      } });
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: f.userId,
        principalType: "user", status: "active", membershipRole: "member" });
      // The fixture commits finalization without the executor's release callback.
      await db.update(issues).set({ responsibleUserId: f.userId, executionRunId: null }).where(eq(issues.id, f.issueId));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
      const dispatched: string[] = [];
      registerServerAdapter({ ...savedAdapter, execute: async input => {
        dispatched.push(input.runId);
        expect(input.context.wakeCommentIds).toContain(queued.commentId);
        expect(input.config.piRpcThinkingLevel).toBe("high");
        await issueService(db).addComment(f.issueId, "The queued message was answered with the new level.", { agentId: f.agentId, runId: input.runId });
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {}, summary: "Queued message answered" };
      } });
      const mode = vi.spyOn(nativeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({ kind: "legacy",
        reason: "persisted_legacy_selection", resolverVersion: nativeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
      restoreMode = () => mode.mockRestore();
      heartbeat = (await import("../heartbeat.js")).heartbeatService(db);
      const errors: unknown[] = [];
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
      worker = heartbeat.registerDeferredReceiptWork(coordinator, () => true);
      await worker.ready;
      await vi.waitFor(async () => {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.id));
        expect(wake, JSON.stringify({ errors, dispatched })).toMatchObject({ status: "completed", runId: dispatched[0] });
        expect(wake.runId).not.toBe(f.runId);
      }, { timeout: 8_000 });
      await heartbeat.drainActiveRunExecutions();
      const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
        eq(issueComments.createdByRunId, dispatched[0]), eq(issueComments.body, "The queued message was answered with the new level.")));
      expect(replies).toHaveLength(1);
      expect(dispatched).toHaveLength(1);
    } finally {
      worker?.stop(); await coordinator?.stop();
      await heartbeat?.drainActiveRunExecutions();
      restoreMode?.(); registerServerAdapter(savedAdapter);
      heldSteering.available = false; heldSteering.reject = false;
      if (steeringFlag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = steeringFlag;
    }
  });

  it("plugin agent comment commits, steers into the held chat, and is answered once without tray residue", async () => {
    const { buildHostServices } = await import("../plugin-host-services.js");
    const { readBoardQueuedComments } = await import("../../modules/wake-queue/adapters/queued-comment-board-postgres.js");
    const flag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    const bridgeIds = process.env.PAPERCLIP_CONVERSATION_INPUT_PLUGIN_IDS;
    process.env.PAPERCLIP_CONVERSATION_INPUT_PLUGIN_IDS = "plugin-record-id";
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.available = true; heldSteering.sent = [];
    const observer = createDb(external ?? database!.connectionString);
    let commitObservedAtDelivery = false;
    try {
      await fixture(true, { beforeFinalize: async scope => {
        await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
        const [sender] = await db.insert(agents).values({ companyId: scope.companyId, name: "Bridge author", adapterType: "process" }).returning();
        await expect(issueService(db).addComment(scope.issueId, "Untrusted assistant output", { agentId: sender.id }))
          .rejects.toThrow("Only this conversation's agent can post agent messages");
        const [chat] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
        const userId = chat.conversationUserId!;
        await db.insert(companyMemberships).values({ companyId: scope.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
        const { attentionService } = await import("../attention.js");
        const personAttention = () => attentionService(db).list(scope.companyId, { userId, view: "mine",
          actor: { type: "board", source: "session", userId, companyIds: [scope.companyId], isInstanceAdmin: false } });
        expect((await personAttention()).items).toEqual([]);
        const services = buildHostServices(db, "plugin-record-id", "paperclip.gateway", { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never,
          undefined, { heartbeatRuntimeEnv: {} });
        const unrelated = buildHostServices(db, "unrelated-plugin-id", "paperclip.gateway", { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never,
          undefined, { heartbeatRuntimeEnv: {} });
        await expect(unrelated.issues.createComment({ companyId: scope.companyId, issueId: scope.issueId,
          authorAgentId: sender.id, body: "Unapproved plugin input" })).rejects.toThrow("Only this conversation's agent");
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, scope.agentId))).toEqual([]);
        expect(heldSteering.sent).toEqual([]);
        heldSteering.onSend = async commentId => {
          // An independent PostgreSQL connection can see neither an uncommitted
          // comment nor admission wake. This runs INSIDE the delivery callback.
          expect((await observer.select().from(issueComments).where(eq(issueComments.id, commentId)))[0].authorAgentId).toBe(sender.id);
          const wakes = await observer.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, scope.agentId));
          expect(wakes).toEqual([expect.objectContaining({ status: "deferred_issue_execution", requestedByActorId: sender.id })]);
          expect(JSON.stringify(wakes[0].payload)).toContain(commentId);
          commitObservedAtDelivery = true;
        };
        const comment = await services.issues.createComment({ companyId: scope.companyId, issueId: scope.issueId,
          authorAgentId: sender.id, body: "Bridge agent asks for a held reply" });
        // Separate root-DB reads prove both authored comment and admission are
        // committed, not visible only inside a comment/admission transaction.
        const [savedComment] = await db.select().from(issueComments).where(eq(issueComments.id, comment.id));
        expect(savedComment.authorAgentId).toBe(sender.id);
        expect(heldSteering.sent).toEqual([comment.id]);
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, scope.agentId));
        expect(wake).toMatchObject({ status: "cancelled", requestedByActorType: "agent", requestedByActorId: sender.id });
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        expect(run.resultJson?.queuedSteeringAcknowledgements).toMatchObject({ [comment.id]: {
          status: "acknowledged", commentUpdatedAt: savedComment.updatedAt.toISOString(),
        } });
        const event = { eventType: "item.completed" as const, runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          sourceEventId: "plugin-held-answer", itemId: "plugin-held-answer", payload: { kind: "agentMessage", channel: "final",
            text: "Bridge held reply answered once.", answers: [comment.id] } };
        const execution = { binding: scope, provider: { kind: "pi_rpc" as const } };
        await publishContinuousNativeReply({ db, execution, event, cursor: 171 });
        await publishContinuousNativeReply({ db, execution, event, cursor: 171 });
        const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, scope.issueId), eq(issueComments.body, event.payload.text)));
        expect(replies).toHaveLength(1);
        const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
        const board = await readBoardQueuedComments({ executor: db, issue, activeRun: run,
          actor: { actorType: "agent", actorId: sender.id, agentId: sender.id, runId: null, agentApiKeyId: null } });
        expect(board.entries).toEqual([]);
        const personTray = await personAttention();
        expect(personTray.items).toEqual([]);
        expect((await personAttention()).items).toEqual([]); // Fresh read, not cached sender queue state.
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, scope.agentId))).toHaveLength(1);
        process.stdout.write(`PLUGIN_HELD ${JSON.stringify({ runId: scope.runId, commentId: comment.id, wakeId: wake.id,
          wakeStatus: wake.status, replies: replies.map(reply => reply.id), tray: board.entries, personTray: personTray.items,
          sent: heldSteering.sent, commitObservedAtDelivery })}\n`);
      } });
    } finally {
      heldSteering.onSend = undefined;
      heldSteering.available = false;
      await observer.$client.end();
      if (bridgeIds === undefined) delete process.env.PAPERCLIP_CONVERSATION_INPUT_PLUGIN_IDS;
      else process.env.PAPERCLIP_CONVERSATION_INPUT_PLUGIN_IDS = bridgeIds;
      if (flag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = flag;
    }
  });

  it.each(["drain", "reset", "non-pi", "paperclip", "unavailable", "agent", "other-agent", "mixed", "flag-off", "issue_children_completed", "execution_review_requested", "issue_completed", "system", "notice", "fresh"])("consumes deferred messages only at a steerable continuous final (%s)", async scenario => {
    const shouldDrain = scenario === "drain" || scenario === "other-agent" || scenario === "mixed";
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const wakeIds = [randomUUID(), randomUUID()];
    heldSteering.sent = [];
    const steeringFlag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.available = scenario !== "unavailable";
    if (scenario === "flag-off") process.env.PAPERCLIP_AGENT_CHAT_STEERING = "false";
    try {
      const f = await fixture(true, { beforeFinalize: async scope => {
        const provider = scenario === "non-pi" ? "codex" : "pi_rpc";
        await db.update(agents).set({ adapterConfig: { provider, sessionContinuity: scenario === "paperclip" ? "paperclip" : "continuous" } }).where(eq(agents.id, scope.agentId));
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
        const fromAgent = !["drain", "reset", "mixed"].includes(scenario);
        const [sender] = await db.insert(agents).values({ companyId: scope.companyId, name: "Agent A", adapterType: "process" }).returning();
        await db.insert(issueComments).values(ids.map((id, index) => ({ id, companyId: scope.companyId, issueId: scope.issueId,
          authorType: scenario === "system" ? "system" as const : fromAgent || (scenario === "mixed" && index === 1) ? "agent" as const : "user" as const,
          authorUserId: fromAgent || (scenario === "mixed" && index === 1) ? null : opening.authorUserId,
          authorAgentId: fromAgent || (scenario === "mixed" && index === 1) ? scenario === "agent" ? scope.agentId : sender.id : null,
          ...(scenario === "notice" ? { metadata: { version: 1 as const, sections: [], authorizationReason: "allow_chat_run_presentation" } } : {}),
          body: scenario === "reset" && index === 0 ? "/new" : `Queued question ${index}` })));
        await db.insert(agentWakeupRequests).values(wakeIds.map((id, index) => ({ id, companyId: scope.companyId, agentId: scope.agentId,
          source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
          requestedByActorId: opening.authorUserId, requestedAt: new Date(1000 + index),
          payload: { issueId: scope.issueId, _paperclipWakeContext: { wakeReason: ["issue_children_completed", "execution_review_requested", "issue_completed"].includes(scenario) ? scenario : "issue_commented",
            forceFreshSession: scenario === "fresh", wakeCommentIds: index === 0 ? ids.slice(0, 2) : ids.slice(2) } } })));
        const execution = { binding: scope, provider: { kind: provider as "pi_rpc" | "codex" } };
        const event = { eventType: "item.completed" as const, runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          sourceEventId: "drain-final", itemId: "drain:m1:b0", payload: { kind: "agentMessage", channel: "final", text: "Opening answer." } };
        const { steerCommittedQueuedComment } = await import("../../modules/wake-queue/index.js");
        await Promise.all([publishContinuousNativeReply({ db, execution, event, cursor: 171 }), publishContinuousNativeReply({ db, execution, event, cursor: 171 }),
          ...(scenario === "mixed" ? [steerCommittedQueuedComment(db, { ...scope, commentId: ids[1] })] : [])]);
        const wakes = await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.id} in (${sql.join(wakeIds.map(id => sql`${id}`), sql`, `)})`);
        expect(wakes.map(wake => wake.status)).toEqual(wakeIds.map(() => shouldDrain ? "cancelled" : "deferred_issue_execution"));
        expect(heldSteering.sent).toEqual(shouldDrain ? ids : []);
        if (shouldDrain) {
          const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
          expect(Object.keys(saved.resultJson!.queuedSteeringAcknowledgements as object).sort()).toEqual([...ids].sort());
          // A new message admitted while held must first consume an older head.
          const lateIds = [randomUUID(), randomUUID()];
          await db.insert(issueComments).values(lateIds.map(id => ({ id, companyId: scope.companyId, issueId: scope.issueId,
            authorType: "user" as const, authorUserId: opening.authorUserId, body: "A later held message" })));
          await db.insert(agentWakeupRequests).values(lateIds.map((id, index) => ({ companyId: scope.companyId, agentId: scope.agentId,
            source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedAt: new Date(2000 + index),
            payload: { issueId: scope.issueId, _paperclipWakeContext: { wakeReason: "issue_commented", wakeCommentIds: [id] } } })));
          await deliverConversationComments(db, { id: scope.issueId, companyId: scope.companyId, conversationAgentId: scope.agentId }, async () => null);
          expect(heldSteering.sent).toEqual([...ids, ...lateIds]);
        }
      } });
      // End-of-run finalization/recovery cannot promote a wake already consumed by normal steering.
      const before = [...heldSteering.sent];
      await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
      await requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId });
      expect(heldSteering.sent).toEqual(before);
      if (shouldDrain) expect(await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")))).toEqual([]);
    } finally {
      heldSteering.available = false;
      if (steeringFlag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = steeringFlag;
    }
  });

  it.each(["turn.started", "turn.accepted"] as const)("drains a cold-start deferred person wake at committed %s, not again at the final", async eventType => {
    const commentId = randomUUID(), wakeId = randomUUID();
    const steeringFlag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.sent = [];
    heldSteering.available = false;
    try {
      await fixture(true, { beforeFinalize: async scope => {
        await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
        await db.insert(issueComments).values({ id: commentId, companyId: scope.companyId, issueId: scope.issueId,
          authorType: "user", authorUserId: opening.authorUserId, body: "Sent while Starting…" });
        await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: scope.companyId, agentId: scope.agentId,
          source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution",
          requestedByActorType: "user", requestedByActorId: opening.authorUserId,
          payload: { issueId: scope.issueId, _paperclipWakeContext: { wakeReason: "issue_commented", wakeCommentIds: [commentId] } } });
        const execution = { binding: scope, provider: { kind: "pi_rpc" as const } };
        const port = new PaperclipControlPlanePort(db, { ...scope, sessionId: run.nativeSessionId!,
          sourceInstanceId: run.runnerInstanceId!, controlPlaneSourceInstanceId: "cold-start-control",
          completionContractId: run.completionContractId!, completionContractSha256: run.completionContractSha256! }, {
          onCommittedEvent: async (event, cursor) => { await publishContinuousNativeReply({ db, execution, event, cursor }); },
          onDuplicateEvent: async (event, cursor) => { await publishContinuousNativeReply({ db, execution, event, cursor }); },
        });
        const event: PrpEvent = { schema: "paperclip.prp.event.v1", schemaVersion: 1,
          sourceEventId: `${run.runnerInstanceId}:cold-start`, sourceInstanceId: run.runnerInstanceId!, sourceSeq: 1,
          sourceKind: "runner", runId: scope.runId, normalizedSessionId: run.nativeSessionId!, turnId: "held-turn",
          eventType, priority: 0, emittedAt: new Date().toISOString(), payload: {} };
        // Admission during startup cannot send before the provider owns a turn.
        await deliverConversationComments(db, { id: scope.issueId, companyId: scope.companyId, conversationAgentId: scope.agentId }, async () => null);
        expect(heldSteering.sent).toEqual([]);
        expect(run.resultJson?.continuousReplies).toBeUndefined();
        heldSteering.available = true;
        let acknowledge!: () => void;
        heldSteering.ack = new Promise<void>(resolve => { acknowledge = resolve; });
        const started = port.appendEvent(event);
        try {
          // Ingestion must return and accept a later event even while steering
          // waits for the provider. A replay must not send the queued head twice.
          await expect(Promise.race([started.then(receipt => receipt.disposition),
            new Promise(resolve => setTimeout(() => resolve("blocked_by_steering"), 1000))])).resolves.toBe("committed");
          await vi.waitFor(() => expect(heldSteering.sent).toEqual([commentId]));
          expect((await port.appendEvent(event)).disposition).toBe("duplicate");
          expect((await port.appendEvent({ ...event, eventType: "item.started", sourceSeq: 2,
            sourceEventId: `${run.runnerInstanceId}:after-start`, itemId: "cold-final:m1:b0" })).disposition).toBe("committed");
        } finally {
          acknowledge();
          await started;
          heldSteering.ack = undefined;
        }
        await vi.waitFor(async () => {
          const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
          const [steered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
          expect(wake.status).toBe("cancelled");
          expect(steered.resultJson?.queuedSteeringAcknowledgements).toMatchObject({ [commentId]: { status: "acknowledged" } });
          expect(steered.resultJson?.continuousReplies).toBeUndefined();
        });
        await port.appendEvent({ ...event, eventType: "item.completed", sourceSeq: 3,
          sourceEventId: `${run.runnerInstanceId}:cold-final`, itemId: "cold-final:m1:b0",
          payload: { kind: "agentMessage", channel: "final", text: "Opening answer including your startup message." } });
        expect(heldSteering.sent).toEqual([commentId]);
        const [answered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        expect(answered.resultJson?.continuousReplies).toMatchObject({ "cold-final:m1:b0": { questionCommentIds: [opening.id, commentId] } });
      } });
    } finally {
      heldSteering.available = false;
      if (steeringFlag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = steeringFlag;
    }
  });

  // RFL 0462 exact probes: real PostgreSQL claims, board selection and publication.
  async function seamInputs(scope: { companyId: string; issueId: string; runId: string; agentId: string }) {
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
    const queueComment = async (body: string, agent = false) => {
      const [comment] = await db.insert(issueComments).values({ companyId: scope.companyId, issueId: scope.issueId,
        authorType: agent ? "agent" : "user", authorUserId: agent ? null : opening.authorUserId,
        authorAgentId: agent ? scope.agentId : null, body }).returning();
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
        source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: opening.authorUserId,
        payload: { issueId: scope.issueId, _paperclipWakeContext: { wakeReason: "issue_commented", wakeCommentIds: [comment.id] } } }).returning();
      return { comment, wake };
    };
    const c = await queueComment("C: also check production");
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: scope.companyId, issueId: scope.issueId,
      kind: "ask_user_questions", status: "answered", sourceRunId: scope.runId, createdByAgentId: scope.agentId,
      resolvedByUserId: opening.authorUserId, resolvedAt: new Date(), title: "Choose environment",
      payload: { version: 1, questions: [{ id: "env", prompt: "Which environment?", selectionMode: "single", required: true,
        options: [{ id: "production", label: "Production" }] }] },
      result: { version: 1, answers: [{ questionId: "env", optionIds: ["production"] }] } }).returning();
    const [cardWake] = await db.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
      source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: opening.authorUserId,
      payload: { issueId: scope.issueId, mutation: "interaction", interactionId: card.id, interactionStatus: "answered" } }).returning();
    const input = await claimFirstTurnQueuedInput(db, scope);
    expect(input).toContain(c.comment.id); expect(input).toContain(card.id);
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId)))[0];
    const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, scope.companyId));
    const board = async () => {
      const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
      return readBoardQueuedComments({ executor: db, issue, activeRun: await readRun(),
        actor: { actorType: "user", actorId: opening.authorUserId!, agentId: null, runId: null, agentApiKeyId: null } });
    };
    const publish = async (itemId: string, answers: string[], cursor = 180) => publishContinuousNativeReply({ db, cursor,
      execution: { binding: scope, provider: { kind: "pi_rpc" } }, event: { eventType: "item.completed", runId: scope.runId,
        normalizedSessionId: run.nativeSessionId!, sourceEventId: itemId, itemId,
        payload: { kind: "agentMessage", channel: "final", text: `Reply ${itemId}`, answers } } });
    return { run, opening, c, card, cardWake, input, queueComment, readRun, wakes, board, publish };
  }

  it.each(["empty", "other", "opening-first"] as const)("0462 RFL: retains submitted-input aliases until actually answered (%s first final)", async mode => {
    heldSteering.available = false;
    await fixture(true, { beforeFinalize: async scope => {
      const s = await seamInputs(scope);
      const other = await s.queueComment("Unrelated question");
      if (mode !== "opening-first") {
        await s.publish("rfl-F1", mode === "empty" ? [] : [other.comment.id]);
        const first = (await s.readRun()).resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
        expect(first["rfl-F1"].questionCommentIds).toEqual(mode === "empty" ? [] : [other.comment.id]);
        expect((await s.wakes()).filter(w => [s.c.wake.id, s.cardWake.id].includes(w.id)).map(w => w.status))
          .toEqual(["deferred_issue_execution", "deferred_issue_execution"]);
        // Claimed but unanswered input stays hidden, not consumed.
        expect((await s.board()).entries.map(e => e.comment.id)).not.toContain(s.card.id);
      }
      await s.publish("rfl-F2", [s.opening.id], 181);
      const saved = await s.readRun();
      const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      expect(replies["rfl-F2"].questionCommentIds).toEqual([s.opening.id, s.c.comment.id, s.card.id]);
      expect((await s.wakes()).filter(w => [s.c.wake.id, s.cardWake.id].includes(w.id)).every(w => w.status === "cancelled" && w.finishedAt)).toBe(true);
      await s.publish("rfl-F2", [s.opening.id], 181); // Event replay creates no second comment.
      await s.publish("rfl-F3", [s.opening.id], 182); // Already answered IDs are never reassigned.
      const after = (await s.readRun()).resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      expect(after["rfl-F3"].questionCommentIds).toEqual([]);
      expect((await comments(scope.runId)).map(c => c.body).sort()).toEqual(mode === "opening-first"
        ? ["Reply rfl-F2", "Reply rfl-F3"] : ["Reply rfl-F1", "Reply rfl-F2", "Reply rfl-F3"]);
      console.info("0462_RFL_ALIAS", JSON.stringify({ mode, runId: scope.runId, replies: after,
        wakes: (await s.wakes()).map(w => ({ id: w.id, status: w.status })) }));
    } });
  });

  it.each(["before-acceptance", "after-acceptance", "after-final-ingest"] as const)("0462 RFL: finalization recovers a failed sealed turn without losing its card (%s)", async stage => {
    heldSteering.available = false;
    let s!: Awaited<ReturnType<typeof seamInputs>>;
    const f = await fixture(true, { failed: true, succeed: false, beforeFinalize: async scope => {
      s = await seamInputs(scope);
      if (stage !== "before-acceptance") await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId,
        runId: scope.runId, agentId: scope.agentId, seq: 171, eventType: "turn.accepted", payload: {} });
      if (stage === "after-final-ingest") for (const [index, answers] of [[], [s.opening.id]].entries()) {
        // Ingestion committed; publication never ran. The normal finalizer must
        // recover both finals before release, not infer consumption from claim.
        await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId, runId: scope.runId, agentId: scope.agentId,
          seq: 172 + index, eventType: "item.completed", payload: { prpEvent: { runId: scope.runId,
            normalizedSessionId: s.run.nativeSessionId, sourceEventId: `crash-F${index}`, itemId: `crash-F${index}`,
            payload: { kind: "agentMessage", channel: "final", text: `Recovered F${index}`, answers } } } });
      }
      expect(await comments(scope.runId)).toHaveLength(0);
      expect((await s.wakes()).every(w => w.status === "deferred_issue_execution")).toBe(true);
    } });
    // Use the production terminal projection, not a manual status update.
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await s.readRun()).status).toBe("failed");
    const answered = stage === "after-final-ingest";
    const recoveredWakes = await s.wakes();
    const sealedWakes = recoveredWakes.filter(w => [s.c.wake.id, s.cardWake.id].includes(w.id));
    expect(sealedWakes).toHaveLength(2);
    expect(sealedWakes.every(w => w.status === (answered ? "cancelled" : "deferred_issue_execution"))).toBe(true);
    expect(recoveredWakes.some(w => w.status === "queued" && w.payload?.retryCause === "native_run_failed")).toBe(!answered);
    if (answered) {
      for (let replay = 0; replay < 2; replay++) await recoverCommittedNativeChatResponse(db, f.input);
      expect((await comments(f.runId)).map(c => c.body).sort()).toEqual(["Recovered F0", "Recovered F1"]);
      expect((await s.readRun()).resultJson?.continuousReplies).toMatchObject({ "crash-F0": { questionCommentIds: [] },
        "crash-F1": { questionCommentIds: [s.opening.id, s.c.comment.id, s.card.id] } });
    }
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      nativeSessionId: randomUUID(), runtimeMode: "native", status: "running", responsibleUserId: f.userId,
      retryOfRunId: f.runId, contextSnapshot: (await s.readRun()).contextSnapshot });
    await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    const nextInput = await claimFirstTurnQueuedInput(db, { ...f.input, agentId: f.agentId, runId: nextRunId });
    if (answered) expect(nextInput).toBeNull();
    else { expect(nextInput).toContain(s.card.id); expect(nextInput).toContain('"optionIds": ['); }
    console.info("0462_RFL_RECOVERY", JSON.stringify({ stage, runId: f.runId, nextRunId, nextInput,
      wakes: (await s.wakes()).map(w => ({ id: w.id, status: w.status })) }));
  });

  it("0462 RFL: mixed claimed C plus unclaimed agent A cannot hide later person P from board or drain", async () => {
    const flag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.available = true; heldSteering.sent = [];
    try {
      await fixture(true, { beforeFinalize: async scope => {
        const s = await seamInputs(scope);
        const a = await s.queueComment("A: automated report", true);
        await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, a.wake.id));
        await db.update(agentWakeupRequests).set({ requestedAt: new Date(1000), payload: { issueId: scope.issueId,
          _paperclipWakeContext: { wakeReason: "issue_commented", wakeCommentIds: [s.c.comment.id, a.comment.id] } } })
          .where(eq(agentWakeupRequests.id, s.c.wake.id));
        await s.queueComment("A2: later automated report", true);
        const p = await s.queueComment("P: later human question");
        expect((await s.board()).entries.map(e => e.comment.id)).toEqual([p.comment.id]);
        await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
        expect(heldSteering.sent).toEqual([p.comment.id]);
        await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
        expect(heldSteering.sent).toEqual([p.comment.id]);
        expect((await s.board()).entries.map(e => e.comment.id)).toEqual([a.comment.id]);
        console.info("0462_RFL_SELECTOR", JSON.stringify({ runId: scope.runId, claimedC: s.c.comment.id,
          agentA: a.comment.id, personP: p.comment.id, steers: heldSteering.sent }));
      } });
    } finally {
      heldSteering.available = false;
      if (flag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = flag;
    }
  });

  it.each(["comment-before", "card-before", "card-after", "comment-before-card-after", "card-before-card-after", "comment-window", "card-window"] as const)("seals pending held-conversation input into the submitted turn (%s)", async scenario => {
    const steeringFlag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.available = true; heldSteering.sent = [];
    try {
      await fixture(true, { beforeFinalize: async scope => {
        await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
        const queue = async (card = !scenario.startsWith("comment")) => {
          const id = randomUUID();
          if (card) await db.insert(issueThreadInteractions).values({ id, companyId: scope.companyId, issueId: scope.issueId,
            kind: "ask_user_questions", status: "answered", createdByAgentId: scope.agentId, sourceRunId: scope.runId,
            resolvedByUserId: opening.authorUserId, resolvedAt: new Date(), title: "Which environment?",
            payload: { version: 1, questions: [{ id: "environment", prompt: "Which environment?", selectionMode: "single", required: true,
              options: [{ id: "production", label: "Production" }] }] },
            result: { version: 1, answers: [{ questionId: "environment", optionIds: ["production"] }] } });
          else await db.insert(issueComments).values({ id, companyId: scope.companyId, issueId: scope.issueId,
            authorType: "user", authorUserId: opening.authorUserId, body: "Also check production before replying." });
          const [wake] = await db.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
            source: "on_demand", reason: "issue_execution_deferred", status: "deferred_issue_execution",
            requestedByActorType: "user", requestedByActorId: opening.authorUserId,
            payload: { issueId: scope.issueId, ...(card ? { mutation: "interaction", interactionId: id, interactionStatus: "answered" } : {}),
              _paperclipWakeContext: { wakeReason: "issue_commented", ...(card ? {} : { wakeCommentIds: [id] }) } } }).returning();
          return { id, wakeId: wake.id };
        };
        const inWindow = scenario.endsWith("-window");
        const before = scenario !== "card-after" && !inWindow;
        let pending = before ? await queue() : undefined;
        const input = await claimFirstTurnQueuedInput(db, scope);
        if (before) { expect(input).toContain(pending!.id); expect(input).toContain("production"); }
        else expect(input).toBeNull();
        if (inWindow) {
          // RFL race concern: commit AFTER the seal but BEFORE turn.submitted.
          // This is intentionally later steering, not part of the submitted text.
          pending = await queue();
          expect(await claimFirstTurnQueuedInput(db, scope)).toBe(input);
          const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, scope.runId),
            eq(heartbeatRunEvents.eventType, "turn.submitted")));
          expect(events).toEqual([]);
          const [issue] = await db.select().from(issues).where(eq(issues.id, scope.issueId));
          const [sealedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
          const board = await readBoardQueuedComments({ executor: db, issue, activeRun: sealedRun,
            actor: { actorType: "user", actorId: opening.authorUserId!, agentId: null, runId: null, agentApiKeyId: null } });
          expect(board.entries.map(e => e.comment.id)).toEqual([pending.id]);
        }
        await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId, runId: scope.runId, agentId: scope.agentId,
          seq: 171, eventType: "turn.submitted", payload: {} });
        if (!before && !inWindow) pending = await queue();
        const late = before && scenario.endsWith("card-after") ? await queue(true) : undefined;
        if (before) {
          // A restart reuses the sealed input, never the newly queued answer.
          expect(await claimFirstTurnQueuedInput(db, scope)).toBe(input);
          if (late) expect(input).not.toContain(late.id);
        }
        // The committed provider-start hook must not steer input already sealed,
        // nor let its receipt hide an answer that arrived after submission.
        await drainContinuousPersonMessages(db, { ...scope }, { beforeFirstReply: true });
        const steers = late ? [late.id] : before ? [] : [pending!.id];
        expect(heldSteering.sent).toEqual(steers);
        await publishContinuousNativeReply({ db, execution: { binding: scope, provider: { kind: "pi_rpc" } }, cursor: 172,
          event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
            sourceEventId: `sealed-${scenario}`, itemId: `sealed-${scenario}`, payload: { kind: "agentMessage", channel: "final",
              text: "Production checked.", answers: [opening.id] } } });
        const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        expect(saved.resultJson?.continuousReplies).toMatchObject({ [`sealed-${scenario}`]: {
          questionCommentIds: before ? [opening.id, pending!.id] : [opening.id],
        } });
        const savedReplies = await comments(scope.runId);
        expect(savedReplies).toHaveLength(1);
        expect(heldSteering.sent).toEqual(steers);
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending!.wakeId));
        expect(wake.status).toBe("cancelled");
        expect(wake.finishedAt).not.toBeNull();
        if (inWindow) {
          // The opening final must not claim the early follow-up. Its own exact
          // answer settles once, without a second delivery, even on event replay.
          const event = { eventType: "item.completed" as const, runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
            sourceEventId: `window-${scenario}`, itemId: `window-${scenario}`, payload: { kind: "agentMessage", channel: "final",
              text: "Follow-up answered.", answers: [pending!.id] } };
          for (let replay = 0; replay < 2; replay++) await publishContinuousNativeReply({ db,
            execution: { binding: scope, provider: { kind: "pi_rpc" } }, cursor: 173, event });
          const [answered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
          expect(answered.resultJson?.continuousReplies).toMatchObject({ [`window-${scenario}`]: { questionCommentIds: [pending!.id] } });
          expect(await comments(scope.runId)).toHaveLength(2);
          expect(heldSteering.sent).toEqual([pending!.id]);
        }
        console.info("FIRST_TURN_SEAM_ROW", JSON.stringify({ scenario, runId: scope.runId, inputId: pending!.id,
          lateInputId: late?.id, firstTurnInput: input, wakeStatus: wake.status, savedReplies: savedReplies.length,
          steers: heldSteering.sent, replies: saved.resultJson?.continuousReplies }));
      } });
    } finally {
      heldSteering.available = false;
      if (steeringFlag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = steeringFlag;
    }
  });

  it.each([70_000, 300_000])("stores and publishes one complete held final past diagnostic caps (%i chars)", async size => {
    const answer = "word ".repeat(size / 5);
    const f = await fixture(true, { reply: answer, beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const execution = { binding: scope, provider: { kind: "pi_rpc" as const } };
      const port = new PaperclipControlPlanePort(db, { ...scope, sessionId: run.nativeSessionId!, sourceInstanceId: run.runnerInstanceId!,
        controlPlaneSourceInstanceId: "large-final-control", completionContractId: run.completionContractId!, completionContractSha256: run.completionContractSha256! }, {
        onCommittedEvent: async (event, cursor) => { await publishContinuousNativeReply({ db, execution, event, cursor }); },
        onDuplicateEvent: async (event, cursor) => { await publishContinuousNativeReply({ db, execution, event, cursor }); },
      });
      const event: PrpEvent = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `${run.runnerInstanceId}:large-final`,
        sourceInstanceId: run.runnerInstanceId!, sourceSeq: 1, sourceKind: "runner", runId: scope.runId,
        normalizedSessionId: run.nativeSessionId!, turnId: "held-turn", itemId: "large-final:m1:b0", eventType: "item.completed",
        priority: 0, emittedAt: new Date().toISOString(), payload: { kind: "agentMessage", channel: "final", text: answer, answers: [] } };
      expect((await port.appendEvent(event)).disposition).toBe("committed");
      expect((await port.appendEvent(event)).disposition).toBe("duplicate");
      const [saved] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, scope.runId),
        eq(heartbeatRunEvents.sourceEventId, event.sourceEventId)));
      expect((saved.payload as { prpEvent: PrpEvent }).prpEvent.payload).toMatchObject({ kind: "agentMessage", channel: "final", text: answer });
      expect((await comments(scope.runId)).map(comment => comment.body)).toEqual([answer]);
    } });
    await recoverCommittedNativeChatResponse(db, f.input);
    expect((await comments(f.runId)).map(comment => comment.body)).toEqual([answer]);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    expect(events.some(event => event.eventType === "turn.submitted")).toBe(false);
    expect(events.some(event => event.message?.includes("without a semantic result"))).toBe(false);
  });

  it.each(["same", "same-legacy", "same-explicit-empty", "same-late-ack", "same-final-first", "fresh", "missing-entry", "unreadable"] as const)("does not re-steer ACKed input into the same Pi session (%s retry)", async mode => {
    const f = await fixture();
    const commentId = randomUUID(), queueId = randomUUID(), retryId = randomUUID();
    const steeringFlag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.sent = [];
    heldSteering.available = true;
    try {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: "C: what is 260 plus 5?" });
      // Deliver C through the actual board/ACK transaction into R1.
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
        source: "issue", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: f.userId,
        payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [commentId] } } });
      await drainContinuousPersonMessages(db, { ...f.input, agentId: f.agentId }, { beforeFirstReply: true });
      expect(heldSteering.sent).toEqual([commentId]);
      const [r1] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(r1.resultJson?.queuedSteeringAcknowledgements).toMatchObject({ [commentId]: { status: "acknowledged" } });
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId });
      const sessionId = mode !== "fresh" ? r1.nativeSessionId! : randomUUID();
      const openingId = mode === "same-legacy" ? randomUUID() : null;
      if (openingId) await db.insert(issueComments).values({ id: openingId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: "D: confirm C's sum too." });
      await db.insert(heartbeatRuns).values({ id: retryId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, nativeSessionId: sessionId, retryOfRunId: f.runId,
        runnerInstanceId: randomUUID(), runtimeMode: "native", status: "running", responsibleUserId: f.userId,
        contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, ...(openingId ? { wakeCommentId: openingId } : {}) } });
      await db.update(issues).set({ executionRunId: retryId }).where(eq(issues.id, f.issueId));
      const scope = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: retryId };
      // Retention is not answer attribution. A valid inferred retry must also
      // carry C's exact revision or its reply instruction in the selected turn.
      // Keep wake identity absent: reconciliation must not manufacture it.
      if (mode === "same-legacy" || mode === "same-late-ack") {
        const [carried] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
        const [opening] = openingId ? await db.select().from(issueComments).where(eq(issueComments.id, openingId)) : [];
        const message = { id: commentId, updatedAt: carried.updatedAt.toISOString(), body: carried.body };
        const received = { id: commentId, updatedAt: message.updatedAt, receivedAt: message.updatedAt, answered: false };
        const extra = opening ? [{ id: opening.id, updatedAt: opening.updatedAt.toISOString(), body: opening.body }] : [];
        await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { continuationPrompt: JSON.stringify({
          messages: extra, replyInstructions: [`Reply to the comment you received at ${received.receivedAt} (id ${commentId}).`],
        }) } }, contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0,
          ...(openingId ? { wakeCommentId: openingId } : {}), executionContinuation: { messages: [message, ...extra], resumeDelta: { receivedComments: [received] } } },
        }).where(eq(heartbeatRuns.id, retryId));
      }
      heldSteering.sent = [];
      heldSteering.userMessages = mode === "unreadable" ? null : mode === "missing-entry" ? [] : ["C: what is 260 plus 5?"];
      heldSteering.userInputIds = mode === "unreadable" ? null : mode === "missing-entry" ? [] : [commentId];
      const inherited = mode.startsWith("same");
      if (mode !== "same-final-first") {
        await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
        await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
      }
      if (mode === "same") {
        // A second failure before the final must not strand the settled wake:
        // the inherited input is still an unanswered delivery receipt.
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, retryId));
        await requeueContinuousUnanswered(db, { id: retryId, companyId: f.companyId });
        const deferred = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution")));
        expect(deferred.some(wake => JSON.stringify(wake.payload).includes(commentId))).toBe(true);
        await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, retryId));
        await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
      }
      expect(heldSteering.sent).toEqual(inherited ? [] : [commentId]);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      // Fresh delivery adopts the input identity into this run; retained
      // reconciliation does not re-deliver or manufacture a wake identity.
      if (inherited) expect(retry.contextSnapshot).not.toHaveProperty("wakeCommentIds");
      else expect(retry.contextSnapshot?.wakeCommentIds).toContain(commentId);
      const board = await readBoardQueuedComments({ executor: db, issue, activeRun: retry,
        actor: { actorType: "user", actorId: f.userId, agentId: null, runId: null, agentApiKeyId: null } });
      expect(board.entries.map(entry => entry.comment.id)).toEqual(mode === "same-final-first" ? [commentId] : []);
      const lateId = mode === "same-late-ack" ? randomUUID() : null;
      if (lateId) {
        // C was inherited at the resumed turn's start; D is only ACKed later.
        await db.insert(issueComments).values({ id: lateId, companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: f.userId, body: "D: answer this after C" });
        await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
          source: "issue", reason: "issue_commented", status: "deferred_issue_execution",
          payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [lateId] } } });
        await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
        expect(heldSteering.sent).toEqual([lateId]);
      }
      const event = { eventType: "item.completed" as const, runId: retryId, normalizedSessionId: sessionId,
        sourceEventId: "retry-final", itemId: "retry:m1:b0", payload: { kind: "agentMessage", channel: "final", text: "265",
          // Same-session resumed Pi has no new command correlation for C.
          ...(mode === "same-legacy" || mode === "same-late-ack" ? {} : { answers: mode === "same-explicit-empty" ? [] : [commentId] }) } };
      for (let replay = 0; replay < 2; replay++) await publishContinuousNativeReply({ db, execution: { binding: scope,
        provider: { kind: "pi_rpc" } }, event, cursor: 200 });
      expect((await comments(retryId)).map(c => c.body)).toEqual(["265"]);
      const [answered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
      expect(answered.resultJson?.continuousReplies).toMatchObject({ "retry:m1:b0": {
        questionCommentIds: mode === "same-explicit-empty" ? [] : [commentId, ...(openingId ? [openingId] : [])] } });
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).toEqual([]);
      expect(heldSteering.sent).toEqual(lateId ? [lateId] : inherited ? [] : [commentId]);
      if (lateId || mode === "same-explicit-empty") {
        expect(await answeredContinuousHeldRun(db, scope)).toBe(false);
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, retryId));
        await requeueContinuousUnanswered(db, { id: retryId, companyId: f.companyId });
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `continuous-unanswered:${retryId}`));
        expect(wake).toMatchObject({ status: "deferred_issue_execution",
          payload: { _paperclipWakeContext: { wakeCommentIds: [lateId ?? commentId] } } });
        console.info("LATE_ACK_PROOF", JSON.stringify({ retryId, inheritedC: commentId, lateD: lateId,
          replies: answered.resultJson?.continuousReplies, requeued: wake.payload }));
      }
      console.info("RESTEER_PROOF", JSON.stringify({ mode, sourceRunId: f.runId, retryRunId: retryId,
        sourceSessionId: r1.nativeSessionId, retrySessionId: sessionId, commentId,
        additionalDeliveries: heldSteering.sent.length, answerBodies: (await comments(retryId)).map(c => c.body),
        replies: answered.resultJson?.continuousReplies }));
    } finally {
      heldSteering.available = false; heldSteering.userInputIds = null;
      if (steeringFlag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = steeringFlag;
    }
  });

  it.each(["retained", "missing", "unreadable", "ambiguous", "legacy-text"] as const)("0458: inherits the exact ACKed card answer in a same-session retry (%s)", async mode => {
    const f = await fixture();
    const interactionId = randomUUID(), queueId = randomUUID(), retryId = randomUUID();
    const steeringFlag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.available = true; heldSteering.sent = []; heldSteering.userMessages = null;
    try {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
      const [interaction] = await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: f.companyId, issueId: f.issueId,
        kind: "ask_user_questions", status: "answered", sourceRunId: f.runId, createdByAgentId: f.agentId,
        title: "Choose a color", payload: { version: 1, questions: [{ id: "color", prompt: "Which color?", selectionMode: "single",
          required: true, options: [{ id: "green", label: "Green" }] }] }, resolvedAt: new Date(), resolvedByUserId: f.userId,
        result: { version: 1, answers: [{ questionId: "color", optionIds: ["green"] }] } }).returning();
      const { queuedInteractionSteeringBody } = await import("../queued-interaction-response.js");
      const text = queuedInteractionSteeringBody(interaction);
      await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId,
        source: "issue", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: f.userId,
        payload: { issueId: f.issueId, mutation: "interaction", interactionId, interactionStatus: "answered" } });
      await drainContinuousPersonMessages(db, { ...f.input, agentId: f.agentId }, { beforeFirstReply: true });
      expect(heldSteering.sent).toEqual([interactionId]);
      const [r1] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(r1.resultJson?.queuedSteeringAcknowledgements).toMatchObject({ [interactionId]: { status: "acknowledged" } });
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      // Reconciliation has restored the typed response wake after R1 failed.
      await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", finishedAt: null }).where(eq(agentWakeupRequests.id, queueId));
      await db.insert(heartbeatRuns).values({ id: retryId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
        nativeSessionId: r1.nativeSessionId, retryOfRunId: f.runId, runtimeMode: "native", status: "running", responsibleUserId: f.userId,
        contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0 } });
      await db.update(issues).set({ executionRunId: retryId }).where(eq(issues.id, f.issueId));
      if (mode === "ambiguous") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: text });
      heldSteering.sent = [];
      heldSteering.userMessages = mode === "unreadable" ? null : mode === "missing" ? [] : [text];
      heldSteering.userInputIds = mode === "unreadable" || mode === "legacy-text" ? null : mode === "retained" ? [interactionId] : [];
      const scope = { ...f.input, runId: retryId, agentId: f.agentId };
      await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
      await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
      expect(heldSteering.sent).toEqual(mode === "retained" ? [] : [interactionId]);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
      expect(wake.status).toBe("cancelled");
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
      if (mode === "retained") expect(retry.resultJson?.continuedSessionInput).toMatchObject({ commentIds: [interactionId] });
      await publishContinuousNativeReply({ db, cursor: 200, execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: retryId, normalizedSessionId: r1.nativeSessionId!, sourceEventId: "card-retry-final",
          itemId: "card-retry-final", payload: { kind: "agentMessage", channel: "final", text: "Green it is.", answers: [interactionId] } } });
      expect((await comments(retryId)).map(comment => comment.body)).toEqual(["Green it is."]);
      console.info("0458_CARD_PROOF", JSON.stringify({ mode, sourceRunId: f.runId, retryId, interactionId,
        additionalSteers: heldSteering.sent.length, wakeStatus: wake.status, inherited: retry.resultJson?.continuedSessionInput }));
    } finally {
      heldSteering.available = false; heldSteering.userMessages = null; heldSteering.userInputIds = null;
      if (steeringFlag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = steeringFlag;
    }
  });

  it.each(["answered", "unanswered", "restored"] as const)("0458: reconciliation does not wake an answered held crash (%s)", async mode => {
    const f = await fixture(true, { failed: true, succeed: false, disposition: "needs_review", beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      await publishContinuousNativeReply({ db, cursor: 170, execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!, sourceEventId: "sweep-held-answer",
          itemId: "sweep-held-answer", payload: { kind: "agentMessage", channel: "final", text: "265", answers: [String(run.contextSnapshot!.wakeCommentId)] } } });
      await db.update(heartbeatRuns).set({ errorCode: "adapter_failed", error: "Native session failed" }).where(eq(heartbeatRuns.id, scope.runId));
    } });
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    expect(decision.reasonCode).toBe("continuous_held_input_already_answered");
    const [committedIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(committedIssue).toMatchObject({ executionRunId: null, checkoutRunId: null });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
      contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || '{"retryReason":"held_session_reconnected"}'::jsonb`,
    }).where(eq(heartbeatRuns.id, f.runId));
    let unansweredId: string | undefined;
    if (mode === "unanswered") {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: "And what is 265 plus 1?" }).returning();
      unansweredId = comment.id;
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0,
        wakeCommentIds: [f.wakeId, unansweredId], retryReason: "held_session_reconnected" } }).where(eq(heartbeatRuns.id, f.runId));
    }
    const { issueRecoveryActions } = await import("@paperclipai/db");
    if (mode === "restored") await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: f.agentId,
      cause: "fresh_continuation", fingerprint: `fresh-continuation:${f.runId}`, resolvedAt: new Date(), nextAction: "Continue from saved work.",
      evidence: { runId: f.runId, continuationDelivery: "pending", executionReconciliation: { runId: f.runId,
        providerStopped: true, actionOutcome: "mixed", outcomeEvidence: "Historical automatic restoration after a held crash." } } });
    // Also exercise the watchdog against stale ownership from the earlier
    // build, before system recovery adoption and fresh-continuation sweep.
    const { createPostgresWakeQueueAdapter } = await import("../../modules/wake-queue/adapters/postgres.js");
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => f.userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    await adapter.withIssueExecutionLock({ companyId: f.companyId, runId: f.runId, now: new Date() },
      async () => { throw new Error("the terminal recovery producer owns this release"); });
    const [released] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(released.status).toBe(mode === "unanswered" ? "blocked" : "in_progress");
    const { settleUnrecoverableExecutions } = await import("../execution-recovery-resolution.js");
    const { continueHeldExecutions } = await import("../fresh-continuation-fallback.js");
    const reconciliationNow = new Date(Date.now() + 16 * 60_000);
    await settleUnrecoverableExecutions(db, reconciliationNow);
    await continueHeldExecutions(db, reconciliationNow);
    const { continueSweepTaskFromSavedWork } = await import("../recovery/sweep-saved-work-continuation.js");
    const sweep = await continueSweepTaskFromSavedWork(db, { companyId: f.companyId, issueId: f.issueId,
      latestRun: { id: f.runId, status: "failed", errorCode: "adapter_failed", finishedAt: new Date(), settlingUntil: null, operatorStopped: false } },
      reconciliationNow);
    const { deliverReconciledExecutions } = await import("../execution-recovery-resolution.js");
    const wake = vi.fn<Parameters<typeof deliverReconciledExecutions>[1]>(async (agentId, options) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, nativeIssueId: f.issueId,
        status: "queued", contextSnapshot: options?.contextSnapshot }).returning();
      return run;
    });
    await deliverReconciledExecutions(db, wake);
    expect(wake).toHaveBeenCalledTimes(mode === "unanswered" ? 1 : 0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(mode === "unanswered" ? 2 : 1);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    if (mode === "answered") expect(actions).toEqual([]);
    if (mode === "restored") expect(actions[0].evidence.continuationDelivery).toBe("invalidated");
    if (unansweredId) expect(JSON.stringify(wake.mock.calls[0])).toContain(unansweredId);
    const [after] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(after.status).not.toBe("blocked");
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
      .some(comment => comment.body.includes("New session"))).toBe(false);
    console.info("0458_SWEEP_PROOF", JSON.stringify({ mode, sourceRunId: f.runId, reasonCode: decision.reasonCode,
      sweep, committedOwnership: { executionRunId: committedIssue.executionRunId, checkoutRunId: committedIssue.checkoutRunId },
      issueStatus: after.status, wakes: wake.mock.calls.length, newRuns: mode === "unanswered" ? 1 : 0, actions: actions.map(a => ({ id: a.id, delivery: a.evidence.continuationDelivery })) }));
    if (mode === "answered") {
      // A new person's message still uses ordinary wake admission and runs.
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: "Now tell me 265 plus 1." }).returning();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: f.userId,
        principalType: "user", status: "active", membershipRole: "member" });
      await db.update(issues).set({ responsibleUserId: f.userId }).where(eq(issues.id, f.issueId));
      await db.update(agents).set({ status: "idle", adapterConfig: {
        provider: "pi_rpc", sessionContinuity: "continuous", model: "test/model",
      } }).where(eq(agents.id, f.agentId));
      const { getServerAdapter, registerServerAdapter } = await import("../../adapters/index.js");
      const nativeMode = await import("./runtime-mode.js"), savedAdapter = getServerAdapter("paperclip_runner");
      const dispatched: string[] = [];
      registerServerAdapter({ ...savedAdapter, execute: async input => {
        dispatched.push(input.runId);
        expect(input.context.wakeCommentIds).toContain(comment.id);
        await issueService(db).addComment(f.issueId, "266", { agentId: f.agentId, runId: input.runId });
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {}, summary: "New question answered" };
      } });
      const resolver = vi.spyOn(nativeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({ kind: "legacy",
        reason: "persisted_legacy_selection", resolverVersion: nativeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
      const heartbeat = (await import("../heartbeat.js")).heartbeatService(db);
      try {
        await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
          requestedByActorType: "user", requestedByActorId: f.userId,
          payload: { issueId: f.issueId, commentId: comment.id },
          contextSnapshot: { issueId: f.issueId, wakeCommentIds: [comment.id] } });
        await heartbeat.drainActiveRunExecutions();
        expect(dispatched).toHaveLength(1);
        expect((await comments(dispatched[0])).map(row => row.body)).toEqual(["266"]);
        console.info("0458_LATER_PERSON_PROOF", JSON.stringify({ sourceRunId: f.runId, commentId: comment.id, newRunId: dispatched[0], answer: "266" }));
      } finally {
        await heartbeat.drainActiveRunExecutions();
        resolver.mockRestore(); registerServerAdapter(savedAdapter);
      }
    }
  });

  it("does not start an unasked retry after a held Pi run answered everything then crashed", async () => {
    const f = await fixture(true, { failed: true, succeed: false, disposition: "needs_review", beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      await publishContinuousNativeReply({ db, cursor: 170, execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          sourceEventId: "held-answer", itemId: "held-answer", payload: { kind: "agentMessage", channel: "final", text: "265", answers: [String(run.contextSnapshot!.wakeCommentId)] } } });
      await db.update(heartbeatRuns).set({ errorCode: "adapter_failed", error: "Native session failed" }).where(eq(heartbeatRuns.id, scope.runId));
    } });
    expect((await comments(f.runId)).map(comment => comment.body)).toEqual(["265"]);
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    expect(decision.reasonCode).toBe("continuous_held_input_already_answered");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
    const { heartbeatService } = await import("../heartbeat.js");
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).toMatchObject({ dispatched: 0 });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect((await comments(f.runId)).map(comment => comment.body)).toEqual(["265"]);
    console.info("HELD_CRASH_PROOF", JSON.stringify({ sourceRunId: f.runId, reasonCode: decision.reasonCode, newRuns: 0, newReplies: 0 }));
  });

  it.each(["deferred", "queued", "pending", "delivering", "fallback_queued", "delivered"] as const)(
    "keeps the failed held-run retry when a card response remains pending (%s)", async mode => {
      const interactionId = randomUUID();
      const f = await fixture(true, { failed: true, succeed: false, disposition: "needs_review", beforeFinalize: async scope => {
        await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        await publishContinuousNativeReply({ db, cursor: 170, execution: { binding: scope, provider: { kind: "pi_rpc" } },
          event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
            sourceEventId: "answered-comments", itemId: "answered-comments", payload: { kind: "agentMessage", channel: "final", text: "All comments answered",
              answers: [String(run.contextSnapshot!.wakeCommentId)] } } });
        await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: scope.companyId, issueId: scope.issueId,
          kind: "ask_user_questions", status: "answered", sourceRunId: scope.runId, createdByAgentId: scope.agentId,
          payload: { version: 1, questions: [{ id: "color", prompt: "Which color?", selectionMode: "single", required: true,
            options: [{ id: "green", label: "Green" }] }] }, resolvedAt: new Date(), resolvedByUserId: run.responsibleUserId,
          result: { version: 1, answers: [{ questionId: "color", optionIds: ["green"] }] } });
        if (mode === "deferred" || mode === "queued" || mode === "fallback_queued") {
          await db.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
            source: "issue", reason: "issue_commented", status: mode === "deferred" ? "deferred_issue_execution" : "queued",
            payload: { issueId: scope.issueId, mutation: "interaction", interactionId, interactionStatus: "answered" } });
        }
        if (mode !== "deferred" && mode !== "queued") {
          await db.insert(issueQuestionResponseDeliveries).values({ companyId: scope.companyId, issueId: scope.issueId,
            interactionId, sourceRunId: scope.runId, correlationId: `question-response:${interactionId}`,
            payloadSha256: "test-response-digest", status: mode });
        }
        expect(await answeredContinuousHeldRun(db, scope)).toBe(false);
        await db.update(heartbeatRuns).set({ errorCode: "adapter_failed", error: "Native session failed" }).where(eq(heartbeatRuns.id, scope.runId));
      } });
      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
      expect(decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
      const retries = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.idempotencyKey, `native-status:${decision.id}:retry`)));
      expect(retries).toHaveLength(1);
      console.info("CARD_RETRY_PROOF", JSON.stringify({ mode, runId: f.runId, interactionId,
        reasonCode: decision.reasonCode, retryWakeId: retries[0].id, retryStatus: retries[0].status }));
      // RFL 0463: terminal transport receipts are not agent answers. The durable
      // card remains owed even when every wake/outbox receipt is terminal.
      await db.update(agentWakeupRequests).set({ status: "completed" }).where(and(
        eq(agentWakeupRequests.companyId, f.companyId), sql`${agentWakeupRequests.payload}->>'interactionId' = ${interactionId}`));
      await db.update(issueQuestionResponseDeliveries).set({ status: mode === "fallback_queued" ? mode : "delivered" })
        .where(eq(issueQuestionResponseDeliveries.interactionId, interactionId));
      expect(await answeredContinuousHeldRun(db, { ...f.input, agentId: f.agentId })).toBe(false);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, nativeSessionId: source.nativeSessionId, runtimeMode: "native", status: "running",
        contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0 } }).returning();
      await db.update(issues).set({ executionRunId: successor.id }).where(eq(issues.id, f.issueId));
      await publishContinuousNativeReply({ db, cursor: 180,
        execution: { binding: { ...f.input, runId: successor.id, agentId: f.agentId }, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: successor.id, normalizedSessionId: source.nativeSessionId!,
          sourceEventId: "terminal-card-answer", itemId: "terminal-card-answer", payload: { kind: "agentMessage", channel: "final",
            text: "Green it is.", answers: [interactionId] } } });
      expect((await comments(successor.id)).map(comment => comment.body)).toEqual(["Green it is."]);
      expect(await answeredContinuousHeldRun(db, { ...f.input, agentId: f.agentId })).toBe(true);
      console.info("0463_TERMINAL_CARD_PROOF", JSON.stringify({ mode, sourceRunId: f.runId, interactionId, answerRunId: successor.id }));
    });

  it.each(["old-card-only", "copied-comment"] as const)("0463 RFL: retained identity distinguishes an old answered card from a later copied comment (%s)", async mode => {
    const f = await fixture();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", sourceRunId: f.runId, createdByAgentId: f.agentId,
      resolvedAt: new Date(), resolvedByUserId: f.userId,
      payload: { version: 1, questions: [{ id: "color", prompt: "Which color?", selectionMode: "single", required: true,
        options: [{ id: "green", label: "Green" }] }] },
      result: { version: 1, answers: [{ questionId: "color", optionIds: ["green"] }] } }).returning();
    const { queuedInteractionSteeringBody } = await import("../queued-interaction-response.js");
    const text = queuedInteractionSteeringBody(card);
    const [copy] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: text }).returning();
    const retryId = randomUUID();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { continuousReplies: { old: { questionCommentIds: [card.id, f.wakeId] } },
      queuedSteeringAcknowledgements: { [card.id]: { status: "acknowledged" }, [copy.id]: { status: "acknowledged" } } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ id: retryId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      nativeSessionId: source.nativeSessionId, runtimeMode: "native", status: "running", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0 } });
    heldSteering.userMessages = [text]; // Text is identical in both histories.
    heldSteering.userInputIds = [mode === "old-card-only" ? card.id : copy.id];
    const steeringFlag = process.env.PAPERCLIP_AGENT_CHAT_STEERING;
    process.env.PAPERCLIP_AGENT_CHAT_STEERING = "true";
    heldSteering.available = true; heldSteering.sent = [];
    try {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "issue", reason: "issue_commented", status: "deferred_issue_execution",
        payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [copy.id] } } }).returning();
      await db.update(issues).set({ executionRunId: retryId }).where(eq(issues.id, f.issueId));
      const scope = { ...f.input, runId: retryId, agentId: f.agentId };
      const evidence = await readContinuousSessionInput(db, scope);
      expect(evidence?.commentIds).toEqual(mode === "old-card-only" ? [] : [copy.id]);
      await drainContinuousPersonMessages(db, scope, { beforeFirstReply: true });
      expect(heldSteering.sent).toEqual(mode === "old-card-only" ? [copy.id] : []);
      const [settledWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      expect(settledWake.status).toBe("cancelled");
      console.info("0463_CROSS_TYPE_PROOF", JSON.stringify({ mode, runId: retryId, cardId: card.id, copyId: copy.id, evidence, additionalSteers: heldSteering.sent }));
    } finally {
      heldSteering.available = false; heldSteering.userMessages = null; heldSteering.userInputIds = null;
      if (steeringFlag === undefined) delete process.env.PAPERCLIP_AGENT_CHAT_STEERING;
      else process.env.PAPERCLIP_AGENT_CHAT_STEERING = steeringFlag;
    }
  });

  it.each(["absent", "completed"] as const)("0463 RFL: durable person comment remains unanswered with %s wake", async mode => {
    const f = await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      await publishContinuousNativeReply({ db, cursor: 170, execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          sourceEventId: "inventory-opening", itemId: "inventory-opening", payload: { kind: "agentMessage", channel: "final",
            text: "Opening answered", answers: [String(run.contextSnapshot!.wakeCommentId)] } } });
    } });
    const [person] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "A durable question without a pending transport receipt" }).returning();
    if (mode === "completed") await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "issue", status: "completed", payload: { issueId: f.issueId, commentId: person.id } });
    expect(await answeredContinuousHeldRun(db, f.input)).toBe(false);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, nativeSessionId: source.nativeSessionId, runtimeMode: "native", status: "succeeded",
      resultJson: { continuousReplies: { answer: { questionCommentIds: [person.id] } } } }).returning();
    expect(await answeredContinuousHeldRun(db, f.input)).toBe(true);
    console.info("0463_DURABLE_INPUT_PROOF", JSON.stringify({ mode, sourceRunId: f.runId, inputId: person.id, answerRunId: successor.id }));
  });

  it("0463 RFL: revalidates a historical restoration after the delivery lock is released", async () => {
    const lateId = randomUUID();
    const f = await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      await publishContinuousNativeReply({ db, cursor: 170, execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          sourceEventId: "race-opening", itemId: "race-opening", payload: { kind: "agentMessage", channel: "final",
            text: "Opening answered", answers: [String(run.contextSnapshot!.wakeCommentId)] } } });
    } });
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, wakeCommentIds: [f.wakeId, lateId] } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(issueComments).values({ id: lateId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "Answer this before the delayed recovery wakes" });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: f.userId,
      principalType: "user", status: "active", membershipRole: "member" });
    await db.update(issues).set({ responsibleUserId: f.userId, executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const { issueRecoveryActions } = await import("@paperclipai/db");
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: f.agentId,
      cause: "fresh_continuation", fingerprint: `historical-race:${f.runId}`, resolvedAt: new Date(), nextAction: "Continue saved work",
      evidence: { continuationDelivery: "pending", executionReconciliation: { runId: f.runId, providerStopped: true,
        actionOutcome: "mixed", outcomeEvidence: "Historical restoration with no freshContinuation.recordedAt" } } }).returning();
    const { heartbeatService } = await import("../heartbeat.js");
    const heartbeat = heartbeatService(db);
    const { deliverReconciledExecutions } = await import("../execution-recovery-resolution.js");
    let successorId: string | undefined;
    let attempted = false;
    try {
      await deliverReconciledExecutions(db, async (agentId, options) => {
        attempted = true;
        // Exact RFL window: delivery's locked verdict was false, then the
        // ordinary person's run answers before the real wake admission lock.
        const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          nativeIssueId: f.issueId, nativeSessionId: source.nativeSessionId, runtimeMode: "native", status: "running",
          contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, wakeCommentIds: [lateId] } }).returning();
        successorId = successor.id;
        await db.update(issues).set({ executionRunId: successor.id }).where(eq(issues.id, f.issueId));
        await publishContinuousNativeReply({ db, cursor: 180, execution: { binding: { ...f.input, runId: successor.id, agentId: f.agentId }, provider: { kind: "pi_rpc" } },
          event: { eventType: "item.completed", runId: successor.id, normalizedSessionId: source.nativeSessionId!,
            sourceEventId: "race-person-answer", itemId: "race-person-answer", payload: { kind: "agentMessage", channel: "final", text: "Answered normally", answers: [lateId] } } });
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successor.id));
        await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.issueId));
        return heartbeat.wakeup(agentId, options);
      });
      expect(attempted).toBe(true);
      expect(successorId).toBeTruthy();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
      const [saved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      expect(saved.evidence.continuationDelivery).toBe("invalidated");
      expect(saved.resolutionNote).toBe("continuous_held_input_already_answered");
      console.info("0463_ADMISSION_RACE_PROOF", JSON.stringify({ sourceRunId: f.runId, successorId, actionId: action.id, evidence: saved.evidence }));
    } finally { await heartbeat.drainActiveRunExecutions(); }
  });

  it("requeues a person-stopped run without deadlocking native event persistence's issue FK", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop lock compatibility", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Continuous Pi", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stopped conversation", assigneeAgentId: agentId });
    const personStop = { requestedAt: new Date().toISOString(), userId: null };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      status: "cancelled", runtimeMode: "native", resultJson: { personStop }, contextSnapshot: { issueId } });
    const requeueDb = createDb(external ?? database!.connectionString, {
      maxConnections: 1, applicationName: `stop-requeue-${runId}`, statementTimeoutMs: 8_000,
    });
    let release!: () => void, runOwned!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { runOwned = resolve; });
    let writerPid = 0;
    const writer = db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      writerPid = Number(backend.pid);
      const sourceInstanceId = randomUUID();
      const append = (sourceSeq: number) => appendHeartbeatRunEvent(tx as unknown as Db, {
        companyId, runId, agentId, eventType: "test.stop_lock_compatibility",
        nativeSource: { sourceInstanceId, sourceEventId: randomUUID(), sourceSeq,
          protocolSchemaVersion: 1, canonicalPayload: { sourceSeq } },
      });
      // The uncursored event-batch fallback locks RUN and updates it once per event.
      await append(1);
      runOwned(); await hold;
      // This second UPDATE really requests ISSUE KEY SHARE through issue_id's FK.
      await append(2);
    });
    void writer.catch(() => undefined);
    let requeued: ReturnType<typeof requeueContinuousUnanswered> | undefined;
    try {
      await Promise.race([ready, writer]);
      // Make requeue the deadlock detector on the unfixed base, not the writer.
      await requeueDb.execute(sql`set deadlock_timeout = '100ms'`);
      requeued = requeueContinuousUnanswered(requeueDb, { id: runId, companyId });
      void requeued.catch(() => undefined);
      // A real lock-wait barrier, not a sleep: requeue already owns ISSUE and
      // is waiting for the writer's RUN before the second event may proceed.
      await expect.poll(async () => (await db.execute(sql`select 1 from pg_stat_activity
        where application_name = ${`stop-requeue-${runId}`} and wait_event_type = 'Lock'
          and ${writerPid}::int = any(pg_blocking_pids(pid))
          and query like 'select "heartbeat_runs"%'`)).length, { timeout: 3_000 }).toBe(1);
      release();
      await Promise.all([writer, requeued]);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run).toMatchObject({ status: "cancelled", nextEventSeq: 3, resultJson: { personStop } });
      expect(run.resultJson?.continuousUnansweredWakeId).toBeUndefined();
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
      expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).map(event => event.seq).sort()).toEqual([1, 2]);
    } finally {
      release();
      await Promise.allSettled([writer, ...(requeued ? [requeued] : [])]);
      await requeueDb.$client.end();
    }
  });

  it("retains ACKed unanswered follow-ups as one failed delivery receipt, never automatic resubmission", async () => {
    const f = await fixture();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_provider_output_without_result",
      resultJson: { queuedSteeringAcknowledgements: { [f.wakeId]: { status: "acknowledged", acknowledgedAt: new Date().toISOString() } } },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    await Promise.all([requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId }), requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId })]);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "failed", error: "native_provider_output_without_result", runId: null,
      payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [f.wakeId] } } });
    expect(wakes[0].finishedAt).toBeInstanceOf(Date);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.resultJson?.continuousReplies).toBeUndefined();
    expect(run.resultJson?.continuousUnansweredWakeId).toBe(wakes[0].id);
    const notices = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain(`message ${f.wakeId}`);
    expect(notices[0].body).toContain("remains unanswered");
    expect(notices[0].body).toContain("nothing was re-sent");
    expect(notices[0].presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
    await requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId });
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")))).toHaveLength(1);
  });

  it("coalesces identical held-turn finals only without new attribution, replays idempotently, and reuses the last at finalization", async () => {
    const f = await fixture(true, { beforeFinalize: async scope => {
      const [personRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const outbox = await completion(scope);
      await db.update(heartbeatRuns).set({ contextSnapshot: personRun.contextSnapshot }).where(eq(heartbeatRuns.id, scope.runId));
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const execution = { binding: scope, provider: { kind: "pi_rpc" as const, model: null } };
      const [followup] = await db.insert(issueComments).values({ companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: personRun.responsibleUserId, body: "Ask again: give me the same answer." }).returning();
      for (let index = 0; index < 4; index++) {
        const event = { eventType: "item.completed" as const, runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          turnId: "hire-turn", sourceEventId: `held-final-${index}`, itemId: `hire-turn:m${index + 1}:b${index === 0 ? 1 : 0}`,
          payload: { kind: "agentMessage", channel: "final", text: index === 1 ? " \nSame  \tanswer. \n" : index < 3 ? "Same answer." : "Last answer.",
            ...(index === 1 ? {} : { answers: index === 3 ? [outbox.deliveryId] : index === 2 ? [followup.id] : [] }) } };
        const cursor = 171 + index;
        await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId, runId: scope.runId, agentId: scope.agentId, seq: cursor, eventType: event.eventType, payload: { prpEvent: event } });
        await Promise.all([publishContinuousNativeReply({ db, execution, event, cursor }), publishContinuousNativeReply({ db, execution, event, cursor })]);
        console.info("completion-attribution-row", { itemId: event.itemId, answers: event.payload.answers ?? "missing", delivery: await outbox.delivery() });
        if (index < 3) {
          expect(await comments(scope.runId)).toHaveLength(index === 2 ? 2 : 1);
          expect(await outbox.delivery(), "a person's unrelated answer must not consume the completion report").toMatchObject({ status: "queued", responseCommentId: null });
        }
      }
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[]; commentId: string; publishedByReference?: boolean }>;
      expect(Object.keys(replies)).toHaveLength(4);
      expect(replies["hire-turn:m2:b0"]).toMatchObject({ questionCommentIds: [],
        commentId: replies["hire-turn:m1:b1"].commentId, publishedByReference: true });
      expect(replies["hire-turn:m3:b0"].questionCommentIds).toEqual([followup.id]);
      expect(replies["hire-turn:m3:b0"].commentId).not.toBe(replies["hire-turn:m1:b1"].commentId);
      expect((await comments(scope.runId)).map(c => c.body).sort()).toEqual(["Last answer.", "Same answer.", "Same answer."]);
      console.info("DBLFINAL_PROOF", JSON.stringify({ runId: scope.runId, replies,
        comments: (await comments(scope.runId)).map(({ id, body }) => ({ id, body })) }));
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: scope.runId, attempts: 0,
        responseCommentId: (await comments(scope.runId)).find(c => c.body === "Last answer.")!.id });
    }, reply: "Last answer." });
    await recoverCommittedNativeChatResponse(db, f.input);
    await recoverCommittedNativeChatResponse(db, f.input);
    expect(await comments(f.runId)).toHaveLength(3);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].nativeSessionId).toBe(f.prpEvent.normalizedSessionId);
  });

  it("acknowledges a queued completion at the first held final without swallowing the second final", async () => {
    await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const taskId = randomUUID(), deliveryId = randomUUID();
      await db.insert(issues).values({ id: taskId, companyId: scope.companyId, title: "Completed delegated work", status: "done", statusVersion: 2 });
      await db.insert(chatTaskHandoffs).values({ companyId: scope.companyId, taskId, conversationId: scope.issueId, agentId: scope.agentId, sessionGeneration: 0 });
      await db.insert(chatCompletionDeliveries).values({ id: deliveryId, companyId: scope.companyId, taskId, statusVersion: 2,
        status: "queued", targetRunId: scope.runId, error: "Completion turn ended without a reply" });
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot,
        chatCompletionDeliveryIds: [deliveryId], chatCompletionUpdates: [{ taskId }] } }).where(eq(heartbeatRuns.id, scope.runId));
      const execution = { binding: scope, provider: { kind: "pi_rpc" as const } };
      const event = { eventType: "item.completed" as const, runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
        sourceEventId: "completion-first", itemId: "completion:m1:b0", payload: { kind: "agentMessage", channel: "final", text: "Delegated work is done." } };
      await publishContinuousNativeReply({ db, execution, event, cursor: 171 });
      const [first] = await comments(scope.runId);
      expect(first.body).toBe("Delegated work is done.");
      const [delivered] = await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.id, deliveryId));
      expect(delivered).toMatchObject({ status: "delivered", responseCommentId: first.id, targetRunId: scope.runId, error: null });
      await publishContinuousNativeReply({ db, execution, cursor: 172, event: { ...event,
        sourceEventId: "completion-second", itemId: "completion:m2:b0", payload: { ...event.payload, text: "A separate later answer." } } });
      const replies = await comments(scope.runId);
      expect(replies).toHaveLength(2);
      expect(replies.map(reply => reply.body).sort()).toEqual(["A separate later answer.", "Delegated work is done."]);
      expect(replies.find(reply => reply.body === "A separate later answer.")!.id).not.toBe(first.id);
      expect((await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.id, deliveryId)))[0]).toEqual(delivered);
    } });
  });

  it.each(["paperclip", "continuous", undefined])("gates held-turn publication on pi_rpc + resolved continuity (%s)", async sessionContinuity => {
    await fixture(false, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const event = { eventType: "item.completed" as const, runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
        sourceEventId: "gated-final", itemId: "hire-turn:m1:b0", payload: { kind: "agentMessage", channel: "final", text: "Reply before terminal." } };
      const execution = { binding: scope, provider: { kind: "pi_rpc" as const, model: null } };
      await publishContinuousNativeReply({ db, execution: { ...execution, provider: { kind: "codex" } }, event, cursor: 171 });
      await publishContinuousNativeReply({ db, execution, event: { ...event, payload: { ...event.payload, channel: "commentary" } }, cursor: 171 });
      expect(await comments(scope.runId)).toEqual([]);
      await publishContinuousNativeReply({ db, execution, event, cursor: 171 });
      expect(await comments(scope.runId)).toHaveLength(sessionContinuity === "paperclip" ? 0 : 1);
      await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId, runId: scope.runId, agentId: scope.agentId, seq: 172, eventType: "lifecycle", payload: { retryReasonCode: "semantic_result_missing" } });
      await publishContinuousNativeReply({ db, execution, event: { ...event, itemId: "recovery-final" }, cursor: 173 });
      expect(await comments(scope.runId)).toHaveLength(sessionContinuity === "paperclip" ? 0 : 1);
    } });
  });

  it("replays persisted finals if ingestion committed but live publication crashed", async () => {
    const f = await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      for (let index = 0; index < 3; index++) await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId,
        runId: scope.runId, agentId: scope.agentId, seq: 171 + index, eventType: "item.completed", payload: { prpEvent: {
          runId: scope.runId, normalizedSessionId: run.nativeSessionId, sourceEventId: `crash-${index}`, itemId: `crash:m${index}:b0`,
          payload: { kind: "agentMessage", channel: "final", text: "Persisted answer." } } } });
      expect(await comments(scope.runId)).toHaveLength(0);
    }, reply: "Persisted answer." });
    await recoverCommittedNativeChatResponse(db, f.input);
    await recoverCommittedNativeChatResponse(db, f.input);
    expect(await comments(f.runId)).toHaveLength(3);
  });

  it("answers opening and its sealed companions without taking a later same-turn steered ACK", async () => {
    heldSteering.available = false;
    await fixture(true, { beforeFinalize: async scope => {
      const s = await seamInputs(scope);
      const named = await s.queueComment("Explicitly answered steer");
      const unnamed = await s.queueComment("Same-turn steer left pending");
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      await db.update(heartbeatRuns).set({ resultJson: { ...current.resultJson, queuedSteeringAcknowledgements: {
        [named.comment.id]: { status: "acknowledged", turnId: "exclusive-turn", afterEventSeq: 170,
          acknowledgedAt: new Date().toISOString() },
        [unnamed.comment.id]: { status: "acknowledged", turnId: "exclusive-turn", afterEventSeq: 170,
          acknowledgedAt: new Date().toISOString() },
      } } }).where(eq(heartbeatRuns.id, scope.runId));
      const publish = async (itemId: string, answers: string[], cursor: number) => publishContinuousNativeReply({ db, cursor,
        execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: s.run.nativeSessionId!,
          turnId: "exclusive-turn", sourceEventId: itemId, itemId,
          payload: { kind: "agentMessage", channel: "final", text: "Exact reply", answers } } });
      await publish("exclusive-steer", [named.comment.id], 171);
      await publish("exclusive-opening", [s.opening.id], 172);
      const replies = (await s.readRun()).resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      expect(replies["exclusive-steer"].questionCommentIds).toEqual([named.comment.id]);
      expect(replies["exclusive-opening"].questionCommentIds).toEqual([s.opening.id, s.c.comment.id, s.card.id]);
      expect(Object.values(replies).flatMap(reply => reply.questionCommentIds)).not.toContain(unnamed.comment.id);
      await publish("exclusive-sealed", [s.c.comment.id, s.card.id], 173);
      expect((await s.readRun()).resultJson?.continuousReplies).toMatchObject({
        "exclusive-sealed": { questionCommentIds: [] },
      });
      expect((await s.wakes()).filter(w => [s.c.wake.id, s.cardWake.id].includes(w.id)).every(w =>
        w.status === "cancelled")).toBe(true);
    } });
  });

  it.each(["explicit", "empty", "absent", "late-ack"])("owns each ACK by its exact final or the first following cursor (%s)", async scenario => {
    await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const openingId = run.contextSnapshot!.wakeCommentId as string;
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, openingId));
      const [steered] = await db.insert(issueComments).values({ companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: opening.authorUserId, body: "G-2: ask a question after counting" }).returning();
      const firstAnswerIds = [openingId];
      const firstSteerId = randomUUID();
      if (scenario === "explicit") {
        await db.insert(issueComments).values({ id: firstSteerId, companyId: scope.companyId, issueId: scope.issueId,
          authorUserId: opening.authorUserId, body: "An earlier steer answered only by the first final" });
        firstAnswerIds.push(firstSteerId);
      }
      await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: {
        ...(scenario === "explicit" ? { [firstSteerId]: { status: "acknowledged", turnId: "count-turn",
          acknowledgedAt: new Date().toISOString(), afterEventSeq: 169 } } : {}),
        [steered.id]: { status: "acknowledged", turnId: "count-turn", acknowledgedAt: new Date().toISOString(),
          afterEventSeq: scenario === "late-ack" ? 172 : 170 },
      } } }).where(eq(heartbeatRuns.id, scope.runId));
      for (let index = 0; index < 2; index++) await publishContinuousNativeReply({ db, cursor: 171 + index * 2,
        execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          turnId: "count-turn", sourceEventId: `ownership-${index}`, itemId: `ownership-${index}`,
          payload: { kind: "agentMessage", channel: "final", text: index === 0 ? "1, 2, 3" : "Which color?",
            ...(scenario === "explicit" ? { answers: index === 0 ? firstAnswerIds : [steered.id] }
              : scenario === "absent" ? {} : { answers: [] }) } } });
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      const onLater = scenario === "explicit" || scenario === "late-ack";
      expect(replies["ownership-0"].questionCommentIds).toEqual(onLater ? firstAnswerIds : [openingId, steered.id]);
      expect(replies["ownership-1"].questionCommentIds).toEqual(onLater ? [steered.id] : []);
    } });
  });

  it.each(["before-count", "after-count", "plain"])("persists the native card's causal input through its answer reply (%s)", async scenario => {
    let askingId!: string, interactionId!: string;
    const f = await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const openingId = run.contextSnapshot!.wakeCommentId as string;
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, openingId));
      await db.insert(companyMemberships).values({ companyId: scope.companyId, principalId: opening.authorUserId!,
        principalType: "user", status: "active", membershipRole: "member" });
      askingId = openingId;
      if (scenario !== "plain") {
        const [asking] = await db.insert(issueComments).values({ companyId: scope.companyId, issueId: scope.issueId,
          authorUserId: opening.authorUserId, body: "G-2: when done, ask me a question with your card tool" }).returning();
        askingId = asking.id;
        await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: {
          [askingId]: { status: "acknowledged", turnId: "count-turn", acknowledgedAt: new Date().toISOString(),
            afterEventSeq: scenario === "before-count" ? 170 : 172 },
        } } }).where(eq(heartbeatRuns.id, scope.runId));
      }
      await publishContinuousNativeReply({ db, cursor: 171, execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          turnId: "count-turn", sourceEventId: "count-final", itemId: "count-final",
          payload: { kind: "agentMessage", channel: "final", text: "1, 2, 3, 4, 5", answers: [] } } });
      // Tool authority uses the asking turn's committed cursor, not wall time or
      // the answer-delivery run's original wake comment.
      await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId, runId: scope.runId, agentId: scope.agentId,
        seq: 173, eventType: "turn.started", payload: { prpEvent: { turnId: "count-turn" } } });
      await db.update(heartbeatRuns).set({ nextEventSeq: 174 }).where(eq(heartbeatRuns.id, scope.runId));
      const authority = new PaperclipRunnerToolAuthority(db, scope);
      try {
        const result = await authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: {
          interactionKind: "questions", idempotencyKey: "color-card", title: "Choose a color", prompt: "Which color?",
          continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "color", prompt: "Which color?",
            selectionMode: "single", required: true, options: [{ id: "blue", label: "Blue" }] }] },
        } }) as { interaction: { id: string; sourceCommentId: string } };
        interactionId = result.interaction.id;
        expect(result.interaction.sourceCommentId).toBe(askingId);
      } finally { authority.close(); }
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      expect((saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>)["count-final"].questionCommentIds)
        .toEqual(scenario === "before-count" ? [openingId, askingId] : [openingId]);
    } });
    await issueThreadInteractionService(db).answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" },
      interactionId, { answers: [{ questionId: "color", optionIds: ["blue"] }] }, { userId: f.userId });
    const wakeup = vi.fn<QuestionResponseDeliveryServiceOptions["heartbeat"]["wakeup"]>(async (_agentId, options) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, nativeSessionId: randomUUID(), runtimeMode: "native", status: "running",
        contextSnapshot: { ...options!.contextSnapshot, conversationSessionGeneration: 0 } }).returning();
      await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.issueId));
      return run;
    });
    const delivered = await questionResponseDeliveryService(db, { heartbeat: { wakeup } as never }).deliver(interactionId);
    expect(delivered).toMatchObject({ status: "fallback_queued" });
    const [answerRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered!.targetRunId!));
    await publishContinuousNativeReply({ db, cursor: 1, execution: { binding: { ...f, runId: answerRun.id }, provider: { kind: "pi_rpc" } },
      event: { eventType: "item.completed", runId: answerRun.id, normalizedSessionId: answerRun.nativeSessionId!,
        turnId: "answer-turn", sourceEventId: "blue-final", itemId: "blue-final",
        payload: { kind: "agentMessage", channel: "final", text: "Blue it is.", answers: [] } } });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, answerRun.id));
    const blue = (saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[]; commentId: string }>)["blue-final"];
    expect(blue.questionCommentIds).toEqual([askingId]);
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, blue.commentId));
    expect(comment.body).toBe("Blue it is.");
    console.log(JSON.stringify({ proof: "replymap2-card-answer", scenario, runId: f.runId, answerRunId: answerRun.id,
      g1: f.wakeId, askingId, interactionId, answerQuestionCommentIds: blue.questionCommentIds }));
  });

  it.each([true, false])("maps held finals by explicit answers, or only opening input when absent (answers=%s)", async explicit => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const f = await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
      await db.insert(issueComments).values(ids.map((id, index) => ({ id, companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: opening.authorUserId, body: index < 3 ? `Steer ${index + 1}` : index === 3 ? "After" : "Still unanswered" })));
      await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: Object.fromEntries(ids.map((id, index) =>
        [id, { status: "acknowledged", acknowledgedAt: `2020-01-01T00:00:0${index}Z` }])) } }).where(eq(heartbeatRuns.id, scope.runId));
      const execution = { binding: scope, provider: { kind: "pi_rpc" as const } };
      for (let index = 0; index < 4; index++) {
        const event = { eventType: "item.completed" as const, runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          sourceEventId: `answers-${index}`, itemId: `answers:m${index}:b0`, payload: { kind: "agentMessage", channel: "final", text: `Reply ${index}`,
            ...(explicit ? { answers: index === 0 ? [opening.id, ids[0], ids[0]] : [ids[index], ids[0]] } : {}) } };
        await Promise.all([publishContinuousNativeReply({ db, execution, event, cursor: 171 + index }),
          publishContinuousNativeReply({ db, execution, event, cursor: 171 + index })]);
        const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[]; commentId: string }>;
        expect(replies[event.itemId].questionCommentIds).toEqual(explicit
          ? index === 0 ? [opening.id, ids[0]] : [ids[index]]
          : index === 0 ? [opening.id] : []);
        const [reply] = await db.select().from(issueComments).where(eq(issueComments.id, replies[event.itemId].commentId));
        expect(reply.body).toBe(`Reply ${index}`);
      }
      // Explicit empty answers is authoritative, not permission to take the FIFO head.
      // A repeated answer id is likewise not permission to consume another question.
      if (explicit) for (const [index, answers] of [[], [opening.id, ids[0]]].entries()) {
        await publishContinuousNativeReply({ db, execution, cursor: 175 + index,
          event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
            sourceEventId: `extra-${index}`, itemId: `extra-${index}`, payload: { kind: "agentMessage", channel: "final", text: "Extra", answers } } });
        const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
        expect((saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>)[`extra-${index}`].questionCommentIds).toEqual([]);
      }
    } });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
    await requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `continuous-unanswered:${f.runId}`));
    expect(wake.payload).toMatchObject({ _paperclipWakeContext: { wakeCommentIds: explicit ? [ids[4]] : ids } });
  });

  it.each(["steered-explicit", "steered-legacy", "plain"])("keeps the count, native question card and answer attached to their person input (%s)", async scenario => {
    const steered = scenario !== "plain";
    let askingCommentId!: string;
    let interactionId!: string;
    let countCommentIds!: string[];
    const f = await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
      await db.insert(companyMemberships).values({ companyId: scope.companyId, principalId: opening.authorUserId!,
        principalType: "user", status: "active", membershipRole: "member" });
      await db.update(issueComments).set({ body: "Count to 50 slowly" }).where(eq(issueComments.id, opening.id));
      askingCommentId = opening.id;
      if (steered) {
        const [followup] = await db.insert(issueComments).values({ companyId: scope.companyId, issueId: scope.issueId,
          authorUserId: opening.authorUserId, body: "When you finish, ask me ONE question with your question-card tool" }).returning();
        askingCommentId = followup.id;
        await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: {
          [followup.id]: { status: "acknowledged", turnId: "count-turn", acknowledgedAt: new Date().toISOString(), afterEventSeq: 170 },
        } } }).where(eq(heartbeatRuns.id, scope.runId));
      }
      await publishContinuousNativeReply({ db, cursor: 171, execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          turnId: "count-turn", sourceEventId: "count-final", itemId: "count-final", payload: {
            kind: "agentMessage", channel: "final", text: Array.from({ length: 50 }, (_, i) => i + 1).join(", "),
            ...(scenario === "steered-legacy" ? {} : { answers: [] }),
          } } });
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      countCommentIds = (saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>)["count-final"].questionCommentIds;
      expect(countCommentIds).toEqual(steered ? [opening.id, askingCommentId] : [opening.id]);
      await db.insert(heartbeatRunEvents).values({ companyId: scope.companyId, runId: scope.runId, agentId: scope.agentId,
        seq: 173, eventType: "turn.started", payload: { prpEvent: { turnId: "count-turn" } } });
      await db.update(heartbeatRuns).set({ nextEventSeq: 174 }).where(eq(heartbeatRuns.id, scope.runId));
      const authority = new PaperclipRunnerToolAuthority(db, scope);
      try {
        const card = await authority.execute({ tool: "request_human_input", callId: randomUUID(), arguments: {
          interactionKind: "questions", idempotencyKey: "count-color-card", title: "Choose a color", prompt: "Which color?",
          continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "color", prompt: "Which color?",
            selectionMode: "single", required: true, options: [{ id: "blue", label: "Blue" }] }] },
        } }) as { interaction: { id: string; sourceCommentId: string } };
        interactionId = card.interaction.id;
        expect(card.interaction.sourceCommentId).toBe(askingCommentId);
      } finally { authority.close(); }
    } });
    await issueThreadInteractionService(db).answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" },
      interactionId, { answers: [{ questionId: "color", optionIds: ["blue"] }] }, { userId: f.userId });
    const wakeup = vi.fn<QuestionResponseDeliveryServiceOptions["heartbeat"]["wakeup"]>(async (_agentId, options) => {
      if (!options) throw new Error("Expected card-answer continuation options");
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, nativeSessionId: randomUUID(), runtimeMode: "native", status: "running",
        contextSnapshot: { ...options.contextSnapshot, conversationSessionGeneration: 0 } }).returning();
      await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.issueId));
      return run;
    });
    const delivery = await questionResponseDeliveryService(db, { heartbeat: { wakeup } as never }).deliver(interactionId);
    expect(delivery).toMatchObject({ status: "fallback_queued" });
    const [answerRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivery!.targetRunId!));
    await publishContinuousNativeReply({ db, cursor: 1,
      execution: { binding: { ...f, runId: answerRun.id }, provider: { kind: "pi_rpc" } },
      event: { eventType: "item.completed", runId: answerRun.id, normalizedSessionId: answerRun.nativeSessionId!,
        turnId: "answer-turn", sourceEventId: "blue-final", itemId: "blue-final",
        payload: { kind: "agentMessage", channel: "final", text: "Blue it is.", answers: [] } } });
    const [savedAnswer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, answerRun.id));
    const blue = (savedAnswer.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[]; commentId: string }>)["blue-final"];
    expect(countCommentIds).toEqual(steered ? [f.wakeId, askingCommentId] : [f.wakeId]);
    expect(blue.questionCommentIds).toEqual([askingCommentId]);
    const [savedBlue] = await db.select().from(issueComments).where(eq(issueComments.id, blue.commentId));
    expect(savedBlue.body).toBe("Blue it is.");
    console.log(JSON.stringify({ proof: "steer-card-reply-map", scenario, firstRunId: f.runId, answerRunId: answerRun.id,
      g1: f.wakeId, askingCommentId, interactionId, countQuestionCommentIds: countCommentIds,
      answerQuestionCommentIds: blue.questionCommentIds, answer: savedBlue.body }));
  });

  it.each([true, false])("maps all same-turn ACKs but excludes other turns, late ACKs and unaccepted steers (explicit=%s)", async explicit => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const openingId = run.contextSnapshot!.wakeCommentId as string;
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, openingId));
      await db.insert(issueComments).values(ids.map(id => ({ id, companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: opening.authorUserId, body: "Another person input" })));
      await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: Object.fromEntries(ids.map((id, index) =>
        [id, { status: index === 4 ? "pending" : "acknowledged", turnId: index === 2 ? "other-turn" : index === 5 ? "later-turn" : "count-turn",
          acknowledgedAt: new Date(1000 + index).toISOString(), afterEventSeq: index === 3 ? 171 : 170 }])) } }).where(eq(heartbeatRuns.id, scope.runId));
      for (const [index, turnId] of ["count-turn", "other-turn", "unrelated-turn"].entries()) await publishContinuousNativeReply({ db, cursor: 171,
        execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!, turnId,
          sourceEventId: `turn-final-${index}`, itemId: `turn-final-${index}`,
          payload: { kind: "agentMessage", channel: "final", text: "Answer for this turn", ...(explicit ? { answers: [] } : {}) } } });
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      expect(replies["turn-final-0"].questionCommentIds).toEqual([openingId, ids[0], ids[1]]);
      expect(replies["turn-final-1"].questionCommentIds).toEqual([ids[2]]);
      expect(replies["turn-final-2"].questionCommentIds).toEqual([]);
    } });
  });

  it("does not add coalesced or sealed first-turn inputs to explicit empty answers without turn identity", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await fixture(false, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
      await db.insert(issueComments).values(ids.map((id, index) => ({ id, companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: opening.authorUserId, body: `Input ${index}`, createdAt: new Date(1000 + index) })));
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, wakeCommentIds: [opening.id, ids[0]], wakeCommentId: ids[0] } })
        .where(eq(heartbeatRuns.id, scope.runId));
      await db.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
        source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user",
        requestedByActorId: opening.authorUserId, payload: { issueId: scope.issueId,
          _paperclipWakeContext: { wakeReason: "issue_commented", wakeCommentIds: ids.slice(1, 3) } } });
      const queuedInput = await claimFirstTurnQueuedInput(db, scope);
      expect(queuedInput).toContain(ids[1]);
      expect(queuedInput).toContain(ids[2]);
      const execution = { binding: scope, provider: { kind: "pi_rpc" as const } };
      for (const [index, answers] of [[], [ids[3]]].entries()) {
        await publishContinuousNativeReply({ db, execution, cursor: 171 + index,
          event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
            sourceEventId: `sealed-${index}`, itemId: `sealed-${index}`, payload: { kind: "agentMessage", channel: "final", text: "Answer", answers } } });
      }
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      expect(replies["sealed-0"].questionCommentIds).toEqual([]);
      expect(replies["sealed-1"].questionCommentIds).toEqual([ids[3]]);
    } });
  });

  it("uses explicit answers even when receipt order and publication cursor disagree", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const openingId = run.contextSnapshot!.wakeCommentId as string;
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, openingId));
      await db.insert(issueComments).values(ids.map(id => ({ id, companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: opening.authorUserId, body: "Question awaiting an exact reply" })));
      await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: Object.fromEntries(ids.map((id, index) =>
        [id, { status: "acknowledged", acknowledgedAt: `2020-01-01T00:00:0${index}Z`, afterEventSeq: 180 }])) } }).where(eq(heartbeatRuns.id, scope.runId));
      const execution = { binding: scope, provider: { kind: "pi_rpc" as const } };
      for (const [index, answers] of [[ids[1]], [], [ids[0], ids[1]], [ids[3], ids[2]]].entries()) {
        await publishContinuousNativeReply({ db, execution, cursor: 171 + index,
          event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
            sourceEventId: `exact-${index}`, itemId: `exact-${index}`, payload: { kind: "agentMessage", channel: "final", text: "Exact answer", answers } } });
      }
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      expect(replies["exact-0"].questionCommentIds).toEqual([ids[1]]);
      expect(replies["exact-1"].questionCommentIds).toEqual([]);
      expect(replies["exact-2"].questionCommentIds).toEqual([ids[0]]);
      expect(replies["exact-3"].questionCommentIds).toEqual([ids[3], ids[2]]);
      expect(Object.values(replies).flatMap(reply => reply.questionCommentIds)).not.toContain(ids[4]);
    } });
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])("maps explicit delivery answers and requeues only unanswered receipts at %s, once", async status => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const f = await fixture(true, { beforeFinalize: async scope => {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, scope.agentId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const [opening] = await db.select().from(issueComments).where(eq(issueComments.id, run.contextSnapshot!.wakeCommentId as string));
      await db.insert(issueComments).values(ids.map((id, index) => ({ id, companyId: scope.companyId, issueId: scope.issueId,
        authorUserId: opening.authorUserId, body: `Question ${index}` })));
      await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: Object.fromEntries(ids.map((id, index) =>
        [id, { status: "acknowledged", acknowledgedAt: `2020-01-01T00:00:0${index}Z` }])) } }).where(eq(heartbeatRuns.id, scope.runId));
      for (let index = 0; index < 2; index++) await publishContinuousNativeReply({ db, cursor: 171 + index,
        execution: { binding: scope, provider: { kind: "pi_rpc" } },
        event: { eventType: "item.completed", runId: scope.runId, normalizedSessionId: run.nativeSessionId!,
          sourceEventId: `fifo-${index}`, itemId: `fifo:m${index}:b0`, payload: { kind: "agentMessage", channel: "final", text: "OK",
            answers: index === 0 ? [opening.id, ids[0]] : [ids[1]] } } });
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
      const replies = saved.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>;
      expect(replies["fifo:m0:b0"].questionCommentIds).toEqual([opening.id, ids[0]]);
      expect(replies["fifo:m1:b0"].questionCommentIds).toEqual([ids[1]]);
      expect((await comments(scope.runId)).every(comment => comment.clientRequestId?.includes("fifo:m"))).toBe(true);
    } });
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    await Promise.all([requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId }), requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId })]);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `continuous-unanswered:${f.runId}`));
    // A run that ended normally answered what Pi took; only a run that died hands an unanswered comment on.
    expect(wakes).toHaveLength(status === "succeeded" ? 0 : 1);
    if (status === "succeeded") return;
    expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [ids[2]], forceFreshSession: false } } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].nativeSessionId).toBe(f.prpEvent.normalizedSessionId);
  });

  it.each(["continuous", "paperclip"])("restores an ACK with no answer at all only in %s mode", async sessionContinuity => {
    const f = await fixture(false);
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity } }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ status: "failed", resultJson: {
      queuedSteeringAcknowledgements: { [f.wakeId]: { status: "acknowledged", acknowledgedAt: new Date().toISOString() } },
    } }).where(eq(heartbeatRuns.id, f.runId));
    await requeueContinuousUnanswered(db, { id: f.runId, companyId: f.companyId });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `continuous-unanswered:${f.runId}`));
    expect(wakes).toHaveLength(sessionContinuity === "continuous" ? 1 : 0);
  });

  it.each(["native", "legacy"] as const)("hands three %s pre-dispatch chat openings to the next first turn, attributed once without resetting automatic retries", async runtimeMode => {
    const f = await fixture(true);
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, f.agentId));
    // Each new run fails at ingress before a session opens, with no steering
    // ACKs or first-turn claim. The fixture's earlier answered turn stays intact.
    const ids: string[] = [];
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, body: `Outage message ${i}`, createdAt: new Date(Date.now() + i) }).returning();
      ids.push(comment.id);
      await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId,
        ...(runtimeMode === "native" ? { nativeIssueId: f.issueId } : {}), runtimeMode, status: "failed", responsibleUserId: f.userId,
        contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, wakeCommentId: comment.id } });
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        status: "failed", source: "issue", reason: "issue_commented", runId: id,
        requestedByActorType: "user", requestedByActorId: f.userId,
        payload: { issueId: f.issueId, commentId: ids[i] } }).returning();
      await db.update(heartbeatRuns).set({ status: "failed", wakeupRequestId: wake.id, finishedAt: new Date(),
        errorCode: "setup_failed", error: "runner.ingress.acquire failed", sessionIdAfter: null,
        scheduledRetryAttempt: 2, resultJson: runtimeMode === "native"
          ? { nativePreDispatchFailure: { version: 1, providerWorkStarted: false } }
          : { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
        .where(eq(heartbeatRuns.id, id));
      await requeueContinuousUnanswered(db, { id, companyId: f.companyId });
      await requeueContinuousUnanswered(db, { id, companyId: f.companyId });
      runs.push(id);
    }
    const pending = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(pending).toHaveLength(3);
    expect(pending.every(w => w.payload?.preDispatchInputOnly === true && w.runId === null)).toBe(true);
    const [next] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "The environment is back; please answer all of these." }).returning();
    ids.push(next.id);
    const nextRunId = randomUUID(), sessionId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, nativeSessionId: sessionId, runtimeMode: "native", status: "running", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, wakeCommentId: next.id } });
    await db.update(issues).set({ status: "in_progress", conversationState: "active", executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    const input = await claimFirstTurnQueuedInput(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: nextRunId });
    for (const id of ids.slice(0, 3)) expect(input).toContain(id);
    expect(ids.slice(0, 3).map(id => input!.indexOf(id))).toEqual([...ids.slice(0, 3).map(id => input!.indexOf(id))].sort((a, b) => a - b));
    // The old pack's FIFO final (no answers field) must attribute the sealed
    // openings as well as the new wake, not only the newest question.
    const event = { eventType: "item.completed" as const, runId: nextRunId, normalizedSessionId: sessionId,
      sourceEventId: "handback-final", itemId: "handback-final", payload: { kind: "agentMessage", channel: "final", text: "All four messages answered." } };
    const execution = { binding: { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: nextRunId }, provider: { kind: "pi_rpc" as const } };
    await publishContinuousNativeReply({ db, execution, event, cursor: 1 });
    await publishContinuousNativeReply({ db, execution, event, cursor: 1 });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, nextRunId));
    const [answered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nextRunId));
    const attributed = Object.values(answered.resultJson!.continuousReplies as Record<string, { questionCommentIds: string[] }>).flatMap(r => r.questionCommentIds);
    expect(attributed).toEqual(ids);
    expect(new Set(attributed).size).toBe(4);
    expect(await comments(nextRunId)).toHaveLength(1);
    console.info("pre-dispatch handback PG evidence", JSON.stringify({ runtimeMode, failedRunIds: runs,
      questionCommentIds: ids, successorRunId: nextRunId, continuousReplies: answered.resultJson!.continuousReplies,
      automaticRetryAttemptsPreserved: 2, providerInvokedByTest: false }));
    const remaining = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(remaining).toHaveLength(0);
    // Releasing failed predecessors after the answer cannot re-create debt.
    for (const id of runs) await requeueContinuousUnanswered(db, { id, companyId: f.companyId });
    for (const id of runs) {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      expect(run.scheduledRetryAttempt).toBe(2);
    }
  });

  it("hands wake, first-turn and steering inputs back once, unless a successor already owns them", async () => {
    const f = await fixture(true);
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, f.agentId));
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issueComments).values(ids.map((id, index) => ({ id, companyId: f.companyId, issueId: f.issueId,
      authorType: "user" as const, authorUserId: f.userId, body: `Unconsumed input ${index}`, createdAt: new Date(Date.now() + index) })));
    const source = randomUUID(), successor = randomUUID();
    await db.insert(heartbeatRuns).values({ id: source, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "failed", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, wakeCommentId: ids[0],
        firstTurnQueuedInput: { schema: "paperclip.first-turn-queued-input.v1", runId: source, commentIds: [ids[1]],
          wakeupRequestIds: [], claimedAt: new Date().toISOString() } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        queuedSteeringAcknowledgements: { [ids[2]]: { status: "acknowledged", acknowledgedAt: new Date().toISOString() } } } });
    await db.insert(heartbeatRuns).values({ id: successor, companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "scheduled_retry", responsibleUserId: f.userId,
      retryOfRunId: source, scheduledRetryAttempt: 2,
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, wakeCommentId: ids[0] } });
    await requeueContinuousUnanswered(db, { id: source, companyId: f.companyId });
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `continuous-unanswered:${source}`));
    expect(receipt.payload).toMatchObject({ preDispatchInputOnly: true, _paperclipWakeContext: { wakeCommentIds: ids.slice(1) } });
    // The scheduled successor owns the opening; if it also fails pre-dispatch,
    // it hands that opening back without duplicating the already pending two.
    await db.update(heartbeatRuns).set({ status: "failed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, successor));
    await requeueContinuousUnanswered(db, { id: successor, companyId: f.companyId });
    await requeueContinuousUnanswered(db, { id: source, companyId: f.companyId });
    const pending = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(pending).toHaveLength(2);
    const handed = pending.flatMap(w => (w.payload?._paperclipWakeContext as { wakeCommentIds: string[] }).wakeCommentIds);
    expect(handed.sort()).toEqual([...ids].sort());
  });

  it("does not hand a failed opening back after provider work, even with a stale no-work annotation", async () => {
    const f = await fixture(true);
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, f.agentId));
    const id = randomUUID();
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "Provider already took this opening" }).returning();
    await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "failed", responsibleUserId: f.userId,
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0, wakeCommentId: message.id },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: id,
      seq: 1, eventType: "turn.started", sourceEventId: "provider-started", payload: {} });
    await requeueContinuousUnanswered(db, { id, companyId: f.companyId });
    const pending = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(pending).toHaveLength(0);
  });

  const comments = (runId: string) => db.select().from(issueComments).where(eq(issueComments.createdByRunId, runId));
  const issue = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0];

  async function completion(f: { companyId: string; issueId: string; runId: string; agentId: string }) {
    const taskId = randomUUID(), deliveryId = randomUUID();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(issues).values({ id: taskId, companyId: f.companyId, title: "Completed review", status: "done", statusVersion: 2 });
    await db.insert(chatTaskHandoffs).values({ companyId: f.companyId, taskId, conversationId: f.issueId,
      agentId: f.agentId, sessionGeneration: 0 });
    await db.insert(chatCompletionDeliveries).values({ id: deliveryId, companyId: f.companyId, taskId,
      statusVersion: 2, status: "queued", targetRunId: f.runId, nextAttemptAt: new Date(0) });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(and(eq(heartbeatRuns.id, f.runId), eq(heartbeatRuns.status, "succeeded")));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, source: "automation", wakeReason: "chat_task_completed",
      conversationMode: true, conversationSessionGeneration: 0, chatCompletionDeliveryIds: [deliveryId], chatCompletionUpdates: [{ taskId }] } })
      .where(eq(heartbeatRuns.id, f.runId));
    const wakeup = vi.fn(async (_agentId: string, options: { idempotencyKey: string }) => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        status: "skipped", reason: "heartbeat.daily_run_limit", idempotencyKey: options.idempotencyKey });
      return null;
    });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      status: "completed", reason: "chat_task_completed", idempotencyKey: `chat-completion:${deliveryId}:0`, runId: f.runId });
    const delivery = async () => (await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.id, deliveryId)))[0];
    return { taskId, deliveryId, wakeup, delivery, service: chatCompletionDeliveryService(db, { wakeup }) };
  }

  it("preserves accepted native callback presentation when outbox retry runs first at the daily cap", async () => {
    const f = await fixture(), outbox = await completion(f);
    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load(f.input);
    expect(entry).toMatchObject({ id: f.runId });


    await outbox.service.deliver(outbox.deliveryId);
    await expect(work.check(entry)).resolves.toBeNull();
    const [comment] = await comments(f.runId);
    expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
    expect(await comments(f.runId)).toHaveLength(1);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
    expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
    expect(outbox.wakeup).not.toHaveBeenCalled();
  });

  it.each([false, true])("wakes the real reply worker only after outer commit, becomes idle and persists once (rollback=%s)", async rollback => {
    const f = await fixture(true, { succeed: false }), outbox = await completion(f);
    let queries = 0;
    const debug = db.$client.options.debug;
    db.$client.options.debug = () => { queries++; };
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const worker = nativeResponsePresentationWork(db).register(coordinator, () => true);
    const quiet = () => vi.waitFor(() => {
      expect(coordinator.nextWakeAt()).toBeNull();
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
    const projectAndDefer = async (abort: boolean) => db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await chatCompletionDeliveryService(tx as unknown as Db, { wakeup: outbox.wakeup }).deliver(outbox.deliveryId);
      expect(await comments(f.runId)).toEqual([]);
      if (abort) throw new Error("fixture-outbox-rollback");
    });
    try {
      await worker.ready; await quiet();
      if (rollback) {
        await expect(projectAndDefer(true)).rejects.toThrow("fixture-outbox-rollback");
        await quiet();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].status).toBe("running");
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, nextAttemptAt: new Date(0) });
        expect(await comments(f.runId)).toEqual([]);
      }
      await projectAndDefer(false);
      await vi.waitFor(async () => expect(await comments(f.runId)).toHaveLength(1), { timeout: 5000 });
      await quiet();
      const [comment] = await comments(f.runId);
      expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
      expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
      const settledQueries = queries;
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(queries).toBe(settledQueries);
      expect(coordinator.nextWakeAt()).toBeNull();
      vi.useRealTimers();
      await outbox.service.deliver(outbox.deliveryId);
      expect(await comments(f.runId)).toHaveLength(1);
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers(); worker.stop(); await coordinator.stop(); db.$client.options.debug = debug;
    }
  });

  it.each(["failed", "cancelled", "missing-final", "no-accepted", "old-generation", "foreign-company", "foreign-agent"])(
    "keeps the existing retry path for %s targets", async fault => {
      const f = await fixture(), outbox = await completion(f);
      if (fault === "failed" || fault === "cancelled") await db.update(heartbeatRuns).set({ status: fault }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "missing-final") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
      if (fault === "no-accepted") await db.update(nativeRunResults).set({ schemaStatus: "rejected" }).where(eq(nativeRunResults.runId, f.runId));
      if (fault === "old-generation") {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, conversationSessionGeneration: 1 } }).where(eq(heartbeatRuns.id, f.runId));
      }
      let foreign: Awaited<ReturnType<typeof fixture>> | undefined;
      if (fault === "foreign-company") {
        foreign = await fixture();
        await db.update(chatCompletionDeliveries).set({ targetRunId: foreign.runId }).where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      }
      if (fault === "foreign-agent") {
        const otherAgent = randomUUID();
        await db.insert(agents).values({ id: otherAgent, companyId: f.companyId, name: "Other agent", adapterType: "paperclip_runner" });
        await db.update(heartbeatRuns).set({ agentId: otherAgent }).where(eq(heartbeatRuns.id, f.runId));
      }
      await outbox.service.deliver(outbox.deliveryId);
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      expect(await comments(f.runId)).toEqual([]);
      if (foreign) expect(await comments(foreign.runId)).toEqual([]);
    },
  );

  it.each(["reset-source", "reopened-task"])("keeps %s delivery supersession", async fault => {
    const f = await fixture(), outbox = await completion(f);
    if (fault === "reset-source") await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.issueId));
    else {
      await issueService(db).update(outbox.taskId, { status: "todo" });
      await issueService(db).update(outbox.taskId, { status: "done" });
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 4 });
    }
    await outbox.service.deliver(outbox.deliveryId);
    expect(await outbox.delivery()).toMatchObject({ status: "superseded", attempts: 0, responseCommentId: null });
    expect(outbox.wakeup).not.toHaveBeenCalled();
    expect(await comments(f.runId)).toEqual([]);
  });

  it("lets an in-flight presentation acknowledge before expiry can retarget the delivery", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const suffix = randomUUID().replaceAll("-", ""), lockId = Number.parseInt(suffix.slice(0, 6), 16) + 1;
    const trigger = `completion_reply_hold_${suffix}`;
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    let blocker: Promise<unknown> | undefined, presentation: Promise<unknown> | undefined, expiry: Promise<unknown> | undefined;
    try {
      await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if NEW.created_by_run_id = '${f.runId}'::uuid then perform pg_advisory_xact_lock(${lockId}); end if;
          return NEW;
        end $$`));
      await db.execute(sql.raw(`create trigger ${trigger} before insert on issue_comments for each row execute function ${trigger}()`));
      blocker = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(${lockId}::bigint)`); acquired(); await hold; });
      await Promise.race([locked, blocker]);
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      presentation = work.check(entry); void presentation.catch(() => undefined);


      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_locks
          where locktype = 'advisory' and classid = 0 and objid = ${lockId}::oid and not granted
            and database = (select oid from pg_database where datname = current_database())) as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      vi.setSystemTime(started + 300_000);
      let expirySettled = false;
      expiry = outbox.service.deliver(outbox.deliveryId).then(() => { expirySettled = true; });
      void expiry.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%from "issues"%' and query like '%for update%') as waiting`);
        expect(expirySettled || row.waiting).toBe(true);
      }, { timeout: 5000 });
      expect(expirySettled).toBe(false);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, responseCommentId: null });
      release(); await blocker; await presentation; await expiry;
      const [comment] = await comments(f.runId);
      expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
      expect(await comments(f.runId)).toHaveLength(1);
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
    } finally {
      release?.(); await Promise.allSettled([blocker, presentation, expiry].filter((value): value is Promise<unknown> => Boolean(value)));
      await db.execute(sql.raw(`drop trigger if exists ${trigger} on issue_comments`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
      vi.useRealTimers();
    }
  });

  it("lets expiry win before presentation and releases the child lock before wake admission", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f), lockErrors: unknown[] = [];
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      vi.setSystemTime(started + 300_000);
      const wakeup = vi.fn(async (agentId: string, options: { idempotencyKey: string }) => {
        try {
          await db.transaction(async tx => {
            await tx.execute(sql`set local lock_timeout = '500ms'`);
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
            await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, outbox.taskId)).for("update");
          });
        } catch (error) { lockErrors.push(error); throw error; }
        return outbox.wakeup(agentId, options);
      });
      await chatCompletionDeliveryService(db, { wakeup }).deliver(outbox.deliveryId);
      expect(lockErrors).toEqual([]);
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      await expect(work.check(entry)).rejects.toThrow("chat_completion_superseded");
      expect(await comments(f.runId)).toEqual([]);
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 2 });
    } finally { vi.useRealTimers(); }
  });

  it("rolls back an expiry transition without waking or losing the original target", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      vi.setSystemTime(started + 300_000);
      const rollback = new Error("fixture-expiry-rollback");
      const connection = new Proxy(db, { get(target, key) {
        return key === "transaction" ? async (callback: Parameters<Db["transaction"]>[0]) => target.transaction(async tx => {
          await callback(tx); throw rollback;
        }) : Reflect.get(target, key);
      } });
      await chatCompletionDeliveryService(connection, { wakeup: outbox.wakeup }).deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, responseCommentId: null,
        error: rollback.message });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await comments(f.runId)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it.each(["new-claim", "delivered", "retargeted", "superseded"])("respects a %s winner while expiry waits for the child lock", async winner => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const replacementId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: replacementId, companyId: f.companyId, agentId: f.agentId, status: "queued" });
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    const blocker = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, outbox.taskId)).for("update"); acquired(); await hold;
      if (winner === "delivered") await tx.update(chatCompletionDeliveries).set({ status: "delivered" }).where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      if (winner === "retargeted") await tx.update(chatCompletionDeliveries).set({ targetRunId: replacementId, attempts: 1 })
        .where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      if (winner === "superseded") {
        await tx.update(issues).set({ status: "todo", statusVersion: 3 }).where(eq(issues.id, outbox.taskId));
        await tx.update(chatCompletionDeliveries).set({ status: "superseded" }).where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
      }
    });
    const waiting = async (count: number) => vi.waitFor(async () => {
      const [row] = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
          and query like '%from "issues"%' and query like '%for update%'`);
      expect(row.waiting).toBeGreaterThanOrEqual(count);
    }, { timeout: 5000 });
    try {
      await Promise.race([locked, blocker]);
      vi.setSystemTime(started + 300_000);
      first = outbox.service.deliver(outbox.deliveryId); void first.catch(() => undefined);
      await waiting(1);
      if (winner === "new-claim") {
        vi.setSystemTime(started + 360_000);
        second = outbox.service.deliver(outbox.deliveryId); void second.catch(() => undefined);
        await waiting(2);
      }
      release(); await blocker; await first; await second;
      if (winner === "new-claim") {
        expect(outbox.wakeup).toHaveBeenCalledTimes(1);
        expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1 });
      } else {
        expect(outbox.wakeup).not.toHaveBeenCalled();
        if (winner === "delivered") expect((await outbox.delivery()).status).toBe("delivered");
        if (winner === "retargeted") expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: replacementId, attempts: 1 });
        if (winner === "superseded") expect((await outbox.delivery()).status).toBe("superseded");
      }
      expect(await comments(f.runId)).toEqual([]);
    } finally {
      release?.(); await Promise.allSettled([blocker, first, second].filter((value): value is Promise<unknown> => Boolean(value)));
      vi.useRealTimers();
    }
  });

  it("rechecks the fresh delivery when retry holds the child lock before presentation reads", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const suffix = randomUUID().replaceAll("-", ""), lockId = Number.parseInt(suffix.slice(0, 6), 16) + 1;
    const trigger = `completion_retry_hold_${suffix}`;
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    let blocker: Promise<unknown> | undefined, presentation: Promise<unknown> | undefined, expiry: Promise<unknown> | undefined;
    try {
      await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if OLD.id = '${outbox.deliveryId}'::uuid and NEW.target_run_id is null then perform pg_advisory_xact_lock(${lockId}); end if;
          return NEW;
        end $$`));
      await db.execute(sql.raw(`create trigger ${trigger} before update of target_run_id on chat_completion_deliveries for each row execute function ${trigger}()`));
      blocker = db.transaction(async tx => { await tx.execute(sql`select pg_advisory_xact_lock(${lockId}::bigint)`); acquired(); await hold; });
      await Promise.race([locked, blocker]);
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      vi.setSystemTime(started + 300_000);
      expiry = outbox.service.deliver(outbox.deliveryId); void expiry.catch(() => undefined);


      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_locks
          where locktype = 'advisory' and classid = 0 and objid = ${lockId}::oid and not granted
            and database = (select oid from pg_database where datname = current_database())) as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      presentation = work.check(entry); void presentation.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%from "issues"%' and query like '%for update%') as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      release(); await blocker; await expiry;
      const [outcome] = await Promise.allSettled([presentation]);
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason.message).toBe("chat_completion_superseded");
      expect(await comments(f.runId)).toEqual([]);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
    } finally {
      release?.(); await Promise.allSettled([blocker, presentation, expiry].filter((value): value is Promise<unknown> => Boolean(value)));
      await db.execute(sql.raw(`drop trigger if exists ${trigger} on chat_completion_deliveries`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
      vi.useRealTimers();
    }
  });

  it.each(["within-grace", "at-expiry"])("preserves a Done reassignment's completion event %s and still retries at expiry", async when => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f), reassignedAgent = randomUUID();
      await db.insert(agents).values({ id: reassignedAgent, companyId: f.companyId, name: "New task owner", adapterType: "paperclip_runner" });
      await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(started + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const updated = await issueService(db).update(outbox.taskId, { assigneeAgentId: reassignedAgent });
      expect(updated).toMatchObject({ status: "done", statusVersion: 3, assigneeAgentId: reassignedAgent });
      expect(await outbox.delivery()).toMatchObject({ status: "queued", statusVersion: 2, targetRunId: f.runId, attempts: 0 });
      if (when === "within-grace") {
        await outbox.service.deliver(outbox.deliveryId);
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
          nextAttemptAt: new Date(started + 120_000) });
        expect(outbox.wakeup).not.toHaveBeenCalled();
      }
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, statusVersion: 2 });
      expect(await comments(f.runId)).toEqual([]);
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 3, assigneeAgentId: reassignedAgent });
    } finally { vi.useRealTimers(); }
  });

  it("returns the fresh saved reply receipt after waiting for the child lock", async () => {
    const f = await fixture(), outbox = await completion(f);
    const [saved] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorAgentId: f.agentId, createdByRunId: f.runId, body: f.reply }).returning();
    let release!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, outbox.taskId)).for("update"); acquired(); await hold;
      await tx.update(chatCompletionDeliveries).set({ status: "delivered", responseCommentId: saved.id })
        .where(eq(chatCompletionDeliveries.id, outbox.deliveryId));
    });
    let reader: Promise<Awaited<ReturnType<typeof existingChatCompletionReply>>> | undefined;
    try {
      await Promise.race([locked, blocker]);
      reader = db.transaction(tx => existingChatCompletionReply(tx, f.runId, f.issueId)); void reader.catch(() => undefined);
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%from "issues"%' and query like '%for update%') as waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 5000 });
      release(); await blocker;
      expect(await reader).toMatchObject({ id: saved.id, body: f.reply, createdByRunId: f.runId });
      expect(await comments(f.runId)).toHaveLength(1);
    } finally { release?.(); await Promise.allSettled([blocker, reader]); }
  });

  it("does not let an old hold shorten a newer claim's lease", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    const f = await fixture(), outbox = await completion(f);
    const notify = nativeResponseNotifications.notifyNativeResponsePresentation;
    let release!: () => void, notified!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { notified = resolve; });
    const spy = vi.spyOn(nativeResponseNotifications, "notifyNativeResponsePresentation").mockImplementationOnce(async (tx, scope) => {
      await notify(tx, scope); notified(); await hold;
    });
    let old: Promise<unknown> | undefined;
    try {


      old = outbox.service.deliver(outbox.deliveryId); void old.catch(() => undefined);
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 5000 }); await ready;
      vi.setSystemTime(started + 60_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
        nextAttemptAt: new Date(started + 120_000) });
      release(); await old;
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
        nextAttemptAt: new Date(started + 120_000) });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await comments(f.runId)).toEqual([]);
    } finally { release?.(); await Promise.allSettled(old ? [old] : []); spy.mockRestore(); vi.useRealTimers(); }
  });

  it("saves a legitimate delayed reply before the fixed limit without another model run", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      for (const elapsed of [0, 60_000, 120_000, 240_000]) {
        vi.setSystemTime(started + elapsed);
        await outbox.service.deliver(outbox.deliveryId);
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0, responseCommentId: null });
        expect(outbox.wakeup).not.toHaveBeenCalled();
      }
      vi.setSystemTime(started + 299_999);
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      await expect(work.check(entry)).resolves.toBeNull();
      const [comment] = await comments(f.runId);
      expect(comment).toMatchObject({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId });
      expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
      expect(await outbox.delivery()).toMatchObject({ status: "delivered", targetRunId: f.runId, attempts: 0, responseCommentId: comment.id });
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await comments(f.runId)).toHaveLength(1);
      expect(outbox.wakeup).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("clamps an external native retry deadline to the immutable five-lease presentation limit", async () => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(started + 86_400_000) })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
        nextAttemptAt: new Date(started + 300_000) });
      expect(outbox.wakeup).not.toHaveBeenCalled();
      expect(await comments(f.runId)).toEqual([]);
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1 });
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(["digest", "external-context"])("bounds permanent %s declines without sliding, publishing or changing accepted work", async fault => {
    const started = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(started);
    try {
      const f = await fixture(), outbox = await completion(f);
      if (fault === "digest") await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
      else {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, externalChatContinuation: true } }).where(eq(heartbeatRuns.id, f.runId));
      }
      const [acceptedBefore] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
      const work = nativeResponsePresentationWork(db), [entry] = await work.load(f.input);
      for (const elapsed of [0, 60_000, 120_000, 240_000]) {
        vi.setSystemTime(started + elapsed);
        await outbox.service.deliver(outbox.deliveryId);
        await expect(work.check(entry)).resolves.toBeNull();
        expect(await comments(f.runId)).toEqual([]);
        expect(await outbox.delivery()).toMatchObject({ status: "queued", targetRunId: f.runId, attempts: 0,
          responseCommentId: null, nextAttemptAt: new Date(started + Math.min(elapsed + 60_000, 300_000)) });
        expect(outbox.wakeup).not.toHaveBeenCalled();
      }
      vi.setSystemTime(started + 299_999);
      await outbox.service.deliver(outbox.deliveryId);
      expect((await outbox.delivery()).nextAttemptAt).toEqual(new Date(started + 300_000));
      vi.setSystemTime(started + 300_000);
      await outbox.service.deliver(outbox.deliveryId);
      expect(await outbox.delivery()).toMatchObject({ status: "pending", targetRunId: null, attempts: 1, responseCommentId: null });
      expect(outbox.wakeup).toHaveBeenCalledTimes(1);
      expect(await comments(f.runId)).toEqual([]);
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId)))[0]).toEqual(acceptedBefore);
      expect(await issue(outbox.taskId)).toMatchObject({ status: "done", statusVersion: 2 });
    } finally { vi.useRealTimers(); }
  });

  it("finds a committed final Agent Chat turn, persists the exact reply once and only then settles waiting", async () => {
    const f = await fixture();
    expect(await comments(f.runId)).toEqual([]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", conversationState: "active" });
    const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
    expect(entries).toEqual([expect.objectContaining({ id: f.runId })]);
    await expect(work.check(entries[0])).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId })]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
    expect(await work.load(f.input)).toEqual([]);
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toHaveLength(1);
  });
  it("recovers a server-finished yielded conversation from its completed unknown-channel reply", async () => {
    const f = await fixture(true, { disposition: "yielded", channel: "unknown" });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId)))[0])
      .toMatchObject({ reasonCode: "conversation_turn_finished" });
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(true);
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: f.reply, createdByRunId: f.runId })]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_review", conversationState: "waiting" });
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toHaveLength(1);
  });

  it("presents an invite join link from database run events, never from the redacted run log", async () => {
    // The run log redacts invitation tokens; the person must still receive the
    // working join link, so the reply must come from the stored run events.
    const token = "pcp_invite_FixtureInviteToken-0123456789_abcdefghijklmnopqrstu";
    const reply = `Created the invite.\n\n**Invite link:** [Join Company](http://127.0.0.1:3100/invite/${token})`;
    expect(compactRunLogChunk(reply)).not.toContain(token);
    const f = await fixture(true, { reply, logRef: `${randomUUID()}/${randomUUID()}/redacted-run.ndjson` });
    runLogReads.length = 0;
    const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
    await expect(work.check(entries[0])).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: reply, createdByRunId: f.runId })]);
    expect(runLogReads).toEqual([]);
  });
  it("keeps a later user message actionable after recovering the earlier exact reply", async () => {
    const f = await fixture();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: f.userId, body: "Another instruction",
      createdAt: new Date("2020-01-01T00:01:00Z") });
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(true);
    expect(await comments(f.runId)).toHaveLength(1);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", conversationState: "active" });
  });
  it("does not duplicate a reply under concurrent recovery", async () => {
    const f = await fixture();
    expect((await Promise.all([recoverCommittedNativeChatResponse(db, f.input), recoverCommittedNativeChatResponse(db, f.input)])).sort())
      .toEqual([false, true]);
    expect(await comments(f.runId)).toHaveLength(1);
  });
  it.each(["skip", "generation", "agent", "user", "execution", "waiting", "turn", "event-run", "session", "channel", "kind", "digest", "partial"])(
    "keeps %s mismatches unchanged instead of publishing an unauthorized or incomplete reply", async fault => {
      const f = await fixture();
      if (["skip", "generation"].includes(fault)) await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId,
        source: "issue.comment", wakeCommentId: f.wakeId, conversationSessionGeneration: fault === "generation" ? 1 : 0,
        ...(fault === "skip" ? { skipIssueComment: true } : {}) } }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "user") await db.update(heartbeatRuns).set({ responsibleUserId: "another-user" }).where(eq(heartbeatRuns.id, f.runId));
      if (fault === "agent") {
        const other = randomUUID(); await db.insert(agents).values({ id: other, companyId: f.companyId, name: "Other agent" });
        await db.update(issues).set({ conversationAgentId: other, assigneeAgentId: other }).where(eq(issues.id, f.issueId));
      }
      if (fault === "execution") {
        const other = randomUUID(); await db.insert(heartbeatRuns).values({ id: other, companyId: f.companyId, agentId: f.agentId });
        await db.update(issues).set({ executionRunId: other }).where(eq(issues.id, f.issueId));
      }
      if (fault === "waiting") await db.update(issues).set({ executionRunId: null, status: "in_review", conversationState: "waiting" }).where(eq(issues.id, f.issueId));
      if (["turn", "event-run", "session", "channel", "kind"].includes(fault)) {
        const event = structuredClone(f.prpEvent);
        if (fault === "turn") event.turnId = "foreign-turn";
        if (fault === "event-run") event.runId = randomUUID();
        if (fault === "session") event.normalizedSessionId = randomUUID();
        if (fault === "channel") event.payload.channel = "analysis";
        if (fault === "kind") event.payload.kind = "reasoning";
        await db.update(heartbeatRunEvents).set({ payload: { prpEvent: event } }).where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 170)));
      }
      if (fault === "digest") await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
      if (fault === "partial") await db.update(nativeRunFinalizations).set({ phase: "copying_back" }).where(eq(nativeRunFinalizations.runId, f.runId));
      const before = await issue(f.issueId);
      await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
      expect(await comments(f.runId)).toEqual([]); expect(await issue(f.issueId)).toEqual(before);
    },
  );
  it.each([false, true])("preserves a selected reply without replacing or resurrecting it (deleted=%s)", async deleted => {
    const f = await fixture();
    const [saved] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      createdByRunId: f.runId, body: "Already selected", ...(deleted ? { deletedAt: new Date("2020-01-01T00:03:00Z") } : {}) }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentId: saved.id, commentAction: "create" } } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toEqual([saved]);
  });
  it("never crosses company scope and keeps ordinary internal task response recovery intact", async () => {
    const f = await fixture(false);
    await expect(recoverCommittedNativeChatResponse(db, { ...f.input, companyId: randomUUID() })).resolves.toBe(false);
    const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
    expect(entries).toHaveLength(1); await expect(work.check(entries[0])).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: f.reply })]);
    expect((await issue(f.issueId)).conversationAgentId).toBeNull();
  });
  it("recovers a deferred review reply once without resolving the review or rerunning work", async () => {
    const f = await fixture(false, { disposition: "needs_review" });
    const before = await issue(f.issueId);
    const reviews = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(before.status).toBe("in_review");
    expect(reviews).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(await comments(f.runId)).toEqual([]);
    const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
    expect(entries).toHaveLength(1);
    await expect(work.check(entries[0])).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: f.reply, createdByRunId: f.runId })]);
    expect(await issue(f.issueId)).toEqual({ ...before, updatedAt: expect.any(Date) });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toEqual(reviews);
    expect(await work.load(f.input)).toEqual([]);
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
  });
  it.each(["missing-final", "wrong-turn", "digest", "skip-comment"])(
    "keeps deferred review response recovery closed for %s", async fault => {
      const f = await fixture(false, { disposition: "needs_review" });
      if (fault === "missing-final") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
      if (fault === "wrong-turn") await db.update(heartbeatRunEvents).set({ payload: { prpEvent: { ...f.prpEvent, turnId: "another-turn" } } })
        .where(and(eq(heartbeatRunEvents.runId, f.runId), eq(heartbeatRunEvents.seq, 170)));
      if (fault === "digest") await db.update(nativeRunResults).set({ canonicalSha256: "invalid-digest" }).where(eq(nativeRunResults.runId, f.runId));
      if (fault === "skip-comment") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, skipIssueComment: true } }).where(eq(heartbeatRuns.id, f.runId));
      const before = await issue(f.issueId);
      await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
      expect(await comments(f.runId)).toEqual([]);
      expect(await issue(f.issueId)).toEqual(before);
    },
  );
  it("rolls back a partial reply write without changing the waiting state or consuming recovery", async () => {
    const f = await fixture(), abort = new Error("fixture-commit-aborted");
    const failing = new Proxy(db, { get(target, key) { return key === "transaction"
      ? (callback: Parameters<Db["transaction"]>[0]) => db.transaction(async tx => { await callback(tx); throw abort; })
      : Reflect.get(target, key); } });
    await expect(recoverCommittedNativeChatResponse(failing, f.input)).rejects.toBe(abort);
    expect(await comments(f.runId)).toEqual([]);
    expect(await issue(f.issueId)).toMatchObject({ status: "in_progress", conversationState: "active" });
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(true);
    expect(await comments(f.runId)).toHaveLength(1);
  });

  // A chat turn can end while its task stays held: a resubmitted approval or
  // an execution stage keeps the status, but the turn still answered the
  // person. A restart between the status commit and the live presentation
  // must not lose that answer. The run is saved exactly as the previous
  // release's finalizer saves it, with no presentation recorded yet.
  type Hold = "pending approval" | "approval sent back for revision" | "execution stage" | "own question card"
    | "someone else's confirmation card";
  async function heldTurn(hold: Hold, disposition: "yielded" | "done" = "yielded") {
    return fixture(true, { disposition, beforeFinalize: async ({ companyId, issueId, runId, agentId }) => {
      if (hold.includes("approval")) {
        const [approval] = await db.insert(approvals).values({ companyId, type: "hire_agent",
          status: hold === "pending approval" ? "pending" : "revision_requested", payload: { name: "Researcher" } }).returning();
        await db.insert(issueApprovals).values({ companyId, issueId, approvalId: approval.id });
      }
      if (hold === "execution stage") await db.update(issues).set({ executionState: { status: "pending" } }).where(eq(issues.id, issueId));
      if (hold === "own question card") {
        await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "pending",
          sourceRunId: runId, createdByAgentId: agentId, payload: { version: 1, questions: [{ id: "model", prompt: "Which model?",
            selectionMode: "single", required: true, options: [{ id: "flash", label: "Flash" }] }] } });
      }
      // The board addressed this card to another person; the run did not create it.
      if (hold === "someone else's confirmation card") {
        await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_confirmation", status: "pending",
          continuationPolicy: "none", title: "Riley's website proposal", requestedResolverPolicy: "human_only",
          effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit", addresseeUserId: "riley",
          createdByUserId: "local-board", payload: { version: 1, prompt: "Riley: approve creating the website implementation task?" } });
      }
    } });
  }
  it.each([
    ["pending approval", "yielded"], ["approval sent back for revision", "yielded"], ["execution stage", "yielded"],
    ["pending approval", "done"], ["someone else's confirmation card", "yielded"],
  ] as const)(
    "recovers a held conversation turn's answer exactly once after a restart: %s (%s)", async (hold, disposition) => {
      const f = await heldTurn(hold, disposition);
      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
      expect(decision.reasonCode).not.toBe("conversation_turn_finished");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson)
        .not.toHaveProperty("presentationDecision");
      expect(await comments(f.runId)).toEqual([]);
      const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
      expect(entries).toEqual([expect.objectContaining({ id: f.runId })]);
      await expect(work.check(entries[0])).resolves.toBeNull();
      expect(await comments(f.runId)).toEqual([expect.objectContaining({ body: f.reply, authorAgentId: f.agentId, createdByRunId: f.runId })]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson).toMatchObject({
        presentationDecision: { chosenSource: "final_agent_message", commentAction: "create", commentId: expect.any(String) } });
      expect(await issue(f.issueId)).toMatchObject({ conversationState: "waiting" });
      expect(await work.load(f.input)).toEqual([]);
      await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
      expect(await comments(f.runId)).toHaveLength(1);
    },
  );
  it("does not repost a held conversation turn's answer that the live path already presented", async () => {
    const f = await heldTurn("pending approval");
    const [saved] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      createdByRunId: f.runId, body: f.reply }).returning();
    await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
      presentationDecision: { chosenSource: "final_agent_message", commentAction: "create", commentId: saved.id, reasonCodes: [] } })}::jsonb` })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await nativeResponsePresentationWork(db).load(f.input)).toEqual([]);
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toEqual([saved]);
  });
  it("keeps a held turn's presentation that the previous release's live path already recorded", async () => {
    // Before the live answered rule, a held yielded turn was recorded as a
    // control-plane wait. That decision stands; recovery never re-presents it.
    const f = await heldTurn("pending approval");
    await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
      presentationDecision: { chosenSource: "none", commentAction: "none", reasonCodes: ["yielded_control_plane_wait"] } })}::jsonb` })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await nativeResponsePresentationWork(db).load(f.input)).toEqual([]);
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toEqual([]);
  });
  it("settles a held conversation turn presented by its own question card without posting its prose", async () => {
    const f = await heldTurn("own question card");
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    expect(cards).toEqual([expect.objectContaining({ kind: "ask_user_questions", status: "pending", sourceRunId: f.runId })]);
    const work = nativeResponsePresentationWork(db), entries = await work.load(f.input);
    expect(entries).toEqual([expect.objectContaining({ id: f.runId })]);
    await expect(work.check(entries[0])).resolves.toBeNull();
    expect(await comments(f.runId)).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson).toMatchObject({
      presentationDecision: { chosenSource: "none", commentAction: "none" } });
    // Settled like the live path: the card is the turn's response.
    expect(await issue(f.issueId)).toMatchObject({ conversationState: "waiting" });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toEqual(cards);
    expect(await work.load(f.input)).toEqual([]);
    await expect(recoverCommittedNativeChatResponse(db, f.input)).resolves.toBe(false);
    expect(await comments(f.runId)).toEqual([]);
  });
});
