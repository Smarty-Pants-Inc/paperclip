import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, budgetPolicies, companies, companySecretBindings, companySecrets, createDb, issues, issueAccessGrants, type Db,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { issueService } from "../services/issues.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { agentHandoverService } from "../services/agent-handover.js";

describe("#20389 RFL F4 retirement publication retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retirement-publication-retry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await database?.cleanup(); });

  // superseded by replacement: RFL FINAL S2/S3 + CTL6-RF2-0505 W1/W3/W5; RFL F4 supersede.
  // Original intent: private-task access and reassignment publish once, never from a rolled-back attempt.
  it("publishes private-task access and reassignment once after retried completion commits (current contract: marker then explicit per-item recovery)", async () => {
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
    await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, task.id));
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    const beforeTask = (await db.select().from(issues).where(eq(issues.id, task.id)))[0]!;
    let attempts = 0, committed = false;
    const events: { action: unknown; entityId: unknown; afterCommit: boolean }[] = [];
    const beforeRollback: number[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      if (event.type === "activity.logged") events.push({ action: event.payload.action, entityId: event.payload.entityId, afterCommit: committed });
    });
    const wrappedDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return (async (work, options) => {
        committed = false;
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
      const complete = () => createLifecycleStore(wrappedDb, createAgentLifecycleEffects())
        .change(agentId, "complete", { owner, version: retiring!.lifecycleVersion });
      await expect(complete()).rejects.toMatchObject({ status: 503, code: "40P01", attempts: 1 });
      expect({ attempts, committed, beforeRollback }).toEqual({ attempts: 1, committed: false, beforeRollback: [0] });
      expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toEqual(retiring);
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toEqual(beforeTask);
      expect(await db.select().from(issueAccessGrants).where(eq(issueAccessGrants.issueId, task.id))).toEqual([]);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
      expect(events).toEqual([]);
      // Mirrors W1 in agent-retirement-handover: explicit completion commits only
      // terminated + one marker + terminal audit. The task is byte-identical.
      await complete();
      expect(attempts).toBe(2);
      expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toMatchObject({
        lifecycleState: "terminated", lifecycleOperation: { handover: { code: "agent_handover_pending" } },
      });
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toEqual(beforeTask);
      expect(await db.select().from(issueAccessGrants).where(eq(issueAccessGrants.issueId, task.id))).toEqual([]);
      expect(events).toEqual([{ action: "agent.terminated", entityId: agentId, afterCommit: true }]);

      // Mirrors W5: fail the worker's first item AFTER its access/reassignment
      // writes. Its own transaction must discard BOTH rows and publications.
      let itemAttempts = 0;
      let now = new Date();
      const itemDb = new Proxy(db, { get(target, key, receiver) {
        if (key === "transaction") return (async (work, options) => {
          committed = false;
          const result = await target.transaction(async tx => {
            const value = await work(tx);
            if (++itemAttempts === 1) {
              expect(events).toEqual([{ action: "agent.terminated", entityId: agentId, afterCommit: true }]);
              await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced handover rollback' USING ERRCODE = '40P01'; END $$`);
            }
            return value;
          }, options);
          committed = true;
          return result;
        }) as Db["transaction"];
        return Reflect.get(target, key, receiver);
      } });
      const recovery = agentHandoverService(itemDb, { now: () => now });
      const failed = await recovery.processAgent(agentId);
      expect(failed).toMatchObject({ tasks: [], cleared: false, blocked: [{ kind: "task", id: task.id, attempts: 1 }] });
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toEqual(beforeTask);
      expect(await db.select().from(issueAccessGrants).where(eq(issueAccessGrants.issueId, task.id))).toEqual([]);
      expect(events.filter(event => ["issue_access_grant.created", "issue.reassigned"].includes(String(event.action)))).toEqual([]);
      now = new Date(now.getTime() + 6_000);
      expect(await recovery.processAgent(agentId)).toMatchObject({ tasks: [task.id], cleared: true, blocked: [] });
      const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(rows.filter(row => row.action === "issue.reassigned")).toEqual([expect.objectContaining({
        entityId: task.id, details: expect.objectContaining({ previousAssigneeAgentId: agentId, assigneeAgentId: managerId }),
      })]);
      const grants = await db.select().from(issueAccessGrants).where(eq(issueAccessGrants.issueId, task.id));
      expect(grants).toEqual([expect.objectContaining({ subjectType: "agent", subjectId: managerId, source: "assignment", revokedAt: null })]);
      expect(rows.filter(row => row.action === "issue_access_grant.created")).toEqual([expect.objectContaining({
        entityType: "issue_access_grant", entityId: grants[0]!.id,
        details: expect.objectContaining({ issueId: task.id, subjectType: "agent", subjectId: managerId, source: "assignment" }),
      })]);
      const expectedActions = [
        "agent.handover_completed",
        "agent.terminated",
        "issue.reassigned",
        "issue.reassignment_failed",
        "issue_access_grant.created",
      ];
      expect(rows.map(row => row.action).sort()).toEqual(expectedActions);
      expect(events.map(event => event.action).sort()).toEqual(expectedActions);
      expect(events).toHaveLength(rows.length);
      expect(events.every(event => event.afterCommit)).toBe(true);
      for (const row of rows) expect(events.filter(event => event.action === row.action && event.entityId === row.entityId)).toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toMatchObject({ assigneeAgentId: managerId });
      expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.lifecycleOperation?.handover).toBeUndefined();
      const eventCount = events.length;
      expect(await recovery.processAgent(agentId)).toEqual({ tasks: [], reports: [], blocked: [], cleared: false });
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual(rows);
      expect(events).toHaveLength(eventCount);
    } finally { unsubscribe(); }
  }, 60_000);

  for (const revokeOnRetry of [false, true]) {
    // superseded by replacement: RFL F4 supersede + RFL FINAL S2/S3 (explicit requests, no lifecycle replay).
    // Original intent: rollback publishes nothing; authorization is rechecked and each committed logical activity publishes once.
    it((revokeOnRetry
      ? "publishes nothing when the rolled-back retirement is denied on retry"
      : "publishes each logical activity once, only after the final retirement commit")
      + " (current contract: explicit retry rechecks authority)", async () => {
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
        const beforeAgent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
        let authorizations = 0;
        // A nested configure/savepoint also authorizes; count only the root request.
        let rootTransaction: unknown;
        const transaction = wrappedDb.transaction.bind(wrappedDb);
        const authorizedDb = new Proxy(wrappedDb, { get(target, key, receiver) {
          if (key === "transaction") return ((work, options) => transaction(async tx => {
            rootTransaction = tx;
            return work(tx);
          }, options)) as Db["transaction"];
          return Reflect.get(target, key, receiver);
        } });
        const lifecycle = createAgentLifecycle(authorizedDb, {}, async tx => {
          if (tx !== rootTransaction) return;
          if (++authorizations === 2 && revokeOnRetry) throw new Error("scope revoked before retry");
        });
        const run = () => lifecycle.updateAndTransition(agentId, "terminate", { adapterConfig, budgetMonthlyCents: 123 });
        await expect(run()).rejects.toMatchObject({ status: 503, code: "40P01", attempts: 1 });
        expect({ attempts, authorizations, committed, beforeRollback }).toEqual({ attempts: 1, authorizations: 1, committed: false, beforeRollback: [0] });
        expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]).toEqual(beforeAgent);
        expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toEqual([]);
        expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toEqual([]);
        expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).toEqual([]);
        expect(events).toEqual([]);
        // Separate caller retry, as in agent-retirement-handover's F4 replacement.
        if (revokeOnRetry) await expect(run()).rejects.toThrow("scope revoked before retry");
        else await run();
        expect(authorizations).toBe(2);
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
          expect(agent).toEqual(beforeAgent);
          expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toEqual([]);
          expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).toEqual([]);
        } else {
          expect(agent).toMatchObject({ lifecycleState: "terminating", budgetMonthlyCents: 123 });
          expect(bindings.map(row => row.details?.configPath).sort()).toEqual(["env.FIRST", "env.SECOND"]);
          const durableBindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
          expect(durableBindings.map(row => ({ targetId: row.targetId, secretId: row.secretId, configPath: row.configPath }))
            .sort((a, b) => a.configPath.localeCompare(b.configPath))).toEqual(references.map(reference => ({
              targetId: agentId, secretId: reference.id, configPath: `env.${reference.key}`,
            })).sort((a, b) => a.configPath.localeCompare(b.configPath)));
          const policies = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
          expect(policies).toEqual([expect.objectContaining({ scopeType: "agent", scopeId: agentId, amount: 123,
            windowKind: "calendar_month_utc" })]);
          expect(rows.filter(row => row.action === "budget.policy_upserted")).toEqual([expect.objectContaining({
            entityType: "budget_policy", entityId: policies[0]!.id,
            details: expect.objectContaining({ scopeType: "agent", scopeId: agentId, amount: 123 }),
          })]);
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
