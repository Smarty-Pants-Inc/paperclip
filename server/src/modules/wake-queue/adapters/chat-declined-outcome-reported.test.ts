import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../../middleware/index.js";
import { issueRoutes } from "../../../routes/issues.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueThreadInteractions, issueTreeHolds, issueRelations, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import { ALREADY_REPORTED_WAKE_REASON, createPostgresWakeQueueAdapter } from "./postgres.js";
import { recordDeclinedInteractionRead } from "../../../services/chat-interaction-outcome-report.js";
import { readQueuedInteractionResponse, INTERACTION_RESPONSE_READ_EVENT } from "../../../services/queued-interaction-response.js";
import * as runEvents from "../../../services/heartbeat-run-events.js";
import * as responseReads from "../../../services/queued-interaction-response.js";
import { issueService } from "../../../services/issues.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../../../services/heartbeat/run-lifecycle.js";
import { createHeartbeatRunPreparation } from "../../../services/heartbeat/run-preparation.js";
import { createHeartbeatRunState } from "../../../services/heartbeat/run-state.js";

const support = await getEmbeddedPostgresTestSupport();

// Chat eval questions-and-approvals.decline-tool: the person said "Do not use that app" and
// declined the tool review a second later. The turn woken by the message read the action
// declined and said so. The decline continuation, saved behind that turn, then posted the
// same declined outcome again.
describe.skipIf(!support.supported)("release of a decline continuation an earlier reply already reported", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("wake-chat-declined-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Declined outcome fixture", issuePrefix: "CDO" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Lead", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seed(input: { outcomeCount?: number; read: boolean; toolAction?: boolean; status?: string; historical?: number }) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Chat with CEO", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: `person-${randomUUID()}`, conversationState: "waiting" }).returning();
    // Older declines come first in the agent's interaction list.
    const history = input.historical ? await db.insert(issueThreadInteractions).values(Array.from({ length: input.historical }, (_, index) => ({
      companyId, issueId: issue.id, kind: "request_confirmation", status: "rejected", resolvedByUserId: "person",
      createdAt: new Date(Date.now() - 600_000 + index), resolvedAt: new Date(Date.now() - 500_000 + index),
      payload: { version: 1, prompt: "Approve an earlier read?", toolAction: { connectionId: randomUUID() } } as never,
    }))).returning() : [];
    const resolvedAt = new Date(Date.now() - 30_000);
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "request_confirmation",
      status: input.status ?? "rejected", resolvedAt, resolvedByUserId: "person",
      payload: { version: 1, prompt: "Approve Read launch notes?", ...(input.toolAction === false ? {} : { toolAction: { connectionId: randomUUID() } }) } as never,
    }).returning();
    // The turn woken by the person's message was running when the card was declined.
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "automation",
      startedAt: new Date(Date.now() - 31_000), contextSnapshot: { issueId: issue.id } }).returning();
    if (input.read) {
      await recordDeclinedInteractionRead(db, { companyId, agentId, runId: run.id, issue,
        interactions: [...history, card].map(row => ({ id: row.id, kind: row.kind, status: row.status, payload: row.payload })) });
    }
    const [reply] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: agentId, createdByRunId: run.id,
      body: "Understood. The approval for that read was already declined, so I won't use the app." }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await db.update(issues).set({ executionRunId: run.id, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const context = { issueId: issue.id, taskId: issue.id, interactionId: card.id, interactionIds: [card.id],
      interactionKind: "request_confirmation", interactionStatus: card.status, wakeReason: "issue_commented", source: "tool_action_review",
      ...(input.outcomeCount === undefined ? {} : { toolActionOutcomeCount: input.outcomeCount }) };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "person",
      payload: { ...context, mutation: "interaction", _paperclipWakeContext: context } }).returning();
    return { issue, run, wake, reply };
  }

  // The answer arrives after this run starts, and is read through
  // the real authorized tool/API door before the run releases its queue.
  it.each([
    { read: true, done: false, mode: "reply" }, { read: false, done: false, mode: "reply" },
    { read: true, done: true, mode: "reply" }, { read: false, done: true, mode: "reply" },
    { read: true, done: false, mode: "atomic" }, { read: true, done: false, mode: "source_comment" },
    { read: true, done: false, mode: "silent" }, { read: true, done: false, mode: "aborted" },
  ])("settles exactly a mid-run answer consumed by its live run: %j", async ({ read, done, mode }) => {
    const settle = read && mode === "reply";
    const [issue] = await db.insert(issues).values({ companyId, title: "Mid-run card answer", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "running",
      responsibleUserId: "person", startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: issue.id } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "ask_user_questions", status: "answered",
      sourceRunId: run.id, createdByAgentId: agentId, resolvedByUserId: "person", resolvedAt: new Date(),
      payload: { version: 1, questions: [{ id: "price", prompt: "Price?", selectionMode: "single", options: [{ id: "custom", label: "Price", freeText: true }] }] } as never,
      result: { version: 1, answers: [{ questionId: "price", optionIds: [], otherText: "$90" }] } as never }).returning();
    const context = { issueId: issue.id, taskId: issue.id, interactionId: card.id, interactionKind: card.kind,
      interactionStatus: card.status, mutation: "interaction", source: "issue.interaction.respond", wakeReason: "issue_commented" };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "person",
      payload: { ...context, _paperclipWakeContext: context } }).returning();
    const cards = [card]; const wakes = [wake];
    if (mode === "atomic") {
      const [second] = await db.insert(issueThreadInteractions).values({ ...card, id: randomUUID() }).returning();
      const secondContext = { ...context, interactionId: second.id };
      const [secondWake] = await db.insert(agentWakeupRequests).values({ ...wake, id: randomUUID(), requestedAt: new Date(wake.requestedAt.getTime() + 1),
        payload: { ...secondContext, _paperclipWakeContext: secondContext } }).returning();
      cards.push(second); wakes.push(secondWake);
    }
    if (mode === "source_comment") {
      const [comment] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorUserId: "person", body: "Please also check shipping." }).returning();
      await db.update(agentWakeupRequests).set({ payload: { ...wake.payload, sourceCommentId: comment.id, commentId: comment.id } }).where(eq(agentWakeupRequests.id, wake.id));
    }
    if (read) {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId: run.id }; next(); });
      // Close the real HTTP response after a partial write, without emitting finish.
      if (mode === "aborted") app.use((_req, res, next) => {
        res.json = () => { res.write("["); res.destroy(); return res; }; next();
      });
      app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);
      const receipt = vi.spyOn(responseReads, "recordInteractionResponseRead");
      const append = runEvents.appendHeartbeatRunEvent;
      const fault = mode === "atomic" ? vi.spyOn(runEvents, "appendHeartbeatRunEvent")
        .mockImplementationOnce(append).mockRejectedValueOnce(new Error("read receipt append failed")) : null;
      try {
        const response = request(app).get(`/api/issues/${issue.id}/interactions`);
        if (mode === "aborted") await expect(response).rejects.toThrow(/aborted|socket hang up|ECONNRESET/i);
        else expect((await response.expect(200)).body.find((row: { id: string }) => row.id === card.id).result.answers[0].otherText).toBe("$90");
        await Promise.allSettled(receipt.mock.results.map(result => result.value));
      } finally { receipt.mockRestore(); fault?.mockRestore(); }
      if (mode === "aborted") expect.soft((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)))
        .filter(row => row.eventType === INTERACTION_RESPONSE_READ_EVENT)).toHaveLength(0);
    }
    // Reading never barges in or removes the person's live Steer/Interrupt.
    expect(await readQueuedInteractionResponse(db, companyId, issue.id, wake.payload)).not.toBeNull();
    if (mode !== "silent") await db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: agentId, createdByRunId: run.id,
      body: read && !["atomic", "aborted"].includes(mode) ? "The answer is $90." : "Still working; I have not read the answer." });
    await db.update(issues).set({ status: done ? "done" : "in_progress", completedAt: done ? new Date() : null,
      executionRunId: run.id, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    const releaseQueue = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: async () => "person",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }), resolveSessionBeforeForWakeup: async () => null }),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } as never,
    });
    const result = await releaseQueue({ companyId, runId: run.id, now: new Date() });
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).filter(row => row.contextSnapshot?.issueId === issue.id);
    const replies = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, run.id));
    const evidence = { read, done, mode, issueId: issue.id, runId: run.id, wakeId: saved.id, wakeStatus: saved.status,
      successorRunId: saved.runId, runIds: runs.map(row => row.id), replies: replies.map(row => row.body), outcome: result.outcome.kind };
    console.info("CARDSETTLE_ROW", JSON.stringify(evidence));
    if (process.env.CARDSETTLE_EVIDENCE_FILE) appendFileSync(process.env.CARDSETTLE_EVIDENCE_FILE, `${JSON.stringify(evidence)}\n`);
    expect.soft(saved.status).toBe(settle ? "cancelled" : "queued");
    expect.soft(runs).toHaveLength(settle ? 1 : 2);
    expect.soft(result.outcome.kind).toBe(settle ? "released" : "promoted");
    expect(replies).toHaveLength(mode === "silent" ? 0 : 1);
    if (mode === "atomic") {
      expect.soft((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)))
        .filter(row => row.eventType === INTERACTION_RESPONSE_READ_EVENT)).toHaveLength(0);
      for (const [index, responseWake] of wakes.entries()) {
        const owed = await readQueuedInteractionResponse(db, companyId, issue.id, responseWake.payload);
        expect.soft(owed).not.toBeNull();
        const [queued] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, responseWake.id));
        console.info("ATOMIC_ROW", JSON.stringify({ interactionId: cards[index].id, runId: run.id, wakeId: queued.id, status: queued.status, owed: Boolean(owed) }));
        expect.soft(queued.status).toBe(index === 0 ? "queued" : "deferred_issue_execution");
      }
      expect(cards).toHaveLength(2);
    }
    if (!read) {
      await releaseQueue({ companyId, runId: run.id, now: new Date() });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).filter(row => row.contextSnapshot?.issueId === issue.id)).toHaveLength(2);
    }
  });

  async function reviewDisposition(run: typeof heartbeatRuns.$inferSelect) {
    const unused = async (): Promise<never> => { throw new Error("Unexpected lifecycle effect"); };
    const deps: HeartbeatLifecycleDependencies = {
      ...createHeartbeatRunState(db), ...createHeartbeatRunPreparation(db), issuesSvc: issueService(db),
      recovery: { escalateStrandedAssignedIssue: unused }, companySkills: { completeTestRunForIssue: unused },
      budgets: { getInvocationBlock: unused }, treeControlSvc: { getActivePauseHoldGate: unused },
      getAgentInvokability: unused, getCurrentUserRedactionOptions: async () => ({}), budgetHooks: {},
      emitTerminalAgentTaskRun: () => {},
      enqueueWakeup: async (targetAgentId, options = {}) => {
        const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: targetAgentId,
          source: options.source ?? "automation", reason: options.reason, status: "queued", payload: options.payload,
          idempotencyKey: options.idempotencyKey }).returning();
        const [successor] = await db.insert(heartbeatRuns).values({ companyId, agentId: targetAgentId,
          status: "queued", invocationSource: "automation", wakeupRequestId: wake.id,
          contextSnapshot: options.contextSnapshot }).returning();
        return successor;
      },
    };
    await createHeartbeatLifecycle(db, deps).handleIssueReviewPathDisposition(run);
  }

  it.each([
    { surface: "task", refusal: null }, { surface: "Agent Chat", refusal: null },
    { surface: "task", refusal: "pause" }, { surface: "task", refusal: "blockers" },
  ])("resumes or preserves the review lifecycle when a live run consumes its card answer: %j", async ({ surface, refusal }) => {
    const [issue] = await db.insert(issues).values({ companyId, title: "Choose a price", status: "in_review", assigneeAgentId: agentId,
      ...(surface === "Agent Chat" ? { conversationAgentId: agentId, conversationUserId: "person", conversationState: "active" } : {}) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "automation",
      startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: issue.id } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "ask_user_questions", status: "answered",
      sourceRunId: run.id, createdByAgentId: agentId, resolvedByUserId: "person", resolvedAt: new Date(),
      payload: { version: 1, questions: [{ id: "price", prompt: "Price?", selectionMode: "single", options: [{ id: "custom", label: "Price", freeText: true }] }] } as never,
      result: { version: 1, answers: [{ questionId: "price", optionIds: [], otherText: "$90" }] } as never }).returning();
    const context = { issueId: issue.id, taskId: issue.id, interactionId: card.id, interactionKind: card.kind,
      interactionStatus: card.status, mutation: "interaction", source: "issue.interaction.respond", wakeReason: "issue_commented" };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "issue_commented",
      status: "deferred_issue_execution", payload: { ...context, _paperclipWakeContext: context } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId: run.id }; next(); });
    app.use("/api", issueRoutes(db, {} as never, {})); app.use(errorHandler);
    const response = await request(app).get(`/api/issues/${issue.id}/interactions`).expect(200);
    expect(response.body.find((row: { id: string }) => row.id === card.id).result.answers[0].otherText).toBe("$90");
    await db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: agentId, createdByRunId: run.id, body: "The answer is $90." });
    const [finished] = await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id)).returning();
    await db.update(issues).set({ executionRunId: run.id, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const releaseQueue = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: async () => "person",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }), resolveSessionBeforeForWakeup: async () => null }),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } as never,
    });
    if (refusal) {
      const [parent] = await db.insert(issues).values({ companyId, title: "Pending prerequisite", status: "todo" }).returning();
      if (refusal === "pause") {
        await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, issue.id));
        await db.insert(issueTreeHolds).values({ companyId, rootIssueId: parent.id, mode: "pause" });
      } else {
        await db.insert(issueRelations).values({ companyId, issueId: parent.id, relatedIssueId: issue.id, type: "blocks" });
      }
    }
    let releaseError: string | null = null;
    let releaseOutcome: string | null = null;
    try { releaseOutcome = (await releaseQueue({ companyId, runId: run.id, now: new Date() })).outcome.kind; }
    catch (error) { releaseError = error instanceof Error ? error.message : String(error); }
    if (!releaseError) await reviewDisposition(finished);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [settled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter(row => row.payload?.issueId === issue.id && row.reason === "issue_review_path_lost");
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).filter(row => row.contextSnapshot?.issueId === issue.id);
    const replies = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    const evidence = { surface, refusal, releaseError, releaseOutcome, executionRunId: saved.executionRunId,
      issueId: issue.id, runId: run.id, cardId: card.id, wakeId: wake.id,
      issueStatus: saved.status, settledStatus: settled.status, recoveryWakeIds: wakes.map(row => row.id),
      runIds: runs.map(row => row.id), replies: replies.map(row => row.body) };
    console.info("REVIEW_CARD_ROW", JSON.stringify(evidence));
    if (process.env.CARDSETTLE_EVIDENCE_FILE) appendFileSync(process.env.CARDSETTLE_EVIDENCE_FILE, `${JSON.stringify(evidence)}\n`);
    expect.soft(releaseError).toBeNull();
    expect.soft(releaseOutcome).toBe("released");
    expect.soft(saved.executionRunId).toBeNull();
    expect.soft(saved.status).toBe(refusal ? "in_review" : "in_progress");
    expect.soft(settled.status).toBe(refusal ? "deferred_issue_execution" : "cancelled");
    expect.soft(wakes).toHaveLength(0);
    expect.soft(runs).toHaveLength(1);
    expect(replies.map(row => row.body)).toEqual(["The answer is $90."]);
  });

  it("still wakes an in-review task whose reviewer really disappeared", async () => {
    const [issue] = await db.insert(issues).values({ companyId, title: "Lost reviewer", status: "in_review", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", invocationSource: "automation",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
    await reviewDisposition(run);
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)))
      .filter(row => row.payload?.issueId === issue.id && row.reason === "issue_review_path_lost");
    expect(wakes).toHaveLength(1);
    console.info("LOST_REVIEW_ROW", JSON.stringify({ issueId: issue.id, runId: run.id, wakeId: wakes[0].id, reason: wakes[0].reason }));
  });

  function release(promotion: () => never) {
    return createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: promotion, getRoutineEnv: promotion,
        resolveSessionBeforeForWakeup: promotion } as never),
      recovery: { escalateStrandedAssignedIssue: promotion, escalateStrandedRecoveryIssueInPlace: promotion } as never,
    });
  }

  it.each([0, 20])("settles the decline continuation with no run when the earlier turn read the decline and replied after it (%s older declines)", async historical => {
    const { issue, run, wake } = await seed({ read: true, historical });
    const promotion = vi.fn((): never => { throw new Error("promotion reached the host"); });
    const result = await release(promotion)({ companyId, runId: run.id, now: new Date() });
    expect(result.outcome.kind).not.toBe("promoted");
    expect(promotion).not.toHaveBeenCalled();
    const [settled] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(settled).toMatchObject({ status: "skipped", runId: null, error: ALREADY_REPORTED_WAKE_REASON });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .filter(row => row.contextSnapshot?.issueId === issue.id && row.id !== run.id)).toEqual([]);
  });

  it.each([
    ["the earlier turn never read the decline", { read: false }],
    ["the card is not a tool action", { read: true, toolAction: false }],
    ["the card was accepted", { read: true, status: "accepted" }],
    ["the batch recorded more outcomes than it lists", { read: true, outcomeCount: 9 }],
  ] as const)("still runs the continuation when %s", async (_label, input) => {
    const { run, wake } = await seed(input);
    const promotion = vi.fn((): never => { throw new Error("promotion reached the host"); });
    await expect(release(promotion)({ companyId, runId: run.id, now: new Date() })).rejects.toThrow("promotion reached the host");
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(saved.status).not.toBe("skipped");
  });
});
