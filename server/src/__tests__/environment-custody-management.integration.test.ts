import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { settleOwnableKind } from "../services/recovery/ownership-invariant-report.js";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";
import { environmentService } from "../services/environments.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { nativeCustodyKeptRecovery } from "../services/native-runtime/native-lease-custody.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const SIX_HOURS = 6 * 60 * 60_000;

describe.skipIf(!support.supported)("environment management keeps unaddressable native custody visible", () => {
  let db: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | undefined;
  let app: express.Express;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-custody-management");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "custody-operator", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", environmentRoutes(db));
    app.use(errorHandler);
  });
  afterAll(async () => {
    // End this suite's pool before dropping its disposable database.
    await db?.$client.end({ timeout: 1 });
    await stopDb?.();
  });

  async function seed(leasePolicy: "ephemeral" | "reuse_by_execution_workspace" | "reuse_by_environment" | "retain_on_failure") {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), runId = randomUUID();
    const boxId = `box-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Custody accounting", issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 12).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox", config: { provider: "fixture" } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native" });
    const lease = await environmentService(db).acquireLease({ companyId, environmentId, heartbeatRunId: runId,
      leasePolicy, provider: "fixture", providerLeaseId: `lease-${randomUUID()}`,
      metadata: { runnerTaskLease: true, sandboxId: boxId } });
    return { lease, environmentId, companyId, runId, boxId };
  }

  // Persist the historical obligation as input, independently of the repair's
  // producer. The unpinned suite exercises the real sweep/release producer.
  async function settleUnaddressableNativeCustody(_db: typeof db,
    lease: typeof environmentLeases.$inferSelect, recovery: Record<string, unknown>) {
    const now = new Date();
    const [retained] = await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "failed",
      failureReason: "native_custody_stop_unavailable", releasedAt: null,
      metadata: { ...lease.metadata,
        orphanedRunLeaseRecovery: { ...recovery, runId: lease.heartbeatRunId, recoveredAt: now.toISOString(),
          disposition: "retained_unstoppable", reason: "provider_plugin_pin_missing" },
        replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId: lease.heartbeatRunId,
          predecessorRunId: null, recordedAt: now.toISOString() },
        pendingCleanupInFlight: false, pendingCleanupLeaseExpiresAtMs: 0 } })
      .where(eq(environmentLeases.id, lease.id)).returning();
    return retained!;
  }

  it.each(["reuse_by_execution_workspace", "reuse_by_environment", "ephemeral", "retain_on_failure"] as const)(
    "counts retained custody under %s and refuses the real DELETE, even with teardown consent", async policy => {
      const { lease, environmentId } = await seed(policy);
      const retained = await settleUnaddressableNativeCustody(db, lease, nativeCustodyKeptRecovery());
      expect(retained).not.toBeNull();
      expect(retained).toMatchObject({ status: "retained", releasedAt: null, cleanupStatus: "failed" });
      const summary = await request(app).get(`/api/environments/${environmentId}/delete-blast-radius`);
      // Exercise the real route even on red: a wrong summary must not hide
      // whether DELETE actually loses the retained holder's environment.
      const deletedResponses: { query: string; status: number; error?: string; deleteBlockedReasons?: string[] }[] = [];
      for (const query of ["", "?destroyReusableSandboxLeases=true"]) {
        const deleted = await request(app).delete(`/api/environments/${environmentId}${query}`);
        deletedResponses.push({ query, status: deleted.status, error: deleted.body.error,
          deleteBlockedReasons: deleted.body.details?.deleteBlockedReasons });
      }
      console.log("CUSTODY_MANAGEMENT_PROOF", JSON.stringify({ leaseId: lease.id, leasePolicy: policy,
        summary: summary.body, deletes: deletedResponses }));
      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({ canDelete: false, reusableSandboxLeaseCount: 1,
        deleteBlockedReasons: ["reusable_sandbox_lease"], reusableSandboxLeaseHolders: [{ leaseId: lease.id, leasePolicy: policy }] });
      expect(await environmentService(db).removeIfDeletable(environmentId)).toBeNull();
      for (const deleted of deletedResponses) {
        expect(deleted.status).toBe(409);
        expect(deleted.deleteBlockedReasons).toContain("reusable_sandbox_lease");
        expect(deleted.error).toMatch(/custody/i);
        expect(deleted.error).not.toMatch(/stopped sandbox/i);
      }
      const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(after).toEqual(retained);
      expect(await environmentService(db).getById(environmentId)).not.toBeNull();
    },
  );

  it.each(["reuse_by_execution_workspace", "ephemeral"] as const)(
    "does not count an ordinary released %s lease and permits the real DELETE", async policy => {
      const { lease, environmentId } = await seed(policy);
      await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
      const summary = await request(app).get(`/api/environments/${environmentId}/delete-blast-radius`);
      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({ canDelete: true, reusableSandboxLeaseCount: 0,
        reusableSandboxLeaseHolders: [], deleteBlockedReasons: [] });
      expect((await request(app).delete(`/api/environments/${environmentId}`)).status).toBe(200);
      expect(await environmentService(db).getById(environmentId)).toBeNull();
      const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(after).toMatchObject({ status: "released", environmentId: null });
    },
  );

  function alarmSpy(providerLeaseId: string) {
    const warn = vi.spyOn(logger, "warn");
    return { warn, lines: (alarm: string) => warn.mock.calls.filter(([fields, msg]) =>
      typeof msg === "string" && msg.startsWith("custody_unpinned_alarm")
      && (fields as { providerLeaseId?: string }).providerLeaseId === providerLeaseId
      && (fields as { alarm?: string }).alarm === alarm) };
  }

  it("5 failures emit exactly one first alarm; concurrent 6th/7th sweeps do not repeat it", async () => {
    const { lease, companyId, runId, boxId } = await seed("reuse_by_execution_workspace");
    await settleUnaddressableNativeCustody(db, lease, nativeCustodyKeptRecovery());
    const { warn, lines } = alarmSpy(lease.providerLeaseId!);
    const sweep = () => settleOwnableKind(db, "environment_retained_orphan_sandbox", { runIds: [runId] });
    try {
      for (let i = 0; i < 4; i++) await sweep();
      expect(lines("first")).toHaveLength(0);
      await sweep();
      expect(lines("first")).toHaveLength(1);
      expect(lines("first")[0]![0]).toMatchObject({ companyId, boxId, providerLeaseId: lease.providerLeaseId, alarm: "first", attempts: 5 });
      await Promise.all([sweep(), sweep()]);
      expect(lines("first")).toHaveLength(1);
      const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      expect(kept).toMatchObject({ status: "retained", metadata: { nativeCustodyAttempts: 5, nativeCustodyEscalated: true } });
      // Another retained row for the same paid box must not repeat the alarm.
      // Leave its counters unset, as in a historical independent holder.
      const { nativeCustodyAttempts: _attempts, nativeCustodyEscalated: _escalated,
        nativeCustodyFirstAlarm: _alarm, ...metadata } = kept!.metadata!;
      await db.insert(environmentLeases).values({ ...kept!, id: randomUUID(), metadata });
      for (let i = 0; i < 5; i++) await sweep();
      expect(lines("first")).toHaveLength(1);
      console.log("CUSTODY_ALARM_PROOF", JSON.stringify({ first: lines("first").map(([fields, msg]) => ({ ...fields as object, msg })) }));
    } finally { warn.mockRestore(); }
  });

  async function expiryFixture(mode: "exact" | "box_mismatch" | "lease_mismatch" | "provider_mismatch" | "ambiguous" | "stop_refused") {
    const seeded = await seed("reuse_by_execution_workspace");
    const { lease, environmentId, runId, boxId } = seeded;
    const retained = (await settleUnaddressableNativeCustody(db, lease, nativeCustodyKeptRecovery()))!;
    const pluginId = randomUUID(), driverKey = `custody-expiry-${pluginId}`, pluginKey = `paperclip.${driverKey}`;
    const manifest = { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Custody expiry", description: "Test provider",
      author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey, kind: "sandbox_provider",
        displayName: "Custody expiry", configSchema: { type: "object" } }] };
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, manifestJson: manifest } as never);
    if (mode === "ambiguous") await db.insert(plugins).values({ id: randomUUID(), pluginKey: `${pluginKey}.twin`,
      packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0", apiVersion: 1, categories: ["automation"],
      status: "disabled", installOrder: 2, manifestJson: { ...manifest, id: `${pluginKey}.twin` } } as never);
    await db.update(environments).set({ config: { provider: mode === "provider_mismatch" ? "different-provider" : driverKey,
      image: "fake:current", account: "current-account" } }).where(eq(environments.id, environmentId));
    // Deliberately NO pluginId or historical config on the lease. Resolve through current configuration only.
    await db.update(environmentLeases).set({ provider: driverKey }).where(eq(environmentLeases.id, lease.id));
    const calls: Array<{ method: string; box?: string }> = [];
    const manager = { isRunning: vi.fn(() => true), getWorker: vi.fn(() => ({ supportedMethods: ["environmentInspectLease", "environmentStopLease"] })),
      call: vi.fn(async (id: string, method: string, params: { providerLeaseId?: string; config?: Record<string, unknown> }) => {
        expect(id).toBe(pluginId);
        expect(params.config).toMatchObject({ image: "fake:current", account: "current-account" });
        calls.push({ method, box: params.providerLeaseId });
        if (method === "environmentInspectLease") return { providerLeaseId: mode === "lease_mismatch" ? "another-lease" : lease.providerLeaseId,
          boxId: mode === "box_mismatch" ? "someone-elses-paid-box" : boxId, state: "active" };
        if (method === "environmentStopLease") {
          if (mode === "stop_refused") throw new Error("Provider refused stop");
          console.log("CUSTODY_PROVIDER_STOP", JSON.stringify({ lookupLeaseId: params.providerLeaseId,
            boxId: mode === "box_mismatch" ? "someone-elses-paid-box" : boxId }));
          return { providerLeaseId: params.providerLeaseId, state: "stopped" };
        }
        throw new Error(`Forbidden provider call: ${method}`);
      }) } as unknown as PluginWorkerManager;
    const recoveredAt = new Date((retained.metadata!.orphanedRunLeaseRecovery as { recoveredAt: string }).recoveredAt);
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager });
    const sweep = (ageMs: number) => settleOwnableKind(db, "environment_retained_orphan_sandbox", {
      runIds: [runId], now: new Date(recoveredAt.getTime() + ageMs), stopRetainedCustody: runtime.stopRetainedCustodyLease,
    });
    return { ...seeded, calls, sweep, manager };
  }

  it("after six hours exact current-provider resolve stops once, never releases/destroys, and stays retained and counted", async () => {
    const { lease, environmentId, calls, sweep } = await expiryFixture("exact");
    await sweep(SIX_HOURS - 1);
    expect(calls).toEqual([]);
    await Promise.all([sweep(SIX_HOURS), sweep(SIX_HOURS)]);
    expect(calls.map(call => call.method)).toEqual(["environmentInspectLease", "environmentStopLease"]);
    for (let i = 0; i < 7; i++) await sweep(SIX_HOURS + 60_000);
    expect(calls).toHaveLength(2);
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(kept).toMatchObject({ status: "retained", releasedAt: null, cleanupStatus: "failed",
      metadata: { orphanedRunLeaseRecovery: { nativeCustodyUnverified: true }, nativeCustodyExpiry: { state: "stopped" } } });
    expect(kept!.metadata?.orphanedRunLeaseRecovery).toMatchObject({ disposition: "retained_unstoppable" });
    expect(await environmentService(db).getDeleteBlastRadius(environmentId)).toMatchObject({ canDelete: false, reusableSandboxLeaseCount: 1 });
    expect((await request(app).delete(`/api/environments/${environmentId}?destroyReusableSandboxLeases=true`)).status).toBe(409);
    console.log("CUSTODY_EXPIRY_PROOF", JSON.stringify({ leaseId: lease.id, calls, status: kept!.status, expiry: kept!.metadata!.nativeCustodyExpiry }));
  });

  it.each(["box_mismatch", "lease_mismatch", "provider_mismatch", "ambiguous", "stop_refused"] as const)(
    "expiry %s is refused, emits one manual_stop alarm, and never stops another box or destroys", async mode => {
      const { lease, companyId, boxId, environmentId, calls, sweep } = await expiryFixture(mode);
      const { warn, lines } = alarmSpy(lease.providerLeaseId!);
      try {
        for (let i = 0; i < 5; i++) await sweep(SIX_HOURS - 1);
        expect(lines("first")).toHaveLength(1);
        expect(lines("manual_stop")).toHaveLength(0);
        await sweep(SIX_HOURS);
        expect(lines("manual_stop")).toHaveLength(1);
        expect(lines("manual_stop")[0]![0]).toMatchObject({ companyId, boxId, providerLeaseId: lease.providerLeaseId, alarm: "manual_stop" });
        await Promise.all([sweep(SIX_HOURS + 60_000), sweep(SIX_HOURS + 60_000)]);
        expect(lines("first")).toHaveLength(1);
        expect(lines("manual_stop")).toHaveLength(1);
        expect(calls.filter(call => call.method === "environmentInspectLease")).toHaveLength(
          mode === "box_mismatch" || mode === "lease_mismatch" || mode === "stop_refused" ? 1 : 0);
        expect(calls.filter(call => call.method === "environmentStopLease")).toHaveLength(mode === "stop_refused" ? 1 : 0);
        expect(calls.filter(call => /Destroy|Release|Acquire|Resume/.test(call.method))).toEqual([]);
        const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
        expect(kept).toMatchObject({ status: "retained", releasedAt: null, metadata: { nativeCustodyExpiry: { state: "manual_stop" } } });
        expect(kept!.metadata?.orphanedRunLeaseRecovery).toMatchObject({ disposition: "retained_unstoppable" });
        expect(await environmentService(db).getDeleteBlastRadius(environmentId)).toMatchObject({ canDelete: false, reusableSandboxLeaseCount: 1 });
        console.log("CUSTODY_REFUSAL_PROOF", JSON.stringify({ mode, leaseId: lease.id, calls,
          alarms: [...lines("first"), ...lines("manual_stop")].map(([fields, msg]) => ({ ...fields as object, msg })) }));
      } finally { warn.mockRestore(); }
    },
  );

  it("a lost expiry stop claim requires manual_stop once, never repeats an uncertain provider stop", async () => {
    const { lease, companyId, boxId, calls, sweep } = await expiryFixture("exact");
    await db.update(environmentLeases).set({ metadata: { ...(await environmentService(db).getLeaseById(lease.id))!.metadata,
      nativeCustodyExpiry: { state: "attempting", attemptId: randomUUID(), deadlineMs: 0 } } }).where(eq(environmentLeases.id, lease.id));
    const { warn, lines } = alarmSpy(lease.providerLeaseId!);
    try {
      for (let i = 0; i < 3; i++) await sweep(SIX_HOURS);
      expect(calls).toEqual([]);
      expect(lines("manual_stop")).toHaveLength(1);
      expect(lines("manual_stop")[0]![0]).toMatchObject({ companyId, boxId, providerLeaseId: lease.providerLeaseId, alarm: "manual_stop" });
      expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "retained", releasedAt: null,
        metadata: { nativeCustodyExpiry: { state: "manual_stop", reason: "stop_attempt_unconfirmed" } } });
    } finally { warn.mockRestore(); }
  });

  it("does not turn an ordinary retained execution-workspace lease into a custody obligation", async () => {
    const { lease, environmentId } = await seed("reuse_by_execution_workspace");
    await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "failed" }).where(eq(environmentLeases.id, lease.id));
    expect((await environmentService(db).getDeleteBlastRadius(environmentId))?.reusableSandboxLeaseCount).toBe(0);
    expect((await request(app).delete(`/api/environments/${environmentId}`)).status).toBe(200);
  });
});
