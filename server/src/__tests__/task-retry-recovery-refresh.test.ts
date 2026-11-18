import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, authUsers, agentWakeupRequests, budgetPolicies, closeRegisteredClients, companies, companyMemberships, costEvents, createDb,
  environments, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issueRelations, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { costRoutes } from "../routes/costs.js";
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

  // Judge row (rf-5 r2b, workspace recovery): the stranded notice asks the
  // screen's Retry decision; compare it with the real route + dispatch.
  it("JUDGE workspace recovery (system already recovering): the notice offers no Retry, and the real Retry starts no run", async () => {
    const f = await fixture();
    const { decideStrandedRetryAdmission } = await import("../services/recovery/stranded-retry-admission.js");
    const { buildStrandedRecoveryEscalationNotice } = await import("../services/recovery/stranded-notice.js");
    console.info("JUDGE_PRE workspace", JSON.stringify(await getExecutionBlocker(db, f.companyId, f.issueId)));
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
      nextAction: "It continues once a board user records that the previous attempt stopped; there is no button for this on the task yet." });
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
    expect(cardRow.card).toBe("This attempt could not be finished. It continues once a board user records that the previous attempt stopped; there is no button for this on the task yet.");
    // The press the card no longer offers starts nothing (route 202, no executor marker).
    const row = await judge(f);
    expect(row).toMatchObject({ status: 202, runStarted: false });
  }, 60_000);

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
