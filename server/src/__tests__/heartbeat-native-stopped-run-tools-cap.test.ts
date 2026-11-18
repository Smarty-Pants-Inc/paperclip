import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { STOPPED_RUN_TOOLS_WAIT_KEY } from "../services/native-runtime/native-controller-recovery.js";
import {
  readStoppedRunToolsWait, STOPPED_RUN_TOOLS_UNCONFIRMED, STOPPED_RUN_TOOLS_UNCONFIRMED_NOTE, stoppedRunHoldsActiveLease,
} from "../services/native-runtime/native-session-executor.js";

// Keep reason: S095 cap. A run that fails with NativeStoppedRunToolsUnconfirmedError
// tells the person one true thing (its error: "... Press Retry to try again.")
// and the failed-run card offers Retry. The native terminal recovery
// (wake-queue/adapters/postgres.ts recordNativeTerminalRecoveryIfNeeded) must
// not add a blocked status and an active_run_watchdog hold that says Paperclip
// continues on its own. Only the executor edge is scripted: it throws the
// typed cap error exactly as native-session-executor.ts
// retireAfterStopIssuedTurnCommands does, after the earlier deferrals stamped
// the run's stoppedRunToolsWait (native-controller-recovery.ts
// deferNativeControllerRecovery). The real heartbeat, run completion, release,
// Retry route (POST /issues/:id/retry) and resumeTaskRetry do the rest.
const fixture = vi.hoisted(() => ({ stoppedRunId: "", executed: [] as string[] }));

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  const recovery = await import("../services/native-runtime/native-controller-recovery.js");
  return {
    ...actual,
    executePaperclipNativeSession: (async input => {
      const { heartbeatRuns } = await import("@paperclipai/db");
      const runId = input.execution.binding.runId;
      fixture.executed.push(runId);
      await input.db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
        || ${JSON.stringify({ [recovery.STOPPED_RUN_TOOLS_WAIT_KEY]: { stoppedRunId: fixture.stoppedRunId, deferrals: 2,
          firstDeferredAt: new Date(Date.now() - 11 * 60_000).toISOString() } })}::jsonb`,
      runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || '{"nativeExecutionInput":{}}'::jsonb` })
        .where(eq(heartbeatRuns.id, runId));
      throw new actual.NativeStoppedRunToolsUnconfirmedError(fixture.stoppedRunId);
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import { heartbeatService } from "../services/heartbeat.js";
import * as heartbeatServices from "../services/heartbeat.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("S095 cap: one true note and a working Retry", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-native-stopped-run-tools-cap-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "native-stopped-run-tools-cap-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "local-board", name: "Board User",
      email: "board-user@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    const writable = async (dir: string): Promise<void> => {
      const stat = await fs.lstat(dir).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(dir, 0o700);
      for (const entry of await fs.readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) await writable(path.join(dir, entry.name));
    };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }); }
  });

  function heartbeatFor(db: ReturnType<typeof createDb>, ids: { companyId: string; issueId: string }) {
    return heartbeatService(db, {
      nativeSessionBackendFactory: () => ({}) as never,
      beforeNativeRuntimeSelection: async id => {
        // The run's Boat box.
        await db.insert(environmentLeases).values({ companyId: ids.companyId, issueId: ids.issueId, heartbeatRunId: id,
          provider: "boat", providerLeaseId: `bx_${id.slice(0, 8)}`, status: "active", leasePolicy: "reuse_by_environment",
          metadata: { driver: "sandbox", remoteCwd: "/workspace" } });
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: ids.issueId, nativePhase: "observed" })
          .where(eq(heartbeatRuns.id, id));
        await db.insert(nativeRunFinalizations).values({ runId: id, companyId: ids.companyId, issueId: ids.issueId, phase: "observed" })
          .onConflictDoNothing();
      },
    });
  }

  async function cappedRun() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const stoppedRunId = randomUUID(), wakeupRequestId = randomUUID();
    fixture.stoppedRunId = stoppedRunId;
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "S095", issuePrefix,
      defaultResponsibleUserId: "local-board", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "local-board",
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "paperclip/faux" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    // The person's Stop: the stopped run, finished, its box no longer held.
    await db.insert(heartbeatRuns).values({ id: stoppedRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "cancelled", runtimeMode: "native", nativeIssueId: issueId,
      contextSnapshot: { issueId }, finishedAt: new Date() });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "assignment",
      triggerDetail: "system", reason: "issue_assigned", payload: { issueId }, status: "queued", runId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "queued", wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, responsibleUserId: "local-board", issueNumber: 1,
      identifier: `${issuePrefix}-1`, startedAt: new Date() });
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    const heartbeat = heartbeatFor(db, { companyId, issueId });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    return { companyId, agentId, runId, issueId, stoppedRunId, heartbeat };
  }

  const issueRow = async (issueId: string) => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  const runRow = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;

  function boardApp(heartbeat: ReturnType<typeof heartbeatService>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "local-board", source: "local_implicit" } as never; next(); });
    const factory = vi.spyOn(heartbeatServices, "heartbeatService").mockReturnValue(heartbeat);
    try { app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1])); }
    finally { factory.mockRestore(); }
    app.use(errorHandler);
    return app;
  }

  it("S095 cap: the capped run's note is the only note: no watchdog hold, the issue is not blocked by it, the card offers Retry", async () => {
    const f = await cappedRun();
    const run = await runRow(f.runId);
    expect.soft(run).toMatchObject({ status: "failed", error: STOPPED_RUN_TOOLS_UNCONFIRMED_NOTE });
    expect.soft((run.resultJson as { failureCause?: string }).failureCause).toBe(STOPPED_RUN_TOOLS_UNCONFIRMED);
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect.soft(holds.map(hold => [hold.kind, hold.cause, hold.nextAction])).toEqual([]);
    const issue = await issueRow(f.issueId);
    expect.soft(issue.status).not.toBe("blocked");
    const [finalization] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect.soft(finalization?.failureCode).not.toBe("native_continuation_requires_reconciliation");
    // No automatic continuation either: the person's Retry is the next run.
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect.soft(wakes.map(wake => [wake.reason, wake.status])).toEqual([["issue_assigned", "failed"]]);
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  }, 60_000);

  it("S095 cap: the real Retry route makes a run that retries the capped run (previousRunId + the person's receipt), and step 3 admits it with no active box", async () => {
    const f = await cappedRun();
    const receipt = (await request(boardApp(f.heartbeat)).post(`/api/issues/${f.issueId}/retry`)
      .send({ observedRunId: f.runId, idempotencyKey: randomUUID() })).body as { accepted?: boolean; requestId?: string };
    expect(receipt).toMatchObject({ accepted: true });
    await f.heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    expect(wake?.runId).toBeTruthy();
    const retry = await runRow(wake!.runId!);
    // The task Retry route records its source as previousRunId with the
    // person's receipt (heartbeat/queue.ts enqueueWakeup); retryOfRunId is set
    // only by a failed chat run's Retry, so it is null here.
    expect(retry.contextSnapshot).toMatchObject({ wakeReason: "task_retry", previousRunId: f.runId,
      taskRetryRequestId: receipt.requestId });
    expect(retry.retryOfRunId).toBeNull();
    // Step 3's own predicate (native-session-executor.ts retireAfterStopIssuedTurnCommands
    // retryWithoutBox) on these rows: a Retry after the cap, the stopped run holding no active box.
    const input = { db, execution: { binding: { companyId: f.companyId, runId: retry.id } } } as never;
    expect(await readStoppedRunToolsWait(input, f.stoppedRunId)).toMatchObject({ retryOfWaited: true, retryAfterCap: true });
    expect(await stoppedRunHoldsActiveLease(input, f.stoppedRunId)).toBe(false);
    expect((await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, f.stoppedRunId),
      eq(environmentLeases.status, "active"))))).toEqual([]);
  }, 60_000);
});
