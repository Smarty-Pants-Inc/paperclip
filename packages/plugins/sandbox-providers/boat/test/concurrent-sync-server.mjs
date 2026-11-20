// BRIEF row (c): real HTTP app, PostgreSQL, worker process and server resolvers.
// No model or live Boat call; this proves capability propagation, not chat latency.
// From repo root, after Boat build (or pass an extracted package as PROVIDER):
// node --import ./server/node_modules/tsx/dist/loader.mjs \
//   packages/plugins/sandbox-providers/boat/test/concurrent-sync-server.mjs ROOT PROVIDER OUTPUT_JSON
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, provider, output] = process.argv.slice(2).map(value => path.resolve(value));
for (const file of [path.join(repo, "server/src/app.ts"), path.join(provider, "dist/worker.js"), path.join(provider, "dist/manifest.js")]) await fs.access(file);
assert(!process.env.DATABASE_URL && !process.env.PAPERCLIP_TEST_DATABASE_URL, "Use only this probe's disposable embedded database");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "boat-concsync-server-"));
process.env.PAPERCLIP_HOME = path.join(root, "home");
const load = file => import(pathToFileURL(path.join(repo, file)).href);
const { createDb, startEmbeddedPostgresTestDatabase, companies, environments, environmentLeases, plugins } = await load("packages/db/src/index.ts");
const { eq } = await import(pathToFileURL(path.join(repo, "server/node_modules/drizzle-orm/index.js")).href);
const { createApp } = await load("server/src/app.ts");
const { createStorageService } = await load("server/src/storage/service.ts");
const { createLocalDiskStorageProvider } = await load("server/src/storage/local-disk-provider.ts");
const { createPluginWorkerManager } = await load("server/src/services/plugin-worker-manager.ts");
const { environmentRuntimeService } = await load("server/src/services/environment-runtime.ts");
const { resolveEnvironmentExecutionTarget } = await load("server/src/services/environment-execution-target.ts");
const { default: manifest } = await import(pathToFileURL(path.join(provider, "dist/manifest.js")).href);
let temporary, manager, app, http;
const result = { provider, version: manifest.version, node: process.version, platform: `${process.platform}/${process.arch}`,
  dependencyScope: "real local app/PostgreSQL/worker; no model or live Boat", rows: [] };
try {
  temporary = await startEmbeddedPostgresTestDatabase("boat-concurrent-capability-");
  const db = createDb(temporary.connectionString);
  manager = createPluginWorkerManager();
  app = await createApp(db, {
    uiMode: "none", serverPort: 0,
    storageService: createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))),
    deploymentMode: "local_trusted", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
    authReady: true, companyDeletionEnabled: false, managedPluginAutoInstall: [], localPluginDir: path.join(root, "plugins"),
    instanceId: `boat-concsync-${randomUUID()}`, pluginWorkerManager: manager,
    decisionServiceOptions: { wakeOriginAgent: async () => undefined },
  });
  http = createServer(app);
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  result.url = `http://127.0.0.1:${http.address().port}`;
  result.serverPid = process.pid;
  const health = await fetch(`${result.url}/api/health`);
  assert.equal(health.status, 200); result.health = await health.json();

  const companyId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID(), leaseId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Boat concurrency contract probe", issuePrefix: `C${companyId.slice(0, 7).toUpperCase()}` });
  await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@paperclipai/plugin-boat", packagePath: provider,
    status: "ready", version: manifest.version, manifestJson: manifest });
  const [environment] = await db.insert(environments).values({ id: environmentId, name: "Boat concurrency contract", driver: "sandbox",
    config: { provider: "boat", apiKey: "fixture-not-a-credential", reuseLease: true } }).returning();
  const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, status: "active",
    provider: "boat", providerLeaseId: "bx_concurrent_probe", leasePolicy: "reuse_by_environment",
    metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, provider: "boat", remoteCwd: root } }).returning();
  const worker = await manager.startWorker(pluginId, { entrypointPath: path.join(provider, "dist/worker.js"), manifest, config: {}, apiVersion: 1,
    instanceInfo: { instanceId: "boat-concsync-probe", hostVersion: "0.0.0" }, hostHandlers: {},
    // Workspace SDK dependencies export TypeScript; the provider itself is the
    // emitted/extracted dist, while its workspace dependencies need the loader.
    env: { TMPDIR: root, NODE_OPTIONS: `--import ${path.join(repo, "server/node_modules/tsx/dist/loader.mjs")}` },
  });
  result.workerPid = worker.diagnostics().pid;
  result.supportedMethods = worker.supportedMethods;
  assert(worker.supportedMethods.includes("environmentSyncIn"));
  assert(worker.supportedMethods.includes("environmentSyncOut"));
  const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager });
  const resolveTarget = () => resolveEnvironmentExecutionTarget({ db, companyId, adapterType: "paperclip_runner", environment,
    leaseId, leaseMetadata: lease.metadata, lease, environmentRuntime: runtime });
  const target = await resolveTarget();
  result.rows.push({ name: "persisted declaration + discovered worker methods -> effective snapshot + raw runner",
    targetKind: target?.kind, effective: target?.effectiveCapabilities, allowConcurrentSyncOperations: target?.runner?.allowConcurrentSyncOperations });
  assert.equal(target?.effectiveCapabilities?.concurrentSyncOperations, true);
  assert.equal(target?.runner?.allowConcurrentSyncOperations, true);
  assert.equal(Object.isFrozen(target.effectiveCapabilities), true);
  for (const verb of ["syncIn", "syncOut"]) {
    assert.equal(typeof target.runner[verb], "function");
    assert.deepEqual(await target.runner[verb]([]), { operations: [] });
  }
  result.rows.push({ name: "both native sync verbs dispatch through real server runner and worker", verdict: "PASS" });

  const denied = structuredClone(manifest);
  delete denied.environmentDrivers[0].sandboxCapabilities.concurrentSyncOperations;
  await db.update(plugins).set({ manifestJson: denied }).where(eq(plugins.id, pluginId));
  const withoutDeclaration = await resolveTarget();
  assert.equal(withoutDeclaration.effectiveCapabilities.concurrentSyncOperations, false);
  assert.equal(withoutDeclaration.runner.allowConcurrentSyncOperations, false);
  result.rows.push({ name: "omitted persisted declaration denies concurrency with the same running worker", verdict: "PASS" });
  await db.update(plugins).set({ manifestJson: manifest }).where(eq(plugins.id, pluginId));
  assert.equal((await resolveTarget()).runner.allowConcurrentSyncOperations, true);
  result.verdict = "PASS";
} catch (error) {
  result.verdict = "FAIL"; result.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  try {
    await app?.locals.paperclipShutdown?.();
    await manager?.stopAll();
    if (http?.listening) { http.closeAllConnections(); await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }
    await temporary?.cleanup();
    result.cleanup = { httpClosed: !http?.listening, workersStopped: true, databaseStopped: true };
  } catch (error) { result.cleanupError = error.message; result.verdict = "FAIL"; process.exitCode = 1; }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ verdict: result.verdict, version: result.version, serverPid: result.serverPid, workerPid: result.workerPid, output, error: result.error?.message, cleanup: result.cleanup }));
}
