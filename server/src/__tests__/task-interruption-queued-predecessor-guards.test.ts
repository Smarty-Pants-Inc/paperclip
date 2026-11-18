import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRuns, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { hasPendingRunCleanup } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const captureTaskInterruptionFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure }));
const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false,
  errorMessage: null, summary: "Queued predecessor guard test run.", provider: "test", model: "test-model" })));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

// rf-3 (smarty-dev#20787): the card's queued-start hold must be the claim's
// own predecessor decision. A predecessor the claim skips (superseded by a
// fresh continuation, or an unrelated same-company run named as retryOfRunId)
// does not hold the run: the claim starts it, so the card must say working.
describe.skipIf(!support.supported)("a queued run's predecessor hold is the claim's decision", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("queued-predecessor-guards-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await db.execute(sql`truncate table ${companies} cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(kind: "held" | "superseded" | "unrelated") {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    const predecessorId = randomUUID(), queuedId = randomUUID(), wakeupRequestId = randomUUID();
    const queuedAt = new Date(Date.now() - 10 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Predecessor guards", status: "active",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    for (const id of [agentId, otherAgentId])
      await db.insert(agents).values({ id, companyId, name: `Agent ${id.slice(0, 4)}`, role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    const [issue] = await db.insert(issues).values({ companyId, title: "Chat", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const [otherIssue] = await db.insert(issues).values({ companyId, title: "Other", status: "in_progress",
      assigneeAgentId: otherAgentId }).returning();
    // The failed predecessor whose sandbox lease the provider has not released.
    const unrelated = kind === "unrelated";
    await db.insert(heartbeatRuns).values({ id: predecessorId, companyId, agentId: unrelated ? otherAgentId : agentId,
      issueId: unrelated ? otherIssue.id : issue.id, status: "failed", errorCode: "native_run_failed",
      startedAt: new Date(queuedAt.getTime() - 60_000), finishedAt: new Date(queuedAt.getTime() - 5_000),
      createdAt: new Date(queuedAt.getTime() - 61_000),
      contextSnapshot: { issueId: unrelated ? otherIssue.id : issue.id },
      resultJson: kind === "superseded" ? { freshContinuationSupersededAt: new Date(queuedAt.getTime() - 4_000).toISOString() } : null });
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: predecessorId,
      issueId: unrelated ? otherIssue.id : issue.id, provider: "boat", providerLeaseId: "boat-sbx-1",
      status: "pending_cleanup", cleanupStatus: "failed", releasedAt: new Date(queuedAt.getTime() - 4_000) });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "on_demand",
      triggerDetail: "manual", status: "queued", runId: queuedId, requestedByActorType: "user",
      requestedByActorId: "board-user", payload: { manualUserWake: true } });
    await db.insert(heartbeatRuns).values({ id: queuedId, companyId, agentId, issueId: issue.id, status: "queued",
      invocationSource: "on_demand", triggerDetail: "manual", wakeupRequestId, retryOfRunId: predecessorId,
      startedAt: null, createdAt: queuedAt, contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_status_changed" } });
    return { companyId, issue, predecessorId, queuedId };
  }
  const card = async (f: Awaited<ReturnType<typeof seed>>) =>
    (await taskInterruptionPresentations(db, f.companyId, [f.issue])).get(f.issue.id);
  async function claimStarted(f: Awaited<ReturnType<typeof seed>>) {
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const [run] = await db.select({ startedAt: heartbeatRuns.startedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.queuedId));
    return run?.startedAt != null;
  }

  it("control: a same-task predecessor with pending cleanup holds the claim, and the card names it", async () => {
    const f = await seed("held");
    expect(await hasPendingRunCleanup(db, f.companyId, f.predecessorId)).toBe(true);
    expect(await card(f)).toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "sandbox_provider_wait" } });
    expect(await claimStarted(f)).toBe(false);
  }, 60_000);

  it("(a) a predecessor superseded by a fresh continuation: the card says working and the claim starts", async () => {
    const f = await seed("superseded");
    expect(await hasPendingRunCleanup(db, f.companyId, f.predecessorId)).toBe(true);
    expect(await card(f)).toMatchObject({ state: "working" });
    expect(await claimStarted(f)).toBe(true);
  }, 60_000);

  it("(b) an unrelated same-company retry predecessor: the card says working and the claim starts", async () => {
    const f = await seed("unrelated");
    expect(await hasPendingRunCleanup(db, f.companyId, f.predecessorId)).toBe(true);
    expect(await card(f)).toMatchObject({ state: "working" });
    expect(await claimStarted(f)).toBe(true);
  }, 60_000);
});
