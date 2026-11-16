import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { agentRoutes } from "../routes/agents.js";
import { ACCOUNTING_WRITE_CONTENTION_MESSAGE, AccountingContentionError } from "../services/accounting-transaction.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { secretService } from "../services/secrets.js";

// #20389 on the M2hall image line (review-fleet-2 06:37Z): the retry sits in two different places on hire.
//  (a) The CREATE transaction is the lifecycle's: ONE attempt (ctl6). A persistent 40P01 there reaches the caller
//      as upstream's named retryable error (AccountingContentionError: HTTP 503, SQLSTATE kept in `code`) and
//      writes nothing: no agent, no binding, no activity, no event.
//  (b) The GRANT step runs AFTER the create transaction commits, inside #20805's withTransactionRetry (5 attempts).
//      When a persistent 40P01 exhausts those attempts, the caller gets a NAMED error, never a bare 500. The
//      committed agent without membership is today's behaviour (removed later by #20805's source fix), so this
//      file asserts nothing about writes there.
//  R2: a transient 40P01 in the grant step is retried by #20805's retry; nothing is published from a rolled-back
//      attempt and each activity is published exactly once.
//  R4 (RFL check row): a 10-wide concurrent hire burst through the route gives 10 x 201, no 5xx, no duplicate agent.

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
  /** True inside a transaction that gave the hired agent its company membership (the grant step). */
  const grantsHiredAgent = (companyId: string) => async (tx: Db) => {
    const result = await tx.execute(sql`
      SELECT 1 FROM ${companyMemberships} m JOIN ${agents} a ON a.id::text = m.principal_id
      WHERE m.company_id = ${companyId} AND m.principal_type = 'agent' AND a.name = ${HIRED}`) as unknown as unknown[] | { rows: unknown[] };
    return (Array.isArray(result) ? result : result.rows).length > 0;
  };

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
    expect(thrown[0]).toBeInstanceOf(AccountingContentionError);
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
        expect(response.body).toMatchObject({ error: ACCOUNTING_WRITE_CONTENTION_MESSAGE });
        expect(thrown).toHaveLength(1);
        expect(thrown[0]).toBeInstanceOf(AccountingContentionError);
        expect(thrown[0]).toMatchObject({ status: 503, code: "40P01", attempts: 1 });
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

    it(`R3(b) ${route}: a persistent 40P01 in the grant step that exhausts #20805's five attempts is a named error, not a bare 500`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db);
      const { wrapped, state } = faultingDb(db, grantsHiredAgent(company.id));
      const thrown: unknown[] = [];
      const app = createApp(wrapped, agentActor(company.id, hiringAgent.id, runs[0]!.id), thrown);
      const response = await request(app).post(`/api/companies/${company.id}/${route}`).send({
        name: HIRED, role: "engineer", reportsTo: hiringAgent.id, adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
      });
      expect(state.faults, "the grant step keeps #20805's withTransactionRetry: five attempts").toBe(5);
      expect(response.status, JSON.stringify(response.body)).not.toBe(500);
      expect(response.body.error).not.toBe("Internal server error");
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body).toMatchObject({ error: ACCOUNTING_WRITE_CONTENTION_MESSAGE });
      expect(thrown[0]).toBeInstanceOf(AccountingContentionError);
      expect(thrown[0]).toMatchObject({ code: "40P01", attempts: 5 });
    }, 60_000);

    it(`R2 ${route}: a transient 40P01 in the grant step is retried; each activity is published once, after commit`, async () => {
      const { company, hiringAgent, runs } = await seedHiringFixture(db);
      let failures = 2;
      const grants = grantsHiredAgent(company.id);
      const { wrapped, state } = faultingDb(db, async tx => failures > 0 && await grants(tx) && failures-- > 0);
      const app = createApp(wrapped, agentActor(company.id, hiringAgent.id, runs[0]!.id));
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
      expect(state.faults).toBe(2);
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
