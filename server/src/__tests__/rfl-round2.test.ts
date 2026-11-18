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

// Independent data-safety checks. Real PG, loader, SDK subprocess, SIGKILL and
// settings HTTP route; scheduler/external services stubbed. No provider access.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error(`Required PostgreSQL support unavailable: ${support.reason}`);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('RFL round 2 independent process acceptance', () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase('rfl-round2-db-');
    db = createDb(database.connectionString);
  }, 60000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(pluginConfig); await db.delete(plugins);
    await db.delete(activityLog); await db.delete(companies);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function setup(workerFixture = './fixtures/rfl-round2-worker.mjs') {
    const [a, b, denied] = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of [a,b,denied]) await db.insert(companies).values({ id, name: 'RFL local fixture', issuePrefix: `R${id.replaceAll('-', '').slice(0,8).toUpperCase()}` });
    const id = randomUUID();
    const root = mkdtempSync(path.join(os.tmpdir(), 'rfl-round2-plugin-'));
    const manifest: PaperclipPluginManifestV1 = {
      id: 'paperclip.rfl-round2', apiVersion: 1, version: '0.0.1', displayName: 'RFL round2',
      description: 'Independent process tests', author: 'RFL', categories: ['automation'],
      capabilities: ['companies.read', 'jobs.schedule'], entrypoints: { worker: 'worker.js' },
      jobs: [{ jobKey: 'check-access', displayName: 'Check access', schedule: '0 0 * * *' }],
    };
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@rfl/round2', version: '0.0.1', type: 'module', paperclipPlugin: { manifest: 'manifest.js', worker: 'worker.js' } }));
    writeFileSync(path.join(root, 'manifest.js'), `export default ${JSON.stringify(manifest)};`);
    const worker = fileURLToPath(new URL(workerFixture, import.meta.url));
    writeFileSync(path.join(root, 'worker.js'), `import { start } from ${JSON.stringify(pathToFileURL(worker).href)}; start(${JSON.stringify(denied)});`);
    await db.insert(plugins).values({ id, pluginKey: manifest.id, packageName: '@rfl/round2', version: '0.0.1', apiVersion: 1, categories: ['automation'], manifestJson: manifest, status: 'ready', installOrder: 1, packagePath: root });
    const registry = pluginRegistryService(db);
    const save = (companyId: string, configJson: Record<string, unknown>) => registry.upsertConfig(id, companyId, { companyId, configJson });
    await save(a, { enabled: true, revision: 1 }); await save(b, { enabled: true, revision: 1 });
    const manager = createPluginWorkerManager();
    const loader = pluginLoader(db, { localPluginDir: path.join(root, 'home'), resolvePackageRoot: () => root, enableLocalFilesystem: false, enableNpmDiscovery: false }, {
      workerManager: manager, lifecycleManager: { markError: vi.fn() },
      jobStore: { syncJobDeclarations: vi.fn() }, jobScheduler: { registerPlugin: vi.fn(), unregisterPlugin: vi.fn(), stop: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      eventBus: { forPlugin: vi.fn(), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
      buildHostHandlers: () => createHostClientHandlers({ pluginId: id, capabilities: manifest.capabilities,
        services: { companies: { get: async ({ companyId }: { companyId: string }) => ({ id: companyId }) } } as unknown as HostServices }),
      instanceInfo: { instanceId: 'rfl-local', hostVersion: '1.0.0' },
    } as unknown as PluginRuntimeServices);
    const state = () => manager.call(id, 'getData', { key: 'state', params: {} }) as Promise<any>;
    expect((await loader.loadAll()).failed).toBe(0);
    expect((await state()).history).toHaveLength(2);
    const handle = manager.getWorker(id)!;
    async function crash() {
      const pid = handle.diagnostics().pid!;
      const ready = deferred();
      const off = manager.onWorkerReady!(which => { if (which === id) ready.resolve(); });
      let timeout: ReturnType<typeof setTimeout>;
      try {
        process.kill(pid, 'SIGKILL');
        await Promise.race([ready.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('respawn timeout')), 10000); })]);
      } finally { off(); clearTimeout(timeout!); }
      expect(manager.getWorker(id)).toBe(handle);
      expect(handle.diagnostics().pid).not.toBe(pid);
    }
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: 'board', userId: 'rfl', source: 'local_implicit', isInstanceAdmin: true, companyIds: [a,b,denied] } as any; next(); });
    app.use('/api', pluginRoutes(db, loader, undefined, undefined, undefined, { workerManager: manager } as any));
    const httpSave = async (companyId: string, configJson: Record<string, unknown>) => {
      const response = await request(app).post(`/api/plugins/${id}/config`).send({ companyId, configJson });
      expect(response.status).toBe(200);
    };
    const gate = path.join(root, 'gate');
    const release = () => writeFileSync(gate, 'released');
    const waitEntered = () => vi.waitFor(() => expect(existsSync(`${gate}.entered`)).toBe(true), { timeout: 5000 });
    const waitHistory = (n: number) => vi.waitFor(async () => expect((await state()).history).toHaveLength(n), { timeout: 5000 });
    const close = async () => { release(); await loader.shutdownAll(); rmSync(root, { recursive: true, force: true }); };
    return { a,b,denied,id,root,registry,save,manager,loader,state,handle,crash,httpSave,gate,release,waitEntered,waitHistory,close };
  }

  it('R1-save: disable delivered by HTTP cannot be undone by delayed B replay', async () => {
    const f = await setup();
    try {
      await f.save(f.a, { revision: 2, enabled: true, gate: f.gate });
      await f.crash(); await f.waitEntered();
      await f.httpSave(f.b, { revision: 2, enabled: false });
      expect((await f.state()).latest[f.b].enabled).toBe(false);
      f.release();
      await vi.waitFor(async () => expect((await f.state()).latest[f.a]?.revision).toBe(2), { timeout: 5000 });
      await pause(200);
      const state = await f.state();
      console.log('RFL_SAVE', JSON.stringify(state.history));
      expect(state.latest[f.b]).toEqual({ revision: 2, enabled: false });
      expect(state.history.filter((x: any) => x.companyId === f.b)).toEqual([{ companyId: f.b, revision: 2, enabled: false }]);
      expect(state.history).toHaveLength(2);
    } finally { await f.close(); }
  }, 20000);

  it('R1-delete: deletion before B delivery is not replayed from the company-list snapshot', async () => {
    const f = await setup();
    try {
      await f.save(f.a, { revision: 2, enabled: true, gate: f.gate });
      await f.crash(); await f.waitEntered();
      await f.registry.deleteConfig(f.id, f.b);
      f.release();
      await vi.waitFor(async () => expect((await f.state()).history.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
      await pause(250);
      const state = await f.state();
      console.log('RFL_DELETE', JSON.stringify(state.history));
      expect(state.history.map((x: any) => x.companyId)).toEqual([f.a]);
    } finally { await f.close(); }
  }, 20000);

  it('R1-generation: a suspended list read from an old PID cannot deliver to the reused handle', async () => {
    const f = await setup(); const captured = deferred(); const release = deferred();
    let armed = true;
    const select = db.select.bind(db) as any;
    const spy = vi.spyOn(db, 'select').mockImplementation(((...args: any[]) => {
      const builder = select(...args); const from = builder.from.bind(builder);
      builder.from = (table: any) => {
        const query = from(table);
        if (table === pluginConfig) {
          const orderBy = query.orderBy.bind(query);
          query.orderBy = (...args: any[]) => {
            const rows = orderBy(...args);
            if (!armed) return rows;
            armed = false;
            return (async () => { const result = await rows; captured.resolve(); await release.promise; return result; })();
          };
        }
        return query;
      };
      return builder;
    }) as any);
    try {
      await f.crash(); await captured.promise;
      await f.save(f.a, { revision: 2, enabled: false }); await f.save(f.b, { revision: 2, enabled: false });
      await f.crash(); await f.waitHistory(2);
      release.resolve(); await pause(300);
      const state = await f.state();
      console.log('RFL_GENERATION', JSON.stringify(state.history));
      expect(state.history).toHaveLength(2);
      expect(Object.values(state.latest).map((x: any) => x.revision)).toEqual([2,2]);
    } finally { release.resolve(); spy.mockRestore(); await f.close(); }
  }, 25000);

  it('JOB composition: respawned runJob can read configured companies but not an unconfigured one', async () => {
    const f = await setup();
    try {
      await f.crash(); await f.waitHistory(2);
      await f.manager.call(f.id, 'runJob', { job: { jobKey: 'check-access', runId: randomUUID(), trigger: 'schedule', scheduledAt: new Date().toISOString() } });
      const state = await f.state(); console.log('RFL_JOB_ACCESS', JSON.stringify(state.jobs));
      expect(state.jobs).toEqual([[{ companyId: f.a, read: f.a }, { companyId: f.b, read: f.b }, { companyId: f.denied, error: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED }]]);
    } finally { await f.close(); }
  }, 20000);

  it('timeout is not completion: older callback must not overwrite a newer successful save', async () => {
    const f = await setup();
    // Real manager timeout, shortened only for configChanged. No mocked result,
    // worker, DB, or settings route. Production default is 30 seconds.
    const call = f.manager.call.bind(f.manager) as any;
    const spy = vi.spyOn(f.manager, 'call').mockImplementation(((id: string, method: string, params: any, ...rest: any[]) =>
      method === 'configChanged' ? call(id, method, params, 150) : call(id, method, params, ...rest)) as any);
    try {
      await f.save(f.a, { revision: 2, enabled: true, gate: f.gate });
      await f.crash(); await f.waitEntered();
      const oldPid = f.handle.diagnostics().pid;
      // RFL 09:08Z ruling: a timed-out callback is retired, not allowed to
      // complete after a newer apply. Do not release the old gate until replay.
      await f.httpSave(f.a, { revision: 3, enabled: false });
      await vi.waitFor(async () => {
        expect(f.handle.diagnostics().pid).not.toBe(oldPid);
        expect((await f.state()).latest[f.a]?.revision).toBe(3);
      }, { timeout: 10000 });
      f.release(); await pause(200);
      const state = await f.state();
      const persisted = (await f.registry.getConfig(f.id, f.a))!.configJson;
      console.log('RFL_TIMEOUT', JSON.stringify({ oldPid, pid: state.pid, history: state.history, persisted }));
      expect(state.latest[f.a]).toEqual(persisted);
      expect(state.history.filter((x: any) => x.companyId === f.a).map((x: any) => x.revision)).toEqual([3]);
    } finally { spy.mockRestore(); await f.close(); }
  }, 20000);

  it('production 30s timeout: a late old callback cannot re-enable a company after disable succeeds', async () => {
    const f = await setup();
    try {
      await f.save(f.a, { revision: 2, enabled: true, gate: f.gate, gateBudgetMs: 45000 });
      await f.crash(); await f.waitEntered();
      const began = Date.now();
      await f.httpSave(f.a, { revision: 3, enabled: false });
      const elapsed = Date.now() - began;
      // RFL 09:08Z ruling supersedes the requirement that old revision 2
      // complete after revision 3. A hung apply must be killed at the deadline.
      await vi.waitFor(async () => expect((await f.state()).latest[f.a]?.revision).toBe(3), { timeout: 10000 });
      f.release(); await pause(200);
      const state = await f.state();
      const persisted = (await f.registry.getConfig(f.id, f.a))!.configJson;
      console.log('RFL_DEFAULT_TIMEOUT', JSON.stringify({ elapsed, history: state.history, persisted }));
      expect(elapsed).toBeGreaterThanOrEqual(29000);
      expect(state.latest[f.a]).toEqual(persisted);
      expect(state.history.filter((x: any) => x.companyId === f.a).map((x: any) => x.revision)).toEqual([3]);
    } finally { await f.close(); }
  }, 50000);

  it('a callback that never returns is killed and the restarted worker ends on DB revision 3', async () => {
    const f = await setup('./fixtures/rfl-config-hung-worker.mjs');
    const call = f.manager.call.bind(f.manager) as any;
    const spy = vi.spyOn(f.manager, 'call').mockImplementation(((id: string, method: string, params: any, ...rest: any[]) =>
      method === 'configChanged' ? call(id, method, params, 150) : call(id, method, params, ...rest)) as any);
    try {
      await f.save(f.a, { revision: 2, enabled: true, gate: f.gate });
      await f.crash(); await f.waitEntered();
      const oldPid = f.handle.diagnostics().pid;
      await f.httpSave(f.a, { revision: 3, enabled: false });
      await vi.waitFor(async () => {
        expect(f.handle.diagnostics().pid).not.toBe(oldPid);
        expect((await f.state()).latest[f.a]?.revision).toBe(3);
      }, { timeout: 10000 });
      await pause(200);
      const state = await f.state();
      expect(state.latest[f.a]).toEqual((await f.registry.getConfig(f.id, f.a))!.configJson);
      expect(state.history.filter((x: any) => x.companyId === f.a).map((x: any) => x.revision)).toEqual([3]);
      expect(() => process.kill(oldPid!, 0)).toThrow();
      console.log('RFL_NEVER_RETURNS', JSON.stringify({ oldPid, pid: state.pid, history: state.history }));
    } finally { spy.mockRestore(); await f.close(); }
  }, 20000);

  it('revision 3 waits for revision 2 to return when the callback completes before timeout', async () => {
    const f = await setup();
    let save: Promise<void> | undefined;
    try {
      await f.save(f.a, { revision: 2, enabled: true, gate: f.gate });
      await f.crash(); await f.waitEntered();
      const pid = f.handle.diagnostics().pid;
      save = f.httpSave(f.a, { revision: 3, enabled: false });
      await vi.waitFor(async () => expect((await f.registry.getConfig(f.id, f.a))!.configJson.revision).toBe(3));
      expect((await f.state()).latest[f.a]).toBeUndefined();
      f.release(); await save;
      const state = await f.state();
      expect(f.handle.diagnostics().pid).toBe(pid);
      expect(state.history.filter((x: any) => x.companyId === f.a).map((x: any) => x.revision)).toEqual([2,3]);
      expect(state.latest[f.a]).toEqual((await f.registry.getConfig(f.id, f.a))!.configJson);
      console.log('RFL_SERIAL_COMPLETION', JSON.stringify({ pid, history: state.history }));
    } finally { f.release(); await save; await f.close(); }
  }, 20000);

  it('four respawns interleaved with saves do not starve the new generation', async () => {
    const f = await setup();
    try {
      for (let revision = 2; revision <= 5; revision++) {
        await f.save(f.a, { revision, enabled: true });
        await f.crash();
        await f.httpSave(f.b, { revision, enabled: false });
        await vi.waitFor(async () => {
          const state = await f.state();
          expect(state.latest[f.a].revision).toBe(revision);
          expect(state.latest[f.b].revision).toBe(revision);
        }, { timeout: 5000 });
      }
      console.log('RFL_CRASH_SAVES', JSON.stringify((await f.state()).history));
    } finally { await f.close(); }
  }, 40000);
});
