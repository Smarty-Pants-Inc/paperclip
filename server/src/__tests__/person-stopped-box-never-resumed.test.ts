import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  plugins,
  projects,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { hasRecordedUserStopRequest } from "../services/acknowledged-native-stop.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// org purple (2), 2026-11-18 23:11Z: "a box whose run was person-stopped is
// never selected by another run". On tB2 a person's Stop (errorCode
// "cancelled") keeps the box WARM (runner-environment-lifecycle.ts :27-28):
// the lease is retained with NO termination receipt. So the rule keys on P's
// RUN: the cancelled-by-user record the real Stop route writes
// (routes/agents.ts POST /heartbeat-runs/:runId/cancel -> heartbeat cancelRun
// -> run-control.ts: cancelledByActorType "user" + executionCancellation;
// read by hasRecordedUserStopRequest). No window. Only P's own run is exempt.

vi.mock("../services/native-runtime/native-harness-backup-storage.js", () => ({
  verifyRecoverableNativeHarnessBackup: vi.fn(async (input: { stamp: unknown; providerLeaseId: string }) =>
    Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)),
}));

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HOUR = 60 * 60_000;

/** The exact options the real Stop route passes for a board user
 * (routes/agents.ts, POST /heartbeat-runs/:runId/cancel). */
const PERSON_STOP = ["Cancelled by a board operator", {
  resultJson: { cancelledByActorType: "user", cancelledByUserId: "person-1" },
}] as const;

