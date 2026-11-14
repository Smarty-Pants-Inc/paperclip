import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, authUsers, agentWakeupRequests, closeRegisteredClients, companies, createDb,
  environments, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, workspaceOperations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { prepareConversationTurn } from "../services/agent-conversations.js";
import { preserveNativeFailedWorkspace } from "../services/native-runtime/native-failed-workspace-recovery.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { hasVerifiedWorkspaceRepair } from "../services/workspace-recovery-receipt.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

// Keep: recorded SMA-43/SMA-63 incident. Characterization of the production RED,
// not an assertion that a skipped restore is correct. Real HTTP + real durable
// admission + real failed-workspace preservation writer, no provider execution.
// Setup is copied from c9-restore-twin.test.ts. Never use a shared database or
// call cleanup's deletion; stop this owned Postgres and retain the evidence.
describe("SMA-43/SMA-63 resolved native hold restore twin", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let stopOwnedPostgres: (() => void) | undefined;
  const userId = `resolved-hold-board-${randomUUID()}`;
  const support = getEmbeddedPostgresTestSupport();
  beforeAll(async () => {
    expect((await support).supported, "embedded Postgres required; no expected skip").toBe(true);
    expect(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL).toBeUndefined();
    temporary = await startEmbeddedPostgresTestDatabase("c9-resolved-hold-twin-");
    db = createDb(temporary.connectionString);
    const port = new URL(temporary.connectionString).port;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== port) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        stopOwnedPostgres = () => { execFileSync(args[0]!.replace(/postgres$/, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]); };
        console.info("RESOLVED-HOLD owned Postgres evidence", { pid, dataDir, port });
        break;
      } catch { /* unrelated or already-exited process */ }
    }
    expect(stopOwnedPostgres, "must own bounded non-deleting cluster stop").toBeDefined();
    closeProcessRunAdmission();
    await db.insert(authUsers).values({ id: userId, name: "Resolved hold board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);
  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    if (temporary) await closeRegisteredClients(temporary.connectionString);
    stopOwnedPostgres?.();
    console.info("RESOLVED-HOLD owned Postgres stopped with pg_ctl -w; data retained");
    resetProcessRunAdmissionForTests();
  });
  function appForBoard() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId }; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }
  const runRows = (issueId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId));
  const wakeRows = (agentId: string) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  const issueRow = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  async function waitForTaskRetryRun(issueId: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const run = (await runRows(issueId)).find(row => typeof row.contextSnapshot?.taskRetryRequestId === "string");
      if (run) return run;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return undefined;
  }
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resolved native hold twin", issuePrefix: `RH${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Persistent native chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    }).returning();
    const managed = await agentInstructionsService(db).materializeManagedBundle(agent!, { "AGENTS.md": "Reply to the person in this persistent conversation.\n" });
    await db.update(agents).set({ adapterConfig: managed.adapterConfig }).where(eq(agents.id, agentId));
    expect((await agentInstructionsService(db).readFile({ ...agent!, adapterConfig: managed.adapterConfig }, "AGENTS.md")).content).toContain("persistent conversation");
    const app = appForBoard();
    const opened = await request(app).post(`/api/companies/${companyId}/chats/${agentId}`).send({}).expect(200);
    const issueId = opened.body.id as string;
    expect(opened.body).toMatchObject({ conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting" });
    const message = await request(app).post(`/api/issues/${issueId}/comments`)
      .send({ body: "Continue my persistent work.", clientRequestId: randomUUID() }).expect(201);
    const admitted = (await runRows(issueId)).find(run => run.contextSnapshot?.wakeCommentId === message.body.id)!;
    expect(admitted).toBeDefined();
    await prepareConversationTurn(db, admitted);
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      nativePhase: "terminal_failure", errorCode: "adapter_failed", error: "Injected native failure before workspace export",
      startedAt: new Date(Date.now() - 10_000), finishedAt: new Date(Date.now() - 1000), updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, admitted.id));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: admitted.id, phase: "terminal_failure" });
    const [environment] = await db.insert(environments).values({ name: `Resolved hold ${admitted.id}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: admitted.id,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
    }).returning();
    const [failed] = await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: admitted.id,
      leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
    } } }).where(eq(heartbeatRuns.id, admitted.id)).returning();
    // Real writer creates the RESOLVED no-replay hold itself. No hand-written
    // automaticRecovery or workspaceRestoreRecovery payload substitutes for it.
    const retained = await preserveNativeFailedWorkspace(db, failed!);
    expect(retained?.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease!.id] } });
    const [written] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(written).toMatchObject({ kind: "active_run_watchdog", status: "resolved", cause: "native_continuation_requires_reconciliation",
      evidence: { runId: failed!.id, automaticRecovery: { replay: "blocked" } } });
    // The production action is system-owned; the preservation writer starts
    // board-owned. Seed only that bookkeeping identity, not the hold predicate.
    await db.update(issueRecoveryActions).set({ ownerType: "system" }).where(eq(issueRecoveryActions.id, written!.id));
    const recovery = recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup });
    await recovery.escalateStrandedAssignedIssue({ issue: await issueRow(issueId), previousStatus: "in_progress", latestRun: retained! });
    const board = await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId);
    expect(board).toMatchObject({ kind: "stranded_assigned_issue", status: "active", ownerType: "board" });
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: written!.id, runId: failed!.id, workspaceRepairRequired: true });
    return { companyId, agentId, issueId, app, board: board!, system: written!, failed: retained!, lease: lease! };
  }
  it("recovered-files control: Try again uses one task Retry, then a NEW message follows normal admission", async () => {
    const f = await fixture();
    // Recorded-call fixture only: no remote sandbox exists, and no provider or
    // deletion path is run. Seed the host's successful copyback/stop receipts;
    // the real receipt reader and continuation admission must verify them.
    const reference = f.failed.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
    const [repaired] = await db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...f.failed.runnerProfileJson, nativeWorkspaceSync: { ...reference, state: "finalized", finalHostSha256: "c".repeat(64) },
    } }).where(eq(heartbeatRuns.id, f.failed.id)).returning();
    await db.update(issueRecoveryActions).set({ evidence: { ...f.system.evidence,
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.failed.id, status: "recovered",
        stage: "saving_receipts", attempt: 1, requestIds: [] },
    } }).where(eq(issueRecoveryActions.id, f.system.id));
    await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.failed.id,
      phase: "workspace_recovery", status: "succeeded", finishedAt: new Date(), metadata: {
        recoveryActionId: f.system.id, leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId,
        descriptorSha256: reference.descriptorSha256, finalHostSha256: "c".repeat(64),
      } });
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { ...f.lease.metadata, pendingCleanupInFlight: false,
        remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.lease.providerLeaseId, state: "stopped" }) },
    }).where(eq(environmentLeases.id, f.lease.id));
    expect(await hasVerifiedWorkspaceRepair(db, repaired!)).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: f.system.id, workspaceRepairRequired: false,
      workspaceRecovery: { status: "recovered" } });
    const before = await runRows(f.issueId);
    await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" }).expect(200);
    const retryRun = await waitForTaskRetryRun(f.issueId);
    expect(retryRun).toBeDefined();
    expect(retryRun).toMatchObject({ status: "queued", contextSnapshot: { previousRunId: f.failed.id,
      taskRetryRequestId: expect.any(String) } });
    expect(await runRows(f.issueId)).toHaveLength(before.length + 1);
    const retryWake = (await wakeRows(f.agentId)).find(wake => wake.runId === retryRun!.id);
    expect(retryWake).toMatchObject({ reason: "task_retry", requestedByActorType: "user", requestedByActorId: userId });
    const retryRequestId = retryRun!.contextSnapshot!.taskRetryRequestId as string;
    await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" }).expect(200);
    await heartbeatService(db).resumeTaskRetry(f.companyId, retryRequestId);
    expect(await runRows(f.issueId)).toHaveLength(before.length + 1);
    expect((await runRows(f.issueId)).filter(run => run.contextSnapshot?.taskRetryRequestId)).toHaveLength(1);
    const next = await request(f.app).post(`/api/issues/${f.issueId}/comments`)
      .send({ body: "New user direction after saved files recovered.", clientRequestId: randomUUID() }).expect(201);
    const newWake = (await wakeRows(f.agentId)).find(wake => wake.idempotencyKey === `conversation-comment:${next.body.id}`);
    expect(newWake).toMatchObject({ status: "deferred_issue_execution", runId: null, requestedByActorType: "user", requestedByActorId: userId });
    await heartbeatService(db).cancelRun(retryRun!.id, "Twin releases its never-started Try again run", { suppressImmediateRecovery: true });
    const promoted = (await wakeRows(f.agentId)).find(wake => wake.id === newWake!.id);
    expect(promoted!.runId).toBeTruthy();
    expect(promoted!.runId).not.toBe(retryRun!.id);
    expect((await runRows(f.issueId)).find(run => run.id === promoted!.runId)).toMatchObject({ status: "queued",
      contextSnapshot: { wakeCommentId: next.body.id } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    console.info("RESOLVED-HOLD recovered-files Try again + NEW message", { issueId: f.issueId, systemActionId: f.system.id,
      retryWakeId: retryWake!.id, retryRunId: retryRun!.id, newMessageWakeId: promoted!.id, newMessageRunId: promoted!.runId });
  });
  it("without repaired files, Try again uses one fresh-workspace task Retry and preserves the source hold", async () => {
    const f = await fixture();
    // Prove the file-repair gate independently of remote cleanup: the original
    // provider is stopped, but no copyback/recovery receipt is present.
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { ...f.lease.metadata, pendingCleanupInFlight: false,
        remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.lease.providerLeaseId, state: "stopped" }) },
    }).where(eq(environmentLeases.id, f.lease.id));
    expect(await hasVerifiedWorkspaceRepair(db, f.failed)).toBe(false);
    const before = await runRows(f.issueId);
    const restored = await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" }).expect(200);
    expect(restored.body.recoveryAction).toMatchObject({ id: f.board.id, status: "resolved", outcome: "handed_back" });
    expect(restored.body.issue).toMatchObject({ status: "todo", assigneeAgentId: f.agentId, activeRecoveryAction: null });
    const retryRun = await waitForTaskRetryRun(f.issueId);
    expect(retryRun).toMatchObject({ status: "queued", contextSnapshot: { previousRunId: f.failed.id,
      taskRetryRequestId: expect.any(String), explicitUserContinuation: { readiness: {
        mode: "fresh_isolated_workspace", retainedSourceIds: [f.lease.id] } } } });
    expect(await runRows(f.issueId)).toHaveLength(before.length + 1);
    const retryWake = (await wakeRows(f.agentId)).find(wake => wake.runId === retryRun!.id);
    expect(retryWake).toMatchObject({ reason: "task_retry", requestedByActorType: "user", requestedByActorId: userId });
    expect(await hasVerifiedWorkspaceRepair(db, f.failed)).toBe(false);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.system.id))).toMatchObject([
      { status: "resolved", evidence: { runId: f.failed.id, automaticRecovery: { replay: "explicit_user_continuation" },
        explicitUserContinuation: { taskRetryRequestId: retryRun!.contextSnapshot!.taskRetryRequestId } } },
    ]);

    // A duplicate card click and scheduler redelivery share the durable
    // action-bound Retry key; neither can manufacture a second successor.
    const retryRequestId = retryRun!.contextSnapshot!.taskRetryRequestId as string;
    await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" }).expect(200);
    await heartbeatService(db).resumeTaskRetry(f.companyId, retryRequestId);
    expect(await runRows(f.issueId)).toHaveLength(before.length + 1);
    expect((await runRows(f.issueId)).filter(run => run.contextSnapshot?.taskRetryRequestId)).toHaveLength(1);

    const next = await request(f.app).post(`/api/issues/${f.issueId}/comments`)
      .send({ body: "A NEW message after Try again.", clientRequestId: randomUUID() }).expect(201);
    const newWake = (await wakeRows(f.agentId)).find(wake => wake.idempotencyKey === `conversation-comment:${next.body.id}`);
    expect(newWake).toMatchObject({ status: "deferred_issue_execution", runId: null, requestedByActorType: "user", requestedByActorId: userId });
    expect((await db.select().from(issueComments).where(eq(issueComments.id, next.body.id)))[0]).toMatchObject({ body: "A NEW message after Try again.", authorUserId: userId });
    expect(await runRows(f.issueId)).toHaveLength(before.length + 1);
    console.info("RESOLVED-HOLD fresh-workspace task Retry admitted once; source retained; new message saved", { issueId: f.issueId, boardActionId: f.board.id,
      systemActionId: f.system.id, retryWakeId: retryWake!.id, retryRunId: retryRun!.id, newMessageWakeId: newWake!.id });
  });
  it("a stale Try again reports the refusal and keeps the board card unresolved", async () => {
    const f = await fixture();
    const newerAt = new Date(Date.now() + 1_000);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
      contextSnapshot: { issueId: f.issueId }, createdAt: newerAt, finishedAt: newerAt, errorCode: "adapter_failed" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.failed.id });
    const before = await runRows(f.issueId);
    const response = await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("failed run changed before Try again was accepted");
    expect(await issueRow(f.issueId)).toMatchObject({ status: "blocked" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.board.id)))
      .toMatchObject([{ status: "active", outcome: null }]);
    expect(await runRows(f.issueId)).toHaveLength(before.length);
    expect((await wakeRows(f.agentId)).filter(wake => wake.idempotencyKey === `task-retry:${f.board.id}`)).toHaveLength(0);

    const issueAfterRefusal = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    const refusal = issueAfterRefusal.body.activeRecoveryAction.evidence.taskRetryRefusal;
    expect(refusal).toMatchObject({ schema: "paperclip.task-retry-source-refusal.v1",
      recoveryActionId: f.board.id, sourceRunId: f.failed.id, currentRunId: expect.any(String),
      reason: expect.stringContaining("older run"), nextAction: expect.stringContaining("latest run") });
    expect(issueAfterRefusal.body.activeRecoveryAction.nextAction).toBe(refusal.nextAction);

    await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" }).expect(409);
    const issueAfterRepeat = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(issueAfterRepeat.body.activeRecoveryAction.evidence.taskRetryRefusal).toEqual(refusal);
    expect(await runRows(f.issueId)).toHaveLength(before.length);
  });
});
