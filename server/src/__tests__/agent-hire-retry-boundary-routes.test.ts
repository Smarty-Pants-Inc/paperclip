import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  approvals,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
  resourceLifecycleEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";
import { AGENT_HIRE_ATTEMPTS, AgentHireContentionError, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { agentRoutes } from "../routes/agents.js";
import { ACCOUNTING_WRITE_CONTENTION_MESSAGE, AccountingContentionError } from "../services/accounting-transaction.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { secretService } from "../services/secrets.js";
import { transactionRetryStats } from "../services/transaction-retry.js";
import { logger } from "../middleware/logger.js";

// #20389 on the M2hall image line (review-fleet-2 06:37Z): the retry sits in two different places on hire.
//  (a) The CREATE transaction is the lifecycle's: ONE attempt (ctl6). A persistent 40P01 there reaches the caller
//      as the hire-specific named retryable error (HTTP 503, code agent_hire_create_contention) and
//      keeps the database error only in `cause`.
//      RFL 07:45Z 11-16: distinct named hire codes
//      writes nothing: no agent, no binding, no activity, no event.
//  (b) SUPERSEDED BY REPLACEMENT (RFL, #20805 x #20389): the GRANT step (membership + tasks:assign) now runs
//      INSIDE the hire transaction (#20805 F2), so a grant fault is injected where the grant writes (a 40P01
//      raised by the new agent's membership insert), not at the end of a separate post-commit transaction. The
//      hire's ONE retry wrapper (retryTransientLockContention, five attempts) retries it; exhausted, the caller
//      gets the distinct named 503 agent_hire_grant_contention, and the WHOLE hire rolled back (review-fleet-2
//      07:43Z): no agent, membership, grant, activity or event.
//  R2: a transient 40P01 in the grant step is retried by that wrapper (same injection as (b)); nothing is
//      published from a rolled-back attempt and each activity is published exactly once.
//  R4 (RFL check row): a 10-wide concurrent hire burst through the route gives 10 x 201, no 5xx, no duplicate agent.
//  REAL R2 / REAL R3(b) (RFL 10:04Z): the same two rows with a REAL two-session deadlock on the new agent's
//      membership INSERT (realGrantDeadlocks; PostgreSQL's deadlock detector, counted in pg_stat_database). They
//      prove grantNewAgentMembership's identity mark survives the real driver path; the injected R3(b) asserts the
//      same error classes and failing statement (REAL_AND_INJECTED_GRANT_CONTENTION_CHAIN, failedQuery).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping agent hire retry boundary tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Db = ReturnType<typeof createDb>;
const HIRED = "Retry boundary hire";

async function seedHiringFixture(db: Db, runs = 1) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `Retry boundary ${nonce}`,
    issuePrefix: `RB${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
    requireBoardApprovalForNewAgents: false,
  }).returning();
  const [hiringAgent] = await db.insert(agents).values({
    companyId: company!.id, name: "Chief Of Staff", role: "general", adapterType: "process",
    adapterConfig: {}, runtimeConfig: {}, permissions: { canCreateAgents: true },
  }).returning();
  await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "agent", principalId: hiringAgent!.id,
    membershipRole: "member", status: "active" });
  await db.insert(principalPermissionGrants).values({ companyId: company!.id, principalType: "agent",
    principalId: hiringAgent!.id, permissionKey: "agents:create" });
  const runRows = await db.insert(heartbeatRuns).values(Array.from({ length: runs }, () => ({
    companyId: company!.id, agentId: hiringAgent!.id, status: "running" as const, contextSnapshot: {},
  }))).returning();
  return { company: company!, hiringAgent: hiringAgent!, runs: runRows };
}

function createApp(db: Db, actor: Express.Request["actor"], thrown: unknown[] = []) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", agentRoutes(db));
  app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
    thrown.push(error);
    next(error);
  });
  app.use(errorHandler);
  return app;
}

const agentActor = (companyId: string, agentId: string, runId: string): Express.Request["actor"] =>
  ({ type: "agent", agentId, companyId, runId, source: "agent_jwt" });

/** Root transactions of `db`; after its work, a transaction for which `fault(tx)` is true raises a real 40P01. */
function faultingDb(db: Db, fault: (tx: Db) => Promise<boolean>) {
  const state = { faults: 0 };
  const wrapped = new Proxy(db, { get(target, key, receiver) {
    if (key === "transaction") return (async (work: (tx: Db) => Promise<unknown>, options?: unknown) =>
      target.transaction(async (tx) => {
        const value = await work(tx as unknown as Db);
        if (await fault(tx as unknown as Db)) {
          state.faults++;
          await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced deadlock' USING ERRCODE = '40P01'; END $$`);
        }
        return value;
      }, options as never)) as unknown as Db["transaction"];
    return Reflect.get(target, key, receiver);
  } });
  return { wrapped: wrapped as Db, state };
}

