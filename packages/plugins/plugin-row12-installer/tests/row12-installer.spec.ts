import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync, verify as verifySignature, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { shouldCreateLowStockInboxItem } from "../src/low-stock.js";
import { GitHubApi } from "../src/github-api.js";
import { createRow12Plugin } from "../src/plugin.js";

const PRIMARY_SMARTY = "29b216c4-76bc-41a3-a71a-88d30737b688";
const COMPANY_ID = "company-1";
const PROJECT_ID = "project-1";
const APP_ID = "810";
const INSTALLATION_ID = "700";
const allowedOrg = "Smarty-Pants-Inc";
const fakeInstallToken = ["ghs", "test", "install", "token"].join("_");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sentinelPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const { privateKey: projectAppPrivateKey, publicKey: projectAppPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const projectAppPem = projectAppPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();

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

function expectNoPemLeak(observable: string, pem: string) {
  for (const form of leakForms(pem)) expect(observable.includes(form), `unexpected PEM leak form: ${form.slice(0, 32)}`).toBe(false);
}

type FakeCall = { method: string; path: string; body: unknown; authorization: string | undefined };
type FakeOptions = { installableOrgs?: Array<{ login: string }>; repoIds?: Record<string, number>; installErrorBody?: string; expectedDeletePath?: string };
const openFakes: Array<{ calls: FakeCall[]; expectedDeletePath?: string; close(): Promise<void> }> = [];

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

async function startFakeGitHub(options: FakeOptions = {}) {
  const calls: FakeCall[] = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      calls.push({ method, path, body, authorization: request.headers.authorization });
      if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        return send(response, 201, { token: fakeInstallToken, expires_at: "2099-01-01T00:00:00Z" });
      }
      if (method === "GET" && path.split("?")[0] === "/enterprises/acme/apps/installable_organizations") {
        return send(response, 200, options.installableOrgs ?? [{ login: allowedOrg }]);
      }
      if (method === "GET" && path.startsWith(`/repos/${allowedOrg}/`)) {
        const name = decodeURIComponent(path.slice(`/repos/${allowedOrg}/`.length));
        return send(response, 200, { id: options.repoIds?.[name] ?? 1001, name });
      }
      if (method === "POST" && path === `/enterprises/acme/apps/organizations/${allowedOrg}/installations`) {
        if (options.installErrorBody) return send(response, 500, { message: options.installErrorBody });
        return send(response, 201, { id: Number(INSTALLATION_ID), app_id: Number(APP_ID) });
      }
      if (method === "GET" && path === `/app/installations/${INSTALLATION_ID}`) {
        return send(response, 200, { id: Number(INSTALLATION_ID), app_id: Number(APP_ID) });
      }
      if (method === "PUT" && /^\/app\/installations\/\d+\/suspended$/.test(path)) {
        return response.writeHead(204).end();
      }
      if (method === "DELETE") {
        if (path !== options.expectedDeletePath) return send(response, 500, { message: "unexpected DELETE path" });
        return response.writeHead(204).end();
      }
      if (method === "PATCH" && path === `/enterprises/acme/apps/organizations/${allowedOrg}/installations/${INSTALLATION_ID}/repositories`) {
        return send(response, 200, { id: Number(INSTALLATION_ID), repository_selection: "selected" });
      }
      if (method === "POST" && path === `/enterprises/acme/apps/organizations/${allowedOrg}/installations/${INSTALLATION_ID}/repositories`) {
        return send(response, 200, { id: Number(INSTALLATION_ID) });
      }
      return send(response, 404, { message: "not found" });
    } catch {
      return send(response, 500, { message: "fake GitHub request parse failure" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake GitHub failed to bind");
  const fake = {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    expectedDeletePath: options.expectedDeletePath,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  openFakes.push(fake);
  return fake;
}

const baseConfig = {
  enterpriseSlug: "acme",
  allowedOrg,
  managerAppId: "1234",
  managerInstallationId: "444",
  managerKeyAnchorProjectId: "anchor-project",
  allowedCallerAgentIds: [PRIMARY_SMARTY],
  deniedRepos: ["tristar-org", "secrets", "client-repo"],
  registeredApps: [
    { slug: "product-one", appId: APP_ID, clientId: "Iv1.product-one", privateKeyRef: { type: "secret_ref", secretId: "product-one-key" }, approvedRepositoryIds: [1001] },
    { slug: "product-two", appId: "811", clientId: "Iv1.product-two", approvedRepositoryIds: [1002] },
    { slug: "product-three", appId: "812", clientId: "Iv1.product-three", approvedRepositoryIds: [1003] },
  ],
};

function makeRun(agentId = PRIMARY_SMARTY): ToolRunContext {
  return { agentId, runId: "run-1", companyId: COMPANY_ID, projectId: PROJECT_ID };
}

async function setup(fake: Awaited<ReturnType<typeof startFakeGitHub>>, options: {
  config?: Record<string, unknown>;
  key?: string | null;
  keyReadError?: boolean;
  auditError?: boolean;
  auditErrorAt?: "intent" | "outcome";
  appKeyResolveError?: boolean;
  anchor?: "missing" | "archived" | "has-agent" | "wrong-name" | "has-task";
} = {}) {
  const harness = createTestHarness({ manifest });
  const ctx = harness.ctx as PluginContext;
  const audit: unknown[] = [];
  const logs: unknown[] = [];
  const keyReads: Array<{ projectId: string; companyId: string }> = [];
  const secretRefs: unknown[] = [];
  let secretResolveCalls = 0;
  const config = { ...baseConfig, ...(options.config ?? {}) };
  ctx.config.get = async () => config;
  ctx.projects.get = async () => {
    if (options.anchor === "missing") return null;
    const anchor = {
      name: options.anchor === "wrong-name" ? "other-project" : "github-manager-key",
      archivedAt: options.anchor === "archived" ? new Date() : null,
      leadAgentId: options.anchor === "has-agent" ? "agent-in-anchor" : null,
    };
    return anchor as Awaited<ReturnType<typeof ctx.projects.get>>;
  };
  ctx.issues.list = async () => options.anchor === "has-task" ? ([{}] as Awaited<ReturnType<typeof ctx.issues.list>>) : [];
  ctx.projects.getInstanceSecrets = async (projectId, companyId) => {
    keyReads.push({ projectId, companyId });
    if (options.keyReadError) throw new Error("revoked sentinel details must be suppressed");
    return options.key === null ? {} : { manager_private_key: options.key ?? sentinelPem };
  };
  ctx.activity.log = async (entry) => {
    const phase = (entry.metadata as { phase?: string } | undefined)?.phase;
    if (options.auditError || options.auditErrorAt === phase) throw new Error("activity backend failed");
    audit.push(entry);
  };
  ctx.secrets.resolve = async (secretRef) => {
    secretResolveCalls++;
    secretRefs.push(secretRef);
    if (options.appKeyResolveError) throw new Error("revoked App key details must be suppressed");
    return projectAppPem;
  };
  ctx.logger.info = (message, meta) => { logs.push([message, meta]); };
  ctx.logger.warn = (message, meta) => { logs.push([message, meta]); };
  ctx.logger.error = (message, meta) => { logs.push([message, meta]); };
  ctx.logger.debug = (message, meta) => { logs.push([message, meta]); };
  const plugin = createRow12Plugin({ apiBaseUrl: fake.url });
  await plugin.definition.setup(ctx);
  return { harness, audit, logs, keyReads, secretRefs, get secretResolveCalls() { return secretResolveCalls; } };
}

async function invoke(
  harness: Awaited<ReturnType<typeof setup>>["harness"],
  name: string,
  params: unknown,
  run = makeRun(),
) {
  return harness.executeTool(name, params, run);
}

function mutationCalls(calls: FakeCall[]) {
  return calls.filter((call) => call.path.endsWith("/installations") || call.path.includes("/repositories"));
}

function bearerJwtVerifies(call: FakeCall, publicKey: KeyObject): boolean {
  const jwt = call.authorization?.replace(/^Bearer /, "") ?? "";
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) return false;
  return verifySignature("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"));
}

afterEach(async () => {
  const live = openFakes.splice(0);
  for (const fake of live) {
    const deletes = fake.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.path)).toEqual(fake.expectedDeletePath ? [fake.expectedDeletePath] : []);
    await fake.close();
  }
});

