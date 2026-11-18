import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, approvals, companies, companySecretBindings, companySecrets, createDb, userCompanyPreferences, type Db,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

// #20389 B6: supersede-by-REPLACEMENT for ctl5's F5 tests (agent-hiring-publication-retry.test.ts and
// agent-primary-publication-retry.test.ts), which force 40P01 and require the lifecycle's internal
// whole-transaction retry that the FINAL ruling removes. Same paths, same strictness, no retry:
// one rolled-back lifecycle transaction commits and publishes NOTHING (one attempt, the 40P01 reaches the
// caller); a separate explicit retry commits once and publishes each logical activity exactly once, after commit.
describe("#20389 B6 lifecycle publication without an internal retry (replaces ctl5 F5 retry tests)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("lifecycle-publication-once-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  /** Root transactions only; `failNext` makes the next one raise a real PostgreSQL 40P01 after its work. */
  function failingDb() {
    const state = { attempts: 0, failNext: true, committed: false };
    const wrapped = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return (async (work, options) => {
        const result = await target.transaction(async tx => {
          state.attempts++;
          const value = await work(tx);
          if (state.failNext) { state.failNext = false; await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced lifecycle rollback' USING ERRCODE = '40P01'; END $$`); }
          return value;
        }, options);
        state.committed = true;
        return result;
      }) as Db["transaction"];
      return Reflect.get(target, key, receiver);
    } });
    return { wrapped, state };
  }
  const sqlStates = (error: unknown) => {
    const codes: string[] = [];
    for (let cause = error as any, depth = 0; cause && typeof cause === "object" && depth < 6; cause = cause.cause, depth++) {
      if (typeof cause.code === "string") codes.push(cause.code);
    }
    return codes;
  };

  for (const path of ["hire", "pending approval", "legacy approval"] as const) {
    it(`${path}: a rolled-back attempt publishes nothing; the explicit retry publishes each activity once after commit`, async () => {
      const companyId = randomUUID(), agentId = randomUUID(), approvalId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Hiring publication once", issuePrefix: `O${companyId.slice(0, 7)}` });
      // Metadata only: binding synchronization does not need a secret value.
      const [reference] = await db.insert(companySecrets).values({ companyId, key: "DEMO", name: "DEMO",
        provider: "local_encrypted", status: "active" }).returning();
      const adapterConfig = { env: { DEMO: { type: "secret_ref", secretId: reference!.id, version: "latest" } } };
      if (path === "pending approval") {
        await db.insert(agents).values({ id: agentId, companyId, name: "Pending worker", adapterType: "process",
          status: "pending_approval", lifecycleState: "pending_approval" });
      }
      if (path !== "hire") {
        await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", requestedByUserId: "board",
          payload: { ...(path === "pending approval" ? { agentId } : {}), name: "Approved worker", adapterType: "process", adapterConfig } });
      }
      const events: { action: unknown; entityId: unknown; configPath: unknown; committed: boolean }[] = [];
      const { wrapped, state } = failingDb();
      const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
        if (event.type === "activity.logged") events.push({ action: event.payload.action, entityId: event.payload.entityId,
          configPath: (event.payload.details as Record<string, unknown> | null)?.configPath, committed: state.committed });
      });
      try {
        const run = () => {
          const lifecycle = createAgentLifecycle(wrapped);
          return path === "hire"
            ? lifecycle.requestHire(companyId, { id: agentId, name: "Worker", adapterType: "process", adapterConfig })
            : lifecycle.approveHire({ approvalId }, "board");
        };
        const failed = await run().then(() => null, error => error);
        expect(sqlStates(failed)).toContain("40P01");
        expect({ attempts: state.attempts, committed: state.committed }).toEqual({ attempts: 1, committed: false });
        expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toHaveLength(0);
        expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toHaveLength(0);
        expect(events).toHaveLength(0);
        const before = await db.select().from(agents).where(eq(agents.companyId, companyId));
        expect(before).toHaveLength(path === "pending approval" ? 1 : 0);
        if (path === "pending approval") expect(before[0]).toMatchObject({ status: "pending_approval", adapterConfig: {} });
        if (path !== "hire") expect((await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]!.status).toBe("pending");
        // The explicit retry: a separate request, nothing replayed inside the failed one.
        await run();
        expect({ attempts: state.attempts, committed: state.committed }).toEqual({ attempts: 2, committed: true });
        const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
        expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toHaveLength(1);
        expect(rows.filter(row => row.action === "secret.binding.created")).toHaveLength(1);
        expect(events).toHaveLength(rows.length);
        expect(events.every(event => event.committed), "all live activity follows the root commit").toBe(true);
        for (const row of rows) expect(events.filter(event => event.action === row.action
          && event.entityId === row.entityId && event.configPath === row.details?.configPath)).toHaveLength(1);
        const after = await db.select().from(agents).where(eq(agents.companyId, companyId));
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ lifecycleState: "preparing", adapterConfig });
        if (path !== "hire") expect((await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]!.status).toBe("approved");
      } finally { unsubscribe(); }
    }, 60_000);
  }

  for (const path of ["terminate", "configure and terminate", "reject by agent", "reject by approval"] as const) {
    it(`${path}: a rolled-back attempt clears no primary and publishes nothing; the explicit retry publishes once`, async () => {
      const companyId = randomUUID(), agentId = randomUUID(), approvalId = randomUUID();
      const pending = path.startsWith("reject");
      await db.insert(companies).values({ id: companyId, name: "Primary publication once", issuePrefix: `Q${companyId.slice(0, 7)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Primary", adapterType: "process",
        status: pending ? "pending_approval" : "idle", lifecycleState: pending ? "pending_approval" : "ready" });
      await db.insert(userCompanyPreferences).values({ companyId, userId: "board", primaryAgentId: agentId, primaryAgentInitialized: true });
      if (path === "reject by approval") await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent",
        requestedByUserId: "board", payload: { agentId } });
      const events: { action: unknown; committed: boolean }[] = [];
      const { wrapped, state } = failingDb();
      const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
        if (event.type === "activity.logged") events.push({ action: event.payload.action, committed: state.committed });
      });
      try {
        const run = () => {
          const lifecycle = createAgentLifecycle(wrapped);
          return path === "terminate" ? lifecycle.terminateAgent(agentId)
            : path === "configure and terminate" ? lifecycle.updateAndTransition(agentId, "terminate", { title: "Updated" })
            : lifecycle.rejectHire(path === "reject by approval" ? { approvalId } : agentId, "board");
        };
        const failed = await run().then(() => null, error => error);
        expect(sqlStates(failed)).toContain("40P01");
        expect({ attempts: state.attempts, committed: state.committed }).toEqual({ attempts: 1, committed: false });
        expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toHaveLength(0);
        expect(events).toEqual([]);
        expect((await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId)))[0])
          .toMatchObject({ primaryAgentId: agentId, primaryAgentInitialized: true });
        await run();
        expect({ attempts: state.attempts, committed: state.committed }).toEqual({ attempts: 2, committed: true });
        expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toHaveLength(1);
        expect(events).toEqual([{ action: "primary_agent.cleared", committed: true }]);
        expect((await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId)))[0])
          .toMatchObject({ primaryAgentId: null, primaryAgentInitialized: true });
      } finally { unsubscribe(); }
    }, 60_000);
  }
});
