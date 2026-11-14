import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { heartbeatService } from "../services/heartbeat.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { stopWarmSandboxesPastWindow, WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS, WARM_SANDBOX_IDLE_TIMEOUT_KEY } from "../services/warm-sandbox-expiry.js";
import { registerNativeWarmCloseDriver, type NativeWarmCloseDriver } from "../services/native-warm-close-driver.js";
import {
  NATIVE_WARM_CLOSE_GIVE_UP_AFTER_MS,
  NATIVE_WARM_CLOSE_MAX_FAILURES,
  NATIVE_WARM_CLOSE_RETRY_MS,
  sweepNativeWarmCloseOpeners,
} from "../services/native-warm-close-opener.js";
import * as providers from "../services/sandbox-provider-runtime.js";

/**
 * F2: the native warm stop gate needs a DURABLE opener. Only an in-process idle
 * close wrote the close receipt, so after a restart, a dead process, another
 * close path or a lost compare-and-swap a native box was never stopped. The
 * existing cleanup sweep now drives the close (through the executor's close
 * path) or, after a bounded time, records it failed and applies the explicit
 * backstop: one warning; a stop only with a checkpoint covering the last turn,
 * otherwise only once the lease TTL has passed.
 */
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WINDOW = 5 * MINUTE;
const SHA_B = `sha256:${"b".repeat(64)}`;
const FAILED_ACTION = "environment_lease.native_warm_close_failed";

let db!: ReturnType<typeof createDb>;
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Fixture = Awaited<ReturnType<typeof nativeWarm>>;

