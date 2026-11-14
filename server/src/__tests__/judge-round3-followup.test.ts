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
describe("Independent round-3 followup probes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let stopOwnedPostgres: (() => void) | undefined;
  const userId = `resolved-hold-board-${randomUUID()}`;
  const support = getEmbeddedPostgresTestSupport();
  beforeAll(async () => {
    expect((await support).supported, "embedded Postgres required; no expected skip").toBe(true);
    expect(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL).toBeUndefined();
    temporary = await startEmbeddedPostgresTestDatabase("judge-tryagain3-followup-");
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

  async function addNewerFailedRun(f: Awaited<ReturnType<typeof fixture>>) {
    const at = new Date(Date.now() + 1000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
      contextSnapshot: { issueId: f.issueId }, createdAt: at, finishedAt: at, errorCode: "adapter_failed" }).returning();
    return run!;
  }
  const click = (f: Awaited<ReturnType<typeof fixture>>) => request(f.app)
    .post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
    .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" });

  it("JUDGE: the exact advertised refresh path must offer a current recovery card", async () => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    await click(f).expect(409);
    const first = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(first.body.activeRecoveryAction.evidence.taskRetryRefusal.currentRunId).toBe(newer.id);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${process.env.JUDGE_EVIDENCE_DIR}/refused-card-from-get.json`, JSON.stringify(first.body.activeRecoveryAction, null, 2));
    await click(f).expect(409);
    const refreshed = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(refreshed.body.activeRecoveryAction.evidence.taskRetryRefusal).toEqual(first.body.activeRecoveryAction.evidence.taskRetryRefusal);
    expect(refreshed.body.status).toBe("blocked");
    expect(await runRows(f.issueId)).toHaveLength(2);
    const cards = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const visible = cards.filter(c => c.status === "active" || c.status === "escalated");
    console.info("JUDGE refresh-only", { issueStatus: refreshed.body.status,
      advertised: refreshed.body.activeRecoveryAction.nextAction,
      visibleCards: visible.map(c => ({ id: c.id, sourceRunId: c.evidence.latestRunId })),
      promisedCurrentRun: newer.id, ordinaryRetryOffered: refreshed.body.interruption?.canRetry,
      repeatedClick: 409, totalRuns: 2 });
    expect(visible.some(c => c.evidence.latestRunId === newer.id), "Refresh must actually supply the card promised by the next action").toBe(true);
  });

  it("JUDGE: normal recovery sweeps must provide that current card even after the source wake is terminal", async () => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    const beforeWake = await wakeRows(f.agentId);
    // The borrowed fixture manually failed its heartbeat but left its original
    // wake live. Seed the matching terminal wake receipt (not stop/lease proof),
    // so sourceHasNewPathOutsideRecoveryAction cannot treat that setup residue
    // as a new source execution path. The original exploratory result is retained.
    await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), error: "adapter_failed" })
      .where(eq(agentWakeupRequests.runId, f.failed.id));
    expect((await wakeRows(f.agentId)).filter(w => w.runId === f.failed.id).every(w => w.status === "failed")).toBe(true);
    await click(f).expect(409);
    const svc = recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup });
    const stranded = await svc.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId });
    const active = await svc.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const refreshed = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    const repeated = await click(f);
    const cards = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const visible = cards.filter(c => c.status === "active" || c.status === "escalated");
    console.info("JUDGE settled-wake sweeps", { issueStatus: refreshed.body.status,
      priorWakeStates: beforeWake.map(w => ({ status: w.status, runId: w.runId })),
      afterWakeStates: (await wakeRows(f.agentId)).map(w => ({ status: w.status, runId: w.runId })),
      visibleCards: visible.map(c => ({ id: c.id, sourceRunId: c.evidence.latestRunId, status: c.status })),
      promisedCurrentRun: newer.id, ordinaryRetryOffered: refreshed.body.interruption?.canRetry,
      repeatedClick: repeated.status, totalRuns: (await runRows(f.issueId)).length, stranded, active });
    expect(refreshed.body.status).toBe("blocked");
    expect(await runRows(f.issueId)).toHaveLength(2);
    expect(await wakeRows(f.agentId)).toHaveLength(beforeWake.length);
    expect(visible.some(c => c.evidence.latestRunId === newer.id), "The recovery owners must not leave a false instruction to use a nonexistent current card").toBe(true);
  });

  it("JUDGE: a supported explicit blocked disposition resolves the action and normal GET no longer exposes it", async () => {
    const f = await fixture();
    await addNewerFailedRun(f);
    await click(f).expect(409);
    const refused = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    const resolution = await request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: f.board.id, outcome: "blocked", sourceIssueStatus: "blocked", resolutionNote: "Explicitly record a separate board disposition." });
    console.info("JUDGE explicit blocked disposition", { status: resolution.status, error: resolution.body.error,
      recoveryStatus: resolution.body.recoveryAction?.status });
    expect(resolution.status).toBe(200);
    expect(resolution.body.recoveryAction.status).toBe("resolved");
    const resolved = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(resolved.body.activeRecoveryAction).toBeNull();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${process.env.JUDGE_EVIDENCE_DIR}/refusal-resolved-from-get.json`, JSON.stringify({
      before: { status: refused.body.status, activeRecoveryAction: refused.body.activeRecoveryAction },
      after: { status: resolved.body.status, activeRecoveryAction: resolved.body.activeRecoveryAction },
    }, null, 2));
  });
});
