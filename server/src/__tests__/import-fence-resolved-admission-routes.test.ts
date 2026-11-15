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
  runtime?: Record<string, unknown>;
  budgetMonthlyCents?: number;
  permissionGrants?: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>;
};

// Real routers and writers: no service, authorization, normalization, lifecycle,
// or transaction mocks. Every case has an isolated company in the fixture DB.
describePg("RFL importfence8 FIX 1 security regressions", () => {
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
        role: "engineer", adapter: { type: a.adapterType ?? "codex_local",
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


  it("RED1 refuses resolved legacy runner env exactly like hire/create with no writes", async () => {
    const { companyId, actor } = await seed();
    const adapterConfig = { ...runnerHire.adapterConfig, env: { HOME: "/tmp/judge-home", PATH: "/usr/bin", TZ: "UTC" } };
    const input = bundle(companyId, [{ slug: "legacy-env", adapterType: "paperclip_runner", config: adapterConfig }]);
    input.source.files[".paperclip.yaml"] = input.source.files[".paperclip.yaml"].replace("runner: paperclip", "runner: legacy");
    const before = await snapshot(companyId);
    const instance = app(actor);
    const imported = await request(instance).post(`/api/companies/${companyId}/imports/apply`).send(input);
    const hired = await request(instance).post(`/api/companies/${companyId}/agent-hires`).send({ ...runnerHire, runner: "legacy", name: "legacy-hire", role: "engineer", adapterConfig });
    const created = await request(instance).post(`/api/companies/${companyId}/agents`).send({ ...runnerHire, runner: "legacy", name: "legacy-create", role: "engineer", adapterConfig });
    const after = await snapshot(companyId);
    console.log(JSON.stringify({ row: "RED1", importStatus: imported.status, importError: imported.body.error,
      hireStatus: hired.status, hireError: hired.body.error, createStatus: created.status, createError: created.body.error, before, after }));
    expect.soft([imported.status, hired.status, created.status]).toEqual([403, 403, 403]);
    expect.soft(imported.body.error).toBe(hired.body.error);
    expect.soft(created.body.error).toBe(hired.body.error);
    expect.soft(hired.body.error).toBe("Agent keys cannot configure host-executed local adapter settings (env).");
    expect.soft(after).toEqual(before);
  });
  it("refuses runner environment on an unmanaged imported root without writes", async () => {
    const { companyId, actor } = await seed();
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`).send(bundle(companyId, [
      { slug: "unmanaged-root", adapterType: "paperclip_runner", config: { ...runnerHire.adapterConfig, env: { TZ: "UTC" } } },
    ]));
    console.log(JSON.stringify({ row: "report-authority", status: response.status, error: response.body.error, before, after: await snapshot(companyId) }));
    expect.soft(response.status).toBe(403);
    expect.soft(response.body.error).toBe("Agent keys cannot configure host-executed local adapter settings (env).");
    expect.soft(await snapshot(companyId)).toEqual(before);
  });
});
