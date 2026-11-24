import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../../middleware/index.js";
import { issueRoutes } from "../../../routes/issues.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { hasConsumedInteractionResponse, hasQueuedInteractionResponse, INTERACTION_RESPONSE_READ_EVENT, readQueuedInteractionResponse } from "../../../services/queued-interaction-response.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import { ALREADY_REPORTED_WAKE_REASON, createPostgresWakeQueueAdapter } from "./postgres.js";
import { recordDeclinedInteractionRead } from "../../../services/chat-interaction-outcome-report.js";

const support = await getEmbeddedPostgresTestSupport();

// Chat eval questions-and-approvals.decline-tool: the person said "Do not use that app" and
// declined the tool review a second later. The turn woken by the message read the action
// declined and said so. The decline continuation, saved behind that turn, then posted the
// same declined outcome again.
describe.skipIf(!support.supported)("release of resolved interaction continuations", () => {
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

  // Regression row: R began before the answer, read it with its tools, replied,
  // and closed the task. Neither source-comment bindings nor the answer branch
  // may reopen it for a duplicate response. Unread answers must still run.
  it.each([true, false])("does not reopen a consumed card answer (source comment: %s)", async bound => {
    const f = await seedAnsweredTask({ read: true, bound });
    expect.soft(await readQueuedInteractionResponse(db, companyId, f.issue.id, f.wake.payload)).toBeNull();
    expect.soft(await hasQueuedInteractionResponse(db, companyId, f.issue.id, agentId)).toBe(false);
    const result = await releaseAnswer(f.run.id);
    expect.soft(result.outcome.kind).toBe("released");
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .filter(row => row.contextSnapshot?.issueId === f.issue.id);
    const replies = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.run.id));
    expect.soft(task.status).toBe("done");
    expect.soft(wake).toMatchObject({ status: "cancelled", runId: null });
    expect.soft(runs).toHaveLength(1);
    expect(replies.map(row => row.body)).toEqual(["WAITED. The answer is $90."]);
    console.info("BCARD_ROW", JSON.stringify({ read: true, sourceCommentBound: bound, issueId: f.issue.id,
      finishingRunId: f.run.id, wakeId: wake.id, wakeStatus: wake.status, taskStatus: task.status,
      runIds: runs.map(row => row.id), reply: replies[0].body }));
  });

  it.each([true, false])("still delivers an unread answer (source comment: %s)", async bound => {
    const f = await seedAnsweredTask({ read: false, bound });
    expect(await readQueuedInteractionResponse(db, companyId, f.issue.id, f.wake.payload)).not.toBeNull();
    const result = await releaseAnswer(f.run.id);
    expect(result.outcome.kind).toBe("promoted");
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(task.status).toBe(bound ? "todo" : "in_progress");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(wake.status).toBe("queued");
    expect(wake.runId).not.toBeNull();
    console.info("BCARD_ROW", JSON.stringify({ read: false, sourceCommentBound: bound, issueId: f.issue.id,
      finishingRunId: f.run.id, wakeId: wake.id, wakeStatus: wake.status, taskStatus: task.status, successorRunId: wake.runId }));
  });

  it.each(["pending_read", "new_result", "new_resolution", "failed", "cancelled", "other_task", "other_closer", "read_after_done"] as const)(
    "cannot retire a response when %s", async scenario => {
      const f = await seedAnsweredTask({ read: scenario === "pending_read" ? "pending" : true, bound: true });
      if (scenario === "new_result") await db.update(issueThreadInteractions).set({ result: {
        version: 1, answers: [{ questionId: "price", optionIds: [], otherText: "$91" }],
      } as never }).where(eq(issueThreadInteractions.id, f.card.id));
      if (scenario === "new_resolution") await db.update(issueThreadInteractions).set({ resolvedAt: new Date() })
        .where(eq(issueThreadInteractions.id, f.card.id));
      if (scenario === "failed" || scenario === "cancelled") await db.update(heartbeatRuns).set({ status: scenario })
        .where(eq(heartbeatRuns.id, f.run.id));
      if (scenario === "other_task") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } })
        .where(eq(heartbeatRuns.id, f.run.id));
      if (scenario === "other_closer") {
        const [closer] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "succeeded" }).returning();
        await db.update(activityLog).set({ runId: closer.id }).where(eq(activityLog.runId, f.run.id));
      }
      if (scenario === "read_after_done") await db.update(heartbeatRunEvents).set({ createdAt: new Date(Date.now() + 1000) })
        .where(eq(heartbeatRunEvents.runId, f.run.id));
      expect(await hasConsumedInteractionResponse(db, { companyId, issueId: f.issue.id, runId: f.run.id, agentId, payload: f.wake.payload })).toBe(false);
      expect(await readQueuedInteractionResponse(db, companyId, f.issue.id, f.wake.payload)).not.toBeNull();
      const result = await releaseAnswer(f.run.id);
      if (["failed", "cancelled", "other_task"].includes(scenario)) {
        // Existing ownership/recovery gates can hold these wakes; they must
        // remain owed, not be mistaken for consumption by a successful closer.
        const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
        expect(saved.status).toBe("deferred_issue_execution");
      } else {
        expect(result.outcome.kind).toBe("promoted");
      }
    });

  it.each(["assignee", "company", "run"] as const)("does not borrow another %s's consumption", async scope => {
    const f = await seedAnsweredTask({ read: true, bound: true });
    if (scope === "assignee") {
      const [other] = await db.insert(agents).values({ companyId, name: "Other", adapterType: "process" }).returning();
      await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, f.issue.id));
    }
    expect(await hasConsumedInteractionResponse(db, { companyId: scope === "company" ? randomUUID() : companyId,
      issueId: f.issue.id, runId: scope === "run" ? randomUUID() : f.run.id, agentId, payload: f.wake.payload })).toBe(false);
  });

  it("settles only the answer and still delivers a separate new human follow-up", async () => {
    const f = await seedAnsweredTask({ read: true, bound: true });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issue.id, authorType: "user", authorUserId: "person",
      body: "New work: also estimate next month's bill" }).returning();
    const context = { issueId: f.issue.id, wakeCommentId: comment.id, wakeCommentIds: [comment.id], wakeReason: "issue_commented" };
    const [followup] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "person",
      payload: { ...context, _paperclipWakeContext: context } }).returning();
    expect((await releaseAnswer(f.run.id)).outcome.kind).toBe("promoted");
    const [answerWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    const [newWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, followup.id));
    expect(answerWake).toMatchObject({ status: "cancelled", runId: null });
    expect(newWake.status).toBe("queued");
    expect(newWake.runId).not.toBeNull();
  });

  it("preserves new input coalesced with a consumed response", async () => {
    const f = await seedAnsweredTask({ read: true, bound: true });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issue.id, authorType: "user", authorUserId: "person",
      body: "And a new independent question" }).returning();
    const payload = f.wake.payload as Record<string, unknown>;
    const context = payload._paperclipWakeContext as Record<string, unknown>;
    await db.update(agentWakeupRequests).set({ payload: { ...payload, wakeCommentIds: [payload.sourceCommentId, comment.id],
      _paperclipWakeContext: { ...context, wakeCommentIds: [payload.sourceCommentId, comment.id] } } })
      .where(eq(agentWakeupRequests.id, f.wake.id));
    expect((await releaseAnswer(f.run.id)).outcome.kind).toBe("promoted");
  });

  it("recognizes a successful run's native status-decision completion", async () => {
    const f = await seedAnsweredTask({ read: true, bound: true });
    await db.update(activityLog).set({ actorType: "system", actorId: "native-status-committer", agentId: null,
      details: { source: "native_status_decision", fromStatus: "in_progress", toStatus: "done" } }).where(eq(activityLog.runId, f.run.id));
    expect((await releaseAnswer(f.run.id)).outcome.kind).toBe("released");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(wake).toMatchObject({ status: "cancelled", runId: null });
  });

  async function seedAnsweredTask(input: { read: boolean | "pending"; bound: boolean }) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Wait then use the card answer", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", invocationSource: "automation",
      responsibleUserId: "person", startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: issue.id } }).returning();
    const [source] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorType: "user", authorUserId: "person",
      body: "WAIT, then answer using the card" }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "ask_user_questions", status: input.read === "pending" ? "pending" : "answered",
      createdByAgentId: agentId, resolvedByUserId: input.read === "pending" ? null : "person", resolvedAt: input.read === "pending" ? null : new Date(),
      payload: { version: 1, questions: [{ id: "price", prompt: "Price?", selectionMode: "single", options: [{ id: "custom", label: "Price", freeText: true }] }] } as never,
      result: input.read === "pending" ? null : { version: 1, answers: [{ questionId: "price", optionIds: [], otherText: "$90" }] } as never }).returning();
    const queueAnswer = async () => {
      const context = { issueId: issue.id, taskId: issue.id, interactionId: card.id, interactionKind: card.kind,
        interactionStatus: card.status, mutation: "interaction", sourceCommentId: input.bound ? source.id : null,
        ...(input.bound ? { wakeCommentId: source.id, wakeCommentIds: [source.id] } : {}), source: "issue.interaction.respond",
        wakeReason: "issue_commented" };
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
        reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "person",
        payload: { ...context, _paperclipWakeContext: context } }).returning();
      return wake;
    };
    // The answer wake is already waiting while R is live and before its read.
    let wake = input.read === "pending" ? null : await queueAnswer();
    if (input.read) {
      // The actual agent tool/API read, through authorization + routes + DB.
      // The answer was not present in this run's initial context.
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId: run.id };
        next();
      });
      app.use("/api", issueRoutes(db, {} as never, {}));
      app.use(errorHandler);
      const response = await request(app).get(`/api/issues/${issue.id}/interactions`).expect(200);
      expect(response.body.find((row: { id: string }) => row.id === card.id).status).toBe(input.read === "pending" ? "pending" : "answered");
      await request(app).get(`/api/issues/${issue.id}/interactions`).expect(200);
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect.soft(events.filter(event => event.eventType === INTERACTION_RESPONSE_READ_EVENT)).toHaveLength(input.read === "pending" ? 0 : 1);
    }
    if (input.read === "pending") {
      await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date(), resolvedByUserId: "person",
        result: { version: 1, answers: [{ questionId: "price", optionIds: [], otherText: "$90" }] } as never })
        .where(eq(issueThreadInteractions.id, card.id));
      card.status = "answered";
      wake = await queueAnswer();
    }
    await db.insert(issueComments).values({ companyId, issueId: issue.id, authorAgentId: agentId, createdByRunId: run.id,
      body: "WAITED. The answer is $90." });
    const completedAt = new Date();
    await db.update(issues).set({ status: "done", completedAt, executionRunId: run.id, executionLockedAt: new Date() })
      .where(eq(issues.id, issue.id));
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, agentId, runId: run.id,
      action: "issue.updated", entityType: "issue", entityId: issue.id, details: { status: "done", _previous: { status: "in_progress" } } });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    return { issue, run, wake: wake!, card };
  }

  function releaseAnswer(runId: string) {
    return createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: async () => "person",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }), resolveSessionBeforeForWakeup: async () => null }),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } as never,
    })({ companyId, runId, now: new Date() });
  }

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
