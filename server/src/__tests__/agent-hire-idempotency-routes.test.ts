import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { transactionRetryStats } from "../services/transaction-retry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-hire idempotency route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * Seed a company, a hiring agent that carries the standard-trust
 * `canCreateAgents` permission, and a running heartbeat run for that agent. The
 * hire route authorizes the agent through the legacy `agents:create` path, and
 * the run id is what the idempotency guard keys on.
 */
async function seedHiringFixture(db: Db) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({
      name: `Idempotency Co ${nonce}`,
      issuePrefix: `ID${nonce.slice(0, 4).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
      // Direct hires (no board approval) mirror the reported QA org where the
      // duplicate "Sam 2" agent was actually created.
      requireBoardApprovalForNewAgents: false,
    })
    .returning();
  const [hiringAgent] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: "Chief Of Staff",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateAgents: true },
    })
    .returning();
  const [run] = await db
    .insert(heartbeatRuns)
    .values({
      companyId: company!.id,
      agentId: hiringAgent!.id,
      status: "running",
      contextSnapshot: {},
    })
    .returning();
  return { company: company!, hiringAgent: hiringAgent!, run: run! };
}

function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    runId,
    source: "agent_jwt",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const value = error as { code?: string; message?: string; detail?: string; where?: string; query?: string; cause?: { code?: string; message?: string; detail?: string; where?: string; query?: string } };
    console.error(`[agent-hire-route-error] ${JSON.stringify({ code: value?.cause?.code ?? value?.code ?? null, message: value?.cause?.message ?? value?.message ?? String(error), detail: value?.cause?.detail ?? value?.detail ?? null, where: value?.cause?.where ?? value?.where ?? null, query: value?.query ?? null, retried: transactionRetryStats.retried })}`);
    next(error);
  });
  app.use(errorHandler);
  return app;
}

async function authorizeAgentToCreate(db: Db, companyId: string, agentId: string) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    membershipRole: "member",
    status: "active",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    permissionKey: "agents:create",
  });
}

async function seedRootCeo(db: Db, companyId: string) {
  const [rootCeo] = await db.insert(agents).values({
    companyId,
    name: "Default-grant CEO",
    role: "ceo",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  }).returning();
  return rootCeo!;
}

async function forceDefaultGrantDeadlocks(db: Db, principalId: string, failedAttempts: number) {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) throw new Error("failedAttempts must be a positive integer");
  await db.execute(sql.raw(`
    CREATE SEQUENCE agent_hire_default_grant_deadlock_attempts;
    CREATE FUNCTION agent_hire_default_grant_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE attempt bigint;
    BEGIN
      IF NEW.principal_id = '${principalId}' AND NEW.permission_key = 'skills:create' THEN
        attempt := nextval('agent_hire_default_grant_deadlock_attempts');
        IF attempt <= ${failedAttempts} THEN
          RAISE EXCEPTION 'forced agent default grant deadlock' USING ERRCODE = '40P01';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER agent_hire_default_grant_deadlock
      BEFORE INSERT ON principal_permission_grants
      FOR EACH ROW EXECUTE FUNCTION agent_hire_default_grant_deadlock();
  `));
}

describeEmbeddedPostgres("agent hire idempotency within a run", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-idempotency-");
    db = createDb(tempDb.connectionString);
    // Embedded Postgres cold-starts slowly on a loaded machine.
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS agent_hire_default_grant_deadlock ON principal_permission_grants"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS agent_hire_default_grant_deadlock()"));
    await db.execute(sql.raw("DROP SEQUENCE IF EXISTS agent_hire_default_grant_deadlock_attempts"));
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the existing hire when the same run re-posts an identical payload", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
    const payload = { name: "Sam", role: "engineer", title: "Store Builder", adapterType: "process" as const };

    const first = await request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.agent?.name).toBe("Sam");
    const createdId = first.body.agent?.id as string;

    // The agent misreads the wrapped 201 body and re-sends the identical payload.
    const second = await request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.agent?.id).toBe(createdId);
    expect(first.body.agent?.appearance).toMatchObject({ schemaVersion: 1, characterVersion: "cap-v1" });
    expect(second.body.agent?.appearance).toEqual(first.body.agent?.appearance);
    // The retry must not have auto-renamed a duplicate to "Sam 2".
    expect(second.body.agent?.name).toBe("Sam");

    const samAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.role, "engineer")));
    expect(samAgents.map((row) => row.name)).toEqual(["Sam"]);
  });

  it("creates one agent when two identical retries overlap in the same run", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
    const payload = { name: "Sam", role: "engineer", title: "Store Builder", adapterType: "process" as const };

    // Both requests are in flight at once, so neither can see the other's
    // activity record unless the route serializes them.
    const [first, second] = await Promise.all([
      request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload),
      request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses, JSON.stringify([first.body, second.body])).toEqual([200, 201]);
    const created = first.status === 201 ? first : second;
    const replayed = first.status === 200 ? first : second;
    expect(replayed.body.idempotent).toBe(true);
    expect(replayed.body.agent?.id).toBe(created.body.agent?.id);

    const samAgents = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.role, "engineer")));
    expect(samAgents.map((row) => row.name)).toEqual(["Sam"]);
  });

  it("treats a changed payload in the same run as a new hire, not a retry", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const first = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Sam", role: "engineer", adapterType: "process" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    // Same identity, corrected configuration: the agent meant a different hire.
    const corrected = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Sam", role: "engineer", adapterType: "process", title: "Store Builder" });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect(corrected.body.idempotent).toBeUndefined();
    expect(corrected.body.agent?.id).not.toBe(first.body.agent?.id);
    expect(corrected.body.agent?.title).toBe("Store Builder");
  });

  it("still creates a distinct agent for a different hire in the same run", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const sam = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Sam", role: "engineer", adapterType: "process" });
    expect(sam.status, JSON.stringify(sam.body)).toBe(201);

    const casey = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "Casey", role: "designer", adapterType: "process" });
    expect(casey.status, JSON.stringify(casey.body)).toBe(201);
    expect(casey.body.agent?.id).not.toBe(sam.body.agent?.id);

    const names = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, company.id));
    expect(names.map((row) => row.name).sort()).toEqual(["Casey", "Chief Of Staff", "Sam"]);
  });

  it("does not deduplicate identical hires across different runs", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    const [secondRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: hiringAgent.id, status: "running", contextSnapshot: {} })
      .returning();
    const payload = { name: "Sam", role: "engineer", adapterType: "process" as const };

    const firstRunApp = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
    const firstRunHire = await request(firstRunApp)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send(payload);
    expect(firstRunHire.status, JSON.stringify(firstRunHire.body)).toBe(201);

    const secondRunApp = createApp(db, agentActor(company.id, hiringAgent.id, secondRun!.id));
    const secondRunHire = await request(secondRunApp).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    // A genuinely separate run is not a retry, so the legacy dedup names it "Sam 2".
    expect(secondRunHire.status, JSON.stringify(secondRunHire.body)).toBe(201);
    expect(secondRunHire.body.idempotent).toBeUndefined();
    expect(secondRunHire.body.agent?.name).toBe("Sam 2");
  });

  it("retries partial company-default grant setup without duplicating any grant set", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    await authorizeAgentToCreate(db, company.id, hiringAgent.id);
    const rootCeo = await seedRootCeo(db, company.id);
    await forceDefaultGrantDeadlocks(db, rootCeo.id, 2);
    const retryCountBefore = transactionRetryStats.retried;
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const response = await request(app).post(`/api/companies/${company.id}/agents`).send({
      name: "Retry-safe hire",
      role: "engineer",
      reportsTo: hiringAgent.id,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(transactionRetryStats.retried - retryCountBefore).toBe(2);

    const hiredAgentId = response.body.id as string;
    expect(await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, company.id),
      eq(companyMemberships.principalType, "agent"),
      eq(companyMemberships.principalId, hiredAgentId),
    ))).toHaveLength(1);
    expect(await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, company.id),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, hiredAgentId),
      eq(principalPermissionGrants.permissionKey, "tasks:assign"),
    ))).toHaveLength(1);
    expect(await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, company.id),
      eq(companyMemberships.principalType, "agent"),
      eq(companyMemberships.principalId, rootCeo.id),
    ))).toHaveLength(1);
    const defaultGrantRows = await db.select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, company.id),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, rootCeo.id),
      ));
    expect(defaultGrantRows.map(row => row.permissionKey).sort()).toEqual(["agents:configure", "skills:create"]);
  });

  it("returns a named retryable error when every default-grant transaction deadlocks", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    await authorizeAgentToCreate(db, company.id, hiringAgent.id);
    const rootCeo = await seedRootCeo(db, company.id);
    await forceDefaultGrantDeadlocks(db, rootCeo.id, 5);
    const retryCountBefore = transactionRetryStats.retried;
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const response = await request(app).post(`/api/companies/${company.id}/agents`).send({
      name: "Exhausted hire",
      role: "engineer",
      reportsTo: hiringAgent.id,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.code).toBe("agent_hire_grant_contention");
    expect(response.body.details).toMatchObject({ retryable: true });
    expect(transactionRetryStats.retried - retryCountBefore).toBe(4);
  });

  it("does not duplicate a direct hire when an exhausted grant request is retried", async () => {
    const { company, hiringAgent, run } = await seedHiringFixture(db);
    await authorizeAgentToCreate(db, company.id, hiringAgent.id);
    const rootCeo = await seedRootCeo(db, company.id);
    await forceDefaultGrantDeadlocks(db, rootCeo.id, 5);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
    const url = `/api/companies/${company.id}/agents`;
    const payload = {
      name: "Retry after grant exhaustion",
      role: "engineer",
      reportsTo: hiringAgent.id,
      adapterType: "process" as const,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    };

    const exhausted = await request(app).post(url).send(payload);
    expect(exhausted.status, JSON.stringify(exhausted.body)).toBe(422);
    expect(exhausted.body.code).toBe("agent_hire_grant_contention");
    const retried = await request(app).post(url).send(payload);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.idempotent).toBe(true);

    const hires = await db.select({ id: agents.id }).from(agents).where(and(
      eq(agents.companyId, company.id),
      eq(agents.name, payload.name),
    ));
    expect(hires.map(row => row.id)).toEqual([retried.body.id]);
    expect(await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, company.id),
      eq(companyMemberships.principalType, "agent"),
      eq(companyMemberships.principalId, retried.body.id),
    ))).toHaveLength(1);
    expect(await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, company.id),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, retried.body.id),
      eq(principalPermissionGrants.permissionKey, "tasks:assign"),
    ))).toHaveLength(1);
  });

  it("keeps a setupId hire on its existing row after grant exhaustion and retry", async () => {
    const { company } = await seedHiringFixture(db);
    const boardUserId = "hire-setup-board";
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: boardUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: boardUserId,
      permissionKey: "agents:create",
    });
    const boardActor: Express.Request["actor"] = {
      type: "board",
      userId: boardUserId,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }],
      source: "session",
    };
    const app = createApp(db, boardActor);
    const setupId = randomUUID();
    const setup = await request(app).post(`/api/companies/${company.id}/agents`).send({
      setupId,
      name: "Setup retry hire",
      adapterType: "process",
    });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    const rootCeo = await seedRootCeo(db, company.id);
    await forceDefaultGrantDeadlocks(db, rootCeo.id, 5);
    const hireUrl = `/api/companies/${company.id}/agent-hires`;
    const payload = {
      setupAgentId: setupId,
      name: "Setup retry hire",
      role: "engineer",
      adapterType: "process" as const,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    };

    const exhausted = await request(app).post(hireUrl).send(payload);
    expect(exhausted.status, JSON.stringify(exhausted.body)).toBe(422);
    expect(exhausted.body.code).toBe("agent_hire_grant_contention");
    const retried = await request(app).post(hireUrl).send(payload);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.idempotent).toBe(true);
    expect(retried.body.agent?.id).toBe(setupId);

    expect(await db.select({ id: agents.id }).from(agents).where(and(
      eq(agents.companyId, company.id),
      eq(agents.id, setupId),
    ))).toHaveLength(1);
    expect(await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, company.id),
      eq(companyMemberships.principalType, "agent"),
      eq(companyMemberships.principalId, setupId),
    ))).toHaveLength(1);
    expect(await db.select().from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, company.id),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, setupId),
      eq(principalPermissionGrants.permissionKey, "tasks:assign"),
    ))).toHaveLength(1);
    expect(await db.select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(and(
        eq(principalPermissionGrants.companyId, company.id),
        eq(principalPermissionGrants.principalType, "agent"),
        eq(principalPermissionGrants.principalId, rootCeo.id),
      ))).toHaveLength(2);
  });

  it("creates ten agents concurrently with membership and tasks:assign in five trials", async () => {
    const trials: Array<{ statuses: number[]; errors: unknown[] }> = [];
    const failures: Array<{ trial: number; statuses: number[]; errors: unknown[] }> = [];

    for (let trial = 0; trial < 5; trial += 1) {
      const { company, hiringAgent, run } = await seedHiringFixture(db);
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "agent",
        principalId: hiringAgent.id,
        membershipRole: "member",
        status: "active",
      });
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "agent",
        principalId: hiringAgent.id,
        permissionKey: "agents:create",
      });
      const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));
      const responses = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        request(app).post(`/api/companies/${company.id}/agents`).send({
          name: `Concurrent hire ${trial}-${index}`,
          role: "engineer",
          reportsTo: hiringAgent.id,
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
        }).then(response => response, error => ({ status: 0, body: { error: String(error) } })),
      ));
      const statuses = responses.map(response => response.status);
      const errors = responses.filter(response => response.status !== 201).map(response => response.body);
      trials.push({ statuses, errors });
      if (errors.length > 0) failures.push({ trial: trial + 1, statuses, errors });
      console.info(`[concurrent-agent-create] ${JSON.stringify({ trial: trial + 1, companyId: company.id, statuses, errors })}`);

      const created = responses.filter(response => response.status === 201).map(response => response.body.id as string);
      for (const agentId of created) {
        expect(await db.select().from(companyMemberships).where(and(
          eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalId, agentId),
        ))).toHaveLength(1);
        expect(await db.select().from(principalPermissionGrants).where(and(
          eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, agentId),
          eq(principalPermissionGrants.permissionKey, "tasks:assign"),
        ))).toHaveLength(1);
      }
    }

    expect(trials).toHaveLength(5);
    expect(failures, JSON.stringify(failures)).toEqual([]);
  }, 120_000);
});
