import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";
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
    // RFL ruling 20:43Z: the bundle message is imported history (never noticed). The note is driven by a LIVE
    // person message posted after the import: the import arrived 8 min ago, the live message 5 min ago.
    const [importedMessage] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issue.id),
      eq(issueComments.authorType, "user")));
    await db.execute(sql`update activity_log set created_at = now() - interval '8 minutes'
      where action = 'issue.imported' and entity_type = 'issue' and entity_id = ${f.issue.id}`);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issue.id, authorType: "user", authorUserId: "m12-board",
      body: "A live follow-up after the import.", createdAt: new Date(Date.now() - 5 * 60_000) });
    await createAgentLifecycle(db).pauseAgent(f.agentId, "manual");
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
    // The live message is written directly: no wake of it is saved for a pause
    // Resume drains, so the note promises no run (rf-2 on 50b1e878).
    expect((await notes(f.issue.id)).map(n => n.body)).toEqual([
      "Import Coder is paused. Your message is saved. Send it again after Import Coder is resumed. "
      + "A board user or Import Coder's manager can resume Import Coder.",
    ]);
    expect((await notes(f.issue.id)).filter(n => (n.metadata as Record<string, unknown> | null)?.authorizationReason
      === `unanswered_message:${importedMessage!.id}`), "the imported bundle message gets no paused note (imported history)").toHaveLength(0);
  });

  it.each(["import", "manual"] as const)("a LIVE person message to an agent paused only by %s gets ONE true paused note across repeat sweeps (importpause)", async pause => {
    const f = await imported(false);
    await db.execute(sql`update activity_log set created_at = now() - interval '8 minutes'
      where action = 'issue.imported' and entity_type = 'issue' and entity_id = ${f.issue.id}`);
    if (pause === "manual") {
      // Control: the same task, its import pause resumed, then the person's own Pause.
      const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
        runPlugin: async () => "complete", runHost: async () => "complete" });
      try {
        await worker.process(f.agentId);
        await createAgentLifecycle(db).resumeAgent(f.agentId);
        await worker.process(f.agentId);
      } finally { await worker.stop(); }
      await createAgentLifecycle(db).pauseAgent(f.agentId, "manual");
    }
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "paused", pauseReason: pause, lifecycleHolds: [pause] });
    // The person's message through the real comment route (board actor), after the import.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "m12-board", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    app.use("/api", agentRoutes(db, {}));
    app.use(errorHandler);
    const posted = await request(app).post(`/api/issues/${f.issue.id}/comments`).send({ body: "Are you there? Please continue." });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
    try {
      for (let i = 0; i < 3; i++) {
        await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
        await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issue.id,
          now: new Date(Date.now() + (30 + i * 10) * 60_000) });
      }
      const swept = await notes(f.issue.id);
      console.log(JSON.stringify({ check: "importpause-live", pause, notes: swept.map(n => n.body) }));
      // adopt-cutc2 re-point (stacked on the fold2 pause line, which saves a paused
      // person's wake): the import-paused message's wake IS saved, so the ONE true
      // note says 'will run when resumed'. The manual control keeps its note.
      expect(swept.map(n => n.body)).toEqual([pause === "import"
        ? "Import Coder is paused. Your message is saved, and it will run when Import Coder is resumed. "
          + "A board user or Import Coder's manager can resume Import Coder."
        : "Import Coder is paused. Your message is saved. Send it again after Import Coder is resumed. "
          + "A board user or Import Coder's manager can resume Import Coder.",
      ]);
      expect((swept[0]!.metadata as Record<string, unknown> | null)?.authorizationReason).toBe(`unanswered_message:${posted.body.id}`);
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).toHaveLength(pause === "import" ? 1 : 0);
      if (pause === "import") {
        // The real import release: POST /agents/:id/resume, then the lifecycle worker to ready.
        const resumed = await request(app).post(`/api/agents/${f.agentId}/resume`).send({});
        expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
        const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
          runPlugin: async () => "complete", runHost: async () => "complete" });
        try {
          for (let i = 0; i < 5 && (await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.lifecycleState !== "ready"; i++)
            await worker.process(f.agentId);
        } finally { await worker.stop(); }
        for (let i = 0; i < 3; i++) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
        // Resume's release drain (resumeDeferredExecutionReceipts, pause_lifted pass) through an
        // admitting heartbeat (this file's yielding handover keeps admission closed), run twice: ONE run.
        const releaser = heartbeatService(db);
        for (let i = 0; i < 2; i++) { await releaser.resumeQueuedRuns(); await releaser.drainActiveRunExecutions(); }
        const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
        const carriesP = runs.filter(run => {
          const c = (run.contextSnapshot ?? {}) as Record<string, unknown>;
          return c.commentId === posted.body.id || c.wakeCommentId === posted.body.id
            || (Array.isArray(c.wakeCommentIds) && c.wakeCommentIds.includes(posted.body.id));
        });
        console.log(JSON.stringify({ check: "importpause-release", runs: runs.map(r => ({ id: r.id, status: r.status, ctx: r.contextSnapshot })) }));
        // P runs once after the real import release: ONE delivery run of P's released wake. This file's
        // process adapter ('true') posts no answer, so the disposition repair then retries (retryOfRunId);
        // P answered ONCE is pause-defer-wake-t4-r2 IMPORT's row (its runner answers).
        const delivered = carriesP.filter(run => !((run.contextSnapshot ?? {}) as Record<string, unknown>).retryOfRunId);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]!.contextSnapshot).toMatchObject({ wakeReason: "issue_commented" });
        expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution")))).toHaveLength(0);
      }
    } finally { await heartbeat.drainActiveRunExecutions(); }
  });

  // c3-live: the two MIXED pause orders, each with Paul's message posted LIVE
  // through the real comment route (not a DB insert, not imported history).
  // (a) import-then-manual: the import safety pause, then the person's Pause
  //     (POST /agents/:id/pause). (b) manual-then-import: the person's Pause,
  //     then the import safety pause (the same lifecycle operation the import
  //     caller uses, company-portability.ts pauseAgent(existingAgentId, "import")).
  // Each: ONE true paused note, no run while paused, real Resume -> P runs once.
  it.each(["import-then-manual", "manual-then-import"] as const)("a LIVE person message to an agent paused %s gets ONE true paused note; Resume runs it once (c3-live)", async order => {
    const f = await imported(false);
    await db.execute(sql`update activity_log set created_at = now() - interval '8 minutes'
      where action = 'issue.imported' and entity_type = 'issue' and entity_id = ${f.issue.id}`);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "m12-board", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    app.use("/api", agentRoutes(db, {}));
    app.use(errorHandler);
    const lifecycleWorker = () => configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runPlugin: async () => "complete", runHost: async () => "complete" });
    if (order === "manual-then-import") {
      // Release the first import pause so the person's Pause comes first.
      const worker = lifecycleWorker();
      try {
        await worker.process(f.agentId);
        await createAgentLifecycle(db).resumeAgent(f.agentId);
        await worker.process(f.agentId);
      } finally { await worker.stop(); }
    }
    const manual = await request(app).post(`/api/agents/${f.agentId}/pause`).send({});
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    if (order === "manual-then-import") await createAgentLifecycle(db).pauseAgent(f.agentId, "import");
    // The lifecycle worker settles the pause, as it does in the running server.
    const settle = lifecycleWorker();
    try {
      for (let i = 0; i < 5 && (await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.lifecycleState !== "paused"; i++)
        await settle.process(f.agentId);
    } finally { await settle.stop(); }
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "paused", lifecycleState: "paused" });
    expect([...agent!.lifecycleHolds].sort()).toEqual(["import", "manual"]);
    const posted = await request(app).post(`/api/issues/${f.issue.id}/comments`).send({ body: "Paul here, live: please pick the orchard count back up." });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const agentRuns = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    const heartbeat = heartbeatService(db, { runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } });
    try {
      for (let i = 0; i < 3; i++) {
        await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
        await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issue.id,
          now: new Date(Date.now() + (30 + i * 10) * 60_000) });
      }
      const swept = await notes(f.issue.id);
      const deferred = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
      const [held] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      console.log(JSON.stringify({ check: "c3-live", order, holds: held!.lifecycleHolds, pauseReason: held!.pauseReason, lifecycleState: held!.lifecycleState,
        notes: swept.map(n => n.body), deferred: deferred.length, runs: (await agentRuns()).length }));
      // ONE note, about THIS live message, and it is true: the wake is saved,
      // so it says the message will run on Resume, and who can resume.
      expect(swept).toHaveLength(1);
      expect((swept[0]!.metadata as Record<string, unknown> | null)?.authorizationReason).toBe(`unanswered_message:${posted.body.id}`);
      expect(swept[0]!.body).toBe("Import Coder is paused. Your message is saved, and it will run when Import Coder is resumed. "
        + "A board user or Import Coder's manager can resume Import Coder.");
      expect(deferred).toHaveLength(1);
      expect(await agentRuns(), "no run while paused").toHaveLength(0);
      // The person's real Resume (POST /agents/:id/resume) lifts both holds.
      const resumed = await request(app).post(`/api/agents/${f.agentId}/resume`).send({});
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
      const worker = lifecycleWorker();
      try {
        for (let i = 0; i < 5 && (await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.lifecycleState !== "ready"; i++)
          await worker.process(f.agentId);
      } finally { await worker.stop(); }
      const [ready] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(ready).toMatchObject({ status: "idle", pauseReason: null, lifecycleHolds: [] });
      for (let i = 0; i < 3; i++) await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issue.id });
      const releaser = heartbeatService(db);
      for (let i = 0; i < 2; i++) { await releaser.resumeQueuedRuns(); await releaser.drainActiveRunExecutions(); }
      const runs = await agentRuns();
      const carriesP = runs.filter(run => {
        const c = (run.contextSnapshot ?? {}) as Record<string, unknown>;
        return c.commentId === posted.body.id || c.wakeCommentId === posted.body.id
          || (Array.isArray(c.wakeCommentIds) && c.wakeCommentIds.includes(posted.body.id));
      });
      console.log(JSON.stringify({ check: "c3-live-release", order, runs: runs.map(r => ({ id: r.id, status: r.status, ctx: r.contextSnapshot })) }));
      // P runs once (the process adapter posts no answer, so a disposition retry is not a second delivery).
      const delivered = carriesP.filter(run => !((run.contextSnapshot ?? {}) as Record<string, unknown>).retryOfRunId);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.contextSnapshot).toMatchObject({ wakeReason: "issue_commented" });
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution")))).toHaveLength(0);
      expect(await notes(f.issue.id), "still ONE note after Resume").toHaveLength(1);
    } finally { await heartbeat.drainActiveRunExecutions(); }
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
