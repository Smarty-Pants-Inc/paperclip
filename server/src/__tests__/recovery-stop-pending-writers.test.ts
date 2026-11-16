import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueRecoveryActionService, type UpsertIssueRecoveryActionInput } from "../services/issue-recovery-actions.js";

// Keep reason: #20807 J2 caught loss of a data-safety obligation and a spent
// inspection budget through the ordinary recovery writer. Use real SQL, including
// a stale-read schedule: a process-local upsert queue cannot fence the Stop owner.
describe("ordinary recovery writers cannot replace an unproved task Stop", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-writers-");
    db = createDb(database.connectionString, { maxConnections: 6 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(stronger = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop writer race", issuePrefix: `W${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retained owner", adapterType: "http",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", invocationSource: "manual",
      runtimeMode: "legacy", executionStage: "dispatching", startedAt: new Date(0), finishedAt: new Date(0),
      runnerProfileJson: { adapterDispatch: { adapterType: "http" } }, resultJson: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retained execution", status: "in_progress",
      checkoutRunId: runId, executionRunId: runId });
    if (stronger) await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "native_workspace_finalization_owner_unverified", fingerprint: "saved-work",
      ownerType: "system", status: "escalated", nextAction: "Recover the independent saved files.",
      evidence: { runId, importantReceipt: "retain" }, attemptCount: 3, maxAttempts: 3 });
    return { companyId, issueId, runId };
  }
  async function active(issueId: string) {
    return (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      .find(row => row.status === "active" || row.status === "escalated")!;
  }
  async function hold(companyId: string, issueId: string) {
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId, issueId })).cleared).toBe(0);
    return active(issueId);
  }
  function input(f: Awaited<ReturnType<typeof fixture>>): UpsertIssueRecoveryActionInput {
    return { companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", cause: "native_finalization_invalid",
      fingerprint: "ordinary-new-evidence", ownerType: "system", evidence: { runId: f.runId, stopPending: null },
      nextAction: "Inspect the new failure.", attemptCount: 1, maxAttempts: 8, wakePolicy: { kind: "resume_native_run", runId: f.runId } };
  }

  it.each([false, true])("preserves the exact held action, owner and budget across every upsert mode (stronger=%s)", async stronger => {
    const f = await fixture(stronger);
    const before = await hold(f.companyId, f.issueId);
    for (const mode of [ {}, { supersedeOnIdentityChange: true }, { preserveExistingOwner: true }, { createOnly: true },
      { cause: before.cause, fingerprint: before.fingerprint, attemptCount: 20, maxAttempts: 1 } ]) {
      const result = await issueRecoveryActionService(db).upsertSourceScoped({ ...input(f), ...mode });
      expect(result.id).toBe(before.id);
      expect(await active(f.issueId)).toEqual(before);
    }
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks()).cleared).toBe(1);
    const released = await issueRecoveryActionService(db).upsertSourceScoped({ ...input(f), supersedeOnIdentityChange: true });
    expect(released.cause).toBe("native_finalization_invalid");
    expect(released.evidence.stopPending).toBeNull();
    expect(released.maxAttempts).toBe(8);
  });

  it.each(["update", "exhaust", "supersede", "exhausted-copyback"] as const)("fences a %s writer that read before the Stop annotation committed", async mode => {
    const f = await fixture(true);
    if (mode === "exhausted-copyback") {
      const row = await active(f.issueId);
      await db.update(issueRecoveryActions).set({ evidence: { ...row.evidence, recoveryBudget: { state: "exhausted" } } })
        .where(eq(issueRecoveryActions.id, row.id));
    }
    let observed!: () => void, release!: () => void;
    const observedRead = new Promise<void>(resolve => { observed = resolve; });
    const allowWrite = new Promise<void>(resolve => { release = resolve; });
    let blocked = false;
    // Pause after PostgreSQL returned the old action, not before the SELECT.
    function intercept(builder: any, actionQuery = false): any {
      return new Proxy(builder, { get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "then") return (fulfilled: (rows: unknown) => unknown, rejected: (error: unknown) => unknown) =>
          Promise.resolve(target).then(async rows => {
            if (actionQuery && !blocked) { blocked = true; observed(); await allowWrite; }
            return rows;
          }).then(fulfilled, rejected);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return result && typeof result === "object" ? intercept(result, actionQuery || (property === "from" && args[0] === issueRecoveryActions)) : result;
        };
      } });
    }
    const writerDb = new Proxy(db, { get(target, property) {
      if (property === "select") return (...args: unknown[]) => intercept((target.select as any)(...args));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const row = await active(f.issueId);
    const update = { ...input(f), ...(mode === "exhaust" ? { attemptCount: 3, maxAttempts: 3 } : {}),
      ...(mode === "supersede" ? { supersedeOnIdentityChange: true } : {}),
      ...(mode === "exhausted-copyback" ? { cause: row.cause, fingerprint: row.fingerprint } : {}) };
    const job = issueRecoveryActionService(writerDb).upsertSourceScoped(update);
    void job.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held: Awaited<ReturnType<typeof active>> | undefined;
    try {
      await Promise.race([observedRead, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("ordinary writer did not reach the action read")), 5_000);
      })]);
      held = await hold(f.companyId, f.issueId);
    } finally { clearTimeout(timer); release(); }
    const result = await job;
    expect(result.id).toBe(held!.id);
    expect(await active(f.issueId)).toEqual(held);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
  });
});
