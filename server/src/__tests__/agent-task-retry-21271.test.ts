import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, principalPermissionGrants, chatEndpoints, chatConversations, toolConnections, toolApplications } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { readTaskRetryIntent, taskRetryMutationAllowed } from "../services/task-retry.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// #21271 rows R1-R5: a real agent key against the real POST /api/issues/:id/retry
// and the one durable requestTaskRetry; only provider work is absent.
describe("agent task Retry (#21271)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-task-retry-21271-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (db) {
      await heartbeatService(db).drainActiveRunExecutions();
      await db.$client.end();
    }
    await database?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID(), userId = randomUUID();
    const ids = { manager: randomUUID(), report: randomUUID(), unrelated: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Retry org", issuePrefix: `R${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    for (const name of ["manager", "report", "unrelated"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, reportsTo: name === "report" ? ids.manager : null,
        adapterType: "process", status: "idle", runtimeConfig: { heartbeat: { enabled: false } } });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...Object.values(ids).map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    // The manager holds the same scoped configure grant its lifecycle authority
    // needs; its key's responsible user holds configure too.
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: ids.manager, permissionKey: "agents:configure",
        scope: { subtreeRootAgentId: ids.manager } },
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" },
    ]);
    const tokens: Record<string, string> = {};
    for (const [name, agentId] of Object.entries(ids)) {
      tokens[name] = randomUUID();
      await db.insert(agentApiKeys).values({ companyId, agentId, name, responsibleUserId: userId,
        keyHash: createHash("sha256").update(tokens[name]!).digest("hex") });
    }
    const api = express();
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", issueRoutes(db, {} as any));
    api.use(errorHandler);
    const board = express();
    board.use(express.json());
    board.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId,
      companyIds: [companyId], isInstanceAdmin: true }; next(); });
    board.use("/api", issueRoutes(db, {} as any));
    board.use(errorHandler);
    let counter = 0;
    async function stoppedTask(assigneeAgentId: string, extra: Partial<typeof issues.$inferInsert> = {}) {
      const issueId = randomUUID(), runId = randomUUID();
      counter += 1;
      await db.insert(issues).values({ id: issueId, companyId, title: `Stopped task ${counter}`, status: "blocked",
        assigneeAgentId, responsibleUserId: userId, createdByUserId: userId, issueNumber: counter, identifier: `R-${counter}-${issueId.slice(0, 4)}`, ...extra });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: assigneeAgentId, issueId, status: "failed",
        invocationSource: "assignment", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(Date.now() - 30_000),
        error: "automatic recovery gave up", errorCode: "adapter_failed", contextSnapshot: { issueId } });
      return { issueId, runId };
    }
    const retryAs = (name: keyof typeof ids, task: { issueId: string; runId: string }) =>
      request(api).post(`/api/issues/${task.issueId}/retry`).set("Authorization", `Bearer ${tokens[name]}`)
        .send({ idempotencyKey: randomUUID(), observedRunId: task.runId });
    const intents = async (issueId: string) => (await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId && wake.reason === "task_retry");
    return { companyId, userId, ids, api, board, stoppedTask, retryAs, intents };
  }

  it("R1: an agent key retries its own assigned stopped non-chat task: 202 and an intent with source agent", async () => {
    const f = await seed();
    const task = await f.stoppedTask(f.ids.manager);
    const response = await f.retryAs("manager", task);
    expect(response.status, response.text).toBe(202);
    expect(response.body).toMatchObject({ accepted: true, observedRunId: task.runId });
    const [wake] = (await f.intents(task.issueId)).filter(row => row.id === response.body.requestId);
    expect(wake).toMatchObject({ requestedByActorType: "agent", requestedByActorId: f.ids.manager, agentId: f.ids.manager });
    expect(readTaskRetryIntent(wake!.payload)).toMatchObject({ actorSource: "agent", actorId: f.ids.manager,
      onBehalfOfUserId: f.userId, sourceRunId: task.runId });
    // Dispatch re-checks the same agent authority from the durable intent.
    expect(await taskRetryMutationAllowed(db, { companyId: f.companyId, issueId: task.issueId,
      actorId: f.ids.manager, actorSource: "agent", onBehalfOfUserId: f.userId })).toBe(true);
    // Dispatch admits it under the agent's own authority and starts the next run.
    await heartbeatService(db).resumeTaskRetry(f.companyId, wake!.id);
    const [dispatched] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
    expect(dispatched).toMatchObject({ status: "coalesced", runId: expect.any(String) });
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, dispatched!.runId!));
    expect(next!.contextSnapshot).toMatchObject({ taskRetryRequestId: wake!.id, previousRunId: task.runId,
      triggeredBy: "agent", actorId: f.ids.manager });
    expect(next!.contextSnapshot?.responsibleUserId).toBe(f.userId);
    expect(next!.responsibleUserId).toBe(f.userId);
  }, 60_000);

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21271 (RFL J04)
  it("J04: the authenticated principal demoted after Retry cannot dispatch: zero new runs", async () => {
    const f = await seed();
    const task = await f.stoppedTask(f.ids.manager);
    const response = await f.retryAs("manager", task);
    expect(response.status, response.text).toBe(202);
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
      eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.userId)));
    await heartbeatService(db).resumeTaskRetry(f.companyId, response.body.requestId);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, task.issueId));
    expect(runs.map(run => run.id), "dispatch must refuse after principal demotion").toEqual([task.runId]);
    const [wake] = await f.intents(task.issueId);
    expect(readTaskRetryIntent(wake!.payload)).toMatchObject({ onBehalfOfUserId: f.userId });
    expect(wake!.payload?.executionWait).toMatchObject({ reason: "retry_authority_denied",
      message: "The agent that requested Retry can no longer change this task." });
  }, 60_000);

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21271 (RFL J07)
  it("J07: a connected Slack chat with policy agent refuses agent Retry: 403, zero new runs", async () => {
    const f = await seed();
    const task = await f.stoppedTask(f.ids.manager);
    const connectionId = randomUUID(), endpointId = randomUUID(), applicationId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: f.companyId, name: "Slack", type: "native" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: f.companyId, applicationId,
      name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId: f.companyId, connectionId,
      provider: "slack", publicId: randomUUID(), assignedAgentId: f.ids.manager, externalExecutionPolicy: "agent" });
    await db.insert(chatConversations).values({ companyId: f.companyId, endpointId, issueId: task.issueId,
      externalConversationId: randomUUID(), externalLabel: "Slack chat" });
    const response = await f.retryAs("manager", task);
    expect(response.status, response.text).toBe(403);
    expect(await f.intents(task.issueId)).toEqual([]);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, task.issueId));
    expect(runs.map(run => run.id)).toEqual([task.runId]);
    expect(await taskRetryMutationAllowed(db, { companyId: f.companyId, issueId: task.issueId,
      actorId: f.ids.manager, actorSource: "agent", onBehalfOfUserId: f.userId })).toBe(false);
  }, 60_000);

  it("R2: a managing agent retries its subordinate's stopped task: 202", async () => {
    const f = await seed();
    const task = await f.stoppedTask(f.ids.report);
    const response = await f.retryAs("manager", task);
    expect(response.status, response.text).toBe(202);
    const [wake] = (await f.intents(task.issueId)).filter(row => row.id === response.body.requestId);
    expect(readTaskRetryIntent(wake!.payload)).toMatchObject({ actorSource: "agent", actorId: f.ids.manager });
    expect(await taskRetryMutationAllowed(db, { companyId: f.companyId, issueId: task.issueId,
      actorId: f.ids.manager, actorSource: "agent", onBehalfOfUserId: f.userId })).toBe(true);
  }, 60_000);

  it("R3: an unrelated agent's task: 403, nothing recorded, and dispatch would refuse it too", async () => {
    const f = await seed();
    const unrelatedTask = await f.stoppedTask(f.ids.unrelated);
    const managerTask = await f.stoppedTask(f.ids.manager);
    for (const [name, task] of [["manager", unrelatedTask], ["report", managerTask], ["report", unrelatedTask]] as const) {
      const response = await f.retryAs(name, task);
      expect(response.status, `${name}: ${response.text}`).toBe(403);
      expect(await f.intents(task.issueId)).toEqual([]);
    }
    expect(await taskRetryMutationAllowed(db, { companyId: f.companyId, issueId: unrelatedTask.issueId,
      actorId: f.ids.manager, actorSource: "agent", onBehalfOfUserId: f.userId })).toBe(false);
    expect(await taskRetryMutationAllowed(db, { companyId: f.companyId, issueId: managerTask.issueId,
      actorId: f.ids.report, actorSource: "agent", onBehalfOfUserId: f.userId })).toBe(false);
  }, 60_000);

  it("R4: a chat issue stays board-only (owner user): 403 for its own agent", async () => {
    const f = await seed();
    const task = await f.stoppedTask(f.ids.manager, { conversationAgentId: f.ids.manager, conversationUserId: f.userId,
      conversationState: "waiting" });
    const response = await f.retryAs("manager", task);
    expect(response.status, response.text).toBe(403);
    expect(await f.intents(task.issueId)).toEqual([]);
    expect(await taskRetryMutationAllowed(db, { companyId: f.companyId, issueId: task.issueId,
      actorId: f.ids.manager, actorSource: "agent", onBehalfOfUserId: f.userId })).toBe(false);
  }, 60_000);

  it("R5: a paused assignee's task gets the same refusal for the agent as for the board", async () => {
    const f = await seed();
    const outcomes: unknown[] = [];
    for (const who of ["board", "agent"] as const) {
      const task = await f.stoppedTask(f.ids.report);
      await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.ids.report));
      const body = { idempotencyKey: randomUUID(), observedRunId: task.runId };
      const response = who === "board"
        ? await request(f.board).post(`/api/issues/${task.issueId}/retry`).send(body)
        : await f.retryAs("manager", task);
      expect(response.status, `${who}: ${response.text}`).toBeLessThan(300);
      await heartbeatService(db).resumeTaskRetry(f.companyId, response.body.requestId).catch(error => error);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, response.body.requestId));
      const started = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.issueId, task.issueId)));
      outcomes.push({ status: response.status, accepted: response.body.accepted, wakeStatus: wake?.status,
        wait: (wake?.payload?.executionWait as Record<string, unknown> | undefined)?.reason ?? null,
        runs: started.length });
    }
    // Board: accepted, held by the paused gate, no new run. The agent gets exactly that.
    expect(outcomes[0]).toEqual({ status: 202, accepted: true, wakeStatus: "deferred_issue_execution",
      wait: "agent.not_invokable", runs: 1 });
    expect(outcomes[1]).toEqual(outcomes[0]);
  }, 60_000);
});
