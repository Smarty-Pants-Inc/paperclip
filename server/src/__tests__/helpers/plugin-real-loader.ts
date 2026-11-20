import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "@paperclipai/db";
import type { PluginRecord } from "@paperclipai/shared";
import { createApp } from "../../app.js";
import { createPluginWorkerManager } from "../../services/plugin-worker-manager.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";

type Dashboard = { worker: { status: string; pid: number | null } | null };

/**
 * The actual app, listening on loopback, with its own production worker manager,
 * loader, namespace migrator, host services and scheduler. No plugin worker
 * imports, service mocks, or factory overrides. Pattern: runner-api-server.ts.
 * The caller owns the migrated, disposable database.
 */
export async function startRealPluginLoader(db: Db, options: { recoverDeferredWakes?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-real-loader-"));
  await mkdir(path.join(root, "catalog"));
  const workers = createPluginWorkerManager();
  const app = await createApp(db, {
    pluginWorkerManager: workers,
    uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
    deploymentMode: "local_trusted", deploymentExposure: "private", authReady: true,
    companyDeletionEnabled: false, announcements: { enabled: false, feedUrl: "" },
    instanceId: `real-loader-${randomUUID()}`, localPluginDir: path.join(root, "plugins"),
    // Empty self-hosted catalog avoids booting unrelated bundled providers. Do not
    // use managedPluginAutoInstall: []: managed mode forbids local-path installs.
    bundledPluginCatalogRoot: path.join(root, "catalog"),
    storageService: createStorageService(createLocalDiskStorageProvider(path.join(root, "storage"))),
    decisionServiceOptions: { wakeOriginAgent: async () => undefined },
  });
  await app.locals.bundledPluginsStartup;
  // The same startup pass index.ts registers after plugin availability. Opt-in
  // keeps unrelated plugin-loader journeys at their existing boundary.
  const deferredWork = options.recoverDeferredWakes ? heartbeatService(db, { pluginWorkerManager: workers })
    .registerDeferredReceiptWork(app.locals.deliveryWork, () => true) : undefined;
  await deferredWork?.ready;
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No real-loader test listener");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const installed = new Set<string>();

  async function api<T>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(`${baseUrl}/api${route}`, {
      method, headers: { "content-type": "application/json", origin: baseUrl },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  /** Installs a local plugin directory through the board endpoint and waits for its real worker. */
  async function install(packagePath: string) {
    const directory = await realpath(path.resolve(packagePath));
    const plugin = await api<PluginRecord>("/plugins/install", { packageName: directory, isLocalPath: true });
    installed.add(plugin.id);
    if (plugin.status !== "ready") throw new Error(`Plugin activation failed: ${JSON.stringify(plugin)}`);
    const deadline = Date.now() + 30_000;
    let dashboard: Dashboard;
    do {
      dashboard = await api<Dashboard>(`/plugins/${plugin.id}/dashboard`);
      if (dashboard.worker?.status === "running" && Number.isInteger(dashboard.worker.pid)) break;
      await delay(25);
    } while (Date.now() < deadline);
    if (dashboard.worker?.status !== "running") throw new Error(`real worker startup timed out: ${JSON.stringify(dashboard)}`);
    console.log("REAL_PLUGIN_INSTALLED", JSON.stringify({ pluginKey: plugin.pluginKey, pluginId: plugin.id, worker: dashboard.worker }));
    return plugin;
  }

  return {
    api, install, baseUrl, workers,
    recheckDeferredWakes() {
      if (!deferredWork) throw new Error("Deferred wake recovery was not registered");
      deferredWork.wake();
    },
    async close(options: { preserveInstall?: boolean } = {}) {
      try {
        // App shutdown drains jobs; explicit disable also terminates the real
        // child workers. Neither operation purges their database namespaces.
        for (const pluginId of options.preserveInstall ? [] : installed) {
          const plugin = await api<PluginRecord>(`/plugins/${pluginId}`);
          if (plugin.status === "ready") await api(`/plugins/${pluginId}/disable`, {});
        }
      } finally {
        try { await app.locals.paperclipShutdown(); await workers.stopAll(); }
        finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  };
}
