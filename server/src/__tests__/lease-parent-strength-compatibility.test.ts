import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { environmentService } from "../services/environments.js";
import { reserveRemoteWorkspace } from "../services/remote-workspaces.js";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

// Keep: F-2's unchanged judge observes UPDATE, so independently exercise the
// replacement's actual NO KEY UPDATE pause point and its unchanged FK checks.
function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; }
function observe(db: Db, after: (query: string) => Promise<void>, pid?: (value: number) => void): Db {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return (callback: (tx: Db) => Promise<unknown>) => target.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      if (pid) { const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); pid(backend!.pid); }
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
(support.supported ? describe : describe.skip)("lease parent strength and source revalidation", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => { temporary = await startRecoveryPostgres("lease-parent-strength-"); db = createDb(temporary.connectionString);
    vi.stubEnv("DATABASE_URL", temporary.connectionString); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "71".repeat(32));
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); vi.unstubAllEnvs(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), changedIssueId = randomUUID();
    const heartbeatRunId = randomUUID(), changedRunId = randomUUID(), environmentId = randomUUID(), oldEnvironmentId = randomUUID();
    const executionWorkspaceId = randomUUID(), changedWorkspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease parent strength", issuePrefix: `N${companyId.slice(0,6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values([issueId,changedIssueId].map(id => ({ id, companyId, title: id, assigneeAgentId: agentId })));
    await db.insert(heartbeatRuns).values([heartbeatRunId,changedRunId].map(id => ({ id, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native" })));
    await db.insert(environments).values([environmentId,oldEnvironmentId].map(id => ({ id, name:id, driver:"ssh", config:{} })));
    await db.insert(executionWorkspaces).values([executionWorkspaceId,changedWorkspaceId].map(id => ({ id, companyId, sourceIssueId:issueId, mode:"shared_workspace", strategyType:"reuse", name:id })));
    return { companyId, agentId, issueId, changedIssueId, heartbeatRunId, changedRunId, environmentId, oldEnvironmentId, executionWorkspaceId, changedWorkspaceId };
  }
  it.each([false,true])("a cross-environment orphan INSERT commits while acquisition holds task N (binding=%s)", async assertCompanyBinding => {
    const f = await fixture(), locked=gate(), resume=gate(); let paused=false;
    const acquisitionDb = observe(db, async query => {
      if (!paused && query.includes('from "issues"') && query.endsWith("for no key update")) { paused=true; locked.open(); await resume.wait; }
    });
    const acquisition = Promise.allSettled([environmentService(acquisitionDb).acquireLease({ ...f, assertCompanyBinding, provider:"fixture", providerLeaseId:"successor" })]);
    try {
      await Promise.race([locked.wait, acquisition.then(() => { throw new Error("acquisition did not take its task N fence"); })]);
      // This must finish BEFORE acquisition resumes. K on W and I is compatible
      // with N, even though the two owners refer to different environments.
      const orphan = await environmentService(db).insertPendingCleanupLease({ ...f, environmentId:f.oldEnvironmentId,
        provider:"fixture", providerLeaseId:"orphan", failureReason:"delayed orphan" });
      expect(orphan.status).toBe("pending_cleanup");
    } finally { resume.open(); await acquisition; }
    expect(await acquisition).toEqual([expect.objectContaining({ status:"fulfilled" })]);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId,f.companyId))).toHaveLength(2);
  },15_000);
  it("serializes acquisition N behind the real remote-workspace C(K) -> I(U) -> R(U) -> W(U) reservation", async () => {
    const f = await fixture(), held = gate(), resume = gate(); let paused = false, acquisitionPid: number | undefined;
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1",
      epoch: 1, snapshotId: null, source: { kind: "empty" }, location: null, writerRunId: f.heartbeatRunId, dirty: false } } })
      .where(eq(executionWorkspaces.id, f.executionWorkspaceId));
    const reservationDb = observe(db, async query => {
      if (!paused && query.includes('from "heartbeat_runs"') && query.endsWith("for update")) { paused = true; held.open(); await resume.wait; }
    });
    const reservation = Promise.allSettled([reserveRemoteWorkspace({ db: reservationDb, ...f, runId: f.heartbeatRunId,
      existingWorkspaceId: f.executionWorkspaceId, projectId: null, projectWorkspaceId: null, source: { kind: "empty" },
      // Reservation only inspects the provider; this same-run replay never transfers files.
      storage: { provider: "s3" } as NonNullable<Parameters<typeof reserveRemoteWorkspace>[0]["storage"]> })]);
    let acquisition: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await Promise.race([held.wait, reservation.then(() => { throw new Error("reservation did not hold I/R U"); })]);
      acquisition = Promise.allSettled([environmentService(observe(db, async () => {}, pid => { acquisitionPid = pid; })).acquireLease({
        ...f, assertCompanyBinding: true, provider: "fixture", providerLeaseId: "reservation-neighbor" })]);
      await vi.waitFor(async () => {
        expect(acquisitionPid).toBeDefined();
        const [state] = await db.execute<{ wait: string | null; query: string }>(sql`select wait_event_type as wait, query from pg_stat_activity where pid=${acquisitionPid!}`);
        expect(state).toMatchObject({ wait: "Lock" });
        expect(state!.query).toContain('from "issues"'); expect(state!.query).toContain("for no key update");
      }, { timeout: 3000, interval: 10 });
    } finally { resume.open(); await reservation; if (acquisition) await acquisition; }
    expect(await reservation).toEqual([expect.objectContaining({ status: "fulfilled", value: expect.objectContaining({ id: f.executionWorkspaceId }) })]);
    expect(await acquisition).toEqual([expect.objectContaining({ status: "fulfilled" })]);
  }, 15_000);
  it.each(["issueId", "heartbeatRunId", "executionWorkspaceId", "environmentId"] as const)("rejects a changed discovered source %s before handoff", async field => {
    const f=await fixture();
    const old=await environmentService(db).acquireLease({ ...f, provider:"fixture", providerLeaseId:"allocation", leasePolicy:"reuse_by_environment" });
    await environmentService(db).releaseLease(old.id,"retained");
    const discovered=gate(), resume=gate(); let paused=false;
    const acquisitionDb=observe(db,async query=>{
      if(!paused&&query.includes('from "environment_leases"')&&!query.includes("for ")) {paused=true;discovered.open();await resume.wait;}
    });
    const acquisition=Promise.allSettled([environmentService(acquisitionDb).acquireLease({ ...f, provider:"fixture", providerLeaseId:"allocation",
      leasePolicy:"reuse_by_environment", assertCompanyBinding:true, replacesReusableLeaseId:old.id })]);
    const changed={issueId:f.changedIssueId,heartbeatRunId:f.changedRunId,executionWorkspaceId:f.changedWorkspaceId,environmentId:f.oldEnvironmentId}[field];
    try {
      await Promise.race([discovered.wait, acquisition.then(()=>{throw new Error("acquisition exited before discovery");})]);
      await db.update(environmentLeases).set({[field]:changed}).where(eq(environmentLeases.id,old.id));
    } finally { resume.open(); await acquisition; }
    const [result]=await acquisition;
    expect(result).toMatchObject({status:"rejected",reason:{status:409,message:"Reusable sandbox lease ownership changed during acquisition."}});
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId,f.companyId)))
      .toEqual([expect.objectContaining({id:old.id,status:"retained",[field]:changed})]);
  },15_000);
});
