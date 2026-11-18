import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { workspaceOperations } from "@paperclipai/db";
import { workspaceOperationService } from "../services/workspace-operations.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

// smarty-dev#20454 (FU-1, F2l): a run's workspace_operations insert carries
// heartbeat_run_id AND issue_id. Its foreign-key checks take FOR KEY SHARE on
// the run first (constraint from migration 0037), then on the issue (0108).
// The documented issue -> run order (run-dispatch withRunOwnershipLocks,
// queue claim, checkout) holds the issue FOR UPDATE and then asks for the run
// FOR UPDATE, which conflicts with that KEY SHARE. Run -> issue vs
// issue -> run: Postgres kills one with 40P01. On d22668bd the insert owner
// has no retry, so a native run's startup failed with
// "Database query failed (40P01)" (prod C8 run cd191df1).
(support.supported ? describe : describe.skip)("workspace-operation insert vs issue -> run locker (40P01)", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });

  const settle = <T>(promise: Promise<T>) => promise.then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const describeError = (error: unknown) => {
    const e = error as { code?: string; cause?: { code?: string; message?: string }; message?: string };
    return `${e?.cause?.code ?? e?.code ?? "?"} ${String(e?.cause?.message || e?.message).slice(0, 120)}`;
  };
  const deadlocks = async () => {
    await server.db.execute(sql`select pg_stat_clear_snapshot()`);
    const [row] = await server.db.execute<{ n: string }>(sql`select deadlocks::text as n from pg_stat_database where datname = current_database()`);
    return Number(row!.n);
  };

  it("the run's workspace_operations insert survives a concurrent issue FOR UPDATE -> run FOR UPDATE transaction", async () => {
    const f = await server.fixture({ connectionScenario: "fresh", apiToolsEnabled: false, disableWakeOnDemand: true });
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const deadlocksBefore = await deadlocks();
    const retryStats = await import("../services/transaction-retry.js").then(m => m.transactionRetryStats);
    const retriedBefore = retryStats.retried;

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let issueHeld!: () => void;
    const issueLocked = new Promise<void>(resolve => { issueHeld = resolve; });
    // B: the issue -> run order of run-dispatch withRunOwnershipLocks
    // (modules/run-dispatch/adapters/postgres.ts:259-276). A long
    // deadlock_timeout makes the insert's backend the detector, so on the
    // base the insert owner is the one that loses with 40P01.
    const locker = settle(server.db.transaction(async tx => {
      await tx.execute(sql`set local deadlock_timeout = '10s'`);
      await tx.execute(sql`select id from issues where id = ${f.issueId} and company_id = ${f.companyId} for update`);
      issueHeld();
      await gate;
      await tx.execute(sql`select id from heartbeat_runs where id = ${f.runId} and company_id = ${f.companyId} for update`);
      return "locker-committed";
    }));
    await issueLocked;

    // A: the real recorder of this run (workspace-operations.ts insertRunning).
    const recorder = workspaceOperationService(server.db).createRecorder({ companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.issueId });
    const recorded = settle(recorder.recordOperation({ phase: "workspace_provision", cwd: "/tmp", run: async () => ({ status: "succeeded" as const }) }));

    // Wait until the insert holds the run KEY SHARE and waits for the issue.
    let insertWaiting = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await server.db.execute<{ q: string }>(sql`select query as q from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      if (rows.some(row => row.q.includes("workspace_operations"))) { insertWaiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    release();
    const [insertResult, lockerResult] = await Promise.all([recorded, locker]);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const deadlocksDetected = (await deadlocks()) - deadlocksBefore;
    const retried = retryStats.retried - retriedBefore;
    const outcome = (r: { ok: true } | { ok: false; error: unknown }) => r.ok ? "ok" : describeError((r as { error: unknown }).error);
    console.log("[workspace-op-deadlock-probe]", JSON.stringify({ insertWaiting,
      workspaceOperationInsert: outcome(insertResult), issueThenRunLocker: outcome(lockerResult),
      pgStatDeadlocksDuringTest: deadlocksDetected, retriedDeadlocks: retried }));

    expect(insertWaiting).toBe(true);
    // The interleave is a real cycle: Postgres detects it.
    expect(deadlocksDetected).toBeGreaterThanOrEqual(1);
    expect({ workspaceOperationInsert: outcome(insertResult), issueThenRunLocker: outcome(lockerResult) })
      .toEqual({ workspaceOperationInsert: "ok", issueThenRunLocker: "ok" });
    const rows = await server.db.select({ id: workspaceOperations.id, status: workspaceOperations.status }).from(workspaceOperations)
      .where(and(eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_provision")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("succeeded");
    expect(retried).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