describeEmbeddedPostgres("tB2: a box whose run a PERSON stopped is never resumed by another run", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("person-stopped-box-never-resumed");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });
  beforeEach(() => { db = createDb(connectionString); });
  // Every row uses its own company, environment and runs: no cross-row cleanup.
  afterEach(async () => { vi.restoreAllMocks(); await db.$client.end({ timeout: 1 }); });
  afterAll(async () => { await stopDb?.(); });

  // ---------------- The reusable sandbox lease path ----------------

  let providerLeaseId = "";
  const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 300_000, reuseLease: true };
  const supportedMethods = ["environmentResumeLease", "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"];

  function worker(pluginId: string) {
    const call = vi.fn(async (_pluginId: string, method: string, params: unknown) => {
      const asked = (params as { providerLeaseId?: string }).providerLeaseId;
      if (method === "environmentResumeLease") {
        return { providerLeaseId: asked, metadata: { ...providerConfig, remoteCwd: "/home/boat/paperclip-workspace" } };
      }
      if (method === "environmentAcquireLease") {
        const fresh = call.mock.calls.filter(([, m]) => m === "environmentAcquireLease").length === 1 ? providerLeaseId : `fresh-box-${randomUUID()}`;
        return { providerLeaseId: fresh, metadata: { ...providerConfig, sandboxId: fresh, remoteCwd: "/home/boat/paperclip-workspace" } };
      }
      if (method === "environmentReleaseLease" || method === "environmentStopLease") return { providerLeaseId: asked, state: "stopped" };
      if (method === "environmentDestroyLease") return { providerLeaseId: asked, state: "destroyed" };
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods })) } as unknown as PluginWorkerManager;
    return { call, manager, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  /** P (issue A) creates its box B through the real acquisition path. */
  async function setup() {
    providerLeaseId = `tb2-box-${randomUUID()}`;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const pRunId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: `Boat ${environmentId}`, driver: "sandbox", status: "active",
      config: providerConfig });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: `acme.reusable-sandbox-provider-${pluginId}`, packageName: `@acme/reusable-sandbox-provider-${pluginId}`,
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: {
        id: `acme.reusable-sandbox-provider-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Reusable Sandbox Provider",
        description: "Test provider", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, timeoutMs: { type: "number" }, reuseLease: { type: "boolean" } } } }],
      },
    } as never);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await db.insert(issues).values([
      { id: issueA, companyId, title: "P's task", status: "in_progress", priority: "medium" },
      { id: issueB, companyId, title: "Another task", status: "in_progress", priority: "medium" },
    ]);
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, mode: "shared_workspace",
      strategyType: "project_primary", name: "Shared workspace", status: "active", providerType: "cloud_sandbox",
      cwd: `/workspaces/${executionWorkspaceId}` });
    await db.insert(heartbeatRuns).values({ id: pRunId, companyId, agentId, issueId: issueA, invocationSource: "assignment", status: "running" });
    const environment: Environment = { id: environmentId, name: `Boat ${environmentId}`, description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    const w = worker(pluginId);
    const created = await w.runtime.acquireRunLease({ companyId, environment, issueId: issueA, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: pRunId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "shared_workspace" } });
    expect(created.lease.providerLeaseId).toBe(providerLeaseId);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: w.manager, environmentRuntime: w.runtime });
    return { companyId, agentId, environment, pluginId, pRunId, issueA, issueB, executionWorkspaceId,
      leaseId: created.lease.id, heartbeat, ...w };
  }
  type Seeded = Awaited<ReturnType<typeof setup>>;

  /** REAL: P is stopped by a person through the real Stop service with the
   * route's own arguments, then the run's real teardown release runs with the
   * warm disposition. On tB2 the box stays warm: retained, no receipt. */
  async function personStopsP(seeded: Seeded) {
    await seeded.heartbeat.cancelRun(seeded.pRunId, ...PERSON_STOP);
    const [pRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.pRunId));
    expect(pRun?.status).toBe("cancelled");
    expect(hasRecordedUserStopRequest(pRun!)).toBe(true);
    await seeded.heartbeat.releaseEnvironmentLeasesForRun({ runId: seeded.pRunId, companyId: seeded.companyId,
      agentId: seeded.agentId, status: pRun!.status, providerResourceDisposition: "keep_running" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    // The tB2 difference: a person-stopped box is kept WARM, no receipt.
    expect(lease?.status).toBe("retained");
    expect(lease?.metadata?.remoteExecutionTermination).toBeUndefined();
    return pRun!;
  }

  /** REAL: P ends `status` (with `errorCode`) and the real warm release runs. */
  async function pEnds(seeded: Seeded, status: "succeeded" | "failed", errorCode: string | null = null) {
    await db.update(heartbeatRuns).set({ status, errorCode, finishedAt: new Date() }).where(eq(heartbeatRuns.id, seeded.pRunId));
    await seeded.heartbeat.releaseEnvironmentLeasesForRun({ runId: seeded.pRunId, companyId: seeded.companyId,
      agentId: seeded.agentId, status, providerResourceDisposition: "keep_running" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(lease?.status).toBe("retained");
  }

  async function newRun(seeded: Seeded, issueId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: seeded.companyId, agentId: seeded.agentId, issueId,
      invocationSource: "assignment", status: "running" });
    return id;
  }

  function acquire(seeded: Seeded, runId: string, issueId: string) {
    return seeded.runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" } });
  }

  const resumedB = (seeded: Seeded) => seeded.call.mock.calls.filter(([, method, params]) =>
    method === "environmentResumeLease" && (params as { providerLeaseId?: string }).providerLeaseId === providerLeaseId);
  const touchedB = (seeded: Seeded) => seeded.call.mock.calls.filter(([, method, params]) =>
    method !== "environmentAcquireLease" && (params as { providerLeaseId?: string }).providerLeaseId === providerLeaseId);

  async function expectFreshBox(seeded: Seeded, acquired: Awaited<ReturnType<typeof acquire>>) {
    expect(resumedB(seeded)).toHaveLength(0);
    expect(acquired.lease.providerLeaseId).not.toBe(providerLeaseId);
    expect(acquired.lease.providerLeaseId).toMatch(/^fresh-box-/);
    // P's box is not released, stopped or destroyed inline: the next message
    // never waits on a provider call for it.
    expect(touchedB(seeded)).toHaveLength(0);
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(kept?.status).toBe("retained");
    expect(kept?.metadata?.reusableLeaseSuccessor).toBeUndefined();
  }
  function expectResumed(seeded: Seeded, acquired: Awaited<ReturnType<typeof acquire>>) {
    expect(resumedB(seeded)).toHaveLength(1);
    expect(acquired.lease.providerLeaseId).toBe(providerLeaseId);
  }

  // ---------------- REFUSED (RED at tB2, GREEN after) ----------------

  it("row 1: a person stops P; the SAME conversation's next run does not take P's warm box (a fresh one)", async () => {
    const seeded = await setup();
    await personStopsP(seeded);
    const next = await newRun(seeded, seeded.issueA);
    await expectFreshBox(seeded, await acquire(seeded, next, seeded.issueA));
  });

  it("row 2: a person stops P; a DIFFERENT issue's run does not take P's warm box (a fresh one)", async () => {
    const seeded = await setup();
    await personStopsP(seeded);
    const other = await newRun(seeded, seeded.issueB);
    await expectFreshBox(seeded, await acquire(seeded, other, seeded.issueB));
  });

  it("row 3: + 2 h after a person's Stop, another run is still refused (no window)", async () => {
    const seeded = await setup();
    await personStopsP(seeded);
    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + 2 * HOUR);
    const later = await newRun(seeded, seeded.issueA);
    await expectFreshBox(seeded, await acquire(seeded, later, seeded.issueA));
  });

  it("row 1b: the box stays refused after a fresh box served the next turn (the next-next run also gets a fresh box, not P's)", async () => {
    const seeded = await setup();
    await personStopsP(seeded);
    const next = await newRun(seeded, seeded.issueA);
    const first = await acquire(seeded, next, seeded.issueA);
    await expectFreshBox(seeded, first);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, next));
    await seeded.heartbeat.releaseEnvironmentLeasesForRun({ runId: next, companyId: seeded.companyId,
      agentId: seeded.agentId, status: "succeeded", providerResourceDisposition: "keep_running" });
    const third = await newRun(seeded, seeded.issueA);
    const acquired = await acquire(seeded, third, seeded.issueA);
    // The succeeded successor's own warm box is reused; P's box is never chosen.
    expect(resumedB(seeded)).toHaveLength(0);
    expect(acquired.lease.providerLeaseId).toBe(first.lease.providerLeaseId);
  });

  // ---------------- UNCHANGED ----------------

  it("row 4: a SUCCEEDED P: the next run reuses the warm box (unchanged)", async () => {
    const seeded = await setup();
    await pEnds(seeded, "succeeded");
    const next = await newRun(seeded, seeded.issueA);
    expectResumed(seeded, await acquire(seeded, next, seeded.issueA));
  });

  it("row 5: P's OWN run resumes its box after the person's Stop (unchanged)", async () => {
    const seeded = await setup();
    await personStopsP(seeded);
    expectResumed(seeded, await acquire(seeded, seeded.pRunId, seeded.issueA));
  });

  it("row 6: a FAILED P (keep-warm adapter_error, no person Stop): the same conversation still resumes (out of this rule)", async () => {
    const seeded = await setup();
    await pEnds(seeded, "failed", "adapter_error");
    const next = await newRun(seeded, seeded.issueA);
    expectResumed(seeded, await acquire(seeded, next, seeded.issueA));
  });

  it("row 6b: a run stopped by a managing AGENT (not a person) is out of this rule: the next run resumes", async () => {
    const seeded = await setup();
    await seeded.heartbeat.cancelRun(seeded.pRunId, "Cancelled by a managing agent", {
      resultJson: { cancelledByActorType: "agent", cancelledByAgentId: seeded.agentId } });
    const [pRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.pRunId));
    expect(hasRecordedUserStopRequest(pRun!)).toBe(false);
    await seeded.heartbeat.releaseEnvironmentLeasesForRun({ runId: seeded.pRunId, companyId: seeded.companyId,
      agentId: seeded.agentId, status: pRun!.status, providerResourceDisposition: "keep_running" });
    const next = await newRun(seeded, seeded.issueA);
    expectResumed(seeded, await acquire(seeded, next, seeded.issueA));
  });

  // ---------------- The handoff mirror (environments.ts acquireLease) ----------------

  it("mirror: the handoff refuses another run's takeover of a person-stopped P's box (conflict, rolled back); P's own reacquire and a succeeded P's handoff are admitted", async () => {
    const seeded = await setup();
    await personStopsP(seeded);
    const other = await newRun(seeded, seeded.issueA);
    const handoff = (runId: string, leaseId: string) => environmentService(db).acquireLease({
      companyId: seeded.companyId, environmentId: seeded.environment.id, executionWorkspaceId: seeded.executionWorkspaceId,
      issueId: seeded.issueA, heartbeatRunId: runId, leasePolicy: "reuse_by_environment", provider: "fake-plugin",
      providerLeaseId, metadata: { agentId: seeded.agentId }, replacesReusableLeaseId: leaseId,
    });
    await expect(handoff(other, seeded.leaseId)).rejects.toThrow(/person stopped/);
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(kept?.status).toBe("retained");
    expect(kept?.metadata?.reusableLeaseSuccessor).toBeUndefined();

    // A succeeded predecessor's handoff is unchanged.
    await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, seeded.pRunId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.pRunId));
    const taken = await handoff(other, seeded.leaseId);
    expect(taken.heartbeatRunId).toBe(other);
    const [retired] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(retired?.status).toBe("expired");
  });

  // ---------------- The warm plugin-task resume (environment-runtime plugin driver) ----------------

  async function pluginTaskFixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID();
    let runId = randomUUID(), allocation = 0;
    const calls: Array<[string, string | undefined]> = [];
    await db.insert(companies).values({ id: companyId, name: "Warm fixture", issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, invocationSource: "manual", status: "running" });
    const [environment] = await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "plugin", status: "active",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {}, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 300000 } }).returning();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-warm", version: "1.0.0", status: "ready", manifestJson: {
      capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true, warmTaskVersion: 1 }],
    } as never });
    const workers = { isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentTask", "environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease"] }),
      call: async (_id: string, method: string, p: any) => {
        calls.push([method === "environmentTask" ? p.operation.kind : method, p.providerLeaseId ?? p.taskId]);
        if (method === "environmentAcquireLease") return { providerLeaseId: `task-${++allocation}`, metadata: { runId: p.runId } };
        if (method === "environmentResumeLease") return { providerLeaseId: p.providerLeaseId, metadata: { runId: p.runId } };
        if (method === "environmentReleaseLease") return { providerLeaseId: p.providerLeaseId, state: "stopped" };
        if (p.operation.kind === "status") return { kind: "status", taskId: p.taskId, phase: "running", executionStopped: false, sessionStateAvailable: false, preparationStopped: false };
        if (p.operation.kind === "describe") return { kind: "description", taskId: p.taskId, runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` }, warmTaskVersion: 1 };
        return { kind: "accepted", taskId: p.taskId };
      } } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    const acquire = (id: string) => runtime.acquireRunLease({ companyId, environment: environment as never, issueId, agentId, heartbeatRunId: id,
      persistedExecutionWorkspace: null, adapterType: "paperclip_runner", runnerTaskProjectIds: [] });
    const first = await acquire(runId);
    expect(first.lease.leasePolicy).toBe("reuse_by_environment");
    const heartbeat = heartbeatService(db, { pluginWorkerManager: workers, environmentRuntime: runtime });
    return { companyId, agentId, issueId, first, calls, runtime, acquire, heartbeat, pRunId: runId,
      async nextRun() { runId = randomUUID(); await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, invocationSource: "manual", status: "running" }); return runId; } };
  }

  it("plugin task: a person stops P; the same conversation's next run does not resume P's retained task box (a fresh one, P's box untouched)", async () => {
    const f = await pluginTaskFixture();
    await f.heartbeat.cancelRun(f.pRunId, ...PERSON_STOP);
    const [pRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.pRunId));
    expect(hasRecordedUserStopRequest(pRun!)).toBe(true);
    await f.runtime.releaseRunLeases(f.pRunId, "released", undefined, "keep_running");
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.first.lease.id));
    expect(kept?.status).toBe("retained");
    const mark = f.calls.length;
    const next = await f.acquire(await f.nextRun());
    expect(next.lease.providerLeaseId).not.toBe(f.first.lease.providerLeaseId);
    expect(f.calls.slice(mark).filter(([, target]) => target === f.first.lease.providerLeaseId)).toEqual([]);
    // A later run is still refused: the fresh box is chosen, never P's, and
    // two retained rows do not make the selection ambiguous.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, next.lease.heartbeatRunId!));
    await f.runtime.releaseRunLeases(next.lease.heartbeatRunId!, "released", undefined, "keep_running");
    const third = await f.acquire(await f.nextRun());
    expect(third.lease.providerLeaseId).toBe(next.lease.providerLeaseId);
    expect(f.calls.filter(([method, target]) => method === "environmentResumeLease" && target === f.first.lease.providerLeaseId)).toEqual([]);
  });

  it("plugin task: a SUCCEEDED P's retained task box is resumed by the next run (unchanged)", async () => {
    const f = await pluginTaskFixture();
    await f.runtime.releaseRunLeases(f.pRunId, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.pRunId));
    const next = await f.acquire(await f.nextRun());
    expect(next.lease.providerLeaseId).toBe(f.first.lease.providerLeaseId);
    expect(f.calls.filter(([method]) => method === "environmentResumeLease")).toHaveLength(1);
  });

});
