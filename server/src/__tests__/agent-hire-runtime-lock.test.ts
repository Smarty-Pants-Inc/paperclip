import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, museAgentBindings, principalPermissionGrants, type Db } from "@paperclipai/db";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { accessService } from "../services/access.js";
import { initializeAgentHire, prepareAgentHire } from "../services/agent-hiring.js";
import { lockAccountingCompany } from "../services/accounting-transaction.js";
import { transactionRetryStats } from "../services/transaction-retry.js";

// #20805 REDs: each fails at f6722df5 and passes with migration 0491 + the
// in-transaction membership grant. Evidence lines are printed as RED_* JSON.
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const MODE = process.env.RED_MODE ?? "head";
const evidence = (name: string, value: unknown) => {
  const line = `RED_${name} ${JSON.stringify({ mode: MODE, ...value as object })}`;
  console.info(line);
  if (process.env.RED_EVIDENCE_FILE) writeFileSync(process.env.RED_EVIDENCE_FILE, line + "\n", { flag: "a" });
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const pgCode = (error: unknown) => { let e = error as any; while (e?.cause) e = e.cause; return e?.code ?? null; };
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
};

describePg("#20805 agent hire runtime lock", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("hire-runtime-lock-");
    db = createDb(temp.connectionString);
    // Probe only: RED_APPLY_SQL replaces function bodies (e.g. the literal D1
    // without the shared hold) to show which RED a variant breaks.
    if (process.env.RED_APPLY_SQL) await db.execute(sql.raw(readFileSync(process.env.RED_APPLY_SQL, "utf8")));
  }, 120_000);
  afterAll(async () => { await temp?.cleanup(); });

  /** A company of `peers` low-id active agents plus hirer H with the highest id. */
  async function fixture(peers: number, options: { highId?: string } = {}) {
    const companyId = randomUUID();
    const nonce = companyId.slice(0, 6).toUpperCase();
    await db.insert(companies).values({ id: companyId, name: `Lock ${nonce}`, issuePrefix: `L${nonce}`,
      defaultResponsibleUserId: "board-user", requireBoardApprovalForNewAgents: false });
    // Peers sort below H. Distinct per company so fixtures can share one database.
    const ids = Array.from({ length: peers }, (_, i) => `0${companyId.slice(1, 4)}${i.toString(16).padStart(4, "0")}-0000-4000-8000-${companyId.slice(-12)}`);
    await db.insert(agents).values(ids.map((id, i) => ({ id, companyId, name: `Peer ${i}`, role: "engineer", adapterType: "process" })));
    const highId = options.highId ?? `f${companyId.slice(1, 8)}-ffff-4fff-bfff-${companyId.slice(-12)}`;
    const [hirer] = await db.insert(agents).values({ id: highId, companyId, name: "Hirer", role: "general", adapterType: "process",
      permissions: { canCreateAgents: true } }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: hirer!.id, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: hirer!.id, permissionKey: "agents:create" });
    const boardUserId = `board-${nonce}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: boardUserId, status: "active", membershipRole: "owner" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: boardUserId, permissionKey: "agents:create" });
    const app = (actor: Express.Request["actor"]) => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => { req.actor = actor; next(); });
      a.use("/api", agentRoutes(db));
      a.use(errorHandler);
      return a;
    };
    const agentApp = app({ type: "agent", agentId: hirer!.id, companyId, source: "agent_key" } as Express.Request["actor"]);
    const boardApp = app({ type: "board", userId: boardUserId, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }], source: "session" } as Express.Request["actor"]);
    return { companyId, hirer: hirer!, peerIds: ids, boardUserId, agentApp, boardApp };
  }

  async function deadlocks() {
    await sleep(1_200); // backends flush their counters when idle
    const [row] = await db.execute<{ deadlocks: string }>(sql`SELECT pg_stat_clear_snapshot(), deadlocks::text FROM pg_stat_database WHERE datname = current_database()`);
    return Number(row!.deadlocks);
  }

  async function grantsOf(companyId: string, agentIds: string[]) {
    const memberships = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "agent"), inArray(companyMemberships.principalId, agentIds)));
    const assign = await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalType, "agent"), inArray(principalPermissionGrants.principalId, agentIds),
      eq(principalPermissionGrants.permissionKey, "tasks:assign")));
    const count = (rows: Array<{ principalId: string }>) => Object.fromEntries(agentIds.map(id => [id, rows.filter(r => r.principalId === id).length]));
    return { memberships: count(memberships), assign: count(assign) };
  }

  async function activeAgentCount(companyId: string) {
    const [row] = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM agents WHERE company_id = ${companyId}`);
    return Number(row!.n);
  }

  function burst(f: Awaited<ReturnType<typeof fixture>>, tag: string) {
    const body = (name: string) => ({ name, role: "engineer", reportsTo: f.hirer.id, adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    const timed = async (kind: string, send: () => Promise<request.Response>) => {
      const started = performance.now();
      const response = await send().catch(error => ({ status: 0, body: { error: String(error) } }) as unknown as request.Response);
      return { kind, status: response.status, body: response.body, ms: performance.now() - started };
    };
    return [
      ...Array.from({ length: 10 }, (_, i) => timed("agent-create", () => request(f.agentApp).post(`/api/companies/${f.companyId}/agents`).send(body(`${tag} agent ${i}`)))),
      ...Array.from({ length: 6 }, (_, i) => timed("board-create", () => request(f.boardApp).post(`/api/companies/${f.companyId}/agents`).send({ ...body(`${tag} board ${i}`), reportsTo: undefined }))),
      ...Array.from({ length: 4 }, (_, i) => timed("agent-hire", () => request(f.agentApp).post(`/api/companies/${f.companyId}/agent-hires`).send(body(`${tag} hire ${i}`)))),
    ];
  }
  const createdId = (r: { kind: string; body: any }) => (r.kind === "agent-hire" ? r.body?.agent?.id : r.body?.id) as string | undefined;

  it("RED a + h: a 20-request burst in a 50-agent company with H highest: no deadlock, no retry, every agent complete", async () => {
    const f = await fixture(50);
    const before = { agents: await activeAgentCount(f.companyId), deadlocks: await deadlocks(), retried: transactionRetryStats.retried };
    const requests = burst(f, "burst");
    // One heartbeat/status write on an existing agent while the burst runs.
    await sleep(30);
    const hbStart = performance.now();
    await db.update(agents).set({ status: "running", lastHeartbeatAt: new Date() }).where(eq(agents.id, f.peerIds[0]!));
    const heartbeatMs = performance.now() - hbStart;
    // And one runtime-relevant write (fires paperclip_record_agent_runtime).
    const rtStart = performance.now();
    await db.update(agents).set({ title: `burst-${randomUUID().slice(0, 6)}` }).where(eq(agents.id, f.peerIds[1]!));
    const runtimeWriteMs = performance.now() - rtStart;
    const results = await Promise.all(requests);
    const after = { agents: await activeAgentCount(f.companyId), deadlocks: await deadlocks(), retried: transactionRetryStats.retried };
    const ids = results.map(createdId).filter((id): id is string => Boolean(id));
    const grants = await grantsOf(f.companyId, ids);
    const latencies = results.map(r => r.ms);
    evidence("A_BURST", {
      statuses: results.map(r => r.status), failures: results.filter(r => r.status !== 201).map(r => ({ kind: r.kind, status: r.status, body: r.body })),
      agentDelta: after.agents - before.agents, deadlockDelta: after.deadlocks - before.deadlocks, retriedDelta: after.retried - before.retried,
      p95Ms: Math.round(quantile(latencies, 0.95)), maxMs: Math.round(Math.max(...latencies)), heartbeatMs: Math.round(heartbeatMs), runtimeWriteMs: Math.round(runtimeWriteMs),
      membershipCounts: [...new Set(Object.values(grants.memberships))], assignCounts: [...new Set(Object.values(grants.assign))],
    });
    expect(results.map(r => r.status)).toEqual(Array(20).fill(201));
    expect(after.agents - before.agents).toBe(20);
    expect(ids).toHaveLength(20);
    expect(Object.values(grants.memberships)).toEqual(Array(20).fill(1));
    expect(Object.values(grants.assign)).toEqual(Array(20).fill(1));
    expect(after.deadlocks - before.deadlocks).toBe(0);
    expect(after.retried - before.retried).toBe(0);
  }, 180_000);

  it("RED b: the same burst plus one company-wide user grant: no deadlock, the user grant bumps every active agent exactly once", async () => {
    const f = await fixture(50);
    const before = { deadlocks: await deadlocks(), retried: transactionRetryStats.retried };
    const requests = burst(f, "mixed").slice(0, 10).concat(burst(f, "mixed-hire").slice(16));
    await sleep(20);
    const grant = db.transaction(async tx => {
      await tx.execute(sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
      await tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.boardUserId, permissionKey: "tasks:assign" });
      const own = await tx.execute<{ resource_id: string; n: string }>(sql`SELECT resource_id::text, count(*)::text AS n FROM resource_lifecycle_events
        WHERE company_id = ${f.companyId} AND resource_type = 'agent_runtime' AND xmin::text = (txid_current() % 4294967296)::text GROUP BY resource_id`);
      const visible = await tx.execute<{ id: string }>(sql`SELECT id::text FROM agents WHERE company_id = ${f.companyId} AND status NOT IN ('pending_approval', 'terminated')`);
      return { own: Array.from(own), visible: Array.from(visible).map(r => r.id) };
    }).then(value => ({ value, error: null }), error => ({ value: null, error: pgCode(error) ?? String(error) }));
    const [results, userGrant] = await Promise.all([Promise.all(requests), grant]);
    const after = { deadlocks: await deadlocks(), retried: transactionRetryStats.retried };
    const bumped = new Map((userGrant.value?.own ?? []).map(r => [r.resource_id, Number(r.n)]));
    evidence("B_MIXED", { statuses: results.map(r => r.status), userGrantError: userGrant.error, deadlockDelta: after.deadlocks - before.deadlocks,
      retriedDelta: after.retried - before.retried, visibleActive: userGrant.value?.visible.length ?? null, bumpedAgents: bumped.size,
      bumpCounts: [...new Set(bumped.values())] });
    expect(userGrant.error).toBeNull();
    expect(results.map(r => r.status)).toEqual(Array(14).fill(201));
    expect(after.deadlocks - before.deadlocks).toBe(0);
    expect(after.retried - before.retried).toBe(0);
    expect([...bumped.keys()].sort()).toEqual([...userGrant.value!.visible].sort());
    expect([...bumped.values()].every(n => n === 1)).toBe(true);
  }, 180_000);

  /** Agent rows a hire holds while its grants commit, read from a second session. */
  async function rowsLockedDuringHire(peers: number) {
    const f = await fixture(peers);
    const fn = `pause_${f.companyId.replace(/-/g, "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM nr WHERE company_id = '${f.companyId}' AND permission_key = 'tasks:assign' AND principal_id <> '${f.hirer.id}')
      THEN PERFORM pg_sleep(1.5); END IF; RETURN NULL; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER zz_${fn} AFTER INSERT ON principal_permission_grants REFERENCING NEW TABLE AS nr
      FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`));
    try {
      const pending = request(f.agentApp).post(`/api/companies/${f.companyId}/agents`).send({ name: "Lock sample", role: "engineer",
        reportsTo: f.hirer.id, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).then(r => r);
      let sampled: number | null = null;
      for (let i = 0; i < 200 && sampled === null; i++) {
        const waiting = await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query ILIKE '%principal_permission_grants%'`);
        if (waiting.length) {
          sampled = await db.transaction(async tx => {
            const [total] = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM agents WHERE company_id = ${f.companyId}`);
            const free = await tx.execute(sql`SELECT id FROM agents WHERE company_id = ${f.companyId} FOR UPDATE SKIP LOCKED`);
            return Number(total!.n) - free.length;
          });
        } else await sleep(10);
      }
      const response = await pending;
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return sampled;
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS zz_${fn} ON principal_permission_grants`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
  }

  it("RED c: agent rows locked by one hire do not grow with company size (10 vs 50 agents)", async () => {
    const small = await rowsLockedDuringHire(10);
    const large = await rowsLockedDuringHire(50);
    evidence("C_LOCKS", { lockedRowsAt10: small, lockedRowsAt50: large });
    expect(small).not.toBeNull();
    expect(large).toBe(small);
    expect(large!).toBeLessThanOrEqual(2);
  }, 120_000);

  it("RED d: revision rows per change, exactly once, and the runtime reader sees each change", async () => {
    const f = await fixture(12);
    const active = await db.execute<{ id: string }>(sql`SELECT id::text FROM agents WHERE company_id = ${f.companyId} AND status NOT IN ('pending_approval', 'terminated')`);
    const latest = async (agentId: string) => Number((await db.execute<{ id: string | null }>(sql`SELECT max(id)::text AS id FROM resource_lifecycle_events
      WHERE company_id = ${f.companyId} AND resource_type = 'agent_runtime' AND resource_id = ${agentId}`))[0]!.id ?? 0);
    const change = async (label: string, write: (tx: Db) => Promise<unknown>) => {
      const readerBefore = await latest(f.peerIds[3]!);
      const rows = await db.transaction(async tx => {
        await write(tx as unknown as Db);
        await write(tx as unknown as Db); // a second write in the same transaction must not add rows
        return Array.from(await tx.execute<{ resource_id: string; n: string }>(sql`SELECT resource_id::text, count(*)::text AS n FROM resource_lifecycle_events
          WHERE company_id = ${f.companyId} AND resource_type = 'agent_runtime' AND xmin::text = (txid_current() % 4294967296)::text GROUP BY resource_id`));
      });
      const readerAfter = await latest(f.peerIds[3]!);
      return { label, agents: rows.length, maxPerAgent: Math.max(...rows.map(r => Number(r.n))), readerAdvanced: readerAfter > readerBefore };
    };
    const target = f.peerIds[5]!;
    const results = [
      await change("agent membership", tx => tx.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: target,
        status: "active", membershipRole: "member" }).onConflictDoUpdate({ target: [companyMemberships.companyId, companyMemberships.principalType, companyMemberships.principalId],
        set: { membershipRole: sql`CASE WHEN ${companyMemberships.membershipRole} = 'member' THEN 'viewer' ELSE 'member' END` } })),
      await change("agent grant", tx => tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: target,
        permissionKey: "tasks:assign" }).onConflictDoNothing()),
      await change("user grant", tx => tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.boardUserId,
        permissionKey: "tasks:assign" }).onConflictDoNothing()),
    ];
    evidence("D_EXACTLY_ONCE", { activeAgents: active.length, results });
    for (const result of results) {
      expect(result.agents, result.label).toBe(active.length);
      expect(result.maxPerAgent, result.label).toBe(1);
      expect(result.readerAdvanced, result.label).toBe(true);
    }
  }, 60_000);

  it("RED d2: a company-wide write cannot commit an agent revision ahead of that agent's open revision (inbox order)", async () => {
    const f = await fixture(3);
    const agentId = f.peerIds[1]!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let writerRevision = 0;
    const writer = db.transaction(async tx => {
      await tx.update(agents).set({ title: `t-${randomUUID()}` }).where(eq(agents.id, agentId));
      writerRevision = Number((await tx.execute<{ id: string }>(sql`SELECT max(id)::text AS id FROM resource_lifecycle_events WHERE resource_id = ${agentId}`))[0]!.id);
      await gate;
    });
    while (!writerRevision) await sleep(5);
    let grantCommitted = false;
    const grant = db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.boardUserId,
      permissionKey: "tasks:assign" }).then(() => { grantCommitted = true; });
    await sleep(300);
    const committedWhileWriterOpen = grantCommitted;
    release();
    await writer; await grant;
    const ids = Array.from(await db.execute<{ id: string }>(sql`SELECT id::text FROM resource_lifecycle_events WHERE resource_id = ${agentId} ORDER BY id`)).map(r => Number(r.id));
    evidence("D2_ORDER", { writerRevision, committedWhileWriterOpen, revisions: ids });
    expect(committedWhileWriterOpen).toBe(false);
    expect(ids.at(-1)!).toBeGreaterThan(writerRevision);
  }, 60_000);

  async function failMemberships(companyId: string, failures: number, code: string) {
    const name = `fail_${companyId.replace(/-/g, "")}`;
    await db.execute(sql.raw(`CREATE SEQUENCE ${name}_n; CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.company_id = '${companyId}' AND NEW.principal_type = 'agent' AND nextval('${name}_n') <= ${failures}
      THEN RAISE EXCEPTION 'injected membership failure' USING ERRCODE = '${code}'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON company_memberships FOR EACH ROW EXECUTE FUNCTION ${name}();`));
    return {
      attempts: async () => Number((await db.execute<{ n: string }>(sql.raw(`SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS n FROM ${name}_n`)))[0]!.n),
      stop: async () => db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON company_memberships; DROP FUNCTION IF EXISTS ${name}(); DROP SEQUENCE IF EXISTS ${name}_n;`)),
    };
  }

  it("RED f: a membership insert failing once inside the create leaves no agent; a repeated POST leaves exactly one", async () => {
    const f = await fixture(3);
    const payload = { name: "Atomic hire", role: "engineer", reportsTo: f.hirer.id, adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } };
    const fault = await failMemberships(f.companyId, 1, "P0001");
    let first: request.Response;
    try { first = await request(f.agentApp).post(`/api/companies/${f.companyId}/agents`).send(payload); } finally { await fault.stop(); }
    const afterFailure = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.name, payload.name)));
    const second = await request(f.agentApp).post(`/api/companies/${f.companyId}/agents`).send(payload);
    const afterRetry = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, f.companyId), sql`${agents.name} LIKE 'Atomic hire%'`));
    const grants = await grantsOf(f.companyId, afterRetry.map(a => a.id));
    evidence("F_ATOMIC", { firstStatus: first!.status, agentsAfterFailure: afterFailure.length, secondStatus: second.status, agentsAfterRetry: afterRetry.length, grants });
    expect(first!.status).toBe(500);
    expect(afterFailure).toHaveLength(0);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(afterRetry).toHaveLength(1);
    expect(Object.values(grants.memberships)).toEqual([1]);
    expect(Object.values(grants.assign)).toEqual([1]);
  }, 60_000);

  for (const route of ["agents", "agent-hires"] as const) {
    it(`RED x1 (/${route}): five straight grant deadlocks commit nothing and answer the named 503`, async () => {
      const f = await fixture(3);
      const before = await activeAgentCount(f.companyId);
      const fault = await failMemberships(f.companyId, 100, "40P01");
      let response: request.Response; let attempts: number;
      try {
        response = await request(f.agentApp).post(`/api/companies/${f.companyId}/${route}`).send({ name: `Exhausted ${route}`, role: "engineer",
          reportsTo: f.hirer.id, adapterType: "process" });
        attempts = await fault.attempts();
      } finally { await fault.stop(); }
      const afterCount = await activeAgentCount(f.companyId);
      evidence("X1_EXHAUSTION", { route, status: response!.status, body: response!.body, attempts: attempts!, agentDelta: afterCount - before });
      expect(response!.status).toBe(503);
      expect(response!.body.code).toBe("agent_hire_grant_contention");
      expect(attempts!).toBe(5);
      expect(afterCount - before).toBe(0);
    }, 60_000);
  }

  it("RED x2: a concurrent grant writer cannot deadlock the hire transaction", async () => {
    const companyId = randomUUID();
    const low = `1${companyId.slice(1, 8)}-0000-4000-8000-000000000001`;
    const high = `f${companyId.slice(1, 8)}-0000-4000-8000-000000000001`;
    const child = `8${companyId.slice(1, 8)}-0000-4000-8000-000000000001`;
    await db.insert(companies).values({ id: companyId, name: "Lock order", issuePrefix: `LO${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(agents).values([
      { id: low, companyId, name: "Earlier child", role: "engineer", adapterType: "process" },
      { id: high, companyId, name: "Hiring agent", role: "general", adapterType: "process" },
    ]);
    let grant: Promise<unknown> | undefined; let grantError: unknown; let hireError: unknown; let blocked = false;
    try {
      await db.transaction(async tx => {
        await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '100ms'"));
        const txDb = tx as unknown as Db;
        await lockAccountingCompany(txDb, companyId);
        const prepared = await prepareAgentHire(txDb, companyId, { id: child, name: "New child", role: "engineer", adapterType: "process",
          adapterConfig: {}, runtimeConfig: {}, reportsTo: high }, { createdByAgentId: high, runnerResolved: true });
        const [owner] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        grant = db.transaction(async grantTx => {
          const access = accessService(grantTx as unknown as Db);
          await access.ensureMembership(companyId, "agent", low, "member", "active");
          await access.setPrincipalPermission(companyId, "agent", low, "tasks:assign", true, null);
        }).catch(error => { grantError = error; });
        const started = Date.now();
        while (Date.now() - started < 2_000) {
          if ((await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE ${owner!.pid} = ANY(pg_blocking_pids(pid))`)).length) { blocked = true; break; }
          await sleep(10);
        }
        const [created] = await tx.insert(agents).values({ ...prepared, companyId } as typeof agents.$inferInsert).returning();
        await initializeAgentHire(txDb, created!, { memberGrant: { grantedByUserId: null } });
      });
    } catch (error) { hireError = error; } finally { await grant; }
    const childRows = await db.select().from(agents).where(eq(agents.id, child));
    evidence("X2_LOCK_ORDER", { grantBlockedBehindHire: blocked, hireSqlState: pgCode(hireError), grantSqlState: pgCode(grantError), childCommitted: childRows.length });
    expect(blocked).toBe(true);
    expect(pgCode(hireError)).toBeNull();
    expect(grantError).toBeUndefined();
    expect(childRows).toHaveLength(1);
  }, 30_000);

  it("RED x3: a pending Muse verification is never woken from a grant attempt that rolls back", async () => {
    const f = await fixture(1);
    const runId = randomUUID();
    await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, context_snapshot) VALUES (${runId}, ${f.companyId}, ${f.hirer.id}, 'running', '{}'::jsonb)`);
    const runApp = (() => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => { req.actor = { type: "agent", agentId: f.hirer.id, companyId: f.companyId, runId, source: "agent_jwt" } as Express.Request["actor"]; next(); });
      a.use("/api", agentRoutes(db));
      a.use(errorHandler);
      return a;
    })();
    const payload = { name: "Muse replay", role: "engineer", reportsTo: f.hirer.id, adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } };
    const created = await request(runApp).post(`/api/companies/${f.companyId}/agents`).send(payload);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = created.body.id as string;
    // A hire left half set up before #20805: no membership, a pending Muse verification.
    await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, agentId)));
    await db.insert(museAgentBindings).values({ companyId: f.companyId, agentId, operatorId: f.boardUserId, pairedAt: new Date(), receiverContactAt: new Date() });
    const fault = await failMemberships(f.companyId, 2, "40P01");
    const perRequest: Array<{ status: number; intents: number }> = [];
    let intents = 0;
    const unsubscribe = subscribeDatabaseWork(db, "muse-maintenance", event => { if (event === "intent") intents++; });
    try {
      for (let i = 0; i < 3 && perRequest.at(-1)?.status !== 200; i++) {
        const before = intents;
        const replay = await request(runApp).post(`/api/companies/${f.companyId}/agents`).send(payload);
        perRequest.push({ status: replay.status, intents: intents - before });
      }
    } finally { unsubscribe(); await fault.stop(); }
    const grants = await grantsOf(f.companyId, [agentId]);
    evidence("X3_MUSE", { perRequest, totalIntents: intents, grants });
    expect(perRequest.at(-1)!.status).toBe(200);
    expect(perRequest.filter(r => r.status !== 200).every(r => r.intents === 0)).toBe(true);
    expect(intents).toBe(1);
    expect(grants.memberships[agentId]).toBe(1);
  }, 60_000);

  it("RED w: company default grants that keep deadlocking defer with the named warning; the create stands, complete", async () => {
    const f = await fixture(1);
    const [ceo] = await db.insert(agents).values({ companyId: f.companyId, name: "Root CEO", role: "ceo", adapterType: "process" }).returning();
    const name = `defer_${f.companyId.replace(/-/g, "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.principal_id = '${ceo!.id}' AND NEW.permission_key = 'skills:create' THEN
        RAISE EXCEPTION 'injected default grant deadlock' USING ERRCODE = '40P01'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON principal_permission_grants FOR EACH ROW EXECUTE FUNCTION ${name}();`));
    let response: request.Response;
    try {
      response = await request(f.agentApp).post(`/api/companies/${f.companyId}/agents`).send({ name: "Deferred defaults", role: "engineer",
        reportsTo: f.hirer.id, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON principal_permission_grants; DROP FUNCTION IF EXISTS ${name}();`));
    }
    const agentId = response!.body?.id as string | undefined;
    const grants = agentId ? await grantsOf(f.companyId, [agentId]) : null;
    evidence("W_DEFERRED", { status: response!.status, warnings: response!.body?.warnings ?? null, error: response!.body?.error ?? null, grants });
    expect(response!.status, JSON.stringify(response!.body)).toBe(201);
    expect(response!.body.warnings).toEqual([expect.objectContaining({ code: "company_default_grants_deferred" })]);
    expect(grants!.memberships[agentId!]).toBe(1);
    expect(grants!.assign[agentId!]).toBe(1);
  }, 60_000);

  it("behaviour kept (audit e): a pending-approval hire still gets membership + tasks:assign stamped with the board user, but not the standard grants", async () => {
    const f = await fixture(1);
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, f.companyId));
    const response = await request(f.boardApp).post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "Pending hire", role: "engineer",
      adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const agentId = response.body.agent.id as string;
    expect(response.body.agent.status).toBe("pending_approval");
    const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, agentId)));
    const grants = await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.principalId, agentId)));
    evidence("E_BEHAVIOUR", { membership: membership ? { status: membership.status, role: membership.membershipRole } : null,
      grants: grants.map(g => ({ key: g.permissionKey, grantedByUserId: g.grantedByUserId })) });
    expect(membership).toMatchObject({ status: "active", membershipRole: "member" });
    expect(grants.map(g => ({ key: g.permissionKey, grantedByUserId: g.grantedByUserId }))).toEqual([{ key: "tasks:assign", grantedByUserId: f.boardUserId }]);
  }, 60_000);

  it("RED e2 (the 0356/0354 deadlock as SQL, two sessions): hirer row then grant vs a concurrent grant", async () => {
    const f = await fixture(5);
    let stepB!: () => void; const bMayInsert = new Promise<void>(r => { stepB = r; });
    const codes: Array<string | null> = [null, null];
    const a = db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
      await tx.execute(sql`SELECT id FROM agents WHERE id = ${f.hirer.id} FOR NO KEY UPDATE`); // the hirer row (agent-interaction-policy)
      stepB();
      await sleep(300); // B's grant is now waiting inside its trigger
      await tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.peerIds[0]!, permissionKey: "tasks:assign" });
    }).catch(error => { codes[0] = pgCode(error); });
    const b = (async () => {
      await bMayInsert;
      await db.transaction(async tx => {
        await tx.execute(sql.raw("SET LOCAL deadlock_timeout = '50ms'"));
        await tx.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.boardUserId, permissionKey: "tasks:assign" });
      }).catch(error => { codes[1] = pgCode(error); });
    })();
    await Promise.all([a, b]);
    evidence("G_TWO_SESSION", { codes });
    expect(codes).not.toContain("40P01");
  }, 30_000);

  // src8 (RFL + review-fleet-2 joint addendum 06:43Z, R2): no such test existed in
  // 0d98310e..19ca9806 (no setupAgentId/setupId in this file or the lock-order file).
  it("R2 RED setup completion: a board New Agent dialog completion (setupAgentId, sent twice) racing a 10-wide agent-key hire burst: 0 deadlocks, the draft completes exactly once", async () => {
    const f = await fixture(20);
    const setupId = randomUUID();
    const setup = await request(f.boardApp).post(`/api/companies/${f.companyId}/agents`).send({ setupId, name: "Dialog draft", adapterType: "process" });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    const before = { agents: await activeAgentCount(f.companyId), deadlocks: await deadlocks() };
    const completion = () => request(f.boardApp).post(`/api/companies/${f.companyId}/agent-hires`).send({ setupAgentId: setupId, name: "Dialog draft",
      role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    const hires = Array.from({ length: 10 }, (_, i) => request(f.agentApp).post(`/api/companies/${f.companyId}/agents`).send({ name: `Burst ${i}`,
      role: "engineer", reportsTo: f.hirer.id, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }));
    const [first, second, ...burstResults] = await Promise.all([completion(), completion(), ...hires]);
    const after = { agents: await activeAgentCount(f.companyId), deadlocks: await deadlocks() };
    const [draft] = await db.select().from(agents).where(eq(agents.id, setupId));
    const grants = await grantsOf(f.companyId, [setupId]);
    const completions = [first!, second!].map(r => ({ status: r.status, idempotent: r.body?.idempotent ?? null, agentId: r.body?.agent?.id ?? null }));
    evidence("R2_SETUP_COMPLETION_BURST", { completions, burst: burstResults.map(r => r.status), deadlockDelta: after.deadlocks - before.deadlocks,
      agentDelta: after.agents - before.agents, holds: draft?.lifecycleHolds, memberships: grants.memberships[setupId], assign: grants.assign[setupId] });
    expect(after.deadlocks - before.deadlocks).toBe(0);
    expect(burstResults.map(r => r.status)).toEqual(Array(10).fill(201));
    expect(after.agents - before.agents).toBe(10);
    // Exactly once: one completion creates (201); the other replays it (200, idempotent).
    expect(completions.map(c => c.status).sort()).toEqual([200, 201]);
    expect(completions.find(c => c.status === 200)?.idempotent).toBe(true);
    expect(completions.every(c => c.agentId === setupId)).toBe(true);
    expect(draft?.lifecycleHolds ?? []).not.toContain("setup");
    expect(grants.memberships[setupId]).toBe(1);
    expect(grants.assign[setupId]).toBe(1);
  }, 90_000);
});
