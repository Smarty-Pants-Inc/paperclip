import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { executionFailureRetryCount } from "../services/execution-recovery-attempt.ts";
import { withIndependentWorkspaceSourceLocks } from "../services/workspace-source-lock.ts";

// Issue #21017 / PR #21071: run preparation waited without a limit on the
// managed project source key. One stalled holder of that key plus ten runs
// preparing in the same project must give ten bounded waits that end as an
// expected cancel with a scheduled retry that spends no failure retry; every
// waiter then starts once the holder releases.
//
// The PR has no runtime knob for its 30 s wait (`WORKSPACE_SOURCE_LOCK_WAIT`
// is a module constant), so the "real" case runs the full 30 s once and the
// "shortened" case narrows only the wait handed to
// withIndependentWorkspaceSourceLocks (3 s) through a module mock. Without the
// port no wait is handed over, so the mock changes nothing at the target.
const sourceLockWaitOverride = vi.hoisted(() => ({ waitMs: null as number | null }));
vi.mock("../services/workspace-source-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace-source-lock.js")>();
  return {
    ...actual,
    withIndependentWorkspaceSourceLocks: ((db, input, action, tryOnly, wait) =>
      actual.withIndependentWorkspaceSourceLocks(db, input, action, tryOnly,
        wait && sourceLockWaitOverride.waitMs !== null ? { ...wait, waitMs: sourceLockWaitOverride.waitMs } : wait)
    ) as typeof actual.withIndependentWorkspaceSourceLocks,
  };
});

