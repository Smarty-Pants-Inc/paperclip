import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { agents, companies, companyMemberships, createDb, principalPermissionGrants, toolApplications, toolConnectionInstalls, toolConnections, type Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lockCompanyAgentRuntime } from "../services/agent-runtime-lock.js";

// #20805 lock-order evidence for migration 0489's rule: existing agent rows
// first, then the company runtime lock. Two sessions each, no timing races
// decide the outcome: each step waits for the other session to be blocked.
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const evidence = (line: string) => { console.info(line); if (process.env.RED_EVIDENCE_FILE) writeFileSync(process.env.RED_EVIDENCE_FILE, line + "\n", { flag: "a" }); };
const pgCode = (error: unknown) => { let e = error as any; while (e?.cause) e = e.cause; return e?.code ?? null; };

describePg("#20805 company runtime lock order", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("runtime-lock-order-"); db = createDb(temp.connectionString); }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function company(peers: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Order", issuePrefix: `O${companyId.slice(0, 5).toUpperCase()}` });
    const rows = await db.insert(agents).values(Array.from({ length: peers }, (_, i) => ({ companyId, name: `A${i}`, role: "engineer", adapterType: "process" }))).returning();
    const [hirer] = await db.insert(agents).values({ id: `f${companyId.slice(1, 8)}-ffff-4fff-bfff-${companyId.slice(-12)}`, companyId, name: "Hirer",
      role: "general", adapterType: "process" }).returning();
    return { companyId, hirer: hirer!, peers: rows };
  }
  async function waitUntilBlocked(pid: number) {
    for (let i = 0; i < 300; i++) {
      if ((await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`)).length) return true;
      await sleep(10);
    }
    return false;
  }

  /** Session A takes the hirer row and the company lock in `order`; session B
   * is a single-agent runtime write of the hirer (row, then the shared hold). */
  async function hirerVersusRuntimeWrite(order: "row-then-lock" | "lock-then-row") {
    const f = await company(3);
    const codes: Array<string | null> = [null, null];
    let pidA = 0; let bStarted!: () => void; const bGo = new Promise<void>(r => { bStarted = r; });
    let b: Promise<void> | undefined;
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      pidA = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      if (order === "row-then-lock") await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.hirer.id} FOR NO KEY UPDATE`);
      else await lockCompanyAgentRuntime(tx as unknown as Db, f.companyId);
      b = (async () => {
        bStarted();
        await db.transaction(async btx => {
          await btx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
          await btx.update(agents).set({ title: `t-${randomUUID().slice(0, 6)}` }).where(sql`${agents.id} = ${f.hirer.id}`);
        }).catch(error => { codes[1] = pgCode(error); });
      })();
      await bGo;
      await sleep(150); // B holds the hirer row (lock-then-row) or waits for it (row-then-lock)
      if (order === "row-then-lock") await lockCompanyAgentRuntime(tx as unknown as Db, f.companyId);
      else await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.hirer.id} FOR NO KEY UPDATE`);
      await tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: "u", permissionKey: "tasks:assign" });
    }).catch(error => { codes[0] = pgCode(error); });
    await b;
    return codes;
  }

  it("the hire's placement (hirer row, then the company lock) does not deadlock with a runtime write of the hirer; the reverse placement does", async () => {
    const ours = await hirerVersusRuntimeWrite("row-then-lock");
    const reverse = await hirerVersusRuntimeWrite("lock-then-row");
    evidence(`LOCK_ORDER_PLACEMENT ${JSON.stringify({ rowThenLock: ours, lockThenRow: reverse })}`);
    expect(ours).toEqual([null, null]);
    expect(reverse).toContain("40P01");
  }, 30_000);

  it("a hire holding the hirer row and the company lock does not deadlock with the startup runtime refresh", async () => {
    const f = await company(20);
    const codes: Array<string | null> = [null, null];
    let refresh: Promise<void> | undefined;
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.hirer.id} FOR NO KEY UPDATE`);
      await lockCompanyAgentRuntime(tx as unknown as Db, f.companyId);
      refresh = db.execute(sql`SELECT paperclip_invalidate_company_agent_runtimes(${f.companyId}::uuid)`).then(() => undefined, error => { codes[1] = pgCode(error); });
      expect(await waitUntilBlocked(pid)).toBe(true);
      await tx.insert(agents).values({ companyId: f.companyId, name: "New hire", role: "engineer", adapterType: "process" });
      await tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: "u", permissionKey: "tasks:assign" });
    }).catch(error => { codes[0] = pgCode(error); });
    await refresh;
    evidence(`LOCK_ORDER_REFRESH ${JSON.stringify({ codes })}`);
    expect(codes).toEqual([null, null]);
  }, 30_000);

  // ---- src8 R2 (RFL 06:42Z 11-16): no path takes the company lock and THEN an
  // agent row lock other than its own. Each RED below is a path that did.

  /** Session A holds `rowId` (the hire's placement: row first) and, once session B
   * is blocked on that row, takes the company lock. B is `work`. */
  async function rowHolderThenLockVersus(f: { companyId: string }, rowId: string, work: (client: Db) => Promise<unknown>,
    options: { lockMode?: "no key update" | "update" } = {}) {
    const codes: Array<string | null> = [null, null];
    let b: Promise<void> | undefined;
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      await tx.execute(sql.raw(`SELECT id FROM agents WHERE id = '${rowId}' FOR ${options.lockMode === "update" ? "UPDATE" : "NO KEY UPDATE"}`));
      b = Promise.resolve().then(() => work(db)).then(() => undefined, error => { codes[1] = pgCode(error); });
      expect(await waitUntilBlocked(pid)).toBe(true);
      await lockCompanyAgentRuntime(tx as unknown as Db, f.companyId);
    }).catch(error => { codes[0] = pgCode(error); });
    await b;
    return codes;
  }

  it("R2 RED fanout loop: the startup refresh locks every agent row before its first shared hold (hirer beyond the first cursor batch)", async () => {
    const f = await company(20);
    const codes = await rowHolderThenLockVersus(f, f.hirer.id,
      client => client.execute(sql`SELECT paperclip_invalidate_company_agent_runtimes(${f.companyId}::uuid)`));
    evidence(`R2_FANOUT_LOOP ${JSON.stringify({ codes })}`);
    expect(codes).toEqual([null, null]);
  }, 30_000);

  it("R2 RED connector statement: a multi-agent install statement locks its agent rows before its first shared hold", async () => {
    const f = await company(3);
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Order MCP", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application!.id, name: "Order connection",
      uid: randomUUID(), transport: "mcp_remote", authKind: "none", enabled: true, status: "active" }).returning();
    const targets = [f.peers[0]!.id, f.hirer.id];
    const codes = await rowHolderThenLockVersus(f, f.hirer.id, client => client.insert(toolConnectionInstalls).values(targets.map(targetId => ({
      companyId: f.companyId, connectionId: connection!.id, targetType: "agent" as const, targetId }))));
    const installs = await db.select().from(toolConnectionInstalls).where(sql`${toolConnectionInstalls.connectionId} = ${connection!.id}`);
    evidence(`R2_CONNECTOR_STATEMENT ${JSON.stringify({ codes, installs: installs.length })}`);
    expect(codes).toEqual([null, null]);
    expect(installs).toHaveLength(2);
  }, 30_000);

  function routeApp(actor: Express.Request["actor"]) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.actor = actor; next(); });
    a.use("/api", agentRoutes(db));
    a.use(errorHandler);
    return a;
  }

  it("R2 RED hire manager key: the hire takes its reportsTo key share before the exclusive lock (vs a row-then-shared writer of the manager)", async () => {
    const f = await company(3);
    const manager = f.peers[1]!;
    await db.update(agents).set({ permissions: { canCreateAgents: true } }).where(sql`${agents.id} = ${f.hirer.id}`);
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: f.hirer.id, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.hirer.id, permissionKey: "agents:create" });
    const app = routeApp({ type: "agent", agentId: f.hirer.id, companyId: f.companyId, source: "agent_key" } as Express.Request["actor"]);
    // Session A is a writer that holds the manager row (FOR UPDATE, the native
    // committer's actor lock) and then takes the SHARED hold (rows first).
    const codes: Array<string | null> = [null];
    let hire: Promise<request.Response> | undefined;
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      const pid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${manager.id} FOR UPDATE`);
      hire = request(app).post(`/api/companies/${f.companyId}/agents`).send({ name: "Keyed hire", role: "engineer", reportsTo: manager.id,
        adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).then(r => r);
      expect(await waitUntilBlocked(pid)).toBe(true);
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('paperclip.connector_runtime:' || ${f.companyId}::uuid::text, 0))`);
    }).catch(error => { codes[0] = pgCode(error); });
    const response = await hire!;
    evidence(`R2_HIRE_MANAGER_KEY ${JSON.stringify({ codes, hire: response.status })}`);
    expect(codes).toEqual([null]);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }, 30_000);

  it("R2 RED approval rows-first: approving a pending hire locks the agent row before the exclusive lock (two sessions: [null,null])", async () => {
    const f = await company(2);
    const [pending] = await db.insert(agents).values({ companyId: f.companyId, name: "Pending", role: "engineer", adapterType: "process",
      status: "pending_approval", lifecycleState: "pending_approval" }).returning();
    const codes = await rowHolderThenLockVersus(f, pending!.id, client => approvalService(client).approveHire(pending!.id, "board-user"));
    const [after] = await db.select({ status: agents.status }).from(agents).where(sql`${agents.id} = ${pending!.id}`);
    evidence(`R2_APPROVAL_ROWS_FIRST ${JSON.stringify({ codes, status: after!.status })}`);
    expect(codes).toEqual([null, null]);
    expect(after!.status).not.toBe("pending_approval");
  }, 30_000);

  it("R2 RED PATCH permissions rows-first: the permission save locks the agent row before the exclusive lock (two sessions: [null,null])", async () => {
    const f = await company(2);
    const target = f.peers[0]!;
    const codes = await rowHolderThenLockVersus(f, target.id,
      client => agentService(client).updatePermissions(target.id, { canCreateAgents: true }));
    const [after] = await db.select({ permissions: agents.permissions }).from(agents).where(sql`${agents.id} = ${target.id}`);
    evidence(`R2_PATCH_PERMISSIONS_ROWS_FIRST ${JSON.stringify({ codes, canCreateAgents: (after!.permissions as any)?.canCreateAgents })}`);
    expect(codes).toEqual([null, null]);
    expect((after!.permissions as any)?.canCreateAgents).toBe(true);
  }, 30_000);
});
