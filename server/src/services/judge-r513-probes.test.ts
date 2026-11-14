import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, environmentLeases, heartbeatRuns, heartbeatRunEvents, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../__tests__/helpers/truncate-with-deadlock-retry.js";
import { ensureFreshContinuation, readFreshContinuationSessionBoundary, resetBacklogContinuationPacingForTests } from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { readFreshThreadStopProof } from "./native-runtime/fresh-thread-stop-gate.js";
import * as processOwner from "./run-process-owner.js";
import { freshThreadRefusalCode } from "./native-runtime/runner-reconciliation-refusal.js";
import { runnerPrepareRefusalCode } from "../vendor/paperclip-runner/index.js";
import { NativeRunnerRefreshRequiredError } from "../../../packages/paperclip-runner/src/contracts/harness-driver.js";

const rflJudgeLogDir = () => { const dir = join(process.env.RFL_JUDGE_LOG_DIR ?? process.env.TASK_OUT ?? tmpdir(), "logs"); mkdirSync(dir, { recursive: true }); return dir; };

// Keep: executor-exclusion trust boundary and truthful skill-change notices.
// No production/provider calls. Real database and real local OS reads.
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("R513 independent allocation and instruction probes", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("r513-probes-"); db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "RFL", requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks(); resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(db, `truncate table issue_recovery_actions, native_run_finalizations, tool_invocations, issue_approvals, approvals, issue_thread_interactions, activity_log, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(profile: Record<string, unknown> | null, code = "runner_remote_state_unavailable") {
    const issueId = randomUUID(), runId = randomUUID(), finishedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Finish the pending reply", status: "blocked", assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId, nativeIssueId: issueId, runtimeMode: "native", status: "failed", errorCode: code, error: code, nativePhase: "terminal_failure", nativeSessionId: randomUUID(), runnerProfileJson: profile, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, createdAt: new Date(finishedAt.getTime() - 120_000), responsibleUserId: userId, contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${runId}`, nextAction: "Reconcile previous execution", maxAttempts: 3, createdAt: finishedAt, evidence: { runId, originalFailureCode: code, nativeFailureBlock: { runId, statusVersion: 4 } } }).returning();
    return { issueId, runId, actionId: action.id };
  }
  function remoteProfile(extra: Record<string, unknown> = {}) {
    return { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1", workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: `remote-${randomUUID()}`, remoteCwd: "/workspace", epoch: 1, state: "prepared", snapshotId: null, ...extra } };
  }
  async function launch(f: Awaited<ReturnType<typeof seed>>, targetKind?: string, seq = 1, identity = false) {
    await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq, eventType: identity ? "native.process_identity_recorded" : "native.process_start_requested", stream: "system", payload: { hostname: hostname(), ...(targetKind ? { targetKind } : {}), providerAttempt: 1, requestedAt: new Date().toISOString() } });
  }
  async function closedLease(f: Awaited<ReturnType<typeof seed>>, providerLeaseId: string) {
    const acquiredAt = new Date(Date.now() - 5000), now = new Date(), id = randomUUID();
    await db.insert(environmentLeases).values({ id, companyId, issueId: f.issueId, heartbeatRunId: f.runId, provider: "boat", providerLeaseId, status: "released", acquiredAt, releasedAt: now, cleanupStatus: "success", metadata: { pluginId: "fixture-boat", remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId: f.runId, leaseId: id, provider: "boat", providerLeaseId, state: "stopped", confirmedAt: now.toISOString() } } });
  }
  async function observe(f: Awaited<ReturnType<typeof seed>>, label: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const localRead = vi.spyOn(processOwner, "noLocalRunnerProcessesForRuns");
    const localIdentityRead = vi.spyOn(processOwner, "proveRunProcessGone");
    const proof = await readFreshThreadStopProof(db, run, f.issueId);
    const result = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const [next] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running", createdAt: new Date(Date.now() + 1000), contextSnapshot: { issueId: f.issueId, previousRunId: f.runId, recoveryActionId: action.id } }).returning();
    const boundary = await readFreshContinuationSessionBoundary(db, next, f.issueId);
    const observed = { label, proof, result, settlement: action.evidence.freshContinuation ?? null, boundary, localReads: localRead.mock.calls.length, localIdentityReads: localIdentityRead.mock.calls.length };
    appendFileSync(join(rflJudgeLogDir(), "independent-observations.jsonl"), JSON.stringify(observed) + "\n");
    return observed;
  }
  function unproven(o: Awaited<ReturnType<typeof observe>>) {
    expect.soft(o.proof.gone).toBe(false);
    expect.soft(o.result).toMatchObject({ kind: "exact_recovery_pending" });
    expect.soft(o.settlement).toBeNull(); expect.soft(o.boundary).toBeNull();
    expect.soft(o.localReads).toBe(0); expect.soft(o.localIdentityReads).toBe(0);
  }

  it.each(["absent", "null", "empty", "older-schema"])("A/B remote profile %s must not become local absence", async shape => {
    const profile = remoteProfile();
    if (shape === "absent") delete (profile.remoteWorkspace as Record<string, unknown>).providerLeaseId;
    if (shape === "null") (profile.remoteWorkspace as Record<string, unknown>).providerLeaseId = null;
    if (shape === "empty") profile.remoteWorkspace.providerLeaseId = "";
    if (shape === "older-schema") profile.remoteWorkspace.schema = "paperclip.remote-workspace-run.v0";
    const f = await seed(profile); await launch(f); unproven(await observe(f, shape));
  });
  it("C1 remote target event without profile or PID remains unproven", async () => {
    const f = await seed(null); await launch(f, "remote"); unproven(await observe(f, "event-only-remote"));
  });
  it("C2 remote target event cannot be bypassed by a dead controller-local PID", async () => {
    const f = await seed(null); await launch(f, "remote");
    const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }); expect(dead.status).toBe(0);
    await db.update(heartbeatRuns).set({ processPid: Number(dead.stdout.trim()) }).where(eq(heartbeatRuns.id, f.runId));
    unproven(await observe(f, "event-remote-dead-controller-pid"));
  });
  it("C3 earlier remote target event cannot be erased by a later controller identity event", async () => {
    const f = await seed(null); await launch(f, "remote"); await launch(f, undefined, 2, true);
    unproven(await observe(f, "remote-event-shadowed"));
  });
  it("C4 actual hostname-only launch with missing profile exposes location ambiguity", async () => {
    const f = await seed(null); await launch(f);
    const o = await observe(f, "actual-hostname-only-no-profile");
    // Diagnostic characterization, not a claim this row independently proves remote allocation.
    expect(o.proof.gone).toBe(true); expect(o.localReads).toBeGreaterThan(0);
  });
  it("D a differently bound successful close is not remote proof", async () => {
    const profile = remoteProfile(); const f = await seed(profile); await launch(f);
    await closedLease(f, `different-${randomUUID()}`); unproven(await observe(f, "mismatched-lease"));
  });
  it("E genuine local absence still proves gone by a positive OS read", async () => {
    const f = await seed(null); await launch(f, "local"); const o = await observe(f, "local-absent");
    expect(o.proof.gone).toBe(true); expect(o.result).toMatchObject({ kind: "continued" }); expect(o.localReads).toBeGreaterThan(0); expect(o.boundary).not.toBeNull();
  });
  it("F matching remote allocation plus successful close stays proven without local reads", async () => {
    const profile = remoteProfile(); const f = await seed(profile); await launch(f);
    await closedLease(f, profile.remoteWorkspace.providerLeaseId); const o = await observe(f, "matching-close");
    expect(o.proof.gone).toBe(true); expect(o.result).toMatchObject({ kind: "continued" }); expect(o.localReads).toBe(0); expect(o.localIdentityReads).toBe(0); expect(o.boundary).not.toBeNull();
  });
  it.each(["provider_active_turn", "provider_live_descendants", "provider_active_goal", "provider_contract_changed"] as const)("G typed instruction refresh carrying %s keeps the skill-change final wording", async prepareCode => {
    // Actual Runner typed error and actual readers; not a made-up JSON classifier.
    const error = new NativeRunnerRefreshRequiredError(false, prepareCode);
    const code = freshThreadRefusalCode(error), prepareRefusalCode = runnerPrepareRefusalCode(error);
    expect(code).toBe("native_runner_refresh_required"); expect(prepareRefusalCode).toBe(prepareCode);
    const f = await seed(null, code!);
    await db.update(heartbeatRuns).set({ resultJson: { nativeFreshContinuationRefusal: { code, prepareRefusalCode, waitForTurn: false } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" })).toMatchObject({ kind: "continued" });
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)); expect(notes).toHaveLength(1);
    appendFileSync(join(rflJudgeLogDir(), "independent-notes.jsonl"), JSON.stringify({ prepareCode, code, prepareRefusalCode, note: notes[0].body }) + "\n");
    expect(notes[0].body).toMatch(/your skill change is in effect/i);
  });
  it("H generic provider_prepare_refused is neutral", async () => {
    const error = Object.assign(new Error("Generic prepare refusal"), { runnerCommandResult: { commandType: "run.prepare", status: "failed", result: { code: "command_execution_failed" } } });
    const code = freshThreadRefusalCode(error), prepareRefusalCode = runnerPrepareRefusalCode(error);
    expect(prepareRefusalCode).toBe("provider_prepare_refused"); const f = await seed(null, code!);
    await db.update(heartbeatRuns).set({ resultJson: { nativeFreshContinuationRefusal: { code, prepareRefusalCode, waitForTurn: false } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" })).toMatchObject({ kind: "continued" });
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)); expect(notes).toHaveLength(1); expect(notes[0].body).not.toMatch(/your skill change is in effect/i);
  });
});
