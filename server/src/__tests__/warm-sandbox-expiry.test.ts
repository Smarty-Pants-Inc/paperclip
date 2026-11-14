import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.js";
import {
  nextWarmSandboxStopAt,
  stopWarmSandboxesPastWindow,
  WARM_SANDBOX_IDLE_TIMEOUT_KEY,
  warmSandboxWindowMetadata,
} from "../services/warm-sandbox-expiry.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

suite("warm sandbox expiry", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let environmentId = "";
  let issueId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-warm-sandbox-expiry-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); environmentId = randomUUID(); issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "WSE",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm work" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function run(status: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, invocationSource: "on_demand", status, nextEventSeq: 1 });
    return id;
  }

  async function row(id: string) {
    const [found] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, id));
    return found!;
  }

  /** The end state of a warm run: its reusable lease is retained and the
   * sandbox kept running for the next turn. */
  async function warmRetained(input: { releasedAgoMs: number; windowMs?: number | null; runStatus?: string;
    providerLeaseId?: string }) {
    const id = randomUUID(), now = Date.now();
    const runId = await run(input.runStatus ?? "succeeded");
    await db.insert(environmentLeases).values({ id, companyId, environmentId, issueId, heartbeatRunId: runId,
      status: "retained", cleanupStatus: "success", leasePolicy: "reuse_by_environment", provider: "fake",
      providerLeaseId: input.providerLeaseId ?? `sandbox://fake/${id}`,
      acquiredAt: new Date(now - input.releasedAgoMs - MINUTE), lastUsedAt: new Date(now - input.releasedAgoMs),
      metadata: { provider: "fake", reuseLease: true,
        ...(input.windowMs === null ? {} : warmSandboxWindowMetadata(input.windowMs ?? 5 * MINUTE)) } });
    return id;
  }

  it("keeps a sandbox still inside its warm window, and wakes when the window ends", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 2 * MINUTE, windowMs: 5 * MINUTE });
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);

    const windowEnd = before.lastUsedAt.getTime() + 5 * MINUTE;
    expect(await nextWarmSandboxStopAt(db)).toBe(windowEnd);
    // The cleanup worker sleeps until exactly that deadline: no interval scan.
    expect(await nextEnvironmentCleanupAt(db)).toBe(windowEnd);
  });

  it("does not stop an expired native warm lease before its checkpoint is durable", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 6 * MINUTE, windowMs: 5 * MINUTE });
    const before = await row(leaseId);
    await db.update(environmentLeases).set({ metadata: { ...before.metadata,
      reusableSandboxLease: { adapterType: "paperclip_runner" } } }).where(eq(environmentLeases.id, leaseId));

    // An elapsed warm window only makes the lease eligible for quiescence. It
    // cannot prove the native checkpoint was published or the session closed.
    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect((await row(leaseId)).status).toBe("retained");
    expect((await row(leaseId)).metadata?.sandboxStopAndRetain).toBeUndefined();
  });

  it("stops a sandbox once its warm window has passed and keeps it for the next turn", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 6 * MINUTE, windowMs: 5 * MINUTE });

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 1 });
    const stopping = await row(leaseId);
    expect(stopping).toMatchObject({ status: "pending_cleanup", failureReason: "sandbox_stop_pending" });
    expect(stopping.metadata?.sandboxStopAndRetain).toMatchObject({ warmWindowExpired: true, leaseId });
    // Its first stop is due now, not after the retry backoff.
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });

  it("stops the sandbox at the provider through the cleanup sweep", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 6 * MINUTE, windowMs: 5 * MINUTE });
    const teardown = vi.fn(async ({ lease }: { lease: { providerLeaseId: string | null } }) =>
      ({ providerLeaseId: lease.providerLeaseId, state: "stopped" }));

    await heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: teardown } as unknown as HeartbeatEnvironmentRuntime })
      .sweepPendingCleanupLeases({ backoffMs: 5 * MINUTE });

    expect(teardown).toHaveBeenCalledOnce();
    const stopped = await row(leaseId);
    // Stopped and kept: a reusable lease the next run on the task resumes.
    expect(stopped).toMatchObject({ status: "released", cleanupStatus: "success", leasePolicy: "reuse_by_environment" });
    expect(stopped.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped" });
    expect(stopped.metadata?.sandboxStopAndRetain).toBeUndefined();
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
  });

  it("keeps a sandbox past its window while a live run holds it", async () => {
    const providerLeaseId = `sandbox://fake/${randomUUID()}`;
    const leaseId = await warmRetained({ releasedAgoMs: 6 * MINUTE, providerLeaseId });
    const liveRun = await run("running");
    await db.insert(environmentLeases).values({ companyId, environmentId, issueId, heartbeatRunId: liveRun,
      status: "active", leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
      metadata: { provider: "fake", reuseLease: true } });
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);
    // A held sandbox is no deadline; the live run's release wakes the worker.
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });

  it("keeps a sandbox past its window while a run on the task is starting", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 6 * MINUTE });
    await run("running");
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);
  });

  it("keeps a sandbox whose own run has not ended", async () => {
    const leaseId = await warmRetained({ releasedAgoMs: 6 * MINUTE, runStatus: "running" });

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect((await row(leaseId)).status).toBe("retained");
  });

  it("leaves a plugin Runner task lease to its own cleanup", async () => {
    // Its release path does not use the stop-only contract, so expiry must not
    // hand it over: the plugin could free the allocation and the task's files.
    const leaseId = await warmRetained({ releasedAgoMs: 6 * MINUTE });
    await db.update(environmentLeases).set({ metadata: { driver: "plugin", pluginId: "fake-plugin",
      runnerTaskLease: true, [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: 5 * MINUTE } }).where(eq(environmentLeases.id, leaseId));
    const before = await row(leaseId);

    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 0 });
    expect(await row(leaseId)).toEqual(before);
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });

  it("reconciles a warm sandbox left running across a restart", async () => {
    // Retained before the warm window was recorded, 35 hours ago: past the
    // longest window any run can configure.
    const leaked = await warmRetained({ releasedAgoMs: 35 * HOUR, windowMs: null });
    // Retained an hour ago with no recorded window: it could still be warm.
    const recent = await warmRetained({ releasedAgoMs: HOUR, windowMs: null });

    // At boot the cleanup worker's first pass finds the leak due now.
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    const teardown = vi.fn(async ({ lease }: { lease: { providerLeaseId: string | null } }) =>
      ({ providerLeaseId: lease.providerLeaseId, state: "stopped" }));
    await heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: teardown } as unknown as HeartbeatEnvironmentRuntime })
      .sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(teardown).toHaveBeenCalledOnce();
    expect(await row(leaked)).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect((await row(recent)).status).toBe("retained");
    const recentRow = await row(recent);
    expect(await nextWarmSandboxStopAt(db)).toBe(recentRow.lastUsedAt.getTime() + 24 * HOUR);
  });

  // Keep: data safety and the pre-upgrade provider-expired warm-lease leak.
  // Use the real PostgreSQL deadline/cleanup path; only provider I/O is controlled.
  async function providerExpiredLegacyLease() {
    const leaseId = await warmRetained({ releasedAgoMs: HOUR, windowMs: null, runStatus: "failed" });
    const expiresAt = new Date(Date.now() - 27 * MINUTE);
    const savedState = { checkpoint: "saved-task-work" };
    const before = await row(leaseId);
    await db.update(environmentLeases).set({ expiresAt,
      metadata: { ...before.metadata, savedState } }).where(eq(environmentLeases.id, leaseId));
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board",
      cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(),
      evidence: { runId: before.heartbeatRunId }, nextAction: "Reconcile, then continue saved work." });
    return { leaseId, expiresAt, actionId, savedState };
  }

  it("bounds a pre-upgrade warm deadline by provider expiry despite an active board recovery action", async () => {
    const { leaseId, expiresAt } = await providerExpiredLegacyLease();
    const retained = await row(leaseId);
    expect(retained.metadata?.[WARM_SANDBOX_IDLE_TIMEOUT_KEY]).toBeUndefined();
    // Without the provider bound this row waits another 23 hours after upgrade.
    expect(retained.lastUsedAt.getTime() + 24 * HOUR).toBeGreaterThan(Date.now());
    expect(await nextWarmSandboxStopAt(db)).toBe(expiresAt.getTime());
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    expect((await row(leaseId)).status).toBe("retained");
  });

  it("stops and retains a provider-expired pre-upgrade lease on its first sweep without closing board recovery", async () => {
    const { leaseId, actionId, savedState } = await providerExpiredLegacyLease();
    const transitions: string[] = [];
    const teardown = vi.fn(async ({ lease }: { lease: typeof environmentLeases.$inferSelect }) => {
      const pending = await row(leaseId);
      transitions.push(pending.status);
      expect(pending).toMatchObject({ status: "pending_cleanup", failureReason: "sandbox_stop_pending" });
      expect(lease.metadata?.sandboxStopAndRetain).toMatchObject({ leaseId, warmWindowExpired: true });
      return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
    });
    const destroy = vi.fn();
    const service = heartbeatService(db, { environmentRuntime: {
      retryPendingSandboxTeardown: teardown, destroyRunLease: destroy,
    } as unknown as HeartbeatEnvironmentRuntime });
    await service.sweepPendingCleanupLeases({ backoffMs: 5 * MINUTE });
    const stopped = await row(leaseId);
    transitions.push(stopped.status);
    expect(transitions).toEqual(["pending_cleanup", "released"]);
    expect(teardown).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    expect(stopped).toMatchObject({ cleanupStatus: "success", leasePolicy: "reuse_by_environment" });
    expect(stopped.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped", leaseId });
    expect(stopped.metadata?.sandboxStopAndRetainReceipt).toMatchObject({ leaseId,
      providerLeaseId: stopped.providerLeaseId });
    expect(stopped.metadata?.sandboxStopAndRetain).toBeUndefined();
    expect(stopped.metadata?.savedState).toEqual(savedState);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "active", ownerType: "board" });
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
    await service.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(teardown).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each([2 * MINUTE, 10 * MINUTE])("uses the earlier saved warm window or provider expiry (%i ms)", async providerRemainingMs => {
    const leaseId = await warmRetained({ releasedAgoMs: 2 * MINUTE, windowMs: 5 * MINUTE });
    const expiresAt = new Date(Date.now() + providerRemainingMs);
    await db.update(environmentLeases).set({ expiresAt }).where(eq(environmentLeases.id, leaseId));
    const retained = await row(leaseId);
    expect(await nextWarmSandboxStopAt(db)).toBe(Math.min(retained.lastUsedAt.getTime() + 5 * MINUTE, expiresAt.getTime()));
  });

  it("records the run's warm window on the lease only for a warm run", () => {
    expect(warmSandboxWindowMetadata(7 * MINUTE)).toEqual({ [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: 7 * MINUTE });
    expect(warmSandboxWindowMetadata(undefined)).toEqual({});
    expect(warmSandboxWindowMetadata(0)).toEqual({});
  });
});
