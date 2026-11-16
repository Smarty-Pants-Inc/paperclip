import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companySecrets, createDb, issues, type Db,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { issueService } from "../services/issues.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

describe("#20389 RFL F4 retirement publication retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retirement-publication-retry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  it("publishes private-task access and reassignment once after retried completion commits", async () => {
    const companyId = randomUUID(), managerId = randomUUID(), agentId = randomUUID(), owner = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Private retirement", issuePrefix: `P${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: managerId, companyId, name: "Manager", adapterType: "process", status: "idle", lifecycleState: "ready" });
    const [retiring] = await db.insert(agents).values({ id: agentId, companyId, name: "Worker", reportsTo: managerId,
      adapterType: "process", status: "terminated", lifecycleState: "cleaning_up", lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: true, completedPluginIds: [], attempts: 1,
        leaseOwner: owner, leaseUntil: new Date(Date.now() + 120_000).toISOString() } }).returning();
    // Create under an eligible owner, then seed the report's pre-retirement ownership.
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const task = await issueService(db).create(companyId, { title: "Private unfinished task", visibility: "private", status: "todo", assigneeAgentId: managerId, createdByUserId: userId });
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, task.id));
    // Remove the fixture's manager grant so completion must create the new access receipt.
    const { issueAccessGrants } = await import("@paperclipai/db");
    await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, task.id));
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    let attempts = 0, committed = false;
    const events: { action: unknown; afterCommit: boolean }[] = [];
    const beforeRollback: number[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      if (event.type === "activity.logged") events.push({ action: event.payload.action, afterCommit: committed });
    });
    const wrappedDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return (async (work, options) => {
        const result = await target.transaction(async tx => {
          attempts++;
          const value = await work(tx);
          if (attempts === 1) {
            beforeRollback.push(events.length);
            await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced completion rollback' USING ERRCODE = '40P01'; END $$`);
          }
          return value;
        }, options);
        committed = true;
        return result;
      }) as Db["transaction"];
      return Reflect.get(target, key, receiver);
    } });
    try {
      await createLifecycleStore(wrappedDb, createAgentLifecycleEffects()).change(agentId, "complete", { owner, version: retiring!.lifecycleVersion });
      const rows = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
        sql`${activityLog.action} in ('issue_access_grant.created', 'issue.reassigned')`));
      console.log("RETIREMENT_COMPLETION_PUBLICATIONS", JSON.stringify({ attempts, beforeRollback, durableActions: rows.map(row => row.action), events }));
      expect(attempts).toBe(2);
      expect(beforeRollback, "private assignment activity must not escape a rolled-back completion").toEqual([0]);
      expect(rows.map(row => row.action).sort()).toEqual(["issue.reassigned", "issue_access_grant.created"]);
      expect(events).toHaveLength(2);
      expect(events.every(event => event.afterCommit)).toBe(true);
      for (const row of rows) expect(events.filter(event => event.action === row.action)).toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toMatchObject({ assigneeAgentId: managerId });
    } finally { unsubscribe(); }
  }, 60_000);

  for (const revokeOnRetry of [false, true]) {
    it(revokeOnRetry
      ? "publishes nothing when the rolled-back retirement is denied on retry"
      : "publishes each logical activity once, only after the final retirement commit", async () => {
      const companyId = randomUUID(), agentId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Retirement publication retry", issuePrefix: `P${companyId.slice(0, 7)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", status: "idle",
        lifecycleState: "ready", runtimeConfig: { heartbeat: { enabled: false } } });
      // Metadata only: no credential value, version or encryption key is created or read.
      const references = await db.insert(companySecrets).values(["FIRST", "SECOND"].map(key => ({
        companyId, key, name: key, provider: "local_encrypted", status: "active",
      }))).returning();
      const adapterConfig = { env: Object.fromEntries(references.map(reference => [reference.key, {
        type: "secret_ref", secretId: reference.id, version: "latest",
      }])) };
      let attempts = 0, committed = false;
      const events: { action: unknown; afterCommit: boolean; configPath: unknown }[] = [];
      const beforeRollback: number[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
        if (event.type === "activity.logged") events.push({ action: event.payload.action,
          afterCommit: committed, configPath: (event.payload.details as Record<string, unknown> | null)?.configPath });
      });
      // Same root transaction proxy as the ctl3 forced-40P01 harness. Raise in
      // PostgreSQL after the callback, so writes and buffered publications from
      // attempt one must both be discarded, not deduplicated after publication.
      const wrappedDb = new Proxy(db, { get(target, key, receiver) {
        if (key === "transaction") return (async (work, options) => {
          const result = await target.transaction(async tx => {
            attempts++;
            const value = await work(tx);
            if (attempts === 1) {
              beforeRollback.push(events.length);
              await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced retirement rollback' USING ERRCODE = '40P01'; END $$`);
            }
            return value;
          }, options);
          committed = true;
          return result;
        }) as Db["transaction"];
        return Reflect.get(target, key, receiver);
      } });
      try {
        const lifecycle = createAgentLifecycle(wrappedDb, {}, async () => {
          if (revokeOnRetry && attempts === 2) throw new Error("scope revoked before retry");
        });
        const operation = lifecycle.updateAndTransition(agentId, "terminate", { adapterConfig, budgetMonthlyCents: 123 });
        if (revokeOnRetry) await expect(operation).rejects.toThrow("scope revoked before retry");
        else await operation;
        const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
        const bindings = rows.filter(row => row.action === "secret.binding.created");
        const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
        console.log("RETIREMENT_PUBLICATION_RETRY", JSON.stringify({ revokeOnRetry, attempts,
          beforeRollback, durableActions: rows.map(row => row.action), events }));
        expect(attempts).toBe(2);
        expect(beforeRollback, "no live event may escape the attempt that rolls back").toEqual([0]);
        if (revokeOnRetry) {
          expect(committed).toBe(false);
          expect(rows).toHaveLength(0);
          expect(events).toHaveLength(0);
          expect(agent).toMatchObject({ lifecycleState: "ready", adapterConfig: {} });
        } else {
          expect(agent).toMatchObject({ lifecycleState: "terminating", budgetMonthlyCents: 123 });
          expect(bindings).toHaveLength(2);
          expect(rows.filter(row => row.action === "budget.policy_upserted")).toHaveLength(1);
          expect(events).toHaveLength(rows.length);
          expect(events.every(event => event.afterCommit), "every logical activity is post-commit").toBe(true);
          for (const row of rows) {
            expect(events.filter(event => event.action === row.action && event.configPath === row.details?.configPath)).toHaveLength(1);
          }
        }
      } finally { unsubscribe(); }
    }, 60_000);
  }
});
