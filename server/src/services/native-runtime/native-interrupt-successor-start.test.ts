import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, applyPendingMigrations, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, plugins } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { classifyNativeWorkspaceInbound } from "./native-workspace-sync.js";
import { nativeWorkspaceExportPendingForResource } from "./native-workspace-finalization-state.js";

// The process-local tier-1 proof (a live, idle, stopped-turn owner on this exact
// lease) lives in the executor's warm-session map. This row stubs ONLY that
// proof; the DB, the lease policy, the export fence and the provider boundary
// are the real acquire path.
const tier1 = vi.hoisted(() => ({ qualified: new Set<string>() }));
vi.mock("./native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./native-session-executor.js")>();
  return { ...actual, hasRetainedNativeTurnStop: (run: { id: string; status: string }, lease?: { heartbeatRunId: string | null; providerLeaseId: string | null }) =>
    run.status === "cancelled" && tier1.qualified.has(run.id) && (!lease || lease.heartbeatRunId === run.id) };
});

/** adopt-intr-start: the qualified same-session Interrupt successor must start
 * the way a warm follow-up on the same box starts. Steps counted here are the
 * ones that decide every later step: which box (resume vs create) and the
 * workspace inbound mode on it (adopt vs full upload). A new box forces the
 * instruction re-upload and a Runner bootstrap (MAP.md). */