async function nativeWarm(input: { idleAgoMs: number; stamp?: boolean; close?: Record<string, unknown>; expiresAt?: Date | null }) {
  const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
  const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox://fake/${leaseId}`;
  const lastUsedAt = new Date(Date.now() - input.idleAgoMs);
  const finishedAt = new Date(lastUsedAt.getTime() - 5_000);
  await db.insert(companies).values({ id: companyId, name: "Opener", issuePrefix: `OP${companyId.slice(0, 3)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer", status: "idle",
    adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(environments).values({ id: environmentId, name: `Fake sandbox ${environmentId}`, driver: "sandbox", status: "active",
    config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true } });
  await db.insert(issues).values({ id: issueId, companyId, title: "Warm work" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "on_demand",
    status: "succeeded", finishedAt, nextEventSeq: 1 });
  const lease = await environmentService(db).acquireLease({ companyId, environmentId, issueId,
    heartbeatRunId: runId, leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
    metadata: { agentId, driver: "sandbox", provider: "fake", image: "ubuntu:24.04", reuseLease: true,
      [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: WINDOW, reusableSandboxLease: { adapterType: "paperclip_runner" } } });
  const stamp = { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: "native-session",
    runnerInstanceId: "runner", sessionScopeSha256: "a".repeat(64), sourceProviderLeaseId: providerLeaseId,
    authorizedProviderLeaseId: providerLeaseId, manifestSha256: SHA_B, completedAt: new Date(finishedAt.getTime() + 10).toISOString() };
  await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "success", lastUsedAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    metadata: { ...lease.metadata, ...(input.stamp === false ? {} : { nativeHarnessBackup: stamp }),
      ...(input.close ? { warmNativeSessionClose: { schema: "paperclip.native-warm-session-close.v1",
        providerLeaseId, runId, ...input.close } } : {}) },
  }).where(eq(environmentLeases.id, lease.id));
  return { companyId, agentId, environmentId, issueId, runId, leaseId: lease.id, providerLeaseId, finishedAt, stamp, lastUsedAt };
}

async function saved(id: string) {
  return (await environmentService(db).getLeaseById(id))!;
}

function closeReceipt(lease: { metadata: Record<string, unknown> | null }) {
  return (lease.metadata?.warmNativeSessionClose ?? null) as Record<string, any> | null;
}

async function warnings(f: Fixture) {
  return db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, FAILED_ACTION)));
}

/** What the executor's close receipt writer records after a confirmed close. */
async function writeClosedReceipt(f: Fixture) {
  const lease = await saved(f.leaseId);
  await db.update(environmentLeases).set({ metadata: { ...lease.metadata, warmNativeSessionClose: {
    schema: "paperclip.native-warm-session-close.v1", state: "closed", closedAt: new Date().toISOString(),
    providerLeaseId: f.providerLeaseId, runId: f.runId, normalizedSessionId: "native-session", manifestSha256: SHA_B } } })
    .where(eq(environmentLeases.id, f.leaseId));
}

async function sweep() {
  return heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) }).sweepPendingCleanupLeases({ backoffMs: 0 });
}

suite("F2: a durable opener for the native warm stop gate in the cleanup sweep", () => {
  const restores: Array<() => void> = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-warm-close-opener-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    while (restores.length) restores.pop()!();
    vi.restoreAllMocks();
    // Each test gets its own company; clear leases so later sweeps see only their own rows.
    await db.delete(environmentLeases);
  });

  function drive(fn: NativeWarmCloseDriver) {
    const driver = vi.fn(fn);
    restores.push(registerNativeWarmCloseDriver(driver));
    return driver;
  }
  function stopSpy() {
    return vi.spyOn(providers.requireSandboxProvider("fake"), "stopLease");
  }

  it("server restarted before the idle timer, owner held here: the sweep drives the close, then stops the box", async () => {
    const f = await nativeWarm({ idleAgoMs: WINDOW + WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS + MINUTE });
    const stop = stopSpy();
    const driver = drive(async (lease) => {
      expect(lease).toMatchObject({ leaseId: f.leaseId, companyId: f.companyId, runId: f.runId, providerLeaseId: f.providerLeaseId });
      await writeClosedReceipt(f);
      return { outcome: "closed" };
    });
    await sweep();
    expect(driver).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(await saved(f.leaseId)).toMatchObject({ status: "released" });
    expect(await warnings(f)).toHaveLength(0);
  });

  it("reconciles a native warm sandbox left running across a restart (no owner anywhere): bounded, then the checkpoint backstop stops it", async () => {
    // The real executor driver: this process holds no warm session for the box.
    const f = await nativeWarm({ idleAgoMs: 35 * HOUR });
    const stop = stopSpy();
    // At boot the cleanup worker's first pass finds the native leak due now.
    expect(await nextEnvironmentCleanupAt(db)).toBeLessThanOrEqual(Date.now());
    await sweep();
    expect(stop).toHaveBeenCalledOnce();
    const lease = await saved(f.leaseId);
    expect(lease.status).toBe("released");
    expect(closeReceipt(lease)).toMatchObject({ state: "failed", warningCount: 1,
      backstop: { kind: "checkpoint", manifestSha256: SHA_B, normalizedSessionId: "native-session" } });
    expect(await warnings(f)).toHaveLength(1);
    await sweep();
    expect(stop).toHaveBeenCalledOnce();
    expect(await warnings(f)).toHaveLength(1);
  });

  it("a close stuck in 'closing' (dead process) without a checkpoint: waits (with a wake scheduled), then fails once and waits for the TTL", async () => {
    const f = await nativeWarm({ idleAgoMs: WINDOW + WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS + MINUTE, stamp: false,
      close: { state: "closing", attempts: 1 } });
    const stop = stopSpy();
    await sweep();
    expect(stop).not.toHaveBeenCalled();
    let lease = await saved(f.leaseId);
    expect(lease.status).toBe("retained");
    expect(closeReceipt(lease)?.state).not.toBe("failed");
    // Unlike before, a wake is scheduled: the opener comes back on its own.
    expect(await nextEnvironmentCleanupAt(db)).not.toBeNull();

    // Past the bound: the close is recorded failed with one warning, and with
    // no checkpoint covering the last turn the box waits for its TTL.
    // (The clock jumps: the window ended long ago and the opener's next attempt is due.)
    await db.update(environmentLeases).set({ lastUsedAt: new Date(Date.now() - 35 * HOUR),
      metadata: sql`jsonb_set(${environmentLeases.metadata}, '{warmNativeSessionClose,openerNextAt}', '0'::jsonb)` })
      .where(eq(environmentLeases.id, f.leaseId));
    await sweep();
    lease = await saved(f.leaseId);
    expect(stop).not.toHaveBeenCalled();
    expect(lease.status).toBe("retained");
    expect(closeReceipt(lease)).toMatchObject({ state: "failed", warningCount: 1, backstop: { kind: "ttl_wait" } });
    expect(await warnings(f)).toHaveLength(1);
    await sweep();
    expect(stop).not.toHaveBeenCalled();
    expect(await warnings(f)).toHaveLength(1);

    // The lease TTL passes: the explicit TTL backstop stops the box, with no second warning.
    await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - MINUTE) }).where(eq(environmentLeases.id, f.leaseId));
    await sweep();
    expect(stop).toHaveBeenCalledOnce();
    expect(closeReceipt(await saved(f.leaseId))).toMatchObject({ state: "failed", backstop: { kind: "ttl" } });
    expect(await warnings(f)).toHaveLength(1);
  });

  it("a close stuck in 'closing' (dead process) WITH a checkpoint covering the last turn: bounded, then the checkpoint backstop stops it", async () => {
    const f = await nativeWarm({ idleAgoMs: 35 * HOUR, close: { state: "closing", attempts: 1 } });
    const stop = stopSpy();
    await sweep();
    expect(stop).toHaveBeenCalledOnce();
    expect(closeReceipt(await saved(f.leaseId))).toMatchObject({ state: "failed", backstop: { kind: "checkpoint" } });
    expect(await warnings(f)).toHaveLength(1);
  });

  it("F5: a busy agent directory never burns the close retry budget nor triggers the give-up", async () => {
    const f = await nativeWarm({ idleAgoMs: 35 * HOUR });
    let outcome: "busy" | "failed" = "busy";
    const driver = drive(async () => ({ outcome }));
    let now = Date.now();
    for (let i = 0; i < NATIVE_WARM_CLOSE_MAX_FAILURES + 3; i++) {
      await sweepNativeWarmCloseOpeners(db, new Date(now));
      now += NATIVE_WARM_CLOSE_RETRY_MS + 1;
    }
    expect(driver).toHaveBeenCalledTimes(NATIVE_WARM_CLOSE_MAX_FAILURES + 3);
    let receipt = closeReceipt(await saved(f.leaseId));
    expect(receipt?.state).not.toBe("failed");
    expect(receipt?.openerFailures ?? 0).toBe(0);
    expect(await warnings(f)).toHaveLength(0);

    // Real failures count, and only they spend the budget.
    outcome = "failed";
    for (let i = 0; i < NATIVE_WARM_CLOSE_MAX_FAILURES; i++) {
      receipt = closeReceipt(await saved(f.leaseId));
      expect(receipt?.state).not.toBe("failed");
      await sweepNativeWarmCloseOpeners(db, new Date(now));
      now += NATIVE_WARM_CLOSE_RETRY_MS + 1;
    }
    expect(closeReceipt(await saved(f.leaseId))).toMatchObject({ state: "failed", warningCount: 1,
      openerFailures: NATIVE_WARM_CLOSE_MAX_FAILURES, backstop: { kind: "checkpoint" } });
    expect(await warnings(f)).toHaveLength(1);
  });

  it("F6: a Runner adopted by another owner is never closed by the sweep", async () => {
    const f = await nativeWarm({ idleAgoMs: 35 * HOUR });
    // A successor run adopted the released Runner on the same sandbox.
    const successorRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorRun, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      invocationSource: "on_demand", status: "running", nextEventSeq: 1 });
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId,
      heartbeatRunId: successorRun, status: "active", leasePolicy: "reuse_by_environment", provider: "fake",
      providerLeaseId: f.providerLeaseId, metadata: { reusableSandboxLease: { adapterType: "paperclip_runner" },
        [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: WINDOW } });
    const before = await saved(f.leaseId);
    const stop = stopSpy();
    const driver = drive(async () => ({ outcome: "closed" }));
    await sweep();
    await sweepNativeWarmCloseOpeners(db, new Date(Date.now() + HOUR));
    expect(driver).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(await saved(f.leaseId)).toEqual(before);
    expect(await warnings(f)).toHaveLength(0);
  });

  it("F6: a released Runner this process does not own (another owner may adopt it) is not closed, and no failure is counted", async () => {
    const f = await nativeWarm({ idleAgoMs: WINDOW + WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS + MINUTE });
    const driver = drive(async () => ({ outcome: "not_owned" }));
    await sweepNativeWarmCloseOpeners(db);
    expect(driver).toHaveBeenCalledOnce();
    const receipt = closeReceipt(await saved(f.leaseId));
    expect(receipt?.state).not.toBe("failed");
    expect(receipt?.openerFailures ?? 0).toBe(0);
    expect((await saved(f.leaseId)).status).toBe("retained");
  });

  it("ORG 15:08Z guard: a box stopped for good stays released 'stopped and kept'; no sweep re-acquires it", async () => {
    const f = await nativeWarm({ idleAgoMs: WINDOW + WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS + MINUTE });
    await writeClosedReceipt(f);
    const stop = stopSpy();
    const acquire = vi.spyOn(providers.requireSandboxProvider("fake"), "acquireLease");
    const resume = vi.spyOn(providers.requireSandboxProvider("fake"), "resumeLease");
    await sweep();
    expect(stop).toHaveBeenCalledOnce();
    const stopped = await saved(f.leaseId);
    expect(stopped).toMatchObject({ status: "released" });
    for (let i = 0; i < 3; i++) {
      await sweep();
      await stopWarmSandboxesPastWindow(db, new Date(Date.now() + 48 * HOUR));
      await sweepNativeWarmCloseOpeners(db, new Date(Date.now() + 48 * HOUR));
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(await saved(f.leaseId)).toMatchObject({ status: "released" });
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, f.providerLeaseId));
    expect(rows).toHaveLength(1);
  });
});

// Keep the constant referenced: the bound is part of the contract this file tests.
void NATIVE_WARM_CLOSE_GIVE_UP_AFTER_MS;
