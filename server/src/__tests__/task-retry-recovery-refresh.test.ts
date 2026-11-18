import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// F3: the F1 row renders the task screen's real ordinary notice (ui ExecutionBlockerNotice)
// from the real GET's interruption. The ui's "@/lib/*" aliases resolve to the ui's own files;
// only components and the API client its rendered branch does not reach are stubbed.
vi.mock("@/lib/router", async () => { const { createElement } = await import("../../../ui/node_modules/react/index.js");
  return { Link: ({ children, to }: { children?: unknown; to: string }) => createElement("a", { href: to }, children as never) }; });
vi.mock("@/lib/utils", async () => await import("../../../ui/src/lib/utils"));
vi.mock("@/lib/status-colors", async () => await import("../../../ui/src/lib/status-colors"));
vi.mock("../../../ui/src/api/issues", () => ({ issuesApi: {} }));
vi.mock("../../../ui/src/components/TaskProjectAccessNotice", () => ({ TaskProjectAccessNotice: () => null }));
vi.mock("../../../ui/src/components/WorkspaceExportRecovery", () => ({ PreviousServerStopConfirmation: () => null }));
import {
  agents, authUsers, agentWakeupRequests, budgetPolicies, closeRegisteredClients, companies, companyMemberships, costEvents, createDb,
  environments, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issueRelations, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { costRoutes } from "../routes/costs.js";
import { agentRoutes } from "../routes/agents.js";
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
import { decideStrandedRetryAdmission } from "../services/recovery/stranded-retry-admission.js";
import { buildStrandedRecoveryEscalationNotice } from "../services/recovery/stranded-notice.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import type { NativeRunIdentity, NativeSession, PrpEvent } from "@paperclipai/paperclip-runner";
import type { HeartbeatServiceOptions } from "../services/heartbeat.js";
import { registerLocalRuntimeApiServer, runtimeApiInternals } from "../runtime-api.js";
import { answeredPersonMessageSql } from "../services/person-message-answer.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";

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
    app.use("/api", costRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }
  // r2g: the two AGENT-facing texts (the wake-skip message of POST
  // /agents/:id/wakeup and GET /issues/:id/heartbeat-context's recovery action)
  // with the board's escalated stranded recovery (process_lost) active.
  async function agentSurfaces(f: { companyId: string; agentId: string; issueId: string; run: { id: string } }) {
    const { RETRY_FROM_SAVED_WORK_NEXT_ACTION } = await import("../services/recovery/stranded-notice.js");
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", cause: "process_lost", ownerType: "board", fingerprint: randomUUID(),
      status: "escalated", nextAction: RETRY_FROM_SAVED_WORK_NEXT_ACTION, evidence: { latestRunId: f.run.id } } as never);
    const app = appForBoard();
    const wake = await request(app).post(`/api/agents/${f.agentId}/wakeup`)
      .send({ source: "on_demand", reason: "r2g_agent_surface", payload: { issueId: f.issueId } });
    const context = (await request(app).get(`/api/issues/${f.issueId}/heartbeat-context`).expect(200)).body;
    const shown = (await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body;
    const surfaces = { canRetry: shown.interruption?.canRetry ?? null, wakeStatus: wake.status, wakeReason: wake.body.reason ?? null,
      wakeMessage: wake.body.message ?? null, contextRecovery: context.issue?.activeRecoveryAction?.nextAction ?? null,
      screenBlocker: shown.executionBlocker?.nextAction ?? null };
    console.info("JUDGE_AGENT_SURFACES", JSON.stringify(surfaces));
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, agentSurfaces: surfaces })}\n`);
    return surfaces;
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

  // G1: GET /issues/:id as the board sees it; the card's text vs the notice's one decision.
  async function g1Card(f: { companyId: string; issueId: string; app: ReturnType<typeof appForBoard>; failed: { id: string } }, when: string) {
    const { decideStrandedRetryAdmission } = await import("../services/recovery/stranded-retry-admission.js");
    const { strandedRetryRefusalCopy } = await import("../services/recovery/stranded-notice.js");
    const shown = (await request(f.app).get(`/api/issues/${f.issueId}`).expect(200)).body;
    const retry = await decideStrandedRetryAdmission(db, { companyId: f.companyId, issueId: f.issueId, runId: f.failed.id });
    const card = { when, blocker: shown.executionBlocker?.nextAction ?? null, canRetry: shown.interruption?.canRetry ?? null,
      decidedRefusal: retry.admits ? null : retry.refusal, decided: retry.admits ? "" : strandedRetryRefusalCopy(retry).nextAction,
      nextAction: shown.activeRecoveryAction?.nextAction ?? null, wakePolicy: shown.activeRecoveryAction?.wakePolicy ?? null };
    console.info("JUDGE_G1_CARD", JSON.stringify(card));
    if (process.env.G1_GET_FILE) appendFileSync(process.env.G1_GET_FILE, `${JSON.stringify({ when, activeRecoveryAction: shown.activeRecoveryAction, executionBlocker: shown.executionBlocker, interruption: shown.interruption })}\n`);
    expect(card.canRetry).toBe(false);
    expect(card.nextAction).not.toContain("Nothing restarts");
    expect(card.wakePolicy).toMatchObject({ type: "system_recovery" });
    return card;
  }

  // Judge row (rf-5 r2b, workspace recovery): the stranded notice asks the
  // screen's Retry decision; compare it with the real route + dispatch.
  it("JUDGE workspace recovery (system already recovering): the notice offers no Retry, and the real Retry starts no run", async () => {
    const f = await fixture();
    const { decideStrandedRetryAdmission } = await import("../services/recovery/stranded-retry-admission.js");
    const { buildStrandedRecoveryEscalationNotice } = await import("../services/recovery/stranded-notice.js");
    console.info("JUDGE_PRE workspace", JSON.stringify(await getExecutionBlocker(db, f.companyId, f.issueId)));
    // G1 (rf-5 2g §2): before any press the projection has canRetry=false and no
    // retryWait; the recovery card from the SAME GET as the blocker must say what the
    // notice says (Paperclip is recovering the saved work), not "Nothing restarts".
    const before = await g1Card(f, "before-press");
    expect(before.decidedRefusal).toBe("saved_work_recovering");
    expect(before.nextAction).toContain("Nothing is needed from you while Paperclip recovers the saved work");
    const retry = await decideStrandedRetryAdmission(db, { companyId: f.companyId, issueId: f.issueId, runId: f.failed.id });
    const notice = buildStrandedRecoveryEscalationNotice({ retry, recoveryActionId: f.board.id, recoveryOwner: null,
      sourceRun: { id: f.failed.id, status: f.failed.status } });
    const runsBefore = await runRows(f.issueId);
    const res = await request(f.app).post(`/api/issues/${f.issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: f.failed.id });
    let dispatchError: string | null = null;
    if (res.body.requestId) await heartbeatService(db).resumeTaskRetry(f.companyId, res.body.requestId)
      .catch((error: Error) => { dispatchError = error.message; });
    const runsAfter = await runRows(f.issueId);
    const row = { admits: retry.admits, refusal: retry.admits ? null : retry.refusal, pressRetry: /Press Retry/.test(JSON.stringify(notice)),
      status: res.status, runStarted: runsAfter.length > runsBefore.length, dispatchError, body: notice.body };
    const { taskInterruptionPresentation } = await import("../services/task-interruption-presentation.js");
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, ...row, nextAction: JSON.stringify(notice.metadata.sections[0]!.rows.find(r => "label" in r && r.label === "Next action") ?? null) })}\n`);
    console.info("JUDGE_ROW workspace", JSON.stringify(row), JSON.stringify(await taskInterruptionPresentation(db, await issueRow(f.issueId))),
      JSON.stringify(await getExecutionBlocker(db, f.companyId, f.issueId)));
    // The screen withholds Retry while the saved files are already being
    // recovered (no person action exists yet), so the notice names none.
    // r2d ST3: no row here proves the recovery then answers the message by
    // itself, so the notice no longer says "Nothing restarts it by itself"; it
    // says what the screen says (retryWait.message) and names no button.
    expect(row).toMatchObject({ admits: false, refusal: "saved_work_recovering", pressRetry: false, status: 202, runStarted: false });
    // r2f SD5: the system state wins; no person-action text while Paperclip holds it.
    expect(JSON.stringify(notice)).not.toContain("Recover saved files");
    expect(notice.body).toContain("Your message is saved.");
    expect(JSON.stringify(notice)).not.toContain("Nothing restarts it by itself");
    // G1 (rf-5 2g §2), after the press: the card follows the same decision as the notice.
    const after = await g1Card(f, "after-press");
    expect(after.nextAction).toContain(after.decided);
  });

  // Judge rows (rf-5 bar): the stranded notice says "Press Retry" IFF the
  // screen's one Retry decision (taskInterruptionPresentation.canRetry) admits,
  // compared with what the REAL POST /issues/:id/retry + dispatch then do.
  const markerDir = mkdtempSync(path.join(tmpdir(), "judge-executor-"));
  async function judgeFixture(opts: { paused?: boolean; blocker?: boolean; adapterType?: "process" | "paperclip_runner";
    heartbeat?: Record<string, unknown>; legacy?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stranded judge", issuePrefix: `SJ${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    // The Retry presser is the person the run acts for; they must be an active member for the executor to start.
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    const adapterType = opts.adapterType ?? "process";
    await db.insert(agents).values({ id: agentId, companyId, name: "Judge agent", role: "engineer", status: opts.paused ? "paused" : "idle",
      adapterType, adapterConfig: adapterType === "process" ? { command: "/bin/sh",
        args: ["-c", 'printf %s "$PAPERCLIP_RUN_ID" > "$JUDGE_MARKER_DIR/$PAPERCLIP_RUN_ID"'], env: { JUDGE_MARKER_DIR: markerDir } } : {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, ...opts.heartbeat } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stranded task", status: "todo", assigneeAgentId: agentId, priority: "medium" });
    if (opts.blocker) {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    }
    const at = new Date(Date.now() - 60_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "failed", errorCode: "adapter_failed",
      ...(adapterType === "paperclip_runner" || opts.legacy ? { runtimeMode: "legacy" } : {}),
      error: "Injected failure", invocationSource: "on_demand", contextSnapshot: { issueId }, createdAt: at, startedAt: at, finishedAt: at }).returning();
    return { companyId, agentId, issueId, run: run! };
  }

  async function judge(f: Awaited<ReturnType<typeof judgeFixture>>) {
    const retry = await decideStrandedRetryAdmission(db, { companyId: f.companyId, issueId: f.issueId, runId: f.run.id });
    const notice = buildStrandedRecoveryEscalationNotice({ retry, recoveryCause: "stranded_assigned_issue",
      recoveryActionId: null, recoveryOwner: null, sourceRun: { id: f.run.id, agentId: f.agentId, status: f.run.status, errorCode: f.run.errorCode } } as never);
    const screen = await taskInterruptionPresentation(db, await issueRow(f.issueId));
    // r2d ST5: process admission is open only for this press, so a successor can
    // really execute. "Run started" = a successor with startedAt AND the
    // executor's own marker file naming that run, never a row's existence.
    resetProcessRunAdmissionForTests();
    let res: Awaited<ReturnType<ReturnType<typeof request>["post"]>>;
    let dispatchError: string | null = null;
    let started: { id: string; status: string; startedAt: Date | null; error: string | null; errorCode: string | null }[] = [];
    try {
      res = await request(appForBoard()).post(`/api/issues/${f.issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: f.run.id });
      // The route nudges dispatch with `void resumeTaskRetry(...)`; await the same call to read its outcome.
      if (res.body.requestId) await heartbeatService(db).resumeTaskRetry(f.companyId, res.body.requestId)
        .catch((error: Error) => { dispatchError = error.message; });
      const successors = () => db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt,
        error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId), ne(heartbeatRuns.id, f.run.id)));
      for (let i = 0; i < 60; i++) {
        started = await successors();
        if (!started.some(run => ["queued", "running"].includes(run.status))) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      started = await successors();
    } finally {
      await heartbeatService(db).drainActiveRunExecutions();
      closeProcessRunAdmission();
    }
    const executed = started.filter(run => run.startedAt && existsSync(path.join(markerDir, run.id))
      && readFileSync(path.join(markerDir, run.id), "utf8") === run.id);
    const [saved] = res.body.requestId ? await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, res.body.requestId)) : [];
    const text = JSON.stringify(notice);
    const row = { admits: retry.admits, refusal: retry.admits ? null : retry.refusal, pressRetry: /Press Retry/.test(text),
      screenCanRetry: screen?.canRetry ?? null, screenUserAction: screen?.userAction ?? null, screenWait: screen?.retryWait?.reason ?? null,
      status: res.status, routeCanRetry: res.body.presentation?.canRetry ?? null, runStarted: executed.length > 0, dispatchError,
      successorRows: started.length, successorStartedAt: started.map(run => run.startedAt?.toISOString() ?? null),
      successorStatus: started.map(run => run.status), executorMarker: executed.map(run => run.id),
      successorError: started.map(run => `${run.errorCode ?? ""}:${run.error ?? ""}`.slice(0, 300)),
      savedWait: (saved?.payload as Record<string, any> | undefined)?.executionWait?.reason ?? saved?.status ?? null,
      body: notice.body, nextAction: JSON.stringify(notice.metadata.sections[0]!.rows.find(r => "label" in r && r.label === "Next action") ?? null) };
    console.info("JUDGE_ROW", JSON.stringify(row));
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, ...row })}\n`);
    return row;
  }

  it("JUDGE CONTROL: an idle agent's failed task: notice says Press Retry, route 202 and a run starts", async () => {
    const row = await judge(await judgeFixture());
    expect(row).toMatchObject({ admits: true, pressRetry: true, status: 202, runStarted: true, dispatchError: null });
  }, 60_000);

  it("JUDGE paused agent WITHOUT a blocker: no Press Retry, names resume; route 202 but no run starts", async () => {
    const row = await judge(await judgeFixture({ paused: true }));
    expect(row).toMatchObject({ admits: false, refusal: "agent_paused", pressRetry: false, status: 202, runStarted: false });
    expect(row.nextAction).toMatch(/resume/);
  }, 60_000);

  it("JUDGE paused agent WITH a blocker: no Press Retry; route 202 but no run starts", async () => {
    const row = await judge(await judgeFixture({ paused: true, blocker: true }));
    expect(row).toMatchObject({ admits: false, pressRetry: false, status: 202, runStarted: false });
  }, 60_000);

  // (u) rf-5 judge-r4-offered-true: a LEGACY attempt whose execution
  // provenance is unproved; its board hold says canRetry=true.
  it("JUDGE (u) unproven legacy execution: notice and screen agree with dispatch", async () => {
    const f = await judgeFixture({ adapterType: "paperclip_runner" });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", ownerType: "board",
      fingerprint: randomUUID(), status: "resolved", outcome: "blocked", nextAction: "Press Retry to continue.",
      evidence: { runId: f.run.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true });
    // r2e: the blocker the task API returns follows the screen (no Retry sentence).
    const shownU = (await request(appForBoard()).get(`/api/issues/${f.issueId}`).expect(200)).body;
    console.info("JUDGE_BLOCKER_SHOWN (u)", JSON.stringify(shownU.executionBlocker));
    expect(shownU.executionBlocker).toMatchObject({ canRetry: false });
    expect(shownU.executionBlocker.nextAction).not.toMatch(/\bRetry\b/);
    const row = await judge(f);
    expect(row).toMatchObject({ status: 202, runStarted: false, savedWait: "previous_execution_unverified" });
    expect(row).toMatchObject({ admits: false, refusal: "previous_execution_unverified", pressRetry: false, screenCanRetry: false });
    // r2d ST2: the screen has no Confirm button here (screenUserAction null), so the notice names none.
    expect(row).toMatchObject({ screenUserAction: null });
    expect(JSON.stringify(row)).not.toContain("Confirm it stopped");
  }, 60_000);

  // r2d ST5: an execution blocker that says canRetry=true on an idle process
  // agent. The notice may say Press Retry only if a run really executes.
  it("JUDGE execution blocker canRetry=true, idle process agent: Press Retry iff the executor runs", async () => {
    const f = await judgeFixture({ legacy: true });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", ownerType: "board",
      fingerprint: randomUUID(), status: "resolved", outcome: "blocked", nextAction: "Press Retry to continue.",
      evidence: { runId: f.run.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    console.info("JUDGE_BLOCKER canRetry-true", JSON.stringify(blocker));
    expect(blocker).toMatchObject({ canRetry: true });
    // r2e: the blocker the task API returns (GET /issues/:id executionBlocker)
    // says Retry only where the screen's projection offers it.
    const shown = (await request(appForBoard()).get(`/api/issues/${f.issueId}`).expect(200)).body;
    console.info("JUDGE_BLOCKER_SHOWN", JSON.stringify({ executionBlocker: shown.executionBlocker, interruption: shown.interruption }));
    expect(shown.interruption).toMatchObject({ canRetry: false });
    expect(shown.executionBlocker.nextAction).not.toMatch(/\bRetry\b/);
    expect(shown.executionBlocker).toMatchObject({ canRetry: false,
      nextAction: "To continue now, create a new task for Judge agent; your message here is saved. This task continues once a board user records that the previous attempt stopped; there is no button for that on the task yet." });
    // r2f SD2: the recovery card (IssueRecoveryActionCard renders activeRecoveryAction.nextAction)
    // follows the same projection: no Retry sentence while presentation.canRetry is false.
    console.info("JUDGE_CARD_SHOWN", JSON.stringify(shown.activeRecoveryAction));
    if (shown.activeRecoveryAction?.nextAction) expect(shown.activeRecoveryAction.nextAction).not.toMatch(/\bRetry\b/);
    const row = await judge(f);
    expect(row.status).toBe(202);
    expect(row.pressRetry).toBe(row.runStarted);
    expect(row.screenCanRetry).toBe(row.runStarted);
    expect(/\bRetry\b/.test(shown.executionBlocker.nextAction)).toBe(row.runStarted);
  }, 60_000);

  // r2f SD2: the same process-agent row with the board's escalated stranded
  // recovery (process_lost) active: IssueRecoveryActionCard renders
  // activeRecoveryAction.nextAction ("Next action"), so it must follow the
  // same Retry decision as the execution blocker and the notice.
  it("JUDGE SD2 recovery card on the process row: its next action follows presentation.canRetry", async () => {
    const f = await judgeFixture({ legacy: true });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", ownerType: "board",
      fingerprint: randomUUID(), status: "resolved", outcome: "blocked", nextAction: "Press Retry to continue.",
      evidence: { runId: f.run.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    const { RETRY_FROM_SAVED_WORK_NEXT_ACTION } = await import("../services/recovery/stranded-notice.js");
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", cause: "process_lost", ownerType: "board", fingerprint: randomUUID(),
      status: "escalated", nextAction: RETRY_FROM_SAVED_WORK_NEXT_ACTION, evidence: { latestRunId: f.run.id } } as never);
    const shown = (await request(appForBoard()).get(`/api/issues/${f.issueId}`).expect(200)).body;
    const cardRow = { canRetry: shown.interruption?.canRetry ?? null, blocker: shown.executionBlocker?.nextAction ?? null,
      card: shown.activeRecoveryAction?.nextAction ?? null, cardStatus: shown.activeRecoveryAction?.status ?? null };
    console.info("JUDGE_CARD_SHOWN SD2", JSON.stringify(cardRow));
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, ...cardRow })}\n`);
    expect(cardRow.cardStatus).toBe("escalated");
    expect(cardRow.canRetry).toBe(false);
    expect(cardRow.card).not.toMatch(/\bRetry\b/);
    expect(cardRow.card).toBe("This attempt could not be finished. To continue now, create a new task for Judge agent; your message here is saved. This task continues once a board user records that the previous attempt stopped; there is no button for that on the task yet.");
    // The press the card no longer offers starts nothing (route 202, no executor marker).
    const row = await judge(f);
    expect(row).toMatchObject({ status: 202, runStarted: false });
  }, 60_000);

  // r2g: the AGENT-facing texts follow the same Retry decision as the screen.
  const legacyHold = (f: { companyId: string; issueId: string; run: { id: string } }) => db.insert(issueRecoveryActions).values({
    companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
    ownerType: "board", fingerprint: randomUUID(), status: "resolved", outcome: "blocked", nextAction: "Press Retry to continue.",
    evidence: { runId: f.run.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
  for (const [label, opts] of [["process-blocker row", { legacy: true }], ["(u) legacy row", { adapterType: "paperclip_runner" }]] as const) {
    it(`JUDGE r2g ${label}: the wake-skip message and heartbeat-context carry no Retry sentence while canRetry is false`, async () => {
      const f = await judgeFixture(opts);
      await legacyHold(f);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true });
      const s = await agentSurfaces(f);
      expect(s.canRetry).toBe(false);
      expect(s).toMatchObject({ wakeStatus: 202, wakeReason: "execution_reconciliation_required" });
      expect(s.wakeMessage).not.toMatch(/\bRetry\b/);
      // It carries the projection's own action (the same text the screen's blocker says).
      expect(s.wakeMessage).toBe(s.screenBlocker);
      expect(s.wakeMessage).toContain("To continue now, create a new task for Judge agent");
      expect(s.contextRecovery).not.toMatch(/\bRetry\b/);
      expect(s.contextRecovery).toContain("To continue now, create a new task for Judge agent");
    }, 60_000);
  }

  it("JUDGE r2g CONTROL: an admissible state keeps the Retry text on both agent-facing surfaces", async () => {
    // Admissible: the same hold on a conversation adapter, whose continuation gate admits Retry.
    const f = await judgeFixture({ legacy: true });
    await db.update(agents).set({ adapterType: "claude_local", adapterConfig: {} }).where(eq(agents.id, f.agentId));
    await legacyHold(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ canRetry: true });
    const s = await agentSurfaces(f);
    expect(s.canRetry).toBe(true);
    expect(s).toMatchObject({ wakeStatus: 202, wakeReason: "execution_reconciliation_required" });
    expect(s.wakeMessage).toMatch(/\bRetry\b/);
    expect(s.contextRecovery).toMatch(/\bRetry\b/);
  }, 60_000);

  // r2g SD3 probe: the person creates a NEW task for the SAME agent through the
  // real create route (as the board does) and asks the same thing. Does that
  // task's run start (startedAt + the executor's marker), admitted by dispatch?
  async function newTaskForSameAgent(f: Awaited<ReturnType<typeof judgeFixture>>) {
    resetProcessRunAdmissionForTests();
    let created: Awaited<ReturnType<ReturnType<typeof request>["post"]>>;
    let runs: { id: string; issueId: string | null; status: string; startedAt: Date | null; error: string | null; errorCode: string | null }[] = [];
    try {
      created = await request(appForBoard()).post(`/api/companies/${f.companyId}/issues`)
        .send({ title: "Same question, new task", description: "Please continue the stranded work.", assigneeAgentId: f.agentId, status: "todo" });
      const newRuns = () => db.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt,
        error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, f.agentId), ne(heartbeatRuns.id, f.run.id)));
      for (let i = 0; i < 80; i++) {
        runs = await newRuns();
        if (runs.length && !runs.some(run => ["queued", "running"].includes(run.status))) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      runs = await newRuns();
    } finally {
      await heartbeatService(db).drainActiveRunExecutions();
      closeProcessRunAdmission();
    }
    const executed = runs.filter(run => run.startedAt && existsSync(path.join(markerDir, run.id))
      && readFileSync(path.join(markerDir, run.id), "utf8") === run.id);
    const wakes = (await wakeRows(f.agentId)).filter(row => (row.payload as Record<string, unknown> | null)?.issueId === created.body.id
      || row.reason === "issue_assigned");
    const probe = { createStatus: created.status, newIssueId: created.body.id ?? null, runs: runs.length, runIssue: runs.map(run => run.issueId),
      runStatus: runs.map(run => run.status), runStartedAt: runs.map(run => run.startedAt?.toISOString() ?? null),
      runError: runs.map(run => `${run.errorCode ?? ""}:${run.error ?? ""}`.slice(0, 300)), executorMarker: executed.map(run => run.id),
      runStarted: executed.length > 0, wakeStatus: wakes.map(row => `${row.reason}:${row.status}`) };
    console.info("JUDGE_SD3_NEW_TASK", JSON.stringify(probe));
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, sd3NewTask: probe })}\n`);
    return probe;
  }
  for (const [label, opts] of [["process-blocker row", { legacy: true }], ["(u) legacy row", { adapterType: "paperclip_runner" }]] as const) {
    it(`JUDGE r2g SD3 ${label}: a new task for the same agent, created on the real route`, async () => {
      const f = await judgeFixture(opts);
      await legacyHold(f);
      expect((await agentSurfaces(f)).canRetry).toBe(false);
      const probe = await newTaskForSameAgent(f);
      expect(probe).toMatchObject({ createStatus: 201 });
      // Dispatch admits the new task's run: it is claimed and started (startedAt),
      // not held by the old task's unverified source.
      expect(probe.runIssue).toContain(probe.newIssueId);
      expect(probe.runStartedAt.filter(Boolean).length).toBeGreaterThan(0);
      expect(probe.runError.join(" ")).not.toMatch(/previous_execution_unverified|execution_reconciliation/);
      // The process executor really runs it (its own marker). The paperclip_runner
      // executor has no local runtime API listener in this test server, so only
      // dispatch's admission (claimed + startedAt) is observable for the (u) row.
      if (opts.adapterType !== "paperclip_runner") expect(probe.runStarted).toBe(true);
    }, 60_000);
  }

  // G2 (rf-5 2g §3): the answering peer is rf-5's rf5-completing-peer.ts pattern
  // (provider-only boundary of heartbeat-provider-trace.test.ts; no admission,
  // stop-proof, selection, event persistence or publication mocks). It answers
  // the new message once and writes its own marker naming the run.
  function answeringPeer(markerFile: string): NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
    return execution => {
      let identity: NativeRunIdentity; let sourceInstanceId = ""; const turn = Promise.withResolvers<string>();
      const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      const contract = execution.completionContract.contract as { revision: string; criteria: Array<{ id: string }> };
      const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "G2 controlled provider answered the new message.",
        completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
          criteria: contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
        evidence: [], verification: [], artifacts: [], attentionRequests: [] };
      const session: NativeSession = { identity: () => identity, capabilities: async () => capabilities, attachRun: async input => { identity = input.identity; },
        startTurn: async input => { const turnId = randomUUID();
          await appendFile(markerFile, `${JSON.stringify({ at: new Date().toISOString(), runId: identity.runId, marker: "provider.startTurn", input })}\n`);
          turn.resolve(turnId); return { turnId }; },
        async *events() { const turnId = await turn.promise;
          const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({ schema: "paperclip.prp.event.v1",
            sourceKind: "runner", sourceInstanceId, sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq, runId: identity.runId,
            normalizedSessionId: identity.sessionId, turnId, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload });
          yield event(1, "turn.started", {});
          yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "G2 controlled provider answered the new message." });
          yield event(3, "run.result.proposed", result); yield event(4, "turn.completed", { status: "completed" }); },
        result: async () => result as never, snapshot: async () => ({ backendKind: "mock", sessionId: identity.sessionId, identity,
          providerSessionId: "g2-controlled-provider", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }), close: async () => {} } as NativeSession;
      return { descriptor: async () => { const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
          sourceInstanceId = run!.runnerInstanceId!;
          await appendFile(markerFile, `${JSON.stringify({ at: new Date().toISOString(), runId: run!.id, startedAt: run!.startedAt, marker: "executor.backend.descriptor" })}\n`);
          return { kind: "mock", name: "g2-controlled-provider-only", version: "1", capabilities, runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } } as never; },
        openSession: async (input: { identity: NativeRunIdentity }) => { identity = input.identity; return session; },
        recoverSession: async () => { throw new Error("G2 harness refuses to recover an old held provider session; only fresh OPEN is qualified."); } } as never;
    };
  }

  // G2: 'To continue now, create a new task for <agent>' (the U text) is proved to
  // ANSWER, not only to start: the legacy-unproved (paperclip_runner) row with the
  // native runtime API listener registered as production does (http/server.ts) and
  // an answering executor. The new task's message is answered (answeredPersonMessageSql)
  // with exactly one run-attributed reply.
  it("JUDGE G2 (u) legacy row: the new task for the same agent ANSWERS its message once", async () => {
    const f = await judgeFixture({ adapterType: "paperclip_runner" });
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", lifecycleMode: "cold" } }).where(eq(agents.id, f.agentId));
    await legacyHold(f);
    const held = await agentSurfaces(f);
    expect(held.canRetry).toBe(false);
    expect(held.screenBlocker).toContain("To continue now, create a new task for Judge agent");
    const markerFile = path.join(markerDir, `g2-${f.agentId}.jsonl`);
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableNativeRunner: true });
    const app = appForBoard();
    const listener = createServer(app);
    registerLocalRuntimeApiServer(listener);
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    let hb: ReturnType<typeof heartbeatService> | null = null;
    try {
      closeProcessRunAdmission();
      const created = await request(app).post(`/api/companies/${f.companyId}/issues`)
        .send({ title: "Same question, new task", description: "Please continue the stranded work.", assigneeAgentId: f.agentId, status: "todo" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const newIssueId = created.body.id as string;
      const sent = await request(app).post(`/api/issues/${newIssueId}/comments`).send({ body: "Answer this NEW TASK message once.", clientRequestId: randomUUID() });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      await new Promise(resolve => setTimeout(resolve, 150));
      resetProcessRunAdmissionForTests();
      hb = heartbeatService(db, { nativeSessionBackendFactory: answeringPeer(markerFile) });
      await hb.resumeQueuedRunsForAgent(f.companyId, f.agentId);
      for (let i = 0; i < 400; i++) { if (hb.getTaskDrainStatus().quiescent) break; await new Promise(resolve => setTimeout(resolve, 50)); }
      await hb.drainActiveRunExecutions();
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId)))
        .filter(run => run.issueId === newIssueId || run.nativeIssueId === newIssueId);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, newIssueId));
      const [answer] = await db.select({ answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) }).from(issueComments).where(eq(issueComments.id, sent.body.id));
      const markers = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { runId: string; marker: string }) : [];
      const replies = comments.filter(c => c.authorType === "agent" && c.createdByRunId && !c.deletedAt && runs.some(run => run.id === c.createdByRunId));
      const row = { newIssueId, messageId: sent.body.id, answered: answer?.answered ?? false, replyCount: replies.length,
        replies: replies.map(c => ({ id: c.id, runId: c.createdByRunId, body: c.body.slice(0, 200) })),
        runs: runs.map(run => ({ id: run.id, status: run.status, startedAt: run.startedAt?.toISOString() ?? null, error: `${run.errorCode ?? ""}:${run.error ?? ""}`.slice(0, 300) })),
        executorMarkers: markers.map(m => `${m.marker}:${m.runId}`) };
      console.info("JUDGE_G2_ANSWERED", JSON.stringify(row));
      if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, g2: row })}\n`);
      expect(row.runs.map(run => run.error).join(" ")).not.toMatch(/local_runtime_api_listener_unavailable|previous_execution_unverified/);
      expect(row.answered).toBe(true);
      expect(row.replyCount).toBe(1);
      expect(markers.some(m => m.marker === "provider.startTurn" && m.runId === replies[0]!.createdByRunId)).toBe(true);
    } finally {
      if (hb) await hb.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      closeProcessRunAdmission();
      await new Promise<void>(resolve => listener.close(() => resolve()));
      runtimeApiInternals.resetForTests();
      await settings.updateExperimental({ enableNativeRunner: false });
    }
  }, 90_000);

  // F1 (rf-5 onA): the foreign held source of #21914 (held-source-comment-retry-21914.test.ts
  // liveShape({ foreign: true }), the same production writers). Remedy (b): Retry on this task
  // binds nothing (two real presses, 202, no new run), so every surface of the SAME GET, before and
  // after a press, says the new-task step; and the new task for the same agent ANSWERS its message once.
  it("JUDGE F1 foreign held source: all five surfaces say the new task before and after a press; the new task ANSWERS once", async () => {
    // F3: the sixth surface, the ordinary interruption notice as the task screen renders it
    // (IssueDetail.tsx mounts ExecutionBlockerNotice with issue.interruption).
    const { createElement } = await import("../../../ui/node_modules/react/index.js");
    const { renderToStaticMarkup } = await import("../../../ui/node_modules/react-dom/server.node.js");
    const { JSDOM } = await import("jsdom");
    const { ExecutionBlockerNotice } = await import("../../../ui/src/components/ExecutionBlockerNotice");
    const ordinaryNoticeText = (presentation: unknown) => new JSDOM(renderToStaticMarkup(createElement(ExecutionBlockerNotice,
      { presentation: presentation as never, canRetry: true, onRetry: () => {} }))).window.document.body.textContent?.trim() || null;
    const { recordNativeLocalProcessStop } = await import("../services/native-local-process-stop.js");
    const { recordRequiredWorkspaceRestoreFailure } = await import("../services/legacy-execution-recovery.js");
    const { adoptSystemRecovery } = await import("../services/system-recovery.js");
    const { createPostgresRunDispatchAdapter } = await import("../modules/run-dispatch/adapters/postgres.js");
    const { NEW_TASK_CONTINUE_ACTION } = await import("../services/execution-blocker.js");
    const { executionWorkspaces, projects } = await import("@paperclipai/db");
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Foreign held source", defaultResponsibleUserId: userId,
      issuePrefix: `FH${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values([agentId, otherAgentId].map(id => ({ id, companyId, name: id === agentId ? "Parent" : "Former",
      role: "engineer", adapterType: "paperclip_runner", status: "idle",
      adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", lifecycleMode: "cold" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } })));
    const [project] = await db.insert(projects).values({ companyId, name: "Repository" }).returning();
    const root = mkdtempSync(path.join(tmpdir(), "f1-foreign-"));
    const primary = path.join(root, "primary"), worktree = path.join(root, "worktree"), branchName = `TASK-${issueId.slice(0, 8)}`;
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
    git("init", "--initial-branch=main", primary);
    git("-C", primary, "-c", "user.email=t@example.com", "-c", "user.name=F1", "commit", "--allow-empty", "-m", "base");
    git("-C", primary, "worktree", "add", "-b", branchName, worktree, "main");
    await db.insert(issues).values({ id: issueId, companyId, projectId: project!.id, title: "Foreign held task", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" } });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: branchName, status: "active", cwd: worktree,
      providerType: "git_worktree", providerRef: worktree, baseRef: "main", branchName }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, issueId));
    // The former assignee's native run, cancelled by the board's Done; its required saved-work hold.
    const cancelledAt = new Date(Date.now() - 20_000);
    const [native] = await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgentId, issueId, nativeIssueId: issueId,
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
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: native!.id, provider: "local",
      status: "expired", leasePolicy: "ephemeral", executionWorkspaceId: workspace!.id, releasedAt: cancelledAt, cleanupStatus: "success" }).returning();
    expect(await db.transaction(tx => recordNativeLocalProcessStop(tx as never, native!))).toBe(true);
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, native!.id));
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native!.id));
    await recordRequiredWorkspaceRestoreFailure(db, stopped!, { ...stopped!.resultJson, workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease!.id] } });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    await adoptSystemRecovery(db, { companyId, issueId, runId: native!.id, actionId: hold!.id });
    // The person's comment reopens it; the stale-run gate cancels its run before start.
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Person request on the held task." }).returning();
    const [wakeRow] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_reopened_via_comment", status: "queued", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId, commentId: comment!.id, mutation: "comment", reopenedFrom: "done" } }).returning();
    const [successor] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "automation",
      triggerDetail: "system", status: "queued", runtimeMode: "legacy", wakeupRequestId: wakeRow!.id, responsibleUserId: userId,
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId, commentId: comment!.id, wakeCommentId: comment!.id,
        wakeCommentIds: [comment!.id], source: "issue.comment.reopen", reopenedFrom: "done", wakeReason: "issue_reopened_via_comment" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: successor!.id }).where(eq(agentWakeupRequests.id, wakeRow!.id));
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId, runId: successor!.id,
      expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    await recoveryService(db, { enqueueWakeup: heartbeatService(db).wakeup }).escalateStrandedAssignedIssue({
      issue: await issueRow(issueId), previousStatus: "todo", latestRun: (await runRows(issueId)).find(run => run.id === successor!.id)! });

    const app = appForBoard();
    // The screen's run reads (GET /issues/:id/runs, the activity feed) are activityRoutes'.
    const { activityRoutes } = await import("../routes/activity.js");
    const readApp = appForBoard().use("/api", activityRoutes(db)).use(errorHandler);
    const SECOND_READING = /Recovering saved work|Restoring saved work|Paperclip recovers the saved work|Retry is waiting|execution checks|Press Retry|Retry is offered|Retry when ready/;
    // The five surfaces of one GET (+ the wake-skip and heartbeat-context read at the same moment).
    const surfaces = async () => {
      const shown = (await request(app).get(`/api/issues/${issueId}`).expect(200)).body;
      if (process.env.G1_GET_FILE) appendFileSync(process.env.G1_GET_FILE, `${JSON.stringify({ when: "f1-foreign",
        activeRecoveryAction: shown.activeRecoveryAction, executionBlocker: shown.executionBlocker, interruption: shown.interruption })}\n`);
      const context = (await request(app).get(`/api/issues/${issueId}/heartbeat-context`).expect(200)).body;
      // THE CLASS (rf-5 onA F3): every string the task screen, the inbox and an agent read for this
      // task, wherever it comes from, may not name a wait or a Retry offer: a second reading.
      const hits: Array<{ route: string; path: string; text: string }> = [];
      // A posted notice's "Run evidence" section is the run's own record (its Failure summary is what the
      // stale-run gate recorded, kept verbatim by held-source-comment-retry-21914.test.ts:216), not a next step.
      const runEvidence: Array<{ route: string; path: string; rows: unknown }> = [];
      const walk = (route: string, value: unknown, at: string): void => {
        if (value && typeof value === "object" && (value as { title?: unknown }).title === "Run evidence" && /\.metadata\.sections\[\d+\]$/.test(at)) {
          runEvidence.push({ route, path: at, rows: (value as { rows?: unknown }).rows }); return;
        }
        if (typeof value === "string") { if (/Retry|recover|saved work|waiting for|execution checks/i.test(value)) hits.push({ route, path: at, text: value }); }
        else if (Array.isArray(value)) value.forEach((item, i) => walk(route, item, `${at}[${i}]`));
        else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walk(route, item, `${at}.${key}`);
      };
      for (const route of [`/api/issues/${issueId}`, `/api/issues/${issueId}/heartbeat-context`, `/api/companies/${companyId}/issues`,
        `/api/issues/${issueId}/runs`, `/api/issues/${issueId}/runs?view=recent`, `/api/issues/${issueId}/live-runs`, `/api/issues/${issueId}/active-run`,
        `/api/issues/${issueId}/recovery-actions`, `/api/issues/${issueId}/comments`, `/api/issues/${issueId}/recent-comments`,
        `/api/issues/${issueId}/queued-comments`, `/api/issues/${issueId}/interactions`, `/api/companies/${companyId}/activity`,
        `/api/heartbeat-runs/${successor!.id}`, `/api/heartbeat-runs/${native!.id}`, `/api/issues/${issueId}/execution`,
        `/api/companies/${companyId}/heartbeat-runs`, `/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}`,
        `/api/companies/${companyId}/heartbeat-runs?agentId=${otherAgentId}`]) {
        const got = await request(readApp).get(route);
        expect(got.status, route).toBeLessThan(400);
        walk(route.replace(issueId, ":id").replace(companyId, ":companyId").replace(successor!.id, ":runId")
          .replace(native!.id, ":sourceRunId").replace(otherAgentId, ":sourceAgentId").replace(agentId, ":agentId"), got.body, "$");
      }
      if (process.env.SWEEP_FILE) appendFileSync(process.env.SWEEP_FILE, `${JSON.stringify({ hits, runEvidence })}\n`);
      const secondReadings = hits.filter(hit => SECOND_READING.test(hit.text));
      const wake = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", reason: "f1_foreign", payload: { issueId } });
      const notices = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"))))
        .sort((a, b) => +a.createdAt - +b.createdAt);
      return { canRetry: shown.interruption?.canRetry ?? null, notice: notices.at(-1)?.body ?? null,
        blocker: shown.executionBlocker?.nextAction ?? null, card: shown.activeRecoveryAction?.nextAction ?? null,
        wakeSkip: wake.body.message ?? null, heartbeatContext: context.issue?.activeRecoveryAction?.nextAction ?? null,
        ordinaryNotice: ordinaryNoticeText(shown.interruption), interruptionState: shown.interruption?.state ?? null,
        secondReadings, runs: (await runRows(issueId)).length };
    };
    const rows: Array<{ when: string; pressedNotice: string | null; pressedState: string | null } & Awaited<ReturnType<typeof surfaces>>> =
      [{ when: "before press", pressedNotice: null, pressedState: null, ...await surfaces() }];
    resetProcessRunAdmissionForTests();
    for (const press of [1, 2]) {
      const retried = await request(app).post(`/api/issues/${issueId}/retry`).send({ observedRunId: successor!.id, idempotencyKey: randomUUID() });
      expect(retried.status).toBe(202);
      // The screen caches the press's own presentation until it refetches (useTaskRetry.ts).
      const pressedNotice = ordinaryNoticeText(retried.body.presentation);
      const pressedState = retried.body.presentation?.state ?? null;
      // The press's own response (the screen's toast/not-started reason reads it) is a read too.
      const pressHits: Array<{ route: string; path: string; text: string }> = [];
      const walkPress = (value: unknown, at: string): void => {
        if (typeof value === "string") { if (SECOND_READING.test(value)) pressHits.push({ route: "POST /api/issues/:id/retry", path: at, text: value }); }
        else if (Array.isArray(value)) value.forEach((item, i) => walkPress(item, `${at}[${i}]`));
        else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) walkPress(item, `${at}.${key}`);
      };
      walkPress(retried.body, "$");
      expect(pressHits, `press ${press}`).toEqual([]);
      if (retried.body.requestId) await heartbeatService(db).resumeTaskRetry(companyId, retried.body.requestId);
      await heartbeatService(db).drainActiveRunExecutions();
      rows.push({ when: `after press ${press}`, pressedNotice, pressedState, ...await surfaces() });
    }
    closeProcessRunAdmission();
    console.info("JUDGE_F1_FOREIGN_SURFACES", JSON.stringify(rows));
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, f1Foreign: rows })}\n`);
    for (const row of rows) {
      expect(row.canRetry, row.when).toBe(false);
      expect([row.interruptionState, row.pressedState ?? "failed"], row.when).toEqual(["failed", "failed"]);
      expect(row.runs, row.when).toBe(rows[0]!.runs);
      // Six surfaces (+ after a press, the notice the screen renders from the press's own presentation).
      for (const surface of [row.notice, row.blocker, row.card, row.wakeSkip, row.heartbeatContext, row.ordinaryNotice,
        ...row.when === "before press" ? [] : [row.pressedNotice]]) {
        expect(surface, `${row.when}: ${JSON.stringify(row)}`).toContain(NEW_TASK_CONTINUE_ACTION);
        expect(surface, row.when).not.toMatch(/Recovering saved work|Paperclip recovers the saved work|Retry is waiting/);
      }
      // ...and no other read of the task says a wait or offers Retry (the class).
      expect(row.secondReadings, row.when).toEqual([]);
    }

    // The step shown WORKS: the new task for the same agent ANSWERS its message once.
    const markerFile = path.join(markerDir, `f1-${agentId}.jsonl`);
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableNativeRunner: true });
    const listener = createServer(app);
    registerLocalRuntimeApiServer(listener);
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    let hb: ReturnType<typeof heartbeatService> | null = null;
    try {
      const created = await request(app).post(`/api/companies/${companyId}/issues`)
        .send({ title: "Same question, new task", description: "Please continue the held work.", assigneeAgentId: agentId, status: "todo" });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const newIssueId = created.body.id as string;
      const sent = await request(app).post(`/api/issues/${newIssueId}/comments`).send({ body: "Answer this NEW TASK message once.", clientRequestId: randomUUID() });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      await new Promise(resolve => setTimeout(resolve, 150));
      resetProcessRunAdmissionForTests();
      hb = heartbeatService(db, { nativeSessionBackendFactory: answeringPeer(markerFile) });
      await hb.resumeQueuedRunsForAgent(companyId, agentId);
      for (let i = 0; i < 400; i++) { if (hb.getTaskDrainStatus().quiescent) break; await new Promise(resolve => setTimeout(resolve, 50)); }
      await hb.drainActiveRunExecutions();
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))
        .filter(run => run.issueId === newIssueId || run.nativeIssueId === newIssueId);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, newIssueId));
      const [answer] = await db.select({ answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) }).from(issueComments).where(eq(issueComments.id, sent.body.id));
      const markers = existsSync(markerFile) ? readFileSync(markerFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { runId: string; marker: string }) : [];
      const replies = comments.filter(c => c.authorType === "agent" && c.createdByRunId && !c.deletedAt && runs.some(run => run.id === c.createdByRunId));
      const row = { newIssueId, messageId: sent.body.id, answered: answer?.answered ?? false, replyCount: replies.length,
        replies: replies.map(c => ({ id: c.id, runId: c.createdByRunId, body: c.body.slice(0, 200) })),
        runs: runs.map(run => ({ id: run.id, status: run.status, startedAt: run.startedAt?.toISOString() ?? null, error: `${run.errorCode ?? ""}:${run.error ?? ""}`.slice(0, 300) })),
        executorMarkers: markers.map(m => `${m.marker}:${m.runId}`) };
      console.info("JUDGE_F1_FOREIGN_NEW_TASK_ANSWERED", JSON.stringify(row));
      if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: expect.getState().currentTestName, f1NewTask: row })}\n`);
      expect(row.answered).toBe(true);
      expect(row.replyCount).toBe(1);
      expect(markers.some(m => m.marker === "provider.startTurn" && m.runId === replies[0]!.createdByRunId)).toBe(true);
    } finally {
      if (hb) await hb.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      closeProcessRunAdmission();
      await new Promise<void>(resolve => listener.close(() => resolve()));
      runtimeApiInternals.resetForTests();
      await settings.updateExperimental({ enableNativeRunner: false });
    }
  }, 120_000);

  // r2d ST5: the agent is busy (its one concurrency slot is occupied by a
  // running run on another task). Record what Retry does at press time.
  it("JUDGE occupied slot (agent busy): Press Retry vs the executor at press time", async () => {
    const f = await judgeFixture({ heartbeat: { maxConcurrentRuns: 1 } });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Busy task", status: "in_progress",
      assigneeAgentId: f.agentId, priority: "medium" });
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: otherIssueId,
      status: "running", invocationSource: "on_demand", contextSnapshot: { issueId: otherIssueId },
      startedAt: new Date(), processPid: process.pid, processStartedAt: new Date() } as never).returning();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agentId));
    const row = await judge(f);
    console.info("JUDGE_BUSY", JSON.stringify({ busyRunId: busy!.id }));
    expect(row).toMatchObject({ status: 202, runStarted: false });
    // A successor may be queued for the slot; it has not started (startedAt null, no marker).
    expect(row.successorStartedAt.every(at => at === null)).toBe(true);
    // r2e (RFL 11:11Z): after the press the screen must SAY it waits. The
    // chat's run line (TaskChatLiveRunPill -> AgentQueueWait) reads the queued
    // run's execution projection; agent_at_capacity is keyed on the same
    // concurrency reader dispatch uses (parseHeartbeatPolicy maxConcurrentRuns
    // vs running runs, queued-run-line.ts agentQueueLinesForRuns).
    const { executionProjectionForRun } = await import("../services/execution-projection.js");
    const queued = (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId),
      ne(heartbeatRuns.id, f.run.id))));
    expect(queued).toHaveLength(1);
    const successorId = queued[0]!.id;
    const waitingLine = await executionProjectionForRun(db, f.companyId, successorId);
    console.info("JUDGE_BUSY_WAITING", JSON.stringify({ waitingLine }));
    expect(waitingLine).toMatchObject({ cause: "agent_at_capacity",
      agentQueue: { agentName: "Judge agent", maxConcurrentRuns: 1, runningCount: 1, position: 1, queuedCount: 1 } });
    expect(waitingLine!.nextAction).toBe("Judge agent is running 1 of 1 tasks at once. This task is 1 of 1 in line and starts automatically when a slot frees.");
    // The other task's run finishes; the slot frees and dispatch starts the line.
    resetProcessRunAdmissionForTests();
    let after: { id: string; status: string; startedAt: Date | null; wakeReason?: string | null }[] = [];
    try {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy!.id));
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, otherIssueId));
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
      // The slot frees outside a finalizer here, so the production queued-run sweep starts the line.
      await heartbeatService(db).resumeQueuedRuns();
      for (let i = 0; i < 60; i++) {
        after = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
          .from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId), ne(heartbeatRuns.id, f.run.id)));
        if (after.some(run => run.id === successorId && !!run.startedAt && !["queued", "running"].includes(run.status))) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      // Give any second run the same window to appear before counting.
      await new Promise(resolve => setTimeout(resolve, 2_000));
      after = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt,
        wakeReason: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'wakeReason'` })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.issueId, f.issueId), ne(heartbeatRuns.id, f.run.id)));
    } finally {
      await heartbeatService(db).drainActiveRunExecutions();
      closeProcessRunAdmission();
    }
    const executed = after.filter(run => run.startedAt && existsSync(path.join(markerDir, run.id))
      && readFileSync(path.join(markerDir, run.id), "utf8") === run.id);
    const freed = { successorId, after: after.map(run => ({ ...run, startedAt: run.startedAt?.toISOString() ?? null })),
      executorMarker: executed.map(run => run.id) };
    console.info("JUDGE_BUSY_FREED", JSON.stringify(freed));
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: `${expect.getState().currentTestName} (after the slot frees)`,
      waitingCause: waitingLine!.cause, waitingLine: waitingLine!.nextAction, ...freed })}\n`);
    // Started = startedAt AND the executor's own marker: the Retry's queued run
    // starts once the slot frees. Any later run is recorded with its wake
    // reason (the stub never answers, so the task stays todo; CONTROL shows the
    // same continuation, r2d finding 5); "no second run" is NOT claimed here.
    expect([...executed].sort((a, b) => a.startedAt!.getTime() - b.startedAt!.getTime())[0]?.id).toBe(successorId);
    expect(after.find(run => run.id === successorId)).toMatchObject({ status: "succeeded" });
  }, 60_000);

  // (b) the agent's budget hard stop is reached; the queued budget evaluation
  // has not yet paused the agent, but admission (budgets.getInvocationBlock) refuses.
  it("JUDGE (b) budget exhausted: notice and screen agree with dispatch", async () => {
    const f = await judgeFixture();
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: f.agentId,
      windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true });
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, heartbeatRunId: f.run.id,
      provider: "openai", model: "gpt", costCents: 500, occurredAt: new Date() });
    const row = await judge(f);
    expect(row).toMatchObject({ status: 202, runStarted: false });
    expect(row).toMatchObject({ admits: false, pressRetry: false, screenCanRetry: false });
    // r2f SD1: the posted notice is never refreshed, so its words must stay true
    // after the budget is raised through the real Costs route.
    expect(row.body).not.toMatch(/can't start|does not allow/);
    expect(row.nextAction).toContain("Raise the budget in Costs, then press Retry.");
    await request(appForBoard()).post(`/api/companies/${f.companyId}/budgets/policies`)
      .send({ scopeType: "agent", scopeId: f.agentId, amount: 100_000, hardStopEnabled: true }).expect(200);
    const after = await judge(f);
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: "SD1 budget: the notice posted before the raise", body: row.body, nextAction: row.nextAction, afterRaise: { screenCanRetry: after.screenCanRetry, runStarted: after.runStarted, executorMarker: after.executorMarker } })}\n`);
    expect(after).toMatchObject({ screenCanRetry: true, status: 202, runStarted: true });
  }, 90_000);

  // (c) the agent's daily run cap (enqueueWakeup getHeartbeatDailyCapBlock).
  it("JUDGE (c) daily run cap reached: notice and screen agree with dispatch", async () => {
    const f = await judgeFixture({ heartbeat: { maxDailyRuns: 1 } });
    await db.update(heartbeatRuns).set({ startedAt: new Date(), finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    const row = await judge(f);
    expect(row).toMatchObject({ status: 202, runStarted: false });
    expect(row).toMatchObject({ admits: false, pressRetry: false, screenCanRetry: false });
    // r2f SD1/SD4: words that stay true after the day rolls; no settings field is named.
    expect(row.body).not.toMatch(/can't start/);
    expect(row.nextAction).toContain("press Retry after 00:00 UTC");
    expect(row.nextAction).toContain("the settings screen has no field for it");
    // The rf-5 path: the notice is posted while the cap holds and nobody can
    // press Retry (the screen withholds it); then the day rolls: the counted
    // run moves to the previous UTC day.
    const g = await judgeFixture({ heartbeat: { maxDailyRuns: 1 } });
    await db.update(heartbeatRuns).set({ startedAt: new Date(), finishedAt: new Date() }).where(eq(heartbeatRuns.id, g.run.id));
    const posted = buildStrandedRecoveryEscalationNotice({ retry: await decideStrandedRetryAdmission(db, { companyId: g.companyId, issueId: g.issueId, runId: g.run.id }),
      recoveryCause: "stranded_assigned_issue", recoveryActionId: null, recoveryOwner: null,
      sourceRun: { id: g.run.id, agentId: g.agentId, status: g.run.status, errorCode: g.run.errorCode } } as never);
    expect((await taskInterruptionPresentation(db, await issueRow(g.issueId)))?.canRetry).toBe(false);
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await db.update(heartbeatRuns).set({ createdAt: yesterday, startedAt: yesterday, finishedAt: yesterday }).where(eq(heartbeatRuns.issueId, g.issueId));
    const after = await judge(g);
    const postedNext = JSON.stringify(posted.metadata.sections[0]!.rows.find(r => "label" in r && r.label === "Next action") ?? null);
    if (process.env.JUDGE_ROWS_FILE) appendFileSync(process.env.JUDGE_ROWS_FILE, `${JSON.stringify({ test: "SD1 daily: the notice posted before the day rolled", body: posted.body, nextAction: postedNext, afterRoll: { screenCanRetry: after.screenCanRetry, runStarted: after.runStarted, executorMarker: after.executorMarker, successorStartedAt: after.successorStartedAt } })}\n`);
    expect(posted.body).toBe(row.body);
    expect(postedNext).toBe(row.nextAction);
    expect(after).toMatchObject({ screenCanRetry: true, status: 202, runStarted: true });
  }, 90_000);

  // r2f SD4: a zero daily limit never resets, so no reset sentence.
  it("JUDGE (c0) daily run cap 0: no reset sentence, no settings field named", async () => {
    const f = await judgeFixture({ heartbeat: { maxDailyRuns: 0 } });
    const screen = await taskInterruptionPresentation(db, await issueRow(f.issueId));
    console.info("JUDGE_SCREEN c0", JSON.stringify(screen?.retryWait));
    expect(screen?.retryWait?.message).toContain("The limit is 0, so it does not reset.");
    const row = await judge(f);
    expect(row).toMatchObject({ admits: false, refusal: "daily_limit", pressRetry: false, screenCanRetry: false, status: 202, runStarted: false });
    expect(row.nextAction).not.toContain("00:00 UTC");
    expect(row.nextAction).toContain("is set to 0, so it never resets");
    expect(screen?.retryWait?.message).not.toContain("00:00 UTC");
  }, 60_000);

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