/**
 * #20805 x #20389: the grant step runs inside the hire transaction, so the grant fault is raised where the grant
 * writes: the new agent's membership insert (any agent principal in `companyId` other than `exceptPrincipalId`)
 * raises a real 40P01 for its first `failedAttempts` attempts. `faults()` counts them across rolled-back attempts.
 */
async function forceHireGrantDeadlocks(db: Db, companyId: string, exceptPrincipalId: string, failedAttempts: number) {
  await db.execute(sql.raw(`
    CREATE SEQUENCE agent_hire_grant_fault_attempts;
    CREATE FUNCTION agent_hire_grant_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.company_id = '${companyId}' AND NEW.principal_type = 'agent' AND NEW.principal_id <> '${exceptPrincipalId}'
        AND nextval('agent_hire_grant_fault_attempts') <= ${failedAttempts} THEN
        RAISE EXCEPTION 'forced agent hire grant deadlock' USING ERRCODE = '40P01';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER agent_hire_grant_fault BEFORE INSERT ON company_memberships
      FOR EACH ROW EXECUTE FUNCTION agent_hire_grant_fault();
  `));
  return {
    faults: async () => {
      const result = await db.execute(sql.raw("SELECT last_value, is_called FROM agent_hire_grant_fault_attempts")) as unknown as
        { last_value: string | number; is_called: boolean }[] | { rows: { last_value: string | number; is_called: boolean }[] };
      const row = (Array.isArray(result) ? result : result.rows)[0]!;
      return row.is_called ? Math.min(Number(row.last_value), failedAttempts) : 0;
    },
  };
}

/** The grant step's exhausted contention as the route receives it, for a real 40P01 AND the injected one: the
 * wrapper's named error, #20389's lifecycleTransaction wrapper, drizzle's query error (the object
 * grantNewAgentMembership marks), postgres.js's server error. */
const REAL_AND_INJECTED_GRANT_CONTENTION_CHAIN = [
  { name: "AgentHireContentionError", code: "40P01" },
  { name: "AccountingContentionError", code: "40P01" },
  { name: "DrizzleQueryError", code: undefined },
  { name: "PostgresError", code: "40P01" },
];

/** The SQL text drizzle attached to the failing statement's error, if any. */
const failedQuery = (error: unknown) => {
  for (let cause = error as { query?: unknown; cause?: unknown } | undefined, depth = 0; cause && typeof cause === "object" && depth < 6;
    cause = cause.cause as typeof cause, depth++) if (typeof cause.query === "string") return cause.query;
  return undefined;
};

/** Class and SQLSTATE of each error in the `cause` chain, outermost first. */
const errorChain = (error: unknown) => {
  const chain: { name: string; code?: unknown }[] = [];
  for (let cause = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; cause && typeof cause === "object" && depth < 6;
    cause = cause.cause as typeof cause, depth++) chain.push({ name: cause.constructor?.name ?? "?", code: cause.code });
  return chain;
};

/**
 * RFL 10:04Z (#20805 F4): a REAL two-session 40P01 on the new agent's membership insert, no trigger, no JS throw.
 * A second session (`opponent`) holds SHARE on company_memberships, so the hire's membership INSERT (ROW EXCLUSIVE)
 * waits on it; once PostgreSQL shows that INSERT blocked by the opponent, the opponent asks for the company runtime
 * advisory lock the hire holds (lockCompanyAgentRuntime, exclusive, until commit). That is a genuine wait cycle. The
 * opponent's deadlock_timeout is 60s, so the hire's backend (waiting first, server default) runs the deadlock check
 * and is the victim: "deadlock detected" (40P01) raised by its membership INSERT. The opponent then gets the lock,
 * releases it at once (session-level lock) and keeps its SHARE for the next round. After `rounds` deadlocks it
 * commits. Each round is one hire attempt, observed in pg_stat_activity.
 */
