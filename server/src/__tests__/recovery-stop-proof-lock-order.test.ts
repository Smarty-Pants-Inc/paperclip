import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";
import { lockNativeExecutionLeaseForReacquire } from "../services/native-runtime/native-execution-lease.js";

// Keep reason: #20807 RFL F3 caught PostgreSQL 40P01. Both participants here
// execute production SQL; barriers control lock acquisition, not lock outcomes.
describe("task Stop proof does not invert the native coordinator/run order", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-lock-order-");
    db = createDb(database.connectionString, { maxConnections: 6 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function reached(promise: Promise<unknown>, label: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`barrier_not_reached: ${label}`)), 5_000);
    })]); } finally { clearTimeout(timer); }
  }
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop/reacquire race", issuePrefix: `L${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native owner", adapterType: "paperclip_runner",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stopped native task", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "cancelled",
      runtimeMode: "native", nativeIssueId: issueId, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      processPid: 2_000_000_000, contextSnapshot: { issueId }, resultJson: { retainedDiagnostic: "never remove" } });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId,
      phase: "observed", leaseOwner: "expired-owner", leaseExpiresAt: new Date(Date.now() - 60_000) });
    return { companyId, agentId, issueId, runId };
  }

  it.each(["native-first", "sweep-first"])("sweep vs native lapsed-lease reacquisition: %s", async order => {
    const f = await fixture();
    const runBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0];
    const coordinatorBefore = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0];
    const runLocked = barrier(), coordinatorLocked = barrier(), releaseSweep = barrier(), releaseNative = barrier();
    const locks: string[] = [];
    let observedRunLock = false;
    function selectBarrier(builder: any, isRun = false): any {
      return new Proxy(builder, { get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "then") return value.bind(target);
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (property === "for" && isRun && !observedRunLock) {
            return Promise.resolve(result).then(async rows => {
              observedRunLock = true; locks.push("run"); runLocked.resolve();
              await releaseSweep.promise;
              return rows;
            });
          }
          return result && typeof result === "object"
            ? selectBarrier(result, isRun || (property === "from" && args[0] === heartbeatRuns)) : result;
        };
      } });
    }
    const sweepDb = new Proxy(db, { get(target, property) {
      if (property === "transaction") return (effect: (tx: Db) => Promise<unknown>) => target.transaction(tx => effect(new Proxy(tx, {
        get(transaction, key) {
          if (key === "select") return (...args: unknown[]) => selectBarrier((transaction.select as any)(...args));
          const value = Reflect.get(transaction, key);
          return typeof value === "function" ? value.bind(transaction) : value;
        },
      }) as unknown as Db));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const sweep = () => recoveryService(sweepDb, { enqueueWakeup: vi.fn() })
      .sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    const reacquire = () => db.transaction(async tx => {
      let first = true;
      return lockNativeExecutionLeaseForReacquire({ execute: async (query: any) => {
        const result = await tx.execute(query);
        if (first) {
          first = false; locks.push("coordinator"); coordinatorLocked.resolve();
          await releaseNative.promise;
        }
        return result;
      } } as any, f);
    });
    // Catch immediately so a failed participant never leaves an unhandled
    // rejection or an unawaited transaction while the other is draining.
    const jobs: Array<Promise<unknown>> = [];
    const start = (operation: () => Promise<unknown>) => {
      const job = operation(); void job.catch(() => {}); jobs.push(job);
    };
    try {
      if (order === "native-first") {
        start(reacquire); await reached(coordinatorLocked.promise, "coordinator");
        start(sweep); await reached(runLocked.promise, "run");
      } else {
        start(sweep); await reached(runLocked.promise, "run");
        start(reacquire); await reached(coordinatorLocked.promise, "coordinator");
      }
    } finally { releaseSweep.resolve(); releaseNative.resolve(); }
    const results = await Promise.allSettled(jobs);
    expect(locks).toEqual(order === "native-first" ? ["coordinator", "run"] : ["run", "coordinator"]);
    const errors = results.filter(result => result.status === "rejected")
      .map(result => String((result as PromiseRejectedResult).reason?.cause?.code ?? (result as PromiseRejectedResult).reason?.code ?? (result as PromiseRejectedResult).reason));
    expect(errors).toEqual([]);
    expect(results.find(result => result.status === "fulfilled" && typeof result.value === "object"))
      .toMatchObject({ status: "fulfilled", value: { cleared: 1, issueIds: [f.issueId] } });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(runBefore);
    // Task recovery is a reader of the coordinator, not its settlement owner.
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0]).toEqual(coordinatorBefore);
  }, 20_000);
});
