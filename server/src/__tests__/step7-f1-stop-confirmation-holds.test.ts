import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  heartbeatRunEvents,
  environmentLeases,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { returnStoppedWaitingTaskToTodo } from "../services/heartbeat/stopped-waiting-task.ts";
import { executionProjectionsForRuns } from "../services/execution-projection.ts";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.ts";
import { agentRoutes } from "../routes/agents.ts";
import { issueRoutes } from "../routes/issues.ts";
import { errorHandler } from "../middleware/index.ts";
import { issueService } from "../services/issues.ts";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/index.ts";
import { HttpError } from "../errors.ts";
import { settleCancelledLegacyPreparation } from "../services/legacy-execution-recovery.ts";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.ts";

const gates = vi.hoisted(() => new Map<string, (() => void) | null>());
const preparation = vi.hoisted(() => ({
  beforeSession: undefined as (() => Promise<void>) | undefined,
  onExecution: undefined as ((context: AdapterExecutionContext) => Promise<void>) | undefined,
}));
vi.mock("../services/heartbeat/session-preparation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat/session-preparation.js")>();
  return { ...actual, prepareHeartbeatSession: async (...args: Parameters<typeof actual.prepareHeartbeatSession>) => {
    await preparation.beforeSession?.();
    return actual.prepareHeartbeatSession(...args);
  } };
});
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    const issueId = (context.context as Record<string, unknown> | undefined)?.issueId;
    // One-shot gate: hold only the first run of a gated task so the slot stays busy.
    if (typeof issueId === "string" && gates.get(issueId) === null) {
      await new Promise<void>((resolve) => gates.set(issueId, resolve));
    }
    await preparation.onExecution?.(context);
    return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "ok", provider: "test", model: "test" };
  }),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_STOP_QUEUED_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("step7-f1: upstream preparation Stop confirmation discharges our task holds", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const executedIssueIds = () =>
    mockAdapterExecute.mock.calls.map(([context]) => (context.context as Record<string, unknown>)?.issueId);

  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else tempDb = await startEmbeddedPostgresTestDatabase("paperclip-step7-f1-");
    db = createDb(external ?? tempDb!.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    preparation.beforeSession = undefined;
    preparation.onExecution = undefined;
    for (const release of gates.values()) release?.();
    gates.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
    await truncateTablesWithDeadlockRetry(db, `
      TRUNCATE TABLE "issue_comments", "issues", "heartbeat_run_events", "cost_events", "activity_log",
        "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "agents", "companies"
      RESTART IDENTITY CASCADE
    `, { attempts: 10, delayMs: () => 100 });
    await db.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture user", email: "responsible-user@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codie", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    return { companyId, agentId };
  }

  async function assignAndWake(companyId: string, agentId: string, title: string, status: "todo" | "in_progress" = "todo") {
    const [issue] = await db.insert(issues).values({ companyId, title, status, assigneeAgentId: agentId }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(run).toBeTruthy();
    return { issue, run: run! };
  }


  const STOP_PENDING_LINE = "Paperclip cannot confirm that the previous execution stopped.";

  // An action written by the release before step 7 (recordTaskStopPending,
  // standalone shape), inserted as rows so this probe runs on any tree.
  async function insertOlderStopHold(companyId: string, issueId: string, runId: string) {
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "escalated", ownerType: "board", cause: "execution_stop_pending",
      fingerprint: `execution_stop_pending:${runId}`, outcome: "escalated", attemptCount: 1, maxAttempts: 1, lastAttemptAt: new Date(),
      nextAction: `Stop pending (execution_stop_pending): ${STOP_PENDING_LINE} Recovery retained this task's claims and escalated the failed inspection to the board.`,
      evidence: { runId, stopPending: { schema: "paperclip.task-stop-pending.v1", code: "execution_stop_pending",
        owner: "recovery.stranded_assigned_issue", runIds: [runId], escalation: "board", automaticAttemptsExhausted: true,
        attemptCount: 1, maxAttempts: 1, checkedAt: new Date().toISOString(), standalone: true, previousNextAction: null } },
    }).returning();
    return hold;
  }
  const openActions = async (issueId: string) => (await db.select().from(issueRecoveryActions)
    .where(eq(issueRecoveryActions.sourceIssueId, issueId))).filter(a => a.status === "active" || a.status === "escalated");

  function routes(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false };
      next();
    });
    app.use("/api", agentRoutes(db, {}));
    const unusedStorage = async () => { throw new Error("Stop and comment routes must not access object storage"); };
    app.use("/api", issueRoutes(db, { provider: "local_disk", putFile: unusedStorage,
      getObject: unusedStorage, headObject: unusedStorage, deleteObject: unusedStorage }));
    app.use(errorHandler);
    return app;
  }

  /** Board Stop by the real route while preparation owns the run, then the
   * preparation unwinds. No later message, sweep or reconcile runs. The hook
   * runs while preparation owns the run, before the Stop. */
  async function stopDuringPreparation(beforeStop?: (issueId: string, runId: string, companyId: string) => Promise<void>) {
    const { companyId, agentId } = await seed();
    const app = routes(companyId);
    let entered = false;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    preparation.beforeSession = async () => { entered = true; await released; };
    try {
      const { issue, run } = await assignAndWake(companyId, agentId, "Accidental submission");
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      const [claimed] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(claimed.executionRunId).toBe(run.id);
      await beforeStop?.(issue.id, run.id, companyId);
      const stop = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
      expect(stop.status).toBe(200);
      expect(stop.body.resultJson.executionCancellation).toMatchObject({ state: "requested" });
      release();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const confirmed = await heartbeat.getRun(run.id);
      expect(confirmed?.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "preparation_settled" });
      return { companyId, agentId, issue, run, app };
    } finally { release(); }
  }

  // RFL F3: both held claims clear on the confirmed Stop itself.
  it("F3 releases both held claims right after the confirmed Stop, before any later message or sweep", async () => {
    let held: { checkoutRunId: string | null; executionRunId: string | null } | undefined;
    const { issue, run } = await stopDuringPreparation(async (issueId, runId) => {
      // Hold both claims, as checkout does for a run that took the task.
      await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
      [held] = await db.select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
        .from(issues).where(eq(issues.id, issueId));
    });
    expect(held).toEqual({ checkoutRunId: run.id, executionRunId: run.id });
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect({ checkoutRunId: task.checkoutRunId, executionRunId: task.executionRunId })
      .toEqual({ checkoutRunId: null, executionRunId: null });
    expect(executedIssueIds()).not.toContain(issue.id);
  }, 60_000);

  // RFL F1: an older release's execution_stop_pending action on this run.
  it("F1 discharges an existing Stop-pending action on the confirmed Stop by the real routes", async () => {
    let holdId = "";
    const { issue, run, companyId } = await stopDuringPreparation(async (issueId, runId, company) => {
      holdId = (await insertOlderStopHold(company, issueId, runId)).id;
    });
    expect(await openActions(issue.id)).toEqual([]);
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, holdId));
    expect(hold).toMatchObject({ status: "resolved", outcome: "restored" });
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(await taskInterruptionPresentation(db, task)).toMatchObject({ state: "resolved" });
    const confirmations = await db.select().from(activityLog).where(eq(activityLog.entityId, issue.id));
    expect(confirmations.filter(row => row.action === "issue.execution_stop_confirmed")).toHaveLength(1);
    expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)).toMatchObject({ phase: "completed", label: "Stopped" });
  }, 60_000);

  it("F1 discharges an existing Stop-pending action when upstream confirms the preparation Stop", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId, title: "Upgraded hold", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(), errorCode: "cancelled",
      contextSnapshot: { issueId: issue.id }, resultJson: {
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "responsible-user" }, reason: "Stop", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const hold = await insertOlderStopHold(companyId, issue.id, run.id);
    const settled = await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false });
    expect(settled?.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "preparation_settled" });
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(after).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(await openActions(issue.id)).toEqual([]);
    const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(await taskInterruptionPresentation(db, task)).toMatchObject({ state: "resolved" });
  });

  it("F1 keeps a Stop-pending action that also binds another run without Stop proof", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId, title: "Two owners", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(), errorCode: "cancelled",
      contextSnapshot: { issueId: issue.id }, resultJson: {
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "responsible-user" }, reason: "Stop", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const [other] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id, status: "running",
      runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
    const hold = await insertOlderStopHold(companyId, issue.id, run.id);
    const both = [run.id, other.id].sort();
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence,
      stopPending: { ...(hold.evidence.stopPending as Record<string, unknown>), runIds: both } } }).where(eq(issueRecoveryActions.id, hold.id));
    const settled = await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false });
    expect(settled?.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
    const [kept] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(kept).toMatchObject({ status: "escalated", evidence: { stopPending: { runIds: both } } });
    expect(kept.nextAction).toContain(STOP_PENDING_LINE);
  });
});
