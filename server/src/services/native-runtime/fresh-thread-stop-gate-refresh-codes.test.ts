import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../../__tests__/helpers/truncate-with-deadlock-retry.js";
import { ensureFreshContinuation, resetBacklogContinuationPacingForTests } from "../fresh-continuation-fallback.js";
import { heartbeatService } from "../heartbeat.js";
import { isInstructionRefreshPrepareCode, RUNNER_PREPARE_REFUSAL_CODES, NativeRunnerRefreshRequiredError } from "../../vendor/paperclip-runner/index.js";
import { freshThreadRefusalCode } from "./runner-reconciliation-refusal.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("fresh thread wording follows Runner instruction-refresh codes", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("fresh-thread-refresh-codes-"); db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "FTR", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);
  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(db, `truncate table issue_recovery_actions, native_run_finalizations, tool_invocations, issue_approvals, approvals, issue_thread_interactions, activity_log, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed() {
    const issueId = randomUUID(), runId = randomUUID(), finishedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Refresh instructions", status: "blocked", assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId, nativeIssueId: issueId, runtimeMode: "native", status: "failed", errorCode: "native_runner_refresh_required", error: "native_runner_refresh_required", nativePhase: "terminal_failure", nativeSessionId: randomUUID(), runnerProfileJson: null, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, createdAt: new Date(finishedAt.getTime() - 120_000), responsibleUserId: userId, contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${runId}`, nextAction: "Reconcile previous execution", maxAttempts: 3, createdAt: finishedAt, evidence: { runId, originalFailureCode: "native_runner_refresh_required", nativeFailureBlock: { runId, statusVersion: 4 } } }).returning();
    return { issueId, runId, actionId: action.id };
  }

  it.each(RUNNER_PREPARE_REFUSAL_CODES)("%s uses wording selected by Runner instruction-refresh admission", async prepareCode => {
    const error = new NativeRunnerRefreshRequiredError(false, prepareCode);
    const code = freshThreadRefusalCode(error);
    expect(code).toBe("native_runner_refresh_required");
    const f = await seed();
    await db.update(heartbeatRuns).set({ resultJson: { nativeFreshContinuationRefusal: { code, prepareRefusalCode: prepareCode, waitForTurn: false } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" })).toMatchObject({ kind: "continued" });
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(notes).toHaveLength(1);
    if (isInstructionRefreshPrepareCode(prepareCode)) {
      expect(notes[0].body).toMatch(/your skill change is in effect/i);
    } else {
      expect(notes[0].body).not.toMatch(/your skill change is in effect/i);
    }
  });
});
