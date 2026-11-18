import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
// The kept box answers a no-op command (the bound's reachability probe): a real
// same_box decision without a real provider.
vi.mock("../services/environment-execution-target.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/environment-execution-target.js")>(),
  resolveEnvironmentExecutionTarget: async () => ({ kind: "remote", remoteCwd: "/workspace",
    runner: { execute: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }) } }),
}));
import { recoveryService } from "../services/recovery/service.js";
import { personStopCardLine, recordTaskStopPending, STOP_PENDING_PERSON_ACTION, STOP_PENDING_PERSON_ACTION_EXECUTOR_ALIVE } from "../services/recovery/stop-pending.js";
import { decidePersonStopExportAtBound, readPersonStopBoundDecision } from "../services/heartbeat/person-stop-release-export.js";
import { PERSON_STOP_EXPORT_BOUND_MS, PERSON_STOP_EXPORT_UNPROVEN } from "../services/heartbeat/person-stop-export-bound.js";
import { STOPPED_SESSION_CLOSE_SCHEMA } from "../services/heartbeat/cancelled-warm-workspace-export.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { activeRunExecutions } from "../services/active-run-executions.js";

// Keep reason: adopt-stopu-twoclock5. RFL F8: a same_box bound decision keeps
// the box RUNNING for its successor; no stop is requested, so no stop receipt
// ever closes a Stop-pending card, and the sweep wrote one that stayed for good.
// rf-4 NEW 2: the card's line must be true per phase (executor alive: its
// in-memory gate holds a new message; executor gone: it starts on a fresh machine).
describe("adopt-stopu-twoclock5: same_box closes the card; the card line is true per phase", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stopu-twoclock5-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { activeRunExecutions.clear(); await db.execute(sql`truncate companies cascade`); await db.execute(sql`truncate environments cascade`); });
  afterEach(() => { vi.useRealTimers(); activeRunExecutions.clear(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  const STOP_AT = Date.parse("2026-11-18T02:00:00.000Z");
  // The first unproven release: the Stop's teardown + the 30 s export bound.
  const FAILING_SINCE = STOP_AT + 30_000;
  const at = (ms: number) => vi.useFakeTimers({ toFake: ["Date"], now: ms });

  async function fixture() {
    at(STOP_AT);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const leaseId = randomUUID(), providerLeaseId = `boat-${runId}`;
    await db.insert(companies).values({ id: companyId, name: "Two clocks", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped owner", adapterType: "paperclip_runner",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
      reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: "intent-1", acknowledgementAuditId: "ack-1", recordedAt: new Date(STOP_AT).toISOString() };
    const sha = "a".repeat(64);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "cancelled",
      runtimeMode: "native", executionStage: "settled", issueId, nativeIssueId: issueId, nativeSessionId: randomUUID(),
      startedAt: new Date(STOP_AT - 60_000), finishedAt: new Date(STOP_AT), contextSnapshot: { issueId },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user",
        executionCancellation: { state: "acknowledged" }, nativeCancellation },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: sha,
          baselineSha256: sha, finalHostSha256: null, workspaceId: randomUUID(), leaseId, providerLeaseId,
          remoteCwd: "/workspace", resourceDisposition: "keep_running" },
        // The NSE clean-close proof: the stopped turn's tools are proven gone.
        nativeStoppedSessionClose: { schema: STOPPED_SESSION_CLOSE_SCHEMA, runId, companyId, issueId, clean: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stop while a command runs", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(STOP_AT - 60_000),
      conversationAgentId: agentId, conversationUserId: "board-user", conversationState: "active" });
    // The export owns the finalizer (no crash path); its own clock is the deferral.
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
      failureCode: "native_retry_cancelled", controllerBootId: "boot-1", controllerGeneration: 3,
      leaseOwner: "executor", leaseExpiresAt: new Date(STOP_AT + 60 * 60_000) });
    // The box is KEPT: lease active, unreleased, the release deferred as unproven.
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: `boat-${runId}`, driver: "plugin" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, status: "active", environmentId,
      leasePolicy: "reuse_by_environment", provider: "plugin:boat:computer", providerLeaseId,
      expiresAt: new Date(STOP_AT + 60 * 60_000),
      metadata: { driver: "plugin", pluginKey: "boat", driverKey: "computer", agentId,
        runnerTaskLease: true, runnerTaskDispatched: true, runnerTaskExecutionStopped: false,
        releaseDeferral: { reason: PERSON_STOP_EXPORT_UNPROVEN, attempts: 1, failingSince: new Date(FAILING_SINCE).toISOString(),
          retryAt: new Date(FAILING_SINCE + PERSON_STOP_EXPORT_BOUND_MS).toISOString(), providerResourceDisposition: "stop_and_retain" } } });
    return { companyId, agentId, issueId, runId, leaseId };
  }
  async function openCards(issueId: string) {
    return (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      .filter(row => (row.status === "active" || row.status === "escalated") && (row.evidence as Record<string, unknown>).stopPending);
  }
  async function sweep(f: { companyId: string; issueId: string }) {
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileStrandedAssignedIssues();
  }
  async function decide(f: { runId: string }) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    return decidePersonStopExportAtBound({ db, environmentRuntime: {} as never, run: run! });
  }

  const BOUND = FAILING_SINCE + PERSON_STOP_EXPORT_BOUND_MS;
  async function decisionOf(f: { leaseId: string }) {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    return readPersonStopBoundDecision(lease!.metadata);
  }
  async function writeCard(f: { companyId: string; issueId: string; runId: string }) {
    await db.transaction(async tx => recordTaskStopPending(tx as unknown as Db, { companyId: f.companyId, issueId: f.issueId,
      runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []));
  }
  // run-control hands a same_box box to its successor (keep_running release).
  async function releaseToSuccessor(f: { leaseId: string }) {
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, f.leaseId));
  }

  it("F8 RED: a card open when the same_box decision commits is closed by that decision", async () => {
    const f = await fixture();
    at(STOP_AT + 5 * 60_000 + 1_000);
    await writeCard(f);
    expect(await openCards(f.issueId)).toHaveLength(1);
    at(BOUND);
    expect(await decide(f)).toMatchObject({ decision: "same_box", reason: "box_reachable_tools_stopped", decidedNow: true });
    expect(await openCards(f.issueId)).toEqual([]);
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(rows.map(row => [row.status, row.outcome])).toEqual([["cancelled", "cancelled"]]);
    expect(rows[0]!.resolutionNote).not.toMatch(/Stop proved/);
  });

  it("F8 RED: same_box, then sweeps (box kept, then handed to its successor) => no lasting card", async () => {
    const f = await fixture();
    at(BOUND);
    expect(await decide(f)).toMatchObject({ decision: "same_box" });
    for (const later of [30_000, 5 * 60_000]) {
      at(BOUND + later);
      await sweep(f);
      expect(await openCards(f.issueId)).toEqual([]);
    }
    await releaseToSuccessor(f);
    for (const later of [6 * 60_000, 60 * 60_000]) {
      at(BOUND + later);
      await sweep(f);
      expect(await openCards(f.issueId)).toEqual([]);
    }
    // The card writer itself, under its task + run locks, refuses on same_box.
    await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      await recordTaskStopPending(tx as unknown as Db, { companyId: f.companyId, issueId: f.issueId,
        runIds: [f.runId], source: "recovery.person_stop_cleanup_pending" }, []);
    });
    expect(await openCards(f.issueId)).toEqual([]);
    expect(await decisionOf(f)).toMatchObject({ decision: "same_box" });
  });

  it("NEW 2: the card line per phase, from the gate's own signal (executor alive => held; gone => fresh machine)", async () => {
    const f = await fixture();
    at(STOP_AT + 5 * 60_000 + 1_000);
    await writeCard(f);
    const read = async () => (await issueRecoveryActionService(db).getActiveForIssue(f.companyId, f.issueId))!.nextAction;
    // Executor ALIVE: heartbeat.ts executeRun still holds the run in activeRunExecutions,
    // so queue.ts predecessor_settling_in_process declines every new message.
    activeRunExecutions.add(f.runId);
    expect(personStopCardLine([f.runId])).toBe(STOP_PENDING_PERSON_ACTION_EXECUTOR_ALIVE);
    expect(await read()).toBe(STOP_PENDING_PERSON_ACTION_EXECUTOR_ALIVE);
    expect(await read()).not.toMatch(/start now/);
    expect(await read()).toMatch(/wait until it closes/);
    // Executor GONE (its finally removed the run; or a fresh process after a restart).
    activeRunExecutions.delete(f.runId);
    expect(personStopCardLine([f.runId])).toBe(STOP_PENDING_PERSON_ACTION);
    expect(await read()).toBe(STOP_PENDING_PERSON_ACTION);
    expect(await read()).toMatch(/start now on a fresh machine/);
  });
});
