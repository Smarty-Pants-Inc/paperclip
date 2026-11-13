import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentApiKeys, authUsers, budgetPolicies, budgetReservations, companies, companyMemberships, costEvents, createDb,
  principalPermissionGrants, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { costRoutes } from "../routes/costs.js";
import { agentPermissionGrantRoutes } from "../routes/agent-permission-grants.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Trust boundary: real bearer authentication, routes, authorization and persisted Postgres writes.
describe("lead budget and permission management inside its current subtree", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "subtree-management-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("subtree-management-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end(); await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  async function seed() {
    const companyId = randomUUID(), userId = randomUUID();
    const ids = { lead: randomUUID(), worker: randomUUID(), descendant: randomUUID(), outside: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Management", issuePrefix: `M${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    for (const name of ["lead", "outside", "worker", "descendant"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, role: "engineer", adapterType: "process", status: "idle", lifecycleState: "ready",
        budgetMonthlyCents: name === "lead" ? 1000 : 100, reportsTo: name === "worker" ? ids.lead : name === "descendant" ? ids.worker : null,
        permissions: { canCreateAgents: true, canAssignTasks: true }, runtimeConfig: { heartbeat: { enabled: false } } });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...Object.values(ids).map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      ...(["agents:configure", "agents:read", "agents:create", "users:manage_permissions"] as const).map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "agents:configure", scope: { subtreeRootAgentId: ids.lead } },
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "tasks:assign", scope: { subtreeRootAgentId: ids.lead } },
    ]);
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: ids.lead, name: "Lead", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express(); api.use(express.json()); api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentPermissionGrantRoutes(db)); api.use("/api", costRoutes(db)); api.use("/api", agentRoutes(db)); api.use(errorHandler);
    const patch = (id: string, suffix: string, body: object) => request(api).patch(`/api/agents/${id}${suffix}`).set("Authorization", `Bearer ${token}`).send(body);
    const board = express(); board.use(express.json());
    board.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: true }; next(); });
    board.use("/api", agentPermissionGrantRoutes(db)); board.use("/api", costRoutes(db)); board.use("/api", agentRoutes(db)); board.use(errorHandler);
    const boardPatch = (id: string, suffix: string, body: object) => request(board).patch(`/api/agents/${id}${suffix}`).send(body);
    return { ids, companyId, userId, patch, boardPatch };
  }
  const readAgent = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const grantBody = (root: string) => ({ permissionKey: "agents:configure", enabled: true, scope: { subtreeRootAgentId: root } });

  it("allows non-CEO lead budget writes through both routes, with agent-attributed policy audit", async () => {
    const f = await seed();
    for (const [suffix, amount] of [["/budgets", 500], ["", 600]] as const) {
      const response = await f.patch(f.ids.worker, suffix, { budgetMonthlyCents: amount });
      expect(response.status, response.text).toBe(200);
      expect((await readAgent(f.ids.worker)).budgetMonthlyCents).toBe(amount);
    }
    const policies = await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, f.ids.worker));
    expect(policies).toHaveLength(1); expect(policies[0]!.amount).toBe(600);
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "budget.policy_upserted")));
    expect(audit).toHaveLength(2);
    expect(audit.every(row => row.actorType === "agent" && row.actorId === f.ids.lead)).toBe(true);
  }, 60_000);

  it("grants only held permission within the lead subtree and records the agent actor", async () => {
    const f = await seed();
    const response = await f.patch(f.ids.worker, "/permission-grants", grantBody(f.ids.worker));
    expect(response.status, response.text).toBe(200);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, f.ids.worker))).toEqual([
      expect.objectContaining({ permissionKey: "agents:configure", scope: { subtreeRootAgentId: f.ids.worker }, grantedByUserId: null }),
    ]);
    const [audit] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.ids.worker), eq(activityLog.action, "agent.permission_grant_updated")));
    expect(audit).toMatchObject({ actorType: "agent", actorId: f.ids.lead });
    expect((await f.patch(f.ids.worker, "/permissions", { canCreateAgents: true, canAssignTasks: true })).status).toBe(200);
    const [assignment] = await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.worker), eq(principalPermissionGrants.permissionKey, "tasks:assign")));
    expect(assignment!.scope).toEqual({ subtreeRootAgentId: f.ids.worker });
  }, 60_000);

  it("allows a managed instructions path, not an arbitrary external host path", async () => {
    const f = await seed(), worker = await readAgent(f.ids.worker);
    const managedPath = path.join(resolveManagedInstructionsRoot(worker), "LEAD.md");
    const response = await f.patch(worker.id, "/instructions-path", { path: managedPath, adapterConfigKey: "instructionsFilePath" });
    expect(response.status, response.text).toBe(200);
    expect((await readAgent(worker.id)).adapterConfig.instructionsFilePath).toBe(managedPath);
    expect((await f.patch(worker.id, "/instructions-path", { path: "/etc/AGENTS.md", adapterConfigKey: "instructionsFilePath" })).status).toBe(403);
    expect((await f.patch(worker.id, "/instructions-path", { path: "/bin/evil", adapterConfigKey: "command" })).status).toBe(403);
    expect((await readAgent(worker.id)).adapterConfig.command).toBeUndefined();
    expect((await f.patch(worker.id, "/instructions-path", { path: managedPath, adapterConfigKey: "agentsMdPath" })).status).toBe(200);
    expect((await f.patch(worker.id, "/instructions-path", { path: "/etc/AGENTS.md", adapterConfigKey: "agentsMdPath" })).status).toBe(403);
  }, 60_000);

  it("denies self, outside, and reparented targets across every mutation without changing persisted data", async () => {
    const f = await seed();
    for (const id of [f.ids.lead, f.ids.outside, f.ids.worker]) {
      if (id === f.ids.worker) await db.update(agents).set({ reportsTo: f.ids.outside }).where(eq(agents.id, id));
      const before = await readAgent(id);
      for (const [suffix, body] of [["/budgets", { budgetMonthlyCents: 500 }], ["", { budgetMonthlyCents: 500 }],
        ["/permissions", { canCreateAgents: true, canAssignTasks: true }], ["/permission-grants", grantBody(id)],
        ["/instructions-path", { path: path.join(resolveManagedInstructionsRoot(before), "LEAD.md") }]] as const) {
        const response = await f.patch(id, suffix, body);
        expect(response.status, `${suffix}: ${response.text}`).toBe(403);
      }
      expect(await readAgent(id)).toEqual(before);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, id))).toEqual([]);
    }
  }, 60_000);

  it("preserves board edits outside the subtree, unscoped grants and zero/unlimited budgets", async () => {
    const f = await seed();
    expect((await f.boardPatch(f.ids.outside, "/budgets", { budgetMonthlyCents: 5000 })).status).toBe(200);
    expect((await f.boardPatch(f.ids.outside, "", { budgetMonthlyCents: 0 })).status).toBe(200);
    expect((await f.boardPatch(f.ids.outside, "/permission-grants", { ...grantBody(f.ids.outside), scope: null })).status).toBe(200);
    expect((await f.boardPatch(f.ids.outside, "/permissions", { canCreateAgents: true, canAssignTasks: true })).status).toBe(200);
    expect((await f.boardPatch(f.ids.outside, "/instructions-path", { path: "/tmp/board-AGENTS.md", adapterConfigKey: "instructionsFilePath" })).status).toBe(200);
    expect((await readAgent(f.ids.outside)).budgetMonthlyCents).toBe(0);
  }, 60_000);

  it("rejects suggestion-only authority and a reparented descendant even with a legacy unscoped configure grant", async () => {
    const f = await seed();
    await db.update(principalPermissionGrants).set({ permissionKey: "agents:suggest-changes" }).where(and(
      eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    expect((await f.patch(f.ids.worker, "/budgets", { budgetMonthlyCents: 500 })).status).toBe(403);
    expect((await f.patch(f.ids.worker, "/permission-grants", { permissionKey: "tasks:assign", enabled: true })).status).toBe(403);
    await db.update(principalPermissionGrants).set({ permissionKey: "agents:configure", scope: null }).where(and(
      eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:suggest-changes")));
    await db.update(agents).set({ reportsTo: f.ids.outside }).where(eq(agents.id, f.ids.worker));
    for (const id of [f.ids.worker, f.ids.descendant, f.ids.lead]) {
      expect((await f.patch(id, "/budgets", { budgetMonthlyCents: 500 })).status).toBe(403);
      expect((await f.patch(id, "/permission-grants", grantBody(id))).status).toBe(403);
    }
  }, 60_000);

  it("uses live remaining spend and current policy capacity, and supports a transitive descendant", async () => {
    const f = await seed();
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.ids.lead,
      provider: "test", model: "test", costCents: 450, occurredAt: new Date() });
    for (const suffix of ["/budgets", ""]) {
      expect((await f.patch(f.ids.worker, suffix, { budgetMonthlyCents: 551 })).status).toBe(403);
      const response = await f.patch(f.ids.descendant, suffix, { budgetMonthlyCents: 550 });
      expect(response.status, response.text).toBe(200);
    }
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: f.ids.lead,
      amount: 700, metric: "billed_cents", windowKind: "calendar_month_utc", isActive: true });
    expect((await f.patch(f.ids.worker, "/budgets", { budgetMonthlyCents: 251 })).status).toBe(403);
    expect((await f.patch(f.ids.worker, "/budgets", { budgetMonthlyCents: 250 })).status).toBe(200);
  }, 60_000);

  it("includes held reservations and fractional cents in the remaining-budget cap", async () => {
    const f = await seed();
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.ids.lead,
      provider: "test", model: "test", costCents: 450, occurredAt: new Date() });
    await db.insert(budgetReservations).values({ companyId: f.companyId, agentId: f.ids.lead,
      decisionInvocationId: randomUUID(), amountCents: "100.0000001", state: "held" });
    for (const suffix of ["/budgets", ""]) {
      expect((await f.patch(f.ids.worker, suffix, { budgetMonthlyCents: 450 })).status).toBe(403);
      const response = await f.patch(f.ids.worker, suffix, { budgetMonthlyCents: 449 });
      expect(response.status, response.text).toBe(200);
    }
  }, 60_000);

  it("does not let a lead denied hiring pass hiring authority to a worker", async () => {
    const f = await seed();
    await db.update(agents).set({ permissions: { canCreateAgents: false, canAssignTasks: true } }).where(eq(agents.id, f.ids.lead));
    const response = await f.patch(f.ids.worker, "/permissions", { canCreateAgents: true, canAssignTasks: true });
    expect(response.status, response.text).toBe(403);
    expect(response.body.error).toContain("agents:create");
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.ids.worker))).toEqual([]);
  }, 60_000);

  it("does not widen a finite source grant into a subtree, and revokes a subordinate grant", async () => {
    const f = await seed();
    const assignment = { permissionKey: "tasks:assign", enabled: true };
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [f.ids.worker] } }).where(and(
      eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "tasks:assign")));
    expect((await f.patch(f.ids.worker, "/permission-grants", { ...assignment, scope: { subtreeRootAgentId: f.ids.worker } })).status).toBe(403);
    expect((await f.patch(f.ids.worker, "/permission-grants", { ...assignment, scope: { agentIds: [f.ids.worker] } })).status).toBe(200);
    expect((await f.patch(f.ids.worker, "/permission-grants", { ...assignment, enabled: false })).status).toBe(200);
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, f.ids.worker))).toEqual([]);
  }, 60_000);

  it("rejects missing authority, unscoped/escaped delegation and budget disabling or over-allocation", async () => {
    const f = await seed();
    for (const body of [
      { permissionKey: "users:manage_permissions", enabled: true, scope: { subtreeRootAgentId: f.ids.worker } },
      { ...grantBody(f.ids.worker), scope: null },
      { ...grantBody(f.ids.worker), scope: { subtreeRootAgentId: f.ids.outside } },
      { ...grantBody(f.ids.worker), scope: { agentIds: [f.ids.worker, f.ids.outside] } },
    ]) expect((await f.patch(f.ids.worker, "/permission-grants", body)).status).toBe(403);
    for (const suffix of ["/budgets", ""]) {
      for (const amount of [1001, 0]) expect((await f.patch(f.ids.worker, suffix, { budgetMonthlyCents: amount })).status).toBe(403);
    }
    expect((await f.patch(f.ids.worker, "/permissions", { canCreateAgents: true, canAssignTasks: true, authorizationPolicy: { allow: ["*"] } })).status).not.toBe(200);
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "tasks:assign")));
    expect((await f.patch(f.ids.worker, "/permissions", { canCreateAgents: true, canAssignTasks: true })).status).toBe(403);
    expect((await readAgent(f.ids.worker)).budgetMonthlyCents).toBe(100);
  }, 60_000);
});
