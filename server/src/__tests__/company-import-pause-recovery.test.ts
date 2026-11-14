import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { companyService } from "../services/companies.js";
import { heartbeatService } from "../services/heartbeat.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

// Keep reason: regression from M12 gate S3/S4, where import's safety pause
// blocked carried-over work and posted two false failure/wait notices.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("company import safety pause recovery (M12 S3/S4)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("company-import-pause-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    await db?.$client.end();
    await database?.cleanup();
  });

  async function imported(monitored: boolean, status = "in_progress", startedAt: string | null = null) {
    const companyId = randomUUID();
    await db.insert(authUsers).values({ id: "m12-board", name: "M12 operator", email: "m12@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "M12 import", issuePrefix: companyId.slice(0, 8),
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "m12-board" });
    await db.insert(companyMemberships).values({ companyId, principalId: "m12-board", principalType: "user",
      status: "active", membershipRole: "owner" });
    const files = {
      "COMPANY.md": '---\nname: "M12 import"\n---\n',
      "agents/coder/AGENTS.md": '---\nname: "Import Coder"\nslug: coder\nrole: engineer\n---\n\nContinue the saved task.\n',
      "tasks/open/TASK.md": '---\nname: "Carried open task"\nkind: task\nassignee: coder\n---\n\nKeep the recorded history.\n',
      ".paperclip.yaml": `schemaVersion: 7\ntasks:\n  open:\n    status: ${status}\n    comments:\n      -\n        body: "Please continue the copper orchard inventory."\n        authorType: user\n`
        + (startedAt ? `    startedAt: "${startedAt}"\n` : '')
        + (monitored ? '    monitor:\n      notes: "Check the amber bridge bolts"\n      scheduledBy: agent\n      hadSchedule: true\n' : ''),
    };
    const result = await companyPortabilityService(db).importBundle({
      source: { type: "inline", rootPath: "m12", files },
      include: { company: false, agents: true, projects: false, issues: true, skills: false },
      target: { mode: "existing_company", companyId }, agents: "all", collisionStrategy: "rename",
      adapterOverrides: { coder: { adapterType: "process", adapterConfig: { command: "true" } } },
    }, "m12-board", { pauseAutomations: true });
    const agentId = result.agents.find(a => a.slug === "coder")!.id!;
    const [issue] = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(issue!.assigneeAgentId).toBe(agentId);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent).toMatchObject({ status: "paused", pauseReason: "import" });
    await db.update(issueComments).set({ createdAt: new Date(Date.now() - 10 * 60_000) })
      .where(and(eq(issueComments.issueId, issue!.id), eq(issueComments.authorType, "user")));
    return { companyId, agentId, issue: issue! };
  }
  const notes = (issueId: string) => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));

  it.each([
    { monitored: false, startedAt: null },
    { monitored: true, startedAt: null },
    { monitored: false, startedAt: "2026-03-19T00:00:00.000Z" },
    { monitored: true, startedAt: "2026-03-19T00:00:00.000Z" },
  ])("real paused import, monitored=$monitored, startedAt=$startedAt: no notes or block; resume admits work without per-task repair", async ({ monitored, startedAt }) => {
    const f = await imported(monitored, "in_progress", startedAt);
    // Keep admitted runs queued at the real run-start handover gate. This
    // proves admission without launching a provider or leaving work running.
    const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
    // Run both owners repeatedly, including beyond B's bounded waiting window.
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
    await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issue.id,
      now: new Date(Date.now() + 30 * 60_000) });
    const beforeResumeNotes = await notes(f.issue.id);
    const [beforeResume] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    console.log(JSON.stringify({ shape: monitored ? "S4" : "S3", phase: "import-paused",
      status: beforeResume!.status, notes: beforeResumeNotes.map(n => n.body), monitorNotes: beforeResume!.monitorNotes }));
    // Real lifecycle Resume + lifecycle worker, not a status-only SQL substitute.
    // Host/plugin preparation is a no-op for this process adapter; no provider.
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await worker.process(f.agentId);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
      const [resumed] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(resumed).toMatchObject({ status: "idle", pauseReason: null, lifecycleHolds: [] });
      const recovery = await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
      console.log(JSON.stringify({ recovery, agentStatus: resumed!.status, pauseReason: resumed!.pauseReason }));
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.agentId, f.agentId)));
      const [afterResume] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      console.log(JSON.stringify({ shape: monitored ? "S4" : "S3", phase: "resumed", status: afterResume!.status,
        notes: (await notes(f.issue.id)).map(n => n.body), runs: runs.map(r => ({ id: r.id, status: r.status })) }));
      expect(beforeResumeNotes).toHaveLength(0);
      expect(beforeResume!.status).toBe("in_progress");
      expect(beforeResume!.originKind).toBe("company_import");
      expect(afterResume!.startedAt).toEqual(startedAt ? new Date(startedAt) : null);
      expect(beforeResume!.monitorNotes).toBe(monitored ? "Check the amber bridge bolts" : null);
      expect(beforeResume!.monitorScheduledBy).toBe(f.issue.monitorScheduledBy);
      expect(beforeResume!.monitorNextCheckAt).toEqual(f.issue.monitorNextCheckAt);
      expect(afterResume!.status).not.toBe("blocked");
      expect(afterResume!.monitorNotes).toBe(beforeResume!.monitorNotes);
      expect(afterResume!.monitorScheduledBy).toBe(beforeResume!.monitorScheduledBy);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "queued", contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_assigned" } });
      expect(await notes(f.issue.id)).toHaveLength(0);
    } finally { await worker.stop(); await heartbeat.drainActiveRunExecutions(); }
  });

  it("an additional manual hold still posts B's true paused note even when import remains the primary pause reason", async () => {
    const f = await imported(false);
    await createAgentLifecycle(db).pauseAgent(f.agentId, "manual");
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
    expect((await notes(f.issue.id)).map(n => n.body)).toEqual([
      "Import Coder is paused. Your message is saved, and it will run when Import Coder is resumed. "
      + "A board user or Import Coder's manager can resume Import Coder.",
    ]);
  });

  it("an armed monitor survives import-pause recovery and its timer admits a run after resume", async () => {
    const f = await imported(true);
    // The portability format deliberately imports monitor metadata unarmed.
    // Also exercise an existing armed monitor while the import hold is active.
    const due = new Date(Date.now() + 60_000);
    await db.update(issues).set({ monitorNextCheckAt: due }).where(eq(issues.id, f.issue.id));
    const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
      const [paused] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(paused).toMatchObject({ status: "in_progress", monitorNextCheckAt: due,
        monitorNotes: "Check the amber bridge bolts", monitorScheduledBy: "agent" });
      expect(await notes(f.issue.id)).toHaveLength(0);
      await worker.process(f.agentId);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id, unanswered: false });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
      const tick = await heartbeat.tickIssueMonitors(new Date(due.getTime() + 1));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      console.log(JSON.stringify({ shape: "S4-armed", tick, runs: runs.map(r => ({ id: r.id, status: r.status,
        reason: r.contextSnapshot?.wakeReason })) }));
      expect(tick.triggered).toBe(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "queued", contextSnapshot: { wakeReason: "issue_monitor_due" } });
      expect(await notes(f.issue.id)).toHaveLength(0);
    } finally { await worker.stop(); await heartbeat.drainActiveRunExecutions(); }
  });

  // Keep reason: recorded monpause incident; the real due timer consumed an
  // imported agent's armed monitor while admission was closed by a pause.
  it.each([
    { status: "in_progress", hold: "import" },
    { status: "in_review", hold: "import" },
    { status: "in_progress", hold: "manual" },
    { status: "in_review", hold: "manual" },
    { status: "in_progress", hold: "company" },
    { status: "in_review", hold: "company" },
  ])("overdue monitor survives $hold pause and resumes exactly once ($status)", async ({ status, hold }) => {
    const f = await imported(true, status);
    const due = new Date(Date.now() + 60_000);
    await db.update(issues).set({ monitorNextCheckAt: due }).where(eq(issues.id, f.issue.id));
    const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await worker.process(f.agentId);
      if (hold !== "import") {
        await createAgentLifecycle(db).resumeAgent(f.agentId);
        await worker.process(f.agentId);
        if (hold === "manual") await createAgentLifecycle(db).pauseAgent(f.agentId, "manual");
        else await companyService(db).update(f.companyId, { status: "paused" });
      }
      for (let tick = 1; tick <= 2; tick++) {
        const result = await heartbeat.tickIssueMonitors(new Date(due.getTime() + tick));
        const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
        console.log(JSON.stringify({ check: "overdue-monitor-paused", status, hold, tick, result,
          schedule: waiting!.monitorNextCheckAt, attempts: waiting!.monitorAttemptCount }));
        expect(result.triggered).toBe(0);
        expect(waiting).toMatchObject({ status, monitorNextCheckAt: due, monitorWakeRequestedAt: null,
          monitorAttemptCount: 0, monitorNotes: "Check the amber bridge bolts" });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
        expect(await notes(f.issue.id)).toHaveLength(0);
      }
      // A held past-due deadline must not hot-loop the existing work scheduler.
      expect(await heartbeat.nextIssueMonitorAt()).toBeNull();
      if (hold === "company") await companyService(db).update(f.companyId, { status: "active" });
      else {
        await createAgentLifecycle(db).resumeAgent(f.agentId);
        await worker.process(f.agentId);
      }
      expect(await heartbeat.nextIssueMonitorAt()).toBe(due.getTime());
      // Competing controllers and the next tick must not duplicate admission.
      await Promise.all([heartbeat.tickIssueMonitors(new Date(due.getTime() + 3)),
        heartbeat.tickIssueMonitors(new Date(due.getTime() + 3))]);
      await heartbeat.tickIssueMonitors(new Date(due.getTime() + 4));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "queued", contextSnapshot: { wakeReason: "issue_monitor_due" } });
      const [consumed] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(consumed).toMatchObject({ monitorNextCheckAt: null, monitorWakeRequestedAt: null, monitorAttemptCount: 1 });
      expect(await notes(f.issue.id)).toHaveLength(0);
      console.log(JSON.stringify({ check: "overdue-monitor-resumed", status, hold,
        runs: runs.map(run => ({ id: run.id, status: run.status, reason: run.contextSnapshot?.wakeReason })) }));
    } finally { await worker.stop(); await heartbeat.drainActiveRunExecutions(); }
  });

  it.each([
    { sourceStatus: "in_progress", status: "in_progress" },
    { sourceStatus: "in_progress", status: "in_review" },
    { sourceStatus: "blocked", status: "in_progress" },
    { sourceStatus: "blocked", status: "in_review" },
  ])("documented PATCH re-arms an imported monitor without a recovery note while import-paused ($sourceStatus -> $status)", async ({ sourceStatus, status }) => {
    const f = await imported(true, sourceStatus);
    const due = new Date(Date.now() + 60_000);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "m12-board", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    app.use(errorHandler);
    const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      const response = await request(app).patch(`/api/issues/${f.issue.id}`).send({ status,
        executionPolicy: { monitor: { nextCheckAt: due.toISOString(), notes: "Re-armed imported monitor" } } });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status, monitorNextCheckAt: due.toISOString() });
      const [paused] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(paused).toMatchObject({ status: "paused", pauseReason: "import" });
      expect(paused!.lifecycleHolds.every(hold => hold === "import")).toBe(true);
      console.log(JSON.stringify({ check: "monitor-patch-import-paused", status, phase: "patched",
        notes: (await notes(f.issue.id)).map(note => note.body), holds: paused!.lifecycleHolds }));
      expect(await notes(f.issue.id)).toHaveLength(0);
      for (let pass = 0; pass < 2; pass++) {
        await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
        await heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId: f.issue.id });
        await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issue.id,
          now: new Date(Date.now() + 30 * 60_000) });
        await heartbeat.tickIssueMonitors(new Date());
      }
      console.log(JSON.stringify({ check: "monitor-patch-import-paused", status, phase: "swept",
        notes: (await notes(f.issue.id)).map(note => note.body) }));
      expect(await notes(f.issue.id)).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
      const [waiting] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(waiting).toMatchObject({ status, monitorNextCheckAt: due, monitorNotes: "Re-armed imported monitor" });
      await worker.process(f.agentId);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
      await heartbeat.tickIssueMonitors(new Date(due.getTime() + 1));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "queued", contextSnapshot: { wakeReason: "issue_monitor_due" } });
      expect(await notes(f.issue.id)).toHaveLength(0);
    } finally { await worker.stop(); await heartbeat.drainActiveRunExecutions(); }
  });

  it("an imported todo task also starts through normal assignment admission after resume", async () => {
    const f = await imported(false, "todo");
    const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
      expect(await notes(f.issue.id)).toHaveLength(0);
      await worker.process(f.agentId);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "queued", contextSnapshot: { wakeReason: "issue_assigned" } });
      expect(await notes(f.issue.id)).toHaveLength(0);
    } finally { await worker.stop(); await heartbeat.drainActiveRunExecutions(); }
  });
});
