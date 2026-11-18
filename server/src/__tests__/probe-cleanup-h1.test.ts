// hire-h1 (RFL finding H1): F5's typed re-read path must not be a SECOND proof
// authority. confirmProbeLeaseTermination keeps its typed inspect and its
// exact-row CAS receipt writer, but its FINAL decision is ownLeaseTerminated on
// the probe's exact lease (runId null, leaseId = the probe's lease, ownLeaseOnly),
// the one reader every other path (ai-connection-runtime probeLeaseTerminated,
// native-session-executor) already uses. The raw run-less receipt reader is not
// exported, so no caller can take a proof from it.
import { randomUUID } from "node:crypto";
import { companies, createDb, environmentLeases, environments, plugins, type Db } from "@paperclipai/db";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import * as termination from "../services/remote-execution-termination.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// Pass-through spy on the one authority: the real reader runs unless a test
// overrides one answer, so the final decision is observable.
vi.mock("../services/remote-execution-termination.js", async importOriginal => {
  const real = await importOriginal<typeof import("../services/remote-execution-termination.js")>();
  return { ...real, ownLeaseTerminated: vi.fn(real.ownLeaseTerminated) };
});
const ownLeaseTerminated = vi.mocked(termination.ownLeaseTerminated);

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("hire probe H1: F5's final proof is ownLeaseTerminated, no second reader", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-probe-cleanup-h1-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => { ownLeaseTerminated.mockClear(); });

  /** Boat's sandbox-provider worker: acquire, a void release (no receipt), and
   * a typed inspect answering `state`. Anything else is refused. */
  function boatWorker(pluginId: string, state: "stopped" | "destroyed") {
    let boxes = 0;
    const methods = ["environmentAcquireLease", "environmentReleaseLease", "environmentRealizeWorkspace", "environmentInspectLease"];
    return {
      isRunning: (id: string) => id === pluginId,
      getWorker: () => ({ status: "running", supportedMethods: methods }),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string; lease?: { providerLeaseId?: string } }) => {
        const providerLeaseId = params.providerLeaseId ?? params.lease?.providerLeaseId;
        if (method === "environmentAcquireLease") return { providerLeaseId: `boat-box-${++boxes}`, metadata: { provider: "boat", remoteCwd: "/home/user/paperclip-workspace" } };
        if (method === "environmentRealizeWorkspace") return { cwd: "/home/user/paperclip-workspace" };
        if (method === "environmentReleaseLease") return undefined;
        if (method === "environmentInspectLease") return { providerLeaseId, state, stoppedAt: null, lastRebootAt: null, observedAt: null };
        throw new JsonRpcCallError({ code: -32002, message: "Boat sandbox lease is no longer active." } as never);
      }),
    } as unknown as PluginWorkerManager;
  }

  /** A closed one-off setup-test lease (no run, no issue, ephemeral, released
   * as failed without a receipt), through the real runtime and plugin path. */
  async function closedProbeLease(state: "stopped" | "destroyed") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "H1 test company", issuePrefix: `H${companyId.slice(0, 7)}` });
    const pluginId = randomUUID();
    const key = `paperclipai.plugin-boat.${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey: key, packageName: "@paperclipai/plugin-boat",
      version: "0.1.17-spare.1", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1,
      manifestJson: { id: key, apiVersion: 1, version: "0.1.17-spare.1", displayName: "Boat", description: "Boat",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", configSchema: { type: "object" } }] },
      updatedAt: new Date() } as never);
    const [environment] = await db.insert(environments).values({ name: `boat-${pluginId.slice(0, 8)}`, driver: "sandbox",
      config: { provider: "boat", reuseLease: false, timeoutMs: 1234 } }).returning();
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: boatWorker(pluginId, state) });
    const acquired = await runtime.acquireRunLease({ companyId, agentId: randomUUID(), adapterType: "paperclip_runner",
      environment: environment as never, configuredEnvironment: environment as never, issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null } as never);
    await runtime.getDriver("sandbox")!.releaseRunLease({ environment: environment as never, lease: acquired.lease, status: "failed" });
    const [closed] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.lease.id));
    expect(closed).toMatchObject({ status: "failed", leasePolicy: "ephemeral", heartbeatRunId: null, issueId: null });
    expect(closed!.metadata?.remoteExecutionTermination, "a void release binds no receipt").toBeUndefined();
    return { companyId, environment: environment!, runtime, closed: closed! };
  }

  for (const state of ["stopped", "destroyed"] as const) {
    it(`RED H1 (${state}): the CAS writer writes the receipt, but the answer is ownLeaseTerminated's on the probe's exact lease (ownLeaseOnly), never the raw receipt check`, async () => {
      const { companyId, environment, runtime, closed } = await closedProbeLease(state);
      ownLeaseTerminated.mockClear();
      // The one authority refuses this time: the decision must follow it even
      // though the writer's row carries a valid receipt the raw check accepts.
      ownLeaseTerminated.mockResolvedValueOnce(false);
      expect(await runtime.confirmProbeLeaseTermination({ companyId, leaseId: closed.id }), "the raw receipt check is not the proof").toBe(false);
      const [written] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, closed.id));
      expect(written!.metadata?.remoteExecutionTermination, "the writer is unchanged: exact-row receipt")
        .toMatchObject({ schema: "paperclip.remote-termination.v1", runId: null, leaseId: closed.id, providerLeaseId: closed.providerLeaseId, state });
      expect(written).toMatchObject({ cleanupStatus: "success", status: "failed" });
      expect(ownLeaseTerminated, "exact-lease ownership, one call").toHaveBeenCalledTimes(1);
      expect(ownLeaseTerminated).toHaveBeenCalledWith(expect.anything(),
        { companyId, environmentId: environment.id, providerLeaseId: closed.providerLeaseId, runId: null, leaseId: closed.id },
        { ownLeaseOnly: true });
      // The control: the real reader accepts the probe's own receipt.
      expect(await runtime.confirmProbeLeaseTermination({ companyId, leaseId: closed.id })).toBe(true);
      expect(ownLeaseTerminated).toHaveBeenCalledTimes(2);
    });
  }

  it("RED H1: no proof-returning run-less receipt reader is exported", () => {
    expect(Object.keys(termination)).not.toContain("hasProbeLeaseTerminationReceipt");
  });
});
