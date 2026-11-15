import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships,
  createDb, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle, startAgentLifecycle } from "../services/agent-lifecycle.js";
import { companyService } from "../services/companies.js";
import { heartbeatService } from "../services/heartbeat.js";

// Keep reason: F1/F2 lost durable monitor intent and wrote false user-visible
// notices across committed Resume and asynchronous company-policy projection.
describe("monitor pause disposition through the real company-policy sweep", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("monitor-pause-projection-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const due = new Date(Date.now() - 60_000), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Monitor owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Projection regression", issuePrefix: companyId.slice(0, 8), requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Projected monitor agent", status: "idle", lifecycleState: "ready", adapterType: "process", adapterConfig: { command: "true" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep the armed check", status: "in_progress", assigneeAgentId: agentId, monitorNextCheckAt: due, executionPolicy: { monitor: { nextCheckAt: due.toISOString() } } });
    return { companyId, agentId, issueId, due };
  }
  const readAgent = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const readIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const heartbeat = () => heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
  async function noFalseSkip(issueId: string) {
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.monitor_skipped")))).toHaveLength(0);
  }
  async function admittedOnce(f: Awaited<ReturnType<typeof fixture>>, h: ReturnType<typeof heartbeat>) {
    const peer = heartbeat();
    try {
      await Promise.all([h.tickIssueMonitors(), peer.tickIssueMonitors()]);
      await h.tickIssueMonitors();
      expect(await readIssue(f.issueId)).toMatchObject({ monitorNextCheckAt: null, monitorAttemptCount: 1 });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(1);
      await noFalseSkip(f.issueId);
    } finally { await peer.drainActiveRunExecutions(); }
  }

  it("F1: retains through committed company Resume before inherited company_paused is swept away", async () => {
    const f = await fixture(), h = heartbeat();
    const lifecycle = startAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" }, () => true);
    try {
      await companyService(db).update(f.companyId, { status: "paused" });
      await lifecycle.sweep();
      expect(await readAgent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["company_paused"] });
      expect(await h.nextIssueMonitorAt()).toBeNull();
      expect(await h.tickIssueMonitors()).toEqual({ checked: 0, triggered: 0, skipped: 0 });
      await companyService(db).update(f.companyId, { status: "active" });
      // No agent Resume or projection sweep is allowed before this tick.
      expect(await readAgent(f.agentId)).toMatchObject({ status: "paused", lifecycleHolds: ["company_paused"] });
      await h.tickIssueMonitors();
      expect((await readIssue(f.issueId)).monitorNextCheckAt).toEqual(f.due);
      expect(await h.nextIssueMonitorAt()).toBeNull();
      await noFalseSkip(f.issueId);
      await lifecycle.sweep();
      expect(await readAgent(f.agentId)).toMatchObject({ status: "idle", lifecycleState: "ready", lifecycleHolds: [] });
      await admittedOnce(f, h);
    } finally { await lifecycle.stop(); await h.drainActiveRunExecutions(); }
  });

  it("F2: retains an import Resume during unfinished Stop after real company pause/resume projection", async () => {
    const f = await fixture(), h = heartbeat();
    let stopping = true;
    const lifecycle = startAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async agent => agent.lifecycleState === "pausing" && stopping ? "pending" : "complete" }, () => true);
    try {
      await createAgentLifecycle(db).pauseAgent(f.agentId, "import");
      await companyService(db).update(f.companyId, { status: "paused" });
      await lifecycle.sweep();
      expect(await readAgent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: ["import", "company_paused"] });
      await companyService(db).update(f.companyId, { status: "active" });
      await lifecycle.sweep();
      expect(await readAgent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: ["import"] });
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      // Tick after committed import Resume but before its next lifecycle sweep.
      expect(await readAgent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: [] });
      await h.tickIssueMonitors();
      expect((await readIssue(f.issueId)).monitorNextCheckAt).toEqual(f.due);
      expect(await h.nextIssueMonitorAt()).toBeNull();
      await noFalseSkip(f.issueId);
      stopping = false;
      // The incomplete Stop may have a retry deadline. Explicit Retry, only
      // after proving the Resume window, finishes it without a timing sleep.
      await createAgentLifecycle(db).retry(f.agentId);
      await lifecycle.sweep();
      expect(await readAgent(f.agentId)).toMatchObject({ status: "idle", lifecycleState: "ready", lifecycleHolds: [] });
      await admittedOnce(f, h);
    } finally { await lifecycle.stop(); await h.drainActiveRunExecutions(); }
  });
});
