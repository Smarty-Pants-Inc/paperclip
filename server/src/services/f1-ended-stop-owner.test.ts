import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { settleStoppedRemoteNativeOwner } from "./native-runtime/native-failed-run-owner-release.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";

// Keep reason (restored by RFL step 6 F2 from 422b8c26:86-104): the observed-owner
// inspection path in native-runtime/native-failed-run-owner-release.ts
// (settleStoppedRemoteNativeOwner) is unchanged by delete-ours step 6. A positive
// stopped/destroyed inspection settles the ended allocation in place: it never
// reopens the row, never dispatches a stop, and keeps every historical metadata key.
// The removed inspected-source stop producer and its block are not revived.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("F1 ended allocation stop owner", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("f1-ended-stop-owner"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { vi.useRealTimers(); await db.execute(sql`truncate table companies cascade`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(status: "released" | "expired", observed = false) {
    const now = Date.now(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Recorded ended allocation", issuePrefix: `F${randomUUID().slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: userId }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Owner", role: "engineer", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Saved follow-up", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, nativeIssueId: issue.id, nativeSessionId: randomUUID(), runtimeMode: "native", nativePhase: observed ? "observed" : "terminal_failure", status: observed ? "running" : "failed", errorCode: observed ? "native_execution_ownership_unverified" : "runner_remote_state_unavailable", createdAt: new Date(now - 600_000), finishedAt: observed ? null : new Date(now - 60_000), responsibleUserId: userId }).returning();
    if (observed) await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: company.id, issueId: issue.id, phase: "observed", leaseOwner: "expired-owner", attempt: 2, controllerGeneration: 7, leaseExpiresAt: new Date(0) });
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, issueId: issue.id, heartbeatRunId: run.id, provider: "boat", providerLeaseId: `recorded-${randomUUID()}`, status, cleanupStatus: "success", failureReason: "historical-idle-close", acquiredAt: new Date(now - 590_000), releasedAt: new Date(now - 300_000), metadata: { pluginId: "fixture-boat", leaseController: { bootId: "historical-boot" }, historicalEvidence: "must survive" } }).returning();
    const readLease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]!;
    return { run, issue, lease, readLease };
  }

  it.each(["released", "expired"] as const)("%s: observed-owner positive inspection settles without reopening or stop dispatch", async status => {
    for (const state of ["stopped", "destroyed"] as const) {
      const f = await fixture(status, true);
      const inspect = vi.fn(async () => {
        expect(await f.readLease()).toEqual(f.lease);
        await db.transaction(async tx => { await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issue.id)).for("update", { noWait: true }); });
        return { providerLeaseId: f.lease.providerLeaseId!, state };
      });
      expect(await settleStoppedRemoteNativeOwner(db, f.run.id, new Date(), inspect)).toBe(true);
      expect(inspect).toHaveBeenCalledOnce();
      const settled = await f.readLease();
      expect(settled.status).toBe(status);
      expect(hasRemoteTerminationReceipt(settled)).toBe(true);
      expect(readStopOnlyCleanup(settled)).toBeNull();
      expect(settled.metadata).toMatchObject({ leaseController: f.lease.metadata!.leaseController, historicalEvidence: "must survive", remoteExecutionTermination: { state, leaseId: f.lease.id } });
      const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id));
      expect(owner).toMatchObject({ phase: "terminal_failure", controllerGeneration: 8, leaseOwner: null });
    }
  }, 60_000);
});