describe("row-12 enterprise installer chunk 1", () => {
  it("R1 refuses an unregistered app before any GitHub call", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    const result = await invoke(harness, "github_app_install", { slug: "not-registered", repositories: ["smarty-poc-work"] });
    expect(result.error).toMatch(/registered/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("R2 never sends repository_selection=all, including the narrowing toggle", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    await invoke(harness, "github_app_narrow_installation", { slug: "product-one", keep: ["smarty-poc-work"] });
    expect(fake.calls.some((call) => (call.body as { repository_selection?: string } | null)?.repository_selection === "all")).toBe(false);
    expect(fake.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(fake.calls.find((call) => call.method === "PATCH")?.body).toEqual({ repository_selection: "selected", repositories: ["smarty-poc-work"] });
  });

  it.each(["tristar-org", "secrets", "client-repo"])("R3-R5 refuses denied repository %s before an install mutation", async (repo) => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: [repo] });
    expect(result.error).toMatch(/refus|denied|not permitted/i);
    expect(mutationCalls(fake.calls).filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("R6 refuses a configured organization other than Smarty-Pants-Inc", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake, { config: { allowedOrg: "some-other-org" } });
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect(result.error).toMatch(/Smarty-Pants-Inc/i);
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["worker-agent", "project-lead", "viewer-agent"])("R7 refuses non-primary actor %s with a readable reason", async (agentId) => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] }, makeRun(agentId));
    expect(result.error).toMatch(/primary Smarty/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("R8 installs exactly selected repos and writes intent then durable outcome activity", async () => {
    const fake = await startFakeGitHub();
    const { harness, audit, keyReads } = await setup(fake);
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect(result.data).toMatchObject({ installationId: Number(INSTALLATION_ID), slug: "product-one", repositories: ["smarty-poc-work"], httpStatus: 201 });
    const installPosts = fake.calls.filter((call) => call.method === "POST" && call.path === `/enterprises/acme/apps/organizations/${allowedOrg}/installations`);
    expect(installPosts).toHaveLength(1);
    expect(installPosts[0]?.body).toEqual({ client_id: "Iv1.product-one", repository_selection: "selected", repositories: ["smarty-poc-work"] });
    expect(audit).toHaveLength(2);
    expect(audit.map((row) => (row as { metadata: { phase: string } }).metadata.phase)).toEqual(["intent", "outcome"]);
    expect(audit[1]).toMatchObject({ metadata: { runId: "run-1", agentId: PRIMARY_SMARTY, projectId: PROJECT_ID, appId: APP_ID, slug: "product-one", installationId: Number(INSTALLATION_ID), repositories: ["smarty-poc-work"], httpStatus: 201 } });
    expect(keyReads).toEqual([{ projectId: "anchor-project", companyId: COMPANY_ID }]);
  });

  it("reports the completed GitHub install when its outcome audit row fails and never retries", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake, { auditErrorAt: "outcome" });
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect(result.error).toContain("github_app_install");
    expect(result.error).toContain("product-one");
    expect(result.error).toContain("installation 700");
    expect(result.error).toContain("smarty-poc-work (1001)");
    expect(result.error).toContain("HTTP 201");
    expect(fake.calls.filter((call) => call.method === "POST" && call.path === `/enterprises/acme/apps/organizations/${allowedOrg}/installations`)).toHaveLength(1);
    expect(fake.calls.filter((call) => call.path === `/enterprises/acme/apps/organizations/${allowedOrg}/installations`)).toHaveLength(1);
  });

  it.each(["missing", "archived", "has-agent", "wrong-name", "has-task"] as const)("fails closed with manager_key_anchor_unavailable for an anchor that is %s", async (anchor) => {
    const fake = await startFakeGitHub();
    const { harness, keyReads } = await setup(fake, { anchor });
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect(result.error).toContain("manager_key_anchor_unavailable");
    expect(fake.calls).toHaveLength(0);
    expect(keyReads).toHaveLength(0);
  });

  it("R13 refuses suspend and unsuspend for unregistered Apps before any GitHub call", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    const suspend = await invoke(harness, "github_app_suspend", { slug: "not-registered" });
    const unsuspend = await invoke(harness, "github_app_unsuspend", { slug: "not-registered" });
    expect(suspend.error).toMatch(/registered allowlist/i);
    expect(unsuspend.error).toMatch(/registered allowlist/i);
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["github_app_suspend", "github_app_unsuspend"] as const)("R13 keeps %s primary-only", async (tool) => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    const result = await invoke(harness, tool, { slug: "product-one" }, makeRun("worker-agent"));
    expect(result.error).toMatch(/primary Smarty/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("R13 suspends with PUT and only github_app_unsuspend sends the exact DELETE using the registered App key", async () => {
    const expectedPath = `/app/installations/${INSTALLATION_ID}/suspended`;
    const fake = await startFakeGitHub({ expectedDeletePath: expectedPath });
    const { harness, audit, secretRefs } = await setup(fake);
    await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    const beforeSuspension = fake.calls.length;
    const suspended = await invoke(harness, "github_app_suspend", { slug: "product-one" });
    expect(suspended.data).toMatchObject({ installationId: Number(INSTALLATION_ID), slug: "product-one", httpStatus: 204 });
    expect(fake.calls.slice(beforeSuspension).filter((call) => call.method === "DELETE")).toHaveLength(0);
    const unsuspended = await invoke(harness, "github_app_unsuspend", { slug: "product-one" });
    expect(unsuspended.data).toMatchObject({ installationId: Number(INSTALLATION_ID), slug: "product-one", httpStatus: 204 });
    const suspendCalls = fake.calls.filter((call) => call.method === "PUT" || call.method === "DELETE");
    expect(suspendCalls.map((call) => [call.method, call.path])).toEqual([["PUT", expectedPath], ["DELETE", expectedPath]]);
    expect(suspendCalls).toHaveLength(2);
    expect(bearerJwtVerifies(suspendCalls[0]!, projectAppPublicKey)).toBe(true);
    expect(bearerJwtVerifies(suspendCalls[1]!, projectAppPublicKey)).toBe(true);
    expect(JSON.parse(Buffer.from(suspendCalls[0]!.authorization!.slice(7).split(".")[1]!, "base64url").toString("utf8")).iss).toBe(APP_ID);
    expect(secretRefs).toEqual([baseConfig.registeredApps[0]!.privateKeyRef, baseConfig.registeredApps[0]!.privateKeyRef]);
    const suspensionAudit = audit.filter((entry) => ["github_app_suspend", "github_app_unsuspend"].includes((entry as { metadata: { operation: string } }).metadata.operation));
    expect(suspensionAudit).toHaveLength(4);
    expect(suspensionAudit.map((entry) => (entry as { metadata: { phase: string; operation: string; installationId: number; httpStatus: number } }).metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "outcome", operation: "github_app_suspend", installationId: Number(INSTALLATION_ID), httpStatus: 204 }),
      expect.objectContaining({ phase: "outcome", operation: "github_app_unsuspend", installationId: Number(INSTALLATION_ID), httpStatus: 204 }),
    ]));
    const observable = JSON.stringify({ suspended, unsuspended, audit });
    expectNoPemLeak(observable, projectAppPem);
  });

  it("R13 refuses a registered App with no own private-key reference before GitHub calls", async () => {
    const fake = await startFakeGitHub();
    const config = {
      ...baseConfig,
      registeredApps: baseConfig.registeredApps.map((app) => app.slug === "product-one" ? { ...app, privateKeyRef: undefined } : app),
    };
    const { harness } = await setup(fake, { config });
    await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    fake.calls.length = 0;
    const result = await invoke(harness, "github_app_suspend", { slug: "product-one" });
    expect(result.error).toMatch(/no private-key secret reference/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("R13 refuses a missing or revoked registered-App key reference with zero GitHub calls", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake, { appKeyResolveError: true });
    await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    fake.calls.length = 0;
    const result = await invoke(harness, "github_app_suspend", { slug: "product-one" });
    expect(result.error).toMatch(/private key unavailable/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("R16 blocks DELETE from every generic request spelling", async () => {
    const fake = await startFakeGitHub();
    const api = new GitHubApi({ read: async () => sentinelPem }, { baseUrl: fake.url });
    await expect(api.request("DELETE", "/forbidden", "fixture-token")).rejects.toThrow(/reserved for GitHub App unsuspension/i);
    await expect(api.request("delete", "/forbidden", "fixture-token")).rejects.toThrow(/reserved for GitHub App unsuspension/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("does not issue DELETE: repository removal is refused before GitHub calls", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    const result = await invoke(harness, "github_app_set_repositories", { installationId: INSTALLATION_ID, add: [], remove: ["old-repo"] });
    expect(result.error).toMatch(/removal is refused.*no DELETE/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("adds selected approved repos through the enterprise grant endpoint", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    const result = await invoke(harness, "github_app_set_repositories", { installationId: INSTALLATION_ID, add: ["smarty-poc-work"], remove: [] });
    expect(result.data).toMatchObject({ installationId: Number(INSTALLATION_ID), slug: "product-one", repositories: ["smarty-poc-work"], httpStatus: 200 });
    expect(fake.calls.some((call) => call.method === "POST" && call.path === `/enterprises/acme/apps/organizations/${allowedOrg}/installations/${INSTALLATION_ID}/repositories`)).toBe(true);
  });

  it("R8 fails closed when the intent activity write fails", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake, { auditError: true });
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect(result.error).toMatch(/audit intent.*no GitHub/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("R9/R17 never returns or persists the sentinel PEM, its base64 encodings, JWT, or installation token", async () => {
    const fake = await startFakeGitHub();
    const { harness, audit, logs } = await setup(fake);
    const response = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    const observable = JSON.stringify({ response, audit, logs });
    expectNoPemLeak(observable, sentinelPem);
    expect(observable.includes(fakeInstallToken)).toBe(false);
    expect(fake.calls.some((call) => call.authorization?.includes(fakeInstallToken))).toBe(true);
    const jwt = fake.calls.find((call) => call.path.includes("/access_tokens"))?.authorization?.replace(/^Bearer /, "");
    expect(typeof jwt).toBe("string");
    expect(observable.includes(jwt ?? "missing-jwt")).toBe(false);
    expect(audit).toHaveLength(2);
  });

  it("R9 suppresses sentinel PEM echoed in a GitHub error body", async () => {
    const fake = await startFakeGitHub({ installErrorBody: sentinelPem });
    const { harness, audit, logs } = await setup(fake);
    const response = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    const observable = JSON.stringify({ response, audit, logs });
    expect(response.error).toMatch(/HTTP 500/);
    expectNoPemLeak(observable, sentinelPem);
  });

  it("R10 reports the manual-install fallback when the org is absent and refuses install", async () => {
    const fake = await startFakeGitHub({ installableOrgs: [{ login: "other-org" }] });
    const { harness } = await setup(fake);
    const orgs = await invoke(harness, "github_app_installable_orgs", {});
    expect(JSON.stringify(orgs)).toMatch(/not enterprise-owned.*fall back to manual install/i);
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect(result.error).toMatch(/not enterprise-owned.*manual install/i);
    expect(fake.calls.some((call) => call.method === "POST" && call.path.endsWith("/installations"))).toBe(false);
  });

  it("R11 narrows with exactly the primary-approved keep list", async () => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake);
    await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    const result = await invoke(harness, "github_app_narrow_installation", { slug: "product-one", keep: ["smarty-poc-work"] });
    expect(result.data).toMatchObject({ installationId: Number(INSTALLATION_ID), repositories: ["smarty-poc-work"], httpStatus: 200 });
    const toggles = fake.calls.filter((call) => call.method === "PATCH");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]?.body).toEqual({ repository_selection: "selected", repositories: ["smarty-poc-work"] });
  });

  it.each(["missing", "revoked"])("R12 fails closed for a %s manager key with zero GitHub calls", async (kind) => {
    const fake = await startFakeGitHub();
    const { harness } = await setup(fake, kind === "missing" ? { key: null } : { keyReadError: true });
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect(result.error).toMatch(/manager key unavailable/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("R15 resolves and refuses a stable repository ID outside the primary-ratified set", async () => {
    const fake = await startFakeGitHub({ repoIds: { "unratified-repo": 9999 } });
    const { harness } = await setup(fake);
    const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["unratified-repo"] });
    expect(result.error).toMatch(/stable repository id.*not approved/i);
    expect(fake.calls.some((call) => call.method === "GET" && call.path === `/repos/${allowedOrg}/unratified-repo`)).toBe(true);
    expect(fake.calls.some((call) => call.method === "POST" && call.path.endsWith("/installations"))).toBe(false);
  });

  it("R17 install makes no environment or shared secret binding changes, and the manager key is not config", async () => {
    const fake = await startFakeGitHub();
    const before = { ...process.env };
    const runtime = await setup(fake);
    await invoke(runtime.harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
    expect({ ...process.env }).toEqual(before);
    expect(runtime.secretResolveCalls).toBe(0);
    expect(runtime.keyReads).toEqual([{ projectId: "anchor-project", companyId: COMPANY_ID }]);
    const properties = (manifest.instanceConfigSchema as { properties: Record<string, unknown> }).properties;
    expect(properties).not.toHaveProperty("managerPrivateKey");
    expect(properties).not.toHaveProperty("managerKeyName");
  });

  it.each([[3, false], [2, true], [1, true], [0, true]] as const)(
    "R18 low-stock flag with %i unused Apps is %s",
    async (unusedCount, expectedLowStock) => {
      const fake = await startFakeGitHub();
      const registeredApps = [
        baseConfig.registeredApps[0],
        ...Array.from({ length: unusedCount }, (_, index) => ({
          slug: `unused-${index + 1}`,
          appId: `${900 + index}`,
          clientId: `Iv1.unused-${index + 1}`,
          approvedRepositoryIds: [2000 + index],
        })),
      ];
      const { harness } = await setup(fake, { config: { registeredApps } });
      const result = await invoke(harness, "github_app_install", { slug: "product-one", repositories: ["smarty-poc-work"] });
      expect(result.data).toMatchObject({ lowStock: expectedLowStock });
      const key = (result.data as { lowStockDeduplicationKey: string | null }).lowStockDeduplicationKey;
      if (expectedLowStock) expect(key).toEqual(expect.any(String));
      else expect(key).toBeNull();
      if (expectedLowStock && key) {
        expect(shouldCreateLowStockInboxItem({ lowStock: true, deduplicationKey: key, existingKeys: new Set() })).toBe(true);
        expect(shouldCreateLowStockInboxItem({ lowStock: true, deduplicationKey: key, existingKeys: new Set([key]) })).toBe(false);
      }
    },
  );
});
