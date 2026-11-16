import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdir } from "node:fs/promises";
import express, { Router, type Request } from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  environments,
  heartbeatRuns,
  pluginCompanySettings,
  pluginConfig,
  pluginEntities,
  plugins,
  pluginState,
  projects,
  type Db,
} from "@paperclipai/db";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { secretSensitiveRouteFamily } from "../middleware/http-log-policy.js";
import { companyRoutes } from "../routes/companies.js";
import { pluginRoutes } from "../routes/plugins.js";
import { projectRoutes } from "../routes/projects.js";
import { secretRoutes } from "../routes/secrets.js";
import { resolveExecutionRunAdapterConfig } from "../services/heartbeat/run-preparation.js";
import { executeRunnerApi, type RunnerApiIo } from "../services/native-runtime/runner-api-client.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { projectInstanceSecretService } from "../services/project-instance-secrets.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Trust-boundary/data-safety integration coverage: real HTTP routes, PostgreSQL,
// encryption, native secret writer and readers. This is NOT an authentication
// token-verification test: fixture actors model actorMiddleware's output.
// Only set is a spy; every invocation delegates to its real transaction-bound
// service. The non-spy read guard makes a writer read-back fail the request.
const writer = vi.hoisted(() => ({
  sets: [] as Array<{ mock: { calls: unknown[][] } }>,
  inPut: false,
}));
vi.mock("../services/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/secrets.js")>();
  return {
    ...actual,
    secretService: (...args: Parameters<typeof actual.secretService>) => {
      const service = actual.secretService(...args);
      const native = service.projectInstance;
      const set = vi.fn(native.set.bind(native));
      writer.sets.push(set);
      return {
        ...service,
        projectInstance: {
          ...native,
          set,
          read: (...scope: Parameters<typeof native.read>) => {
            if (writer.inPut) throw new Error("Instance-secret writer must not read back a value");
            return native.read(...scope);
          },
        },
      };
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping W1 instance-secret route tests: ${support.reason ?? "embedded PostgreSQL unsupported"}`);
}

const KEY = "github_manager_key";
// board-mutation-guard.ts:43-66 trusts this default dev origin. Do not use a
// forwarded-host shortcut, and do not exempt session requests from the guard.
const TRUSTED_ORIGIN = "http://localhost:3100";
type Actor = Request["actor"];

function sentinel() {
  const body = randomBytes(32).toString("hex");
  return { body, value: `-----BEGIN SENTINEL KEY-----\n${body}\n-----END SENTINEL KEY-----` };
}

function setCalls() {
  return writer.sets.flatMap((spy) => spy.mock.calls);
}

function buildApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  const api = Router();
  // Same ordering as app.ts:710. A missing PUT route must not be hidden by a
  // test-only route or by bypassing the real browser mutation guard.
  api.use(boardMutationGuard());
  api.use(pluginRoutes(db, {} as never, { jobStore: pluginJobStore(db) } as never));
  api.use(secretRoutes(db));
  api.use(projectRoutes(db));
  api.use("/companies", companyRoutes(db));
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

describePostgres("W1 board-session-only project instance-secret write", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let f: Awaited<ReturnType<typeof fixture>>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-plugin-instance-secret-write-");
    db = createDb(database.connectionString);
  }, 90_000);

  beforeEach(async () => {
    writer.sets.length = 0;
    writer.inPut = false;
    f = await fixture();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    const otherPluginId = randomUUID();
    const projectId = randomUUID();
    const archivedId = randomUUID();
    const ordinaryId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const ownerId = `w1-owner-${randomUUID()}`;
    const memberId = `w1-member-${randomUUID()}`;
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: `W1 ${companyId}`, issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 7)}`.toUpperCase(),
    });
    await db.insert(authUsers).values([
      { id: ownerId, name: "W1 owner (Paul's authority shape)", email: `${ownerId}@example.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
      { id: memberId, name: "W1 member", email: `${memberId}@example.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, membershipRole: "owner", status: "active" },
      { companyId, principalType: "user", principalId: memberId, membershipRole: "member", status: "active" },
    ]);
    for (const id of [pluginId, otherPluginId]) {
      await db.insert(plugins).values({
        id, pluginKey: `w1.${id}`, packageName: `@fixture/w1-${id}`, version: "1.0.0", apiVersion: 1,
        categories: ["automation"], status: "ready",
        manifestJson: {
          id: `w1.${id}`, name: "W1 credential owner", apiVersion: 1, version: "1.0.0", entrypoints: {},
          capabilities: ["events.subscribe", "projects.instance-secrets"],
          resourceLifecycle: ["project"], instanceSecretKeys: [KEY],
        } as never,
      });
      await db.insert(pluginConfig).values({ pluginId: id, companyId, configJson: {} });
      await db.insert(pluginCompanySettings).values({ pluginId: id, companyId, enabled: true });
    }
    await db.insert(projects).values([
      { id: projectId, companyId, name: "W1 anchor", env: {} },
      { id: archivedId, companyId, name: "W1 archived anchor", archivedAt: new Date("2020-01-01") },
      { id: ordinaryId, companyId, name: "W1 ordinary project with no instance secret", env: {} },
    ]);
    await db.insert(agents).values({
      id: agentId, companyId, name: "W1 agent", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { env: {} }, permissions: {},
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: {} });
    await db.insert(environments).values({ id: environmentId, name: `W1 ${environmentId}`, driver: "fake", config: {}, envVars: {} });
    const board: Actor = {
      type: "board", source: "session", userId: ownerId, sessionId: randomUUID(), isInstanceAdmin: false,
      companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    };
    const agent: Actor = { type: "agent", source: "agent_jwt", companyId, agentId, runId, keyScope: { kind: "standard" } };
    return {
      companyId, pluginId, otherPluginId, projectId, archivedId, ordinaryId, agentId, runId, ownerId, memberId, environmentId,
      board, agent, a: sentinel(), b: sentinel(),
    };
  }

  function scope() {
    return { companyId: f.companyId, pluginId: f.pluginId, projectId: f.projectId };
  }

  function url(projectId: string = f.projectId, key: string = KEY, pluginId: string = f.pluginId, companyId: string = f.companyId) {
    return `/api/companies/${companyId}/plugins/${pluginId}/projects/${projectId}/instance-secrets/${key}`;
  }

  function noSentinel(value: unknown) {
    const serialized = JSON.stringify(value) ?? "";
    for (const secret of [f.a, f.b]) {
      expect(serialized).not.toContain(secret.value);
      expect(serialized).not.toContain(secret.body);
    }
  }

  // Snapshot ALL native rows, not only counts or the new fixture's rows. A
  // refusal must neither insert, rotate, delete nor modify an existing version.
  // This fixture's company only. lastResolvedAt is read bookkeeping that an earlier test's
  // fire-and-forget resolution can stamp later (W1HEAD 00:50Z); it is not a write, so it is excluded.
  async function secretSnapshot() {
    const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId)).orderBy(companySecrets.id);
    return {
      secrets: secrets.map(({ lastResolvedAt: _read, ...row }) => row),
      versions: secrets.length ? await db.select().from(companySecretVersions)
        .where(inArray(companySecretVersions.secretId, secrets.map(row => row.id))).orderBy(companySecretVersions.id) : [],
    };
  }

  async function put(actor = f.board, value: unknown = f.a.value, path = url(), origin = TRUSTED_ORIGIN) {
    writer.inPut = true;
    try {
      return await request(buildApp(db, actor)).put(path).set("Origin", origin).send({ value });
    } finally {
      writer.inPut = false;
    }
  }

  async function saved(value = f.a.value, actor = f.board) {
    const before = setCalls().length;
    const previousActivities = await savedActivities();
    const res = await put(actor, value);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(res.text).toBe("");
    expect(res.body).toEqual({});
    expect(res.headers["content-length"] === undefined || res.headers["content-length"] === "0").toBe(true);
    expect(setCalls().slice(before)).toEqual([[scope(), KEY, value]]);
    const activities = await savedActivities();
    const added = activities.filter((row) => !previousActivities.some((old) => old.id === row.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      companyId: f.companyId, actorType: "user", actorId: f.ownerId,
      action: "project.instance_secret.saved", entityType: "project", entityId: f.projectId,
    });
    // RFL no-echo: no value, fingerprint or hash in the activity row.
    expect(added[0].details).toEqual({ key: KEY });
    noSentinel(added);
    expect(JSON.stringify(added)).not.toContain(createHash("sha256").update(value).digest("hex"));
    return res;
  }

  async function savedActivities() {
    return db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, f.projectId),
      eq(activityLog.action, "project.instance_secret.saved"),
    )).orderBy(activityLog.id);
  }

  async function refused(actor: Actor, status: number, code: string, path = url(), value: unknown = f.a.value) {
    const before = await secretSnapshot();
    const calls = setCalls().length;
    const activityBefore = await savedActivities();
    const res = await put(actor, value, path);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    // The shared errorHandler shape: { error, code, details: { code } }; nothing else, no value.
    expect(res.body).toEqual({ error: expect.any(String), code, details: { code } });
    expect(res.body.error.length).toBeGreaterThan(0);
    noSentinel(res.body);
    expect(await secretSnapshot()).toEqual(before);
    expect(await savedActivities()).toEqual(activityBefore);
    expect(setCalls()).toHaveLength(calls);
    return res;
  }

  function deniedActors(): Array<{ name: string; actor: Actor; code: string }> {
    const boardOnly = "instance_secret_write_board_only";
    return [
      // auth.ts:309-322: board bearer keys keep their user's board authority,
      // but source is board_key, never session.
      { name: "board API key", actor: { ...f.board, source: "board_key", sessionId: undefined, keyId: randomUUID() }, code: boardOnly },
      // auth.ts:444-455: run-bound JWTs remain agents even for a board owner.
      { name: "agent JWT", actor: f.agent, code: boardOnly },
      { name: "ops user through an agent route", actor: {
        ...f.agent, onBehalfOfUserId: f.ownerId,
        onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }],
      }, code: boardOnly },
      // auth.ts:505-516: a harness bearer used as an agent is agent_key.
      { name: "harness agent key", actor: { ...f.agent, source: "agent_key", keyId: randomUUID(), onBehalfOfUserId: f.ownerId }, code: boardOnly },
      // There is NO Express plugin actor on c4e28522 (types/express.d.ts:9).
      // Workers use JSON-RPC over stdio (plugin-worker-manager.ts:7-12), not
      // HTTP authentication. A worker's uncredentialed HTTP request is none
      // (auth.ts:217); actorType:plugin exists only in secret access auditing
      // (secrets.ts:3598), not actorMiddleware. Do not invent a plugin JWT.
      { name: "plugin worker without a board session (IPC has no HTTP actor)", actor: { type: "none", source: "none" }, code: boardOnly },
      { name: "non-admin board session", actor: {
        ...f.board, userId: f.memberId,
        memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }],
      }, code: "instance_secret_write_admin_required" },
    ];
  }

  it.each(["owner", "admin", "instance admin"] as const)("W1 (a) saves once from an %s board session, replies with no echo, and the owning plugin reads exactly the sentinel", async (role) => {
    let actor = f.board;
    if (role === "admin") {
      await db.update(companyMemberships).set({ membershipRole: "admin" }).where(and(
        eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.ownerId),
      ));
      actor = { ...actor, memberships: [{ companyId: f.companyId, membershipRole: "admin", status: "active" }] };
    }
    if (role === "instance admin") actor = { ...actor, isInstanceAdmin: true, companyIds: [], memberships: [] };
    await saved(f.a.value, actor);
    expect(await secretService(db).projectInstance.read(scope())).toEqual({ [KEY]: f.a.value });
    const [row] = await db.select().from(companySecrets).where(eq(companySecrets.ownerProjectId, f.projectId));
    expect(row).toMatchObject({ companyId: f.companyId, scope: "instance", ownerPluginId: f.pluginId, ownerAgentId: null, latestVersion: 1, provider: "local_encrypted" });
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, row.id));
    expect(versions).toHaveLength(1);
    noSentinel(versions);
    // Native tables already exist; W1 must not add a migration. This is a
    // filesystem check, not a shell/git dependency in the test runner.
    const migrations = await readdir(new URL("../../../packages/db/src/migrations/", import.meta.url));
    expect(migrations.filter((name) => name.toLowerCase().includes("instance_secret_write"))).toEqual([]);
  });

  it.each([
    "board API key", "agent JWT", "ops user through an agent route", "harness agent key",
    "plugin worker without a board session (IPC has no HTTP actor)", "non-admin board session",
  ])("W1 (b) refuses %s with an exact code and no native row change", async (name) => {
    const denied = deniedActors().find((entry) => entry.name === name)!;
    // Empty store first: catches an unauthorized create even before (a).
    await refused(denied.actor, 403, denied.code);
    // Seed through the route, never the native writer, then repeat to catch
    // unauthorized rotation or deletion of an existing secret.
    await saved();
    await refused(denied.actor, 403, denied.code, url(), f.b.value);
  });

  it("W1 (k) refuses Paul's owner-authority board_key harness identity, with no row change", async () => {
    const paulHarness: Actor = { ...f.board, source: "board_key", sessionId: undefined, keyId: randomUUID() };
    // Actor fixture only: no real org-test-harness-paul token or user record is
    // loaded. The userId is the fixture's real owner membership principal.
    await refused(paulHarness, 403, "instance_secret_write_board_only");
    await saved();
    await refused(paulHarness, 403, "instance_secret_write_board_only", url(), f.b.value);
  });

  it("W1 (l) applies the real trusted-browser-origin guard to a valid session without changing rows", async () => {
    // This prerequisite also makes (l) RED on the route-less base, rather than
    // accidentally passing on the pre-existing guard's 403 alone.
    await saved();
    const before = await secretSnapshot();
    const activities = await savedActivities();
    const calls = setCalls().length;
    const res = await put(f.board, f.b.value, url(), "https://untrusted-w1.example.invalid");
    // put sets Origin only; it never supplies a fallback trusted Referer.
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board mutation requires trusted browser origin" });
    noSentinel(res.body);
    expect(await secretSnapshot()).toEqual(before);
    expect(await savedActivities()).toEqual(activities);
    expect(setCalls()).toHaveLength(calls);
  });

  it("W1 (c) leaves no sentinel plaintext in any public table, plugin state/config/entity, activity, or refused response", async () => {
    await saved();
    expect(await secretService(db).projectInstance.read(scope())).toEqual({ [KEY]: f.a.value });
    for (const denied of deniedActors()) await refused(denied.actor, 403, denied.code);
    await refused(f.board, 409, "instance_secret_project_archived", url(f.archivedId));
    await refused(f.board, 404, "instance_secret_project_missing", url(randomUUID()));
    await refused(f.board, 422, "instance_secret_key_undeclared", url(f.projectId, "undeclared_key"));
    await refused(f.board, 422, "instance_secret_value_invalid", url(), { nested: f.a.value });
    await db.update(pluginCompanySettings).set({ enabled: false }).where(and(
      eq(pluginCompanySettings.pluginId, f.pluginId), eq(pluginCompanySettings.companyId, f.companyId),
    ));
    await refused(f.board, 409, "instance_secret_plugin_unavailable");

    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name
    `);
    expect(tables.length).toBeGreaterThan(0);
    for (const { table_name: table } of tables) {
      const [row] = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM ${sql.identifier("public")}.${sql.identifier(table)} t
        WHERE t::text LIKE ${`%${f.a.body}%`} OR t::text LIKE ${`%${f.b.body}%`}
      `);
      expect(row.count, `plaintext sentinel in public.${table}`).toBe(0);
    }
    // Explicit surfaces as well as the exhaustive scan above.
    noSentinel(await db.select().from(activityLog));
    noSentinel(await db.select().from(pluginConfig));
    noSentinel(await db.select().from(pluginState));
    noSentinel(await db.select().from(pluginEntities));
  });

  async function boardReadSurfaces() {
    const app = buildApp(db, f.board);
    const config = await request(app).get(`/api/plugins/${f.pluginId}/config`).query({ companyId: f.companyId });
    expect(config.status).toBe(200);
    expect(config.body.configJson).toEqual({});
    noSentinel(config.body);
    // plugins.ts:1634-1640 requires bridgeDeps/workerManager for settings data.
    // No live worker is launched here: assert the REAL route refuses with 501,
    // rather than mocking a worker handler that could conceal a value leak.
    const settings = await request(app).post(`/api/plugins/${f.pluginId}/data/settings`)
      .set("Origin", TRUSTED_ORIGIN).send({ companyId: f.companyId });
    expect(settings.status).toBe(501);
    expect(settings.body).toEqual({ error: "Plugin bridge is not enabled" });
    noSentinel(settings.body);
    const catalog = await request(app).get(`/api/companies/${f.companyId}/secrets/catalog`);
    const list = await request(app).get(`/api/companies/${f.companyId}/secrets`);
    expect(catalog.status).toBe(200);
    expect(list.status).toBe(200);
    noSentinel(catalog.body);
    noSentinel(list.body);
    // Both company export aliases exist on this base (companies.ts:531,1136).
    for (const suffix of ["export", "exports"]) {
      const exported = await request(app).post(`/api/companies/${f.companyId}/${suffix}`)
        .set("Origin", TRUSTED_ORIGIN).send({});
      expect(exported.status, JSON.stringify(exported.body)).toBe(200);
      noSentinel(exported.body);
    }
    const fidelity = await request(app).get(`/api/companies/${f.companyId}/export/fidelity`);
    expect(fidelity.status).toBe(200);
    noSentinel(fidelity.body);
  }

  it("W1 (d) exposes no value through config, refused settings data, secret catalog/list or company exports", async () => {
    await saved();
    await boardReadSurfaces();
  });

  it("W1 (e) rotates with one set per PUT and no writer read-back; latest reads give only B and routes give neither value", async () => {
    await saved();
    const [original] = await db.select().from(companySecrets).where(eq(companySecrets.ownerProjectId, f.projectId));
    // No read() is performed by this test between the two writes. All request
    // read-backs are actively forbidden by the non-spy wrapper above.
    await saved(f.b.value);
    const latest = await secretService(db).projectInstance.read(scope());
    expect(latest).toEqual({ [KEY]: f.b.value });
    expect(JSON.stringify(latest)).not.toContain(f.a.body);
    expect(await projectInstanceSecretService(db, f.pluginId).read(f.companyId, f.projectId)).toEqual({ [KEY]: f.b.value });
    const [rotated] = await db.select().from(companySecrets).where(eq(companySecrets.id, original.id));
    expect(rotated.latestVersion).toBe(2);
    const versions = await db.select().from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, original.id)).orderBy(companySecretVersions.version);
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    noSentinel(versions);
    // Historical ciphertext remains for native versioning; ordinary resolvers
    // must not make A (or B) readable as a bindable company secret.
    await expect(secretService(db).resolveSecretValue(f.companyId, original.id, 1)).rejects.toThrow();
    await expect(secretService(db).resolveSecretValue(f.companyId, original.id, "latest")).rejects.toThrow();
    await boardReadSurfaces();
    const agentApp = buildApp(db, f.agent);
    const agentList = await request(agentApp).get("/api/agents/me/secrets");
    const agentValue = await request(agentApp).post(`/api/agents/me/secrets/${KEY}/value`).send({});
    expect(agentList.status).toBe(200);
    expect(agentValue.status).toBe(403);
    noSentinel(agentList.body);
    noSentinel(agentValue.body);
    expect(setCalls()).toEqual([[scope(), KEY, f.a.value], [scope(), KEY, f.b.value]]);
  });

  it.each(["archived", "missing"] as const)("W1 (f) refuses an %s project with no row change", async (state) => {
    await saved();
    await refused(f.board, state === "archived" ? 409 : 404,
      state === "archived" ? "instance_secret_project_archived" : "instance_secret_project_missing",
      url(state === "archived" ? f.archivedId : randomUUID()));
  });

  // review-fleet-2 01:11Z: a REAL project of another company in the path, by a board session
  // that is admin of company A only. Company A's path cannot reach it (the project lookup is
  // scoped to the path's company), and company B's path refuses A's admin before any lookup.
  it("W1 (f) refuses a cross-company project id: another company's project in company A's path, with no row in either company", async () => {
    await saved();
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId, name: `W1 other ${otherCompanyId}`, issuePrefix: `X${otherCompanyId.replace(/-/g, "").slice(0, 7)}`.toUpperCase(),
    });
    await db.insert(projects).values({ id: otherProjectId, companyId: otherCompanyId, name: "W1 another company's project", env: {} });
    const otherBefore = await db.select().from(companySecrets).where(eq(companySecrets.companyId, otherCompanyId));
    await refused(f.board, 404, "instance_secret_project_missing", url(otherProjectId));
    await refused(f.board, 403, "instance_secret_write_admin_required", url(otherProjectId, KEY, f.pluginId, otherCompanyId));
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, otherCompanyId))).toEqual(otherBefore);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.ownerProjectId, otherProjectId))).toEqual([]);
  });

  it("W1 (g) refuses keys absent from the manifest allow-list without changing rows", async () => {
    await refused(f.board, 422, "instance_secret_key_undeclared", url(f.projectId, "undeclared_key"));
    await saved();
    await refused(f.board, 422, "instance_secret_key_undeclared", url(f.projectId, "undeclared_key"));
  });

  it("W1 (h) isolates the value from another installed, configured, capable plugin", async () => {
    await saved();
    expect(await secretService(db).projectInstance.read({ ...scope(), pluginId: f.otherPluginId })).toEqual({});
    expect(await projectInstanceSecretService(db, f.otherPluginId).read(f.companyId, f.projectId)).toEqual({});
    expect(await secretService(db).projectInstance.read(scope())).toEqual({ [KEY]: f.a.value });
  });

  it.each(["environment", "agent"] as const)("W1 (i) refuses an instance secret as an %s binding and writes no binding row", async (targetType) => {
    await saved();
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.ownerProjectId, f.projectId));
    const before = await db.select().from(companySecretBindings).orderBy(companySecretBindings.id);
    const nativeBefore = await secretSnapshot();
    // env-scope guard from ad/envscope-fix 8c2ee81f, stacked below W1
    await expect(secretService(db).replaceSecretRefsForInstanceTarget(
      { targetType, targetId: targetType === "environment" ? f.environmentId : f.agentId },
      [{ secretId: secret.id, configPath: "credential", versionSelector: "latest" }],
    )).rejects.toMatchObject({ status: 422, message: "Secret references require company-scoped secrets" });
    expect(await db.select().from(companySecretBindings).orderBy(companySecretBindings.id)).toEqual(before);
    expect(await secretSnapshot()).toEqual(nativeBefore);
  });

  it.each(["archive", "delete"] as const)("W1 (j) refuses an agent's %s of the anchor and preserves the project and instance secret", async (operation) => {
    await saved();
    const app = buildApp(db, f.agent);
    const before = await db.select().from(projects).where(eq(projects.id, f.projectId));
    const nativeBefore = await secretSnapshot();
    // Positive control: refuse the private-credential anchor, not every agent
    // project edit. The SAME agent can still archive an ordinary project.
    expect(await db.select().from(companySecrets).where(eq(companySecrets.ownerProjectId, f.ordinaryId))).toEqual([]);
    const ordinary = await request(app).patch(`/api/projects/${f.ordinaryId}`)
      .send({ archivedAt: new Date().toISOString() });
    expect(ordinary.status).toBeGreaterThanOrEqual(200);
    expect(ordinary.status).toBeLessThan(300);
    const [ordinaryRow] = await db.select().from(projects).where(eq(projects.id, f.ordinaryId));
    expect(ordinaryRow.archivedAt).toBeInstanceOf(Date);
    // Each case gets a fresh anchor, so a broken archive cannot mask a broken
    // delete. This stays RED until the decided integrity guard is installed.
    const res = operation === "archive"
      ? await request(app).patch(`/api/projects/${f.projectId}`).send({ archivedAt: new Date().toISOString() })
      : await request(app).delete(`/api/projects/${f.projectId}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      code: "project_anchors_instance_secret",
      error: "This project holds a plugin's private credential and can't be archived or deleted by an agent.",
      details: { code: "project_anchors_instance_secret" },
    });
    noSentinel(res.body);
    expect(await db.select().from(projects).where(eq(projects.id, f.projectId))).toEqual(before);
    expect(await secretSnapshot()).toEqual(nativeBefore);
    expect(await secretService(db).projectInstance.read(scope())).toEqual({ [KEY]: f.a.value });
  });

  it.each(["missing", "not ready", "disabled", "no capability"] as const)("W1 plugin eligibility refuses %s before key/project/value validation", async (state) => {
    let pluginId = f.pluginId;
    if (state === "missing") pluginId = randomUUID();
    if (state === "not ready") await db.update(plugins).set({ status: "error" }).where(eq(plugins.id, pluginId));
    if (state === "disabled") await db.update(pluginCompanySettings).set({ enabled: false }).where(and(
      eq(pluginCompanySettings.pluginId, pluginId), eq(pluginCompanySettings.companyId, f.companyId),
    ));
    if (state === "no capability") {
      const [plugin] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
      await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, capabilities: ["events.subscribe"] } }).where(eq(plugins.id, pluginId));
    }
    await refused(f.board, 409, "instance_secret_plugin_unavailable", url(randomUUID(), "undeclared_key", pluginId), null);
  });

  it.each([null, 7, {}, "", "   ", "x".repeat(131_073)])("W1 value validation refuses invalid input %# without invoking set", async (value) => {
    await refused(f.board, 422, "instance_secret_value_invalid", url(), value);
  });

  it.each(["inactive membership", "owner absent from companyIds", "owner of another company"] as const)("W1 admin authority refuses %s", async (state) => {
    let actor = f.board;
    if (state === "inactive membership") actor = { ...actor, memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "inactive" }] };
    if (state === "owner absent from companyIds") actor = { ...actor, companyIds: [] };
    if (state === "owner of another company") actor = { ...actor, memberships: [{ companyId: randomUUID(), membershipRole: "owner", status: "active" }] };
    await refused(actor, 403, "instance_secret_write_admin_required");
  });

  it("W1 validation order rejects non-session/admin actors before looking up any scope and key before project/value", async () => {
    // Invalid UUIDs would provoke a DB cast failure if a lookup ran first.
    const invalidScope = url("not-a-project", "undeclared_key", "not-a-plugin", "not-a-company");
    await refused({ ...f.board, source: "board_key" }, 403, "instance_secret_write_board_only", invalidScope, null);
    await refused({ ...f.board, memberships: [], companyIds: [] }, 403, "instance_secret_write_admin_required", invalidScope, null);
    await refused(f.board, 422, "instance_secret_key_undeclared", url(randomUUID(), "undeclared_key"), null);
    await refused(f.board, 404, "instance_secret_project_missing", url(randomUUID()), null);
    await refused(f.board, 409, "instance_secret_project_archived", url(f.archivedId), null);
  });

  it("W1 R14 agent JWT reads, call_api secret tools, heartbeat env projection, config, activity and HTTP-log policy never expose the value", async () => {
    await saved();
    const app = buildApp(db, f.agent);
    const listed = await request(app).get("/api/agents/me/secrets");
    expect(listed.status).toBe(200);
    expect(listed.body.secrets).toEqual([]);
    noSentinel(listed.body);
    const value = await request(app).post(`/api/agents/me/secrets/${KEY}/value`).send({});
    expect(value.status).toBe(403);
    expect(value.body.error).toBe("Secret access is not granted for this agent");
    noSentinel(value.body);
    const config = await request(app).get(`/api/plugins/${f.pluginId}/config`).query({ companyId: f.companyId });
    expect(config.status).toBe(403);
    noSentinel(config.body);

    // A tool path DOES exist: native runner call_api -> executeRunnerApi ->
    // POST /agents/me/secrets/{key}/value (runner-api-reference.ts:792).
    // Exercise its real HTTP client against these same real mounted routes.
    // No separate secrets-value MCP tool was found in public-mcp/capabilities.ts,
    // public-mcp/expanded-capabilities.ts or tool-gateway.ts; connection OAuth
    // credential plumbing there is not an arbitrary company-secret read tool.
    const server = app.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("W1 HTTP listener has no TCP address");
      const io: RunnerApiIo = {
        apiUrl: `http://127.0.0.1:${address.port}`, token: "w1-fixture-agent-token-not-a-real-credential",
        readFile: async () => { throw new Error("Secret read tool must not upload a file"); },
        saveResponse: async () => { throw new Error("Secret read tool must not persist a response asset"); },
      };
      const context = { companyId: f.companyId, issueId: randomUUID(), runId: f.runId, workMode: "standard" };
      const toolList = await executeRunnerApi({ operationId: "GET /api/agents/me/secrets" }, context, io);
      expect(toolList).toMatchObject({ ok: true, status: 200, data: { secrets: [] } });
      noSentinel(toolList);
      const toolValue = await executeRunnerApi({ operationId: "POST /api/agents/me/secrets/{key}/value", pathParams: { key: KEY }, body: {} }, context, io);
      expect(toolValue).toMatchObject({ ok: false, status: 403 });
      noSentinel(toolValue);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    // This is the actual heartbeat projection function, not a reconstructed env
    // helper. Neither the agent nor its project has any binding to the key.
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [project] = await db.select().from(projects).where(eq(projects.id, f.projectId));
    const projection = await resolveExecutionRunAdapterConfig({
      companyId: f.companyId, agentId: f.agentId, heartbeatRunId: f.runId,
      adapterType: agent.adapterType, agentAdapterConfig: agent.adapterConfig,
      projectId: f.projectId, executionRunConfig: agent.adapterConfig, projectEnv: project.env,
      secretsSvc: secretService(db),
    });
    noSentinel(projection);
    expect(projection.secretManifest).toEqual([]);
    expect(projection.secretKeys.has(KEY)).toBe(false);
    noSentinel(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)));
    // Logger streams are process-global; use the explicitly permitted policy
    // assertion rather than intercepting unrelated workers' pino output.
    expect(secretSensitiveRouteFamily("PUT", url())).toBe("plugin_instance_secret_write");
  });
});
