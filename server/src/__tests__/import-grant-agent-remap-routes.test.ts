import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  activityLog, agents, approvals, budgetPolicies, companies, companyMemberships, companySecrets,
  createDb, principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Embedded PostgreSQL unavailable: ${support.reason}`);
type Db = ReturnType<typeof createDb>;
type Scope = Record<string, unknown>;
const permissionKey = "tasks:assign_scope";
const board: Express.Request["actor"] = { type: "board", userId: "local-board", source: "local_implicit" };
const scopeForms: Array<[string, (id: string) => Scope]> = [
  ["subtreeRootAgentId", id => ({ subtreeRootAgentId: id })],
  ["agentIds", id => ({ agentIds: [id] })],
  ["allow", id => ({ allow: [`subtree:${id}`, `agent:${id}`] })],
  ...["agentId", "assigneeAgentId", "targetAgentId", "managerAgentId", "managedSubtreeAgentId", "subtreeAgentId"]
    .flatMap((key): Array<[string, (id: string) => Scope]> => [
      [key, id => ({ [key]: id })], [key + "s", id => ({ [key + "s"]: [id] })],
    ]),
  ["subtreeRootAgentIds", id => ({ subtreeRootAgentIds: [id] })],
];

// Same real-router / real-writer embedded-PG harness as the import admission fence.
// No authorization, service, lifecycle, transaction, or persistence mocks.
describePg("row 39 imported permission scope agent IDs", () => {
  let db: Db;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-import-grant-remap-");
    db = createDb(fixture.connectionString);
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Import ${companyId}`,
      issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false });
    const [ceo] = await db.insert(agents).values({ companyId, name: "CEO", role: "ceo",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: { canCreateAgents: true } }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: ceo!.id,
      membershipRole: "member", status: "active" });
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: ceo!.id, permissionKey: "agents:configure", scope: { subtreeRootAgentId: ceo!.id } },
      { companyId, principalType: "agent", principalId: ceo!.id, permissionKey, scope: { subtreeRootAgentId: ceo!.id } },
    ]);
    const actor: Express.Request["actor"] = { type: "agent", agentId: ceo!.id, companyId,
      source: "agent_key", keyId: randomUUID() };
    return { companyId, ceo: ceo!, actor };
  }
  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api/companies", companyRoutes(db));
    instance.use(errorHandler);
    return instance;
  }
  function bundle(companyId: string, managerId: string, sourceId: string, scope: Scope) {
    const slugs = ["a-grantee", "z-scope-root"];
    const files: Record<string, string> = {
      "COMPANY.md": `---\nname: Imported\nincludes:\n${slugs.map(slug => `  - agents/${slug}/AGENTS.md`).join("\n")}\n---\n`,
      ".paperclip.yaml": stringify({ schema: "paperclip/v1", agents: Object.fromEntries(slugs.map(slug => [slug, {
        sourceAgentId: slug === "z-scope-root" ? sourceId : randomUUID(), role: "engineer",
        reportsToExistingAgentId: managerId,
        adapter: { type: "codex_local", runner: "legacy", config: {} },
        permissionGrants: slug === "a-grantee" ? [{ permissionKey, scope }] : [],
      }])) }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }),
    };
    for (const slug of slugs) files[`agents/${slug}/AGENTS.md`] = `---\nname: ${slug}\nslug: ${slug}\nkind: agent\n---\n\nImported agent.\n`;
    return { source: { type: "inline", files }, include: { company: false, agents: true, projects: false, issues: false, skills: false },
      target: { mode: "existing_company", companyId }, agents: "all", collisionStrategy: "rename" };
  }
  async function snapshot(companyId: string) {
    const tables = { agents, grants: principalPermissionGrants, approvals, budgets: budgetPolicies,
      secrets: companySecrets, memberships: companyMemberships, activity: activityLog };
    return Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([key, table]) => [key,
      (await db.select({ id: table.id }).from(table).where(eq(table.companyId, companyId))).map(row => row.id).sort(),
    ])));
  }
  async function grantFor(companyId: string, principalId: string) {
    return (await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId)))
      .find(grant => grant.principalId === principalId && grant.permissionKey === permissionKey);
  }

  it.each(scopeForms)("remaps packaged %s after all destination agents exist", async (label, scopeFor) => {
    const { companyId, ceo } = await seed();
    const sourceId = randomUUID();
    const response = await request(app(board)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, ceo.id, sourceId, scopeFor(sourceId)));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const imported = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const root = imported.find(agent => agent.name === "z-scope-root")!;
    const grantee = imported.find(agent => agent.name === "a-grantee")!;
    const grant = await grantFor(companyId, grantee.id);
    console.log(JSON.stringify({ row: `remap:${label}`, sourceId, destinationId: root.id, scope: grant?.scope }));
    expect(root.id).not.toBe(sourceId);
    expect(grant?.scope).toEqual(scopeFor(root.id));
  });

  it("remaps a packaged subtree before enforcing the agent actor delegation bound", async () => {
    const { companyId, ceo, actor } = await seed();
    const sourceId = randomUUID();
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, ceo.id, sourceId, { subtreeRootAgentId: sourceId }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const imported = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const root = imported.find(agent => agent.name === "z-scope-root")!;
    const grantee = imported.find(agent => agent.name === "a-grantee")!;
    expect((await grantFor(companyId, grantee.id))?.scope).toEqual({ subtreeRootAgentId: root.id });
  });

  it.each(["board", "agent"])("refuses an unknown scope agent for %s with a named 422 and no residue", async actorType => {
    const { companyId, ceo, actor } = await seed();
    const unknownId = randomUUID();
    const before = await snapshot(companyId);
    const response = await request(app(actorType === "board" ? board : actor)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, ceo.id, randomUUID(), { subtreeRootAgentId: unknownId }));
    const after = await snapshot(companyId);
    console.log(JSON.stringify({ row: `unknown:${actorType}`, unknownId, status: response.status,
      error: response.body.error, before, after }));
    expect.soft(response.status, JSON.stringify(response.body)).toBe(422);
    expect.soft(response.body.error ?? "").toContain(permissionKey);
    expect.soft(response.body.error ?? "").toContain(unknownId);
    expect.soft(after).toEqual(before);
  });

  it.each(scopeForms)("refuses unknown %s references before any board writes", async (_label, scopeFor) => {
    const { companyId, ceo } = await seed();
    const unknownId = randomUUID();
    const before = await snapshot(companyId);
    const response = await request(app(board)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, ceo.id, randomUUID(), scopeFor(unknownId)));
    expect.soft(response.status, JSON.stringify(response.body)).toBe(422);
    expect.soft(response.body.error ?? "").toContain(permissionKey);
    expect.soft(response.body.error ?? "").toContain(unknownId);
    expect.soft(await snapshot(companyId)).toEqual(before);
  });

  it("does not treat a real agent from another company as a valid target-company reference", async () => {
    const foreign = await seed();
    const { companyId, ceo } = await seed();
    const before = await snapshot(companyId);
    const response = await request(app(board)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, ceo.id, randomUUID(), { agentIds: [foreign.ceo.id] }));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toContain(foreign.ceo.id);
    expect(await snapshot(companyId)).toEqual(before);
  });

  it("prioritizes the package mapping when a source ID also exists at the destination", async () => {
    const { companyId, ceo } = await seed();
    const response = await request(app(board)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, ceo.id, ceo.id, { subtreeRootAgentId: ceo.id }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const imported = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const root = imported.find(agent => agent.name === "z-scope-root")!;
    const grantee = imported.find(agent => agent.name === "a-grantee")!;
    expect((await grantFor(companyId, grantee.id))?.scope).toEqual({ subtreeRootAgentId: root.id });
    expect(root.id).not.toBe(ceo.id);
  });

  it("refuses a reference to an unselected package agent without residue", async () => {
    const { companyId, ceo } = await seed();
    const sourceId = randomUUID();
    const input = { ...bundle(companyId, ceo.id, sourceId, { subtreeRootAgentId: sourceId }), agents: ["a-grantee"] };
    const before = await snapshot(companyId);
    const response = await request(app(board)).post(`/api/companies/${companyId}/imports/apply`).send(input);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toContain(sourceId);
    expect(await snapshot(companyId)).toEqual(before);
  });

  it("does not create a new company when a grant references an unknown agent", async () => {
    const { companyId, ceo } = await seed();
    const unknownId = randomUUID();
    const before = (await db.select({ id: companies.id }).from(companies)).map(company => company.id).sort();
    const input = { ...bundle(companyId, ceo.id, randomUUID(), { subtreeRootAgentId: unknownId }),
      target: { mode: "new_company", newCompanyName: "Must not persist" } };
    const response = await request(app(board)).post("/api/companies/import").send(input);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toContain(unknownId);
    expect((await db.select({ id: companies.id }).from(companies)).map(company => company.id).sort()).toEqual(before);
  });

  it.each([true, false])("keeps a target-company ID only within the actor's delegation bound: %s", async allowed => {
    const { companyId, ceo, actor } = await seed();
    const [existing] = await db.insert(agents).values({ companyId, name: "Existing scope root", role: "engineer",
      reportsTo: allowed ? ceo.id : null, adapterType: "codex_local", adapterConfig: {} }).returning();
    const before = await snapshot(companyId);
    const response = await request(app(actor)).post(`/api/companies/${companyId}/imports/apply`)
      .send(bundle(companyId, ceo.id, randomUUID(), { subtreeRootAgentId: existing!.id }));
    expect(response.status, JSON.stringify(response.body)).toBe(allowed ? 200 : 422);
    if (allowed) {
      const grantee = (await db.select().from(agents).where(eq(agents.companyId, companyId))).find(agent => agent.name === "a-grantee")!;
      expect((await grantFor(companyId, grantee.id))?.scope).toEqual({ subtreeRootAgentId: existing!.id });
    } else {
      expect(response.body.error).toContain(permissionKey);
      expect(await snapshot(companyId)).toEqual(before);
    }
  });

  it("remaps scopes from an actual exported company package, never retaining the source company ID", async () => {
    const source = await seed();
    const [sourceRoot, sourceGrantee] = await db.insert(agents).values([
      { companyId: source.companyId, name: "Source root", role: "engineer", adapterType: "codex_local", adapterConfig: {} },
      { companyId: source.companyId, name: "Source grantee", role: "engineer", adapterType: "codex_local", adapterConfig: {} },
    ]).returning();
    await db.insert(principalPermissionGrants).values({ companyId: source.companyId, principalType: "agent",
      principalId: sourceGrantee!.id, permissionKey, scope: { subtreeRootAgentId: sourceRoot!.id,
        agentIds: [sourceRoot!.id], allow: [`subtree:${sourceRoot!.id}`, `agent:${sourceRoot!.id}`] } });
    const exported = await request(app(board)).post(`/api/companies/${source.companyId}/exports`).send({
      include: { company: false, agents: true, projects: false, issues: false, skills: false },
      agents: [sourceRoot!.id, sourceGrantee!.id],
    });
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const target = await seed();
    const response = await request(app(board)).post(`/api/companies/${target.companyId}/imports/apply`).send({
      source: { type: "inline", files: exported.body.files }, include: exported.body.manifest.includes,
      target: { mode: "existing_company", companyId: target.companyId }, agents: "all", collisionStrategy: "rename",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const imported = await db.select().from(agents).where(eq(agents.companyId, target.companyId));
    const root = imported.find(agent => agent.name === "Source root")!;
    const grantee = imported.find(agent => agent.name === "Source grantee")!;
    const grant = await grantFor(target.companyId, grantee.id);
    console.log(JSON.stringify({ row: "export-import", sourceCompanyId: source.companyId, targetCompanyId: target.companyId,
      sourceId: sourceRoot!.id, destinationId: root.id, scope: grant?.scope }));
    expect(grant?.scope).toEqual({ subtreeRootAgentId: root.id,
      agentIds: [root.id], allow: [`subtree:${root.id}`, `agent:${root.id}`] });
    expect(root.id).not.toBe(sourceRoot!.id);
  });
});
