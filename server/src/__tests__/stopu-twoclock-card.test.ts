import { randomUUID } from "node:crypto";
import { agents, companies, heartbeatRunEvents, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const seam = vi.hoisted(() => ({ failSupersede: 0 }));
vi.mock("../services/recovery/stop-pending.js", async importOriginal => {
  const real = await importOriginal<typeof import("../services/recovery/stop-pending.js")>();
  return { ...real, supersedePersonStopCardByBoundDecision: async (...args: Parameters<typeof real.supersedePersonStopCardByBoundDecision>) => {
    if (seam.failSupersede > 0) { seam.failSupersede--; throw new Error("forced supersede failure (twoclock3 b)"); }
    return real.supersedePersonStopCardByBoundDecision(...args);
  } };
});
import { recoveryService } from "../services/recovery/service.js";
import { recordTaskStopPending } from "../services/recovery/stop-pending.js";
import { decidePersonStopExportAtBound, readPersonStopBoundDecision } from "../services/heartbeat/person-stop-release-export.js";
import { PERSON_STOP_EXPORT_BOUND_MS, PERSON_STOP_EXPORT_UNPROVEN, personStopExportBoundAt } from "../services/heartbeat/person-stop-export-bound.js";

// Keep reason: adopt-stopu-twoclock (FV-2 pilot, traces 81/82). A person's Stop
// while a command runs, export unproven: TWO five-minute clocks. The card's
// (personStopCardBoundAt: nativeCancellation.recordedAt + 5 min, read by the
// recovery sweep's deferral) and the export hold's (personStopExportBoundAt:
// releaseDeferral.failingSince + 5 min, which starts later). Between them the
// sweep wrote a Stop-pending card saying "New messages you send start now"
// while the hold still held them; at the export bound the without_files
// decision kept the box (no stop request, so no stop receipt) and nothing closed
// the card. Drive the real sweep and the real bound decision on real SQL, with a
// fake Date standing in for the two clocks.
describe("adopt-stopu-twoclock: the person-Stop card and the export hold share one owner", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stopu-twoclock-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterEach(() => { vi.useRealTimers(); });
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
          remoteCwd: "/workspace", resourceDisposition: "keep_running" } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stop while a command runs", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(STOP_AT - 60_000),
      conversationAgentId: agentId, conversationUserId: "board-user", conversationState: "active" });
    // The export owns the finalizer (no crash path); its own clock is the deferral.
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
      failureCode: "native_retry_cancelled", controllerBootId: "boot-1", controllerGeneration: 3,
      leaseOwner: "executor", leaseExpiresAt: new Date(STOP_AT + 60 * 60_000) });
    // The box is KEPT: lease active, unreleased, the release deferred as unproven.
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, status: "active",
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

  it("no card while the export hold is on; the without_files decision leaves no open card, then or later", async () => {
    const f = await fixture();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const holdEndsAt = personStopExportBoundAt(lease!.metadata)!;
    expect(holdEndsAt).toBe(FAILING_SINCE + PERSON_STOP_EXPORT_BOUND_MS);
    // The card's clock has run out (Stop + 5 min + 1 s); the hold's has 29 s left.
    at(STOP_AT + 5 * 60_000 + 1_000);
    expect(Date.now()).toBeLessThan(holdEndsAt);
    await sweep(f);
    expect(await openCards(f.issueId)).toEqual([]);
    // Still inside the hold: the bound makes no decision yet.
    expect(await decide(f)).toBeNull();
    // At the hold's bound: tools not proven stopped -> without_files, box kept.
    at(holdEndsAt);
    expect(await decide(f)).toMatchObject({ decision: "without_files", reason: "tools_not_proven_stopped" });
    await sweep(f);
    expect(await openCards(f.issueId)).toEqual([]);
    // Much later: no stop was requested, so no receipt; still no card from the sweep.
    at(holdEndsAt + 30 * 60_000);
    await sweep(f);
    expect(await openCards(f.issueId)).toEqual([]);
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(kept!.status).toBe("active");
    expect(readPersonStopBoundDecision(kept!.metadata)).toMatchObject({ decision: "without_files" });
  });

  it("a card already open when the without_files decision is made is closed by that decision, not left open for good", async () => {
    const f = await fixture();
    at(STOP_AT + 5 * 60_000 + 1_000);
    // A card already raised (any writer; through the real writer, never a hand-made row).
    await db.transaction(async tx => recordTaskStopPending(tx as unknown as Db, { companyId: f.companyId, issueId: f.issueId,
      runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []));
    expect(await openCards(f.issueId)).toHaveLength(1);
    at(FAILING_SINCE + PERSON_STOP_EXPORT_BOUND_MS);
    expect(await decide(f)).toMatchObject({ decision: "without_files" });
    expect(await openCards(f.issueId)).toEqual([]);
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(rows.map(row => [row.status, row.outcome])).toEqual([["cancelled", "cancelled"]]);
    // It does not claim the Stop was proved.
    expect(rows[0]!.resolutionNote).not.toMatch(/Stop proved/);
  });

  it("twoclock3 (a): a card write after the decision committed (sweep read before it) writes no card", async () => {
    const f = await fixture();
    at(FAILING_SINCE + PERSON_STOP_EXPORT_BOUND_MS);
    // 1. the sweep's deferral read happened (no decision yet); 2. the decision
    // and its supersede commit (no card yet, nothing to supersede); 3. the
    // sweep's card writer runs under its task + run locks.
    expect(await decide(f)).toMatchObject({ decision: "without_files" });
    expect(await openCards(f.issueId)).toEqual([]);
    await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      await recordTaskStopPending(tx as unknown as Db, { companyId: f.companyId, issueId: f.issueId,
        runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []);
    });
    expect(await openCards(f.issueId)).toEqual([]);
  });

  it("twoclock3 (b): a failed supersede is logged as a run event and the next sweep closes the card", async () => {
    const f = await fixture();
    at(STOP_AT + 5 * 60_000 + 1_000);
    await db.transaction(async tx => recordTaskStopPending(tx as unknown as Db, { companyId: f.companyId, issueId: f.issueId,
      runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []));
    expect(await openCards(f.issueId)).toHaveLength(1);
    at(FAILING_SINCE + PERSON_STOP_EXPORT_BOUND_MS);
    seam.failSupersede = 1;
    expect(await decide(f)).toMatchObject({ decision: "without_files" });
    expect(seam.failSupersede).toBe(0);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    const failed = events.filter(event => event.eventType === "person_stop.card_supersede_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toMatch(/forced supersede failure/);
    expect(await openCards(f.issueId)).toHaveLength(1);
    // twoclock2 cleared the task's pointers with the decision, so the sweep no
    // longer visits this task. Put the execution pointer back on the stopped run
    // (a pointer that still names it) so the sweep's deferral is what runs next.
    await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    at(FAILING_SINCE + PERSON_STOP_EXPORT_BOUND_MS + 30_000);
    await sweep(f);
    expect(await openCards(f.issueId)).toEqual([]);
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(rows.map(row => [row.status, row.outcome])).toEqual([["cancelled", "cancelled"]]);
  });
});
