import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentApiKeys, agents, approvals, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, userCompanyPreferences } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { CREATE_COMPANY_IRREVERSIBLE_NOTICE } from "../services/company-creation-approval.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// #21271 rows C1-C5: the real approval routes, a real agent key for the request
// and board identities for the decision; the effect is the real company creation.
describe("create_company approval card (#21271)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("create-company-approval-21271-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), ownerId = randomUUID(), otherUserId = randomUUID(), adminId = randomUUID();
    const ids = { primary: randomUUID(), ceo: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Home org", issuePrefix: `H${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false });
    for (const id of [ownerId, otherUserId, adminId]) {
      await db.insert(authUsers).values({ id, name: id.slice(0, 6), email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    }
    // The CEO (reportsTo null) is not the owner's selected primary; that does not qualify it.
    await db.insert(agents).values([
      { id: ids.ceo, companyId, name: "CEO", role: "ceo", reportsTo: null, adapterType: "process", status: "idle",
        runtimeConfig: { heartbeat: { enabled: false } } },
      { id: ids.primary, companyId, name: "Smarty", reportsTo: ids.ceo, adapterType: "process", status: "idle",
        runtimeConfig: { heartbeat: { enabled: false } } },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerId, membershipRole: "owner", status: "active" },
      { companyId, principalType: "user", principalId: otherUserId, membershipRole: "owner", status: "active" },
      ...Object.values(ids).map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(userCompanyPreferences).values({ companyId, userId: ownerId, primaryAgentId: ids.primary, primaryAgentInitialized: true });
    const tokens: Record<string, string> = {};
    for (const [name, agentId] of Object.entries(ids)) {
      tokens[name] = randomUUID();
      await db.insert(agentApiKeys).values({ companyId, agentId, name, responsibleUserId: ownerId,
        keyHash: createHash("sha256").update(tokens[name]!).digest("hex") });
    }
    const api = express();
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", approvalRoutes(db));
    api.use(errorHandler);
    const boardApp = (actor: Express.Request["actor"]) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", approvalRoutes(db));
      app.use(errorHandler);
      return app;
    };
    const admin = boardApp({ type: "board", source: "session", userId: adminId, companyIds: [companyId], isInstanceAdmin: true });
    const operator = boardApp({ type: "board", source: "session", userId: otherUserId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false });
    const name = `Launch Labs ${companyId.slice(0, 6)}`;
    const ask = (agent: keyof typeof ids, payload: Record<string, unknown> = {}) => request(api)
      .post(`/api/companies/${companyId}/approvals`).set("Authorization", `Bearer ${tokens[agent]}`)
      .send({ type: "create_company", payload: { name, description: "Research and marketing", ownerUserId: ownerId,
        budgetMonthlyCents: 5000, ...payload } });
    const cards = () => db.select().from(approvals).where(and(eq(approvals.companyId, companyId), eq(approvals.type, "create_company")));
    const created = (orgName = name) => db.select().from(companies).where(eq(companies.name, orgName));
    return { companyId, ownerId, otherUserId, ids, admin, operator, ask, cards, created, name };
  }

  it("C1: the primary's request makes ONE pending card; the same request again returns that card", async () => {
    const f = await seed();
    const first = await f.ask("primary");
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({ type: "create_company", status: "pending", requestedByAgentId: f.ids.primary,
      payload: { name: f.name, description: "Research and marketing", ownerUserId: f.ownerId, budgetMonthlyCents: 5000,
        irreversibleNotice: CREATE_COMPANY_IRREVERSIBLE_NOTICE } });
    expect(first.body.payload.irreversibleNotice).toContain("can't be deleted on hq");
    const again = await f.ask("primary");
    expect(again.status, again.text).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const spaced = await f.ask("primary", { name: `  ${f.name.toUpperCase()}  ` });
    expect(spaced.body.id).toBe(first.body.id);
    expect(await f.cards()).toHaveLength(1);
    expect(await f.created()).toEqual([]);
  }, 60_000);

  it("C2: a non-primary agent (even the CEO), or the primary for another user, is refused: 403 and no card", async () => {
    const f = await seed();
    const ceo = await f.ask("ceo");
    expect(ceo.status, ceo.text).toBe(403);
    const forOther = await f.ask("primary", { ownerUserId: f.otherUserId });
    expect(forOther.status, forOther.text).toBe(403);
    expect(await f.cards()).toEqual([]);
  }, 60_000);

  it("C3: an instance admin's approve creates the org with the owner's membership once; approving again returns the same", async () => {
    const f = await seed();
    const card = (await f.ask("primary")).body;
    // Concurrent approves (a double click, a replayed request) share one effect.
    const [first, racing, third] = await Promise.all([1, 2, 3].map(() =>
      request(f.admin).post(`/api/approvals/${card.id}/approve`).send({})));
    expect(first!.status, first!.text).toBe(200);
    expect(racing!.status, racing!.text).toBe(200);
    expect(third!.status, third!.text).toBe(200);
    expect(third!.body.payload.createdCompanyId).toBe(first!.body.payload.createdCompanyId);
    const orgs = await f.created();
    expect(orgs).toHaveLength(1);
    const org = orgs[0]!;
    expect(org).toMatchObject({ name: f.name, description: "Research and marketing", budgetMonthlyCents: 5000 });
    expect(first!.body).toMatchObject({ status: "approved", payload: { createdCompanyId: org.id } });
    expect(racing!.body.payload.createdCompanyId).toBe(org.id);
    const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, org.id),
      eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, f.ownerId)));
    expect(membership).toMatchObject({ membershipRole: "owner", status: "active" });
    const replay = await request(f.admin).post(`/api/approvals/${card.id}/approve`).send({});
    expect(replay.status, replay.text).toBe(200);
    expect(replay.body.payload.createdCompanyId).toBe(org.id);
    expect(await f.created()).toHaveLength(1);
    // The request after approval is a new logical request, not a replay of this one.
    expect((await f.cards()).filter(row => row.status === "approved")).toHaveLength(1);
  }, 90_000);

  it("C4: reject creates nothing", async () => {
    const f = await seed();
    const card = (await f.ask("primary")).body;
    const rejected = await request(f.admin).post(`/api/approvals/${card.id}/reject`).send({});
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    expect(await f.created()).toEqual([]);
    const late = await request(f.admin).post(`/api/approvals/${card.id}/approve`).send({});
    expect(late.status).toBe(422);
    expect(await f.created()).toEqual([]);
  }, 60_000);

  it("C5: an approver who is not an instance admin is refused and nothing is created", async () => {
    const f = await seed();
    const card = (await f.ask("primary")).body;
    const refused = await request(f.operator).post(`/api/approvals/${card.id}/approve`).send({});
    expect(refused.status, refused.text).toBe(403);
    expect(await f.created()).toEqual([]);
    const [still] = await f.cards();
    expect(still).toMatchObject({ id: card.id, status: "pending" });
    expect(still!.payload.reservedCompanyId).toBeUndefined();
  }, 60_000);
});
