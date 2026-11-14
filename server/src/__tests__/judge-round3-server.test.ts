import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
describe("Independent round-3 delta probes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let stopOwnedPostgres: (() => void) | undefined;
  const userId = `resolved-hold-board-${randomUUID()}`;
  const support = getEmbeddedPostgresTestSupport();
  beforeAll(async () => {
    expect((await support).supported, "embedded Postgres required; no expected skip").toBe(true);
    expect(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL).toBeUndefined();
    temporary = await startEmbeddedPostgresTestDatabase("judge-tryagain3-");
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

  async function addNewerFailedRun(f: Awaited<ReturnType<typeof fixture>>, offsetMs = 1000) {
    const at = new Date(Date.now() + offsetMs);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
      contextSnapshot: { issueId: f.issueId }, createdAt: at, finishedAt: at, errorCode: "adapter_failed" }).returning();
    return run!;
  }
  const click = (f: Awaited<ReturnType<typeof fixture>>) => request(f.app)
    .post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
    .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" });
  const refusalInput = (f: Awaited<ReturnType<typeof fixture>>, currentRunId: string) => ({
    companyId: f.companyId, sourceIssueId: f.issueId, recoveryActionId: f.board.id,
    sourceRunId: f.failed.id, currentRunId,
  });

  it("JUDGE: refreshing and both normal recovery sweeps must supply the advertised current recovery card", async () => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    const wakesBefore = await wakeRows(f.agentId);
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    await click(f).expect(409);
    const first = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(first.body.activeRecoveryAction.evidence.taskRetryRefusal.currentRunId).toBe(newer.id);
    const svc = recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup });
    const stranded = await svc.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const active = await svc.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const refreshed = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    // Pin the generated IDs and wall-clock fields so the byte comparison still catches GET-shape drift.
    const normalGetCard = refreshed.body.activeRecoveryAction;
    const fixturePath = [resolve(process.cwd(), "ui/src/__fixtures__/refused-card-from-get.json"),
      resolve(process.cwd(), "../ui/src/__fixtures__/refused-card-from-get.json")].find(existsSync)!;
    expect(JSON.stringify({
      ...normalGetCard,
      id: "8e8153f0-7868-4200-bfd4-aab67e0c2287",
      companyId: "944eec99-d2f1-4bab-a52a-139ebcc36004",
      sourceIssueId: "332ea2a8-da19-430f-8eec-01c0fb680701",
      previousOwnerAgentId: "d7862449-edc0-4f29-b9f0-2fb4d6cc7b99",
      returnOwnerAgentId: "d7862449-edc0-4f29-b9f0-2fb4d6cc7b99",
      fingerprint: "source_scoped_recovery:944eec99-d2f1-4bab-a52a-139ebcc36004:332ea2a8-da19-430f-8eec-01c0fb680701:stranded_assigned_issue",
      lastAttemptAt: "2026-11-14T06:55:13.414Z",
      createdAt: "2026-11-14T06:55:13.410Z",
      updatedAt: "2026-11-14T06:55:13.549Z",
      evidence: {
        ...normalGetCard.evidence,
        latestRunId: "55e8e4d1-54a3-4f86-ba60-9d15f511adbf",
        sourceIssueId: "332ea2a8-da19-430f-8eec-01c0fb680701",
        sourceIdentifier: "RH944EEC-1",
        taskRetryRefusal: {
          ...normalGetCard.evidence.taskRetryRefusal,
          recordedAt: "2026-11-14T06:55:13.543Z",
          sourceRunId: "47f4b520-4171-4120-9218-902ac650205d",
          currentRunId: "55e8e4d1-54a3-4f86-ba60-9d15f511adbf",
          recoveryActionId: "8e8153f0-7868-4200-bfd4-aab67e0c2287",
        },
      },
    }, null, 2)).toBe(
      readFileSync(fixturePath, "utf8"),
    );
    const again = await click(f);
    const cards = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const visible = cards.filter(c => c.status === "active" || c.status === "escalated");
    console.info("JUDGE missing-current-card evidence", JSON.stringify({
      issueId: f.issueId, sourceRunId: f.failed.id, newerRunId: newer.id,
      nextAction: refreshed.body.activeRecoveryAction?.nextAction,
      visibleCards: visible.map(c => ({ id: c.id, sourceRunId: c.evidence.latestRunId, status: c.status })),
      issueStatus: refreshed.body.status, secondClickStatus: again.status,
      ordinaryRetryOffered: refreshed.body.interruption?.canRetry,
      interruptionState: refreshed.body.interruption?.state,
      runCount: (await runRows(f.issueId)).length,
      wakeDelta: (await wakeRows(f.agentId)).length - wakesBefore.length,
      commentDelta: (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).length - commentsBefore.length,
      stranded, active,
    }));
    // Preserve an exact normal-GET fixture for a separate DOM render, without the toast.
    if (process.env.JUDGE_EVIDENCE_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.JUDGE_EVIDENCE_DIR}/refused-card-from-get.json`, JSON.stringify(refreshed.body.activeRecoveryAction, null, 2));
    }
    expect(again.status).toBe(409);
    expect(refreshed.body.status).toBe("blocked");
    expect(await runRows(f.issueId)).toHaveLength(2);
    expect(await wakeRows(f.agentId)).toHaveLength(wakesBefore.length);
    expect(visible.some(c => c.evidence.latestRunId === newer.id),
      "The persisted next action promises a current card that refresh/sweeps must actually supply").toBe(true);
  });

  it("JUDGE: clicking the refreshed current-run card admits one Retry under the existing hold", async () => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    const runsBefore = await runRows(f.issueId);
    const wakesBefore = await wakeRows(f.agentId);
    await click(f).expect(409);
    const refreshed = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    const action = refreshed.body.activeRecoveryAction;
    expect(action.evidence.latestRunId).toBe(newer.id);
    expect(action.evidence.taskRetryRefusal.currentRunId).toBe(newer.id);
    const heldBefore = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.system.id)))[0]!;
    const budgetBefore = heldBefore.evidence.systemRecovery;

    await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: action.id, sourceRunId: action.evidence.latestRunId,
        outcome: "restored", sourceIssueStatus: "todo" }).expect(200);
    const retryWakeRows = (await wakeRows(f.agentId)).filter(wake => wake.idempotencyKey === `task-retry:${f.board.id}`);
    expect(retryWakeRows).toHaveLength(1);
    expect(retryWakeRows[0]).toMatchObject({ reason: "task_retry", status: "deferred_issue_execution", runId: null,
      requestedByActorType: "user", requestedByActorId: userId,
      payload: { taskRetry: { sourceRunId: newer.id } },
    });
    expect(await runRows(f.issueId)).toHaveLength(runsBefore.length);
    const heldAfter = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.system.id)))[0]!;
    expect(heldAfter.status).toBe(heldBefore.status);
    expect(heldAfter.evidence.systemRecovery).toEqual(budgetBefore);
    expect(heldAfter.evidence).toEqual(heldBefore.evidence);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      recoveryActionId: f.system.id, runId: f.failed.id, workspaceRepairRequired: true,
    });
    console.info("JUDGE refreshed-card Retry", { currentRunId: newer.id, retryRequestId: retryWakeRows[0].id,
      retryStatus: retryWakeRows[0].status, existingHoldId: heldAfter.id,
      admittedExecutionRuns: (await runRows(f.issueId)).length - runsBefore.length });
  });

  it("JUDGE: explicit completion removes the active recovery card for a normal reload", async () => {
    const f = await fixture();
    await addNewerFailedRun(f);
    await click(f).expect(409);
    const refused = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "blocked", sourceIssueStatus: "blocked" }).expect(200);
    const completed = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(completed.body.status).toBe("blocked");
    expect(completed.body.activeRecoveryAction).toBeNull();
    if (process.env.JUDGE_EVIDENCE_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.JUDGE_EVIDENCE_DIR}/refusal-completed-from-get.json`, JSON.stringify({
        before: { status: refused.body.status, activeRecoveryAction: refused.body.activeRecoveryAction },
        after: { status: completed.body.status, activeRecoveryAction: completed.body.activeRecoveryAction },
      }, null, 2));
    }
  });

  it("JUDGE: concurrent HTTP refusals share one unchanged refusal, no wake, no comment, no retry", async () => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    const wakesBefore = await wakeRows(f.agentId);
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const [actionBefore] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.board.id));
    const replies = await Promise.all([click(f), click(f), click(f)]);
    expect(replies.map(r => r.status)).toEqual([409, 409, 409]);
    const [actionAfter] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.board.id));
    const { evidence: evidenceBefore, nextAction: _nextBefore, updatedAt: _timeBefore, ...unchangedBefore } = actionBefore!;
    const { evidence: evidenceAfter, nextAction: _nextAfter, updatedAt: _timeAfter, ...unchangedAfter } = actionAfter!;
    const {
      latestRunId,
      latestRunStatus,
      latestRunErrorCode,
    } = evidenceAfter;
    expect(unchangedAfter).toEqual(unchangedBefore);
    // Refresh owns exactly these run-binding fields; every concurrent winner must bind them alike.
    expect({ latestRunId, latestRunStatus, latestRunErrorCode }).toEqual({
      latestRunId: newer.id,
      latestRunStatus: newer.status,
      latestRunErrorCode: "adapter_failed",
    });
    const first = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    const refusal = first.body.activeRecoveryAction.evidence.taskRetryRefusal;
    expect(refusal.recordedAt).toEqual(expect.any(String));
    await click(f).expect(409);
    const repeated = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(repeated.body.activeRecoveryAction.evidence.taskRetryRefusal).toEqual(refusal);
    expect(await runRows(f.issueId)).toHaveLength(2);
    expect(await wakeRows(f.agentId)).toHaveLength(wakesBefore.length);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(commentsBefore.length);
    console.info("JUDGE concurrent refusal", { statuses: replies.map(r => r.status), recordedAt: refusal.recordedAt,
      runCount: 2, addedWakes: 0, addedComments: 0 });
  });

  it.each(["rebound", "resolved", "different-owner", "different-kind"] as const)(
    "JUDGE: %s action winning the rollback gap rejects the delayed refusal without mutation", async (change) => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    const patch = change === "rebound" ? { evidence: { ...f.board.evidence, latestRunId: newer.id } }
      : change === "resolved" ? { status: "resolved", outcome: "restored" }
      : change === "different-owner" ? { ownerType: "system" }
      : { kind: "active_run_watchdog" };
    await db.update(issueRecoveryActions).set(patch).where(eq(issueRecoveryActions.id, f.board.id));
    const before = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.board.id));
    expect(await issueRecoveryActionService(db).recordTaskRetrySourceRefusal(refusalInput(f, newer.id))).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.board.id))).toEqual(before);
  });

  it("JUDGE: a delayed older receipt must not overwrite the refusal naming a newer current run", async () => {
    const f = await fixture();
    const { requestTaskRetry } = await import("../services/task-retry.js");
    const input = { db, companyId: f.companyId, issueId: f.issueId, actorId: userId,
      actorSource: "local_implicit", idempotencyKey: f.board.id, observedRunId: f.failed.id };
    const b = await addNewerFailedRun(f, 1000);
    const olderReceipt = await requestTaskRetry(input);
    expect(olderReceipt).toMatchObject({ accepted: false, stale: true, observedRunId: b.id });
    const c = await addNewerFailedRun(f, 2000);
    const newerReceipt = await requestTaskRetry(input);
    expect(newerReceipt).toMatchObject({ accepted: false, stale: true, observedRunId: c.id });
    const svc = issueRecoveryActionService(db);
    // Deterministic completion order of the two post-rollback record calls:
    // the newer-source receipt reaches the record transaction first.
    await svc.recordTaskRetrySourceRefusal(refusalInput(f, newerReceipt.observedRunId!));
    await svc.recordTaskRetrySourceRefusal(refusalInput(f, olderReceipt.observedRunId!));
    const current = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    const stored = current.body.activeRecoveryAction.evidence.taskRetryRefusal;
    console.info("JUDGE out-of-order receipt", { source: f.failed.id, olderReceiptRun: b.id,
      latestRun: c.id, displayedLatestRun: stored.currentRunId });
    expect(stored.currentRunId, "A delayed record must not move the displayed Latest run backwards").toBe(c.id);
  });
});
