import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { recoveryService } from "../services/recovery/service.js";
import { lockEnvironmentLeaseAcquisitionParents } from "../services/environment-lease-acquisition-locks.js";
import { END_OF_RUN_RELEASE_GRACE_MS, STOP_CONFIRMATION_GRACE_MS } from "../services/recovery/stop-pending.js";

// Keep reason: Paul pressed Interrupt/Stop; the reply came, then a pink
// "RECOVERY ESCALATED · Stop pending (execution_stop_pending)" card appeared
// because the provider's stop confirmation lags the cancel by ~0.2-3 s.
// Real PostgreSQL rows through the real watchdog paths (stale-lock sweep and
// stranded-assignment reconcile), no mocked Stop verdict.
describe("stop-pending waits out the normal stop-confirmation window", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-pending-grace-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  const personStop = (at: Date) => ({ cancelledByActorType: "user", cancelledByUserId: "paul",
    executionCancellation: { state: "acknowledged", acknowledgedAt: at.toISOString() } });

  /** A person's acknowledged Stop of a managed remote run whose provider has not
   * yet written its termination receipt (the lease is still held). */
  async function fixture(path: "sweep" | "stranded", { stoppedAgoMs = 0, person = true, succeeded = false } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const stoppedAt = new Date(Date.now() - stoppedAgoMs);
    await db.insert(companies).values({ id: companyId, name: "Stop grace", issuePrefix: `G${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed GitHub agent", adapterType: "paperclip_runner",
      ...(path === "stranded"
        ? { status: "paused", pauseReason: "budget", lifecycleState: "pausing", lifecycleHolds: ["budget"] }
        : { status: "active", lifecycleState: "ready", lifecycleHolds: [] }),
      lifecycleRequiredPluginIds: [], lifecycleOperation: { id: randomUUID(), attempts: 1, hostComplete: false, completedPluginIds: [] } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      status: succeeded ? "succeeded" : "cancelled", runtimeMode: "native", executionStage: "settled", issueId, nativeIssueId: issueId, contextSnapshot: { issueId },
      startedAt: new Date(stoppedAt.getTime() - 60_000), finishedAt: stoppedAt,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: succeeded ? { stopReason: "completed" } : person ? personStop(stoppedAt) : { stopReason: "cancelled" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Interrupted chat", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date() });
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, status: "active",
      leasePolicy: "ephemeral", provider: "plugin:github:managed", providerLeaseId: `gh-${runId}`,
      // No known lifetime: the ordinary lease-TTL grace cannot cover this
      // tail, which is what let FINAL5e2's sweep open its card at +1.5 s.
      expiresAt: null,
      metadata: { driver: "plugin", pluginKey: "github", driverKey: "managed", agentId } }).returning();
    return { companyId, agentId, issueId, runId, lease: lease! };
  }
  async function receiptLands(f: Awaited<ReturnType<typeof fixture>>) {
    const [released] = await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, f.lease.id)).returning();
    await db.update(environmentLeases).set({ metadata: { ...released!.metadata, remoteExecutionTermination:
      remoteTerminationReceipt(released!, { providerLeaseId: released!.providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, f.lease.id));
  }
  async function stopCards(issueId: string) {
    return (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      .filter(action => action.cause === "execution_stop_pending" || action.evidence.stopPending !== undefined);
  }
  async function inspect(path: "sweep" | "stranded") {
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    if (path === "sweep") await recovery.sweepStaleIssueLocks();
    else await recovery.reconcileStrandedAssignedIssues();
  }
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Row (a): the receipt lands +0.5 s / +2 s / +3 s after the first inspection.
  // Stranded-assignment reconcile already skips a person-cancelled latest run
  // (it is not stranded), so the stale-lock sweep is the watchdog that showed
  // Paul's card; rows (a), (b) and (d) drive it. Row (c) drives both.
  it.each([
    ["sweep", 500], ["sweep", 2_000], ["sweep", 3_000],
  ] as const)("%s: a person's Stop confirmed +%ims later never shows a stop card", async (path, lag) => {
    const f = await fixture(path);
    await inspect(path);
    expect(await stopCards(f.issueId)).toEqual([]);
    // The claims stay held while unconfirmed: the grace is not Stop proof.
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
    await sleep(lag);
    await receiptLands(f);
    await inspect(path);
    expect(await stopCards(f.issueId)).toEqual([]);
  }, 30_000);

  // spgrace2 (rf-5 condition 3, MIXED LEASES): a person's Stop of a run that
  // also holds a LOCAL lease (local driver, environment-runtime.ts
  // acquireRunLease: ephemeral, provider "local"), released by the run's own
  // releaseRunLeases at the end of the run, plus the managed remote lease
  // whose receipt lands +2 s later: no card at any point.
  it("sweep: person Stop with a released local lease and a remote receipt at +2 s never shows a stop card", async () => {
    const f = await fixture("sweep");
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      status: "released", releasedAt: new Date(), cleanupStatus: "success", leasePolicy: "ephemeral", provider: "local",
      metadata: { driver: "local", agentId: f.agentId } });
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toEqual([]);
    await sleep(2_000);
    await receiptLands(f);
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toEqual([]);
    // The receipt completes Stop proof: the claims clear, so no card can come at the bound.
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: null, executionRunId: null });
  }, 30_000);
  // spgrace2 narrowing: a person's Stop whose LOCAL lease is still held is not
  // waiting on a remote confirmation; it cards at once as before spgrace.
  it("sweep: person Stop with a still-held local lease escalates at once", async () => {
    const f = await fixture("sweep");
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      status: "active", leasePolicy: "ephemeral", provider: "local", metadata: { driver: "local", agentId: f.agentId } });
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
  });

  // Row (b): the safety half. Never confirmed -> exactly one card after the bound.
  it.each(["sweep"] as const)("%s: a never-confirmed person Stop escalates once after the bound", async path => {
    const f = await fixture(path);
    await inspect(path);
    expect(await stopCards(f.issueId)).toEqual([]);
    // Time passes beyond the bound with no receipt.
    const past = new Date(Date.now() - STOP_CONFIRMATION_GRACE_MS - 1_000);
    await db.update(heartbeatRuns).set({ finishedAt: past, resultJson: personStop(past) }).where(eq(heartbeatRuns.id, f.runId));
    await inspect(path);
    await inspect(path);
    expect(await stopCards(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending", ownerType: "board" }]);
  });

  // Lead scope (FINAL5e2 card e4061c40): a SUCCEEDED run, first inspected 1.5 s
  // after finishing, whose lease is released in the ordinary end-of-run tail.
  async function backdate(f: { runId: string }, agoMs: number) {
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - agoMs) }).where(eq(heartbeatRuns.id, f.runId));
  }
  async function leaseReleased(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, f.lease.id));
  }
  it.each([2_000, 8_000, 20_000])("sweep: a succeeded run's lease released +%ims later never shows a stop card", async lag => {
    const f = await fixture("sweep", { succeeded: true, stoppedAgoMs: 1_500 });
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
    await backdate(f, 1_500 + lag); // the tail elapses with the lease still held
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toEqual([]);
    await leaseReleased(f);
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: null, executionRunId: null });
  });
  // rf-10: a distinct acquisition retakes the predecessor's task/run rows (FOR
  // NO KEY UPDATE, environment-lease-acquisition-locks.ts) during the
  // completion tail, so the sweep inspects only after it commits, with the
  // release further delayed. The grace reads finished_at and lease rows under
  // the sweep's own locks, which that acquisition does not hide.
  it("sweep: an acquisition holding the predecessor's rows in the tail shows no stop card", async () => {
    const f = await fixture("sweep", { succeeded: true, stoppedAgoMs: 1_500 });
    let releaseAcquisition!: () => void;
    const held = new Promise<void>(resolve => { releaseAcquisition = resolve; });
    let locked!: () => void;
    const lockedNow = new Promise<void>(resolve => { locked = resolve; });
    const acquisition = db.transaction(async tx => {
      await lockEnvironmentLeaseAcquisitionParents(tx as unknown as Db, { companyId: f.companyId,
        environmentId: randomUUID(), issueId: f.issueId, heartbeatRunId: f.runId });
      locked();
      await held;
    });
    await lockedNow;
    const sweep = inspect("sweep");
    await sleep(2_000);
    releaseAcquisition();
    await acquisition;
    await sweep;
    expect(await stopCards(f.issueId)).toEqual([]);
    await backdate(f, 10_000);
    await leaseReleased(f);
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: null, executionRunId: null });
  }, 30_000);
  it("sweep: a succeeded run's lease never released escalates once after the bound", async () => {
    const f = await fixture("sweep", { succeeded: true, stoppedAgoMs: 1_500 });
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toEqual([]);
    await backdate(f, END_OF_RUN_RELEASE_GRACE_MS + 1_000);
    await inspect("sweep");
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending", ownerType: "board" }]);
  });
  it("sweep: a succeeded run whose controller is still alive escalates as today", async () => {
    const f = await fixture("sweep", { succeeded: true, stoppedAgoMs: 1_500 });
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 600_000) }).where(eq(heartbeatRuns.id, f.runId));
    await inspect("sweep");
    expect(await stopCards(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
  });

  // Row (c): a cancel with no person Stop/Interrupt keeps today's immediate card.
  it.each(["sweep", "stranded"] as const)("%s: a non-person cancel escalates as today", async path => {
    const f = await fixture(path, { person: false });
    await inspect(path);
    expect(await stopCards(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
  });

  // Row (d): any other blocker (a live co-owner process) escalates as today,
  // even though the remote run alone would be inside its window.
  it.each(["sweep"] as const)("%s: a live process escalates as today", async path => {
    const f = await fixture(path), checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: checkoutRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "cancelled", runtimeMode: "legacy", executionStage: "settled",
      contextSnapshot: { issueId: f.issueId }, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      processPid: process.pid, resultJson: personStop(new Date()) });
    await db.update(issues).set({ checkoutRunId }).where(eq(issues.id, f.issueId));
    await inspect(path);
    expect(await stopCards(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
  });

  it("names a bound no shorter than the warm stop-receipt bound", async () => {
    const { handedOffWarmStopReceiptBound } = await import("../services/native-runtime/handed-off-warm-lease.js");
    expect(STOP_CONFIRMATION_GRACE_MS).toBe(handedOffWarmStopReceiptBound.ms);
  });
});
