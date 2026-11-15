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

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Embedded PostgreSQL unavailable: ${support.reason}`);
type Db = ReturnType<typeof createDb>;
type Proposed = {
  slug: string;
  config?: Record<string, unknown>;
  adapterType?: string;
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
        role: "engineer", adapter: { type: a.adapterType ?? "codex_local", runner: "legacy", config: a.config ?? {} },
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
    console.log(JSON.stringify({ row, status: response.status, error: response.body.error, before, after }));
    expect.soft([403, 422], JSON.stringify(response.body)).toContain(response.status);
    expect.soft(after).toEqual(before);
  }

  it.each(["command", "args", "cwd"])("R1 refuses submitted local host %s without writes", async key => {
    await refused(`R1:${key}`, [{ slug: "local-host", config: { [key]: key === "args" ? ["--untrusted"] : "/tmp/untrusted" } }]);
  });
  it.each(["string", "plain"])("R2 refuses a %s credential without writes", async shape => {
    const value = "sk-synthetic-fixture-not-a-real-credential";
    await refused(`R2:${shape}`, [{ slug: "credential", config: { env: { OPENAI_API_KEY: shape === "plain" ? { type: "plain", value } : value } } }]);
  });

  it.each([
    ["TZ string", { TZ: "UTC" }, true],
    ["TZ plain binding", { TZ: { type: "plain", value: "UTC" } }, true],
    ["credential string", { OPENAI_API_KEY: "sk-synthetic-fixture" }, false],
    ["credential plain binding", { OPENAI_API_KEY: { type: "plain", value: "sk-synthetic-fixture" } }, false],
  ] as const)("R2b import and hire have the same env answer: %s", async (label, env, allowed) => {
    const { companyId, actor } = await seed();
    const instance = app(actor);
    const imported = await request(instance).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, [{ slug: "env-import", config: { env } }]));
    const hired = await request(instance).post(`/api/companies/${companyId}/agent-hires`).send({
      name: "env-hire", role: "engineer", adapterType: "codex_local", runner: "legacy", adapterConfig: { env },
    });
    const importAllowed = imported.status >= 200 && imported.status < 300;
    const hireAllowed = hired.status >= 200 && hired.status < 300;
    console.log(JSON.stringify({ row: `R2b:${label}`, importStatus: imported.status, hireStatus: hired.status,
      importError: imported.body.error, hireError: hired.body.error, importAllowed, hireAllowed, expectedAllowed: allowed }));
    expect.soft(importAllowed, JSON.stringify(imported.body)).toBe(allowed);
    expect.soft(hireAllowed, JSON.stringify(hired.body)).toBe(allowed);
    expect.soft(importAllowed).toBe(hireAllowed);
  });

  it("R3 refuses an escalating package grant with a clear 422", async () => {
    const { companyId, actor } = await seed();
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`).send(bundle(companyId, [{
      slug: "grant-escalation", permissionGrants: [{ permissionKey: "agents:configure", scope: null }],
    }]));
    console.log(JSON.stringify({ row: "R3", status: response.status, error: response.body.error }));
    expect.soft(response.status, JSON.stringify(response.body)).toBe(422);
    expect.soft(response.body.error ?? "").toMatch(/grant|delegat|permission/i);
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
