import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import { hasRecoveredCleanupStopReceipt, ownLeaseTerminated, remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { parkedCleanupDisposition } from "../services/environment-retained-orphan-settlement.js";

// RFL port read (pl/pausing-s1-c1b, hunk 1): a CARRIED cleanup stop receipt
// (workspaceRecoveryCleanup.stopReceipt) goes through c1b's B1 rule too. A stop
// receipt proves the box stopped at confirmedAt, not that it stayed stopped:
// another holder's lease on the same box acquired at or after confirmedAt voids it.
describe("pausing carried stop receipt under c1b B1", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pausing-carried-b1-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  it("RFL port: a carried stop receipt with another holder's lease on the same box acquired at its confirmedAt is NOT proof, and the park key does not park", async () => {
    const companyId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pausing B1", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(environments).values({ id: environmentId, companyId, name: `Boat ${environmentId}`, driver: "sandbox",
      status: "active", config: { provider: "boat" } } as never);
    const [agent] = await db.insert(agents).values({ companyId, name: "Boat Lead", adapterType: "process",
      status: "running", defaultEnvironmentId: environmentId, lifecycleRequiredPluginIds: [] }).returning();
    const [run, other] = await db.insert(heartbeatRuns).values([0, 1].map(() => ({ companyId, agentId: agent!.id, status: "cancelled",
      invocationSource: "on_demand", runtimeMode: "legacy", startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 100_000) }))).returning();
    const providerLeaseId = `boat-${randomUUID()}`;
    const identity = { id: randomUUID(), companyId, heartbeatRunId: run!.id, provider: "boat", providerLeaseId };
    // The carried receipt is bound to this exact lease, run and provider, confirmed at a fixed past instant.
    const confirmedAt = new Date(Date.now() - 80_000);
    const stopReceipt = { ...remoteTerminationReceipt(identity, { providerLeaseId, state: "stopped" })!, confirmedAt: confirmedAt.toISOString() };
    await db.insert(environmentLeases).values({ ...identity, environmentId, status: "pending_cleanup", cleanupStatus: "failed",
      leasePolicy: "ephemeral", acquiredAt: new Date(Date.now() - 110_000), releasedAt: new Date(Date.now() - 90_000),
      failureReason: "retained_orphan_sandbox_released", updatedAt: new Date(Date.now() - 3_600_000),
      metadata: { agentId: agent!.id, workspaceRecoveryCleanup: { runId: run!.id, reason: "retained_orphan_sandbox_released", stopReceipt } } });
    const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, identity.id)))[0]!;
    const owner = { companyId, environmentId, providerLeaseId, runId: run!.id, leaseId: identity.id };
    const scope = { carriedCleanupStop: true, ownLeaseOnly: true } as const;
    const stopped = { providerLeaseId, state: "stopped" };

    // Control: alone on its box, the carried receipt is the park key's proof.
    expect(hasRecoveredCleanupStopReceipt(await lease())).toBe(true);
    expect(await ownLeaseTerminated(db, owner, scope)).toBe(true);
    expect(await parkedCleanupDisposition(db, await lease(), new Date(), stopped)).toMatchObject({ state: "parked", code: "provider_retains_resource" });

    // Another holder (another run) takes the same box (same provider + providerLeaseId)
    // exactly at the receipt's confirmedAt; it has since closed.
    await db.insert(environmentLeases).values({ id: randomUUID(), companyId, environmentId, heartbeatRunId: other!.id, provider: "boat",
      providerLeaseId, status: "released", cleanupStatus: "success", leasePolicy: "ephemeral",
      acquiredAt: confirmedAt, releasedAt: new Date(Date.now() - 70_000), metadata: { agentId: agent!.id } });

    expect(hasRecoveredCleanupStopReceipt(await lease()), "the carried receipt itself is still well-formed").toBe(true);
    expect(await ownLeaseTerminated(db, owner, scope), "B1: a carried receipt does not prove the box stayed stopped").toBe(false);
    expect(await parkedCleanupDisposition(db, await lease(), new Date(), stopped)).toBeUndefined();
    expect(await parkedCleanupDisposition(db, await lease(), new Date())).toBeUndefined();

    // The real pending-destroy sweep (provider answers "stopped") does not park it either.
    const destroy = vi.fn(async (input: { lease: { providerLeaseId: string | null } }) => ({ providerLeaseId: input.lease.providerLeaseId, state: "stopped" }));
    const runtime = environmentRuntimeService(db);
    const sweeper = heartbeatService(db, { environmentRuntime: { ...runtime, inspectLeaseResource: vi.fn(async () => undefined),
      releaseRunLeases: vi.fn(async () => []), isPendingCleanupWorkerReady: async () => true,
      destroyRunLease: destroy, retryPendingSandboxTeardown: destroy } as never });
    await sweeper.sweepPendingCleanupLeases({ backoffMs: 0 }).catch(() => undefined);
    expect(((await lease()).metadata as Record<string, unknown>).cleanupDisposition).toBeUndefined();
  });
});
