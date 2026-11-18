import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";
import { Writable } from "node:stream";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import express, { Router, type Request } from "express";
import request from "supertest";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  agents,
  heartbeatRuns,
  createDb,
  pluginCompanySettings,
  pluginConfig,
  plugins,
  projects,
  type Db,
} from "@paperclipai/db";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createHttpLogger } from "../middleware/logger.js";
import { companyRoutes } from "../routes/companies.js";
import { pluginRoutes } from "../routes/plugins.js";
import { projectRoutes } from "../routes/projects.js";
import { secretRoutes } from "../routes/secrets.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { createRow12Plugin } from "../../../packages/plugins/plugin-row12-installer/src/plugin.js";
import manifest from "../../../packages/plugins/plugin-row12-installer/src/manifest.js";

const PRIMARY_SMARTY = "29b216c4-76bc-41a3-a71a-88d30737b688";
const TRUSTED_ORIGIN = "http://localhost:3100";
const INSTALL_TOKEN = "ghs_test_install_token_only";
const APP_ID = "810";
const MANAGER_INSTALLATION_ID = "444";
const REPOSITORY_ID = 1001;
const ALLOWED_ORG = "Smarty-Pants-Inc";
type Actor = Request["actor"];
type Sentinel = ReturnType<typeof makeSentinel>;
type FakeCall = { method: string; path: string; body: unknown; authorization: string | undefined };

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping row-12 instance-secret integration tests: ${support.reason ?? "embedded PostgreSQL unsupported"}`);

function makeSentinel() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey,
    fingerprint: createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("hex"),
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function leakForms(pem: string): string[] {
  const base64Body = pem.split(/\r?\n/).slice(1, -1).join("").replace(/\s/g, "");
  return [...new Set([
    pem,
    JSON.stringify(pem).slice(1, -1),
    Buffer.from(pem).toString("base64"),
    base64Body,
    ...(base64Body.match(/.{1,64}/g) ?? []),
  ])];
}

function expectNoSentinels(value: unknown, sentinels: string[]) {
  const serialized = JSON.stringify(value) ?? "";
  const forms = sentinels.flatMap(leakForms);
  expect(forms.map((form) => serialized.includes(form))).toEqual(forms.map(() => false));
}

async function startFakeGitHub(sentinels: Sentinel[]) {
  const calls: FakeCall[] = [];
  const verifiedKeyIndexes: number[] = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      const authorization = request.headers.authorization;
      calls.push({ method, path, body, authorization });
      if (method === "POST" && path === `/app/installations/${MANAGER_INSTALLATION_ID}/access_tokens`) {
        const jwt = authorization?.replace(/^Bearer /, "") ?? "";
        const [header, payload, signature] = jwt.split(".");
        let matched = -1;
        if (header && payload && signature) {
          for (let index = 0; index < sentinels.length; index++) {
            if (verifySignature("RSA-SHA256", Buffer.from(`${header}.${payload}`), sentinels[index]!.publicKey, Buffer.from(signature, "base64url"))) matched = index;
          }
        }
        verifiedKeyIndexes.push(matched);
        return send(response, matched >= 0 ? 201 : 401, matched >= 0
          ? { token: INSTALL_TOKEN, expires_at: "2099-01-01T00:00:00Z" }
          : { message: "JWT did not verify against the test sentinel key" });
      }
      if (method === "GET" && path.split("?")[0] === "/enterprises/acme/apps/installable_organizations") {
        return send(response, 200, [{ login: ALLOWED_ORG }]);
      }
      if (method === "GET" && path === `/repos/${ALLOWED_ORG}/smarty-poc-work`) {
        return send(response, 200, { id: REPOSITORY_ID, name: "smarty-poc-work" });
      }
      if (method === "POST" && path === `/enterprises/acme/apps/organizations/${ALLOWED_ORG}/installations`) {
        return send(response, 201, { id: 700, app_id: Number(APP_ID) });
      }
      return send(response, 404, { message: "not found" });
    } catch {
      return send(response, 500, { message: "fake GitHub request parse failure" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake GitHub failed to bind to loopback");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    verifiedKeyIndexes,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const baseConfig = {
  enterpriseSlug: "acme",
  allowedOrg: ALLOWED_ORG,
  managerAppId: "1234",
  managerInstallationId: MANAGER_INSTALLATION_ID,
  managerKeyAnchorProjectId: "",
  allowedCallerAgentIds: [PRIMARY_SMARTY],
  deniedRepos: [],
  registeredApps: [{ slug: "product-one", appId: APP_ID, clientId: "Iv1.product-one", approvedRepositoryIds: [REPOSITORY_ID] }],
};

function buildApp(db: Db, actor: Actor, httpLog?: ReturnType<typeof createHttpLogger>) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use((req, _res, next) => { req.actor = actor; next(); });
  if (httpLog) app.use(httpLog);
  const api = Router();
  api.use(boardMutationGuard());
  api.use(pluginRoutes(db, {} as never, { jobStore: pluginJobStore(db) } as never));
  api.use(secretRoutes(db));
  api.use(projectRoutes(db));
  api.use("/companies", companyRoutes(db));
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

function boardActor(companyId: string, userId: string): Actor {
  return {
    type: "board", source: "session", userId, sessionId: randomUUID(), isInstanceAdmin: false,
    companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  };
}

async function installPut(app: express.Express, companyId: string, pluginId: string, projectId: string, value: string) {
  return request(app)
    .put(`/api/companies/${companyId}/plugins/${pluginId}/projects/${projectId}/instance-secrets/manager_private_key`)
    .set("Origin", TRUSTED_ORIGIN)
    .send({ value });
}

describePostgres("row-12 installer reads a board-written project instance secret through the local Paperclip host", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const cleanup: Array<() => void | Promise<void>> = [];

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-row12-real-secret-read-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    vi.unstubAllEnvs();
  });

  it("writes, reads, signs, refuses unauthorized writes, isolates plugins, rotates, and fails closed for an archived anchor", async () => {
    const sentinelA = makeSentinel();
    const sentinelB = makeSentinel();
    const fake = await startFakeGitHub([sentinelA, sentinelB]);
    cleanup.push(fake.close);
    const companyId = randomUUID();
    const pluginId = randomUUID();
    const otherPluginId = randomUUID();
    const anchorProjectId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const ownerId = `row12-owner-${randomUUID()}`;
    const companyKey = `R${randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase()}`;
    const now = new Date();
    const config = { ...baseConfig, managerKeyAnchorProjectId: anchorProjectId };
    const otherManifest = { ...manifest, id: "paperclipai.plugin-row12-read-probe" };
    const pluginKey = "paperclipai.plugin-row12-installer";

    await db.insert(companies).values({ id: companyId, name: `Row-12 integration ${companyId}`, issuePrefix: companyKey });
    await db.insert(authUsers).values({ id: ownerId, name: "Row-12 fixture owner", email: `${ownerId}@example.invalid`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerId, membershipRole: "owner", status: "active" });
    for (const [id, key, pkgManifest] of [
      [pluginId, pluginKey, manifest],
      [otherPluginId, "paperclipai.plugin-row12-read-probe", otherManifest],
    ] as const) {
      await db.insert(plugins).values({
        id, pluginKey: key, packageName: `@fixture/${key}`, version: "0.1.0", apiVersion: 1,
        categories: ["connector", "automation"], status: "ready", manifestJson: pkgManifest as never,
      });
      await db.insert(pluginConfig).values({ pluginId: id, companyId, configJson: id === pluginId ? config : {} });
      await db.insert(pluginCompanySettings).values({ pluginId: id, companyId, enabled: true });
    }
    await db.insert(projects).values({ id: anchorProjectId, companyId, name: "github-manager-key", env: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Row-12 agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: { env: {} }, permissions: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: {} });

    const board = boardActor(companyId, ownerId);
    const boardApiKey: Actor = { ...board, source: "board_key", sessionId: undefined, keyId: randomUUID() };
    const agent: Actor = { type: "agent", source: "agent_jwt", companyId, agentId, runId, keyScope: { kind: "standard" } };
    const routeApp = buildApp(db, board);
    const writeA = await installPut(routeApp, companyId, pluginId, anchorProjectId, sentinelA.privatePem);
    // RED on the W1 base until the installer manifest declares manager_private_key.
    expect(writeA.status, JSON.stringify(writeA.body)).toBe(204);
    expect(writeA.text).toBe("");
    expect(writeA.body).toEqual({});

    const installerServices = buildHostServices(db, pluginId, pluginKey, createPluginEventBus(), undefined, { manifest });
    cleanup.push(() => installerServices.dispose());
    const installerHandlers = createHostClientHandlers({ pluginId, capabilities: manifest.capabilities, services: installerServices });
    const invocation = { invocationScope: { companyId } };
    const harness = createTestHarness({ manifest });
    const ctx = harness.ctx as PluginContext;
    ctx.config.get = async (requestedCompanyId) => {
      if (requestedCompanyId !== companyId) throw new Error("unexpected test company");
      const [row] = await db.select().from(pluginConfig).where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)));
      return row?.configJson ?? null;
    };
    ctx.projects.get = async (projectId, requestedCompanyId) => installerHandlers["projects.get"]({ projectId, companyId: requestedCompanyId }, invocation);
    ctx.issues.list = async (params) => installerHandlers["issues.list"](params, invocation);
    ctx.projects.getInstanceSecrets = async (projectId, requestedCompanyId) => installerHandlers["projects.getInstanceSecrets"]({ projectId, companyId: requestedCompanyId }, invocation);
    ctx.activity.log = async (params) => installerHandlers["activity.log"](params, invocation);
    ctx.state.get = async (params) => installerHandlers["state.get"](params, invocation);
    ctx.state.set = async (params, value) => installerHandlers["state.set"]({ ...params, value }, invocation);
    const secretRead = vi.spyOn(installerServices.projects, "getInstanceSecrets");
    await createRow12Plugin({ apiBaseUrl: fake.url }).definition.setup(ctx);
    const run: ToolRunContext = { agentId: PRIMARY_SMARTY, runId: randomUUID(), companyId, projectId: anchorProjectId };
    const invokeInstall = () => harness.executeTool("github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] }, run);

    const otherServices = buildHostServices(db, otherPluginId, "paperclipai.plugin-row12-read-probe", createPluginEventBus(), undefined, { manifest: otherManifest });
    cleanup.push(() => otherServices.dispose());
    const otherHandlers = createHostClientHandlers({ pluginId: otherPluginId, capabilities: otherManifest.capabilities, services: otherServices });
    expect(await otherHandlers["projects.getInstanceSecrets"]({ companyId, projectId: anchorProjectId }, invocation)).toEqual({});

    const deniedBoardWrite = await installPut(buildApp(db, boardApiKey), companyId, pluginId, anchorProjectId, sentinelB.privatePem);
    expect(deniedBoardWrite.status).toBe(403);
    expect(deniedBoardWrite.body.code).toBe("instance_secret_write_board_only");
    const deniedAgentWrite = await installPut(buildApp(db, agent), companyId, pluginId, anchorProjectId, sentinelB.privatePem);
    expect(deniedAgentWrite.status).toBe(403);
    expect(deniedAgentWrite.body.code).toBe("instance_secret_write_board_only");
    const preRotationRead = await ctx.projects.getInstanceSecrets(anchorProjectId, companyId);
    expect(preRotationRead.manager_private_key === sentinelA.privatePem).toBe(true);

    const installedA = await invokeInstall();
    expect(installedA.data, JSON.stringify({ result: installedA, calls: fake.calls.map(({ method, path }) => [method, path]), verified: fake.verifiedKeyIndexes })).toMatchObject({ installationId: 700, slug: "product-one", repositories: ["smarty-poc-work"], repositoryIds: [String(REPOSITORY_ID)], httpStatus: 201 });
    expect(fake.verifiedKeyIndexes).toEqual([0]);
    expect(secretRead).toHaveBeenCalledWith({ companyId, projectId: anchorProjectId });
    const installRequests = fake.calls.filter((call) => call.method === "POST" && call.path === `/enterprises/acme/apps/organizations/${ALLOWED_ORG}/installations`);
    expect(installRequests).toHaveLength(1);
    expect(installRequests[0]?.body).toEqual({ client_id: "Iv1.product-one", repository_selection: "selected", repositories: ["smarty-poc-work"] });

    const [secretRow] = await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, companyId), eq(companySecrets.ownerProjectId, anchorProjectId), eq(companySecrets.ownerPluginId, pluginId),
    ));
    expect(secretRow).toMatchObject({ scope: "instance", key: "manager_private_key", latestVersion: 1, provider: "local_encrypted" });
    const versionsA = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretRow.id));
    expect(versionsA).toHaveLength(1);
    expectNoSentinels(versionsA, [sentinelA.privatePem]);

    const logLines: string[] = [];
    const sink = new Writable({ write(chunk, _encoding, callback) { logLines.push(chunk.toString()); callback(); } });
    const captureLogger = pino({ level: "debug" }, sink);
    const httpLogger = createHttpLogger(captureLogger);
    const missingProject = await installPut(buildApp(db, board, httpLogger), companyId, pluginId, randomUUID(), sentinelA.privatePem);
    expect(missingProject.status).toBe(404);
    captureLogger.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logLines.length).toBeGreaterThan(0);
    expectNoSentinels(logLines, [sentinelA.privatePem, sentinelB.privatePem]);

    const oldRead = await ctx.projects.getInstanceSecrets(anchorProjectId, companyId);
    expect(oldRead.manager_private_key === sentinelA.privatePem).toBe(true);
    const writeB = await installPut(routeApp, companyId, pluginId, anchorProjectId, sentinelB.privatePem);
    expect(writeB.status).toBe(204);
    const rotatedRead = await ctx.projects.getInstanceSecrets(anchorProjectId, companyId);
    expect(rotatedRead.manager_private_key === sentinelB.privatePem).toBe(true);
    expect(rotatedRead.manager_private_key === sentinelA.privatePem).toBe(false);
    const installedB = await invokeInstall();
    expect(installedB.data).toMatchObject({ httpStatus: 201, repositories: ["smarty-poc-work"] });
    expect(fake.verifiedKeyIndexes).toEqual([0, 1]);
    const rotated = await db.select().from(companySecrets).where(eq(companySecrets.id, secretRow.id));
    expect(rotated[0]?.latestVersion).toBe(2);
    const rotatedVersions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretRow.id)).orderBy(companySecretVersions.version);
    expect(rotatedVersions.map((version) => version.version)).toEqual([1, 2]);
    expectNoSentinels(rotatedVersions, [sentinelA.privatePem, sentinelB.privatePem]);

    const instanceSecretUrl = `/api/companies/${companyId}/plugins/${pluginId}/projects/${anchorProjectId}/instance-secrets/manager_private_key`;
    const noReadBack = await request(routeApp).get(instanceSecretUrl);
    expect(noReadBack.status).toBe(404);
    expectNoSentinels(noReadBack.body, [sentinelA.privatePem, sentinelB.privatePem]);
    const boardConfig = await request(routeApp).get(`/api/plugins/${pluginId}/config`).query({ companyId });
    expect(boardConfig.status).toBe(200);
    expectNoSentinels(boardConfig.body, [sentinelA.privatePem, sentinelB.privatePem]);
    const boardCatalog = await request(routeApp).get(`/api/companies/${companyId}/secrets/catalog`);
    const boardSecretList = await request(routeApp).get(`/api/companies/${companyId}/secrets`);
    expect(boardCatalog.status).toBe(200);
    expect(boardSecretList.status).toBe(200);
    const settingsData = await request(routeApp).post(`/api/plugins/${pluginId}/data/settings`).set("Origin", TRUSTED_ORIGIN).send({ companyId });
    expect(settingsData.status).toBe(501);
    expectNoSentinels(settingsData.body, [sentinelA.privatePem, sentinelB.privatePem]);
    for (const suffix of ["export", "exports"]) {
      const exported = await request(routeApp).post(`/api/companies/${companyId}/${suffix}`).set("Origin", TRUSTED_ORIGIN).send({});
      expect(exported.status).toBe(200);
      expectNoSentinels(exported.body, [sentinelA.privatePem, sentinelB.privatePem]);
    }
    for (const output of [boardCatalog.body, boardSecretList.body]) {
      expectNoSentinels(output, [sentinelA.privatePem, sentinelB.privatePem]);
    }
    const agentApp = buildApp(db, agent);
    const agentSecrets = await request(agentApp).get("/api/agents/me/secrets");
    const agentSecretValue = await request(agentApp).post("/api/agents/me/secrets/manager_private_key/value").send({});
    expect(agentSecrets.status).toBe(200);
    expect(agentSecretValue.status).toBe(403);
    for (const output of [agentSecrets.body, agentSecretValue.body, installedA, installedB]) {
      expectNoSentinels(output, [sentinelA.privatePem, sentinelB.privatePem]);
    }

    const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const pluginConfigRows = await db.select().from(pluginConfig).where(eq(pluginConfig.companyId, companyId));
    const rowData = JSON.stringify({ activities, pluginConfigRows, logs: logLines, pluginState: await installerServices.state.get({ scopeKind: "company", scopeId: companyId, namespace: "row12-installer", stateKey: "used-app-slugs" }) });
    expectNoSentinels(rowData, [sentinelA.privatePem, sentinelB.privatePem]);
    expect([rowData.includes(sentinelA.fingerprint), rowData.includes(sentinelB.fingerprint)]).toEqual([false, false]);
    const tables = await db.execute<{ table_name: string }>(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    const databaseLeakPatterns = [sentinelA.privatePem, sentinelB.privatePem].flatMap(leakForms).map((form) => sql`t::text LIKE ${`%${form}%`}`);
    for (const { table_name: table } of tables) {
      const [match] = await db.execute<{ count: number }>(sql`
        SELECT count(*)::int AS count FROM ${sql.identifier("public")}.${sql.identifier(table)} t
        WHERE ${sql.join(databaseLeakPatterns, sql` OR `)}
      `);
      expect(match.count, `plaintext sentinel in public.${table}`).toBe(0);
    }

    fake.calls.length = 0;
    fake.verifiedKeyIndexes.length = 0;
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, anchorProjectId));
    const archivedInstall = await invokeInstall();
    expect(archivedInstall.error).toContain("manager_key_anchor_unavailable");
    expect(fake.calls).toHaveLength(0);
    expect(fake.verifiedKeyIndexes).toHaveLength(0);

    expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
  }, 90_000);
});
