import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companies, createDb, pluginConfig, plugins } from '@paperclipai/db';
import { pluginRegistryService } from '../services/plugin-registry.js';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error(`Postgres required: ${support.reason}`);
// Data safety: exercise concurrent PostgreSQL UPDATEs through independent
// clients, not a JavaScript clock or an in-process delivery lock.
describe('RFL durable timestamp revisions', () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase('rfl-pg-revision-');
    db = createDb(database.connectionString);
  }, 60000);
  afterAll(async () => { await database?.cleanup(); });
  it('32 concurrent writes from two DB clients have 32 distinct increasing millisecond revisions', async () => {
    const other = createDb(database.connectionString);
    const companyId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: 'RFL concurrency', issuePrefix: 'RFLCONC' });
    await db.insert(plugins).values({ id: pluginId, pluginKey: 'paperclip.rfl-concurrency', packageName: '@rfl/concurrency', version: '0.0.1', apiVersion: 1, categories: ['automation'], status: 'ready', installOrder: 1,
      manifestJson: { id: 'paperclip.rfl-concurrency', apiVersion: 1, version: '0.0.1', displayName: 'RFL', description: 'RFL data safety', author: 'RFL', categories: ['automation'], capabilities: [], entrypoints: { worker: 'worker.js' } } });
    const future = new Date('2100-01-01T00:00:00Z');
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: {}, updatedAt: future });
    const writers = [pluginRegistryService(db), pluginRegistryService(other)];
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => writers[i % 2].upsertConfig(pluginId, companyId, { companyId, configJson: { request: i } })));
    const revisions = results.map(row => row.updatedAt.getTime()).sort((a,b) => a-b);
    const stored = await writers[0].getConfig(pluginId, companyId);
    console.log('RFL_PG_REVISIONS', JSON.stringify({ writes: revisions.length, distinct: new Set(revisions).size, firstDeltaMs: revisions[0]-future.getTime(), lastDeltaMs: revisions.at(-1)!-future.getTime() }));
    expect(revisions).toEqual(Array.from({ length: 32 }, (_, i) => future.getTime() + i + 1));
    expect(stored!.updatedAt.getTime()).toBe(revisions.at(-1));
    expect(stored!.configJson).toEqual(results.find(row => row.updatedAt.getTime() === revisions.at(-1))!.configJson);
  });
});
