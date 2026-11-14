import { randomUUID } from "node:crypto";
import {
  activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
  plugins, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createHeartbeatQueue } from "../heartbeat/queue.js";
import { createHeartbeatRunControl } from "../heartbeat/run-control.js";
import { callbacks as runControlCallbacks } from "../heartbeat/__tests__/run-control-fixtures.js";
import { pluginLifecycleManager } from "../plugin-lifecycle.js";
import { runGuardianBoundaryJob } from "../../__tests__/helpers/plugin-real-loader.js";

// RFL's F1-b acceptance block below is byte-for-byte except for its one marked
// harness insertion. Shared seed/receipt helpers are copied from that judge;
// unrelated judge cases are not rerun here. Relative imports follow relocation.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error(`Boundary checks require PostgreSQL: ${support.reason}`);
describe("R4-a FIX3 independent boundaries — guardian F1-b", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("r4a3-boundary-independent");
    db = createDb(database.connectionString, { maxConnections: 6 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });
  async function seed() {
    const userId = `judge-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Judge fixture", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Independent boundary check", issuePrefix: "JDG", defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue owner", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Parked task", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "succeeded", runtimeMode: "native", nativeIssueId: issue.id,
      invocationSource: "assignment", startedAt: new Date(100), finishedAt: new Date(200), contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: company.id, issueId: issue.id, phase: "committed" });
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent); deps.canStartNewExternalBotWork.mockResolvedValue(false);
    const makeRelease = (fail = false) => createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => { if (fail) throw new Error("judge rollback injection"); return { routineId: null, env: null, responsibleUserId: null }; },
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    const controls = runControlCallbacks(db);
    vi.mocked(controls.wakeQueue.releaseIssueExecution).mockImplementation(makeRelease());
    deps.releaseIssueExecutionAndPromote.mockImplementation(createHeartbeatRunControl(db, controls).releaseIssueExecutionAndPromote);
    return { company, agent, issue, source, deps, makeRelease, queue: createHeartbeatQueue(db, deps),
      input: { companyId: company.id, runId: source.id, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true } };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  async function plugin(status: typeof plugins.$inferInsert.status = "ready") {
    const id = randomUUID(), pluginKey = `judge.plugin.${id}`;
    return (await db.insert(plugins).values({ id, pluginKey, packageName: pluginKey, version: "1.0.0", status,
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Judge fixture", description: "Fixture", author: "Judge", categories: ["automation"], capabilities: ["issues.wakeup"], entrypoints: { worker: "./worker.js" } } }).returning())[0];
  }
  type Plugin = Awaited<ReturnType<typeof plugin>>;
  function payload(f: Seed, p: Plugin) {
    return { issueId: f.issue.id, mutation: "plugin_wakeup", pluginId: p.id, pluginKey: p.pluginKey,
      _paperclipWakeContext: { issueId: f.issue.id, taskId: f.issue.id, wakeReason: "plugin_issue_wakeup_requested", pluginId: p.id, pluginKey: p.pluginKey } };
  }
  async function receipt(f: Seed, p: Plugin, extra: Partial<typeof agentWakeupRequests.$inferInsert> = {}) {
    return (await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "assignment", triggerDetail: "system",
      status: "deferred_issue_execution", requestedByActorType: "system", requestedByActorId: p.id, payload: payload(f, p), ...extra }).returning())[0];
  }
  async function readReceipt(id: string) { return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]; }
  async function queued(f: Seed) { return db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agent.id), eq(heartbeatRuns.status, "queued"))); }

  it("acceptance F1-b: an old upgrade-held wake must acquire an actionable persisted hold/notice rather than remain silently deferred", async () => {
    const f = await seed(), p = await plugin();
    const r = await receipt(f, p, { requestedAt: new Date("2000-01-01"), updatedAt: new Date("2000-01-01") });
    await pluginLifecycleManager(db).markUpgradePending(p.id);
    await f.queue.resumeQueuedRuns(); await f.queue.resumeQueuedRuns(); await f.queue.resumeQueuedRuns();
    // GUARDIAN HARNESS LINE (RFL 00:52Z)
    await runGuardianBoundaryJob(db, f.company.id);
    const after = await readReceipt(r.id);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
    const activities = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.company.id), eq(activityLog.entityId, f.issue.id)));
    const issueAfter = (await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0];
    console.log("BOUNDARY indefinitely-held", JSON.stringify({ receipt: after, comments, activities, issueExecutionState: issueAfter.executionState, queued: (await queued(f)).length }));
    expect(after.status).toBe("deferred_issue_execution");
    expect(await queued(f)).toHaveLength(0);
    const visibleHold = Boolean(after.error || after.payload?.executionWait || issueAfter.executionState || comments.length || activities.length);
    expect(visibleHold, "no receipt error/hold, task execution state, task notice, task activity, deadline or successor after repeated sweeps").toBe(true);
  });
});
