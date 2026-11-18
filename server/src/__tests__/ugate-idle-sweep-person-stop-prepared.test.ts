import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { nextWarmSandboxStopAt, stopWarmSandboxesPastWindow, warmSandboxWindowMetadata } from "../services/warm-sandbox-expiry.js";

// KEEP (never-OK, adopt-stopu-ugate (3)): the idle sweep (warm-window expiry,
// run by the environment cleanup sweep: heartbeat/recovery.ts
// stopWarmSandboxesPastWindowWhenDue) must never enqueue the stop-only cleanup
// of a box whose person-stopped run's workspace descriptor is still `prepared`
// (its edit exists only on that box). The pending_cleanup sweep skips the
// export-pending check for stop-only rows, so the enqueue is the last gate.
const support = await getEmbeddedPostgresTestSupport();
const MINUTE = 60_000;

describe.skipIf(!support.supported)("adopt-stopu-ugate (3): the idle sweep never enqueues a stop-only cleanup of a prepared person-Stop source", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), issueId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("ugate-idle-sweep-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "UGS", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Warm work" });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed(input: { personStop: boolean; descriptor: "prepared" | "finalized" }) {
    const runId = randomUUID(), leaseId = randomUUID(), now = Date.now();
    const providerLeaseId = `sandbox://fake/${leaseId}`;
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", invocationSource: "on_demand", status: input.personStop ? "cancelled" : "succeeded", nextEventSeq: 1,
      runnerProfileJson: { nativeResourceDisposition: "keep_running", nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: input.descriptor, descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId, providerLeaseId,
        remoteCwd: "/workspace", resourceDisposition: "keep_running" } },
      resultJson: input.personStop ? { cancelledByActorType: "user", cancelledByUserId: "person", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
        reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: new Date(now).toISOString() } } : {} });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId,
      status: "retained", cleanupStatus: "success", leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
      acquiredAt: new Date(now - 30 * MINUTE), lastUsedAt: new Date(now - 20 * MINUTE),
      metadata: { provider: "fake", reuseLease: true, ...warmSandboxWindowMetadata(5 * MINUTE) } });
    return leaseId;
  }

  it("a prepared person-Stop source past its warm window: no stop-only cleanup enqueued, box kept; a finalized one still stops", async () => {
    const prepared = await seed({ personStop: true, descriptor: "prepared" });
    const result = await stopWarmSandboxesPastWindow(db);
    const [row] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, prepared));
    const evidence = { result, status: row!.status, stopIntent: row!.metadata?.sandboxStopAndRetain ?? null,
      nextWarmSandboxStopAt: await nextWarmSandboxStopAt(db) };
    console.log("UGATE_IDLE_SWEEP_EVIDENCE", JSON.stringify(evidence));
    expect(evidence.stopIntent).toBeNull();
    expect(row!.status).toBe("retained");
    expect(result).toEqual({ stopping: 0 });
    // Not perpetually due: the cleanup worker does not spin on it.
    expect(evidence.nextWarmSandboxStopAt).toBeNull();

    // Control: once that run's export finalized, the same sweep stops its box.
    const finalized = await seed({ personStop: true, descriptor: "finalized" });
    expect(await stopWarmSandboxesPastWindow(db)).toEqual({ stopping: 1 });
    const [done] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, finalized));
    expect(done!.metadata?.sandboxStopAndRetain).toMatchObject({ warmWindowExpired: true });
  }, 60_000);
});