describe("Interrupt successor start: no more steps than a warm follow-up", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_TEST_DATABASE_URL");
    if (external) { await applyPendingMigrations(external); temporary = { connectionString: external, cleanup: async () => {} }; }
    else temporary = await startEmbeddedPostgresTestDatabase("native-intr-start-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterEach(() => { vi.restoreAllMocks(); tier1.qualified.clear(); });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(predecessor: "warm_follow_up" | "interrupt_successor" | "unqualified_cut" | "failed") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Interrupt start", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Six steps", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
    const provider = "intr-start-plugin";
    await db.insert(plugins).values({ id: pluginId, pluginKey: `intr-start.${pluginId}`,
      packageName: "intr-start-provider", version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready",
      manifestJson: { id: `intr-start.${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Interrupt start provider",
        description: "Controlled lifecycle boundary", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Interrupt start", supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, reuseLease: { type: "boolean" } } } }] } });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox", status: "active",
      config: { provider, image: "fake:test", reuseLease: true } }).returning();
    const box = `box-${randomUUID()}`;
    let acquisitions = 0;
    const call = vi.fn(async (_id: string, method: string, input?: Record<string, unknown>) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: acquisitions++ ? `new-${randomUUID()}` : box, metadata: { remoteCwd: "/work" } };
      if (method === "environmentResumeLease") return { providerLeaseId: String(input?.providerLeaseId ?? box), metadata: { remoteCwd: "/work" } };
      if (["environmentReleaseLease", "environmentStopLease"].includes(method)) return { providerLeaseId: box, state: "stopped" };
      if (method === "environmentDestroyLease") return { providerLeaseId: box, state: "destroyed" };
      throw new Error(method);
    });
    const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentResumeLease",
      "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const input = { companyId, agentId, issueId, environment: environment as unknown as Environment,
      heartbeatRunId: runId, persistedExecutionWorkspace: null };
    const acquired = await runtime.acquireRunLease(input);
    // A warm box stays running for the next message (keep_running), for a
    // finished turn and for a person's Interrupt alike.
    await runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
    const stamp = { schema: "paperclip.native-workspace-stamp/v1", workspaceId: issueId, providerLeaseId: box,
      remoteCwd: "/work", hostSha256: "d".repeat(64), finalizedRunId: randomUUID() };
    await db.update(environmentLeases).set({ metadata: { ...acquired.lease.metadata, nativeWorkspaceSync: stamp } })
      .where(eq(environmentLeases.id, acquired.lease.id));
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", leaseId: acquired.lease.id,
      providerLeaseId: box, workspaceId: issueId, remoteCwd: "/work", resourceDisposition: "keep_running",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null };
    const cut = { cancelledByActorType: "user", cancelledByUserId: "paul", operatorInterrupted: true };
    const terminal = predecessor === "warm_follow_up"
      // A finished turn: completeWorkspace finalized its reference (runtime-execution.ts:1024-1102).
      ? { status: "succeeded", runnerProfileJson: { nativeWorkspaceSync: { ...reference, state: "finalized", finalHostSha256: "d".repeat(64) } } }
      : predecessor === "failed"
        ? { status: "failed", runnerProfileJson: { nativeWorkspaceSync: reference } }
        // A cut turn: NativeCancellationPendingRecoveryError skips completeWorkspace; the reference stays prepared.
        : { status: "cancelled", resultJson: cut, errorCode: "operator_interrupted", runnerProfileJson: { nativeWorkspaceSync: reference,
            nativeRetainedIdleCheckpoint: { schema: "paperclip.native-retained-idle-checkpoint.v1", runId, companyId, issueId } } };
    await db.update(heartbeatRuns).set({ ...terminal, finishedAt: new Date(Date.now() - 180_000) }).where(eq(heartbeatRuns.id, runId));
    // The cut turn really started on the box (it ran tools before the Interrupt).
    if (predecessor !== "warm_follow_up") await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 100_000,
      eventType: "turn.started", stream: "system", level: "info", message: "turn started" });
    if (predecessor === "interrupt_successor") tier1.qualified.add(runId);
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
    call.mockClear();
    return { runtime, input, runId, nextRunId, box, lease: acquired.lease, call };
  }

  /** The successor's start steps, from the real acquire path. */
  async function startSteps(f: Awaited<ReturnType<typeof seed>>) {
    const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId });
    const acquisition = (next.lease.metadata?.sandboxLeaseAcquisition as { outcome?: "created" | "resumed" } | undefined)?.outcome ?? "created";
    const workspaceMode = classifyNativeWorkspaceInbound({ kind: "new_run", acquisition, hasPriorStamp: Boolean(next.lease.metadata?.nativeWorkspaceSync) });
    const sameBox = next.lease.providerLeaseId === f.box;
    // The gate-readable receipt of the same choice (native.warm_retention.probe, phase acquisition).
    let probe: Record<string, unknown> | undefined;
    for (let i = 0; i < 40 && !probe; i++) {
      probe = (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.nextRunId)))
        .map(event => event.payload as Record<string, unknown> | null).find(payload => payload?.phase === "acquisition") ?? undefined;
      if (!probe) await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {
      probe: { acquisition: probe?.acquisition, reason: probe?.reason },
      providerCalls: f.call.mock.calls.map(call => call[1]),
      sameBox,
      // Each counted step is one the warm follow-up skips on the same box.
      steps: {
        environment_create: f.call.mock.calls.some(call => call[1] === "environmentAcquireLease") ? 1 : 0,
        workspace_full_upload: workspaceMode === "host_current" ? 1 : 0,
        // A different box retires the warm instruction dir and the retained Runner
        // (native-session-executor.ts:1296-1299, :13437-13448): re-upload + bootstrap.
        instructions_materialize: sameBox ? 0 : 1,
        runner_session_bootstrap: sameBox ? 0 : 1,
      },
    };
  }

  it("a qualified same-session Interrupt successor runs no more start steps than a warm follow-up", async () => {
    const warm = await startSteps(await seed("warm_follow_up"));
    expect(warm).toEqual({ probe: { acquisition: "resumed", reason: "reused" }, providerCalls: ["environmentResumeLease"], sameBox: true,
      steps: { environment_create: 0, workspace_full_upload: 0, instructions_materialize: 0, runner_session_bootstrap: 0 } });
    const successor = await startSteps(await seed("interrupt_successor"));
    expect(successor).toEqual(warm);
  });

  it("keeps the export fence for a cut without the live tier-1 owner and for a failed turn", async () => {
    for (const kind of ["unqualified_cut", "failed"] as const) {
      const f = await seed(kind);
      const steps = await startSteps(f);
      expect(steps.sameBox, kind).toBe(false);
      expect(steps.providerCalls, kind).toEqual(["environmentAcquireLease"]);
      // The unexported source stays fenced on its allocation.
      expect(await nativeWorkspaceExportPendingForResource(db, f.lease, f.nextRunId), kind).toBe(true);
    }
  });
});
