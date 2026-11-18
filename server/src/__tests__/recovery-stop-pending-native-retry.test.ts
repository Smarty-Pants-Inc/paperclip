import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// Keep the genuine same-run retry owner guard, not the removed task Stop policy.
describe("native retry retains its eligible task claim", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-native-retry-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(status: string, processPid: number | null = null) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const old = new Date(Date.now() - 30 * 86_400_000);
    await db.insert(companies).values({ id: companyId, name: "Native retry ownership", issuePrefix: `N${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Old native owner", adapterType: "paperclip_runner",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(issues).values({ id: issueId, companyId, title: "Native Stop obligation", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status, runtimeMode: "native", nativeIssueId: issueId,
      invocationSource: "manual", executionStage: "dispatching", startedAt: old, finishedAt: status === "running" ? null : old, processPid });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId, executionLockedAt: old }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "retryable_failure",
      resultId: null, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null });
    return { companyId, issueId, runId };
  }
  async function task(issueId: string) { return (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!; }

  it.each(["failed", "running"])("retains the normal %s same-run retry owner without adding a Stop escalation", async status => {
    const f = await fixture(status);
    const before = await task(f.issueId);
    const enqueueWakeup = vi.fn();
    expect((await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks()).cleared).toBe(0);
    expect(await task(f.issueId)).toEqual(before);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

});
