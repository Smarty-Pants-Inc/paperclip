import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { activityLog, companies, createDb, pluginConfig, plugins } from '@paperclipai/db';
import { createHostClientHandlers, PLUGIN_RPC_ERROR_CODES, type HostServices } from '@paperclipai/plugin-sdk';
import type { PaperclipPluginManifestV1 } from '@paperclipai/shared';
import { pluginLoader, type PluginRuntimeServices } from '../services/plugin-loader.js';
import { createPluginWorkerManager } from '../services/plugin-worker-manager.js';
import { pluginRegistryService } from '../services/plugin-registry.js';
import { pluginRoutes } from '../routes/plugins.js';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

// Independent host-contract checks: actual PostgreSQL, loader, manager, SDK child
// processes, SIGKILLs and HTTP settings save. Only unrelated schedulers are stubs.
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite('judge: stored-config respawn acceptance', () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase('judge-cfg-replay-');
    db = createDb(database.connectionString);
  }, 60000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(activityLog);
    await db.delete(companies);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const [a, b, denied] = ids;
    for (const id of ids) await db.insert(companies).values({ id, name: `judge ${id}`, issuePrefix: `J${id.replaceAll('-', '').slice(0, 8).toUpperCase()}` });
    const id = randomUUID();
    const root = mkdtempSync(path.join(os.tmpdir(), 'judge-cfg-package-'));
    const manifest: PaperclipPluginManifestV1 = {
      id: 'paperclip.judge-config', apiVersion: 1, version: '0.0.1', displayName: 'Judge',
      description: 'Independent acceptance fixture', author: 'Judge', categories: ['automation'],
      capabilities: ['companies.read', 'jobs.schedule'], entrypoints: { worker: 'worker.js' },
      jobs: [{ jobKey: 'daily', displayName: 'daily', schedule: '0 0 * * *' }],
    };
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@judge/plugin-config', version: '0.0.1', type: 'module', paperclipPlugin: { manifest: 'manifest.js', worker: 'worker.js' } }));
    writeFileSync(path.join(root, 'manifest.js'), `export default ${JSON.stringify(manifest)};`);
    const worker = fileURLToPath(new URL('./fixtures/judge-config-worker.mjs', import.meta.url));
    writeFileSync(path.join(root, 'worker.js'), `import { start } from ${JSON.stringify(pathToFileURL(worker).href)}; start(${JSON.stringify(denied)});`);
    await db.insert(plugins).values({ id, pluginKey: manifest.id, packageName: '@judge/plugin-config', version: '0.0.1', apiVersion: 1, categories: ['automation'], manifestJson: manifest, status: 'ready', installOrder: 1, packagePath: root });
    const registry = pluginRegistryService(db);
    const save = (companyId: string, configJson: Record<string, unknown>) => registry.upsertConfig(id, companyId, { companyId, configJson });
    await save(a, { enabled: true, revision: 1 });
    await save(b, { enabled: true, revision: 1 });
    const manager = createPluginWorkerManager();
    const loader = pluginLoader(db, { localPluginDir: path.join(root, 'home'), resolvePackageRoot: () => root, enableLocalFilesystem: false, enableNpmDiscovery: false }, {
      workerManager: manager, lifecycleManager: { markError: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() }, jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
      buildHostHandlers: () => createHostClientHandlers({ pluginId: id, capabilities: manifest.capabilities,
        services: { companies: { get: async ({ companyId }: { companyId: string }) => ({ id: companyId }) } } as unknown as HostServices }),
      instanceInfo: { instanceId: 'judge', hostVersion: '1.0.0' },
    } as unknown as PluginRuntimeServices);
    const snapshot = () => manager.call(id, 'getData', { key: 'snapshot', params: {} }) as Promise<any>;
    expect((await loader.loadAll()).failed).toBe(0);
    expect((await snapshot()).changes).toHaveLength(2);
    const handle = manager.getWorker(id)!;
    async function crash() {
      const before = handle.diagnostics().pid!;
      let unsub = () => {};
      let timer: ReturnType<typeof setTimeout>;
      const ready = new Promise<void>((resolve, reject) => {
        unsub = manager.onWorkerReady!(pluginId => { if (pluginId === id) resolve(); });
        timer = setTimeout(() => reject(new Error('automatic respawn timeout')), 10000);
      });
      try { process.kill(before, 'SIGKILL'); await ready; }
      finally { clearTimeout(timer!); unsub(); }
      expect(handle.status).toBe('running');
      expect(handle.diagnostics().pid).not.toBe(before);
      expect(manager.getWorker(id)).toBe(handle);
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: 'board', userId: 'judge', source: 'local_implicit', isInstanceAdmin: true, companyIds: ids } as any; next(); });
    app.use('/api', pluginRoutes(db, loader, undefined, undefined, undefined, { workerManager: manager } as any));
    async function httpSave(companyId: string, configJson: Record<string, unknown>) {
      const response = await request(app).post(`/api/plugins/${id}/config`).send({ companyId, configJson });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    async function cleanup() {
      writeFileSync(path.join(root, 'gate'), 'released');
      await loader.shutdownAll();
      rmSync(root, { recursive: true, force: true });
    }
    return { a, b, denied, id, root, registry, manager, loader, save, snapshot, crash, httpSave, cleanup, handle };
  }

  it('normal settings save, replacement, and five SIGKILL respawns deliver once per company/event; references survive', async () => {
    const f = await fixture();
    try {
      await f.httpSave(f.b, { enabled: true, revision: 2 });
      const s = await f.snapshot();
      expect(s.changes.filter((x: any) => x.companyId === f.a)).toHaveLength(1);
      expect(s.changes.filter((x: any) => x.companyId === f.b)).toHaveLength(2);
      const tokenRef = { type: 'secret_ref', secretId: randomUUID(), version: 'latest' };
      for (let revision = 3; revision <= 7; revision++) {
        await f.save(f.a, { enabled: true, revision, tokenRef });
        await f.crash();
        await vi.waitFor(async () => expect((await f.snapshot()).changes).toHaveLength(2), { timeout: 5000 });
        const current = await f.snapshot();
        expect(current.latest[f.a]).toEqual({ enabled: true, revision, tokenRef });
        expect(current.latest[f.b]).toEqual({ enabled: true, revision: 2 });
        expect(current.deniedCode).toBe(PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED);
        await f.manager.call(f.id, 'runJob', { job: { jobKey: 'daily', runId: randomUUID(), trigger: 'schedule', scheduledAt: new Date().toISOString() } });
        expect((await f.snapshot()).completed.sort()).toEqual([f.a, f.b].sort());
        console.log('JUDGE_NORMAL_RESPAWN', JSON.stringify({ revision, changes: current.changes.length, pid: current.pid, deniedCode: current.deniedCode }));
      }
      await f.loader.unloadSingle(f.id, 'paperclip.judge-config');
      expect((await f.loader.loadSingle(f.id)).success).toBe(true);
      expect(f.manager.getWorker(f.id)).not.toBe(f.handle);
      expect((await f.snapshot()).changes).toHaveLength(2);
    } finally { await f.cleanup(); }
  }, 45000);

  it('deleted company config is absent on the next respawn and enabled:false stays off', async () => {
    const f = await fixture();
    try {
      await f.registry.deleteConfig(f.id, f.b);
      await f.save(f.a, { enabled: false, revision: 2 });
      await f.crash();
      await vi.waitFor(async () => expect((await f.snapshot()).changes).toHaveLength(1), { timeout: 5000 });
      const s = await f.snapshot();
      expect(s.changes).toEqual([{ companyId: f.a, config: { enabled: false, revision: 2 } }]);
      expect(s.latest[f.b]).toBeUndefined();
      expect(s.deniedCode).toBe(PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED);
      await f.manager.call(f.id, 'runJob', { job: { jobKey: 'daily', runId: randomUUID(), trigger: 'schedule', scheduledAt: new Date().toISOString() } });
      expect((await f.snapshot()).completed).toEqual([]);
      console.log('JUDGE_DELETED_DISABLED', JSON.stringify(s));
    } finally { await f.cleanup(); }
  }, 20000);

  it('LATEST config wins when HTTP settings save races sequential respawn replay', async () => {
    const f = await fixture();
    const gate = path.join(f.root, 'gate');
    try {
      // A slow but healthy first company config handler leaves B in the stored snapshot.
      await f.save(f.a, { enabled: true, revision: 2, gate });
      await f.crash();
      await vi.waitFor(() => expect(existsSync(`${gate}.entered`)).toBe(true), { timeout: 5000 });
      await f.httpSave(f.b, { enabled: false, revision: 2 });
      expect((await f.snapshot()).latest[f.b]).toEqual({ enabled: false, revision: 2 });
      writeFileSync(gate, 'release');
      await vi.waitFor(async () => expect((await f.snapshot()).changes).toHaveLength(3), { timeout: 5000 });
      const s = await f.snapshot();
      const stored = await f.registry.getConfig(f.id, f.b);
      console.log('JUDGE_SETTINGS_RACE', JSON.stringify({ changes: s.changes, runtimeB: s.latest[f.b], storedB: stored?.configJson }));
      expect(s.latest[f.b]).toEqual(stored?.configJson);
    } finally { await f.cleanup(); }
  }, 20000);

  it('old replay reads cannot cross process generations on a reused handle', async () => {
    const f = await fixture();
    let release = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let captured = () => {};
    const didCapture = new Promise<void>(resolve => { captured = resolve; });
    let armed = true;
    // Delay delivery of ONE real DB query result, not the query's rows or the worker.
    // Models a slow read completion spanning a second automatic respawn.
    const select = db.select.bind(db) as any;
    const spy = vi.spyOn(db, 'select').mockImplementation(((...args: any[]) => {
      const builder = select(...args);
      const from = builder.from.bind(builder);
      builder.from = (table: any) => {
        const query = from(table);
        if (table === pluginConfig) {
          const orderBy = query.orderBy.bind(query);
          query.orderBy = (...ordering: any[]) => {
            const result = orderBy(...ordering);
            if (!armed) return result;
            armed = false;
            return (async () => { const rows = await result; captured(); await released; return rows; })();
          };
        }
        return query;
      };
      return builder;
    }) as any);
    try {
      await f.crash();
      await didCapture;
      const firstPid = f.handle.diagnostics().pid;
      await f.save(f.a, { enabled: true, revision: 2 });
      await f.save(f.b, { enabled: true, revision: 2 });
      await f.crash();
      await vi.waitFor(async () => expect((await f.snapshot()).changes).toHaveLength(2), { timeout: 5000 });
      expect((await f.snapshot()).latest[f.a].revision).toBe(2);
      release();
      // Do not invoke shutdown to drain: it sets shuttingDown and would cancel
      // the old read before its generation check, hiding the live-runtime bug.
      // Observe for one bounded second; a correct generation fence stays at 2.
      await vi.waitFor(async () => expect((await f.snapshot()).changes.length).toBeGreaterThan(2), { timeout: 1000 }).catch(() => {});
      const s = await f.snapshot();
      console.log('JUDGE_GENERATION_RACE', JSON.stringify({ firstPid, finalPid: s.pid, changes: s.changes }));
      expect(s.changes).toHaveLength(2);
      expect(s.latest[f.a].revision).toBe(2);
      expect(s.latest[f.b].revision).toBe(2);
    } finally { release(); spy.mockRestore(); await f.cleanup(); }
  }, 25000);

  it('a deleted config must not be delivered from an in-flight replay snapshot', async () => {
    const f = await fixture();
    const gate = path.join(f.root, 'gate');
    try {
      await f.save(f.a, { enabled: true, revision: 2, gate });
      await f.crash();
      await vi.waitFor(() => expect(existsSync(`${gate}.entered`)).toBe(true), { timeout: 5000 });
      await f.registry.deleteConfig(f.id, f.b);
      writeFileSync(gate, 'release');
      await vi.waitFor(async () => expect((await f.snapshot()).changes.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
      // drain replay tasks, without replacing the worker or changing its data
      await f.loader.stopActivationTimeoutRecovery();
      const s = await f.snapshot();
      console.log('JUDGE_DELETE_RACE', JSON.stringify({ deliveredCompanyIds: s.changes.map((x: any) => x.companyId), deletedCompany: f.b, storedB: await f.registry.getConfig(f.id, f.b) }));
      expect(s.latest[f.b]).toBeUndefined();
    } finally { await f.cleanup(); }
  }, 20000);
});
