import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  environments,
  approvals,
  principalPermissionGrants,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { secretService } from "../services/secrets.js";
import { piRpcThinking, resolvePaperclipRunnerNativeProviderInput } from "../services/native-runtime/provider-profile.js";
import * as providerPack from "../services/native-runtime/remote-provider-pack.js";
import { fingerprintEnvironmentSandboxProviderConfig, SANDBOX_PLATFORM_PROBE_METADATA_KEY } from "../services/environment-custom-image-runtime.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.js";
import { environmentService } from "../services/environments.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-hire credential inheritance route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

// The fixed Claude Code OAuth binding. It is a user-secret reference to the
// fixed key. Any other shape is a replacement or a weaker binding.
const FIXED_CLAUDE_OAUTH_BINDING = { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } as const;

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

// The local implicit board actor always passes authorization, so it stands in
// for a user actor without needing a seeded company membership.
function userActor(): Express.Request["actor"] {
  return { type: "board", userId: "local-board", source: "local_implicit" };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("hired agent provider credential inheritance", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-hire-auth-inheritance-${randomUUID()}`);

  beforeAll(async () => {
    // These route rows exercise configuration persistence, not provider-pack installation.
    vi.spyOn(providerPack, "installedNativePiDriverAvailable").mockResolvedValue(true);
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-auth-inheritance-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Auth Inheritance Co ${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParentAgent(companyId: string, adapterType: string, env: Record<string, unknown>) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Parent ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        adapterType,
        adapterConfig: { env },
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      })
      .returning();
    return row!;
  }

  async function createCompanySecret(companyId: string, value: string) {
    return secretService(db).create(companyId, {
      name: `cred-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
  }

  function secretRef(secretId: string, extra: Record<string, unknown> = {}) {
    return { type: "secret_ref" as const, secretId, ...extra };
  }

  function hire(actor: Express.Request["actor"], companyId: string, payload: Record<string, unknown>) {
    const app = createApp(db, actor);
    return request(app).post(`/api/companies/${companyId}/agent-hires`).send(payload);
  }

  function childEnvOf(res: request.Response): Record<string, unknown> {
    return ((res.body.agent?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env) ?? {};
  }

  it("inherits the parent secret_ref for a codex_local hire with no env, and derives the child binding", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-parent");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).OPENAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, res.body.agent.id),
        ),
      );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      configPath: "env.OPENAI_API_KEY",
      secretId: secret.id,
      versionSelector: "latest",
    });
  });

  it("keeps a pinned version selector on the copied reference and its derived binding", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-pinned");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id, { version: 3 }),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Pinned Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).OPENAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id, version: 3 });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetId, res.body.agent.id),
        ),
      );
    expect(bindings[0]?.versionSelector).toBe("3");
  });

  it("retains version, required, and allowMissingOverride on a copied user_secret_ref", async () => {
    const companyId = await seedCompany();
    await secretService(db).createUserSecretDefinition(companyId, {
      key: "openai_shared_key",
      name: "Shared OpenAI key",
      provider: "local_encrypted",
    });
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: {
        type: "user_secret_ref",
        key: "openai_shared_key",
        version: 2,
        required: false,
        allowMissingOverride: true,
      },
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex User Secret Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).OPENAI_API_KEY).toMatchObject({
      type: "user_secret_ref",
      key: "openai_shared_key",
      version: 2,
      required: false,
      allowMissingOverride: true,
    });
  });

  it("inherits a grok_local parent's XAI_API_KEY reference", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "xai-parent-key");
    const parent = await seedParentAgent(companyId, "grok_local", {
      XAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Grok Child",
      role: "engineer",
      adapterType: "grok_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).XAI_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });
  });

  it("inherits a native OpenCode parent's OPENROUTER_API_KEY reference when the hire inherits the caller runtime", async () => {
    const companyId = await seedCompany();
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    const secret = await createCompanySecret(companyId, "openrouter-parent-key");
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    await db.update(agents).set({ adapterConfig: {
      provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", opencodePermissionMode: "allow",
      env: { OPENROUTER_API_KEY: secretRef(secret.id, { version: "latest" }), OPENCODE_CONFIG_CONTENT: "{\"provider\":{}}" },
    } }).where(eq(agents.id, parent.id));

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "OpenCode Child", role: "qa", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.status).toBe("pending_approval");
    const [child] = await db.select().from(agents).where(eq(agents.id, res.body.agent.id));
    const env = (child!.adapterConfig as { env?: Record<string, unknown> }).env ?? {};
    expect(env.OPENROUTER_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id, version: "latest" });
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });

  it.each(["create", "hire"] as const)("blocks native Claude credential redirection before %s inheritance", async mode => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "fixture-parent-credential");
    const parent = await seedParentAgent(companyId, "paperclip_runner", { ANTHROPIC_API_KEY: secretRef(secret.id) });
    await db.update(agents).set({ adapterConfig: { provider: "acpx", acpxAgent: "claude", env: { ANTHROPIC_API_KEY: secretRef(secret.id) } } }).where(eq(agents.id, parent.id));
    const app = createApp(db, agentActor(companyId, parent.id));
    const res = await request(app).post(`/api/companies/${companyId}/${mode === "hire" ? "agent-hires" : "agents"}`).send({
      name: "Redirected child", role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "claude", env: { ANTHROPIC_BASE_URL: "https://untrusted.example.test" } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("host-executed local adapter settings");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
  });

  it("still inherits Claude credential references for an ordinary native hire", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "fixture-parent-credential");
    const parent = await seedParentAgent(companyId, "claude_local", { ANTHROPIC_API_KEY: secretRef(secret.id) });
    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Native child", role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", acpxAgent: "claude" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.adapterType).toBe("paperclip_runner");
    expect(childEnvOf(res).ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });
  });

  it("inherits a claude_local parent's ANTHROPIC_API_KEY reference", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "ant-parent-key");
    const parent = await seedParentAgent(companyId, "claude_local", {
      ANTHROPIC_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });
  });

  it("keeps the child-supplied ANTHROPIC_API_KEY and inherits no Claude credential at all", async () => {
    const companyId = await seedCompany();
    const childSecret = await createCompanySecret(companyId, "ant-child-key");
    // The parent holds the fixed Claude OAuth binding, which is normally
    // inheritable, but the child already supplies its own Claude credential.
    const parent = await seedParentAgent(companyId, "claude_local", {
      CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_CLAUDE_OAUTH_BINDING },
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude Child With Own Key",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { env: { ANTHROPIC_API_KEY: secretRef(childSecret.id) } },
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    expect(childEnv.ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: childSecret.id });
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("does not inherit a plain environment value", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "grok_local", {
      XAI_API_KEY: "xai-plain-value",
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Grok Plain Value Child",
      role: "engineer",
      adapterType: "grok_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).XAI_API_KEY).toBeUndefined();
  });

  it("does not inherit across a mismatched adapter type", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-mismatch");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude Child From Codex Parent",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(childEnvOf(res))).toHaveLength(0);
  });

  it("does not inherit a codex_local credential from a hiring agent in another company", async () => {
    const parentCompanyId = await seedCompany();
    const targetCompanyId = await seedCompany();
    const secret = await createCompanySecret(parentCompanyId, "sk-openai-other-company");
    const parent = await seedParentAgent(parentCompanyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id),
    });

    // The actor claims the target company, but the named hiring agent belongs
    // to a different company. The route must reject the request and must
    // never copy the other company's credential reference.
    const res = await hire(agentActor(targetCompanyId, parent.id), targetCompanyId, {
      name: "Codex Cross-Company Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status).toBe(403);
    const children = await db.select().from(agents).where(eq(agents.companyId, targetCompanyId));
    expect(children).toHaveLength(0);
  });

  it("does not inherit a grok_local credential from a hiring agent in another company", async () => {
    const parentCompanyId = await seedCompany();
    const targetCompanyId = await seedCompany();
    const secret = await createCompanySecret(parentCompanyId, "xai-other-company");
    const parent = await seedParentAgent(parentCompanyId, "grok_local", {
      XAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(targetCompanyId, parent.id), targetCompanyId, {
      name: "Grok Cross-Company Child",
      role: "engineer",
      adapterType: "grok_local",
    });

    expect(res.status).toBe(403);
    const children = await db.select().from(agents).where(eq(agents.companyId, targetCompanyId));
    expect(children).toHaveLength(0);
  });

  it("does not inherit a claude_local credential, including the fixed OAuth binding, from a hiring agent in another company", async () => {
    const parentCompanyId = await seedCompany();
    const targetCompanyId = await seedCompany();
    const parent = await seedParentAgent(parentCompanyId, "claude_local", {
      ANTHROPIC_API_KEY: secretRef((await createCompanySecret(parentCompanyId, "ant-other-company")).id),
      CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_CLAUDE_OAUTH_BINDING, version: 1 },
    });

    const res = await hire(agentActor(targetCompanyId, parent.id), targetCompanyId, {
      name: "Claude Cross-Company Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status).toBe(403);
    const children = await db.select().from(agents).where(eq(agents.companyId, targetCompanyId));
    expect(children).toHaveLength(0);
  });

  it("carves out a per-agent CODEX_HOME when the child inherits OPENAI_API_KEY", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "sk-openai-isolated");
    const parent = await seedParentAgent(companyId, "codex_local", {
      OPENAI_API_KEY: secretRef(secret.id),
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Isolated Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    // A bare environment string persists as a `plain` binding.
    const codexHome = childEnv.CODEX_HOME as { type: string; value: string } | undefined;
    expect(codexHome?.type).toBe("plain");
    expect(codexHome?.value.length ?? 0).toBeGreaterThan(0);
  });

  it("keeps the shared company Codex home when the child inherits no key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "codex_local", {});

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Codex Shared Home Child",
      role: "engineer",
      adapterType: "codex_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).CODEX_HOME).toBeUndefined();
  });

  it("adds no home override for a grok_local child with no inherited key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "grok_local", {});

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Grok No Key Child",
      role: "engineer",
      adapterType: "grok_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    expect(childEnv.GROK_HOME).toBeUndefined();
    expect(childEnv.XAI_API_KEY).toBeUndefined();
  });

  it("inherits nothing for a user actor hire", async () => {
    const companyId = await seedCompany();
    // No hiring-agent context exists for a user actor. The merge must not run
    // at all, so an otherwise-inheritable key is simply never considered.
    const res = await hire(userActor(), companyId, {
      name: "User Hired Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(childEnvOf(res))).toHaveLength(0);
  });

  it.each((["agents", "agent-hires"] as const).flatMap(endpoint =>
    [
      { provider: "codex", model: undefined, key: "modelReasoningEffort" },
      { provider: "codex", model: "gpt-6.1-sol", key: "modelReasoningEffort" },
      { provider: "acpx", acpxAgent: "claude", key: "modelReasoningEffort" },
      { provider: "acpx", acpxAgent: "grok", key: "reasoningEffort" },
    ].flatMap(kind => [undefined, null, "", "auto", "high", "unknown", 5].map(level => ({ endpoint, ...kind, level }))),
  ))("$endpoint $provider/$acpxAgent persists or refuses $key=$level", async ({ endpoint, key, level, ...kind }) => {
    const companyId = await seedCompany();
    const res = await request(createApp(db, userActor())).post(`/api/companies/${companyId}/${endpoint}`).send({
      name: "Reasoning Child", role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { ...kind, [key]: level },
    });
    if (level === "unknown" || typeof level === "number") {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
      return;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const responseAgent = endpoint === "agents" ? res.body : res.body.agent;
    const [child] = await db.select().from(agents).where(eq(agents.id, responseAgent.id));
    const expected = level === "high" ? "high" : "medium";
    expect(child!.adapterConfig[key]).toBe(expected);
    expect(responseAgent.adapterConfig[key]).toBe(expected);
    if (kind.provider === "codex") {
      expect(child!.adapterConfig.model).toBe(kind.model ?? "claude-opus-5-5");
      expect(responseAgent.adapterConfig.model).toBe(kind.model ?? "claude-opus-5-5");
    }
    const native = resolvePaperclipRunnerNativeProviderInput({ backend: kind.provider === "codex" ? "codex_app_server" : "acpx_runtime", adapterConfig: child!.adapterConfig });
    const nativeKey = kind.acpxAgent === "claude" ? "claudeEffort" : kind.acpxAgent === "grok" ? "grokEffort" : "codexReasoningEffort";
    expect(native).toMatchObject({ [nativeKey]: expected });
  });

  it.each((["agents", "agent-hires"] as const).flatMap(endpoint => [
    { adapterType: "codex_local", key: "modelReasoningEffort" },
    { adapterType: "claude_local", key: "effort" },
    { adapterType: "grok_local", key: "reasoningEffort" },
  ].flatMap(kind => [undefined, "high", "unknown"].map(level => ({ endpoint, ...kind, level })))))
  ("legacy $endpoint $adapterType persists or refuses $key=$level", async ({ endpoint, adapterType, key, level }) => {
    const companyId = await seedCompany();
    const res = await request(createApp(db, userActor())).post(`/api/companies/${companyId}/${endpoint}`).send({
      name: "Legacy Reasoning Child", role: "engineer", adapterType, runner: "legacy", adapterConfig: { [key]: level },
    });
    if (level === "unknown") {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
      return;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const responseAgent = endpoint === "agents" ? res.body : res.body.agent;
    const [child] = await db.select().from(agents).where(eq(agents.id, responseAgent.id));
    expect(child!.adapterConfig[key]).toBe(level ?? "medium");
    if (adapterType === "codex_local" || adapterType === "claude_local") {
      expect(child!.adapterConfig.model).toBe("claude-opus-5-5");
      expect(responseAgent.adapterConfig.model).toBe("claude-opus-5-5");
    }
  });

  it.each(["codex", "pi_rpc"] as const)("%s explicit hires inherit only an omitted environment", async provider => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: "Parent local", driver: "local" });
    await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, parent.id));
    for (const requestedEnvironment of [undefined, null, environmentId]) {
      if (requestedEnvironment === environmentId) {
        await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, parent.id));
      }
      const res = await hire(agentActor(companyId, parent.id), companyId, {
        name: "Environment Child", role: "engineer", adapterType: "paperclip_runner",
        adapterConfig: { provider, ...(provider === "codex" && requestedEnvironment === environmentId ? { model: "gpt-6.1-sol" } : {}), ...(requestedEnvironment === environmentId
          ? { [provider === "codex" ? "modelReasoningEffort" : "piRpcThinkingLevel"]: "high" } : {}) },
        defaultEnvironmentId: requestedEnvironment,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [child] = await db.select().from(agents).where(eq(agents.id, res.body.agent.id));
      const expectedEnvironment = requestedEnvironment === undefined ? environmentId : requestedEnvironment;
      expect(child!.defaultEnvironmentId).toBe(expectedEnvironment);
      expect(res.body.agent.defaultEnvironmentId).toBe(expectedEnvironment);
      if (provider === "codex") expect(child!.adapterConfig.model)
        .toBe(requestedEnvironment === environmentId ? "gpt-6.1-sol" : "claude-opus-5-5");
      expect(child!.adapterConfig[provider === "codex" ? "modelReasoningEffort" : "piRpcThinkingLevel"])
        .toBe(requestedEnvironment === environmentId ? "high" : "medium");
    }
  });

  it.each((["agents", "agent-hires"] as const).flatMap(endpoint =>
    [undefined, "auto", "legacy"].flatMap(runner => ["sandbox", "local"].map(driver => ({ endpoint, runner, driver }))),
  ))("Codex card $endpoint on $driver with runner $runner", async ({ endpoint, runner, driver }) => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: "Plugin computer", driver,
      config: driver === "sandbox" ? { provider: "example-sandbox" } : {} });
    await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, parent.id));
    const res = await request(createApp(db, endpoint === "agents" ? userActor() : agentActor(companyId, parent.id)))
      .post(`/api/companies/${companyId}/${endpoint}`).send({
        name: "Codex card child", role: "engineer", adapterType: "codex_local", runner,
        adapterConfig: { dangerouslyBypassApprovalsAndSandbox: true },
        ...(endpoint === "agents" ? { defaultEnvironmentId: environmentId } : {}),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const responseAgent = endpoint === "agents" ? res.body : res.body.agent;
    const [child] = await db.select().from(agents).where(eq(agents.id, responseAgent.id));
    expect(child).toMatchObject({ defaultEnvironmentId: environmentId,
      adapterType: runner === "legacy" ? "codex_local" : "paperclip_runner", adapterConfig: { modelReasoningEffort: "medium" } });
    if (runner === "legacy") return expect(child!.adapterConfig.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(child!.adapterConfig).toMatchObject({ provider: "codex", model: expect.stringMatching(/\S/) });
    expect(child!.adapterConfig).not.toHaveProperty("dangerouslyBypassApprovalsAndSandbox");
    expect(responseAgent.adapterConfig).not.toHaveProperty("dangerouslyBypassApprovalsAndSandbox");
  });

  it.each(["gpt-6.1-sol", undefined])("caller-runtime Codex defaults model and level regardless of caller model %s", async model => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: "Caller local", driver: "local" });
    await db.update(agents).set({ adapterConfig: {
      provider: "codex", model, modelReasoningEffort: "high",
    }, defaultEnvironmentId: environmentId }).where(eq(agents.id, parent.id));
    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Inherited Codex Child", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [child] = await db.select().from(agents).where(eq(agents.id, res.body.agent.id));
    expect(child!.adapterConfig.modelReasoningEffort).toBe("medium");
    expect(child!.adapterConfig.model).toBe("claude-opus-5-5");
    expect(child!.defaultEnvironmentId).toBe(environmentId);
  });

  it.each(["reasoningEffort", "effort"])("Codex uses a named %s alias and refuses a masked invalid alias", async key => {
    const companyId = await seedCompany();
    const payload = { name: "Alias Child", role: "engineer", adapterType: "paperclip_runner" };
    const app = createApp(db, userActor());
    const res = await request(app).post(`/api/companies/${companyId}/agents`).send({
      ...payload, adapterConfig: { provider: "codex", [key]: "high" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterConfig.modelReasoningEffort).toBe("high");
    const invalid = await request(app).post(`/api/companies/${companyId}/agents`).send({
      ...payload, adapterConfig: { provider: "codex", modelReasoningEffort: "low", [key]: "unknown" },
    });
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(422);
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
  });

  it.each([
    { name: "defaults rather than copying the caller level", board: false, callerLevel: "xhigh", requestedLevel: undefined, expectedLevel: "medium" },
    { name: "keeps an explicitly named level", board: false, callerLevel: "xhigh", requestedLevel: "low", expectedLevel: "low" },
    { name: "defaults a board hire", board: true, callerLevel: "xhigh", requestedLevel: undefined, expectedLevel: "medium" },
    { name: "defaults when the caller has no level", board: false, callerLevel: undefined, requestedLevel: undefined, expectedLevel: "medium" },
  ])("pi_rpc hire thinking level: $name", async ({ board, callerLevel, requestedLevel, expectedLevel }) => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    await db.update(agents).set({ adapterConfig: {
      provider: "pi_rpc", model: "openai-codex/gpt-5.6", ...(callerLevel ? { piRpcThinkingLevel: callerLevel } : {}),
    } }).where(eq(agents.id, parent.id));
    const res = await hire(board ? userActor() : agentActor(companyId, parent.id), companyId, {
      name: "Pi Child", role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", model: "openai-codex/gpt-5.6", ...(requestedLevel ? { piRpcThinkingLevel: requestedLevel } : {}) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [child] = await db.select().from(agents).where(eq(agents.id, res.body.agent.id));
    expect(child!.adapterConfig.piRpcThinkingLevel).toBe(expectedLevel);
    expect(child!.adapterConfig.model).toBe("openai-codex/gpt-5.6");
    expect(res.body.agent.adapterConfig.piRpcThinkingLevel).toBe(expectedLevel);
  });

  it.each((["agents", "agent-hires"] as const).flatMap(endpoint =>
    ["piRpcThinkingLevel", "modelReasoningEffort", "reasoningEffort", "effort"].flatMap(key =>
      ["high", "low", "off", 5, "unknown"].map(level => ({ endpoint, key, level })),
    ),
  ))("pi_rpc $endpoint honors or refuses $key=$level", async ({ endpoint, key, level }) => {
    const companyId = await seedCompany();
    const res = await request(createApp(db, userActor()))
      .post(`/api/companies/${companyId}/${endpoint}`).send({
        name: "Pi Child", role: "engineer", adapterType: "paperclip_runner",
        adapterConfig: { provider: "pi_rpc", [key]: level },
      });
    if (typeof level !== "string" || level === "unknown") {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain(key);
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
      return;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const responseAgent = endpoint === "agents" ? res.body : res.body.agent;
    const [child] = await db.select().from(agents).where(eq(agents.id, responseAgent.id));
    expect(child!.adapterConfig.piRpcThinkingLevel).toBe(level);
    expect(responseAgent.adapterConfig.piRpcThinkingLevel).toBe(level);
    expect(resolvePaperclipRunnerNativeProviderInput({
      backend: "pi_rpc", adapterConfig: child!.adapterConfig,
    })).toMatchObject({ provider: "pi_rpc", piRpcThinkingLevel: level });
  });

  it.each((["agents", "agent-hires"] as const).flatMap(endpoint => [
    { config: { piThinkingLevel: "high" }, expected: "high" },
    { config: { thinking: "low" }, expected: "low" },
    { config: { piRpcThinkingLevel: "auto", piThinkingLevel: "high" }, expected: "high" },
    { config: {}, expected: "medium" },
    { config: { extraArgs: ["--verbose"] }, expected: null },
    { config: { args: ["--verbose"] }, expected: null },
    { config: { command: "custom-pi" }, expected: null },
    { config: { stdoutLogMode: "full" }, expected: null },
    { config: { model: "unqualified" }, expected: null },
    { config: { piThinkingLevel: "unknown" }, expected: null },
    { config: { piRpcThinkingLevel: "low", thinking: "unknown" }, expected: null },
  ].map(row => ({ endpoint, ...row }))))("direct pi_rpc $endpoint validates and stores $config", async ({ endpoint, config, expected }) => {
    const companyId = await seedCompany();
    const res = await request(createApp(db, userActor())).post(`/api/companies/${companyId}/${endpoint}`).send({
      name: "Native Pi Child", role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", model: "paperclip/claude-opus-5-5", ...config },
    });
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(res.status, JSON.stringify(res.body)).toBe(expected === null ? 422 : 201);
    if (expected === null) {
      expect(rows).toHaveLength(0);
      return;
    }
    expect(rows).toHaveLength(1);
    const responseAgent = endpoint === "agents" ? res.body : res.body.agent;
    expect(rows[0]!.adapterConfig.piRpcThinkingLevel).toBe(expected);
    expect(responseAgent.adapterConfig.piRpcThinkingLevel).toBe(expected);
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "pi_rpc", adapterConfig: rows[0]!.adapterConfig }))
      .toMatchObject({ piRpcThinkingLevel: expected });
  });

  it.each(["agents", "agent-hires"])("pi_rpc %s refuses a masked invalid alias before persistence", async endpoint => {
    const companyId = await seedCompany();
    const res = await request(createApp(db, userActor())).post(`/api/companies/${companyId}/${endpoint}`).send({
      name: "Masked Pi Child", role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", piRpcThinkingLevel: "low", effort: "ultra" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("effort");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(0);
  });

  it("pi_rpc defaults absent and auto effort to medium in native projection", () => {
    expect(piRpcThinking({})).toBe("medium");
    expect(piRpcThinking({ effort: "auto" })).toBe("medium");
  });

  it.each((["agents", "agent-hires"] as const).flatMap(endpoint =>
    [undefined, null, "", " \t\n"].map(unset => ({ endpoint, unset })),
  ))("pi_rpc $endpoint persists defaults for unset $unset", async ({ endpoint, unset }) => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    await db.update(agents).set({ adapterConfig: {
      provider: "pi_rpc", model: "openai-codex/gpt-5.6", piRpcThinkingLevel: "xhigh",
    } }).where(eq(agents.id, parent.id));
    const actor = endpoint === "agents" ? userActor() : agentActor(companyId, parent.id);
    const res = await request(createApp(db, actor))
      .post(`/api/companies/${companyId}/${endpoint}`).send({
        name: "Pi Child", role: "engineer", adapterType: "paperclip_runner",
        adapterConfig: { provider: "pi_rpc", model: unset, piRpcThinkingLevel: unset },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const responseAgent = endpoint === "agents" ? res.body : res.body.agent;
    const [child] = await db.select().from(agents).where(eq(agents.id, responseAgent.id));
    const expected = { piRpcThinkingLevel: "medium", model: "paperclip/claude-opus-5-5" };
    expect(child!.adapterConfig).toMatchObject(expected);
    expect(responseAgent.adapterConfig).toMatchObject(expected);
  });

  it.each([undefined, null, "", " \t", "fable/gpt-6.1-sol"])("pi_rpc caller-runtime hire defaults model and level regardless of caller model %j", async callerModel => {
    const companyId = await seedCompany();
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    await db.update(agents).set({ adapterConfig: {
      provider: "pi_rpc", model: callerModel, piRpcThinkingLevel: "xhigh",
    } }).where(eq(agents.id, parent.id));
    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Pi Tool Child", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [child] = await db.select().from(agents).where(eq(agents.id, res.body.agent.id));
    const expected = { piRpcThinkingLevel: "medium", model: "paperclip/claude-opus-5-5" };
    expect(child!.adapterConfig).toMatchObject(expected);
    expect(res.body.agent.adapterConfig).toMatchObject(expected);
    expect(res.body.approval.payload.adapterConfig).toMatchObject(expected);
    expect(res.body.approval.payload.requestedConfigurationSnapshot.adapterConfig).toMatchObject(expected);
  });

  it("rejects native runtime inheritance for a board actor", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    const res = await hire(userActor(), companyId, {
      name: "Board Inheritance Attempt", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status).toBe(403);
    expect(parent.adapterType).toBe("paperclip_runner");
  });

  it("rejects inheritance from a legacy caller", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "codex_local", {});
    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Legacy Inheritance Attempt", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("paperclip_runner adapter");
  });

  it("rejects native runtime inheritance across companies", async () => {
    const parentCompanyId = await seedCompany();
    const targetCompanyId = await seedCompany();
    const parent = await seedParentAgent(parentCompanyId, "paperclip_runner", { provider: "codex", model: "gpt-5.6-sol" });
    const res = await hire(agentActor(targetCompanyId, parent.id), targetCompanyId, {
      name: "Cross Company Inheritance Attempt", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, targetCompanyId))).toHaveLength(0);
  });

  it("records only inherited safe settings in an approval snapshot", async () => {
    const companyId = await seedCompany();
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    await db.update(agents).set({ adapterConfig: {
      provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5", acpxPermissionMode: "approve-all",
      env: { PRIVATE_PARENT_TOKEN: secretRef("parent-secret") }, cwd: "/private/parent",
      invocationLimits: { maxIterations: 3, credentials: "never-copy" },
    } }).where(eq(agents.id, parent.id));
    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Approval Snapshot Child", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.status).toBe("pending_approval");
    expect(res.body.approval.payload.inheritRuntimeFrom).toBeUndefined();
    expect(res.body.approval.payload.adapterConfig).toMatchObject({ provider: "acpx", acpxAgent: "claude", acpxPermissionMode: "approve-all" });
    expect(res.body.approval.payload.adapterConfig.env).toBeUndefined();
    expect(res.body.approval.payload.adapterConfig.cwd).toBeUndefined();
    expect(res.body.approval.payload.adapterConfig.invocationLimits).toEqual({ maxIterations: 3 });
  });

  it.each([
    ["claude_managed", "managedProfileId", "managedAgentsRetentionAcknowledged", "Managed Agent"],
    ["aws_agentcore", "agentCoreProfileId", "agentCoreRetentionAcknowledged", "Remote Agent"],
  ])("revalidates the inherited %s company profile before creating a hire", async (provider, profileKey, retentionKey, label) => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    await db.update(agents).set({ adapterConfig: {
      provider, [profileKey]: randomUUID(), [retentionKey]: true,
    } }).where(eq(agents.id, parent.id));
    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Missing Profile Child", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe(`${label} profile not found`);
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
  });

  it.each([
    ["agent", "pi_local", undefined], ["agent", "codex_local", undefined],
    ["board", "codex_local", undefined], ["agent", "codex_local", null], ["agent", "codex_local", "explicit"],
  ] as const)("plain create environment: %s %s %s", async (actor, adapterType, selection) => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    const environmentId = randomUUID();
    const config = { provider: "daytona", image: `example/runner@sha256:${"a".repeat(64)}`, reuseLease: false };
    await db.insert(environments).values({ id: environmentId, name: "Creator sandbox", driver: "sandbox", config });
    const environment = (await environmentService(db).getById(environmentId))!;
    const runtime = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment, { applyCustomImageTemplate: true, readOnlyCustomImageTemplate: true });
    await db.update(environments).set({ metadata: { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { [companyId]: {
      v: 1, companyId, image: config.image, template: null, baseConfigFingerprint: fingerprintEnvironmentSandboxProviderConfig(config),
      runtimeConfigFingerprint: fingerprintEnvironmentSandboxProviderConfig(runtime.config as typeof config),
      facts: { platform: "linux", architecture: "x64", libc: "glibc", glibcVersion: "2.39" },
    } } } }).where(eq(environments.id, environmentId));
    await db.update(agents).set({ defaultEnvironmentId: environmentId, adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, parent.id));
    const explicitEnvironmentId = randomUUID();
    if (selection === "explicit") await db.insert(environments).values({ id: explicitEnvironmentId, name: "Explicit local", driver: "local" });
    const defaultEnvironmentId = selection === "explicit" ? explicitEnvironmentId : selection;
    const res = await request(createApp(db, actor === "agent" ? agentActor(companyId, parent.id) : userActor()))
      .post(`/api/companies/${companyId}/agents`).send({ name: "Plain child", adapterType,
        ...(adapterType === "pi_local" ? { adapterConfig: { model: "paperclip/claude-opus-5-5" } } : {}),
        ...(selection === undefined ? {} : { defaultEnvironmentId }) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [child] = await db.select().from(agents).where(eq(agents.id, res.body.id));
    const expectedEnvironmentId = actor === "agent" && selection === undefined ? environmentId : defaultEnvironmentId ?? null;
    expect(child!.defaultEnvironmentId).toBe(expectedEnvironmentId);
    expect(res.body.defaultEnvironmentId).toBe(expectedEnvironmentId);
    expect(child!.adapterType).toBe("paperclip_runner");
  });

  it("validates and preserves an inherited caller default environment", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "paperclip_runner", {});
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: `Local ${environmentId}`, driver: "local" });
    await db.update(agents).set({ defaultEnvironmentId: environmentId }).where(eq(agents.id, parent.id));
    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Invalid Environment Child", role: "engineer", adapterType: "paperclip_runner", inheritRuntimeFrom: "caller",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.defaultEnvironmentId).toBe(environmentId);
  });

  it("inherits the fixed Claude OAuth binding, keeps its version, and leaks no token value", async () => {
    const companyId = await seedCompany();
    const parent = await seedParentAgent(companyId, "claude_local", {
      CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_CLAUDE_OAUTH_BINDING, version: 3 },
    });

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "Claude OAuth Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childAgentId = res.body.agent.id as string;
    expect(childEnvOf(res).CLAUDE_CODE_OAUTH_TOKEN).toMatchObject({
      type: "user_secret_ref",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      version: 3,
    });
    // The response body carries the reference only, never a token value.
    expect(JSON.stringify(res.body).replaceAll(process.env.PAPERCLIP_HOME!, "<home>")).not.toContain("sk-");

    const declarations = await db
      .select()
      .from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.targetId, childAgentId));
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({
      envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      configPath: "env.CLAUDE_CODE_OAUTH_TOKEN",
      versionSelector: "3",
    });

    const hireActivity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "agent.hire_created")));
    expect(hireActivity).toHaveLength(1);
    const detailsText = JSON.stringify(hireActivity[0]!.details);
    expect(detailsText).not.toContain("adapterConfig");
    expect(detailsText).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
