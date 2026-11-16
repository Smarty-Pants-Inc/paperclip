import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, approvals, companies, userCompanyPreferences, createDb, type Db,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { ACCOUNTING_TRANSACTION_ATTEMPTS, AccountingContentionError } from "../services/accounting-transaction.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

// Keep reason: #20389 F5 wider audit found dropped primary-agent publications
// and nested configure/transition publication before the root commit. Exercise
// real PostgreSQL rollback and actual lifecycle services, without provider calls.
describe("#20389 primary-agent publication across lifecycle retries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("primary-publication-retry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  for (const path of ["terminate", "configure and terminate", "reject by agent", "reject by approval"] as const) {
    for (const exhaust of [false, true]) {
      // superseded by replacement: CTL6-RF2-0632 + RFL 06:36Z F5.
      // Original intent: rollback keeps the primary; a committed clear publishes exactly once after the root commit.
      it(`${path}: ${exhaust ? "exhaustion is silent" : "publishes once after root commit"} (current contract: ${exhaust ? "one attempt per failed request" : "explicit retry after a silent rollback"})`, async () => {
        const companyId = randomUUID(), agentId = randomUUID(), approvalId = randomUUID();
        const pending = path.startsWith("reject");
        await db.insert(companies).values({ id: companyId, name: "Primary publication retry", issuePrefix: `P${companyId.slice(0, 7)}` });
        await db.insert(agents).values({ id: agentId, companyId, name: "Primary", adapterType: "process",
          status: pending ? "pending_approval" : "idle", lifecycleState: pending ? "pending_approval" : "ready" });
        await db.insert(userCompanyPreferences).values({ companyId, userId: "board", primaryAgentId: agentId, primaryAgentInitialized: true });
        if (path === "reject by approval") await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent",
          requestedByUserId: "board", payload: { agentId } });
        let attempts = 0, committed = false;
        const events: { action: unknown; entityType: unknown; entityId: unknown; afterCommit: boolean }[] = [];
        const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
          if (event.type === "activity.logged") events.push({ action: event.payload.action, entityType: event.payload.entityType,
            entityId: event.payload.entityId, afterCommit: committed });
        });
        const wrappedDb = new Proxy(db, { get(target, key, receiver) {
          if (key === "transaction") return (async (work, options) => {
            const result = await target.transaction(async tx => {
              attempts++;
              const value = await work(tx);
              if (exhaust || attempts === 1) await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced primary rollback' USING ERRCODE = '40P01'; END $$`);
              return value;
            }, options);
            committed = true;
            return result;
          }) as Db["transaction"];
          return Reflect.get(target, key, receiver);
        } });
        try {
          const lifecycle = createAgentLifecycle(wrappedDb);
          const run = () => path === "terminate" ? lifecycle.terminateAgent(agentId)
            : path === "configure and terminate" ? lifecycle.updateAndTransition(agentId, "terminate", { title: "Updated" })
            : lifecycle.rejectHire(path === "reject by approval" ? { approvalId } : agentId, "board");
          const beforeAgent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
          const beforePreferences = await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId));
          const beforeApprovals = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
          // Mirrors agent-lifecycle-publication-once: explicit requests, never an
          // internal replay. Every failed request is one 40P01 and leaves exact rows intact.
          for (let failedRequests = 0; failedRequests < (exhaust ? ACCOUNTING_TRANSACTION_ATTEMPTS : 1); failedRequests++) {
            await expect(run()).rejects.toMatchObject({
              name: AccountingContentionError.name, status: 503, code: "40P01", attempts: 1,
            });
            expect(attempts).toBe(failedRequests + 1);
            expect(committed).toBe(false);
            expect(events).toEqual([]);
            expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
            expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toEqual(beforeAgent);
            expect(await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId))).toEqual(beforePreferences);
            expect(await db.select().from(approvals).where(eq(approvals.companyId, companyId))).toEqual(beforeApprovals);
          }
          if (!exhaust) await run();
          const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
          const [preference] = await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId));
          expect(attempts).toBe(exhaust ? ACCOUNTING_TRANSACTION_ATTEMPTS : 2);
          expect(committed).toBe(!exhaust);
          expect(rows).toEqual(exhaust ? [] : [expect.objectContaining({
            action: "primary_agent.cleared", entityType: "user_preference", entityId: "board",
          })]);
          expect(events).toEqual(exhaust ? [] : [{ action: "primary_agent.cleared", entityType: "user_preference",
            entityId: "board", afterCommit: true }]);
          expect(preference).toMatchObject({ primaryAgentId: exhaust ? agentId : null, primaryAgentInitialized: true });
          if (!exhaust) {
            const after = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
            expect(after).toMatchObject({ status: "terminated", lifecycleState: pending ? "rejected" : "terminating" });
            if (path === "configure and terminate") expect(after.title).toBe("Updated");
            if (path === "reject by approval") expect((await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0])
              .toMatchObject({ status: "rejected", decidedByUserId: "board" });
          }
        } finally { unsubscribe(); }
      }, 60_000);
    }
  }
});
