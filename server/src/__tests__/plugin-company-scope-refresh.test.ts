import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, issues, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createHostClientHandlers, PLUGIN_RPC_ERROR_CODES, type HostServices } from "@paperclipai/plugin-sdk";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { createPluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { bundledImageFixture } from "./helpers/bundled-image-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Recorded catch: guardv3 MP1/HG. Independent managers and database connections
// represent hosts A/B; only A receives the config save. Real worker children,
// SDK invocation propagation, host authorization, registry and Postgres reads.
// Keep reason: cross-process company authorization is a trust boundary.
describe("plugin company authorization across hosts sharing Postgres", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let dbA: ReturnType<typeof createDb>;
  let dbB: ReturnType<typeof createDb>;
  let registryA: ReturnType<typeof pluginRegistryService>;
  let registryB: ReturnType<typeof pluginRegistryService>;
  const managerA = createPluginWorkerManager();
  const managerB = createPluginWorkerManager();
  const pluginId = randomUUID(), companyId = randomUUID(), otherCompanyId = randomUUID(), issueId = randomUUID();
  const configGet = vi.fn<HostServices["config"]["get"]>(async ({ companyId: id }) =>
    (await registryB.getConfig(pluginId, id!))?.configJson as Record<string, unknown> ?? {});
  const issueGet = vi.fn<HostServices["issues"]["get"]>(async ({ issueId: id, companyId: company }) => {
    const [issue] = await dbB.select().from(issues).where(and(eq(issues.id, id), eq(issues.companyId, company)));
    return (issue ?? null) as Awaited<ReturnType<HostServices["issues"]["get"]>>;
  });
  const loadScopes = vi.fn(async () => (await registryB.listConfigs(pluginId)).map(row => row.companyId));
  const manifest: PaperclipPluginManifestV1 = {
    id: "test.scope-refresh", apiVersion: 1, version: "1.0.0", displayName: "Scope refresh",
    description: "Cross-host scope regression", author: "Paperclip", categories: ["automation"],
    capabilities: ["issues.read", "plugin.state.read", "jobs.schedule"], entrypoints: { worker: "worker.mjs" },
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-company-scopes-");
    dbA = createDb(database.connectionString);
    dbB = createDb(database.connectionString);
    registryA = pluginRegistryService(dbA);
    registryB = pluginRegistryService(dbB);
    await dbA.insert(companies).values([
      { id: companyId, name: "Company configured by A", issuePrefix: "CSA" },
      { id: otherCompanyId, name: "Never configured", issuePrefix: "CSB" },
    ]);
    await dbA.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@test/scope-refresh",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], manifestJson: manifest, status: "ready", installOrder: 1 });
    await dbA.insert(issues).values({ id: issueId, companyId, title: "Daily-work authorization regression", status: "todo", priority: "medium" });
    for (const [manager, registry] of [[managerA, registryA], [managerB, registryB]] as const) {
      const options = {
        entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-config-scope-refresh.mjs", import.meta.url)),
        execArgv: ["--import", import.meta.resolve("tsx")], manifest, config: {},
        instanceInfo: { instanceId: manager === managerA ? "host-a" : "host-b", hostVersion: "1.0.0" }, apiVersion: 1,
        env: { SCOPE_TEST_COMPANY_ID: companyId, SCOPE_TEST_OTHER_COMPANY_ID: otherCompanyId, SCOPE_TEST_ISSUE_ID: issueId },
        autoRestart: false,
        proactiveCompanyScopes: (await registry.listConfigs(pluginId)).map(row => row.companyId),
        // Structurally supplied so this test also typechecks on the unfixed base.
        loadProactiveCompanyScopes: manager === managerB ? loadScopes : async () =>
          (await registry.listConfigs(pluginId)).map(row => row.companyId),
        hostHandlers: createHostClientHandlers({ pluginId, capabilities: manifest.capabilities,
          services: { config: { get: configGet }, issues: { get: issueGet } } as unknown as HostServices }),
      };
      await manager.startWorker(pluginId, options);
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all([managerA.stopAll(), managerB.stopAll()]);
    await Promise.all([dbA?.$client.end({ timeout: 1 }), dbB?.$client.end({ timeout: 1 })]);
    await database?.cleanup();
  }, 30_000);

  const job = (key: string) => managerB.call(pluginId, "runJob", { job: {
    jobKey: key, runId: randomUUID(), trigger: "schedule", scheduledAt: new Date().toISOString(),
  } });
  const denied = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
  async function enableViaA() {
    await registryA.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true, savedBy: "host-a" } });
    managerA.setProactiveCompanyScopes(pluginId, (await registryA.listConfigs(pluginId)).map(row => row.companyId));
  }
  async function removeViaA() {
    await registryA.deleteConfig(pluginId, companyId);
    managerA.setProactiveCompanyScopes(pluginId, (await registryA.listConfigs(pluginId)).map(row => row.companyId));
  }

  it.each(["config", "issue"])("admits B's job %s read immediately after A alone enables a company", async (key) => {
    await removeViaA();
    managerB.setProactiveCompanyScopes(pluginId, []);
    const configCalls = configGet.mock.calls.length, issueCalls = issueGet.mock.calls.length;
    await denied(job(key));
    expect(configGet).toHaveBeenCalledTimes(configCalls);
    expect(issueGet).toHaveBeenCalledTimes(issueCalls);
    await enableViaA();
    await expect(job(key)).resolves.toBeNull();
    await expect(managerB.call(pluginId, "getData", { key: "result", params: {} }))
      .resolves.toMatchObject(key === "config" ? { enabled: true, savedBy: "host-a" } : { id: issueId, companyId });
  });

  it("revokes B's cached job authority when A removes the stored company config", async () => {
    await enableViaA();
    // Model an already-warm B cache without delivering A's config callback.
    managerB.setProactiveCompanyScopes(pluginId, [companyId]);
    await job("config");
    const configCalls = configGet.mock.calls.length, issueCalls = issueGet.mock.calls.length;
    await removeViaA();
    await denied(job("config"));
    await denied(job("issue"));
    expect(configGet).toHaveBeenCalledTimes(configCalls);
    expect(issueGet).toHaveBeenCalledTimes(issueCalls);
  });

  it("refreshes genuinely proactive calls as well as jobs, including revocation", async () => {
    managerB.setProactiveCompanyScopes(pluginId, []);
    await enableViaA();
    await expect(managerB.call(pluginId, "getData", { key: "proactive-config", params: {} }))
      .resolves.toMatchObject({ enabled: true });
    await expect(managerB.call(pluginId, "getData", { key: "proactive-issue", params: {} }))
      .resolves.toMatchObject({ id: issueId });
    await removeViaA();
    await denied(managerB.call(pluginId, "getData", { key: "proactive-config", params: {} }));
    await denied(managerB.call(pluginId, "getData", { key: "proactive-issue", params: {} }));
  });

  it("never grants an unconfigured company, missing company or wildcard", async () => {
    await enableViaA();
    const calls = configGet.mock.calls.length;
    await denied(job("other"));
    await denied(job("missing"));
    await denied(job("wildcard"));
    expect(configGet).toHaveBeenCalledTimes(calls);
  });

  it("keeps scoped invocations strict and does not reload their company authority", async () => {
    const reads = loadScopes.mock.calls.length;
    await denied(managerB.call(pluginId, "performAction", { key: "cross-company", companyId,
      params: {} }));
    expect(loadScopes).toHaveBeenCalledTimes(reads);
  });

  it("does not resurrect an invocation that timed out while the registry read was pending", async () => {
    await enableViaA();
    let release!: () => void, started!: () => void;
    const readStarted = new Promise<void>(resolve => { started = resolve; });
    const readReleased = new Promise<void>(resolve => { release = resolve; });
    loadScopes.mockImplementationOnce(async () => {
      started();
      await readReleased;
      return [companyId];
    });
    const calls = configGet.mock.calls.length;
    const timedOut = expect(managerB.call(pluginId, "runJob", { job: {
      jobKey: "config", runId: randomUUID(), trigger: "schedule", scheduledAt: new Date().toISOString(),
    } }, 100)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT });
    try {
      await readStarted;
      await timedOut;
    } finally { release(); }
    // A fresh request still succeeds; the retired request must not reach config.
    await expect(job("config")).resolves.toBeNull();
    expect(configGet).toHaveBeenCalledTimes(calls + 1);
  });

  it("wires the production loader to the plugin's authoritative registry rows", async () => {
    // This helper writes a tiny JS package/catalog, not an image build.
    const image = bundledImageFixture({ id: "test.scope-refresh-loader" });
    const options = {
      localPluginDir: path.join(image.root, "home"), prebuiltOnly: true,
      resolvePackageRoot: image.resolver.resolve, assertPackageActivation: image.resolver.assertActivation,
      enableLocalFilesystem: false, enableNpmDiscovery: false,
    };
    let workerOptions: WorkerStartOptions | undefined;
    const services = {
      workerManager: {
        startWorker: vi.fn(async (_id: string, start: WorkerStartOptions) => { workerOptions = start; }),
        call: vi.fn(async () => ({})), stopWorker: vi.fn(), stopAll: vi.fn(),
      },
      lifecycleManager: { markError: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
      buildHostHandlers: vi.fn(() => ({})), instanceInfo: { instanceId: "loader-host", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices;
    const loader = pluginLoader(dbB, options, services);
    try {
      await pluginLoader(dbA, options).installPlugin({ localPath: image.packageRoot });
      const row = (await registryA.getByKey(image.manifest.id))!;
      await registryA.updateStatus(row.id, { status: "ready" });
      const loaded = await loader.loadSingle(row.id);
      expect(loaded).toMatchObject({ success: true });
      expect(workerOptions?.proactiveCompanyScopes).toEqual([]);
      const reload = workerOptions?.loadProactiveCompanyScopes;
      expect(reload).toBeTypeOf("function");
      await registryA.upsertConfig(row.id, companyId, { companyId, configJson: { enabled: true } });
      await expect(reload!()).resolves.toEqual([companyId]);
      await registryA.deleteConfig(row.id, companyId);
      await expect(reload!()).resolves.toEqual([]);
    } finally {
      await loader.shutdownAll();
      rmSync(image.root, { recursive: true, force: true });
    }
  });

  it("fails closed on a config read failure instead of trusting a warm cache, then recovers", async () => {
    await enableViaA();
    managerB.setProactiveCompanyScopes(pluginId, [companyId]);
    const calls = configGet.mock.calls.length;
    loadScopes.mockRejectedValueOnce(new Error("database unavailable"));
    await denied(job("config"));
    expect(configGet).toHaveBeenCalledTimes(calls);
    await expect(job("config")).resolves.toBeNull();
  });
});
