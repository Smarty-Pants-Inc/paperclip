import { randomUUID } from "node:crypto";
import request from "supertest";
import { sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
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
  }) {
    const db = ctx.db;
    const { companyId, actor, userId } = await seedCompanyWithBoardAccess(db, "Person cancel projection");
    const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const at = new Date(Date.now() - 60 * 60_000);
    await db.insert(agents).values({ id: agentId, companyId, name: "Native agent", adapterType: "paperclip_runner",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(issues).values({ id: issueId, companyId, title: "Native task", status: "todo", assigneeAgentId: agentId });
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
    return response.body.execution as { phase: string; label: string; recoveryOwner: string | null; cause: string | null };
  }

  for (const [row, scope] of [["(1) Stop", "run"], ["(2) task-tree Pause", "issue"], ["(3) agent Pause", "run"]] as const) {
    it(`${row}: a person's settled cancel shows Stopped, never Recovery needed`, async () => {
      const execution = await settledRun({ status: "cancelled", failureCode: "native_retry_cancelled", scope });
      expect(execution).toMatchObject({ phase: "completed", label: "Stopped", recoveryOwner: null, cause: null });
    });
  }

  it("(4) control: a person-cancelled run whose cleanup failed keeps the board's Recovery needed", async () => {
    const execution = await settledRun({ status: "cancelled", failureCode: "native_retry_cancelled", recoveryAction: true });
    expect(execution).toMatchObject({ phase: "recovery_needed", label: "Recovery needed", recoveryOwner: "board" });
  });

  it("(5) a non-person terminal failure still needs recovery", async () => {
    const execution = await settledRun({ status: "failed", failureCode: "native_session_retry_exhausted" });
    expect(execution).toMatchObject({ phase: "recovery_needed", label: "Recovery needed", recoveryOwner: "board" });
  });
});
