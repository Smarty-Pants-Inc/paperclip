import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type { IssueComment, PluginJobRecord, PluginJobRunRecord, PluginRecord } from "@paperclipai/shared";
import { createApp } from "../../app.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";

export const GUARDIAN_PLUGIN_ID = "smarty-pants.paperclip-plugin-conversation-guardian";
export const guardianPackagePath = () => process.env.GUARDIAN_PLUGIN_PATH
  || fileURLToPath(new URL("../fixtures/guardian-absent/", import.meta.url));
const execute = promisify(execFile);

type Dashboard = { worker: { status: string; pid: number | null } | null };

/**
 * Route A: the actual app, listening on loopback, with its own production worker
 * manager, loader, namespace migrator, host services and scheduler. No plugin
 * worker imports, service mocks, or factory overrides. Pattern: runner-api-server.ts.
 * The caller owns the migrated, disposable database (also used for stuck-state SQL).
 */
export async function startRealPluginLoader(db: Db) {
  const root = await mkdtemp(path.join(tmpdir(), "guardian-real-loader-"));
  await mkdir(path.join(root, "catalog"));
  const app = await createApp(db, {
    uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
    deploymentMode: "local_trusted", deploymentExposure: "private", authReady: true,
    companyDeletionEnabled: false, announcements: { enabled: false, feedUrl: "" },
    instanceId: `guardian-${randomUUID()}`, localPluginDir: path.join(root, "plugins"),
    // Empty self-hosted catalog avoids booting unrelated bundled providers. Do not
    // use managedPluginAutoInstall: []: managed mode forbids local-path installs.
    bundledPluginCatalogRoot: path.join(root, "catalog"),
    storageService: createStorageService(createLocalDiskStorageProvider(path.join(root, "storage"))),
    decisionServiceOptions: { wakeOriginAgent: async () => undefined },
  });
  await app.locals.bundledPluginsStartup;
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No guardian test listener");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const installed = new Set<string>();

  async function api<T>(route: string, body?: unknown, method = body === undefined ? "GET" : "POST",
    headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(`${baseUrl}/api${route}`, {
      method, headers: { "content-type": "application/json", origin: baseUrl, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  // Dispatch is asynchronous. Observe the durable scheduler run through the UI's
  // read API, bounded to 30s; never treat the trigger's HTTP 200 as completion.
  async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T;
    do {
      last = await read();
      if (done(last)) return last;
      await delay(25);
    } while (Date.now() < deadline);
    throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
  }

  async function install(packagePath = guardianPackagePath()) {
    let directory = await realpath(path.resolve(packagePath));
    if ((await stat(directory)).isFile()) {
      // The board endpoint takes directories. Unpack a local npm tarball first;
      // installation/validation/activation still go through that same endpoint.
      const unpacked = await mkdtemp(path.join(root, "package-"));
      const listing = await execute("tar", ["-tzf", directory]);
      if (listing.stdout.split("\n").some(name => name.startsWith("/") || name.split("/").includes(".."))) {
        throw new Error("Unsafe plugin tarball path");
      }
      await execute("tar", ["-xzf", directory, "--no-same-owner", "-C", unpacked]);
      directory = path.join(unpacked, "package");
    }
    const plugin = await api<PluginRecord>("/plugins/install", { packageName: directory, isLocalPath: true });
    installed.add(plugin.id);
    if (plugin.status !== "ready") throw new Error(`Plugin activation failed: ${JSON.stringify(plugin)}`);
    const dashboard = await waitFor("real worker startup", () => api<Dashboard>(`/plugins/${plugin.id}/dashboard`),
      value => value.worker?.status === "running" && Number.isInteger(value.worker.pid));
    console.log("REAL_PLUGIN_INSTALLED", JSON.stringify({ pluginKey: plugin.pluginKey, pluginId: plugin.id, worker: dashboard.worker }));
    return plugin;
  }

  async function setCompanyConfig(pluginId: string, companyId: string, configJson: Record<string, unknown> = { enabled: true }) {
    return api(`/plugins/${pluginId}/config`, { companyId, configJson });
  }

  async function jobRuns(pluginId: string, jobKey = "sweep") {
    const jobs = await api<PluginJobRecord[]>(`/plugins/${pluginId}/jobs`);
    const job = jobs.find(candidate => candidate.jobKey === jobKey);
    if (!job) throw new Error(`No registered job ${jobKey} for ${pluginId}`);
    return api<PluginJobRunRecord[]>(`/plugins/${pluginId}/jobs/${job.id}/runs?limit=500`);
  }

  async function triggerJob(pluginId: string, jobKey = "sweep") {
    const jobs = await api<PluginJobRecord[]>(`/plugins/${pluginId}/jobs`);
    const job = jobs.find(candidate => candidate.jobKey === jobKey);
    if (!job) throw new Error(`No registered job ${jobKey} for ${pluginId}`);
    return api<{ runId: string }>(`/plugins/${pluginId}/jobs/${job.id}/trigger`, {});
  }

  async function waitForJob(pluginId: string, runId: string, jobKey = "sweep") {
    return waitFor("real job completion", async () => (await jobRuns(pluginId, jobKey)).find(run => run.id === runId),
      value => !!value && !["pending", "queued", "running"].includes(value.status));
  }

  async function runJob(pluginId: string, jobKey = "sweep") {
    const receipt = await triggerJob(pluginId, jobKey);
    const run = await waitForJob(pluginId, receipt.runId, jobKey);
    if (run?.status !== "succeeded") throw new Error(`Guardian job did not succeed: ${JSON.stringify(run)}`);
    console.log("REAL_PLUGIN_JOB", JSON.stringify({ pluginId, jobKey, runId: run.id, status: run.status, trigger: run.trigger }));
    return run;
  }

  async function restartWorker(pluginId: string) {
    const before = await api<Dashboard>(`/plugins/${pluginId}/dashboard`);
    await api(`/plugins/${pluginId}/disable`, {});
    const stopped = await api<Dashboard>(`/plugins/${pluginId}/dashboard`);
    if (stopped.worker?.status === "running") throw new Error("Worker did not stop");
    await api(`/plugins/${pluginId}/enable`, {});
    const after = await waitFor("worker restart", () => api<Dashboard>(`/plugins/${pluginId}/dashboard`),
      value => value.worker?.status === "running" && !!value.worker.pid && value.worker.pid !== before.worker?.pid);
    console.log("REAL_PLUGIN_RESTART", JSON.stringify({ pluginId, before: before.worker, stopped: stopped.worker, after: after.worker }));
    return { before, stopped, after };
  }

  return {
    api, install, setCompanyConfig, runJob, triggerJob, waitForJob, jobRuns, waitFor, restartWorker, baseUrl,
    comments: (issueId: string) => api<IssueComment[]>(`/issues/${issueId}/comments`),
    dashboard: (pluginId: string) => api<Dashboard>(`/plugins/${pluginId}/dashboard`),
    async close() {
      try {
        // app shutdown drains jobs; explicit disable also terminates the real
        // child workers. Neither operation purges their database namespaces.
        for (const pluginId of installed) {
          const plugin = await api<PluginRecord>(`/plugins/${pluginId}`);
          if (plugin.status === "ready") await api(`/plugins/${pluginId}/disable`, {});
        }
      } finally {
        try { await app.locals.paperclipShutdown(); }
        finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          await rm(root, { recursive: true, force: true });
        }
      }
    },
  };
}

/** Only the marked F1-b harness line calls this; the judge's reads/asserts stay intact. */
export async function runGuardianBoundaryJob(db: Db, companyId: string) {
  const runtime = await startRealPluginLoader(db);
  try {
    const plugin = await runtime.install();
    if (plugin.pluginKey !== GUARDIAN_PLUGIN_ID) throw new Error(`Wrong guardian: ${plugin.pluginKey}`);
    await runtime.setCompanyConfig(plugin.id, companyId);
    await runtime.runJob(plugin.id);
  } finally { await runtime.close(); }
}
