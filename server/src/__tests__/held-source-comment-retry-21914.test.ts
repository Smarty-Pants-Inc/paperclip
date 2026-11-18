import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, executionWorkspaces, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, projects, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { recordRequiredWorkspaceRestoreFailure } from "../services/legacy-execution-recovery.js";
import { adoptSystemRecovery } from "../services/system-recovery.js";
import { recordNativeLocalProcessStop } from "../services/native-local-process-stop.js";
import { getExecutionBlocker, NEW_TASK_CONTINUE_ACTION } from "../services/execution-blocker.js";
import { readSystemRecovery } from "../services/system-recovery-state.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { taskRetryRunAncestry } from "../services/recovery-run-ancestry.js";
import { recoveryService } from "../services/recovery/service.js";

const execFile = promisify(execFileCallback);
const support = await getEmbeddedPostgresTestSupport();

/**
 * R4 (#21914), the live shape of upq-c2a-p5f-g2-21914 field by field: the board
 * marks the task Done while its native run is active; that run keeps a required
 * saved-work hold. The person's comment reopens the task; its run is cancelled
 * before start by the stale-run gate and the comment's wake is deferred. The
 * person presses Retry. Retry must reach the held source, admit ONE run, and
 * that run's input carries the person's comment.
 */
describe.skipIf(!support.supported)("R4 #21914: Retry after a held source's pre-start cancellation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-r4-21914-"));
    database = await startEmbeddedPostgresTestDatabase("r4-21914-");
    db = createDb(database.connectionString);
    // Runs are admitted and stay queued: no provider executes in this test.
    closeProcessRunAdmission();
  }, 90_000);
  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    resetProcessRunAdmissionForTests();
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function git(cwd: string, ...args: string[]) {
    return (await execFile("git", ["-C", cwd, ...args])).stdout.trim();
  }

  /** `foreign`: the task was reassigned, so the held source belongs to another agent. */
  async function liveShape(options: { foreign?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID();
    const userId = `r4-person-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "R4 21914", defaultResponsibleUserId: userId,
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 8)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values([agentId, otherAgentId].map(id => ({ id, companyId, name: id === agentId ? "Parent" : "Former",
      role: "engineer", adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } })));
    const [project] = await db.insert(projects).values({ companyId, name: "Repository" }).returning();
    const primary = join(root, `${issueId}-primary`);
    await execFile("git", ["init", "--initial-branch=main", primary]);
    await git(primary, "config", "user.email", "test@example.com");
    await git(primary, "config", "user.name", "R4 test");
    await writeFile(join(primary, "README.md"), "committed\n");
    await git(primary, "add", ".");
    await git(primary, "commit", "-m", "base");
    const worktree = join(root, `${issueId}-worktree`);
    const branchName = `TASK-${issueId.slice(0, 8)}`;
    await git(primary, "worktree", "add", "-b", branchName, worktree, "main");
    const sourceAgentId = options.foreign ? otherAgentId : agentId;
    await db.insert(issues).values({ id: issueId, companyId, projectId: project.id, title: "TEST parent", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" } });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: branchName, status: "active", cwd: worktree,
      providerType: "git_worktree", providerRef: worktree, baseRef: "main", branchName }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issueId));

    // f077…: the parent's native run, cancelled by the board's Done
    // (routes/issues.ts "Cancelled before issue terminalization").
    const cancelledAt = new Date(Date.now() - 20_000);
    const [native] = await db.insert(heartbeatRuns).values({ companyId, agentId: sourceAgentId, issueId, nativeIssueId: issueId,
      invocationSource: "assignment", triggerDetail: "system", runtimeMode: "native", status: "cancelled",
      errorCode: "issue_terminalized", error: "Cancelled before issue terminalization", processPid: 999_999_999,
      responsibleUserId: userId, startedAt: new Date(Date.now() - 80_000), finishedAt: cancelledAt,
      contextSnapshot: { issueId, taskId: issueId, source: "issue.create", wakeReason: "issue_assigned" },
      resultJson: { stopReason: "cancelled", cancelledByUserId: userId, cancelledByActorType: "user",
        cancellation: { reason: "Cancelled before issue terminalization", source: "operator", expected: true,
          initiator: { id: userId, type: "user" }, recordedAt: cancelledAt.toISOString() },
        startupCancellation: { errorCode: "issue_terminalized", requestedAt: cancelledAt.toISOString(), beforeNativeSelection: false },
        executionCancellation: { proof: "provider_termination_receipt", state: "acknowledged",
          requestedAt: cancelledAt.toISOString(), acknowledgedAt: cancelledAt.toISOString() },
        terminalizationStopConfirmed: true } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: native.id, provider: "local",
      status: "expired", leasePolicy: "ephemeral", executionWorkspaceId: workspace.id, releasedAt: cancelledAt,
      cleanupStatus: "success" }).returning();
    expect(await db.transaction(tx => recordNativeLocalProcessStop(tx as unknown as Db, native))).toBe(true);
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, native.id));
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.id));
    // Its required saved-work hold, written by the production writer
    // (legacy-execution-recovery.ts), then adopted by system recovery as live.
    await recordRequiredWorkspaceRestoreFailure(db, stopped, { ...stopped.resultJson, workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id] } });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(hold).toMatchObject({ kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      cause: "native_continuation_requires_reconciliation",
      evidence: { runId: native.id, workspaceRestoreFailure: "restore_failed", automaticRecovery: { replay: "blocked" } } });
    await adoptSystemRecovery(db, { companyId, issueId, runId: native.id, actionId: hold.id });

    // The board marked it Done; the person's comment reopens it (issue.comment.reopen).
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Person request: answer exactly once with `ACK violet otter`." }).returning();
    const context = { issueId, taskId: issueId, taskKey: issueId, commentId: comment.id, wakeCommentId: comment.id,
      wakeCommentIds: [comment.id], source: "issue.comment.reopen", reopenedFrom: "done",
      wakeReason: "issue_reopened_via_comment", wakeSource: "automation", wakeTriggerDetail: "system" };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_reopened_via_comment", status: "queued", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId, commentId: comment.id, mutation: "comment", reopenedFrom: "done" } }).returning();
    const [successor] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "automation",
      triggerDetail: "system", status: "queued", runtimeMode: "legacy", wakeupRequestId: wake.id,
      responsibleUserId: userId, contextSnapshot: context }).returning();
    await db.update(agentWakeupRequests).set({ runId: successor.id }).where(eq(agentWakeupRequests.id, wake.id));

    // cbf2…: the production stale-run gate cancels it before start.
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId, runId: successor.id,
      expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
    expect(cancelled).toMatchObject({ status: "cancelled", runtimeMode: "legacy", startedAt: null, retryOfRunId: null,
      errorCode: "execution_reconciliation_required", resultJson: { stopReason: "execution_reconciliation_required",
        timeoutSource: "stale_queued_run_gate", executionWait: { issueId, recoveryActionId: hold.id } } });
    const [deferred] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    if (!options.foreign) expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "execution_recovery", recoveryActionId: hold.id } } });
    // The live projection: held by the native source, Retry disabled, one saved message.
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: hold.id, runId: native.id,
      cause: "native_continuation_requires_reconciliation", canRetry: false, workspaceRepairRequired: true, savedMessageCount: options.foreign ? 0 : 1 });
    return { companyId, agentId, otherAgentId, issueId, userId, native: stopped, hold, comment, wake, successor: cancelled };
  }

  const runsOf = (issueId: string) => db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
  const carriesComment = (run: typeof heartbeatRuns.$inferSelect, commentId: string) =>
    run.contextSnapshot?.wakeCommentId === commentId ||
    (Array.isArray(run.contextSnapshot?.wakeCommentIds) && (run.contextSnapshot.wakeCommentIds as unknown[]).includes(commentId));

  it("Retry reaches the held native source and admits exactly one run carrying the person's comment", async () => {
    const f = await liveShape();
    const before = await runsOf(f.issueId);
    expect(before).toHaveLength(2);
    // The person presses Retry on the latest (pre-start-cancelled) run.
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.userId,
      observedRunId: f.successor.id, idempotencyKey: randomUUID() });
    expect(receipt).toMatchObject({ accepted: true, observedRunId: f.successor.id });
    // The held source's recovery action is bound to this Retry, as for a normal predecessor.
    const [bound] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.hold.id));
    expect(readSystemRecovery(bound.evidence)).toMatchObject({ sourceRunId: f.native.id, intentId: receipt.requestId });
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const admitted = (await runsOf(f.issueId)).filter(run => !before.some(old => old.id === run.id));
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ status: "queued", contextSnapshot: { taskRetryRequestId: receipt.requestId,
      explicitUserContinuation: { readiness: { sourceRunId: f.native.id } } } });
    // Its input carries the person's comment, and nothing else will deliver it again.
    expect(carriesComment(admitted[0]!, f.comment.id)).toBe(true);
    const [adopted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(adopted).toMatchObject({ status: "coalesced", runId: admitted[0]!.id });
    const deliveries = (await runsOf(f.issueId)).filter(run => carriesComment(run, f.comment.id) &&
      !(run.status === "cancelled" && !run.startedAt));
    expect(deliveries.map(run => run.id)).toEqual([admitted[0]!.id]);
    const stillDeferred = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(stillDeferred).toEqual([]);
  }, 60_000);

  it("a foreign held source is not bound and admits nothing; the notice does not say Press Retry", async () => {
    const f = await liveShape({ foreign: true });
    const before = await runsOf(f.issueId);
    expect(await taskRetryRunAncestry({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: f.successor.id })).toEqual([f.successor.id]);
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.userId,
      observedRunId: f.successor.id, idempotencyKey: randomUUID() });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.hold.id));
    expect(readSystemRecovery(hold.evidence)?.intentId).toBeNull();
    if (receipt.requestId) await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId);
    expect(await runsOf(f.issueId)).toHaveLength(before.length);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker).toMatchObject({ canRetry: false });

    // The stranded escalation notice (recovery/service.ts) for this task.
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const recovery = recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup });
    await recovery.escalateStrandedAssignedIssue({ issue, previousStatus: "todo", latestRun: f.successor });
    const notices = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system")));
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice.body).not.toMatch(/Press Retry/);
      expect(JSON.stringify(notice.metadata)).not.toMatch(/Press Retry/);
    }
    // The existing true text instead: the blocker's own next action, and
    // upstream's new-task wording in place of the Retry sentence.
    const escalation = notices.at(-1)!;
    expect(escalation.body).toContain(NEW_TASK_CONTINUE_ACTION);
    expect(JSON.stringify(escalation.metadata)).toContain(JSON.stringify(blocker!.nextAction));
  }, 60_000);

  it("keeps a source from another company or task out of the ancestry, and an ordinary retry edge unchanged", async () => {
    const f = await liveShape();
    const g = await liveShape();
    expect(await taskRetryRunAncestry({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: f.successor.id })).toEqual([f.successor.id, f.native.id]);
    // The receipt names another company's (and task's) action: no edge.
    await db.update(heartbeatRuns).set({ resultJson: { ...f.successor.resultJson,
      executionWait: { issueId: f.issueId, recoveryActionId: g.hold.id } } }).where(eq(heartbeatRuns.id, f.successor.id));
    expect(await taskRetryRunAncestry({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: f.successor.id })).toEqual([f.successor.id]);
    // Same company, another task's action naming this very source run: no edge.
    const [otherTask] = await db.insert(issues).values({ companyId: f.companyId, title: "Another task", status: "todo",
      assigneeAgentId: f.agentId }).returning();
    const [otherAction] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: otherTask.id,
      kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", ownerType: "board",
      fingerprint: `native-workspace:${randomUUID()}`, status: "resolved", outcome: "blocked", nextAction: "Reconcile",
      evidence: { runId: f.native.id, automaticRecovery: { replay: "blocked" } } }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { ...f.successor.resultJson,
      executionWait: { issueId: f.issueId, recoveryActionId: otherAction.id } } }).where(eq(heartbeatRuns.id, f.successor.id));
    expect(await taskRetryRunAncestry({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: f.successor.id })).toEqual([f.successor.id]);
    await db.update(heartbeatRuns).set({ resultJson: f.successor.resultJson }).where(eq(heartbeatRuns.id, f.successor.id));
    // An ordinary Retry run with a real retry_of_run_id keeps that edge.
    const [earlier] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "failed", runtimeMode: "legacy", errorCode: "adapter_failed", contextSnapshot: { issueId: f.issueId },
      createdAt: new Date(Date.now() - 120_000), startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 110_000) }).returning();
    await db.update(heartbeatRuns).set({ retryOfRunId: earlier.id }).where(eq(heartbeatRuns.id, f.successor.id));
    expect(await taskRetryRunAncestry({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      sourceRunId: f.successor.id })).toEqual([f.successor.id, earlier.id]);
  }, 60_000);
});
