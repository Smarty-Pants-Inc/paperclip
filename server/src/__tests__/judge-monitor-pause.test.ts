import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, companies, issues, issueComments, activityLog, heartbeatRuns, agentWakeupRequests, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { companyService } from "../services/companies.js";
import { heartbeatService } from "../services/heartbeat.js";

// Independent judge: reach asynchronous lifecycle projections via real services.
// Keep reason: safety boundary between committed company/import intent and monitor clearing.
describe("independent judge: retained monitors across actual lifecycle transitions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("judge-monpause-"); db = createDb(database.connectionString); }, 90000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const due = new Date(Date.now() - 60000);
    await db.insert(authUsers).values({ id: "judge-board", name: "Judge board", email: "judge@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Judge retention", issuePrefix: companyId.slice(0,8), requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "judge-board" });
    await db.insert(companyMemberships).values({ companyId, principalId: "judge-board", principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retention agent", status: "idle", lifecycleState: "ready", adapterType: "process", adapterConfig: { command: "true" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retain committed monitor intent", status: "in_progress", assigneeAgentId: agentId, monitorNextCheckAt: due, monitorNotes: "judge retention", executionPolicy: { monitor: { nextCheckAt: due.toISOString(), notes: "judge retention" } } });
    return { companyId, agentId, issueId, due };
  }
  const row = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const agent = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const notes = (id: string) => db.select().from(issueComments).where(and(eq(issueComments.issueId,id),eq(issueComments.authorType,"system")));
  const heartbeat = () => heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });

  it("company resume retains an overdue check before the asynchronous inherited hold projection catches up", async () => {
    const f = await fixture(); const h = heartbeat();
    const work = startAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete" }, () => true);
    try {
      await companyService(db).update(f.companyId,{ status: "paused" });
      await work.sweep();
      expect(await agent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["company_paused"] });
      await h.tickIssueMonitors();
      expect((await row(f.issueId)).monitorNextCheckAt).toEqual(f.due);
      await companyService(db).update(f.companyId,{ status: "active" });
      const window = await agent(f.agentId);
      expect(window).toMatchObject({ status: "paused", lifecycleHolds: ["company_paused"] });
      const tick = await h.tickIssueMonitors();
      const during = await row(f.issueId);
      const falseNotes = await notes(f.issueId);
      await work.sweep(); await h.tickIssueMonitors();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agentId));
      const skips = await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issueId),eq(activityLog.action,"issue.monitor_skipped")));
      console.log(JSON.stringify({ probe: "company-resume-projection", window: { status: window.status, phase: window.lifecycleState, holds: window.lifecycleHolds }, tick, retained: during.monitorNextCheckAt, notes: falseNotes.map(n=>n.body), skips: skips.length, runsAfterReady: runs.length, wakesAfterReady: wakes.length }));
      expect.soft(during.monitorNextCheckAt).toEqual(f.due);
      expect.soft(falseNotes).toHaveLength(0);
      expect.soft(skips).toHaveLength(0);
      expect.soft(runs).toHaveLength(1);
      expect.soft(wakes).toHaveLength(1);
    } finally { await work.stop(); await h.drainActiveRunExecutions(); }
  });

  it("import Resume during unfinished pausing is not a manual pause and must retain the check", async () => {
    const f = await fixture(); const h = heartbeat(); let stopping = true;
    const work = startAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async a => a.lifecycleState === "pausing" && stopping ? "pending" : "complete", runPlugin: async () => "complete" }, () => true);
    try {
      await createAgentLifecycle(db).pauseAgent(f.agentId,"import");
      // No direct SQL status substitution: pause and resume are committed lifecycle commands.
      expect(await agent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: ["import"] });
      await h.tickIssueMonitors();
      expect((await row(f.issueId)).monitorNextCheckAt).toEqual(f.due);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      const window = await agent(f.agentId);
      expect(window).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleHolds: [] });
      const tick = await h.tickIssueMonitors(); const during = await row(f.issueId); const falseNotes = await notes(f.issueId);
      stopping = false; await work.sweep(); await h.tickIssueMonitors();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId));
      console.log(JSON.stringify({ probe: "import-resume-during-pausing", window: { status: window.status, phase: window.lifecycleState, holds: window.lifecycleHolds }, tick, retained: during.monitorNextCheckAt, notes: falseNotes.map(n=>n.body), runsAfterReady: runs.length }));
      expect.soft(during.monitorNextCheckAt).toEqual(f.due);
      expect.soft(falseNotes).toHaveLength(0);
      expect.soft(runs).toHaveLength(1);
    } finally { await work.stop(); await h.drainActiveRunExecutions(); }
  });

  it("control: the specifically fixed paused/resuming window retains and admits exactly once", async () => {
    const f = await fixture(); const h = heartbeat(); const peer = heartbeat();
    const work = startAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete" }, () => true);
    try {
      await createAgentLifecycle(db).pauseAgent(f.agentId,"import"); await work.sweep();
      expect(await agent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["import"] });
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      expect(await agent(f.agentId)).toMatchObject({ status: "paused", lifecycleState: "resuming", lifecycleHolds: [] });
      expect(await h.nextIssueMonitorAt()).toBeNull();
      expect(await h.tickIssueMonitors()).toEqual({ checked: 0, triggered: 0, skipped: 0 });
      expect((await row(f.issueId)).monitorNextCheckAt).toEqual(f.due);
      await work.sweep();
      await Promise.all([h.tickIssueMonitors(),peer.tickIssueMonitors()]); await h.tickIssueMonitors();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agentId));
      expect(runs).toHaveLength(1); expect(wakes).toHaveLength(1); expect(await notes(f.issueId)).toHaveLength(0);
      console.log(JSON.stringify({ probe: "resuming-control", runs: runs.length, wakes: wakes.length, notes: 0 }));
    } finally { await work.stop(); await h.drainActiveRunExecutions(); await peer.drainActiveRunExecutions(); }
  });

  it("control: no pause fires normally once under racing schedulers", async () => {
    const f = await fixture(); const h = heartbeat(); const peer = heartbeat();
    try {
      await Promise.all([h.tickIssueMonitors(),peer.tickIssueMonitors()]); await h.tickIssueMonitors();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agentId));
      console.log(JSON.stringify({ probe: "no-pause-admission-diagnostic", runs: runs.map(r=>({ status: r.status, errorCode: r.errorCode })), wakes: wakes.map(w=>({ status: w.status, reason: w.reason })), activities: (await db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog).where(eq(activityLog.entityId,f.issueId))) }));
      expect(runs).toHaveLength(1); expect(wakes).toHaveLength(1); expect(await notes(f.issueId)).toHaveLength(0);
      expect(await row(f.issueId)).toMatchObject({ monitorNextCheckAt: null, monitorAttemptCount: 1 });
      console.log(JSON.stringify({ probe: "no-pause-control", runs: runs.length, wakes: wakes.length, notes: 0 }));
    } finally { await h.drainActiveRunExecutions(); await peer.drainActiveRunExecutions(); }
  });

  it("control: an explicit manual hold on import pause clears once with one note and no resume run", async () => {
    const f = await fixture(); const h = heartbeat(); const peer = heartbeat();
    const work = startAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete" }, () => true);
    try {
      await createAgentLifecycle(db).pauseAgent(f.agentId,"import"); await work.sweep();
      await createAgentLifecycle(db).pauseAgent(f.agentId,"manual");
      expect((await agent(f.agentId)).lifecycleHolds).toEqual(["import","manual"]);
      await Promise.all([h.tickIssueMonitors(),peer.tickIssueMonitors()]); await h.tickIssueMonitors();
      expect((await row(f.issueId)).monitorNextCheckAt).toBeNull();
      const visible = await notes(f.issueId);
      const skips = await db.select().from(activityLog).where(and(eq(activityLog.entityId,f.issueId),eq(activityLog.action,"issue.monitor_skipped")));
      expect(visible).toHaveLength(1); expect(skips).toHaveLength(1);
      expect(visible[0]!.body).toBe(`The scheduled check due at ${f.due.toISOString()} was skipped because Retention agent was paused; it won't run again unless re-armed.`);
      await createAgentLifecycle(db).resumeAgent(f.agentId); await work.sweep(); await h.tickIssueMonitors();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId));
      expect(runs).toHaveLength(0); expect(await notes(f.issueId)).toHaveLength(1);
      console.log(JSON.stringify({ probe: "manual-plus-import-control", runs: runs.length, notes: visible.length, skips: skips.length }));
    } finally { await work.stop(); await h.drainActiveRunExecutions(); await peer.drainActiveRunExecutions(); }
  });
});
