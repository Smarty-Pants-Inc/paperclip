import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, inArray, sql } from "drizzle-orm";
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
  nativeRunFinalizations,
  environmentLeases,
  environments,
  issueRecoveryActions,
  issueComments,
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
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.ts";
import * as deferredNotifications from "../services/deferred-execution-notifications.js";
import * as nativeSession from "../services/native-runtime/native-session-executor.js";
import { environmentService } from "../services/environments.js";
import { settleProviderReturnedStopInput } from "../services/person-stop-before-turn.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import type { PrpEvent } from "../vendor/paperclip-runner/index.js";

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

describeEmbeddedPostgres("Stop on a task whose run is still waiting in line", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const executedIssueIds = () =>
    mockAdapterExecute.mock.calls.map(([context]) => (context.context as Record<string, unknown>)?.issueId);

  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stop-queued-task-");
    db = createDb(external ?? tempDb!.connectionString);
    // Observe the actual terminal UPDATE, not merely the row after the route.
    await db.$client.unsafe(`
      create table test_stop_receipt_transitions (run_id uuid, receipt jsonb, wakes jsonb);
      create function test_stop_receipt_transition() returns trigger language plpgsql as $$
      begin
        insert into test_stop_receipt_transitions values (new.id, new.result_json->'personStop',
          (select coalesce(jsonb_agg(w.payload), '[]'::jsonb) from agent_wakeup_requests w where w.run_id = new.id));
        return new;
      end $$;
      create trigger test_stop_receipt_transition after update of status on heartbeat_runs
        for each row when (old.status = 'running' and new.status = 'cancelled') execute function test_stop_receipt_transition();
    `);
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
    if (db) await db.$client.unsafe(`drop trigger if exists test_stop_receipt_transition on heartbeat_runs;
      drop function if exists test_stop_receipt_transition(); drop table if exists test_stop_receipt_transitions;`);
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

  // Gate 7: the setup-failure/Stop race must not lose input that no provider saw.
  it.each(["legacy", "native"] as const)("keeps Stop receipts when a stale %s failure writer wins after Stop", async runtimeMode => {
    const { companyId, agentId } = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode,
      executionStage: "preparing", resultJson: { setupDetail: "keep" } }).returning();
    const returned = [randomUUID()], requestedAt = new Date().toISOString();
    const receipt = { personStop: { requestedAt, userId: "responsible-user", returned },
      startupCancellation: { requestedAt, beforeNativeSelection: true } };
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const stop = db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      locked(); await released;
      await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify(receipt)}::jsonb` })
        .where(eq(heartbeatRuns.id, run.id));
    });
    await acquired;
    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
    const failure = lifecycle.setRunStatusIfRunning(run.id, "failed", {
      errorCode: "setup_failed", error: "40P01 deadlock", finishedAt: new Date(),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, personStop: { returned: [] } },
    }, undefined, { setupFailure: true });
    try {
      // The actual writer must have read its stale snapshot and reached the held run row.
      await vi.waitFor(async () => {
        const rows = await db.$client<{ count: string }[]>`select count(*)::text as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%heartbeat_runs%'`;
        expect(Number(rows[0].count)).toBeGreaterThan(0);
      }, { timeout: 10_000 });
    } finally { release(); await stop; }
    const result = await failure;
    expect(result.updated).toBe(true);
    expect(result.run).toMatchObject({ status: "failed", resultJson: { ...receipt, setupDetail: "keep",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    console.info("STOP_RECEIPT_PROOF", JSON.stringify({ case: "stop_then_failure", runtimeMode, runId: run.id,
      status: result.run?.status, personStop: result.run?.resultJson?.personStop, startupCancellation: result.run?.resultJson?.startupCancellation }));
  }, 30_000);

  it.each([
    { identity: "plural", status: "failed", stage: "preparing", runtimeMode: "legacy", provider: "pi_rpc" },
    { identity: "singular", status: "failed", stage: "preparing", runtimeMode: "legacy", provider: "pi_rpc" },
    { identity: "plural", status: "running", stage: "preparing", runtimeMode: "legacy", provider: "pi_rpc" },
    // Gate 7 run 18911ef5: claim happened, but staging/native selection did not.
    { identity: "plural", status: "running", stage: null, runtimeMode: "legacy", provider: "pi_rpc" },
    { identity: "singular", status: "running", stage: "staging", runtimeMode: "legacy", provider: "codex" },
    { identity: "plural", status: "running", stage: "staging", runtimeMode: "native", provider: "pi_rpc" },
    { identity: "process_requested", status: "running", stage: "staging", runtimeMode: "native", provider: "pi_rpc" },
    { identity: "plural", status: "cancelled", stage: "staging", runtimeMode: "legacy", provider: "pi_rpc" },
  ])("returns $identity input on $status $runtimeMode/$provider $stage setup when the person pressed Stop, without replay", async ({ identity, status, stage, runtimeMode, provider }) => {
    const { companyId, agentId } = await seed();
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider } }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ companyId, title: "Setup failed before Stop", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user" }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorType: "user",
      authorUserId: "responsible-user", body: "M1 never received" }).returning();
    const context = { issueId: issue.id, ...(identity === "plural" ? { wakeCommentIds: [message.id] } : { wakeCommentId: message.id }) };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "failed", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user", payload: { issueId: issue.id, commentId: message.id,
        _paperclipWakeContext: context } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode,
      executionStage: stage, nextEventSeq: stage === "staging" ? 3 : 1,
      startedAt: status === "running" ? new Date() : null, wakeupRequestId: wake.id, contextSnapshot: context,
      ...(runtimeMode === "native" ? { nativeIssueId: issue.id, driverKind: "pi_rpc" } : {}),
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        ...(runtimeMode === "native" ? { nativeExecutionInput: { provider: { kind: provider } } } : {}) },
      ...(status === "failed" ? { errorCode: "setup_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } } : {}) }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    if (runtimeMode === "native") await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId, issueId: issue.id, phase: "observed" });
    if (stage === "staging") await db.insert(heartbeatRunEvents).values(["lifecycle", "staging"].map((eventType, seq) => ({
      companyId, runId: run.id, agentId, seq: seq + 1, eventType, message: eventType,
    })));
    if (identity === "process_requested") {
      await db.update(heartbeatRuns).set({ processPid: 987654321, processGroupId: 987654321, processStartedAt: new Date(),
        usageJson: { budgetDispatch: { handedOffAt: new Date().toISOString() } }, nextEventSeq: 5 }).where(eq(heartbeatRuns.id, run.id));
      await db.insert(heartbeatRunEvents).values(["native.process_start_requested", "run.attached"].map((eventType, index) => ({
        companyId, agentId, runId: run.id, seq: index + 3, eventType, sourceEventId: `startup:${run.id}:${index}`,
      })));
    }
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {}));
    const unusedStorage = async () => { throw new Error("Stop restoration must not access object storage"); };
    app.use("/api", issueRoutes(db, { provider: "local_disk", putFile: unusedStorage,
      getObject: unusedStorage, headObject: unusedStorage, deleteObject: unusedStorage }));
    app.use(errorHandler);
    const stopped = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body).toMatchObject({ status: status === "running" ? "cancelled" : status,
      resultJson: { personStop: { userId: "responsible-user", returned: [message.id] } } });
    const reload = await request(app).get(`/api/heartbeat-runs/${run.id}`);
    expect(reload.body.resultJson.personStop.returned).toEqual([message.id]);
    const terminalWrites = await db.$client<{ receipt: { returned: string[] }; wakes: unknown }[]>`
      select receipt, wakes from test_stop_receipt_transitions where run_id = ${run.id}`;
    if (status === "running") {
      expect(terminalWrites.length).toBeGreaterThan(0);
      for (const write of terminalWrites) {
        expect(write.receipt.returned).toContain(message.id);
        expect(JSON.stringify(write.wakes)).not.toContain(message.id);
      }
    }
    const [settledWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(settledWake.status).toBe("cancelled");
    expect(JSON.stringify(settledWake.payload)).not.toContain(message.id);
    // Complete the page's restore handshake: it keeps the text in the box,
    // then deletes the returned comment through this same real route.
    const restored = await request(app).delete(`/api/issues/${issue.id}/comments/${message.id}`).send({});
    expect(restored.status).toBe(200);
    const [returnedComment] = await db.select().from(issueComments).where(eq(issueComments.id, message.id));
    expect(returnedComment.deletedAt).toBeInstanceOf(Date);
    // The seeded preparation owner now unwinds, just as heartbeat's finally
    // does. A cancellation receipt alone must not claim provider cleanup.
    if (status === "running" && runtimeMode === "legacy") {
      expect(await settleCancelledLegacyPreparation(db, { run: (await heartbeat.getRun(run.id))!, providerDispatchStarted: false })).toBeTruthy();
    }
    const inputs: Array<Record<string, unknown>> = [];
    preparation.onExecution = async context => {
      inputs.push(context.context as Record<string, unknown>);
      await issueService(db).update(issue.id, { status: "done" });
    };
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: {} }).where(eq(agents.id, agentId));
    const nextMessage = await request(app).post(`/api/issues/${issue.id}/comments`).send({ body: "M2 corrected request" });
    expect(nextMessage.status).toBe(201);
    await vi.waitFor(() => expect(inputs.length).toBeGreaterThan(0), { timeout: 10_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(executedIssueIds()).toContain(issue.id);
    expect(inputs.length).toBeGreaterThan(0);
    expect(JSON.stringify(inputs)).not.toContain(message.body);
    for (const input of inputs) {
      const wake = input.paperclipWake as { commentIds: string[]; comments: unknown[] };
      const continuation = input.executionContinuation as { originCommentIds: string[]; messages: Array<{ id: string; deleted: boolean }> };
      expect(wake.commentIds).not.toContain(message.id);
      expect(JSON.stringify(wake.comments)).not.toContain(message.id);
      expect(continuation.originCommentIds).not.toContain(message.id);
      // Deleted history keeps an empty audit tombstone, never the input/body.
      expect(continuation.messages.filter(item => !item.deleted).map(item => item.id)).not.toContain(message.id);
    }
    process.stdout.write(`STOP_RECEIPT_PROOF ${JSON.stringify({ case: "stop_and_restore", initialStatus: status, identity, stage, runtimeMode, provider, runId: run.id,
      deletedAt: returnedComment.deletedAt, nextRunIds: mockAdapterExecute.mock.calls.map(([context]) => context.runId), terminalWrites,
      messageId: message.id, personStop: reload.body.resultJson.personStop, wakeStatus: settledWake.status,
      nextRunInputCount: inputs.length, messageBodyDelivered: JSON.stringify(inputs).includes(message.body) })}\n`);
  }, 60_000);

  it("settles a failure committed after Stop read running but before Stop acquired its ownership locks", async () => {
    const { companyId, agentId } = await seed();
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ companyId, title: "Failure wins during Stop", assigneeAgentId: agentId }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id,
      authorType: "user", authorUserId: "responsible-user", body: "M1" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy",
      executionStage: "preparing", runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      contextSnapshot: { issueId: issue.id, wakeCommentId: message.id } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const failure = db.transaction(async tx => {
      const lifecycle = createHeartbeatLifecycle(tx as unknown as typeof db,
        { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
      await lifecycle.setRunStatusIfRunning(run.id, "failed", { errorCode: "setup_failed", error: "40P01",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }, undefined, { setupFailure: true });
      locked(); await released;
    });
    await acquired;
    const stop = request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({}).then(response => response);
    try {
      await vi.waitFor(async () => {
        const waits = await db.$client<{ query: string }[]>`select query from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
        expect(waits.some(row => row.query.includes('"issues"') || row.query.includes('"heartbeat_runs"'))).toBe(true);
      }, { timeout: 10_000 });
    } finally { release(); await failure; await stop; }
    const response = await stop;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "failed", resultJson: { personStop: { returned: [message.id] } } });
    console.info("STOP_RECEIPT_PROOF", JSON.stringify({ case: "failure_commits_during_stop", runId: run.id,
      status: response.body.status, personStop: response.body.resultJson.personStop }));
  }, 30_000);

  it.each([
    { order: "cleanup_first", status: "failed" }, { order: "stop_first", status: "failed" },
    { order: "cleanup_first", status: "running" }, { order: "stop_first", status: "running" },
  ])("serializes checkout cleanup and Stop in issue-then-run order: $order / $status", async ({ order, status }) => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Checkout/Stop lock order", assigneeAgentId: agentId }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id,
      authorType: "user", authorUserId: "responsible-user", body: "M1" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "failed",
      payload: { issueId: issue.id, commentId: message.id } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode: "legacy",
      wakeupRequestId: wake.id, contextSnapshot: { issueId: issue.id, wakeCommentId: message.id },
      ...(status === "failed" ? { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } } : {}) }).returning();
    await db.update(issues).set({ checkoutRunId: run.id, executionRunId: run.id }).where(eq(issues.id, issue.id));
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    const waits = () => db.$client<{ query: string }[]>`select query from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    let cleanup: Promise<unknown> | undefined, stop: Promise<request.Response> | undefined;
    const holder = db.transaction(async tx => {
      if (order === "cleanup_first") {
        await issueService(tx as unknown as typeof db).clearCheckoutRunIfTerminal(issue.id);
      } else {
        // Pause Stop after both ownership locks, at its dependent input write.
        await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)).for("update");
      }
      locked(); await released;
    });
    await acquired;
    try {
      stop = request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({}).then(response => response);
      if (order === "stop_first") {
        await vi.waitFor(async () => expect((await waits()).some(row => row.query.includes('"agent_wakeup_requests"'))).toBe(true), { timeout: 10_000 });
        cleanup = issueService(db).clearCheckoutRunIfTerminal(issue.id);
      }
      // The contender waits on ISSUE, never holding issue while waiting on RUN.
      await vi.waitFor(async () => {
        const pending = await waits();
        expect(pending.some(row => row.query.includes('"issues"') && !row.query.includes('"heartbeat_runs"'))).toBe(true);
      }, { timeout: 10_000 });
    } finally {
      release(); await holder;
      await Promise.allSettled([stop, cleanup].filter(Boolean));
    }
    const response = await stop!;
    await cleanup;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: status === "running" ? "cancelled" : "failed", resultJson: { personStop: { returned: [message.id] } } });
    const [unlocked] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(unlocked.checkoutRunId).toBeNull();
    expect(unlocked.executionRunId).toBeNull();
    console.info("STOP_RECEIPT_PROOF", JSON.stringify({ case: "checkout_stop_lock_order", order, initialStatus: status, runId: run.id,
      status: response.body.status, personStop: response.body.resultJson.personStop, checkoutRunId: unlocked.checkoutRunId }));
  }, 30_000);

  it("returns only this person's pre-press input and preserves other queued input on a failed run", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Filtered Stop", assigneeAgentId: agentId }).returning();
    const [mine, future, other, deleted] = await db.insert(issueComments).values([
      { companyId, issueId: issue.id, authorType: "user", authorUserId: "responsible-user", body: "mine" },
      { companyId, issueId: issue.id, authorType: "user", authorUserId: "responsible-user", body: "after press", createdAt: new Date(Date.now() + 60_000) },
      { companyId, issueId: issue.id, authorType: "agent", authorAgentId: agentId, body: "not mine" },
      { companyId, issueId: issue.id, authorType: "user", authorUserId: "responsible-user", body: "deleted", deletedAt: new Date() },
    ]).returning();
    const ids = [mine.id, future.id, other.id, deleted.id];
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "legacy",
      contextSnapshot: { issueId: issue.id, wakeCommentIds: ids },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      payload: { issueId: issue.id, commentId: mine.id, _paperclipWakeContext: { wakeCommentIds: ids } } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    let firstPress: string | undefined;
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("failed");
      expect(response.body.resultJson.personStop.returned).toEqual([mine.id]);
      firstPress ??= response.body.resultJson.personStop.requestedAt;
      expect(response.body.resultJson.personStop.requestedAt).toBe(firstPress);
      if (repeat === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
        const [between] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorType: "user",
          authorUserId: "responsible-user", body: "M2 between repeated Stop presses" }).returning();
        ids.push(between.id);
        await db.update(agentWakeupRequests).set({ payload: { issueId: issue.id, commentId: future.id,
          _paperclipWakeContext: { wakeCommentIds: ids.slice(1) } } }).where(eq(agentWakeupRequests.id, wake.id));
      }
    }
    const [remaining] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(remaining.status).toBe("deferred_issue_execution");
    expect(JSON.stringify(remaining.payload)).not.toContain(mine.id);
    for (const id of ids.slice(1)) expect(JSON.stringify(remaining.payload)).toContain(id);
  });

  it.each(["dispatch", "acknowledgement", "process_pid", "process_group", "process_started", "budget_dispatch", "turn_started", "execution_started"])("does not return terminal input with %s evidence", async evidence => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Do not return received input", assigneeAgentId: agentId }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id,
      authorType: "user", authorUserId: "responsible-user", body: "already received or unknown" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "legacy",
      processPid: evidence === "process_pid" ? 12345 : null, processGroupId: evidence === "process_group" ? 12345 : null,
      processStartedAt: evidence === "process_started" ? new Date() : null,
      usageJson: evidence === "budget_dispatch" ? { budgetDispatch: { handedOffAt: new Date().toISOString() } } : null,
      contextSnapshot: { issueId: issue.id, wakeCommentIds: [message.id] }, resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        ...(evidence === "dispatch" ? { firstTurnDispatchCommitted: true } : {}),
        ...(evidence === "acknowledgement" ? { queuedSteeringAcknowledgements: { [message.id]: { received: true } } } : {}),
      } }).returning();
    if (["turn_started", "execution_started"].includes(evidence)) await db.insert(heartbeatRunEvents).values({ companyId, agentId,
      runId: run.id, seq: 1, eventType: evidence === "turn_started" ? "turn.started" : "adapter.invoke" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    const response = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("failed");
    expect(response.body.resultJson).not.toHaveProperty("personStop");
    expect(response.body.resultJson).not.toHaveProperty("startupCancellation");
  });

  it("fixes provider-returned input at the Stop click and re-admits post-press M2 exactly once", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Post-press returned input", assigneeAgentId: agentId }).returning();
    const [m1] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorType: "user", authorUserId: "responsible-user", body: "M1 unseen" }).returning();
    // Both comments round to the same JS millisecond. PostgreSQL must own
    // comparison with the press's sub-millisecond cutoff.
    const pressedAt = "2026-11-24T23:00:00.000500Z";
    const [m2] = await db.insert(issueComments).values({ companyId, issueId: issue.id, authorType: "user", authorUserId: "responsible-user", body: "M2 after Stop" }).returning();
    await db.update(issueComments).set({ createdAt: sql`'2026-11-24T23:00:00.000400Z'::timestamptz` }).where(eq(issueComments.id, m1.id));
    await db.update(issueComments).set({ createdAt: sql`'2026-11-24T23:00:00.000600Z'::timestamptz` }).where(eq(issueComments.id, m2.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issue.id, runtimeMode: "native", status: "succeeded",
      resultJson: { personStop: { requestedAt: pressedAt, userId: "responsible-user" }, queuedSteeringAcknowledgements: { [m2.id]: { status: "acknowledged" } } } }).returning();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, runId: run.id, source: "issue", status: "completed",
      payload: { issueId: issue.id, commentId: m2.id } });
    const [otherIssue] = await db.insert(issues).values({ companyId, title: "Other issue, same agent", assigneeAgentId: agentId }).returning();
    const [otherWake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "issue", status: "deferred_issue_execution",
      payload: { issueId: otherIssue.id, commentId: randomUUID() } }).returning();
    const sourceInstanceId = randomUUID(), sessionId = randomUUID();
    const port = new PaperclipControlPlanePort(db, { companyId, agentId, issueId: issue.id, runId: run.id, sessionId,
      sourceInstanceId, controlPlaneSourceInstanceId: "post-stop-test", completionContractId: randomUUID(), completionContractSha256: "test" });
    const lateNotice: PrpEvent = { schema: "paperclip.prp.event.v1", sourceInstanceId, sourceEventId: "late-stop-return:1",
      sourceSeq: 1, sourceKind: "runner", runId: run.id, normalizedSessionId: sessionId, turnId: "finished-turn",
      eventType: "provider.notice.recorded", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { schema: "paperclip.provider.notice.v1", noticeId: "late-stop-return", severity: "info", category: "pi_stop_returned_input",
        scope: "turn", recoverable: true, userActionable: false, summary: "Returned unread Stop input",
        details: [{ name: "returnedCommentIds", value: `${m1.id},${m2.id}` }] } };
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holder = db.transaction(async tx => {
      await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, otherWake.id)).for("update");
      held.resolve(); await release.promise;
    });
    await held.promise;
    let settlement: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // The provider notice arrives AFTER the run settled; the finalizer
      // cannot see it retroactively. Exercise actual event intake, not a helper.
      settlement = port.appendEvent(lateNotice).then(() => undefined);
      await Promise.race([settlement, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Stop settlement blocked on another issue's wake")), 2_000);
      })]);
    } finally {
      if (timeout) clearTimeout(timeout);
      release.resolve(); await holder; await settlement;
    }
    await port.appendEvent(lateNotice); // exact durable notice replay
    const settled = (await heartbeat.getRun(run.id))!;
    expect(settled.resultJson?.personStop).toMatchObject({ returned: [m1.id] });
    const readmitted = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,
      (settled.resultJson?.personStopReadmitted as Record<string, string>)[m2.id]));
    expect(readmitted).toHaveLength(1); expect(readmitted[0].status).toBe("deferred_issue_execution");
    expect(readmitted[0].runId).toBeNull(); expect(JSON.stringify(readmitted[0].payload)).toContain(m2.id);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, m2.id)))[0].deletedAt).toBeNull();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, readmitted[0].id)))).toHaveLength(1);
    // An already-bound replacement is not re-admitted, even with no answer
    // receipt yet. A cancelled UNBOUND marker, however, proves no answer.
    const [next] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issue.id, status: "succeeded" }).returning();
    await db.update(agentWakeupRequests).set({ runId: next.id, status: "completed" }).where(eq(agentWakeupRequests.id, readmitted[0].id));
    await settleProviderReturnedStopInput(db, run, [m1.id, m2.id]);
    expect((await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.idempotencyKey} = ${`person-stop-postpress:${run.id}:${m2.id}`}`))).toHaveLength(1);
    await db.update(agentWakeupRequests).set({ runId: null, status: "cancelled" }).where(eq(agentWakeupRequests.id, readmitted[0].id));
    await settleProviderReturnedStopInput(db, run, [m1.id, m2.id]);
    const retried = (await heartbeat.getRun(run.id))!.resultJson?.personStopReadmitted as Record<string, string>;
    expect(retried[m2.id]).not.toBe(readmitted[0].id);
    const [replacement] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retried[m2.id]));
    expect(replacement.status).toBe("deferred_issue_execution");
    await settleProviderReturnedStopInput(db, run, [m1.id, m2.id]);
    expect((await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.idempotencyKey} = ${`person-stop-postpress:${run.id}:${m2.id}`}`))).toHaveLength(2);
    const databaseTimes = await db.select({ id: issueComments.id, createdAt: sql<string>`${issueComments.createdAt}::text` })
      .from(issueComments).where(inArray(issueComments.id, [m1.id, m2.id]));
    process.stdout.write(`POSTPRESS_STOP_PROOF ${JSON.stringify({ runId: run.id, pressedAt, m1: m1.id, m2: m2.id, databaseTimes,
      personStop: settled.resultJson?.personStop, readmittedWakeId: readmitted[0].id, replacementWakeId: replacement.id,
      status: readmitted[0].status, deleted: false, otherIssueLockDidNotBlock: true, lateNoticeReplayCount: 2 })}\n`);
  });

  it("returns the message after the real setup-failure handler records a 40P01", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Actual setup failure", assigneeAgentId: agentId }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id,
      authorType: "user", authorUserId: "responsible-user", body: "M1" }).returning();
    preparation.beforeSession = async () => { throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); };
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "responsible-user", manualUserWake: true,
      payload: { issueId: issue.id, commentId: message.id },
      contextSnapshot: { issueId: issue.id, wakeCommentId: message.id, wakeCommentIds: [message.id] } });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const failed = await heartbeat.getRun(run!.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "setup_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    const response = await request(app).post(`/api/heartbeat-runs/${run!.id}/cancel`).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "failed", resultJson: { personStop: { returned: [message.id] } } });
    expect(executedIssueIds()).not.toContain(issue.id);
  }, 60_000);

  it("keeps the existing native-attempt fence when merging a Stop receipt into failure JSON", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Attempted native work", assigneeAgentId: agentId }).returning();
    const receipt = { requestedAt: new Date().toISOString(), userId: "responsible-user", returned: [randomUUID()] };
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issue.id, resultJson: { personStop: receipt,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).returning();
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId, issueId: issue.id, phase: "running", attempt: 1 });
    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
    const result = await lifecycle.setRunStatusIfRunning(run.id, "failed", { errorCode: "setup_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }, undefined, { setupFailure: true });
    expect(result.updated).toBe(true);
    expect(result.run?.resultJson?.personStop).toEqual(receipt);
    expect(result.run?.resultJson).not.toHaveProperty("executionRecovery");
  });

  it("returns current Stop state rather than a failure bar when a queued receipt loses its status race", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Queued receipt race", assigneeAgentId: agentId }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id,
      authorType: "user", authorUserId: "responsible-user", body: "M1" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued",
      contextSnapshot: { issueId: issue.id, wakeCommentId: message.id } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const terminal = db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      locked(); await released;
      await tx.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    });
    await acquired;
    const stop = request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({}).then(response => response);
    try {
      await vi.waitFor(async () => {
        const waits = await db.$client<{ query: string }[]>`select query from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
        expect(waits.some(row => row.query.includes('update "heartbeat_runs"'))).toBe(true);
      }, { timeout: 10_000 });
    } finally { release(); await terminal; await stop; }
    const response = await stop;
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("cancelled");
    expect(response.body.error).toBeNull();
    process.stdout.write(`STOP_RECEIPT_PROOF ${JSON.stringify({ case: "queued_receipt_status_race", runId: run.id,
      httpStatus: response.status, status: response.body.status })}\n`);
  });

  it("keeps mid-turn Pi Stop turn-only and returns only queued unseen input", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, title: "Mid-turn Stop", assigneeAgentId: agentId }).returning();
    const [received, queued] = await db.insert(issueComments).values(["M1 received", "M2 queued"].map(body => ({
      companyId, issueId: issue.id, authorType: "user" as const, authorUserId: "responsible-user", body,
    }))).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issue.id, driverKind: "pi_rpc", sessionIdBefore: "saved-session", nextEventSeq: 2,
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } } },
      contextSnapshot: { issueId: issue.id, wakeCommentIds: [received.id] },
      resultJson: { firstTurnDispatchCommitted: true, queuedSteeringAcknowledgements: { [received.id]: { received: true } } },
    }).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: run.id, seq: 1, eventType: "turn.started" });
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand",
      status: "deferred_issue_execution", payload: { issueId: issue.id, commentId: queued.id,
        _paperclipWakeContext: { wakeCommentIds: [queued.id] } } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "responsible-user", companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", agentRoutes(db, {})); app.use(errorHandler);
    // Only the provider wire is substituted; route, receipt and wake settlement
    // use PostgreSQL. Mid-turn Stop must not call whole-run cancellation.
    const interrupt = vi.spyOn(nativeSession, "interruptNativeTurn").mockResolvedValue({ turnId: "active-turn" });
    try {
      const stopped = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ status: "running", runtimeMode: "native", sessionIdBefore: "saved-session",
        resultJson: { personStop: { returned: [queued.id] }, firstTurnDispatchCommitted: true } });
      expect(stopped.body.resultJson).not.toHaveProperty("startupCancellation");
      expect((await db.select().from(issueComments).where(eq(issueComments.id, received.id)))[0].deletedAt).toBeNull();
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("cancelled");
      process.stdout.write(`STOP_RECEIPT_PROOF ${JSON.stringify({ case: "mid_turn", runId: run.id,
        status: stopped.body.status, personStop: stopped.body.resultJson.personStop, receivedMessageId: received.id,
        sessionIdBefore: stopped.body.sessionIdBefore })}\n`);
    } finally { interrupt.mockRestore(); }
  });

  it("does not invent Stop metadata for a setup failure without a person's Stop", async () => {
    const { companyId, agentId } = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy" }).returning();
    const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
    const result = await lifecycle.setRunStatusIfRunning(run.id, "failed", { errorCode: "setup_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }, undefined, { setupFailure: true });
    expect(result.run?.status).toBe("failed");
    expect(result.run?.resultJson).not.toHaveProperty("personStop");
    expect(result.run?.resultJson).not.toHaveProperty("startupCancellation");
  });

  it("confirms Stop during preparation and continues once from a later message", async () => {
    const { companyId, agentId } = await seed();
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
    let entered = false;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    preparation.beforeSession = async () => { entered = true; await released; };
    try {
      const { issue, run } = await assignAndWake(companyId, agentId, "Accidental submission");
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
      // Gate 7: acquisition handed the idle allocation to this preparation.
      // Neither Stop nor its finally may call the provider to archive that box.
      const [environment] = await db.insert(environments).values({ name: "Borrowed idle box", driver: "sandbox" }).returning();
      const leases = environmentService(db);
      const input = { companyId, environmentId: environment!.id, issueId: issue.id, provider: "daytona",
        providerLeaseId: "idle-box", leasePolicy: "reuse_by_environment" as const,
        metadata: { agentId, priorSession: "saved-pi-session" } };
      const predecessor = await leases.acquireLease(input);
      await leases.releaseLease(predecessor.id, "retained", { cleanupStatus: "success" });
      const borrowed = await leases.acquireLease({ ...input, heartbeatRunId: run.id,
        replacesReusableLeaseId: predecessor.id });
      expect(borrowed.metadata).not.toHaveProperty("replacesReusableLeaseId");
      const stop = await request(app).post(`/api/heartbeat-runs/${run.id}/cancel`).send({});
      expect(stop.status).toBe(200);
      expect(stop.body.status).toBe("cancelled");
      // Terminal status alone must not confirm a Stop while preparation owns it.
      expect(stop.body.resultJson.executionCancellation).toMatchObject({ state: "requested" });
      release();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const settled = await request(app).get(`/api/heartbeat-runs/${run.id}`);
      expect(settled.status).toBe(200);
      expect(settled.body.resultJson.preDispatchCancellationSettledAt).toEqual(expect.any(String));
      const [returned] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, borrowed!.id));
      expect(returned).toMatchObject({ status: "released", cleanupStatus: "success", providerLeaseId: "idle-box",
        metadata: { priorSession: "saved-pi-session" } });
      expect(returned!.metadata).not.toHaveProperty("remoteExecutionTermination");
      expect(settled.body.resultJson.executionCancellation).toMatchObject({ state: "acknowledged", proof: "preparation_settled", acknowledgedAt: expect.any(String) });
      expect(executedIssueIds()).not.toContain(issue.id);
      expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)).toMatchObject({
        phase: "completed", label: "Stopped", cause: null,
        nextAction: "Send a new message to continue from saved work.",
      });
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id)))
        .filter(action => action.status === "active" || action.status === "escalated")).toHaveLength(0);
      const [task] = await db.select().from(issues).where(eq(issues.id, issue.id));
      expect(await taskInterruptionPresentation(db, task)).toMatchObject({ state: "resolved", canRetry: false });
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect(events.find(event => event.message === "run cancelled")?.level).toBe("info");
      await heartbeat.reconcileStrandedAssignedIssues();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(executedIssueIds()).not.toContain(issue.id);

      preparation.beforeSession = undefined;
      // Simulate the agent's final reply and task completion. A raw adapter exit
      // without a task disposition correctly triggers a separate follow-up.
      preparation.onExecution = async context => {
        await context.onEvent?.({ eventType: "item.completed", stream: "stdout", level: "info", payload: {
          prpEvent: { sourceEventId: `fixture:${context.runId}:final`, payload: { kind: "agentMessage", channel: "final", text: "ok" } },
        } });
        await issueService(db).update(issue.id, { status: "done" });
      };
      const message = await request(app).post(`/api/issues/${issue.id}/comments`).send({ body: "Continue with the corrected request." });
      expect(message.status).toBe(201);
      // Comment dispatch is asynchronous; wait for its wake to register before
      // draining the process-wide executor set or tearing down its task rows.
      await vi.waitFor(() => expect(executedIssueIds()).toContain(issue.id), { timeout: 10_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(executedIssueIds().filter(id => id === issue.id)).toHaveLength(1);
      expect((await heartbeat.getRun(run.id))?.status).toBe("cancelled");
    } finally { release(); }
  }, 60_000);

  it.each([false, true])("confirms Stop only after lease release, with prior automatic disposition: %s", async (disposeFirst) => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId, title: "Retained preparation", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(), errorCode: "cancelled",
      contextSnapshot: { issueId: issue.id }, resultJson: {
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "responsible-user" }, reason: "Stop", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId: issue.id, heartbeatRunId: run.id,
      provider: "local", status: "active" }).returning();
    expect(await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false })).toBeNull();
    expect((await heartbeat.getRun(run.id))?.resultJson?.executionCancellation).toEqual({ state: "requested", requestedAt });
    expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)?.phase).toBe("failed");
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });

    if (disposeFirst) {
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
        kind: "active_run_watchdog", status: "active", ownerType: "system", returnOwnerAgentId: agentId,
        cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${run.id}`,
        nextAction: "Preserve this stopped execution until its outcome is known.", evidence: { runId: run.id } });
      await settleUnrecoverableExecutions(db);
      const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
      expect(hold).toMatchObject({ status: "resolved", outcome: "blocked",
        evidence: { automaticRecovery: { replay: "blocked" }, legacyCancellationBlock: { runId: run.id } } });
      expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)?.phase).toBe("recovery_needed");
    }

    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.id, lease.id));
    const deferredHint = vi.spyOn(deferredNotifications, "notifyDeferredWakesForIssue");
    const settled = await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false });
    if (disposeFirst) expect(deferredHint).toHaveBeenCalledWith(expect.anything(), { companyId, issueId: issue.id });
    deferredHint.mockRestore();
    expect(settled?.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", proof: "preparation_settled", requestedAt });
    expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)).toMatchObject({ phase: "completed", label: "Stopped" });
    const [settledIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(settledIssue.status).toBe("in_progress");
    expect(await taskInterruptionPresentation(db, settledIssue)).toMatchObject({ state: "resolved", canRetry: false });
    expect(executedIssueIds()).not.toContain(issue.id);
  });

  it.each(["2026-01-01T00:00:00.000Z", null])("retains the Stop hold after dispatch handoff without an invocation event: %s", async (handedOffAt) => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Dispatch handoff before adapter entry", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(), errorCode: "cancelled",
      contextSnapshot: { issueId: issue.id }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      resultJson: {
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "responsible-user" },
          reason: "Stop", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${run.id}`,
      nextAction: "Preserve this stopped execution until its outcome is known.", evidence: { runId: run.id } }).returning();
    // The old owner has a stale snapshot. The replacement has passed the gate,
    // but has not recorded adapter.invoke or a process identity yet.
    await db.update(heartbeatRuns).set({ usageJson: { budgetDispatch: { handedOffAt } }, executionStage: "dispatching" })
      .where(eq(heartbeatRuns.id, run.id));
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id))).toEqual([]);
    expect(await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false })).toBeNull();
    const stopped = await heartbeat.getRun(run.id);
    expect(stopped?.resultJson).toEqual(run.resultJson);
    const [retained] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(retained).toMatchObject({ status: "active", outcome: null, evidence: hold.evidence });
    expect((await executionProjectionsForRuns(db, companyId, [run.id])).get(run.id)?.phase).not.toBe("completed");
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed" });
    expect(executedIssueIds()).not.toContain(issue.id);
  });

  it("preserves a system cancellation's recovery delivery when preparation settles", async () => {
    const { companyId, agentId } = await seed();
    const [issue] = await db.insert(issues).values({ companyId, assigneeAgentId: agentId,
      title: "Stale continuation", status: "in_progress" }).returning();
    const requestedAt = new Date().toISOString();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue.id,
      status: "cancelled", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId: issue.id }, resultJson: {
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "continuation_task_ownership_changed", recordedAt: requestedAt },
        executionCancellation: { state: "requested", requestedAt },
      } }).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${run.id}`,
      nextAction: "Continue saved input through recovery.", evidence: { runId: run.id,
        automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", continuationDelivery: "pending" } } }).returning();
    const result = await settleCancelledLegacyPreparation(db, { run, providerDispatchStarted: false });
    expect(result?.resultJson?.executionCancellation).toEqual({ state: "requested", requestedAt });
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(settled.evidence.automaticRecovery).toEqual({ policy: "preserve_without_replay_v1",
      replay: "allowed", continuationDelivery: "pending" });
  });

  it.each(["todo", "in_progress"] as const)("takes a %s task out of line in one Stop and still promotes the agent's next task", async (waitingStatus) => {
    const { companyId, agentId } = await seed();
    const busy = randomUUID();
    const [busyIssue] = await db.insert(issues).values({ id: busy, companyId, title: "Busy", status: "todo", assigneeAgentId: agentId }).returning();
    gates.set(busyIssue.id, null);
    const busyRun = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: busyIssue.id } });
    await vi.waitFor(() => expect(executedIssueIds()).toContain(busyIssue.id), { timeout: 10_000 });

    const waiting = await assignAndWake(companyId, agentId, "Waiting task", waitingStatus);
    const next = await assignAndWake(companyId, agentId, "Next task");
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("queued");
    expect((await heartbeat.getRun(next.run.id))?.status).toBe("queued");

    const stopped = await heartbeat.cancelRun(waiting.run.id, "Cancelled by a board operator", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" },
    });
    expect(stopped?.status).toBe("cancelled");
    // The board Stop route follows the cancel with this status return.
    await returnStoppedWaitingTaskToTodo(db, stopped!, { userId: "responsible-user" });

    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.run.wakeupRequestId!));
    expect(wake.status).toBe("cancelled");
    const [waitingIssue] = await db.select().from(issues).where(eq(issues.id, waiting.issue.id));
    expect(waitingIssue.executionRunId).toBeNull();
    expect(waitingIssue.status).toBe("todo");
    const statusActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, waiting.issue.id));
    expect(statusActivity.filter((row) => row.action === "issue.updated")).toHaveLength(waitingStatus === "in_progress" ? 1 : 0);

    // Free the slot: the agent's next task promotes, the stopped one never runs again.
    gates.get(busyIssue.id)?.();
    await vi.waitFor(() => expect(executedIssueIds()).toContain(next.issue.id), { timeout: 45_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(executedIssueIds()).not.toContain(waiting.issue.id);
    const laterRuns = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${waiting.issue.id}`);
    expect(laterRuns).toEqual([{ id: waiting.run.id, status: "cancelled" }]);
    const [afterIssue] = await db.select().from(issues).where(eq(issues.id, waiting.issue.id));
    expect(afterIssue.status).toBe("todo");
    expect(afterIssue.executionRunId).toBeNull();
    expect(busyRun).toBeTruthy();
  }, 120_000);

  /** Hold the task row in another transaction until `release` is called. */
  async function holdTaskRow(issueId: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      locked();
      await released;
    });
    await lockTaken;
    return { release, holder };
  }

  async function queueBehindBusyTask() {
    const { companyId, agentId } = await seed();
    const [busyIssue] = await db.insert(issues).values({ companyId, title: "Busy", status: "todo", assigneeAgentId: agentId }).returning();
    gates.set(busyIssue.id, null);
    await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: busyIssue.id } });
    await vi.waitFor(() => expect(executedIssueIds()).toContain(busyIssue.id), { timeout: 10_000 });
    const waiting = await assignAndWake(companyId, agentId, "Waiting task");
    const queued = await heartbeat.getRun(waiting.run.id);
    expect(queued?.status).toBe("queued");
    expect(queued?.runtimeMode).toBe("legacy");
    return waiting;
  }

  // The board route attributes Stop to the user, which first supersedes the
  // task's handoffs under the same task-row lock.
  const stopCallers = [
    { caller: "control plane", reason: "Cancelled by control plane", options: undefined },
    { caller: "board", reason: "Cancelled by a board operator",
      options: { resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } } },
  ] as const;

  it.each(stopCallers)("stops a waiting legacy run for the $caller when another writer briefly holds its task row past the lock timeout", async ({ reason, options }) => {
    const waiting = await queueBehindBusyTask();
    const lock = await holdTaskRow(waiting.issue.id);
    // Longer than one 1s lock_timeout, shorter than the bounded attempts.
    const releaseTimer = setTimeout(lock.release, 1_500);
    try {
      const stopped = await heartbeat.cancelRun(waiting.run.id, reason, options);
      expect(stopped?.status).toBe("cancelled");
    } finally {
      clearTimeout(releaseTimer);
      lock.release();
      await lock.holder;
    }
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("cancelled");
  }, 60_000);

  it.each(stopCallers)("answers the $caller a retryable conflict when the task row stays locked through every attempt", async ({ reason, options }) => {
    const waiting = await queueBehindBusyTask();
    const lock = await holdTaskRow(waiting.issue.id);
    try {
      const startedAt = Date.now();
      const error = await heartbeat.cancelRun(waiting.run.id, reason, options).then(
        () => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).details).toMatchObject({ code: "run_stop_busy", runId: waiting.run.id });
      // Bounded: three 1s waits plus short backoff, never an open-ended queue.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      lock.release();
      await lock.holder;
    }
    // Nothing was committed, so the same Stop succeeds once the writer is done.
    expect((await heartbeat.getRun(waiting.run.id))?.status).toBe("queued");
    const stopped = await heartbeat.cancelRun(waiting.run.id, reason, options);
    expect(stopped?.status).toBe("cancelled");
  }, 60_000);
});