// Documented test bound: the database's statement_timeout is 45 s, above the
// PR's 30 s source-lock wait and below the 120 s stalled holder. Without the
// port the blocking project-key wait ends only on this statement_timeout.
const TEST_STATEMENT_TIMEOUT_MS = 45_000;
const HOLDER_STALL_MS = 120_000;
const WAITERS = 10;
const ADAPTER = "source_lock_wait_test";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("bounded workspace source lock wait in run preparation (#21017)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const executed: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-source-lock-wait-");
    const admin = createDb(tempDb.connectionString);
    const databaseName = new URL(tempDb.connectionString).pathname.slice(1);
    await admin.execute(sql.raw(`alter database "${databaseName}" set statement_timeout = ${TEST_STATEMENT_TIMEOUT_MS}`));
    await admin.$client.end();
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      execute: async (input) => {
        executed.push(input.runId);
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 60_000);

  afterEach(async () => {
    sourceLockWaitOverride.waitMs = null;
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    executed.length = 0;
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    // The embedded database is discarded whole; no row cleanup.
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedProject() {
    const companyId = randomUUID(), projectId = randomUUID(), projectWorkspaceId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    // A local project checkout under the instance's managed project root, so
    // preparation adds the managed project source key inside its issue scope.
    const cwd = path.join(resolvePaperclipInstanceRoot(), "projects", companyId, projectId, "repo");
    await fs.mkdir(cwd, { recursive: true });
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible user",
      email: "source-lock@example.test", createdAt: now, updatedAt: now }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Source lock project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Primary",
      sourceType: "local_path", cwd, isPrimary: true });
    const waiters: Array<{ agentId: string; issueId: string }> = [];
    for (let index = 0; index < WAITERS; index += 1) {
      const agentId = randomUUID(), issueId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: `Waiter${index}`, role: "engineer", status: "idle",
        adapterType: ADAPTER, adapterConfig: {}, permissions: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
      await db.insert(issues).values({ id: issueId, companyId, title: `Waiter issue ${index}`, status: "in_progress",
        priority: "medium", responsibleUserId: "responsible-user", assigneeAgentId: agentId, projectId,
        projectWorkspaceId, issueNumber: index + 1, identifier: `${issuePrefix}-${index + 1}` });
      waiters.push({ agentId, issueId });
    }
    return { companyId, projectId, waiters };
  }

  async function runScenario(label: string, expectedWaitMs: number) {
    const fixture = await seedProject();
    // ONE stalled holder of the project's source key, taken through the real
    // acquire path in its own session. It stalls up to 120 s and is released
    // early by the test once every waiter has settled.
    let entered!: () => void, release!: () => void;
    const holderEntered = new Promise<void>(resolve => { entered = resolve; });
    const holderFree = new Promise<void>(resolve => { release = resolve; });
    const stall = setTimeout(() => release(), HOLDER_STALL_MS);
    let holderReleased = false;
    const holder = withIndependentWorkspaceSourceLocks(db, { companyId: fixture.companyId, projectIds: [fixture.projectId] },
      async () => { entered(); await holderFree; holderReleased = true; return "held"; });
    try {
      await holderEntered;
      const started = Date.now();
      const progress = setInterval(() => {
        void db.execute(sql`select wait_event_type, wait_event, state, left(query, 80) as query, now() - query_start as running
          from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`)
          .then(rows => console.log(`[source-lock-wait] ${label} t+${Date.now() - started}ms active=${JSON.stringify(rows)}`))
          .catch(() => undefined);
      }, 10_000);
      // Wake the ten waiters one after another (each wake commits before the
      // next); their preparations then wait concurrently on the held key.
      const runs = [];
      for (const waiter of fixture.waiters) runs.push(await heartbeat.invoke(waiter.agentId, "assignment",
        { issueId: waiter.issueId, wakeReason: "issue_assigned" }, "system"));
      expect(runs.every(Boolean)).toBe(true);
      const runIds = runs.map(run => run!.id);
      console.log(`[source-lock-wait] ${label} invoked ${runIds.length} runs at t+${Date.now() - started}ms`);
      await heartbeat.drainActiveRunExecutions();
      clearInterval(progress);
      const settledAfterMs = Date.now() - started;
      const settled = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds));
      const retries = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.retryOfRunId, runIds));
      const holderStillHeld = !holderReleased;
      const summary = {
        label, settledAfterMs, holderStillHeld,
        waiters: settled.map(run => ({
          status: run.status, errorCode: run.errorCode, error: run.error?.slice(0, 160) ?? null,
          waitedMs: run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
          failureRetriesSpent: executionFailureRetryCount(run),
          cancellation: (run.resultJson as Record<string, any> | null)?.cancellation ?? null,
        })),
        retries: retries.map(run => ({ status: run.status, reason: run.scheduledRetryReason,
          attempt: run.scheduledRetryAttempt,
          failureRetries: (run.contextSnapshot as Record<string, any> | null)?.executionRetryAccounting?.failureRetries ?? null,
          failureRetriesBeforeWorkspaceWait:
            (run.contextSnapshot as Record<string, any> | null)?.failureRetriesBeforeWorkspaceWait ?? null })),
      };
      console.log(`[source-lock-wait] ${JSON.stringify(summary)}`);
      // Optional evidence file for reviewers (vitest may hide a passing test's stdout).
      if (process.env.SOURCE_LOCK_WAIT_EVIDENCE)
        await fs.appendFile(process.env.SOURCE_LOCK_WAIT_EVIDENCE, `${JSON.stringify(summary)}\n`);

      // The holder still holds the key: the waits ended on their own bound.
      expect(holderStillHeld).toBe(true);
      for (const run of settled) {
        expect(run.status, `waiter ${run.id}`).toBe("cancelled");
        expect(run.errorCode).toBe("workspace_busy");
        expect((run.resultJson as Record<string, any>).cancellation).toMatchObject({ expected: true, source: "control_plane" });
        expect((run.resultJson as Record<string, any>).executionRecovery).toMatchObject({ kind: "workspace_wait", providerWorkStarted: false });
        const waited = run.finishedAt!.getTime() - run.startedAt!.getTime();
        expect(waited).toBeGreaterThanOrEqual(expectedWaitMs - 1_000);
        expect(waited).toBeLessThan(expectedWaitMs + 10_000);
        expect(executionFailureRetryCount(run)).toBe(0);
      }
      expect(executed).toEqual([]);
      expect(retries).toHaveLength(WAITERS);
      for (const retry of retries) {
        expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 1 });
        const context = retry.contextSnapshot as Record<string, any>;
        // The failure-retry counter is unchanged by the wait.
        expect(context.executionRetryAccounting.failureRetries).toBe(0);
        expect(context.failureRetriesBeforeWorkspaceWait).toBe(0);
        expect(executionFailureRetryCount(retry)).toBe(0);
        expect(context.workspaceBusyDeferredWhileAssignee).toBe(true);
      }

      // The holder releases: every waiter's retry starts and runs.
      release();
      await holder;
      const promotion = await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 10 * 60_000));
      // Promotion is instance-wide; this scenario's ten retries must be in it.
      expect(promotion.runIds).toEqual(expect.arrayContaining(retries.map(retry => retry.id)));
      const otherPromoted = promotion.runIds.filter(id => !retries.some(retry => retry.id === id));
      if (otherPromoted.length > 0) {
        const rows = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, otherPromoted));
        console.log(`[source-lock-wait] ${label} also promoted: ${JSON.stringify(rows.map(run => ({ reason: run.scheduledRetryReason,
          retryOfRunId: run.retryOfRunId, wakeReason: (run.contextSnapshot as Record<string, any> | null)?.wakeReason ?? null })))}`);
      }
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const finished = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, retries.map(retry => retry.id)));
      console.log(`[source-lock-wait] ${label} after release: ${JSON.stringify(finished.map(run => ({ status: run.status, errorCode: run.errorCode })))}`);
      expect(finished.map(run => run.status)).toEqual(Array(WAITERS).fill("succeeded"));
      // Every waiter's retry started and reached the adapter; no original
      // waiter did. Later runs (follow-up wakes after a successful run) may
      // also execute; they are logged, not asserted.
      const retryIds = retries.map(retry => retry.id);
      expect(executed).toEqual(expect.arrayContaining(retryIds));
      expect(executed.filter(id => runIds.includes(id))).toEqual([]);
      const extra = executed.filter(id => !retryIds.includes(id));
      if (extra.length > 0) {
        const rows = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, extra));
        console.log(`[source-lock-wait] ${label} later runs: ${JSON.stringify(rows.map(run => ({ status: run.status,
          wakeReason: (run.contextSnapshot as Record<string, any> | null)?.wakeReason ?? null, retryOfRunId: run.retryOfRunId })))}`);
      }
    } finally {
      clearTimeout(stall);
      release();
      await holder.catch(() => undefined);
    }
  }

  it("real 30 s wait: ten waiters behind one stalled project-key holder cancel as expected, keep their failure retries, and all start after release",
    () => runScenario("real-30s", 30_000), 240_000);

  it("shortened 3 s wait: same contract", async () => {
    sourceLockWaitOverride.waitMs = 3_000;
    await runScenario("shortened-3s", 3_000);
  }, 240_000);
});
