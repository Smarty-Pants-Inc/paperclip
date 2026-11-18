import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins } from "@paperclipai/db";
import { environmentService } from "../services/environments.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Scope finding, NOT a passing acceptance suite. The accepted manager.call
// fence does not intercept getWorker(...).openDuplexChannel(...). The latter
// sends duplexChannelOpen through the worker's callInternal and runs command.
describe("S scope finding: direct duplex command bypasses the accepted choke", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("s-duplex-choke-gap");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterAll(async () => { await db?.$client.end(); await cleanup?.(); });

  it.each(["expired", "superseded", "ordinary"] as const)("refuses stale duplex command after %s, but keeps an ordinary lease usable", async mode => {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Duplex scope proof", issuePrefix: `D${companyId.slice(0, 7).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox", config: { provider: "fixture" } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded" });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "s-duplex-fixture", version: "1", status: "ready",
      manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "fixture",
        kind: "sandbox_provider", sandboxCapabilities: { duplexCommandStream: true } }] } as never });
    const metadata = { sandboxProviderPlugin: true, pluginId, provider: "fixture" };
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      provider: "fixture", providerLeaseId: "old-box", status: "active", leasePolicy: "reuse_by_environment", metadata });
    const environment = (await environmentService(db).getById(environmentId))!;
    const stale = (await environmentService(db).getLeaseById(leaseId))!;
    await db.update(environmentLeases).set({ status: mode === "expired" ? "expired" : "released",
      metadata: { ...metadata, ...(mode === "superseded" ? { reusableSandboxLeaseSuperseded: { supersededByProviderLeaseId: "new-box" } } : {}) },
    }).where(eq(environmentLeases.id, leaseId));
    const before = await environmentService(db).getLeaseById(leaseId);
    const openDuplexChannel = vi.fn(async () => ({ write() {}, onData() {}, kill() {},
      wait: async () => ({ exitCode: 0 }), close: async () => {} }));
    const call = vi.fn();
    const workers = { call, getWorker: () => ({ supportedMethods: ["duplexChannelOpen"], openDuplexChannel }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workers });
    expect(await runtime.resolveCapabilities({ environment, lease: stale })).toMatchObject({ duplexCommandStream: true });
    const result = await runtime.openDuplexChannel({ environment, lease: stale, command: ["fixture-child-command"] })
      .then(channel => ({ channel }), (error: unknown) => ({ error }));
    if ("channel" in result) await result.channel.close();
    expect(call).not.toHaveBeenCalled();
    expect(await environmentService(db).getLeaseById(leaseId)).toEqual(before);
    expect(openDuplexChannel).toHaveBeenCalledTimes(mode === "ordinary" ? 1 : 0);
    if (mode !== "ordinary") expect(result).toMatchObject({ error: { code: "sandbox_lease_start_denied" } });
  });
});
