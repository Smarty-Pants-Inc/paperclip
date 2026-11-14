import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, authUsers, agentWakeupRequests, closeRegisteredClients, companies, createDb,
  environments, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
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
import { startTaskDrain, stopTaskDrain } from "../services/task-admission.js";

// Keep: RFL round-4 findings F1/F5. Real HTTP, durable Task Retry and the real
// native workspace hold writer. No provider call or executor is started.
describe("Task Retry recovery-card refresh", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let stopOwnedPostgres: (() => void) | undefined;
  const userId = `recovery-refresh-board-${randomUUID()}`;
  const support = getEmbeddedPostgresTestSupport();

  beforeAll(async () => {
    expect((await support).supported, "embedded Postgres required; no expected skip").toBe(true);
    expect(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL).toBeUndefined();
    temporary = await startEmbeddedPostgresTestDatabase("task-retry-recovery-refresh-");
    db = createDb(temporary.connectionString);
    const port = new URL(temporary.connectionString).port;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (!args[0]?.endsWith("/postgres") || args[args.indexOf("-p") + 1] !== port) continue;
        const dataDir = args[args.indexOf("-D") + 1]!;
        stopOwnedPostgres = () => { execFileSync(args[0]!.replace(/postgres$/, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]); };
        console.info("Owned recovery-refresh Postgres", { pid, dataDir, port });
        break;
      } catch { /* unrelated or already-exited process */ }
    }
    expect(stopOwnedPostgres, "must own bounded non-deleting cluster stop").toBeDefined();
    closeProcessRunAdmission();
    await db.insert(authUsers).values({ id: userId, name: "Recovery refresh board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90_000);

  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    if (temporary) await closeRegisteredClients(temporary.connectionString);
    stopOwnedPostgres?.();
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
  const taskRetryRows = async (agentId: string, issueId: string) => (await wakeRows(agentId)).filter(row =>
    row.reason === "task_retry" && (row.payload as Record<string, unknown> | null)?.issueId === issueId);

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery refresh twin", issuePrefix: `RR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
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
    const [environment] = await db.insert(environments).values({ name: `Recovery refresh ${admitted.id}`, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: admitted.id,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
    }).returning();
    const [failed] = await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: admitted.id,
      leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId, remoteCwd: "/work", resourceDisposition: "destroy",
    } } }).where(eq(heartbeatRuns.id, admitted.id)).returning();
    // The real preservation writer creates A's no-replay hold; tests retain it.
    const retained = await preserveNativeFailedWorkspace(db, failed!);
    expect(retained?.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease!.id] } });
    const [system] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    await db.update(issueRecoveryActions).set({ ownerType: "system" }).where(eq(issueRecoveryActions.id, system!.id));
    await recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup })
      .escalateStrandedAssignedIssue({ issue: await issueRow(issueId), previousStatus: "in_progress", latestRun: retained! });
    const board = await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId);
    expect(board).toMatchObject({ kind: "stranded_assigned_issue", status: "active", ownerType: "board" });
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: system!.id, runId: failed!.id, workspaceRepairRequired: true });
    return { companyId, agentId, issueId, app, board: board!, system: system!, failed: retained! };
  }

  async function addNewerFailedRun(f: Awaited<ReturnType<typeof fixture>>) {
    const at = new Date(Date.now() + 1000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, retryOfRunId: f.failed.id,
      runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
      contextSnapshot: { issueId: f.issueId }, createdAt: at, finishedAt: at, errorCode: "adapter_failed" }).returning();
    return run!;
  }
  const clickOldCard = (f: Awaited<ReturnType<typeof fixture>>) => request(f.app)
    .post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
    .send({ actionId: f.board.id, outcome: "restored", sourceIssueStatus: "todo" });

  it("refreshes current B, observes status without changing it, and admits one source-bound B Retry", async () => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    const beforeStatus = await issueRow(f.issueId);
    const [holdBefore] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.system.id));
    await db.update(issueRecoveryActions).set({ evidence: { ...f.board.evidence, latestIssueStatus: "blocked" } })
      .where(eq(issueRecoveryActions.id, f.board.id));
    const wakesBefore = await wakeRows(f.agentId);

    await clickOldCard(f).expect(409);
    const refreshed = await request(f.app).get(`/api/issues/${f.issueId}`).expect(200);
    const afterRefusal = await issueRow(f.issueId);
    expect(afterRefusal.status).toBe(beforeStatus.status);
    expect(refreshed.body.activeRecoveryAction.evidence).toMatchObject({ latestRunId: newer.id, latestIssueStatus: afterRefusal.status });
    expect(await taskRetryRows(f.agentId, f.issueId)).toHaveLength(0);
    expect(await wakeRows(f.agentId)).toHaveLength(wakesBefore.length);
    expect(await runRows(f.issueId)).toHaveLength(2);

    // The same Try again action enters canonical Task Retry for B. A is still
    // unsafe, so the one durable request waits and no executor can start.
    const currentCardRetry = () => request(f.app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`)
      .send({ actionId: refreshed.body.activeRecoveryAction.id, sourceRunId: newer.id,
        outcome: "restored", sourceIssueStatus: "todo" });
    const drain = startTaskDrain({ ttlMs: 30_000 });
    try {
      await currentCardRetry().expect(200);
      const [intent] = await taskRetryRows(f.agentId, f.issueId);
      expect(intent).toBeDefined();
      expect(intent!.status).toBe("deferred_issue_execution");
      expect((intent!.payload as any).taskRetry.sourceRunId).toBe(newer.id);
      await currentCardRetry().expect(200);
      const intents = await taskRetryRows(f.agentId, f.issueId);
      expect(intents).toHaveLength(1);
      expect(intents[0]!.id).toBe(intent!.id);
      expect(await runRows(f.issueId)).toHaveLength(2);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: f.failed.id, workspaceRepairRequired: true });
      const [holdAfter] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.system.id));
      expect(holdAfter).toMatchObject({ id: holdBefore!.id, ownerType: holdBefore!.ownerType,
        status: holdBefore!.status, cause: holdBefore!.cause,
        evidence: { runId: f.failed.id, automaticRecovery: { replay: "blocked" } },
      });
      expect((holdAfter!.evidence.systemRecovery as Record<string, unknown> | undefined)?.attempts ?? 0).toBe(0);
      expect((holdAfter!.evidence.systemRecovery as Record<string, unknown> | undefined)?.retriesUsed ?? 0).toBe(0);
    } finally {
      stopTaskDrain();
      expect(drain.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("quota-failure refresh creates no scheduled run, quota wake, comment, or hold mutation", async () => {
    const f = await fixture();
    const newer = await addNewerFailedRun(f);
    await db.update(heartbeatRuns).set({ errorCode: "provider_quota", error: "Usage limit reached; try later" })
      .where(eq(heartbeatRuns.id, newer.id));
    const runsBefore = await runRows(f.issueId);
    const wakesBefore = await wakeRows(f.agentId);
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const [holdBefore] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.system.id));

    await clickOldCard(f).expect(409);
    const runsAfter = await runRows(f.issueId);
    const wakesAfter = await wakeRows(f.agentId);
    const commentsAfter = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const [holdAfter] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.system.id));
    expect(runsAfter).toHaveLength(runsBefore.length);
    expect(wakesAfter).toHaveLength(wakesBefore.length);
    expect(commentsAfter).toHaveLength(commentsBefore.length);
    expect(holdAfter).toEqual(holdBefore);
    expect((await request(f.app).get(`/api/issues/${f.issueId}`).expect(200)).body.activeRecoveryAction.evidence.latestRunId).toBe(newer.id);
  });

  it("refreshing a refusal does not republish an escalation outside the latest 50 system comments", async () => {
    const f = await fixture();
    await addNewerFailedRun(f);
    await db.insert(issueComments).values(Array.from({ length: 51 }, (_, index) => ({
      companyId: f.companyId, issueId: f.issueId, authorType: "system" as const,
      body: `Unrelated retained status notice ${index}`, createdAt: new Date(Date.now() + index + 1),
    })));
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const wakesBefore = await wakeRows(f.agentId);
    const runsBefore = await runRows(f.issueId);

    await clickOldCard(f).expect(409);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(commentsBefore.length);
    expect(await wakeRows(f.agentId)).toHaveLength(wakesBefore.length);
    expect(await runRows(f.issueId)).toHaveLength(runsBefore.length);
  });
});
