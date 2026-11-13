import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, agentApiKeys, agentRuntimeState, agentTaskSessions,
  agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issues, principalPermissionGrants, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";

// Keep reason: trust boundary. Real bearer authentication, authorization, reporting
// hierarchy, route services and persisted mutations; no mocked permission decisions.
// Execution dispatch is closed with the service's shutdown fence: accepted work
// is durably queued without launching an adapter or an unowned background job.
describe("target-scoped agent recovery and work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recovery-work-home-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("agent-recovery-work-");
    db = createDb(database.connectionString);
    closeProcessRunAdmission();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    resetProcessRunAdmissionForTests();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  const operations = ["retry", "clear-error", "reset-session", "wakeup", "invoke", "cancel"] as const;
  type Operation = typeof operations[number] | "retry-run";
  async function seed(operation: Operation, grant: "configure" | "suggest" | "unscoped" = "configure") {
    const companyId = randomUUID(), foreignCompanyId = randomUUID(), userId = randomUUID();
    const ids = { lead: randomUUID(), worker: randomUUID(), descendant: randomUUID(), outside: randomUUID(), manager: randomUUID(), foreign: randomUUID() };
    await db.insert(companies).values([
      { id: companyId, name: "Recovery boundary", issuePrefix: `R${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false },
      { id: foreignCompanyId, name: "Other company", issuePrefix: `F${foreignCompanyId.slice(0, 7)}` },
    ]);
    await db.insert(authUsers).values({ id: userId, name: "Responsible board owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    for (const name of ["manager", "lead", "worker", "descendant", "outside", "foreign"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId: name === "foreign" ? foreignCompanyId : companyId,
        name, role: "engineer", adapterType: "process", status: "idle", lifecycleState: "ready",
        reportsTo: name === "lead" || name === "outside" ? ids.manager : name === "worker" ? ids.lead : name === "descendant" ? ids.worker : null,
        permissions: { canCreateAgents: true }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...Object.entries(ids).map(([name, principalId]) => ({ companyId: name === "foreign" ? foreignCompanyId : companyId,
        principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      ...["agents:configure", "agents:create", "agents:read", "agent:wake"].map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "agents:read" },
      { companyId, principalType: "agent", principalId: ids.lead,
        permissionKey: grant === "suggest" ? "agents:suggest-changes" : "agents:configure",
        scope: grant === "unscoped" ? null : { subtreeRootAgentId: ids.lead } },
    ]);
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: ids.lead, name: "Ordinary lead key", responsibleUserId: userId,
      keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express(); api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(db)); api.use(errorHandler);
    const board = express(); board.use(express.json());
    board.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false }; next(); });
    board.use("/api", agentRoutes(db)); board.use(errorHandler);
    const runIds = new Map<string, string>();
    for (const [name, id] of Object.entries(ids)) {
      if (name === "lead") continue;
      const targetCompanyId = name === "foreign" ? foreignCompanyId : companyId;
      if (operation === "retry") {
        await db.update(agents).set({ status: "paused", lifecycleState: "verifying", lifecycleError: "Verification failed",
          lifecycleOperation: { id: randomUUID(), hostComplete: true, completedPluginIds: [], attempts: 1, retryRequired: true },
        }).where(eq(agents.id, id));
      } else if (operation === "clear-error") {
        await db.update(agents).set({ status: "error", errorReason: "Recorded run failure" }).where(eq(agents.id, id));
      } else if (operation === "reset-session") {
        await db.insert(agentRuntimeState).values({ companyId: targetCompanyId, agentId: id, adapterType: "process", sessionId: "old-session", lastError: "old-error", stateJson: { stale: true } });
        await db.insert(agentTaskSessions).values({ companyId: targetCompanyId, agentId: id, adapterType: "process", taskKey: "task", sessionDisplayId: "old-task-session" });
      } else {
        const issueId = operation === "retry-run" ? randomUUID() : null;
        if (issueId) await db.insert(issues).values({ id: issueId, companyId: targetCompanyId,
          title: "Worker task needing retry", status: "todo", assigneeAgentId: id,
          responsibleUserId: name === "foreign" ? null : userId });
        const [run] = await db.insert(heartbeatRuns).values({ companyId: targetCompanyId, agentId: id,
          status: operation === "cancel" ? "queued" : operation === "retry-run" ? "failed" : "running",
          ...(issueId ? { scopeKind: "issue" as const, issueId, contextSnapshot: { issueId } } : {}),
          ...(operation === "retry-run" ? { errorCode: "test_failure", error: "Retryable failure", finishedAt: new Date() } : {}),
        }).returning();
        runIds.set(id, run.id);

      }
    }
    function post(id: string, asBoard = false, body?: Record<string, unknown>) {
      const suffix = operation === "retry" ? "lifecycle/retry" : operation === "reset-session" ? "runtime-state/reset-session" : operation === "invoke" ? "heartbeat/invoke" : operation === "retry-run" ? "wakeup" : operation;
      const url = operation === "cancel" ? `/api/heartbeat-runs/${runIds.get(id)}/cancel` : `/api/agents/${id}/${suffix}`;
      const call = request(asBoard ? board : api).post(url);
      if (!asBoard) call.set("Authorization", `Bearer ${token}`);
      return call.send(body ?? (operation === "retry-run" ? { failedRunId: runIds.get(id), reason: "retry_failed_run" } : {}));
    }
    return { ids, companyId, userId, runIds, post };
  }

  async function snapshot(id: string) {
    const agent = await db.select().from(agents).where(eq(agents.id, id));
    return {
      agent,
      keys: await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, id)),
      issues: await db.select().from(issues).where(eq(issues.assigneeAgentId, id)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, id)),
      runtime: await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, id)),
      sessions: await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, id)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, agent[0]!.companyId)),
    };
  }

  async function assertMutation(operation: Operation, f: Awaited<ReturnType<typeof seed>>, id: string, board = false) {
    const response = await f.post(id, board);
    expect(response.status, response.text).toBe(operation === "wakeup" || operation === "invoke" || operation === "retry-run" ? 202 : 200);
    const [saved] = await db.select().from(agents).where(eq(agents.id, id));
    if (operation === "retry") {
      expect(saved).toMatchObject({ lifecycleState: "verifying", lifecycleError: null });
      expect(saved.lifecycleOperation).not.toHaveProperty("retryRequired");
    } else if (operation === "clear-error") {
      expect(saved).toMatchObject({ status: "idle", errorReason: null });
    } else if (operation === "reset-session") {
      expect((await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, id)))[0]).toMatchObject({ sessionId: null, lastError: null });
      expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, id))).toEqual([]);
    } else if (operation === "cancel") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runIds.get(id)!));
      expect(run.status).toBe("cancelled");
      expect(run.resultJson).toMatchObject(board ? { cancelledByActorType: "user", cancelledByUserId: f.userId }
        : { cancelledByActorType: "agent", cancelledByAgentId: f.ids.lead });
      if (!board) expect(run.errorCode).toBe("operator_interrupted");
    } else {
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
      expect(wakes.length).toBeGreaterThan(0);
      expect(wakes.some(wake => wake.status !== "skipped" && wake.requestedByActorType === (board ? "user" : "agent")
        && wake.requestedByActorId === (board ? f.userId : f.ids.lead))).toBe(true);
      if (operation === "retry-run") {
        expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, id), eq(heartbeatRuns.retryOfRunId, f.runIds.get(id)!))))
          .toEqual([expect.objectContaining({ status: "queued" })]);
      }
    }
    const action = ({ retry: "agent.lifecycle_retried", "clear-error": "agent.error_cleared", "reset-session": "agent.runtime_session_reset", cancel: "heartbeat.cancelled",
      wakeup: "heartbeat.invoked", invoke: "heartbeat.invoked", "retry-run": "heartbeat.invoked" })[operation];
    const entries = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, action)));
    expect(entries).toContainEqual(expect.objectContaining({ actorType: board ? "user" : "agent", actorId: board ? f.userId : f.ids.lead }));
  }

  for (const operation of operations) {
    it(`${operation}: an ordinary lead manages its direct worker with its scoped agent key`, async () => {
      const f = await seed(operation);
      await assertMutation(operation, f, f.ids.worker);
    }, 60_000);
    it(`${operation}: the same grant reaches a transitive report`, async () => {
      const f = await seed(operation);
      await assertMutation(operation, f, f.ids.descendant);
    }, 60_000);
    it(`${operation}: outside the subtree is 403 without any mutation`, async () => {
      const f = await seed(operation);
      const before = await snapshot(f.ids.outside);
      const response = await f.post(f.ids.outside);
      expect(response.status, response.text).toBe(403);
      expect(await snapshot(f.ids.outside)).toEqual(before);
    }, 60_000);
    it(`${operation}: reparenting the worker revokes the lead's authority immediately`, async () => {
      const f = await seed(operation);
      await assertMutation(operation, f, f.ids.worker);
      await db.update(agents).set({ reportsTo: f.ids.manager }).where(eq(agents.id, f.ids.worker));
      const before = await snapshot(f.ids.worker);
      const response = await f.post(f.ids.worker);
      expect(response.status, response.text).toBe(403);
      expect(await snapshot(f.ids.worker)).toEqual(before);
    }, 60_000);
    it(`${operation}: suggestion-only authority is not a direct recovery grant`, async () => {
      const f = await seed(operation, "suggest");
      const before = await snapshot(f.ids.worker);
      const response = await f.post(f.ids.worker);
      expect(response.status, response.text).toBe(403);
      expect(await snapshot(f.ids.worker)).toEqual(before);
    }, 60_000);
    it(`${operation}: company access still prevents foreign-company mutations`, async () => {
      const f = await seed(operation);
      const before = await snapshot(f.ids.foreign);
      const response = await f.post(f.ids.foreign);
      expect([403, 404], response.text).toContain(response.status);
      expect(await snapshot(f.ids.foreign)).toEqual(before);
    }, 60_000);
    it(`${operation}: board authority is unchanged outside the lead's subtree`, async () => {
      const f = await seed(operation);
      await assertMutation(operation, f, f.ids.outside, true);
    }, 60_000);
    it(`${operation}: a legacy unscoped configure grant cannot manage outside the subtree`, async () => {
      const f = await seed(operation, "unscoped");
      const before = await snapshot(f.ids.outside);
      const response = await f.post(f.ids.outside);
      expect.soft(response.status, response.text).toBe(403);
      expect.soft(await snapshot(f.ids.outside)).toEqual(before);
    }, 60_000);
    it(`${operation}: the lead cannot manage its own manager`, async () => {
      const f = await seed(operation);
      const before = await snapshot(f.ids.manager);
      const response = await f.post(f.ids.manager);
      expect(response.status, response.text).toBe(403);
      expect(await snapshot(f.ids.manager)).toEqual(before);
    }, 60_000);
  }

  for (const operation of ["wakeup", "invoke"] as const) {
    it(`${operation}: self-wake remains available without a direct configure grant`, async () => {
      const f = await seed(operation, "suggest");
      const response = await f.post(f.ids.lead);
      expect(response.status, response.text).toBe(202);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.ids.lead)))
        .toContainEqual(expect.objectContaining({ requestedByActorType: "agent", requestedByActorId: f.ids.lead, status: "queued" }));
    }, 60_000);
  }

  it("exact failed-run retry retains its separate board-only boundary", async () => {
    const f = await seed("retry-run");
    const before = await snapshot(f.ids.worker);
    const response = await f.post(f.ids.worker);
    expect(response.status, response.text).toBe(403);
    expect(await snapshot(f.ids.worker)).toEqual(before);
    await assertMutation("retry-run", f, f.ids.worker, true);
  }, 60_000);

  it("clear-error keeps the underlying error-state precondition", async () => {
    const f = await seed("clear-error");
    await db.update(agents).set({ status: "idle", errorReason: null }).where(eq(agents.id, f.ids.worker));
    const before = await snapshot(f.ids.worker);
    const response = await f.post(f.ids.worker);
    expect(response.status, response.text).toBe(409);
    expect(await snapshot(f.ids.worker)).toEqual(before);
  }, 60_000);

  it("lifecycle retry cannot revive a terminated worker", async () => {
    const f = await seed("retry");
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated", lifecycleOperation: null }).where(eq(agents.id, f.ids.worker));
    const before = await snapshot(f.ids.worker);
    const response = await f.post(f.ids.worker);
    expect(response.status, response.text).toBe(409);
    expect(await snapshot(f.ids.worker)).toEqual(before);
  }, 60_000);

  it("session reset keeps its task-key selection rather than clearing other tasks", async () => {
    const f = await seed("reset-session");
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.ids.worker, adapterType: "process", taskKey: "other", sessionDisplayId: "keep" });
    const response = await f.post(f.ids.worker, false, { taskKey: "task" });
    expect(response.status, response.text).toBe(200);
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.ids.worker)))
      .toEqual([expect.objectContaining({ taskKey: "other", sessionDisplayId: "keep" })]);
  }, 60_000);

  it("a managing agent can cancel an already-running worker run", async () => {
    const f = await seed("cancel");
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, f.runIds.get(f.ids.worker)!));
    await assertMutation("cancel", f, f.ids.worker);
  }, 60_000);

  it("configure authority does not bypass private-task run visibility", async () => {
    const f = await seed("cancel");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Private worker task",
      status: "todo", assigneeAgentId: f.ids.worker, visibility: "private", privacyRootIssueId: issueId });
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, f.runIds.get(f.ids.worker)!));
    const before = await snapshot(f.ids.worker);
    const response = await f.post(f.ids.worker);
    expect(response.status, response.text).toBe(404);
    expect(await snapshot(f.ids.worker)).toEqual(before);
  }, 60_000);

  it("a cancellation request cannot substitute an authorized agent for the saved run's target", async () => {
    const f = await seed("cancel");
    const before = await snapshot(f.ids.outside);
    const response = await f.post(f.ids.outside, false, { agentId: f.ids.worker });
    expect(response.status, response.text).toBe(403);
    expect(await snapshot(f.ids.outside)).toEqual(before);
  }, 60_000);

  it("managed wake does not grant raw provider trace capture", async () => {
    const f = await seed("wakeup");
    const before = await snapshot(f.ids.worker);
    const response = await f.post(f.ids.worker, false, { debug: { providerTrace: "raw" } });
    expect(response.status, response.text).toBe(403);
    expect(await snapshot(f.ids.worker)).toEqual(before);
  }, 60_000);
});
