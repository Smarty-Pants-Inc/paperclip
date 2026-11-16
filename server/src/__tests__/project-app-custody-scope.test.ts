import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companySecrets, createDb, pluginConfig, plugins, projects, toolConnections } from "@paperclipai/db";

// Only GitHub HTTP is stubbed. The classifier, SQL, vault, connection writer
// and shared credential owner are the production implementations.
const provider = vi.hoisted(() => {
  const state = { appId: 123, calls: [] as string[], onApp: undefined as undefined | (() => Promise<void>) };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    state.calls.push(path);
    if (path === "/app") {
      await state.onApp?.();
      return Response.json({ id: state.appId, client_id: "Iv1scopeclient", slug: "scope-fixture" });
    }
    if (/^\/app\/installations\/\d+$/.test(path)) return Response.json({ id: 456, app_id: state.appId, suspended_at: null,
      account: { login: "owner" }, permissions: { contents: "write", pull_requests: "write", issues: "read" } });
    if (path.endsWith("/access_tokens")) return Response.json({ token: "scope-fixture-token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (path.startsWith("/users/")) return Response.json({ id: 321, login: "scope-fixture[bot]", type: "Bot" });
    if (path === "/installation/repositories") return Response.json({ repositories: [{ id: 101, full_name: "owner/a", private: true }] });
    throw new Error(`Unexpected GitHub HTTP path: ${path}`);
  }));
  return state;
});
import { assertNotManagerApp, readProjectAppManager, ROW12_INSTALLER_PLUGIN_KEY } from "../services/project-app-custody.js";
import { resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { secretService } from "../services/secrets.js";
import { projectConnectionFixture } from "./helpers/project-connections-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("custody seam scope: existing non-project Apps and configured manager exclusion", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let pem: string;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-custody-c-scope-");
    db = createDb(database.connectionString);
    pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }, 90_000);
  beforeEach(() => { provider.appId = 123; provider.calls.length = 0; provider.onApp = undefined; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }, 60_000);

  async function fixture() {
    const f = await projectConnectionFixture(db);
    await secretService(db).rotate(f.secret.id, { value: pem });
    return f;
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  async function manager(f: F) {
    await db.insert(plugins).values({ pluginKey: ROW12_INSTALLER_PLUGIN_KEY, packageName: "@paperclipai/plugin-row12-installer", version: "0.1.0", status: "ready",
      manifestJson: { id: ROW12_INSTALLER_PLUGIN_KEY, capabilities: ["projects.instance-secrets"], instanceSecretKeys: ["manager_private_key"] } as never }).onConflictDoNothing();
    const [plugin] = await db.select().from(plugins).where(eq(plugins.pluginKey, ROW12_INSTALLER_PLUGIN_KEY));
    const [anchor] = await db.insert(projects).values({ companyId: f.companyId, name: "github-manager-key" }).returning();
    const [key] = await db.insert(companySecrets).values({ companyId: f.companyId, key: "manager_private_key", name: "Manager anchor", scope: "instance", ownerPluginId: plugin!.id, ownerProjectId: anchor!.id }).returning();
    await db.insert(pluginConfig).values({ companyId: f.companyId, pluginId: plugin!.id, configJson: { managerAppId: "999", managerKeyAnchorProjectId: anchor!.id } });
    return { plugin: plugin!, anchor: anchor!, key: key! };
  }
  async function nonProject(f: F, appId = "123") {
    const saved = await f.seedConnection(null);
    const config = { ...saved.connection.config, methodConfig: { ...f.config().methodConfig, appId } };
    const [connection] = await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, saved.connection.id)).returning();
    return { connection: connection!, grant: saved.grant };
  }
  const release = (f: F, c: Awaited<ReturnType<typeof nonProject>>) => resolveGitHubAppCredential(db, c.connection, c.grant, false, false, f.leadA.id);

  it("no installed manager plugin is not an unavailable classification", async () => {
    const f = await fixture();
    expect(await readProjectAppManager(db, f.companyId)).toBeNull();
    const c = await nonProject(f);
    expect((await release(f, c)).token).toBe("scope-fixture-token");
  });
  it("an installed plugin with no company C4 config or W1 key does not gate another company's ordinary App", async () => {
    await manager(await fixture());
    const f = await fixture();
    expect(await readProjectAppManager(db, f.companyId)).toBeNull();
    const input = f.input(); input.projectId = null;
    const created = await f.service.createConnection(f.companyId, input, f.actor());
    expect(created.projectId).toBeNull();
    expect(provider.calls).toHaveLength(0); // ordinary draft creation is not project approval
    expect((await release(f, await nonProject(f))).token).toBe("scope-fixture-token");
  });
  it("a configured non-manager ordinary App releases without a project receipt", async () => {
    const f = await fixture(); await manager(f);
    expect((await release(f, await nonProject(f))).token).toBe("scope-fixture-token");
  });
  it.each(["empty-config", "malformed-id", "missing-config-with-key", "missing-key"])("configured but %s fails closed on a non-project release", async mode => {
    const f = await fixture(); const m = await manager(f);
    if (mode === "empty-config") await db.update(pluginConfig).set({ configJson: {} }).where(eq(pluginConfig.companyId, f.companyId));
    if (mode === "malformed-id") await db.update(pluginConfig).set({ configJson: { managerAppId: "oops", managerKeyAnchorProjectId: m.anchor.id } }).where(eq(pluginConfig.companyId, f.companyId));
    if (mode === "missing-config-with-key") await db.delete(pluginConfig).where(eq(pluginConfig.companyId, f.companyId));
    if (mode === "missing-key") await db.update(companySecrets).set({ status: "revoked" }).where(eq(companySecrets.id, m.key.id));
    await expect(release(f, await nonProject(f))).rejects.toMatchObject({ details: { code: "project_app_manager_classification_unavailable" } });
    expect(provider.calls).toHaveLength(0);
  });
  it.each(["numeric", "client-alias", "reference"])("configured manager %s is still forbidden on a non-project release", async mode => {
    const f = await fixture(); const m = await manager(f); provider.appId = 999;
    if (mode === "reference") {
      await expect(assertNotManagerApp(db, { companyId: f.companyId, refs: [{ secretId: m.key.id, configPath: "credentials.privateKey" }] }))
        .rejects.toMatchObject({ details: { code: "project_app_manager_forbidden" } });
    } else {
      await expect(release(f, await nonProject(f, mode === "numeric" ? "999" : "Iv1scopeclient")))
        .rejects.toMatchObject({ details: { code: "project_app_manager_forbidden" } });
    }
    if (mode !== "client-alias") expect(provider.calls).toHaveLength(0);
  });
  it("a manager configured during provider I/O is excluded by the post-I/O snapshot", async () => {
    const f = await fixture(); const c = await nonProject(f, "Iv1scopeclient");
    provider.appId = 999;
    provider.onApp = async () => { await manager(f); };
    await expect(release(f, c)).rejects.toMatchObject({ details: { code: "project_app_manager_forbidden" } });
    expect(provider.calls).toContain("/app");
  });
  it("configured manager Client-ID aliases cannot create ordinary connections", async () => {
    const f = await fixture(); await manager(f); provider.appId = 999;
    const input = f.input(); input.projectId = null;
    input.config = { ...input.config, methodConfig: { ...f.config().methodConfig, appId: "Iv1scopeclient" } };
    await expect(f.service.createConnection(f.companyId, input, f.actor())).rejects.toMatchObject({ details: { code: "project_app_manager_forbidden" } });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });
  it("absent C4 configuration still refuses project first binding, before provider/key acquisition", async () => {
    const f = await fixture();
    await expect(f.service.createConnection(f.companyId, f.input(), f.actor()))
      .rejects.toMatchObject({ details: { code: "project_app_manager_classification_unavailable" } });
    expect(provider.calls).toHaveLength(0);
    expect(await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.projectId, f.a.id)))).toHaveLength(0);
  });
});