function realGrantDeadlocks(connectionString: string, companyId: string, rounds: number) {
  const opponent = createDb(connectionString);
  const observed: { pid: number; waitEvent: string; lock: string }[] = [];
  const companyLock = sql`hashtextextended('paperclip.connector_runtime:' || ${companyId}::uuid::text, 0)`;
  const rowsOf = <T,>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
  let holding!: () => void;
  const holdingShare = new Promise<void>(resolve => { holding = resolve; });
  const done = opponent.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL deadlock_timeout = '60s'`);
    await tx.execute(sql`LOCK TABLE company_memberships IN SHARE MODE`);
    holding();
    for (let round = 0; round < rounds; round++) {
      // The hire's backend waiting for ROW EXCLUSIVE on company_memberships (the lock its membership INSERT takes
      // first), blocked by this session. pg_stat_activity.query is not used: under the extended protocol it still
      // shows the backend's previous statement while the INSERT waits during parse analysis.
      let waiter: { pid: number; mode: string; wait_event: string } | undefined;
      for (const started = Date.now(); !waiter; ) {
        // pg_stat_activity is snapshotted once per transaction; this poll runs in one, so clear it every time.
        await tx.execute(sql`SELECT pg_stat_clear_snapshot()`);
        if (Date.now() - started > 30_000) {
          const activity = rowsOf(await tx.execute(sql`SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
            left(query, 120) AS query, datname, backend_type, application_name FROM pg_stat_activity WHERE pid <> pg_backend_pid()`));
          throw new Error(`round ${round + 1}: the hire never blocked on its membership insert: ${JSON.stringify(activity)}`);
        }
        waiter = rowsOf<{ pid: number; mode: string; wait_event: string }>(await tx.execute(sql`
          SELECT l.pid, l.mode, a.wait_event FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND l.locktype = 'relation' AND l.relation = 'company_memberships'::regclass
            AND l.pid <> pg_backend_pid() AND pg_backend_pid() = ANY(pg_blocking_pids(l.pid))`))[0];
        if (!waiter) await new Promise(resolve => setTimeout(resolve, 25));
      }
      observed.push({ pid: waiter.pid, waitEvent: waiter.wait_event, lock: `${waiter.mode} on company_memberships` });
      // Close the cycle: wait for the company lock the blocked hire holds until its transaction ends.
      await tx.execute(sql`SELECT pg_advisory_lock(${companyLock})`);
      await tx.execute(sql`SELECT pg_advisory_unlock(${companyLock})`);
    }
  });
  return {
    observed, holdingShare,
    finish: async () => { try { await done; } finally { await opponent.$client.end({ timeout: 5 }); } },
  };
}

/** The hire wrapper's own retry log lines (onRetry: attempt N rolled back, retrying), as {attempt, sqlState}. */
function spyHireRetryLog() {
  const warn = vi.spyOn(logger, "warn");
  let kept: { attempt: number; sqlState: string }[] | undefined;
  const read = () => warn.mock.calls.filter(call => call[1] === "Agent hire grant step hit lock contention; retrying the hire transaction")
    .map(call => ({ attempt: (call[0] as { attempt: number }).attempt, sqlState: (call[0] as { sqlState: string }).sqlState }));
  return {
    lines: () => kept ?? read(),
    // mockRestore clears mock.calls: keep the lines first.
    restore: () => { kept = read(); warn.mockRestore(); },
  };
}

async function databaseDeadlocks(db: Db) {
  const result = await db.execute(sql`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`) as unknown;
  const rows = (Array.isArray(result) ? result : (result as { rows: { deadlocks: string | number }[] }).rows) as
    { deadlocks: string | number }[];
  return Number(rows[0]!.deadlocks);
}

/** pg_stat_database is flushed asynchronously; wait until PostgreSQL itself has counted `expected` deadlocks. */
async function waitForDatabaseDeadlocks(db: Db, expected: number) {
  let seen = await databaseDeadlocks(db);
  for (const started = Date.now(); seen < expected && Date.now() - started < 15_000; seen = await databaseDeadlocks(db)) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return seen;
}

const sqlStates = (error: unknown) => {
  const codes: string[] = [];
  for (let cause = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; cause && typeof cause === "object" && depth < 6;
    cause = cause.cause as typeof cause, depth++) if (typeof cause.code === "string") codes.push(cause.code);
  return codes;
};

describeEmbeddedPostgres("agent hire retry boundary (#20389 on M2hall, R3/R4)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-hire-retry-boundary-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-retry-boundary-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS agent_hire_grant_fault ON company_memberships"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS agent_hire_grant_fault()"));
    await db.execute(sql.raw("DROP SEQUENCE IF EXISTS agent_hire_grant_fault_attempts"));
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(resourceLifecycleEvents);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  /** True inside the transaction that created the hired agent row. */
  const createsHiredAgent = (companyId: string) => async (tx: Db) =>
    (await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, HIRED)))).length > 0;

  it("R3(a) agent-hires, inherited secret binding: the failed create writes no binding; the caller's own retry writes it once", async () => {
    const { company, hiringAgent, runs } = await seedHiringFixture(db);
    const secret = await secretService(db).create(company.id, { name: `cred-${randomUUID()}`, provider: "local_encrypted",
      value: "sk-openai-parent" });
    await db.update(agents).set({ adapterType: "codex_local",
      adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id } } } }).where(eq(agents.id, hiringAgent.id));
    const actor = agentActor(company.id, hiringAgent.id, runs[0]!.id);
    const payload = { name: HIRED, role: "engineer", reportsTo: hiringAgent.id, adapterType: "codex_local" };
    const childBindings = async () => (await db.select({ id: companySecretBindings.id }).from(companySecretBindings)
      .innerJoin(agents, sql`${agents.id}::text = ${companySecretBindings.targetId}`)
      .where(and(eq(companySecretBindings.companyId, company.id), eq(agents.name, HIRED))));
    const bindingsBefore = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, company.id));
    const { wrapped, state } = faultingDb(db, createsHiredAgent(company.id));
    const thrown: unknown[] = [];
    const failed = await request(createApp(wrapped, actor, thrown)).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(state.faults).toBe(1);
    expect(failed.status, JSON.stringify(failed.body)).toBe(503);
    expect(failed.body.code).toBe("agent_hire_create_contention");
    expect(thrown[0]).toBeInstanceOf(HttpError);
    expect(thrown[0]).toMatchObject({ status: 503, code: "agent_hire_create_contention", retryable: true, attempts: 1 });
    expect(sqlStates(thrown[0])).toContain("40P01");
    expect(await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.name, HIRED)))).toHaveLength(0);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, company.id)))
      .toHaveLength(bindingsBefore.length);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, company.id),
      eq(activityLog.action, "agent.hire_created")))).toHaveLength(0);
    // Control: the same request without the fault derives exactly one child binding, so "0" above is meaningful.
    const retried = await request(createApp(db, actor)).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(await childBindings()).toHaveLength(1);
  }, 60_000);

  it("non-hire lifecycle callers retain upstream AccountingContentionError unchanged", async () => {
    const { company } = await seedHiringFixture(db);
    const effects = createAgentLifecycleEffects();
    const failed = effects.transaction(db, company.id, async tx => {
      await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced deadlock' USING ERRCODE = '40P01'; END $$`);
    });
    await expect(failed).rejects.toBeInstanceOf(AccountingContentionError);
    await expect(failed).rejects.toMatchObject({ status: 503, code: "40P01", attempts: 1 });
  });

  for (const route of ["agent-hires", "agents"] as const) {
    it(`R3(a) ${route}: a persistent 40P01 in the create transaction is one attempt, a named 503, and writes nothing`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db);
      const resourceEvents = () => db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, company.id));
      const resourceEventsBefore = await resourceEvents();
      const { wrapped, state } = faultingDb(db, createsHiredAgent(company.id));
      const thrown: unknown[] = [];
      const app = createApp(wrapped, agentActor(company.id, hiringAgent.id, runs[0]!.id), thrown);
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(company.id, event => { events.push(event); });
      try {
        const response = await request(app).post(`/api/companies/${company.id}/${route}`).send({
          name: HIRED, role: "engineer", reportsTo: hiringAgent.id, adapterType: "process",
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        });
        expect(state.faults, "one attempt: the lifecycle create transaction is not retried internally").toBe(1);
        expect(response.status, JSON.stringify(response.body)).toBe(503);
        expect(response.body).toMatchObject({ error: ACCOUNTING_WRITE_CONTENTION_MESSAGE, code: "agent_hire_create_contention",
          details: { retryable: true } });
        expect(thrown).toHaveLength(1);
        expect(thrown[0]).toBeInstanceOf(HttpError);
        expect(thrown[0]).toMatchObject({ status: 503, code: "agent_hire_create_contention", retryable: true, attempts: 1 });
        expect(sqlStates(thrown[0])).toContain("40P01");
      } finally { unsubscribe(); }
      const hired = await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.name, HIRED)));
      expect(hired).toHaveLength(0);
      expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
      expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, company.id))).toHaveLength(0);
      expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id),
        ne(companyMemberships.principalId, hiringAgent.id)))).toHaveLength(0);
      expect(await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, company.id),
        ne(principalPermissionGrants.principalId, hiringAgent.id)))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).toHaveLength(0);
      expect(await resourceEvents(), "no resource lifecycle event for the hire").toEqual(resourceEventsBefore);
      expect(events).toEqual([]);
    }, 60_000);

    it(`R3(b) ${route}: a persistent 40P01 in the grant step exhausts the hire's five attempts: named 503 agent_hire_grant_contention, nothing written`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db);
      const resourceEvents = () => db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, company.id));
      const resourceEventsBefore = await resourceEvents();
      const fault = await forceHireGrantDeadlocks(db, company.id, hiringAgent.id, 1_000);
      const thrown: unknown[] = [];
      const app = createApp(db, agentActor(company.id, hiringAgent.id, runs[0]!.id), thrown);
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(company.id, event => { events.push(event); });
      try {
        const response = await request(app).post(`/api/companies/${company.id}/${route}`).send({
          name: HIRED, role: "engineer", reportsTo: hiringAgent.id, adapterType: "process",
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        });
        expect(await fault.faults(), "the hire's one retry wrapper: five attempts").toBe(AGENT_HIRE_ATTEMPTS);
        expect(response.status, JSON.stringify(response.body)).not.toBe(500);
        expect(response.body.error).not.toBe("Internal server error");
        expect(response.status, JSON.stringify(response.body)).toBe(503);
        // SUPERSEDED (RFL, #20805 x #20389): the grant step's own named code, distinct from the create step's.
        expect(response.body).toMatchObject({ code: "agent_hire_grant_contention", details: { retryable: true } });
        expect(response.body.code).not.toBe("agent_hire_create_contention");
        expect(thrown).toHaveLength(1);
        expect(thrown[0]).toBeInstanceOf(AgentHireContentionError);
        expect(thrown[0]).toMatchObject({ status: 503, code: "40P01", attempts: AGENT_HIRE_ATTEMPTS });
        expect(sqlStates(thrown[0])).toContain("40P01");
        // RFL 10:04Z (2): the injected 40P01 reaches the wrapper through the same classes as a real one (REAL R3(b) below).
        console.info(`[injected 40P01 ${route}]`, JSON.stringify({ errorChain: errorChain(thrown[0]),
          failedStatement: failedQuery(thrown[0])?.slice(0, 60) }));
        expect(errorChain(thrown[0])).toEqual(REAL_AND_INJECTED_GRANT_CONTENTION_CHAIN);
        expect(failedQuery(thrown[0])).toMatch(/^insert into "company_memberships"/);
      } finally { unsubscribe(); }
      // The grant runs inside the hire transaction: the whole hire rolled back (review-fleet-2 07:43Z).
      expect(await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.name, HIRED)))).toHaveLength(0);
      expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
      expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id),
        ne(companyMemberships.principalId, hiringAgent.id)))).toHaveLength(0);
      expect(await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, company.id),
        ne(principalPermissionGrants.principalId, hiringAgent.id)))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).toHaveLength(0);
      expect(await resourceEvents(), "no resource lifecycle event for the hire").toEqual(resourceEventsBefore);
      expect(events).toEqual([]);
    }, 60_000);

    it(`R2 ${route}: a transient 40P01 in the grant step is retried; each activity is published once, after commit`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db);
      // SUPERSEDED (RFL, #20805 x #20389): the grant fault is raised by the grant write inside the hire transaction.
      const fault = await forceHireGrantDeadlocks(db, company.id, hiringAgent.id, 2);
      const app = createApp(db, agentActor(company.id, hiringAgent.id, runs[0]!.id));
      const events: { action: unknown; entityId: unknown }[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(company.id, event => {
        if (event.type === "activity.logged") events.push({ action: event.payload.action, entityId: event.payload.entityId });
      });
      let response;
      try {
        response = await request(app).post(`/api/companies/${company.id}/${route}`).send({
          name: HIRED, role: "engineer", reportsTo: hiringAgent.id, adapterType: "process",
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        });
      } finally { unsubscribe(); }
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(await fault.faults()).toBe(2);
      const hired = await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.name, HIRED)));
      expect(hired).toHaveLength(1);
      expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalId, hired[0]!.id)))).toHaveLength(1);
      expect(await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, company.id),
        eq(principalPermissionGrants.principalId, hired[0]!.id), eq(principalPermissionGrants.permissionKey, "tasks:assign")))).toHaveLength(1);
      const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
      expect(rows.length).toBeGreaterThan(0);
      expect(events).toHaveLength(rows.length);
      for (const row of rows) expect(events.filter(event => event.action === row.action && event.entityId === row.entityId)).toHaveLength(1);
    }, 60_000);

    it(`REAL R2 ${route}: a real two-session 40P01 on the new agent's membership insert is retried, then the hire succeeds`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db);
      const deadlocksBefore = await databaseDeadlocks(db);
      const retriedBefore = transactionRetryStats.retried;
      const retryLog = spyHireRetryLog();
      const real = realGrantDeadlocks(tempDb!.connectionString, company.id, 2);
      await real.holdingShare;
      const app = createApp(db, agentActor(company.id, hiringAgent.id, runs[0]!.id));
      let response;
      try {
        response = await request(app).post(`/api/companies/${company.id}/${route}`).send({
          name: HIRED, role: "engineer", reportsTo: hiringAgent.id, adapterType: "process",
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        });
      } finally { await real.finish(); retryLog.restore(); }
      const deadlocks = await waitForDatabaseDeadlocks(db, deadlocksBefore + 2);
      console.info(`[REAL R2 ${route}]`, JSON.stringify({ status: response.status, observed: real.observed,
        deadlocksCountedByPostgres: deadlocks - deadlocksBefore, wrapperRetries: transactionRetryStats.retried - retriedBefore,
        retryLog: retryLog.lines() }));
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(retryLog.lines(), "the wrapper logged attempts 1 and 2 failing with 40P01, then attempt 3 committed")
        .toEqual([{ attempt: 1, sqlState: "40P01" }, { attempt: 2, sqlState: "40P01" }]);
      // Two attempts each blocked at the membership INSERT and were deadlock victims; the third committed.
      expect(real.observed).toHaveLength(2);
      for (const blocked of real.observed) expect(blocked.lock).toBe("RowExclusiveLock on company_memberships");
      expect(deadlocks - deadlocksBefore, "PostgreSQL itself detected two real deadlocks").toBe(2);
      expect(transactionRetryStats.retried - retriedBefore, "the hire wrapper retried: attempt count 3 > 1").toBe(2);
      const hired = await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.name, HIRED)));
      expect(hired).toHaveLength(1);
      expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id),
        eq(companyMemberships.principalId, hired[0]!.id)))).toHaveLength(1);
      expect(await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, company.id),
        eq(principalPermissionGrants.principalId, hired[0]!.id), eq(principalPermissionGrants.permissionKey, "tasks:assign"))))
        .toHaveLength(1);
    }, 120_000);

    it(`REAL R3(b) ${route}: a persistent real two-session 40P01 on the membership insert: five attempts, 503 agent_hire_grant_contention, nothing written`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db);
      const resourceEvents = () => db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, company.id));
      const resourceEventsBefore = await resourceEvents();
      const deadlocksBefore = await databaseDeadlocks(db);
      const retriedBefore = transactionRetryStats.retried;
      const retryLog = spyHireRetryLog();
      const real = realGrantDeadlocks(tempDb!.connectionString, company.id, AGENT_HIRE_ATTEMPTS);
      await real.holdingShare;
      const thrown: unknown[] = [];
      const app = createApp(db, agentActor(company.id, hiringAgent.id, runs[0]!.id), thrown);
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(company.id, event => { events.push(event); });
      let response;
      try {
        response = await request(app).post(`/api/companies/${company.id}/${route}`).send({
          name: HIRED, role: "engineer", reportsTo: hiringAgent.id, adapterType: "process",
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        });
      } finally { unsubscribe(); await real.finish(); retryLog.restore(); }
      const deadlocks = await waitForDatabaseDeadlocks(db, deadlocksBefore + AGENT_HIRE_ATTEMPTS);
      console.info(`[REAL R3(b) ${route}]`, JSON.stringify({ status: response.status, code: response.body.code,
        observed: real.observed, deadlocksCountedByPostgres: deadlocks - deadlocksBefore,
        wrapperRetries: transactionRetryStats.retried - retriedBefore, retryLog: retryLog.lines(), errorChain: errorChain(thrown[0]),
        failedStatement: failedQuery(thrown[0])?.slice(0, 60) }));
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(retryLog.lines()).toEqual([1, 2, 3, 4].map(attempt => ({ attempt, sqlState: "40P01" })));
      // The statement PostgreSQL aborted (drizzle keeps it on its query error): the new agent's membership INSERT.
      expect(failedQuery(thrown[0])).toMatch(/^insert into "company_memberships"/);
      expect(response.body).toMatchObject({ code: "agent_hire_grant_contention", details: { retryable: true } });
      expect(real.observed, "five attempts, each blocked at the membership INSERT").toHaveLength(AGENT_HIRE_ATTEMPTS);
      for (const blocked of real.observed) expect(blocked.lock).toBe("RowExclusiveLock on company_memberships");
      expect(deadlocks - deadlocksBefore, "PostgreSQL itself detected five real deadlocks").toBe(AGENT_HIRE_ATTEMPTS);
      expect(transactionRetryStats.retried - retriedBefore).toBe(AGENT_HIRE_ATTEMPTS - 1);
      expect(thrown).toHaveLength(1);
      expect(thrown[0]).toBeInstanceOf(AgentHireContentionError);
      expect(thrown[0]).toMatchObject({ status: 503, code: "40P01", attempts: AGENT_HIRE_ATTEMPTS });
      // Same classes as the injected R3(b) above (RFL 10:04Z (2)); the real one's message is PostgreSQL's own.
      expect(errorChain(thrown[0])).toEqual(REAL_AND_INJECTED_GRANT_CONTENTION_CHAIN);
      let root = thrown[0] as { cause?: unknown; message?: string };
      while (root.cause) root = root.cause as typeof root;
      expect(root.message).toBe("deadlock detected");
      expect(await db.select().from(agents).where(and(eq(agents.companyId, company.id), eq(agents.name, HIRED)))).toHaveLength(0);
      expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(1);
      expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id),
        ne(companyMemberships.principalId, hiringAgent.id)))).toHaveLength(0);
      expect(await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, company.id),
        ne(principalPermissionGrants.principalId, hiringAgent.id)))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).toHaveLength(0);
      expect(await resourceEvents(), "no resource lifecycle event for the hire").toEqual(resourceEventsBefore);
      expect(events).toEqual([]);
    }, 120_000);

    it(`R4 ${route}: a 10-wide concurrent hire burst gives 10 x 201, no 5xx, no duplicate agent`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db, 10);
      const responses = await Promise.all(runs.map((run, index) =>
        request(createApp(db, agentActor(company.id, hiringAgent.id, run.id)))
          .post(`/api/companies/${company.id}/${route}`).send({
            name: `Burst hire ${index}`, role: "engineer", reportsTo: hiringAgent.id, adapterType: "process",
            adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
          }).then(response => response, error => ({ status: 0, body: { error: String(error) } }))));
      const statuses = responses.map(response => response.status);
      expect(statuses.filter(status => status >= 500), JSON.stringify(responses.map(response => response.body))).toEqual([]);
      expect(statuses, JSON.stringify(responses.filter(response => response.status !== 201).map(response => response.body)))
        .toEqual(Array(10).fill(201));
      const hired = await db.select().from(agents).where(and(eq(agents.companyId, company.id), ne(agents.id, hiringAgent.id)));
      expect(hired).toHaveLength(10);
      expect(new Set(hired.map(agent => agent.name)).size).toBe(10);
      expect(hired.map(agent => agent.name).sort()).toEqual(Array.from({ length: 10 }, (_, index) => `Burst hire ${index}`).sort());
      for (const agent of hired) {
        expect(await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.principalId, agent.id)))).toHaveLength(1);
        expect(await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalId, agent.id), eq(principalPermissionGrants.permissionKey, "tasks:assign")))).toHaveLength(1);
      }
    }, 120_000);
  }
});
