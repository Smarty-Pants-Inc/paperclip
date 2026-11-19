import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { expect, it } from "vitest";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { agentRoutes } from "../routes/agents.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";

// The live shape: a person's composer Stop or tree Pause of a native run in
// startup. No coordinator state is seeded for these rows: the run carries the
// unclaimed coordinator runtime selection leaves ("observed", attempt 0), and
// the real routes write whatever they write.
describeEmbeddedPostgres("person-cancelled native startup run through the real routes", () => {
  const ctx = useEmbeddedPostgres("projection-person-cancel-route-", {
    resetEach: async (db) => { await db.execute(sql`truncate companies cascade`); },
  });

  async function startupRun() {
    const db = ctx.db;
    const seeded = await seedCompanyWithBoardAccess(db, "Person cancel route");
    const { companyId } = seeded;
    const agentId = randomUUID(), parentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Native agent", adapterType: "paperclip_runner",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent task", status: "todo" });
    await db.insert(issues).values({ id: issueId, companyId, parentId, title: "Native task", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      status: "running", runtimeMode: "native", nativeIssueId: issueId, startedAt: new Date(), contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    // What runtime selection leaves: an unclaimed coordinator, before any controller lease.
    await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "observed", attempt: 0,
      failureDetail: {}, resultId: null, leaseOwner: null });
    return { ...seeded, agentId, parentId, issueId, runId };
  }

  async function read(db: typeof ctx.db, app: ReturnType<typeof routeApp>, runId: string, label: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, run!.companyId));
    const body = (await request(app).get(`/api/heartbeat-runs/${runId}`).expect(200)).body;
    const result = (run!.resultJson ?? {}) as Record<string, unknown>;
    console.log(label, JSON.stringify({ status: run!.status, errorCode: run!.errorCode,
      cancelledByActorType: result.cancelledByActorType, startupCancellation: result.startupCancellation,
      nativeCancellation: result.nativeCancellation ?? null, resultKeys: Object.keys(result),
      coordinator: owner ? { phase: owner.phase, failureCode: owner.failureCode, failureDetail: owner.failureDetail,
        recoveryState: owner.recoveryState, nativeCancellationDecision: (owner as Record<string, unknown>).nativeCancellation ?? null } : null,
      recoveryActions: actions.map(a => ({ status: a.status, cause: a.cause })), execution: body.execution }));
    return body.execution as { phase: string; label: string; recoveryOwner: string | null; nextAction: string | null; canStop: boolean };
  }

  it("(R1) composer Stop: POST /heartbeat-runs/:id/cancel by a board user -> Stopped + Send a new message", async () => {
    const db = ctx.db;
    const { actor, runId } = await startupRun();
    const app = routeApp(db, actor, (d) => agentRoutes(d));
    const cancel = await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    console.log("R1 cancel", cancel.status, JSON.stringify(cancel.body).slice(0, 300));
    expect(cancel.status).toBe(200);
    const execution = await read(db, app, runId, "R1");
    expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null,
      nextAction: "Send a new message to continue from saved work.", canStop: false });
  });

  it("(R1b) composer Stop after its release hold settled (live: no active recovery action) -> Stopped", async () => {
    const db = ctx.db;
    const { actor, runId, companyId, issueId } = await startupRun();
    const app = routeApp(db, actor, (d) => agentRoutes(d));
    expect((await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({})).status).toBe(200);
    const settled = await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date() })
      .where(sql`${issueRecoveryActions.companyId} = ${companyId} and ${issueRecoveryActions.sourceIssueId} = ${issueId} and ${issueRecoveryActions.status} = 'active'`)
      .returning({ id: issueRecoveryActions.id });
    expect(settled).toHaveLength(1);
    const execution = await read(db, app, runId, "R1b");
    expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null,
      nextAction: "Send a new message to continue from saved work.", canStop: false });
  });

  it("(R2) tree Pause: POST /issues/:id/tree-holds {mode:'pause'} -> Stopped + Resume to continue.", async () => {
    const db = ctx.db;
    const { actor, runId, parentId } = await startupRun();
    const app = routeApp(db, actor, (d) => agentRoutes(d), (d) => issueTreeControlRoutes(d));
    const hold = await request(app).post(`/api/issues/${parentId}/tree-holds`).send({ mode: "pause", reason: "Paused by a person" });
    console.log("R2 hold", hold.status, JSON.stringify(hold.body).slice(0, 300));
    expect(hold.status).toBeLessThan(300);
    const execution = await read(db, app, runId, "R2");
    expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null,
      nextAction: "Resume to continue.", canStop: false });
  });

  it("(R3) agent Pause: POST /agents/:id/pause -> Stopped + Resume to continue.", async () => {
    const db = ctx.db;
    const { actor, runId, agentId } = await startupRun();
    const app = routeApp(db, actor, (d) => agentRoutes(d));
    const pause = await request(app).post(`/api/agents/${agentId}/pause`).send({});
    console.log("R3 pause", pause.status, JSON.stringify(pause.body).slice(0, 300));
    expect(pause.status).toBeLessThan(300);
    const execution = await read(db, app, runId, "R3");
    expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null,
      nextAction: "Resume to continue.", canStop: false });
  });

  it("(R4) control: real-route Stop whose cleanup failed (a recovery action exists) keeps Recovery needed", async () => {
    const db = ctx.db;
    const { actor, runId, companyId, issueId } = await startupRun();
    const app = routeApp(db, actor, (d) => agentRoutes(d));
    expect((await request(app).post(`/api/heartbeat-runs/${runId}/cancel`).send({})).status).toBe(200);
    // The route left one active hold for this run; cleanup failing escalates it to a quarantine.
    const updated = await db.update(issueRecoveryActions).set({ cause: "native_session_cleanup_quarantined",
      nextAction: "Verify the stopped session before starting a new attempt." })
      .where(sql`${issueRecoveryActions.companyId} = ${companyId} and ${issueRecoveryActions.sourceIssueId} = ${issueId} and ${issueRecoveryActions.status} = 'active'`)
      .returning({ id: issueRecoveryActions.id });
    expect(updated).toHaveLength(1);
    const execution = await read(db, app, runId, "R4");
    expect(execution).toMatchObject({ phase: "recovery_needed", label: "Recovery needed", recoveryOwner: "board" });
  });
});
