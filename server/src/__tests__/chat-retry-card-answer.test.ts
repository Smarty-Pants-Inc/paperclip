// PERSON CASE: in a chat, a person answers a card; the run carrying that answer fails; the chat shows
// "Couldn't finish this attempt" with a Retry button; the person presses it. The retried agent must SEE the
// person's card answer ONCE in its input, and the answer counts answered after the reply.
// REAL, over HTTP: the chat is opened (POST /companies/:id/chats/:agentId), the person's message is posted
// (POST /issues/:id/comments), the card is answered (POST /issues/:id/interactions/:id/respond: the real resolver AND
// the real answer delivery, which admits the run that carries the answer), and Retry is pressed on each of the two
// Retry routes a chat has: the notice's Retry (POST /issues/:id/retry, ExecutionBlockerNotice -> useTaskRetry) and
// the chat thread's failed-attempt Retry (POST /agents/:id/wakeup with failedRunId, TaskChatThread ->
// agentsApi.retryFailedRun). REAL beneath them: requestTaskRetry -> resumeTaskRetry, heartbeat.wakeup's exact
// failed-run retry, the runtime materializer of the successor's native input (materializeNativeInteractionResponses),
// the one carry (readContinuationCommentInput) and the one answered rule (answeredPersonMessageSql), real PostgreSQL.
// PLANTED, named in each row: the company / agent, the asking run's completion and the card row it asked (no
// provider runs here), the FAILURE of the run that carried the answer, and the successor's completion + reply.
// Run admission is closed with the service's shutdown fence, so accepted runs stay queued and no adapter starts.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, chatActions, chatConversations, chatEndpoints, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issues, issueThreadInteractions, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { chatChannelService, type ChatChannelService, type ChatChannelServiceOptions } from "../services/chat-channels.js";
import { readContinuationCommentInput } from "../services/continuation-comment-input.js";
import { heartbeatService } from "../services/heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { materializeNativeInteractionResponses } from "../services/native-runtime/native-interaction-bridge.js";
import { answeredPersonMessageSql } from "../services/person-message-answer.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("Retry in a chat after a failed card-answer run: the successor sees the person's answer, once", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const userId = `chat-retry-card-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("chat-retry-card-answer-");
    db = createDb(database.connectionString);
    closeProcessRunAdmission();
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);
  afterAll(async () => {
    await chatChannels?.shutdown();
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client.end();
    await database?.cleanup();
    resetProcessRunAdmissionForTests();
  });

  let chatChannels: ChatChannelService | undefined;
  function appForPerson() {
    // REAL chat-action Retry owner (services/chat-channels/failed-run-retry.ts) over the real heartbeat wake; its
    // provider runtime is not started (no provider is contacted in these rows).
    chatChannels ??= chatChannelService(db, { heartbeat: heartbeatService(db),
      runtime: { shutdown: async () => undefined, hasUnsettledLifecycle: () => false } as unknown as ChatChannelServiceOptions["runtime"] });
    const chatRunRetries = { prepareFailedChatRunRetry: chatChannels.prepareFailedChatRunRetry,
      processFailedChatRunRetry: chatChannels.processFailedChatRunRetry };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId }; next(); });
    app.use("/api", issueRoutes(db, {} as never, { chatRunRetries }));
    app.use("/api", agentRoutes(db, { chatRunRetries }));
    app.use(errorHandler);
    return app;
  }
  const runsOf = (companyId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  type Run = typeof heartbeatRuns.$inferSelect;
  async function waitForRun(companyId: string, match: (run: Run) => boolean) {
    for (const deadline = Date.now() + 4_000; Date.now() < deadline;) {
      const run = (await runsOf(companyId)).find(match);
      if (run) return run;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return undefined;
  }

  /** A chat where the person answered a card and the run that carried the answer failed. */
  async function fixture(kind: "agent-chat" | "connected-task" = "agent-chat") {
    // PLANTED: the company, the person's membership and the chat's agent.
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Chat retry card answer",
      issuePrefix: `CR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }).returning();
    const managed = await agentInstructionsService(db).materializeManagedBundle(agent!, { "AGENTS.md": "Reply to the person in this chat.\n" });
    await db.update(agents).set({ adapterConfig: managed.adapterConfig }).where(eq(agents.id, agentId));
    const app = appForPerson();
    let issueId: string;
    if (kind === "agent-chat") {
      // REAL route: the person opens the chat.
      const opened = await request(app).post(`/api/companies/${companyId}/chats/${agentId}`).send({}).expect(200);
      issueId = opened.body.id as string;
      expect(opened.body).toMatchObject({ conversationAgentId: agentId, conversationUserId: userId });
    } else {
      // PLANTED: a task whose conversation is connected to an outside chat (a restricted Slack endpoint), so the
      // notice's Retry goes to the chat-action owner (task-retry.ts -> prepareFailedChatRunRetry).
      issueId = randomUUID();
      const applicationId = randomUUID(), connectionId = randomUUID(), endpointId = randomUUID(), conversationId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Continue the answered scope", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, createdByUserId: userId });
      await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
      await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId,
        transport: "chat_sdk", connectionPurpose: "channel" });
      await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId,
        assignedAgentId: agentId, publicationMode: "automatic", externalExecutionPolicy: "restricted" });
      await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId,
        externalConversationId: conversationId, externalLabel: "Connected", state: "active" });
    }
    // REAL route: the person sends a message; its run is admitted (queued; admission is closed).
    const message = await request(app).post(`/api/issues/${issueId}/comments`)
      .send({ body: "Ask me the scope before continuing.", clientRequestId: randomUUID() }).expect(201);
    const asking = await waitForRun(companyId, run => run.contextSnapshot?.wakeCommentId === message.body.id ||
      run.contextSnapshot?.commentId === message.body.id);
    expect(asking, "the message's run").toBeDefined();
    // PLANTED: that run asked the card and finished (no provider runs here), with its reply to the message.
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", nativeIssueId: issueId,
      startedAt: new Date(Date.now() - 9_000), finishedAt: new Date(Date.now() - 8_000) }).where(eq(heartbeatRuns.id, asking!.id));
    await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId, createdByRunId: asking!.id,
      body: "Which scope?", createdAt: new Date(Date.now() - 8_000) });
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId: asking!.id, kind: "ask_user_questions",
      status: "pending", createdByAgentId: agentId, addresseeUserId: userId, continuationPolicy: "wake_assignee",
      createdAt: new Date(Date.now() - 8_000),
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", required: true, selectionMode: "single",
        options: [{ id: "first", label: "First exact scope" }] }] } }).returning();
    // REAL route: the person answers the card. The real delivery admits the run that carries the answer.
    await request(app).post(`/api/issues/${issueId}/interactions/${card!.id}/respond`)
      .send({ answers: [{ questionId: "scope", optionIds: ["first"] }] }).expect(200);
    const carrying = await waitForRun(companyId, run => run.id !== asking!.id &&
      (run.contextSnapshot?.interactionId === card!.id ||
        (Array.isArray(run.contextSnapshot?.interactionIds) && run.contextSnapshot.interactionIds.includes(card!.id))));
    expect(carrying, "the real answer delivery admitted a run that carries the card answer").toBeDefined();
    // PLANTED: the run that carried the answer FAILED before it replied.
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      nativePhase: "terminal_failure", errorCode: "adapter_failed", error: "Injected failure of the run carrying the card answer",
      startedAt: new Date(Date.now() - 2_000), finishedAt: new Date(Date.now() - 1_000), updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, carrying!.id));
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, carrying!.id));
    return { kind, app, companyId, agentId, issueId, cardId: card!.id, failed: failed! };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** The successor's card-answer input, as its runtime selection builds it (runtime-selection.ts: interactionId +
   * interactionIds from the run's own context, through the REAL materializer). */
  async function materializedCardAnswers(f: Fixture, run: Run) {
    const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
    const single = typeof context.interactionId === "string" ? [context.interactionId] : [];
    const interactionIds = Array.isArray(context.interactionIds)
      ? [...new Set([...single, ...context.interactionIds.filter((id): id is string => typeof id === "string")])] : single;
    return materializeNativeInteractionResponses({ db, companyId: f.companyId, issueId: f.issueId, runId: run.id, agentId: f.agentId,
      wakeReason: typeof context.wakeReason === "string" ? context.wakeReason : undefined, interactionIds });
  }

  /** The one answered rule, keyed as its production callers key a card answer: the card's id and its answer time. */
  const cardAnswerAnswered = async (cardId: string) => (await db.select({ answered: sql<boolean>`${answeredPersonMessageSql({
    id: sql`${issueThreadInteractions.id}`, companyId: sql`${issueThreadInteractions.companyId}`,
    issueId: sql`${issueThreadInteractions.issueId}`, createdAt: sql`${issueThreadInteractions.resolvedAt}` })}` })
    .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, cardId)))[0]!.answered;

  /** REAL: the notice's Retry ("Couldn't finish this attempt" -> Retry). */
  const pressNoticeRetry = (f: Fixture, idempotencyKey = randomUUID()) => request(f.app).post(`/api/issues/${f.issueId}/retry`)
    .send({ idempotencyKey, observedRunId: f.failed.id });
  /** REAL: the chat thread's failed-attempt Retry, as the UI sends it (ui/src/api/agents.ts retryFailedRun). */
  const pressThreadRetry = (f: Fixture, failedRunId = f.failed.id) => request(f.app).post(`/api/agents/${f.agentId}/wakeup`)
    .send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId });
  /** The runs a Retry of `failedRunId` admitted. */
  const isSuccessorOf = (failedRunId: string) => (run: Run) => run.id !== failedRunId &&
    (run.retryOfRunId === failedRunId || run.contextSnapshot?.previousRunId === failedRunId);
  const successors = async (f: Fixture, failedRunId = f.failed.id) => (await runsOf(f.companyId)).filter(isSuccessorOf(failedRunId));
  const failRun = (runId: string, issueId: string) => db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native",
    nativeIssueId: issueId, nativePhase: "terminal_failure", errorCode: "adapter_failed", error: "Injected failure",
    startedAt: new Date(Date.now() - 2_000), finishedAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
    .where(eq(heartbeatRuns.id, runId));
  const chatActionsOf = (f: Fixture) => db.select({ kind: chatActions.kind }).from(chatActions).where(eq(chatActions.companyId, f.companyId));

  /** PLANTED: the successor completes and replies (no provider runs here). */
  async function successorReplies(f: Fixture, successor: Run) {
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(Date.now() - 500), finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, successor.id), eq(heartbeatRuns.companyId, f.companyId)));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: successor.id, body: "Continuing with the first exact scope.", createdAt: new Date() });
  }

  it.each([
    ["a chat, the notice's Retry (POST /issues/:id/retry)", "agent-chat", "notice"],
    ["a chat, the thread's Retry (POST /agents/:id/wakeup, failedRunId)", "agent-chat", "thread"],
    ["a connected conversation, the notice's Retry (POST /issues/:id/retry, offered to the chat-action owner first)", "connected-task", "notice"],
  ] as const)("%s: the successor is given the card answer exactly once, and its reply counts as the answer", async (_name, kind, button) => {
    const press = (f: Fixture) => button === "notice" ? pressNoticeRetry(f) : pressThreadRetry(f);
    const f = await fixture(kind);
    // The REAL carrying run names the card as the answer delivery names it: the singular interactionId.
    expect(f.failed.contextSnapshot).toMatchObject({ source: "issue.interaction.respond", interactionId: f.cardId });
    expect(await cardAnswerAnswered(f.cardId), "the failed run answered nothing: the card answer is still owed").toBe(false);

    const first = await press(f);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const successor = await waitForRun(f.companyId, isSuccessorOf(f.failed.id));
    expect(successor, "Retry admitted a successor").toBeDefined();
    expect(await successors(f), "one successor").toHaveLength(1);
    const context = successor!.contextSnapshot as Record<string, unknown>;
    expect(context).toMatchObject({ forceFreshSession: true, previousRunId: f.failed.id,
      wakeReason: button === "notice" ? "task_retry" : "retry_failed_run" });
    const answers = await materializedCardAnswers(f, successor!);
    expect(answers.map(answer => answer.interactionId), "the card answer appears exactly once in the materialized input").toEqual([f.cardId]);
    expect(JSON.stringify(answers[0]!.response), "it is the person's answer").toContain("first");
    expect(context.interactionIds, "the still-owed card answer is the successor's own input").toEqual([f.cardId]);
    expect(context.interactionId, "a Retry is not an interaction-continuation wake").toBeUndefined();
    // The chat-action owner (failed-run-retry.ts) repeats an exact outside chat request only; it refuses the run
    // that carried a card answer, so the Retry continues as a task Retry and no chat action is minted.
    expect(await chatActionsOf(f)).toEqual([]);

    // A second press adds no run and no second copy of the answer.
    await press(f);
    await new Promise(resolve => setTimeout(resolve, 300));
    const again = await successors(f);
    expect(again.map(run => run.id)).toEqual([successor!.id]);
    expect((await materializedCardAnswers(f, again[0]!)).map(answer => answer.interactionId)).toEqual([f.cardId]);

    expect(await cardAnswerAnswered(f.cardId), "queued, no reply yet: still owed").toBe(false);
    await successorReplies(f, successor!);
    expect(await cardAnswerAnswered(f.cardId), "the successor's own input names the card, so its reply answers it").toBe(true);
    expect(await readContinuationCommentInput(db, { companyId: f.companyId, issueId: f.issueId, runId: successor!.id }),
      "answered: never carried again").toEqual({});
  }, 120_000);

  it("a chat, the thread's Retry of a successor that failed too still gives the card answer exactly once", async () => {
    const f = await fixture();
    expect((await pressThreadRetry(f)).status).toBe(202);
    const first = await waitForRun(f.companyId, isSuccessorOf(f.failed.id));
    expect(first).toBeDefined();
    // PLANTED: the first successor fails too, before it replied.
    await failRun(first!.id, f.issueId);
    expect(await cardAnswerAnswered(f.cardId)).toBe(false);

    expect((await pressThreadRetry(f, first!.id)).status).toBe(202);
    const second = await waitForRun(f.companyId, isSuccessorOf(first!.id));
    expect(second, "the second Retry admitted its own successor").toBeDefined();
    expect(await successors(f, first!.id)).toHaveLength(1);
    expect((await materializedCardAnswers(f, second!)).map(answer => answer.interactionId)).toEqual([f.cardId]);
    expect((second!.contextSnapshot as Record<string, unknown>).interactionIds).toEqual([f.cardId]);
    await successorReplies(f, second!);
    expect(await cardAnswerAnswered(f.cardId)).toBe(true);
  }, 120_000);

  it("a chat, the thread's Retry: a card answer that was already answered is not given to the successor again", async () => {
    const f = await fixture();
    // PLANTED: a run whose own input names the card succeeded and replied after the answer and before the failed
    // run (which still names the card), so the answer is ANSWERED.
    const [answering] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId, interactionIds: [f.cardId] },
      createdAt: new Date(f.failed.createdAt.getTime() - 1), finishedAt: new Date() }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: answering!.id, body: "Done with the first exact scope.", createdAt: new Date() });
    expect(await cardAnswerAnswered(f.cardId)).toBe(true);

    expect((await pressThreadRetry(f)).status).toBe(202);
    const successor = await waitForRun(f.companyId, isSuccessorOf(f.failed.id));
    expect(successor).toBeDefined();
    expect((successor!.contextSnapshot as Record<string, unknown>).interactionIds, "nothing owed: nothing carried").toBeUndefined();
    expect(await materializedCardAnswers(f, successor!)).toEqual([]);
  }, 120_000);

  it("a connected conversation, the thread's Retry: refused in words and starts nothing; the notice's Retry then carries the card answer once", async () => {
    const f = await fixture("connected-task");
    // The chat-action owner repeats an exact outside chat request only. The run that carried a card answer is not
    // one, so this Retry is refused (never a successor without the answer) and names the Retry that continues.
    const refused = await pressThreadRetry(f);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "chat_failed_run_retry_not_authorized" });
    expect(refused.body.error).toContain("Retry continues the task from its saved work");
    expect(await successors(f), "a refused Retry starts nothing").toEqual([]);
    expect(await chatActionsOf(f)).toEqual([]);

    expect((await pressNoticeRetry(f)).status).toBe(202);
    const successor = await waitForRun(f.companyId, isSuccessorOf(f.failed.id));
    expect(successor).toBeDefined();
    expect((await materializedCardAnswers(f, successor!)).map(answer => answer.interactionId)).toEqual([f.cardId]);
  }, 120_000);
});
