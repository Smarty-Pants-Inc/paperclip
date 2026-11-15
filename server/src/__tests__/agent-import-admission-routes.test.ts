import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  activityLog, agents, approvals, budgetPolicies, companies, companySecrets,
  createDb, principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { teamsCatalogRoutes } from "../routes/teams-catalog.js";
import { listCatalogTeams } from "../services/teams-catalog.js";
import { secretService } from "../services/secrets.js";

// The non-local hire fixture from agent-report-runtime-autonomy.test.ts:257-260.
// Keep runner selection explicit: "legacy" would convert this back to pi_local
// and measure the local host guard instead of the runner-backed hire policy.
const runnerHire = {
  adapterType: "paperclip_runner",
  runner: "paperclip",
  adapterConfig: { provider: "pi_rpc", model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "high" },
} as const;

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Embedded PostgreSQL unavailable: ${support.reason}`);
type Db = ReturnType<typeof createDb>;
type Proposed = {
  slug: string;
  config?: Record<string, unknown>;
  adapterType?: string;
  reportsToExistingAgentId?: string;
  runtime?: Record<string, unknown>;
  budgetMonthlyCents?: number;
  permissionGrants?: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>;
};

// Real routers and writers: no service, authorization, normalization, lifecycle,
// or transaction mocks. Every case has an isolated company in the fixture DB.
describePg("agent-actor import admission fence", () => {
  let db: Db;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-import-admission-");
    db = createDb(fixture.connectionString);
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  async function seed(approvalRequired = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Import ${companyId}`,
      issuePrefix: `F${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: approvalRequired });
    const [ceo] = await db.insert(agents).values({ companyId, name: "CEO", role: "ceo",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: { canCreateAgents: true } }).returning();
    const actor: Express.Request["actor"] = { type: "agent", agentId: ceo!.id, companyId,
      source: "agent_key", keyId: randomUUID() };
    return { companyId, ceo: ceo!, actor };
  }
  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api/companies", companyRoutes(db));
    instance.use("/api", agentRoutes(db));
    instance.use("/api", teamsCatalogRoutes(db));
    instance.use(errorHandler);
    return instance;
  }
  function bundle(companyId: string, proposed: Proposed[]) {
    const files: Record<string, string> = {
      "COMPANY.md": `---\nname: Imported\nincludes:\n${proposed.map(a => `  - agents/${a.slug}/AGENTS.md`).join("\n")}\n---\n`,
      ".paperclip.yaml": stringify({ schema: "paperclip/v1", agents: Object.fromEntries(proposed.map(a => [a.slug, {
        role: "engineer", reportsToExistingAgentId: a.reportsToExistingAgentId,
        adapter: { type: a.adapterType ?? "codex_local",
          runner: a.adapterType === runnerHire.adapterType ? runnerHire.runner : "legacy", config: a.config ?? {} },
        runtime: a.runtime ?? {}, budgetMonthlyCents: a.budgetMonthlyCents ?? 0,
        permissionGrants: a.permissionGrants ?? [],
      }])) }),
    };
    for (const agent of proposed) files[`agents/${agent.slug}/AGENTS.md`] = `---\nname: ${agent.slug}\nslug: ${agent.slug}\nkind: agent\n---\n\nImported agent.\n`;
    return { source: { type: "inline", files }, include: { company: false, agents: true, projects: false, issues: false, skills: false },
      target: { mode: "existing_company", companyId }, agents: "all", collisionStrategy: "rename" };
  }
  async function snapshot(companyId: string) {
    const [agentRows, grants, approvalRows, budgets, secrets] = await Promise.all([
      db.select().from(agents).where(eq(agents.companyId, companyId)),
      db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId)),
      db.select().from(approvals).where(eq(approvals.companyId, companyId)),
      db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId)),
      db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId)),
    ]);
    return { agents: agentRows.map(a => a.id).sort(), grants: grants.map(g => g.id).sort(),
      approvals: approvalRows.map(a => a.id).sort(), budgets: budgets.map(b => b.id).sort(), secrets: secrets.map(s => s.id).sort() };
  }
  async function refused(row: string, proposed: Proposed[]) {
    const { companyId, actor } = await seed();
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`).send(bundle(companyId, proposed));
    const after = await snapshot(companyId);
    console.log(JSON.stringify({ row, status: response.status, error: response.body.error, before, after,
      proposedAdapterType: proposed[0]?.adapterType ?? "codex_local" }));
    expect.soft([403, 422], JSON.stringify(response.body)).toContain(response.status);
    expect.soft(after).toEqual(before);
    return { companyId, actor, response, after };
  }

  it.each(["command", "args", "cwd"])("R1 refuses submitted local host %s without writes", async key => {
    await refused(`R1:${key}`, [{ slug: "local-host", config: { [key]: key === "args" ? ["--untrusted"] : "/tmp/untrusted" } }]);
  });
  // RFL 18:06Z: exactly the live report-env rule. Plain credentials are not
  // classified or refused; secret references require the ACTOR's own access.
  it.each([
    ["R2 credential string", { env: { OPENAI_API_KEY: "sk-synthetic-fixture" } }, true],
    ["R2 credential plain binding", { env: { OPENAI_API_KEY: { type: "plain", value: "sk-synthetic-fixture" } } }, true],
    ["R2b TZ string", { env: { TZ: "UTC" } }, true],
    ["R2b TZ plain binding", { env: { TZ: { type: "plain", value: "UTC" } } }, true],
    ["R2b accessible secret_ref", {}, true],
    ["R2b inaccessible secret_ref", {}, false],
    ["R2b command", { command: "/tmp/untrusted" }, false],
    ["R2b args", { args: ["--untrusted"] }, false],
    ["R2b cwd", { cwd: "/tmp/untrusted" }, false],
  ] as const)("%s: import/hire/create share admission", async (label, suppliedConfig, allowed) => {
    const { companyId, actor } = await seed();
    let adapterConfig: Record<string, unknown> = { ...runnerHire.adapterConfig, ...suppliedConfig };
    let expectedError: string | undefined;
    if (label.endsWith("secret_ref")) {
      const secrets = secretService(db);
      const secret = await secrets.create(companyId, { name: "import-fence-fixture", provider: "local_encrypted",
        value: "sk-synthetic-fixture-not-a-real-credential" });
      if (allowed) await secrets.createBinding({ companyId, secretId: secret.id, targetType: "agent", targetId: actor.agentId!,
        configPath: "env.OPENAI_API_KEY" });
      adapterConfig = { ...adapterConfig, env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } } };
      if (!allowed) expectedError = `Caller cannot resolve secret ${secret.id} for a report's environment`;
    } else if (!allowed) {
      expectedError = `Agent keys cannot configure host-executed local adapter settings (${label.split(" ").at(-1)}).`;
    }
    // RFL importfence8 FIX 1: positive import env rows are now real reports
    // with the same explicit configure + runtime grants as live report PATCH.
    // No assertion/status is relaxed; the unprivileged/root controls live in
    // import-fence-resolved-admission-routes.test.ts.
    if (allowed) await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: actor.agentId!, permissionKey: "agents:configure", scope: { subtreeRootAgentId: actor.agentId! } },
      { companyId, principalType: "agent", principalId: actor.agentId!, permissionKey: "agents:configure-reports-runtime", scope: null },
    ]);
    const instance = app(actor);
    const beforeImport = await snapshot(companyId);
    const imported = await request(instance).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, [{ slug: "env-import", adapterType: runnerHire.adapterType, config: adapterConfig,
        reportsToExistingAgentId: allowed ? actor.agentId : undefined }]));
    const afterImport = await snapshot(companyId);
    const hired = await request(instance).post(`/api/companies/${companyId}/agent-hires`).send({
      ...runnerHire, name: "env-hire", role: "engineer", adapterConfig,
    });
    const afterHire = await snapshot(companyId);
    const created = await request(instance).post(`/api/companies/${companyId}/agents`).send({
      ...runnerHire, name: "env-create", role: "engineer", adapterConfig,
    });
    const afterCreate = await snapshot(companyId);
    console.log(JSON.stringify({ row: label, importStatus: imported.status, hireStatus: hired.status, createStatus: created.status,
      importError: imported.body.error, hireError: hired.body.error, createError: created.body.error,
      expectedAllowed: allowed, expectedError,
      importedAdapterType: (await db.select().from(agents).where(eq(agents.companyId, companyId)))
        .find(a => a.name === "env-import")?.adapterType,
      beforeImport, afterImport, afterHire, afterCreate }));
    // Existing transport contracts are 200 for import and 201 for creation.
    // Exact status AND exact error pairs, not merely a loose 2xx/4xx check.
    expect.soft([imported.status, hired.status, created.status]).toEqual(allowed ? [200, 201, 201] : [403, 403, 403]);
    expect.soft([imported.body.error, hired.body.error, created.body.error]).toEqual([expectedError, expectedError, expectedError]);
    if (!allowed) {
      expect.soft(afterImport).toEqual(beforeImport);
      expect.soft(afterHire).toEqual(beforeImport);
      expect.soft(afterCreate).toEqual(beforeImport);
    } else {
      expect.soft(afterImport.agents.length).toBe(beforeImport.agents.length + 1);
      expect.soft(afterHire.agents.length).toBe(afterImport.agents.length + 1);
      expect.soft(afterCreate.agents.length).toBe(afterHire.agents.length + 1);
    }
  });

  it("R3 refuses an escalating package grant with a clear 422", async () => {
    const { companyId, actor } = await seed();
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`).send(bundle(companyId, [{
      slug: "grant-escalation", permissionGrants: [{ permissionKey: "agents:configure", scope: null }],
    }]));
    console.log(JSON.stringify({ row: "R3", status: response.status, error: response.body.error }));
    expect.soft(response.status, JSON.stringify(response.body)).toBe(422);
    expect.soft(response.body.error ?? "").toContain("agents:configure");
    expect.soft(await snapshot(companyId)).toEqual(before);
  });
  it("R3b reports each stripped unknown grant and its reason in the result and activity", async () => {
    const { companyId, actor } = await seed();
    const unknown = "unknown:import-fence";
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`).send(bundle(companyId, [{
      slug: "unknown-grant", permissionGrants: [{ permissionKey: unknown, scope: null }],
    }]));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const grants = await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    expect(grants.some(g => g.permissionKey === unknown)).toBe(false);
    const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const resultText = JSON.stringify(response.body);
    const logText = JSON.stringify(logs);
    console.log(JSON.stringify({ row: "R3b", status: response.status, resultHasRemovedGrant: resultText.includes(unknown),
      activityHasRemovedGrant: logText.includes(unknown) }));
    expect.soft(resultText).toContain(unknown);
    expect.soft(resultText).toMatch(/unknown.*permission|unknown.*grant|unrecognized.*grant/i);
    expect.soft(logText).toContain(unknown);
    expect.soft(logText).toMatch(/unknown.*permission|unknown.*grant|unrecognized.*grant/i);
  });
  it("R4 refuses a positive starting budget with approvals off", async () => {
    await refused("R4", [{ slug: "budget", budgetMonthlyCents: 100 }]);
  });
  it("R4b requires a real pending hire_agent approval, never an idle or paused bypass", async () => {
    const { companyId, actor } = await seed(true);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, [{ slug: "approval", budgetMonthlyCents: 100 }]));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const child = rows.find(a => a.name === "approval");
    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    console.log(JSON.stringify({ row: "R4b", status: response.status, childStatus: child?.status,
      approvals: approvalRows.map(a => ({ type: a.type, status: a.status, payload: a.payload })) }));
    expect.soft(child?.status).toBe("pending_approval");
    expect.soft(approvalRows).toEqual([expect.objectContaining({ type: "hire_agent", status: "pending",
      requestedByAgentId: actor.agentId, payload: expect.objectContaining({ agentId: child?.id, budgetMonthlyCents: 100 }) })]);
  });
  it("R5 rolls back the whole two-agent bundle when its second agent is invalid", async () => {
    // Preview sorts by slug: keep the invalid agent second in actual execution.
    await refused("R5", [{ slug: "a-valid-first" }, { slug: "z-invalid-second", config: { command: "/tmp/untrusted" } }]);
  });
  it("R6 preserves the agent actor through the real catalog install route", async () => {
    const { companyId, actor } = await seed();
    const catalog = await listCatalogTeams({ kind: "bundled" });
    const team = catalog.find(t => t.compatibility === "compatible" && t.trustLevel === "markdown_only" && t.agentSlugs.length > 0);
    expect(team, "a shipped compatible markdown-only catalog team is required").toBeDefined();
    const slug = team!.agentSlugs[0]!;
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/teams/catalog/${encodeURIComponent(team!.id)}/install`).send({
      include: { agents: true, projects: false, issues: false, skills: false }, agents: [slug],
      adapterOverrides: { [slug]: { adapterType: "codex_local", runner: "legacy", adapterConfig: { command: "/tmp/untrusted" } } },
    });
    console.log(JSON.stringify({ row: "R6", catalogId: team!.id, slug, status: response.status, error: response.body.error }));
    expect.soft([403, 422], JSON.stringify(response.body)).toContain(response.status);
    expect.soft(await snapshot(companyId)).toEqual(before);
  });

  it.each(["safe", "full"])("GUARD board %s import remains permitted", async mode => {
    const { companyId } = await seed();
    const board: Express.Request["actor"] = { type: "board", userId: "local-board", source: "local_implicit" };
    const response = await request(app(board)).post(mode === "safe" ? `/api/companies/${companyId}/imports/apply` : "/api/companies/import")
      .send(bundle(companyId, [{ slug: "board-local", config: { command: "/tmp/board-command" }, budgetMonthlyCents: 100,
        runtime: { heartbeat: { maxDailyCostCents: 0 } } }]));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows.some(a => a.name === "board-local" && a.budgetMonthlyCents === 100)).toBe(true);
  });
  it.each(["process", "http"])("GUARD safe import still refuses %s", async adapterType => {
    const { companyId, actor } = await seed();
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, [{ slug: "unsafe-adapter", adapterType }]));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await snapshot(companyId)).toEqual(before);
  });
  it("GUARD N's zero daily cap still reaches its shared 422 from an agent import", async () => {
    const { companyId, actor } = await seed();
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, [{ slug: "daily-zero", runtime: { heartbeat: { maxDailyCostCents: 0 } } }]));
    console.log(JSON.stringify({ row: "GUARD:daily-zero", status: response.status, error: response.body.error }));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toMatch(/daily|maxDailyCostCents/i);
    expect(await snapshot(companyId)).toEqual(before);
  });
});
