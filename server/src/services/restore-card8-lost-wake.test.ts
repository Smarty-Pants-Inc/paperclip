import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueRecoveryActions, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";

// Each worker scan is one reconcileRetainedWorkspaces call; the scan itself is
// stubbed (no runtime) so the test counts how often the idle worker looks.
const scans = vi.hoisted(() => ({ count: 0 }));
vi.mock("./workspace-recovery.js", async (original) => {
  const actual = await original<typeof import("./workspace-recovery.js")>();
  return { ...actual, reconcileRetainedWorkspaces: async () => { scans.count += 1; return []; } };
});

const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms));
// The bound the fallback promises (one 60 s re-arm period plus slack), literal on purpose.
const LOST_WAKE_BOUND_MS = 65_000;

// restore-card8 item 4 (rf-3 J1/J2): a hold written while the coordinator is idle
// and whose wake is lost is still scanned within one re-arm period.
(recoveryPostgresSupport.supported ? describe : describe.skip)("restore-card8: the idle worker finds an owed hold with a lost wake", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  async function start() {
    if (!database) {
      database = await startRecoveryPostgres("restore-card8-wake-");
      db = createDb(database.connectionString);
    }
    // Only this test's hold is on the schedule.
    await db.delete(issueRecoveryActions);
  }
  /** Writes an owed hold through `writer`, a separate database owner: its
   * notification never reaches the coordinator's owner (the lost wake). */
  async function writeOwedHold(writer: ReturnType<typeof createDb>) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await writer.insert(companies).values({ id: companyId, name: "Card8 wake", issuePrefix: companyId.slice(0, 8) });
    await writer.insert(agents).values({ id: agentId, companyId, name: "Card8 worker", adapterType: "paperclip_runner" });
    await writer.insert(issues).values({ id: issueId, companyId, title: "Owed files", status: "in_progress", assigneeAgentId: agentId });
    await writer.insert(environments).values({ id: environmentId, name: `Card8 ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    await writer.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId,
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), status: "failed",
      errorCode: "setup_failed", error: "The run stopped", finishedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId }, runnerProfileJson: { remoteWorkspace: reference }, resultJson: {} });
    await writer.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Owed remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    const [lease] = await writer.insert(environmentLeases).values({ id: leaseId, companyId,
      environmentId, heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } }).returning();
    expect(await preserveRemoteWorkspacePreparationFailure(writer, lease!)).not.toBeNull();
    const [action] = await writer.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(action.evidence).toMatchObject({ runId, workspaceRestorePending: true });
    return { companyId, issueId };
  }
  /** Advances the fake clock in 1 s steps, letting real database I/O settle. */
  async function advance(ms: number) {
    for (let at = 0; at < ms; at += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      await realSleep(15);
    }
  }
  async function idleWorker() {
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => undefined });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, {} as EnvironmentRuntimeService, async () => undefined);
    await worker.ready;
    await realSleep(200);
    return { coordinator, worker };
  }
  let running: Awaited<ReturnType<typeof idleWorker>> | undefined;
  afterEach(async () => {
    vi.useRealTimers();
    await running?.worker.stop();
    await running?.coordinator.stop();
    running = undefined;
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  // J1 without a person's message is gold #21172 (a lost wake on an idle
  // coordinator needs a re-arm only while an owed hold exists; the periodic
  // rescan 469574d5 conflicts with upstream's quiet-idle contract,
  // execution-control-work.test.ts:226). Its executable body is in commit
  // de289747 (restore-card8 RED); the person-message variant below is green.
  it.todo("J1: idle (nothing scheduled), then an owed hold with a LOST wake -> scanned again within one re-arm period (todo: gold #21172, RFL 12:30Z)");

  it("J1 + a person message: the deferred message wakes the scan", async () => {
    await start();
    // The hold is written by another owner (its wake is lost), as in J1.
    const writer = createDb(database.connectionString);
    try {
      scans.count = 0;
      running = await idleWorker();
      expect(scans.count).toBe(1);
      const { companyId, issueId } = await writeOwedHold(writer);
      await realSleep(500);
      expect(scans.count).toBe(1);
      // A person's new message on the task, through the real comment route on the coordinator's owner.
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      const comment = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Are my files back?" }).expect(201);
      // The message is saved behind the restore hold, not run (the route wakes the assignee after it answers).
      const saved = async () => (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`)))
        .map(row => (row.payload?._paperclipWakeContext as { wakeCommentId?: string } | undefined)?.wakeCommentId);
      await expect.poll(saved, { timeout: 10_000 }).toContain(comment.body.id);
      expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
      // Real clock: a wake runs the scan once the worker's 15 s reconciliation interval
      // has passed. Nothing else is scheduled (J1 NEGATIVE), so only the message's wake explains it.
      await expect.poll(() => scans.count, { timeout: 30_000, interval: 250 }).toBeGreaterThanOrEqual(2);
    } finally {
      await writer.$client.end();
    }
  }, 60_000);

  it("J2 CONTROL: a known owed hold at start -> scanned at least twice in 65 s", async () => {
    await start();
    await writeOwedHold(db);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    scans.count = 0;
    running = await idleWorker();
    await advance(LOST_WAKE_BOUND_MS);
    expect(scans.count).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("J1 NEGATIVE: idle with nothing owed -> the periodic check does not run a full scan", async () => {
    await start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    scans.count = 0;
    running = await idleWorker();
    await advance(LOST_WAKE_BOUND_MS);
    expect(scans.count).toBe(1);
  }, 120_000);
});
