import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
// Data-safety keep reason: the existing timestamp is now a revision fence;
// exercise PostgreSQL's locked-row expression rather than mocking the clock.
suite("plugin config timestamp revisions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-config-revision-");
    db = createDb(database.connectionString);
  }, 60000);
  afterAll(async () => { await database?.cleanup(); });

  it("upsert, patch and error updates advance beyond a future timestamp at Date precision", async () => {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Config revision", issuePrefix: "CFGREV" });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "paperclip.config-revision", packageName: "@test/config-revision",
      version: "0.0.1", apiVersion: 1, categories: [], status: "ready", installOrder: 1,
      manifestJson: {
        id: "paperclip.config-revision", apiVersion: 1, version: "0.0.1", displayName: "Config revision",
        description: "Config revision test", author: "Test", categories: ["automation"], capabilities: [],
        entrypoints: { worker: "worker.js" },
      },
    });
    const future = new Date("2100-01-01T00:00:00.000Z");
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: { enabled: true }, updatedAt: future });
    const registry = pluginRegistryService(db);
    const saved = await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: false } });
    expect(saved.updatedAt.getTime()).toBeGreaterThan(future.getTime());
    const patched = await registry.patchConfig(pluginId, companyId, { companyId, configJson: { revision: 2 } });
    expect(patched.updatedAt.getTime()).toBeGreaterThan(saved.updatedAt.getTime());
    await registry.setConfigError(pluginId, companyId, "test error");
    const latest = await registry.getConfig(pluginId, companyId);
    expect(latest!.updatedAt.getTime()).toBeGreaterThan(patched.updatedAt.getTime());
    expect(latest!.configJson).toEqual({ enabled: false, revision: 2 });
  });
});
