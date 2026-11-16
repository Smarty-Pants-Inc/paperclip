import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, approvals, companies, companySecretBindings, companySecrets, createDb, type Db,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { ACCOUNTING_TRANSACTION_ATTEMPTS, AccountingContentionError } from "../services/accounting-transaction.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

// Keep reason: #20389 F5, a real PostgreSQL rollback/retry failure that a normal
// hire flow cannot force cheaply. No credential values or provider calls.
describe("#20389 RFL F5 hire/approval publication retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("hiring-publication-retry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  for (const path of ["hire", "pending approval", "legacy approval"] as const) {
    for (const exhaust of [false, true]) {
      // superseded by replacement: CTL6-RF2-0632 + RFL 06:36Z F5.
      // Original intent: no hire/approval binding or activity escapes rollback; committed effects publish exactly once.
      it(`${path}: ${exhaust ? "exhausted retries publish nothing" : "one rollback then one post-commit event per logical activity"} (current contract: ${exhaust ? "one attempt per failed request" : "explicit retry after a silent rollback"})`, async () => {
        const companyId = randomUUID(), agentId = randomUUID(), approvalId = randomUUID();
        await db.insert(companies).values({ id: companyId, name: "Hiring publication retry", issuePrefix: `H${companyId.slice(0, 7)}` });
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
        let attempts = 0, committed = false;
        const events: { action: unknown; entityId: unknown; configPath: unknown; afterCommit: boolean }[] = [];
        const beforeRollback: number[] = [];
        const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
          if (event.type === "activity.logged") events.push({ action: event.payload.action, entityId: event.payload.entityId,
            configPath: (event.payload.details as Record<string, unknown> | null)?.configPath, afterCommit: committed });
        });
        // Intercept only the root transaction, not savepoints. The PostgreSQL
        // exception after the complete callback rolls back real binding/activity
        // rows; the next attempt starts a new transaction and publication buffer.
        const wrappedDb = new Proxy(db, { get(target, key, receiver) {
          if (key === "transaction") return (async (work, options) => {
            const result = await target.transaction(async tx => {
              attempts++;
              const value = await work(tx);
              if (exhaust || attempts === 1) {
                beforeRollback.push(events.length);
                await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced hire rollback' USING ERRCODE = '40P01'; END $$`);
              }
              return value;
            }, options);
            committed = true;
            return result;
          }) as Db["transaction"];
          return Reflect.get(target, key, receiver);
        } });
        try {
          const lifecycle = createAgentLifecycle(wrappedDb);
          const run = () => path === "hire"
            ? lifecycle.requestHire(companyId, { id: agentId, name: "Worker", adapterType: "process", adapterConfig })
            : lifecycle.approveHire({ approvalId }, "board");
          const originalAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
          const originalApprovals = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
          // Keep the original eight-rollback pressure, but each rollback belongs to a
          // separate caller request: lifecycleTransaction must never replay it itself.
          for (let failedRequests = 0; failedRequests < (exhaust ? ACCOUNTING_TRANSACTION_ATTEMPTS : 1); failedRequests++) {
            await expect(run()).rejects.toMatchObject({
              name: AccountingContentionError.name, status: 503, code: "40P01", attempts: 1,
            });
            expect(attempts).toBe(failedRequests + 1);
            expect(committed).toBe(false);
            expect(events).toEqual([]);
            expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
            expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toEqual([]);
            expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toEqual(originalAgents);
            expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toEqual(originalApprovals);
          }
          // Mirrors agent-lifecycle-publication-once: the caller explicitly retries.
          if (!exhaust) await run();
          const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
          const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
          const companyAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
          console.log("HIRING_PUBLICATION_RETRY", JSON.stringify({ path, exhaust, attempts, committed, beforeRollback,
            durableActions: rows.map(row => row.action), bindings: bindings.length, events }));
          expect(attempts).toBe(exhaust ? ACCOUNTING_TRANSACTION_ATTEMPTS : 2);
          expect(beforeRollback, "no live activity may escape any rolled-back attempt").toEqual(Array(exhaust ? ACCOUNTING_TRANSACTION_ATTEMPTS : 1).fill(0));
          if (exhaust) {
            expect(committed).toBe(false);
            expect(rows).toHaveLength(0);
            expect(bindings).toHaveLength(0);
            expect(events).toHaveLength(0);
            expect(companyAgents).toHaveLength(path === "pending approval" ? 1 : 0);
            if (path === "pending approval") expect(companyAgents[0]).toMatchObject({ status: "pending_approval", adapterConfig: {} });
            if (path !== "hire") expect((await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]!.status).toBe("pending");
          } else {
            expect(committed).toBe(true);
            expect(bindings).toEqual([expect.objectContaining({
              secretId: reference!.id, configPath: "env.DEMO", targetType: "agent", targetId: companyAgents[0]!.id,
            })]);
            expect(rows.filter(row => row.action === "secret.binding.created")).toEqual([
              expect.objectContaining({ entityType: "agent", entityId: companyAgents[0]!.id,
                details: expect.objectContaining({ configPath: "env.DEMO", secretId: reference!.id }) }),
            ]);
            expect(events).toHaveLength(rows.length);
            expect(events.every(event => event.afterCommit), "all live activity must follow the root commit, not a savepoint").toBe(true);
            for (const row of rows) expect(events.filter(event => event.action === row.action
              && event.entityId === row.entityId && event.configPath === row.details?.configPath)).toHaveLength(1);
            expect(companyAgents).toHaveLength(1);
            expect(companyAgents[0]).toMatchObject({ lifecycleState: "preparing", adapterConfig });
            if (path !== "hire") expect((await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]!.status).toBe("approved");
          }
        } finally { unsubscribe(); }
      }, 60_000);
    }
  }
});
