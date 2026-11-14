import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";
import { environmentService } from "../services/environments.js";
import { allowLegacyShutdownWorkspaceCleanup, beginLegacyShutdownWorkspaceSettlement } from "../services/legacy-shutdown-workspace-settlement.js";

// Actual service owners; only scheduling is controlled. No schema/FK edits,
// artificial row locks, retry, provider calls, or replacement implementations.
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
(support.supported ? describe : describe.skip)("judge: whole-transaction acquisition contract", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => { temporary = await startRecoveryPostgres("judge-whole-transaction-"); db = createDb(temporary.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  it.each([false, true])("shutdown file-preservation and successor acquisition both commit (creation=%s)", async creation => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), oldRunId = randomUUID(), newRunId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Whole transaction judge", issuePrefix: `W${companyId.slice(0,6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve interrupted files while successor starts", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, runtimeMode: "legacy", status: "running", contextSnapshot: { issueId } });
    await db.insert(heartbeatRuns).values({ id: newRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
    await db.update(issues).set({ executionRunId: newRunId }).where(eq(issues.id, issueId));
    await db.insert(environments).values({ id: environmentId, name: `Judge ${environmentId}`, driver: "sandbox", config: { provider: "daytona" } });
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: oldRunId, issueId,
      status: "active", provider: "daytona", providerLeaseId: randomUUID(), leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId: "fixture-plugin", remoteCwd: "/home/daytona/workspace" } }).returning();
    const deadline = new Date(Date.now() - 1000);
    await beginLegacyShutdownWorkspaceSettlement(db, { id: oldRunId, companyId }, deadline);
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted", finishedAt: new Date() }).where(eq(heartbeatRuns.id, oldRunId));
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id));
    const creationOperationId = creation ? randomUUID() : undefined;
    if (creationOperationId) await db.insert(sandboxCreationOperations).values({ id: creationOperationId, companyId, environmentId,
      originalEnvironmentId: environmentId, runId: newRunId, issueId, provider: "daytona", driverKey: "daytona", config: {}, metadata: {}, state: "pending", nextAttemptAt: new Date(Date.now() + 60_000) });
    const locked = gate(), resume = gate(); let paused = false, acquisitionPid: number | undefined;
    const preservationQueries: string[] = [];
    const preservationDb = observe(db, async query => {
      preservationQueries.push(query);
      if (!paused && query.includes('from "issues"') && query.endsWith("for update")) { paused = true; locked.open(); await resume.wait; }
    }, () => {}, "100ms");
    const preservation = allowLegacyShutdownWorkspaceCleanup(preservationDb, source!, new Date());
    const preservationResult = Promise.allSettled([preservation]);
    let acquisitionResult: Promise<PromiseSettledResult<unknown>[]> | undefined, waitError: unknown, waitingQuery = "";
    try {
      await Promise.race([locked.wait, preservation.then(() => { throw new Error("preservation exited before task fence"); })]);
      const acquisitionDb = observe(db, async () => {}, value => { acquisitionPid = value; }, "5s");
      acquisitionResult = Promise.allSettled([environmentService(acquisitionDb).acquireLease({ companyId, environmentId, issueId,
        heartbeatRunId: newRunId, assertCompanyBinding: true, creationOperationId, provider: "daytona", providerLeaseId: randomUUID() })]);
      await vi.waitFor(async () => {
        expect(acquisitionPid).toBeDefined();
        const [activity] = await db.execute<{ wait: string | null; query: string }>(sql`select wait_event_type as wait, query from pg_stat_activity where pid=${acquisitionPid!}`);
        expect(activity?.wait).toBe("Lock"); waitingQuery = activity!.query;
      }, { timeout: 5000, interval: 10 });
    } catch (error) { waitError = error; } finally { resume.open(); }
    const results = [...await preservationResult, ...await (acquisitionResult ?? Promise.resolve([]))];
    const outcomes = results.map(r => r.status === "fulfilled" ? "committed" : detail(r.reason));
    console.log("[judge-whole-transaction]", JSON.stringify({ creation, waitingQuery, outcomes, preservationQueries }));
    if (waitError) throw waitError;
    expect(outcomes).toEqual(["committed", "committed"]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: true });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, source!.id)))[0])
      .toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure", metadata: { legacyShutdownWorkspaceSettlement: { state: "expired" } } });
  }, 20_000);
});
