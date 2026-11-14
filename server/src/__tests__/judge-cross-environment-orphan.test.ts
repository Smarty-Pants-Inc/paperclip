import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";
import { environmentService } from "../services/environments.js";
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
(support.supported ? describe : describe.skip)("judge: cross-environment orphan transaction contract", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => { temporary = await startRecoveryPostgres("judge-cross-environment-"); db = createDb(temporary.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  it.each([false, true])("old-environment orphan and new-environment successor commit for the same task/workspace (binding=%s)", async assertCompanyBinding => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), oldRunId = randomUUID(), newRunId = randomUUID();
    const oldEnvironmentId = randomUUID(), newEnvironmentId = randomUUID(), executionWorkspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cross-environment judge", issuePrefix: `X${companyId.slice(0,6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue task in another environment", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, nativeIssueId: issueId, status: "failed", runtimeMode: "native", finishedAt: new Date() });
    await db.insert(heartbeatRuns).values({ id: newRunId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native" });
    await db.insert(environments).values([oldEnvironmentId,newEnvironmentId].map(id=>({ id, name: `Judge ${id}`, driver: "ssh", config: {} })));
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, sourceIssueId: issueId, mode: "shared_workspace", strategyType: "reuse", name: "Persistent task workspace" });
    const taskLocked=gate(),resume=gate(); let paused=false, cleanupPid: number|undefined;
    const acquisitionDb=observe(db,async query=>{
      if(!paused&&query.includes('from "issues"')&&query.endsWith("for update")){paused=true;taskLocked.open();await resume.wait;}
    },()=>{},"100ms");
    const acquisition=environmentService(acquisitionDb).acquireLease({ companyId, environmentId:newEnvironmentId,issueId,heartbeatRunId:newRunId,
      executionWorkspaceId,assertCompanyBinding,provider:"judge",providerLeaseId:"successor-allocation" });
    const acquisitionResult=Promise.allSettled([acquisition]);
    let cleanupResult:Promise<PromiseSettledResult<unknown>[]>|undefined,waitError:unknown,waitingQuery="";
    try{
      // M1 has no explicit task lock: its real acquisition commits here. On the
      // item the new UPDATE lock is paused, then the actual orphan INSERT runs.
      await Promise.race([taskLocked.wait,acquisitionResult]);
      const cleanupDb=observe(db,async()=>{},value=>{cleanupPid=value;},"5s");
      cleanupResult=Promise.allSettled([environmentService(cleanupDb).insertPendingCleanupLease({companyId,environmentId:oldEnvironmentId,
        issueId,heartbeatRunId:oldRunId,executionWorkspaceId,provider:"judge",providerLeaseId:"old-orphan",failureReason:"lease recording failed"})]);
      if(paused)await vi.waitFor(async()=>{
        expect(cleanupPid).toBeDefined();
        const [activity]=await db.execute<{wait:string|null;query:string}>(sql`select wait_event_type as wait, query from pg_stat_activity where pid=${cleanupPid!}`);
        expect(activity?.wait).toBe("Lock");expect(activity?.query).toContain('insert into "environment_leases"');waitingQuery=activity!.query;
      },{timeout:5000,interval:10});
    }catch(error){waitError=error;}finally{resume.open();}
    const results=[...await acquisitionResult,...await(cleanupResult??Promise.resolve([]))];
    const outcomes=results.map(r=>r.status==="fulfilled"?"committed":detail(r.reason));
    console.log("[judge-cross-environment]",JSON.stringify({assertCompanyBinding,paused,waitingQuery,outcomes}));
    if(waitError)throw waitError;
    expect(outcomes).toEqual(["committed","committed"]);
    const leases=await db.select().from(environmentLeases).where(eq(environmentLeases.companyId,companyId));
    expect(leases).toHaveLength(2);expect(leases.map(l=>l.status).sort()).toEqual(["active","pending_cleanup"]);
  },20_000);
});
