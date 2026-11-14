import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, companies, completionContracts, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueComments, issues, nativeRunFinalizations, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { environmentService } from "../services/environments.js";
import { NativeRunCoordinatorStore } from "../services/native-runtime/native-run-coordinator-store.js";
import { finalizeNativeRun, recoverCommittedNativeChatResponse } from "../services/native-runtime/native-run-finalizer.js";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

type Query = { sql: string; params: unknown[] };
function observeTransactions(db: Db, after: (query: Query) => Promise<void>, deadlockTimeout: string): Db {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== "transaction") return Reflect.get(target, key, receiver);
    return (callback: (tx: Db) => Promise<unknown>) => target.transaction(async tx => {
      await tx.execute(sql`select set_config('deadlock_timeout', ${deadlockTimeout}, true), set_config('statement_timeout', '8s', true)`);
      const session = (tx as unknown as { session: { prepareQuery: (...args: unknown[]) => { execute: (...args: unknown[]) => Promise<unknown> } } }).session;
      const prepare = session.prepareQuery;
      session.prepareQuery = function (...args) {
        const prepared = prepare.apply(this, args);
        const execute = prepared.execute;
        prepared.execute = async function (...values) {
          const result = await execute.apply(this, values);
          await after(args[0] as Query);
          return result;
        };
        return prepared;
      };
      return callback(observeTransactions(tx as unknown as Db, after, deadlockTimeout));
    });
  } });
}
function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; }
const settle = <T>(p: Promise<T>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
function errorDetail(error: unknown): unknown {
  const e = error as { code?: string; detail?: string; where?: string; message?: string; cause?: unknown };
  return e.cause ? errorDetail(e.cause) : { code: e.code, detail: e.detail, where: e.where, message: e.message };
}

(support.supported ? describe : describe.skip)("lease acquire vs native response row locks", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: Db;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("lease-response-deadlock-");
    db = createDb(temporary.connectionString);
    await db.execute(sql`alter table environment_leases drop constraint environment_leases_issue_id_issues_id_fk`);
    await db.execute(sql`alter table environment_leases add constraint environment_leases_issue_id_issues_id_fk
      foreign key (issue_id) references issues(id) on delete set null`);
    console.log("[lease-fk-order]", await db.execute(sql`select tgname, pg_get_triggerdef(oid) as definition
      from pg_trigger where tgrelid='environment_leases'::regclass and tgname like 'RI_ConstraintTrigger_c_%' order by tgname`));
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function fixture(options: { sharedWorkspace?: boolean; creationAttachment?: boolean }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID();
    const runId = randomUUID(), otherRunId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
    const successorIssueId = options.sharedWorkspace ? randomUUID() : issueId;
    const workspaceId = options.sharedWorkspace ? randomUUID() : null;
    const operationId = options.creationAttachment ? randomUUID() : undefined;
    await db.insert(companies).values({ id: companyId, name: "Lease locks", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values([...new Set([issueId, successorIssueId])].map(id => ({ id, companyId,
      title: "Lease lock reproduction", status: "in_progress", assigneeAgentId: agentId })));
    await db.insert(environments).values({ id: environmentId, name: `Lease locks ${environmentId}`, driver: "ssh", config: {} });
    if (workspaceId) await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "shared_workspace", strategyType: "reuse", name: "Shared lease locks" });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", objective: "Complete the task", criteria: [] },
      canonicalSha256: `lease-${runId}`, createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, nativeSessionId: sessionId,
      runnerInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId, source: "assignment" } });
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId, agentId, nativeIssueId: successorIssueId,
      status: options.creationAttachment ? "succeeded" : "running", runtimeMode: "native" });
    const port = new NativeRunCoordinatorStore(db, { companyId, issueId, runId, agentId, normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerId, completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    const summary = "Blocked: the staging bucket needs operator access.";
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "blocked", summary,
      blocker: { reasonCode: "access", owner: { kind: "user", name: "Board operator" }, unblockAction: "Grant staging access", scope: "task_wide" },
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "blocked" },
      turnId: "lease-turn" });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: !options.creationAttachment,
      skipNativeResponsePresentation: true });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase).toBe("committed");
    const predecessorRunId = options.creationAttachment ? otherRunId : runId;
    const successorRunId = options.creationAttachment ? runId : otherRunId;
    const lease = await environmentService(db).acquireLease({ companyId, environmentId, issueId, heartbeatRunId: predecessorRunId,
      executionWorkspaceId: workspaceId, provider: "fixture", providerLeaseId: "one-allocation", leasePolicy: "reuse_by_environment", metadata: { agentId } });
    await environmentService(db).releaseLease(lease.id, "retained");
    if (operationId) await db.insert(sandboxCreationOperations).values({ id: operationId, companyId, environmentId,
      originalEnvironmentId: environmentId, runId: successorRunId, issueId, provider: "fixture", driverKey: "fixture",
      config: {}, metadata: {}, state: "pending", nextAttemptAt: new Date(Date.now() + 60_000) });
    return { companyId, agentId, issueId, successorIssueId, environmentId, runId, successorRunId, workspaceId, operationId, lease, summary };
  }

  it("rejects a source lease whose task changes after parent discovery", async () => {
    const f = await fixture({});
    const changedIssueId = randomUUID();
    await db.insert(issues).values({ id: changedIssueId, companyId: f.companyId, title: "New lease owner" });
    const discovered = gate(), continueAcquisition = gate();
    let paused = false;
    const acquisitionDb = observeTransactions(db, async query => {
      if (!paused && query.sql.includes('from "environment_leases"') && !query.sql.includes("for update")) {
        paused = true;
        discovered.open();
        await continueAcquisition.wait;
      }
    }, "100ms");
    const acquisition = settle(environmentService(acquisitionDb).acquireLease({ companyId: f.companyId, environmentId: f.environmentId,
      issueId: f.issueId, heartbeatRunId: f.successorRunId, provider: "fixture", providerLeaseId: "one-allocation",
      leasePolicy: "reuse_by_environment", assertCompanyBinding: true, replacesReusableLeaseId: f.lease.id, metadata: { agentId: f.agentId } }));
    try {
      await Promise.race([discovered.wait, acquisition.then(result => { throw new Error(`Acquisition ended before discovery: ${JSON.stringify(result)}`); })]);
      await db.update(environmentLeases).set({ issueId: changedIssueId }).where(eq(environmentLeases.id, f.lease.id));
    } finally {
      continueAcquisition.open();
      await acquisition;
    }
    const result = await acquisition;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 409, message: "Reusable sandbox lease ownership changed during acquisition." });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
      .toMatchObject({ status: "retained", issueId: changedIssueId });
    expect(await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId),
      eq(environmentLeases.heartbeatRunId, f.successorRunId)))).toHaveLength(0);
  }, 20_000);

  it.each([
    { detector: "acquisition", sharedWorkspace: false, creationAttachment: false },
    { detector: "response", sharedWorkspace: false, creationAttachment: false },
    { detector: "response", sharedWorkspace: true, creationAttachment: false },
    { detector: "response", sharedWorkspace: false, creationAttachment: true },
  ])("commits handoff and native reply (detector=$detector, shared=$sharedWorkspace, attachment=$creationAttachment)", async options => {
    const f = await fixture(options);
    const issueLocked = gate(), readRun = gate();
    const responseDb = observeTransactions(db, async query => {
      if (query.sql.includes('from "issues"') && query.sql.endsWith("for update")) { issueLocked.open(); await readRun.wait; }
    }, options.detector === "response" ? "100ms" : "5s");
    const response = settle(recoverCommittedNativeChatResponse(responseDb, f));
    let acquisition: ReturnType<typeof settle<unknown>> | undefined;
    let blocked: Array<{ query: string; blockers: number[] }> = [];
    try {
      await Promise.race([issueLocked.wait, response.then(result => { throw new Error(`Response ended before its issue lock: ${JSON.stringify(result)}`); })]);
      const acquireDb = observeTransactions(db, async () => {}, options.detector === "acquisition" ? "100ms" : "5s");
      acquisition = settle(environmentService(acquireDb).acquireLease({ companyId: f.companyId, environmentId: f.environmentId,
        issueId: f.successorIssueId, heartbeatRunId: f.successorRunId, executionWorkspaceId: f.workspaceId,
        creationOperationId: f.operationId, assertCompanyBinding: true, provider: "fixture", providerLeaseId: "one-allocation",
        leasePolicy: "reuse_by_environment", replacesReusableLeaseId: f.lease.id, metadata: { agentId: f.agentId } }));
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        blocked = await db.execute<{ query: string; blockers: number[] }>(sql`select query, pg_blocking_pids(pid) as blockers
          from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'`);
        if (blocked.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      readRun.open();
      await Promise.allSettled([response, ...(acquisition ? [acquisition] : [])]);
    }
    const [a, b] = await Promise.all([acquisition, response]);
    console.log("[lease-response-deadlock]", JSON.stringify({ ...options, blocked,
      acquisition: a?.ok ? "committed" : a && errorDetail(a.error), response: b.ok ? b.value : errorDetail(b.error) }));
    expect(blocked).toHaveLength(1);
    expect(a?.ok).toBe(true);
    expect(b).toEqual({ ok: true, value: !options.creationAttachment });
    const [oldLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const successors = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, f.companyId),
      eq(environmentLeases.heartbeatRunId, f.successorRunId)));
    expect(oldLease).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ status: "active", issueId: f.successorIssueId,
      metadata: { reusableLeasePredecessor: oldLease.metadata?.reusableLeaseSuccessor } });
    if (f.operationId) {
      expect((await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.id, f.operationId)))[0])
        .toMatchObject({ state: "attached", leaseId: successors[0].id });
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.runId))).toHaveLength(0);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      expect(await recoverCommittedNativeChatResponse(db, f)).toBe(true);
    }
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.runId)))
      .toEqual([expect.objectContaining({ body: f.summary })]);
    expect(await recoverCommittedNativeChatResponse(db, f)).toBe(false);
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.runId))).toHaveLength(1);
  }, 20_000);
});
