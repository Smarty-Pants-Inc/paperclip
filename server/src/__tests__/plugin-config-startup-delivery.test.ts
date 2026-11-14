import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createHostClientHandlers, PLUGIN_RPC_ERROR_CODES, type HostServices } from "@paperclipai/plugin-sdk";
import { companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * LOOA-629: a plugin worker is spawned once per plugin (not per company) with
 * an empty bootstrap config, and can only read company-scoped config from
 * inside a company-scoped invocation. A proactive plugin (e.g. the chat
 * gateway) has no such invocation at setup(), so the loader must replay every
 * configured company's config to the freshly-started worker. That replay reads
 * the config rows via `registry.listConfigs(pluginId)`, which this exercises.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin config startup-delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("registry.listConfigs (startup config delivery)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-delivery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin(pluginKey: string, installOrder: number) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: `@paperclipai/${pluginKey}`,
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "0.0.1",
        displayName: pluginKey,
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder,
    });
    return pluginId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Co ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  it("returns every company-scoped config row for a plugin", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    await registry.upsertConfig(pluginId, companyA, {
      companyId: companyA,
      configJson: { slackBotToken: "xoxb-a", slackAppToken: "xapp-a" },
    });
    await registry.upsertConfig(pluginId, companyB, {
      companyId: companyB,
      configJson: { slackBotToken: "xoxb-b", slackAppToken: "xapp-b" },
    });

    const rows = await registry.listConfigs(pluginId);
    expect(rows).toHaveLength(2);

    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    expect(byCompany.get(companyA)?.configJson).toMatchObject({ slackBotToken: "xoxb-a" });
    expect(byCompany.get(companyB)?.configJson).toMatchObject({ slackBotToken: "xoxb-b" });
  });

  it("only returns rows for the requested plugin (no cross-plugin bleed)", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const otherPluginId = await seedPlugin("paperclip.other-test", 2);
    const companyA = await seedCompany();

    await registry.upsertConfig(pluginId, companyA, {
      companyId: companyA,
      configJson: { marker: "mine" },
    });
    await registry.upsertConfig(otherPluginId, companyA, {
      companyId: companyA,
      configJson: { marker: "theirs" },
    });

    const rows = await registry.listConfigs(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.configJson).toMatchObject({ marker: "mine" });
  });

  it("returns an empty list when the plugin has no configured companies", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const rows = await registry.listConfigs(pluginId);
    expect(rows).toEqual([]);
  });

  it("replays current stored config after SIGKILL, retaining setup authority without double-delivering activation", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.config-replay", 1);
    const companyId = await seedCompany();
    const unconfiguredCompanyId = await seedCompany();
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "plugin-config-replay-"));
    const manifest: PaperclipPluginManifestV1 = {
      id: "paperclip.config-replay", apiVersion: 1, version: "0.0.1",
      displayName: "Config replay", description: "Crash recovery fixture", author: "Paperclip",
      categories: ["automation"], capabilities: ["companies.read", "jobs.schedule"],
      entrypoints: { worker: "worker.js" },
      jobs: [{ jobKey: "daily-work", displayName: "Daily work", schedule: "0 0 * * *" }],
    };
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@paperclipai/plugin-config-replay", version: manifest.version, type: "module",
      paperclipPlugin: { manifest: "manifest.js", worker: "worker.js" },
    }));
    writeFileSync(path.join(packageRoot, "manifest.js"), `export default ${JSON.stringify(manifest)};`);
    const fixture = fileURLToPath(new URL("./fixtures/plugin-worker-config-replay.mjs", import.meta.url));
    writeFileSync(path.join(packageRoot, "worker.js"),
      `import { start } from ${JSON.stringify(pathToFileURL(fixture).href)}; start(${JSON.stringify(companyId)}, ${JSON.stringify(unconfiguredCompanyId)});`);
    await registry.update(pluginId, { manifest, packagePath: packageRoot });
    await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true, revision: 1 } });

    const manager = createPluginWorkerManager();
    const companyGet = vi.fn(async ({ companyId: id }: { companyId: string }) => ({ id }));
    const loader = pluginLoader(db, {
      localPluginDir: path.join(packageRoot, "home"), resolvePackageRoot: () => packageRoot,
      enableLocalFilesystem: false, enableNpmDiscovery: false,
    }, {
      workerManager: manager, lifecycleManager: { markError: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() },
      jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
      buildHostHandlers: () => createHostClientHandlers({
        pluginId, capabilities: manifest.capabilities,
        services: { companies: { get: companyGet } } as unknown as HostServices,
      }),
      instanceInfo: { instanceId: "config-replay-test", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices);
    const snapshot = () => manager.call(pluginId, "getData", { key: "snapshot", params: {} });
    const expected = (revision: number) => ({
      changes: [{ companyId, config: { enabled: true, revision } }],
      setupCompany: companyId, unconfiguredError: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    try {
      expect((await loader.loadAll()).failed).toBe(0);
      expect(await snapshot()).toMatchObject(expected(1));
      const handle = manager.getWorker(pluginId)!;
      for (const revision of [2, 3]) {
        await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true, revision } });
        const oldPid = handle.diagnostics().pid!;
        let unsubscribe = () => {};
        let readyTimeout: ReturnType<typeof setTimeout> | undefined;
        const ready = new Promise<void>((resolve, reject) => {
          unsubscribe = manager.onWorkerReady!(id => { if (id === pluginId) resolve(); });
          readyTimeout = setTimeout(() => reject(new Error("Worker did not automatically respawn")), 5_000);
        });
        try {
          process.kill(oldPid, "SIGKILL");
          await ready;
        } finally {
          clearTimeout(readyTimeout);
          unsubscribe();
        }
        expect(manager.getWorker(pluginId)).toBe(handle);
        expect(handle.status).toBe("running");
        expect(handle.diagnostics().pid).not.toBe(oldPid);
        expect(await snapshot()).toMatchObject({
          setupCompany: companyId, unconfiguredError: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
        await vi.waitFor(async () => expect(await snapshot()).toMatchObject(expected(revision)), { timeout: 5_000 });
        await manager.call(pluginId, "runJob", { job: {
          jobKey: "daily-work", runId: randomUUID(), trigger: "schedule", scheduledAt: new Date().toISOString(),
        } });
        expect(await snapshot()).toMatchObject({ completed: [companyId] });
      }
      expect(companyGet).toHaveBeenCalledTimes(3);
      expect(companyGet.mock.calls.every(([params]) => params.companyId === companyId)).toBe(true);

      await loader.unloadSingle(pluginId, manifest.id);
      expect((await loader.loadSingle(pluginId)).success).toBe(true);
      expect(manager.getWorker(pluginId)).not.toBe(handle);
      expect(await snapshot()).toMatchObject(expected(3));
    } finally {
      await loader.shutdownAll();
      rmSync(packageRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
