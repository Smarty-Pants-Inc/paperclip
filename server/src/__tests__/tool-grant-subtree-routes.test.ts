import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentApiKeys, authUsers, companies, companyMemberships, connectionGrants,
  createDb, principalPermissionGrants, toolApplications, toolConnections, toolConnectionInstalls,
  toolProfiles, toolProfileEntries, toolProfileBindings, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS, newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { accessService } from "../services/access.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Recorded catch: #20389 pass 3 / SMAA-1169. Trust boundary: real bearer HTTP,
// PostgreSQL grants, an actual hire, and persisted installs/bindings (no auth mocks).
describe("tool grants to a manager's current reporting subtree", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("tool-grant-subtree-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(style: "structured" | "allow" | "unscoped" | "exact-outside" = "structured") {
    const companyId = randomUUID(), userId = randomUUID();
    const ids = { manager: randomUUID(), lead: randomUUID(), peer: randomUUID(), other: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Real hire tool regression", issuePrefix: `T${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", userId, "operator", "active");
    await access.ensureRoleDefaultGrants(companyId, userId, "operator", userId);
    for (const name of ["manager", "other", "lead", "peer"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, adapterType: "process", status: "idle", lifecycleState: "ready",
        reportsTo: name === "lead" || name === "peer" ? ids.manager : null,
        permissions: { canCreateAgents: true }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: ids[name], membershipRole: "member", status: "active" });
    }
    await db.insert(principalPermissionGrants).values(NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map(permissionKey => ({
      companyId, principalType: "agent" as const, principalId: ids.lead, permissionKey,
      scope: permissionKey === "agents:configure" && style !== "structured"
        ? style === "allow" ? { allow: [`subtree:${ids.lead}`] } : style === "exact-outside" ? { agentIds: [ids.other] } : null
        : newStandardAgentGrantScope(permissionKey, ids.lead),
    })));
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: ids.lead, name: "Lead key", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express();
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(db));
    api.use("/api", toolAccessRoutes(db));
    api.use(errorHandler);
    const board = express();
    const memberships = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    board.use(express.json());
    board.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships, isInstanceAdmin: false }; next(); });
    board.use("/api", toolAccessRoutes(db));
    board.use(errorHandler);
    const hire = await request(api).post(`/api/companies/${companyId}/agent-hires`).set("Authorization", `Bearer ${token}`).send({
      name: "Just hired helper", role: "engineer", reportsTo: ids.lead, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    });
    expect(hire.status, hire.text).toBe(201);
    const report = hire.body.agent.id as string;
    expect((await db.select().from(agents).where(eq(agents.id, report)))[0]!.reportsTo).toBe(ids.lead);
    const descendant = randomUUID();
    await db.insert(agents).values({ id: descendant, companyId, name: "Indirect report", reportsTo: report, adapterType: "process", status: "idle", lifecycleState: "ready" });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Mailbox", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Mailbox", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "organization", status: "active", isDefault: true });
    const retained = [ids.lead, ids.peer, ids.manager, ids.other].map(targetId => ({ targetType: "agent" as const, targetId }));
    await db.insert(toolConnectionInstalls).values(retained.map(target => ({ companyId, connectionId: connection.id, ...target })));
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Read mailbox", defaultAction: "deny" }).returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "connection", connectionId: connection.id });
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "agent", targetId: ids.peer });
    const installUrl = `/api/tool-connections/${connection.id}/installs`;
    const bindingUrl = `/api/companies/${companyId}/tools/profiles/${profile.id}/bind`;
    const put = (targets: Array<{ targetType: "agent"; targetId: string }>) => request(api).put(installUrl).set("Authorization", `Bearer ${token}`).send({ installs: targets });
    const bind = (targetId: string) => request(api).post(bindingUrl).set("Authorization", `Bearer ${token}`).send({ targetType: "agent", targetId });
    const installed = async () => (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).map(row => row.targetId).sort();
    return { companyId, userId, ids, report, descendant, connection, profile, retained, api, board, token, put, bind, installed, installUrl, bindingUrl };
  }

  for (const style of ["structured", "allow"] as const) {
    it(`${style}: installs a tool on its just-hired report without authority over retained targets`, async () => {
      const f = await fixture(style);
      const response = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
      expect(response.status, response.text).toBe(200);
      expect(await f.installed()).toEqual([...f.retained.map(row => row.targetId), f.report].sort());
      const indirect = await f.put([...f.retained, { targetType: "agent", targetId: f.report }, { targetType: "agent", targetId: f.descendant }]);
      expect(indirect.status, indirect.text).toBe(200);
      expect(await f.installed()).toContain(f.descendant);
      const removeOwn = await f.put(f.retained);
      expect(removeOwn.status, removeOwn.text).toBe(200);
      expect(await f.installed()).toEqual(f.retained.map(row => row.targetId).sort());
      const noChange = await f.put(f.retained);
      expect(noChange.status, noChange.text).toBe(200);
    }, 60_000);

    it(`${style}: binds a shared profile to direct and indirect reports, preserving outside bindings`, async () => {
      const f = await fixture(style);
      for (const id of [f.report, f.descendant]) {
        const response = await f.bind(id);
        expect(response.status, response.text).toBe(201);
      }
      const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
      expect(bindings.map(row => row.targetId).sort()).toEqual([f.ids.peer, f.report, f.descendant].sort());
    }, 60_000);
  }

  it.each(["peer", "manager", "other"] as const)("refuses adding, removing or binding an outside %s", async target => {
    const f = await fixture();
    const before = await f.installed();
    // An unchanged outside target must not require authority; removing it must.
    const remove = await f.put(f.retained.filter(row => row.targetId !== f.ids[target]));
    expect(remove.status, remove.text).toBe(403);
    expect(await f.installed()).toEqual(before);
    const binding = await f.bind(f.ids[target]);
    expect(binding.status, binding.text).toBe(403);
    // Remove through the board, then prove a forbidden addition is a true delta.
    const saved = f.retained.filter(row => row.targetId !== f.ids[target]);
    const boardRemove = await request(f.board).put(f.installUrl).send({ installs: saved });
    expect(boardRemove.status, boardRemove.text).toBe(200);
    const add = await f.put(f.retained);
    expect(add.status, add.text).toBe(403);
    expect(await f.installed()).toEqual(saved.map(row => row.targetId).sort());
  }, 60_000);

  it.each(["unscoped", "exact-outside"] as const)("%s configure cannot widen tool assignments beyond the current subtree", async style => {
    const f = await fixture(style);
    const response = await f.bind(f.ids.other);
    expect(response.status, response.text).toBe(403);
    const remove = await f.put(f.retained.filter(row => row.targetId !== f.ids.other));
    expect(remove.status, remove.text).toBe(403);
  }, 60_000);

  it("intersects strict descendants with a narrower explicit configure grant", async () => {
    const f = await fixture();
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [f.report] } }).where(and(
      eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure"),
    ));
    const direct = await f.bind(f.report);
    expect(direct.status, direct.text).toBe(201);
    const indirect = await f.bind(f.descendant);
    expect(indirect.status, indirect.text).toBe(403);
    const install = await f.put([...f.retained, { targetType: "agent", targetId: f.descendant }]);
    expect(install.status, install.text).toBe(403);
  }, 60_000);

  it("leaves shared profile/connection mutations subject to all affected consumers", async () => {
    const f = await fixture();
    const connection = await request(f.api).patch(`/api/tool-connections/${f.connection.id}`).set("Authorization", `Bearer ${f.token}`).send({ name: "Cannot change peers' connection" });
    expect(connection.status, connection.text).toBe(403);
    const profile = await request(f.api).patch(`/api/tool-profiles/${f.profile.id}`).set("Authorization", `Bearer ${f.token}`).send({ name: "Cannot change peers' profile" });
    expect(profile.status, profile.text).toBe(403);
  }, 60_000);

  it("preserves unchanged company sharing without allowing the lead to remove it", async () => {
    const f = await fixture();
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "company", targetId: f.companyId });
    const installs = [...f.retained, { targetType: "company", targetId: f.companyId }, { targetType: "agent", targetId: f.report }];
    const own = await request(f.api).put(f.installUrl).set("Authorization", `Bearer ${f.token}`).send({ installs });
    expect(own.status, own.text).toBe(200);
    const removeCompany = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
    expect(removeCompany.status, removeCompany.text).toBe(403);
    expect(await f.installed()).toContain(f.companyId);
  }, 60_000);

  it("recomputes the install delta after a concurrent board writer adds an outside recipient", async () => {
    const f = await fixture();
    const [outside] = await db.insert(agents).values({ companyId: f.companyId, name: "New outside recipient", adapterType: "process", status: "idle", lifecycleState: "ready" }).returning();
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const boardWrite = db.transaction(async tx => {
      await tx.select({ id: toolConnections.id }).from(toolConnections).where(eq(toolConnections.id, f.connection.id)).for("update");
      await tx.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "agent", targetId: outside.id });
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
      ready(Number(row!.pid));
      await gate;
    });
    let mutation: Promise<request.Response> | undefined;
    try {
      const pid = await locked;
      mutation = f.put([...f.retained, { targetType: "agent", targetId: f.report }]).then(response => response);
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and ${pid} = any(pg_blocking_pids(pid))`);
        expect(rows.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 20 });
    } finally {
      release();
      await boardWrite;
      await mutation;
    }
    const response = await mutation!;
    expect(response.status, response.text).toBe(403);
    expect(await f.installed()).toEqual([...f.retained.map(row => row.targetId), outside.id].sort());
  }, 60_000);

  it("rechecks the current tree after a report is moved; board access is unchanged", async () => {
    const f = await fixture();
    await db.update(agents).set({ reportsTo: f.ids.other }).where(eq(agents.id, f.report));
    const response = await f.bind(f.descendant);
    expect(response.status, response.text).toBe(403);
    const install = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
    expect(install.status, install.text).toBe(403);
    const boardBind = await request(f.board).post(f.bindingUrl).send({ targetType: "agent", targetId: f.descendant });
    expect(boardBind.status, boardBind.text).toBe(201);
    const boardPut = await request(f.board).put(f.installUrl).send({ installs: [{ targetType: "agent", targetId: f.ids.manager }] });
    expect(boardPut.status, boardPut.text).toBe(200);
    expect(await f.installed()).toEqual([f.ids.manager]);
  }, 60_000);

  it("unbinds only its own report without changing outside recipients", async () => {
    const f = await fixture();
    const bound = await f.bind(f.report);
    expect(bound.status, bound.text).toBe(201);
    const url = f.bindingUrl.replace(/\/bind$/, "/unbind");
    const own = await request(f.api).post(url).set("Authorization", `Bearer ${f.token}`).send({ targetType: "agent", targetId: f.report });
    expect(own.status, own.text).toBe(200);
    const outside = await request(f.api).post(url).set("Authorization", `Bearer ${f.token}`).send({ targetType: "agent", targetId: f.ids.peer });
    expect(outside.status, outside.text).toBe(403);
    const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
    expect(bindings.map(row => row.targetId)).toEqual([f.ids.peer]);
  }, 60_000);

  for (const style of ["structured", "unscoped"] as const) {
    for (const operation of ["install", "bind", "unbind"] as const) {
      it(`${style}: ${operation} waits on the company lock and revalidates an intermediate-manager reparent`, async () => {
        const f = await fixture(style);
        if (operation === "unbind") {
          const bound = await f.bind(f.descendant);
          expect(bound.status, bound.text).toBe(201);
        }
        const installsBefore = await f.installed();
        const bindingsBefore = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
        let release!: () => void, ready!: (pid: number) => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const locked = new Promise<number>(resolve => { ready = resolve; });
        const reparent = withAccountingTransaction(db, f.companyId, async tx => {
          await updateAgentConfigurationInTransaction(tx, f.report, { reportsTo: f.ids.other });
          const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
          ready(Number(row!.pid));
          await gate;
        });
        let mutation: Promise<request.Response> | undefined;
        try {
          const pid = await locked;
          const call = operation === "install" ? f.put([...f.retained, { targetType: "agent", targetId: f.descendant }])
            : operation === "bind" ? f.bind(f.descendant)
              : request(f.api).post(f.bindingUrl.replace(/\/bind$/, "/unbind")).set("Authorization", `Bearer ${f.token}`).send({ targetType: "agent", targetId: f.descendant });
          mutation = call.then(response => response);
          // Event-based proof of actual overlap: the writer must wait on the
          // reporting-tree mutex, not merely recheck a previously moved row.
          await vi.waitFor(async () => {
            const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
              and ${pid} = any(pg_blocking_pids(pid))`);
            expect(rows.length).toBeGreaterThan(0);
          }, { timeout: 5_000, interval: 20 });
        } finally {
          release();
          await reparent;
          await mutation;
        }
        const response = await mutation!;
        expect(response.status, response.text).toBe(403);
        expect(await f.installed()).toEqual(installsBefore);
        expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id))).toEqual(bindingsBefore);
      }, 60_000);
    }
  }

  it("does not substitute a suggestion grant for revoked direct configure", async () => {
    const f = await fixture();
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    const response = await f.bind(f.report);
    expect(response.status, response.text).toBe(403);
    const install = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
    expect(install.status, install.text).toBe(403);
    // Existing self-service is independent of cross-agent configure grants.
    const self = await f.bind(f.ids.lead);
    expect(self.status, self.text).toBe(201);
  }, 60_000);
});
