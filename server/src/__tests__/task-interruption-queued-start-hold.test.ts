import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { hasPendingRunCleanup } from "../services/execution-blocker.js";
import { taskInterruptionPresentations } from "../services/task-interruption-presentation.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const captureTaskInterruptionFailure = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure }));

// Live row (22:48:09Z): a with-work run failed native_run_failed while the
// sandbox provider was unreachable. Its automatic successor stayed queued for
// 10+ minutes: the issue claim declines it with predecessor_cleanup_pending
// (heartbeat/queue.ts) while the predecessor's sandbox lease cannot be
// released. The card said "working", canRetry false, no line.
describe.skipIf(!support.supported)("a queued run that cannot start", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("queued-start-hold-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(() => { vi.useRealTimers(); });

  const queuedAt = new Date("2026-11-17T22:38:25.501Z");
  async function seed(lease: "sandbox_unreleased" | "local_settling" | "released") {
    const companyId = randomUUID(), agentId = randomUUID(), failedId = randomUUID(), queuedId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Queued hold", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Chat", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: null }).returning();
    await db.insert(heartbeatRuns).values({ id: failedId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "failed", runtimeMode: "native", errorCode: "native_run_failed", startedAt: new Date(queuedAt.getTime() - 60_000),
      finishedAt: new Date(queuedAt.getTime() - 5_000), createdAt: new Date(queuedAt.getTime() - 61_000) });
    {
      const released = lease === "released";
      await db.insert(environmentLeases).values({ companyId, heartbeatRunId: failedId, issueId: issue.id,
        provider: lease === "local_settling" ? "local" : "boat", providerLeaseId: lease === "local_settling" ? null : "boat-sbx-1",
        // The reaper records a destroy it could not confirm as pending_cleanup + failed.
        status: released ? "released" : lease === "local_settling" ? "active" : "pending_cleanup",
        cleanupStatus: released ? "success" : lease === "local_settling" ? null : "failed",
        releasedAt: released || lease === "sandbox_unreleased" ? new Date(queuedAt.getTime() - 4_000) : null });
    }
    // The automatic successor: never started, retries the failed run.
    await db.insert(heartbeatRuns).values({ id: queuedId, companyId, agentId, issueId: issue.id, scopeKind: "issue",
      status: "queued", invocationSource: "automation", triggerDetail: "system", runtimeMode: "legacy",
      retryOfRunId: failedId, startedAt: null, createdAt: queuedAt,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_status_changed" } });
    return { companyId, agentId, issue, failedId, queuedId };
  }
  const at = (offsetMs: number) => vi.setSystemTime(new Date(queuedAt.getTime() + offsetMs));
  const project = async (f: Awaited<ReturnType<typeof seed>>) =>
    (await taskInterruptionPresentations(db, f.companyId, [f.issue])).get(f.issue.id);

  it("names the sandbox provider hold past the queued-input bound, never 'working', and offers no Retry", async () => {
    const f = await seed("sandbox_unreleased");
    vi.useFakeTimers({ toFake: ["Date"] });
    // The dispatcher's own gate (heartbeat/queue.ts predecessor_cleanup_pending) refuses this run.
    expect(await hasPendingRunCleanup(db, f.companyId, f.failedId)).toBe(true);
    for (const offset of [0, 30_000, 119_000]) {
      at(offset);
      expect(await project(f)).toMatchObject({ state: "working", canRetry: false, observedRunId: f.queuedId });
    }
    for (const offset of [10 * 60_000, 120_000, 121_000, 60 * 60_000]) {
      at(offset);
      expect(await project(f)).toMatchObject({ responsibility: "system", state: "failed", canRetry: false,
        observedRunId: f.queuedId, retryWait: { reason: "sandbox_provider_wait",
          message: "Waiting for the sandbox provider. Your message is saved." } });
    }
  }, 60_000);

  it("names a previous-run hold with no sandbox, and lets a released predecessor keep its ordinary line", async () => {
    const local = await seed("local_settling");
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await hasPendingRunCleanup(db, local.companyId, local.failedId)).toBe(true);
    at(119_000);
    expect(await project(local)).toMatchObject({ state: "working" });
    at(10 * 60_000);
    expect(await project(local)).toMatchObject({ state: "failed", canRetry: false, retryWait: {
      reason: "previous_run_settling", message: "Waiting for the previous run to stop. Your message is saved." } });
    const released = await seed("released");
    expect(await hasPendingRunCleanup(db, released.companyId, released.failedId)).toBe(false);
    at(10 * 60_000);
    // Nothing holds it at the claim: the dispatcher is starting it.
    expect(await project(released)).toMatchObject({ state: "working" });
  }, 60_000);

  it("shows a started run as working at any age", async () => {
    for (const status of ["running", "queued"] as const) {
      const f = await seed("sandbox_unreleased");
      await db.update(heartbeatRuns).set({ status, startedAt: new Date(queuedAt.getTime() + 1_000) })
        .where(eq(heartbeatRuns.id, f.queuedId));
      vi.useFakeTimers({ toFake: ["Date"] });
      at(10 * 60_000);
      expect(await project(f)).toMatchObject({ state: "working", canRetry: false });
      vi.useRealTimers();
    }
  }, 60_000);

  it("never creates a second run when Retry is pressed on the held task", async () => {
    const f = await seed("sandbox_unreleased");
    const runsFor = async () => db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, f.companyId), or(eq(heartbeatRuns.issueId, f.issue.id), eq(heartbeatRuns.nativeIssueId, f.issue.id))));
    expect(await runsFor()).toHaveLength(2);
    for (let press = 0; press < 2; press++)
      await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: "board",
        idempotencyKey: randomUUID(), observedRunId: f.queuedId }).catch(() => undefined);
    const after = await runsFor();
    expect(after).toHaveLength(2);
    expect(after.filter(run => run.status === "queued").map(run => run.id)).toEqual([f.queuedId]);
  }, 60_000);
});
