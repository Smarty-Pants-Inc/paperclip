import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueReadStates, issues, issueThreadInteractions } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { authorizationService } from "../services/authorization.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

// Keep: trust boundaries and data safety. Exercise real routes and PostgreSQL,
// not mocks of authorization, filtering, or read-state writes.
(support.supported ? describe : describe.skip)("all-member conversations", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), otherCompanyId = randomUUID();
  const agentId = randomUUID(), otherAgentId = randomUUID(), foreignAgentId = randomUUID(), hiddenAgentId = randomUUID();
  const owner = randomUUID(), member = randomUUID(), privateOwner = randomUUID();
  const ownChat = randomUUID(), memberChat = randomUUID(), privateChat = randomUUID(), otherChat = randomUUID();
  const interactionId = randomUUID(), failedRunId = randomUUID();
  const originalMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  function appFor(userId = owner, extra: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], ...extra }; next(); });
    app.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const path = () => `/api/companies/${companyId}/chats`;
  const list = (app = appFor(), query: Record<string, unknown> = {}) => request(app).get(path()).query({ members: "all", agentId, ...query });
  beforeAll(async () => {
    database = await startRecoveryPostgres("paperclip-all-member-chats-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([{ id: companyId, name: "Daily conversations", issuePrefix: "AMC" }, { id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" }]);
    for (const [id, name, role] of [[owner, "Owner A", "owner"], [member, "Member B", "operator"], [privateOwner, "Private member", "operator"]] as const) {
      await db.insert(authUsers).values({ id, name, email: `${id}@test.invalid`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: role });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId: id, membershipRole: role, grantedByUserId: null });
    }
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Shared helper", role: "engineer", adapterType: "process" },
      { id: otherAgentId, companyId, name: "Other helper", role: "engineer", adapterType: "process" },
      { id: foreignAgentId, companyId: otherCompanyId, name: "Foreign helper", role: "engineer", adapterType: "process" },
      { id: hiddenAgentId, companyId, name: "Hidden helper", role: "engineer", adapterType: "process", permissions: { authorizationPolicy: { agentVisibility: { mode: "private", hiddenFromDefaultDirectory: true }, managedBy: "permissions-extension" } } },
    ]);
    await db.insert(issues).values([
      { id: ownChat, companyId, title: "Owner conversation", conversationAgentId: agentId, conversationUserId: owner, createdByUserId: owner },
      { id: memberChat, companyId, title: "Member conversation", conversationAgentId: agentId, conversationUserId: member, createdByUserId: member },
      { id: privateChat, companyId, title: "Private conversation", conversationAgentId: agentId, conversationUserId: privateOwner, createdByUserId: privateOwner, visibility: "private" },
      { id: otherChat, companyId, title: "Other agent conversation", conversationAgentId: otherAgentId, conversationUserId: member, createdByUserId: member },
    ].map(row => ({ ...row, assigneeAgentId: row.conversationAgentId, conversationState: "waiting" as const, status: "in_review" })));
    await db.insert(issueComments).values({ companyId, issueId: memberChat, authorAgentId: agentId, authorType: "agent", body: "Saved answer for Member B" });
    await db.insert(issueReadStates).values({ companyId, issueId: memberChat, userId: member, lastReadAt: new Date("2020-01-01") });
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId, status: "failed", runtimeMode: "legacy", contextSnapshot: { issueId: memberChat }, finishedAt: new Date() });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId: memberChat, kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Approve?" } });
  }, 90_000);
  afterAll(async () => {
    if (originalMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = originalMode;
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  it.each(["enforce", "off"])("lists only shared readable conversations (%s)", async mode => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = mode;
    const app = appFor();
    const response = await list(app);
    expect(response.status).toBe(200);
    expect(response.body.map((row: { id: string }) => row.id).sort()).toEqual([ownChat, memberChat].sort());
    expect(response.body.find((row: { id: string }) => row.id === memberChat).conversationUserId).toBe(member);
    for (const row of response.body) expect((await request(app).get(`/api/issues/${row.id}`)).status).toBe(200);
    const search = await request(app).get(`/api/companies/${companyId}/issues`).query({ q: "conversation" });
    expect(search.status).toBe(200);
    expect(search.body.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining(response.body.map((row: { id: string }) => row.id)));
  });
  it.each(["enforce", "off"])("hides private conversations even from their owner, company owner and instance admin (%s)", async mode => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = mode;
    for (const app of [appFor(privateOwner), appFor(owner), appFor(owner, { isInstanceAdmin: true })]) {
      const response = await list(app);
      expect(response.status).toBe(200);
      expect(response.body.map((row: { id: string }) => row.id)).not.toContain(privateChat);
    }
  });
  it("preserves the existing no-parameter result", async () => {
    expect((await request(appFor(member)).get(path())).body.map((row: { id: string }) => row.id).sort()).toEqual([memberChat, otherChat].sort());
  });
  it("refuses agent actors and non-members", async () => {
    expect((await list(appFor(owner, { type: "agent", agentId, companyId, userId: undefined, source: "agent_key" }))).status).toBe(403);
    expect((await list(appFor(randomUUID(), { companyIds: [] }))).status).toBe(404);
  });
  it("requires active membership even for an instance administrator", async () => {
    expect((await list(appFor(randomUUID(), { companyIds: [], isInstanceAdmin: true }))).status).toBe(404);
  });
  it("requires a visible agent in this company", async () => {
    expect((await list(appFor(), { agentId: foreignAgentId })).status).toBe(404);
    // A stale companyIds assertion must not bypass the canonical agent read.
    // This base treats agentVisibility.private as assignment policy, not a
    // board read restriction, so do not invent a different list-only policy.
    const noMembership = randomUUID();
    expect((await authorizationService(db).decide({ actor: { type: "board", source: "session", userId: noMembership },
      action: "agent:read", resource: { type: "agent", companyId, agentId: hiddenAgentId } })).allowed).toBe(false);
    expect((await list(appFor(noMembership), { agentId: hiddenAgentId })).status).toBe(404);
    expect((await request(appFor()).get(path()).query({ members: "all" })).status).toBe(400);
  });
  it("bounds pages and validates limits", async () => {
    const first = await list(appFor(), { limit: 1, offset: 0 });
    const second = await list(appFor(), { limit: 1, offset: 1 });
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(first.body).toHaveLength(1); expect(second.body).toHaveLength(1);
    expect(first.body[0].id).not.toBe(second.body[0].id);
    for (const limit of [0, 101, "invalid"]) expect((await list(appFor(), { limit })).status).toBe(400);
  });
  it.each(["chat-handoffs", "pending-questions", "decision-receipts"])("keeps %s owner-only", async endpoint => {
    expect((await request(appFor()).get(`/api/issues/${memberChat}/${endpoint}`)).status).toBe(404);
  });
  it.each(["send", "attachments", "interaction", "retry", "interrupt", "compact"])("keeps %s owner-only", async operation => {
    const app = appFor();
    const base = `/api/issues/${memberChat}`;
    const response = operation === "send" ? await request(app).post(`${base}/comments`).send({ body: "No", clientRequestId: randomUUID() })
      : operation === "attachments" ? await request(app).post(`/api/companies/${companyId}/issues/${memberChat}/attachments`).attach("file", Buffer.from("No"), "note.txt")
      : operation === "interaction" ? await request(app).post(`${base}/interactions/${interactionId}/accept`).send({})
      : operation === "retry" ? await request(app).post(`${base}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: null })
      : operation === "interrupt" ? await request(app).post(`${base}/queued-comments/interrupt`).send({ queueId: randomUUID(), revision: "revision", targetRunId: randomUUID() })
      : await request(app).post(`${base}/context/compact`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toMatch(/conversation owner/);
  });
  it("keeps the agent failed-run retry endpoint owner-only", async () => {
    const response = await request(appFor()).post(`/api/agents/${agentId}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toMatch(/conversation owner/);
  });
  it("does not change the owner's read markers, unread count, conversation or activity", async () => {
    const snapshot = async () => ({
      reads: await db.select().from(issueReadStates).where(and(eq(issueReadStates.issueId, memberChat), eq(issueReadStates.userId, member))),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
      issue: await db.select().from(issues).where(eq(issues.id, memberChat)),
      owned: (await request(appFor(member)).get(path())).body,
    });
    const before = await snapshot();
    expect(before.owned.find((row: { id: string }) => row.id === memberChat).unreadMessageCount).toBe(1);
    await list();
    for (const suffix of ["", "/comments", "/interactions"]) expect((await request(appFor()).get(`/api/issues/${memberChat}${suffix}`)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
});
