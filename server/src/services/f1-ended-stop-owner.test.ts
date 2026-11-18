import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, environmentLeases, heartbeatRuns, issueComments, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareInspectedSourceSandboxStop, readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { heartbeatService } from "./heartbeat.js";

// Keep reason: receipt-less historical idle releases from SEED-B, and the
// provider/DB ownership boundary. Retained cleanup preparation, fenced settlement
// and real cleanup sweep; no removed fresh-gate inspection/stop orchestration.
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

  // follow-Paperclip Cut B R5: split out removed gate orchestration; preserve ended evidence and stop-and-keep at its existing cleanup owner.
  it.each((["released", "expired"] as const).flatMap(status => (["running", "error", "absent"] as const).map(observation => ({ status, observation }))))("$status / $observation: only a positive running observation can prepare bounded stop-and-keep", async ({ status, observation }) => {
      const f = await fixture(status), t0 = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      expect(await f.readLease()).toEqual(f.lease);
      const result = observation === "error" ? new Error("external provider unavailable")
        : observation === "absent" ? undefined : { providerLeaseId: f.lease.providerLeaseId!, state: observation };
      const preparation = await prepareInspectedSourceSandboxStop(db, f.lease, result);
      const prepared = await f.readLease();
      if (observation !== "running") {
        // RFL 22:57Z (3): ERROR/ABSENT is not stop authority. Preserve every
        // byte of ended evidence. Cleanup does not own a thread-started note.
        expect(preparation).toBeNull();
        const stop = vi.fn(async () => undefined);
        const hb = heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
        expect(prepared).toEqual(f.lease);
        for (let n = 0; n < 3; n++) {
          expect(await prepareInspectedSourceSandboxStop(db, f.lease, result)).toBeNull();
          await hb.sweepPendingCleanupLeases();
          expect(await f.readLease()).toEqual(f.lease);
        }
        expect(stop).not.toHaveBeenCalled();
        const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issue.id), eq(issueComments.authorType, "system")));
        expect(notes).toHaveLength(0);
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
        return;
      }
      expect(preparation).not.toBeNull();
      expect(prepared.status).toBe("pending_cleanup");
      expect(readStopOnlyCleanup(prepared)).not.toBeNull();
      expect(prepared.metadata).toMatchObject({ leaseController: f.lease.metadata!.leaseController, historicalEvidence: "must survive", sandboxStopAndRetain: { endedLeaseEvidence: { status, cleanupStatus: "success", failureReason: "historical-idle-close", releasedAt: f.lease.releasedAt!.toISOString(), metadata: f.lease.metadata } } });
      const requestId = readStopOnlyCleanup(prepared)!.requestId;
      const stop = vi.fn(async () => undefined);
      const hb = heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
      for (let n = 0; n < 12; n++) {
        vi.setSystemTime(t0 + n * 1800_000);
        expect(await prepareInspectedSourceSandboxStop(db, await f.readLease(), result)).toBeNull();
        await hb.sweepPendingCleanupLeases();
        expect(readStopOnlyCleanup(await f.readLease())!.requestId).toBe(requestId);
      }
      expect(stop.mock.calls.length).toBeGreaterThan(0);
      expect(stop.mock.calls.length).toBeLessThanOrEqual(5);
      const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issue.id), eq(issueComments.authorType, "system")));
      expect(notes).toHaveLength(0); // the one started note is owed only at actual session selection
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
  }, 60_000);

});
