import { randomUUID } from "node:crypto";
import {
  activityLog, agentInstructionWorkingCopies, agents, agentWakeupRequests, companies,
  createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, environments, heartbeatRuns,
  issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatAgentStatus } from "./agent-status.js";

// smarty-dev#21005: a settled, stopped instruction copy whose only debt is the
// rm -rf of its per-run agent-files dir on a stopped-and-retained remote box
// (release(): remoteUnavailable -> cleanupPending stays true, next_attempt_at
// scheduled) is cleanup capacity, not agent execution. The copy's own retry
// worker keeps the cleanup; the agent must not show "running" forever.

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_STATUS_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping stopped copy cleanup tests: ${support.reason}`);

describePostgres("stranded agent status with a stopped copy's leftover remote cleanup", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let service: ReturnType<typeof createHeartbeatAgentStatus>;
  const live = new Set<string>();
  const old = () => new Date(Date.now() - 60 * 60_000);

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-agent-status-copy-cleanup-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6 });
    if (external) {
      db.$client.options.onnotice = () => {};
      await db.execute(sql`truncate companies cascade`);
    }
    service = createHeartbeatAgentStatus(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  beforeEach(async () => {
    live.clear();
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(activityLog);
    await db.delete(agentInstructionWorkingCopies);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  type Shape = { state?: string; baseline?: boolean; processStoppedAt?: Date | null };

  /** The live holder shape (HOLDERS-SAMPLE, fresh, 11-18): settled state, stopped,
   * no baseline, cleanupPending true, retry scheduled, lease stopped and retained. */
  async function seed(shape: Shape = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const leaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stale running", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer",
      status: "running", adapterType: "process", runtimeConfig: { heartbeat: { enabled: false } },
      lastHeartbeatAt: old(), updatedAt: old(), createdAt: old() });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
      invocationSource: "automation", status: "succeeded", runtimeMode: "legacy",
      startedAt: old(), finishedAt: old(), updatedAt: old(), createdAt: old() });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId,
      status: "expired", leasePolicy: "reuse_by_environment", provider: "daytona",
      providerLeaseId: "stopped-box", cleanupStatus: "success", releasedAt: old(), metadata: {} });
    const remoteCwd = "/home/daytona/workspace";
    const state = shape.state ?? "unchanged";
    await db.insert(agentInstructionWorkingCopies).values({ companyId, agentId, runId,
      responsibleUserId: "test-user", entryFile: "AGENTS.md", baseHash: "test-hash",
      localRoot: `/tmp/agent-files/${runId}/root`,
      executionRoot: `${remoteCwd}/.paperclip-runtime/agent-files/${agentId}/${runId}`,
      location: "remote:daytona", state,
      processStoppedAt: shape.processStoppedAt === undefined ? old() : shape.processStoppedAt,
      nextAttemptAt: new Date(Date.now() + 6 * 60 * 60_000), attempts: 0,
      receipt: { schema: "paperclip.agent-files.v1", state, appliedCandidateHash: null,
        storageWarning: null, cleanupPending: true, materializationRunId: runId,
        pendingConflicts: [], cleanup: { leaseId },
        ...(shape.baseline ? { baseline: { "AGENTS.md": "test-hash" } } : {}) } });
    return { companyId, agentId, runId };
  }

  const reconcile = () => service.reconcileStrandedAgentStatuses(() => live);
  const agent = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0]!);
  const reconciledEvents = (agentId: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, "agent.status_reconciled")));

  it.each(["unchanged", "unavailable"])("settles a stopped %s copy whose only debt is remote dir cleanup", async state => {
    const { agentId, runId } = await seed({ state });
    expect(await reconcile()).toEqual([agentId]);
    expect((await agent(agentId)).status).toBe("idle");
    expect(await reconciledEvents(agentId)).toEqual([expect.objectContaining({
      details: { previousStatus: "running", nextStatus: "idle", reason: "no_unsettled_execution" } })]);
    // The copy's own cleanup worker keeps its debt.
    expect(await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, runId)))
      .toEqual([expect.objectContaining({ state, nextAttemptAt: expect.any(Date),
        receipt: expect.objectContaining({ cleanupPending: true }) })]);
  });

  it.each([
    ["a baseline (unsaved local mirror)", { baseline: true }],
    ["pending_commit", { state: "pending_commit" }],
    ["pending_collection", { state: "pending_collection" }],
    ["a live process (process_stopped_at NULL)", { processStoppedAt: null }],
  ] as const)("keeps the agent running for a copy with %s", async (_label, shape) => {
    const { agentId } = await seed(shape);
    expect(await reconcile()).toEqual([]);
    expect((await agent(agentId)).status).toBe("running");
    expect(await reconciledEvents(agentId)).toEqual([]);
  });

  it("keeps the agent running while another run is running", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation",
      status: "running", runtimeMode: "legacy", startedAt: old(), updatedAt: old(), createdAt: old() });
    expect(await reconcile()).toEqual([]);
    expect((await agent(agentId)).status).toBe("running");
  });
});
