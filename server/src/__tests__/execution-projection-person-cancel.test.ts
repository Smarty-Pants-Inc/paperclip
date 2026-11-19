import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueRecoveryActions, issues, issueTreeHolds, nativeRunFinalizations } from "@paperclipai/db";
import { expect, it } from "vitest";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { agentRoutes } from "../routes/agents.js";

// A person's Stop, task-tree Pause and agent Pause all settle a native run as
// cancelled with a terminal_failure / native_retry_cancelled coordinator. The
// run's execution projection, read through the real GET route, must show the
// ordinary stopped state, not the board's "Recovery needed".
describeEmbeddedPostgres("person-cancelled native run execution projection", () => {
  const ctx = useEmbeddedPostgres("projection-person-cancel-", {
    resetEach: async (db) => { await db.execute(sql`truncate companies cascade`); },
  });

  async function settledRun(opts: {
    status: "cancelled" | "failed";
    failureCode: string;
    scope?: "turn" | "run" | "issue";
    recoveryAction?: boolean;
    treePause?: "active" | "released";
    agentLifecycle?: "ready" | "paused" | "pausing";
  }) {
    const db = ctx.db;
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(db, "Person cancel projection");
    const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const at = new Date(Date.now() - 60 * 60_000);
    const lifecycleState = opts.agentLifecycle ?? "ready";
    await db.insert(agents).values({ id: agentId, companyId, name: "Native agent", adapterType: "paperclip_runner",
      status: lifecycleState === "ready" ? "active" : "paused", lifecycleState, lifecycleHolds: [], lifecycleRequiredPluginIds: [],
      pauseReason: lifecycleState === "ready" ? null : "manual" });
    // The tree Pause is held on the task's parent, so the read must walk to an ancestor.
    const parentId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent task", status: "todo" });
    await db.insert(issues).values({ id: issueId, companyId, parentId, title: "Native task", status: "todo", assigneeAgentId: agentId });
    if (opts.treePause) {
      await db.insert(issueTreeHolds).values({ companyId, rootIssueId: parentId, mode: "pause", status: opts.treePause,
        reason: "Paused by a person", createdByActorType: "user", createdByUserId: userId,
        ...(opts.treePause === "released" ? { releasedAt: new Date(), releasedByActorType: "user", releasedByUserId: userId } : {}) });
    }
    const person = opts.status === "cancelled";
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      status: opts.status, runtimeMode: "native", nativeIssueId: issueId, startedAt: at, finishedAt: at,
      contextSnapshot: { issueId },
      resultJson: person ? {
        cancelledByActorType: "user", cancelledByUserId: userId,
        cancellation: { source: "operator", expected: true, initiator: { type: "user", userId },
          reason: "Cancelled by a board operator", recordedAt: at.toISOString() },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", scope: opts.scope ?? "run", runId, companyId, issueId,
          intentId: `native-cancellation:${randomUUID()}`, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
          dispatchState: "acknowledged", dispatched: true },
      } : {} });
    await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "terminal_failure",
      failureCode: opts.failureCode, failureDetail: {}, resultId: null, leaseOwner: null });
    if (opts.recoveryAction) {
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        cause: "native_session_cleanup_quarantined", fingerprint: `cleanup:${runId}`, ownerType: "board", status: "active",
        nextAction: "Verify the stopped session before starting a new attempt.", evidence: { runId }, attemptCount: 1, maxAttempts: 3 });
    }
    const response = await request(routeApp(db, actor, (d) => agentRoutes(d)))
      .get(`/api/heartbeat-runs/${runId}`).expect(200);
    return response.body.execution as { phase: string; label: string; recoveryOwner: string | null; cause: string | null; nextAction: string | null };
  }

  for (const [row, scope] of [["(1) Stop", "run"], ["(2) task-tree Pause", "issue"], ["(3) agent Pause", "run"]] as const) {
    it(`${row}: a person's settled cancel shows Stopped, never Recovery needed`, async () => {
      const execution = await settledRun({ status: "cancelled", failureCode: "native_retry_cancelled", scope });
      expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null, cause: null,
        nextAction: "Send a new message to continue from saved work." });
    });
  }

  // While the Pause that stopped the run is still active, a new message is held,
  // not continued: the next step is the Pause's own, Resume.
  for (const [row, opts] of [
    ["(6) tree Pause active (hold on the parent)", { scope: "issue", treePause: "active" }],
    ["(7) agent Pause active (paused)", { scope: "run", agentLifecycle: "paused" }],
    ["(7b) agent Pause active (pausing)", { scope: "run", agentLifecycle: "pausing" }],
  ] as const) {
    it(`${row}: Stopped, and the next action is Resume, never Send a new message`, async () => {
      const execution = await settledRun({ status: "cancelled", failureCode: "native_retry_cancelled", ...opts });
      expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null, cause: null,
        nextAction: "Resume to continue." });
      expect(execution.nextAction).not.toMatch(/Send a new message/);
    });
  }

  it("(8) after Resume (tree hold released, agent ready): the plain Stop next action", async () => {
    const execution = await settledRun({ status: "cancelled", failureCode: "native_retry_cancelled", scope: "issue",
      treePause: "released", agentLifecycle: "ready" });
    expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null, cause: null,
      nextAction: "Send a new message to continue from saved work." });
  });

  it("(4) control: a person-cancelled run whose cleanup failed keeps the board's Recovery needed", async () => {
    const execution = await settledRun({ status: "cancelled", failureCode: "native_retry_cancelled", recoveryAction: true });
    expect(execution).toMatchObject({ phase: "recovery_needed", label: "Recovery needed", recoveryOwner: "board" });
  });

  it("(5) a non-person terminal failure still needs recovery", async () => {
    const execution = await settledRun({ status: "failed", failureCode: "native_session_retry_exhausted" });
    expect(execution).toMatchObject({ phase: "recovery_needed", label: "Recovery needed", recoveryOwner: "board" });
  });
});
