import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";
import { environmentService } from "../services/environments.js";

// Independent service-level schedule. No FK recreation in the deadlock cases.
// Pause only after the actual orphan recorder has taken its documented environment fence.
function gate() { let open!: () => void; const wait = new Promise<void>(r => { open = r; }); return { open, wait }; }
function observe(db: Db, after: (query: string) => Promise<void>, pid: (value: number) => void, timeout: string): Db {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return (callback: (tx: Db) => Promise<unknown>) => target.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); pid(backend!.pid);
      await tx.execute(sql`select set_config('deadlock_timeout', ${timeout}, true), set_config('statement_timeout', '10s', true)`);
      const session = (tx as unknown as { session: { prepareQuery: (...args: unknown[]) => { execute: (...args: unknown[]) => Promise<unknown> } } }).session;
      const prepare = session.prepareQuery;
      session.prepareQuery = function (...args) {
        const prepared = prepare.apply(this, args), execute = prepared.execute;
        prepared.execute = async function (...values) { const result = await execute.apply(this, values); await after((args[0] as { sql: string }).sql); return result; };
        return prepared;
      };
      return callback(tx as unknown as Db);
    });
  } });
}
function detail(error: any): any { return error?.cause ? detail(error.cause) : { code: error?.code, message: error?.message, detail: error?.detail, where: error?.where }; }
(support.supported ? describe : describe.skip)("judge: acquisition lock compatibility", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => { temporary = await startRecoveryPostgres("judge-lease-order-"); db = createDb(temporary.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), heartbeatRunId = randomUUID(), environmentId = randomUUID(), executionWorkspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Judge lease order", issuePrefix: `J${companyId.slice(0,6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Judge lease order", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native" });
    await db.insert(environments).values({ id: environmentId, name: `Judge ${environmentId}`, driver: "ssh", config: {} });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, sourceIssueId: issueId, mode: "shared_workspace", strategyType: "reuse", name: "Judge workspace" });
    return { companyId, agentId, issueId, heartbeatRunId, environmentId, executionWorkspaceId };
  }
  it.each([
    { assertCompanyBinding: false, sharedWorkspace: false },
    { assertCompanyBinding: true, sharedWorkspace: false },
    { assertCompanyBinding: false, sharedWorkspace: true },
    { assertCompanyBinding: true, sharedWorkspace: true },
  ])("orphan cleanup and successor acquisition commit (binding=$assertCompanyBinding, shared=$sharedWorkspace)", async ({ assertCompanyBinding, sharedWorkspace }) => {
    const f = await fixture(), locked = gate(), resume = gate();
    // Real handoff: cleanup belongs to a finished predecessor, acquisition to a
    // distinct running successor. For a shared workspace the task also differs.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.heartbeatRunId));
    const successorIssueId = sharedWorkspace ? randomUUID() : f.issueId, successorRunId = randomUUID();
    if (sharedWorkspace) await db.insert(issues).values({ id: successorIssueId, companyId: f.companyId, title: "Successor task" });
    await db.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: successorIssueId, status: "running", runtimeMode: "native" });
    const cleanupScope = { ...f, executionWorkspaceId: sharedWorkspace ? f.executionWorkspaceId : null };
    const acquisitionScope = { ...cleanupScope, issueId: successorIssueId, heartbeatRunId: successorRunId };
    let paused = false, writerPid: number | undefined;
    const cleanupDb = observe(db, async query => {
      if (!paused && query.includes('from "environments"') && query.endsWith("for update")) { paused = true; locked.open(); await resume.wait; }
    }, () => {}, "100ms");
    const cleanup = environmentService(cleanupDb).insertPendingCleanupLease({ ...cleanupScope, provider: "judge", providerLeaseId: "orphan", failureReason: "lease recording failed" });
    const cleanupResult = Promise.allSettled([cleanup]);
    let acquisitionResult: Promise<PromiseSettledResult<unknown>[]> | undefined, waitError: unknown, waitingQuery = "";
    try {
      await Promise.race([locked.wait, cleanup.then(() => { throw new Error("cleanup exited before environment fence"); })]);
      const acquisitionDb = observe(db, async () => {}, value => { writerPid = value; }, "5s");
      acquisitionResult = Promise.allSettled([environmentService(acquisitionDb).acquireLease({ ...acquisitionScope, assertCompanyBinding, provider: "judge", providerLeaseId: "fresh" })]);
      await vi.waitFor(async () => {
        expect(writerPid).toBeDefined();
        const [activity] = await db.execute<{ wait: string | null; query: string }>(sql`select wait_event_type as wait, query from pg_stat_activity where pid=${writerPid!}`);
        expect(activity?.wait).toBe("Lock"); waitingQuery = activity!.query;
      }, { timeout: 5000, interval: 10 });
    } catch (error) { waitError = error; }
    finally { resume.open(); }
    const results = [...await cleanupResult, ...await (acquisitionResult ?? Promise.resolve([]))];
    const outcomes = results.map(r => r.status === "fulfilled" ? "committed" : detail(r.reason));
    console.log("[judge-orphan-acquisition]", JSON.stringify({ assertCompanyBinding, sharedWorkspace, waitingQuery, outcomes }));
    if (waitError) throw waitError;
    expect(outcomes).toEqual(["committed", "committed"]);
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    expect(leases).toHaveLength(2);
    expect(leases.map(l => l.status).sort()).toEqual(["active", "pending_cleanup"]);
  }, 20_000);

  it("measures ten parallel acquisitions in one company", async () => {
    const f = await fixture(), svc = environmentService(db);
    const scopes = [];
    for (let i = 0; i < 10; i++) {
      const issueId = randomUUID(), heartbeatRunId = randomUUID(), executionWorkspaceId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: `Parallel ${i}` });
      await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: issueId, status: "running" });
      await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId: f.companyId, sourceIssueId: issueId, mode: "shared_workspace", strategyType: "reuse", name: `Parallel ${i}` });
      scopes.push({ ...f, issueId, heartbeatRunId, executionWorkspaceId });
    }
    for (const sharedParents of [false, true]) for (const assertCompanyBinding of [false, true]) for (let round = 0; round < 5; round++) {
      const start = performance.now(), durations: number[] = [];
      const rows = await Promise.all(scopes.map(async (scope, index) => {
        const entered = performance.now();
        const row = await svc.acquireLease({ ...(sharedParents ? f : scope), assertCompanyBinding, provider: "judge", providerLeaseId: `parallel-${sharedParents}-${assertCompanyBinding}-${round}-${index}` });
        durations.push(performance.now() - entered); return row;
      }));
      const totalMs = performance.now() - start; durations.sort((a,b) => a-b);
      console.log("[judge-ten-parallel]", JSON.stringify({ sharedParents, assertCompanyBinding, round, totalMs, minMs: durations[0], medianMs: durations[4], p95Ms: durations[9], durationsMs: durations }));
      expect(rows).toHaveLength(10); expect(rows.every(r => r.status === "active")).toBe(true); expect(new Set(rows.map(r => r.id)).size).toBe(10);
    }
  }, 30_000);

  it("the builder's disposable FK recreation preserves its complete catalog definition", async () => {
    const inspect = () => db.execute(sql`select conname, pg_get_constraintdef(oid) as definition, condeferrable, condeferred, convalidated, confupdtype, confdeltype, confmatchtype, conkey, confkey, conrelid::regclass::text as child, confrelid::regclass::text as parent from pg_constraint where conname='environment_leases_issue_id_issues_id_fk'`);
    const before = [...await inspect()];
    await db.execute(sql`alter table environment_leases drop constraint environment_leases_issue_id_issues_id_fk`);
    await db.execute(sql`alter table environment_leases add constraint environment_leases_issue_id_issues_id_fk foreign key (issue_id) references issues(id) on delete set null`);
    const after = [...await inspect()];
    console.log("[judge-fk-catalog]", JSON.stringify({ before, after }));
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ condeferrable: false, condeferred: false, convalidated: true, confdeltype: "n", confupdtype: "a" });
  });
});
