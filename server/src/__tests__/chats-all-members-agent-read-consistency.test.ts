import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

// Keep: trust boundary. Compare real HTTP routes against PostgreSQL so the
// all-members list cannot invent a different rule from canonical agent:read.
// Actor injection replaces session resolution only, not authorization.
(support.supported ? describe : describe.skip)("all-member chats and canonical agent read consistency", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const member = randomUUID();
  const owner = randomUUID();
  const nonMember = randomUUID();
  const foreignAgentId = randomUUID();
  const readableAgents = [
    { kind: "directory-visible", agentId: randomUUID(), chatId: randomUUID(), hidden: false },
    { kind: "directory-hidden/private", agentId: randomUUID(), chatId: randomUUID(), hidden: true },
  ];

  function appFor(userId: string, companyIds: string[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds };
      next();
    });
    app.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function readBoth(app: ReturnType<typeof appFor>, agentId: string) {
    // Same actor, agent, and company scope as agentsApi.get in the app.
    const agent = await request(app).get(`/api/agents/${agentId}`).query({ companyId });
    const chats = await request(app).get(`/api/companies/${companyId}/chats`)
      .query({ agentId, members: "all" });
    return { agent, chats };
  }

  beforeAll(async () => {
    database = await startRecoveryPostgres("paperclip-chats-agent-read-consistency-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Agent-read consistency", issuePrefix: "ARC" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" },
    ]);
    for (const [id, name] of [[member, "Reading member"], [owner, "Conversation owner"], [nonMember, "Non-member"]]) {
      await db.insert(authUsers).values({ id, name, email: `${id}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
      if (id === nonMember) continue;
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: "operator" });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId: id, membershipRole: "operator", grantedByUserId: null });
    }
    for (const { kind, agentId, chatId, hidden } of readableAgents) {
      await db.insert(agents).values({
        id: agentId, companyId, name: `${kind} helper`, role: "engineer", adapterType: "process",
        permissions: hidden ? {
          authorizationPolicy: {
            agentVisibility: { mode: "private", hiddenFromDefaultDirectory: true },
            managedBy: "permissions-extension",
          },
        } : {},
      });
      await db.insert(issues).values({
        id: chatId, companyId, title: `${kind} conversation`, assigneeAgentId: agentId,
        conversationAgentId: agentId, conversationUserId: owner, createdByUserId: owner,
        conversationState: "waiting", status: "in_review",
      });
    }
    await db.insert(agents).values({ id: foreignAgentId, companyId: otherCompanyId, name: "Foreign helper", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({
      companyId: otherCompanyId, title: "Foreign conversation", assigneeAgentId: foreignAgentId,
      conversationAgentId: foreignAgentId, conversationUserId: owner, createdByUserId: owner,
      conversationState: "waiting", status: "in_review",
    });
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  it.each(readableAgents)("allows a member to read the $kind agent and its shared conversation", async ({ agentId, chatId }) => {
    const { agent, chats } = await readBoth(appFor(member, [companyId]), agentId);
    expect(agent.status, JSON.stringify(agent.body)).toBe(200);
    expect(chats.status, JSON.stringify(chats.body)).toBe(agent.status);
    expect(agent.body).toMatchObject({ id: agentId, companyId });
    expect(chats.body).toHaveLength(1);
    expect(chats.body[0]).toMatchObject({ id: chatId, companyId, conversationAgentId: agentId, conversationUserId: owner });
  });

  it.each(readableAgents)("returns 404 from both routes for a non-member reading the $kind agent", async ({ agentId }) => {
    const { agent, chats } = await readBoth(appFor(nonMember, []), agentId);
    expect(agent.status, JSON.stringify(agent.body)).toBe(404);
    expect(chats.status, JSON.stringify(chats.body)).toBe(agent.status);
    expect(agent.body).toEqual({ error: "Agent not found" });
    expect(chats.body).toEqual(agent.body);
  });

  it("returns 404 from both routes for an agent of another company", async () => {
    const { agent, chats } = await readBoth(appFor(member, [companyId]), foreignAgentId);
    expect(agent.status, JSON.stringify(agent.body)).toBe(404);
    expect(chats.status, JSON.stringify(chats.body)).toBe(agent.status);
    expect(agent.body).toEqual({ error: "Agent not found" });
    expect(chats.body).toEqual(agent.body);
  });

  it("returns the same 404 for an absent agent", async () => {
    const { agent, chats } = await readBoth(appFor(member, [companyId]), randomUUID());
    expect(agent.status, JSON.stringify(agent.body)).toBe(404);
    expect(chats.status, JSON.stringify(chats.body)).toBe(agent.status);
    expect(agent.body).toEqual({ error: "Agent not found" });
    expect(chats.body).toEqual(agent.body);
  });
});
