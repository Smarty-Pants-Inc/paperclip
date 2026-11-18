import { gitExclusionRetryContract } from "./helpers/git-exclusion-retry-contract.js";
import { queueGitExclusionNextTry } from "./helpers/git-exclusion-next-try.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHeartbeatInstructionWorkingCopy } from "../services/heartbeat/instruction-working-copy.js";
import * as fileStoreModule from "../services/agent-file-store.js";
import * as instructionAuthorization from "../services/agent-instruction-authorization.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDirectoryCleanup } from "../services/directory-cleanup-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";
import * as ssh from "@paperclipai/adapter-utils/ssh";
const execFile = promisify(execFileCallback);
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentFileStore, fileHash, inspectAgentFile, inspectAgentDirectory, snapshotAgentFiles, MAX_AGENT_FILE_BYTES, MAX_AGENT_DIRECTORY_BYTES, MAX_AGENT_DIRECTORY_ENTRIES } from "../services/agent-file-store.js";
import { activityLog, agents, companies, issues, authUsers, companyMemberships, principalPermissionGrants, heartbeatRuns, environmentLeases, environments, agentInstructionWorkingCopies, agentInstructionRevisions, agentInstructionHeads, createDb, fileStorageDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService, instructionWorkingCopyGuidance } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { buildNativeRuntimeContext } from "../services/native-runtime/runtime-context.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildNativeModelEnvelope } from "../vendor/paperclip-runner/index.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { createReusableLeaseHandoff } from "../services/environment-lease-handoff.js";
import { AGENT_FILES_SAVE_PENDING_INSTRUCTION, AgentDirectoryReuseInvalidatedError, agentDirectoryWorkingCopyService, agentFileSaveHeld } from "../services/agent-directory-working-copies.js";
import { agentFileSaveHeldOnLease, claimLeaseForDestroyUnlessHeld, releaseLeaseDestroyClaim } from "../services/agent-file-save-hold.js";
import * as checkpointsModule from "../services/agent-file-checkpoints.js";
import { collectStoppedInstructionCopyWithRetries } from "../services/agent-instruction-working-copies.js";
import { HttpError } from "../errors.js";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { heartbeatRunEvents, plugins } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { agentFileRoots } from "@paperclipai/db";
import * as storageModule from "../storage/index.js";
import { Readable } from "node:stream";
import { logger } from "../middleware/logger.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_DIRECTORY_TEST_DATABASE_URL");

describe("persistent agent directories", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  let revisions: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\uFEFF# Original\r\n☃\n";
  const target = () => ({ companyId, agentId });
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  async function run(options: { warm?: boolean; reuseRunId?: string } = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return (await copies.prepare({ ...target(), runId, cwd: home, ...options }))!;
  }
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-working-copies-")));
    process.env.PAPERCLIP_HOME = home;
    if (!external) database = await startEmbeddedPostgresTestDatabase("instruction-copies-db-");
    db = createDb(external ?? database.connectionString);
    copies = agentInstructionWorkingCopyService(db);
    revisions = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) {
      const writable = async (dir: string) => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      };
      await writable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
  });

  function judgeLatch() { let release!: () => void; const promise = new Promise<void>(r=>release=r);return {promise,release}; }
  async function loseJudgeSource(id:string) {
    const key=`isolated_repository_source:${companyId}:${id}`;
    const rows=await db.execute(sql`select pid from pg_locks where locktype='advisory' and granted
      and classid::bigint=((hashtextextended(${key},0)>>32)&4294967295) and objid::bigint=(hashtextextended(${key},0)&4294967295)`);
    expect(rows).toHaveLength(1); await db.execute(sql`select pg_terminate_backend(${rows[0].pid})`);
    expect(await db.transaction(async tx=>(await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`))[0].acquired)).toBe(true);
    await new Promise(r=>setTimeout(r,2500));
  }
  async function sourceTimeout() { const [row]=await db.execute(sql`select current_database() as name`);await db.execute(sql.raw(`alter database "${row.name}" set idle_in_transaction_session_timeout = '3s'`)); }
  it.skip('JUDGE checkpointWarm: an outer lock loss after real capture prevents canonical save and receipt patch', async()=>{
    const {withWorkspaceSourceLocks}=await import('../services/workspace-source-lock.js');
    const copy=await run({warm:true}),id=randomUUID();await fs.writeFile(path.join(copy.localRoot,'late-memory.txt'),'unsaved tail');
    await sourceTimeout();const entered=judgeLatch(),gate=judgeLatch(),ended=judgeLatch();
    const capture=checkpointsModule.captureAgentFileCheckpoint;let signal:AbortSignal|undefined;let capturesAfterLoss=0;
    const spy=vi.spyOn(checkpointsModule,'captureAgentFileCheckpoint').mockImplementation(async input=>{if(signal?.aborted)capturesAfterLoss++;const captured=await capture(input);entered.release();await gate.promise;return captured;});
    const op=withWorkspaceSourceLocks(db,{companyId,issueIds:[id]},async(_tx,lost)=>{signal=lost;try{return await copies.checkpointWarm({companyId,runId:copy.runId});}finally{ended.release();}}).then(value=>({value}),error=>({error:String(error)}));
    try {
      await Promise.race([entered.promise,op.then(x=>{throw Error('early '+JSON.stringify(x))})]);await loseJudgeSource(id);expect(signal?.aborted).toBe(true);
      gate.release();await ended.promise;const result=await op;const current=await copies.get(companyId,copy.runId);
      const proof={canonicalSavedAfterLoss:await fs.readFile(path.join(root,'late-memory.txt'),'utf8').catch(()=>null),receiptPatchedAfterLoss:current?.baseHash!==copy.baseHash || current?.state!==copy.state || current?.errorCode!==copy.errorCode,errorCode:current?.errorCode,capturesAfterLoss,copyRetained:!!current,resultFailed:'error' in result};
      console.log('RFL_AGENT_CHECKPOINT',JSON.stringify(proof));await fs.writeFile(path.join(process.env.TASK_OUT!,'consumer-agent-checkpoint.json'),JSON.stringify(proof,null,2));
      expect(proof.copyRetained).toBe(true);expect(proof.canonicalSavedAfterLoss).toBe(null);expect(proof.capturesAfterLoss).toBe(0);expect(proof.receiptPatchedAfterLoss).toBe(false);
    }finally{gate.release();await ended.promise;await op;spy.mockRestore();}
  },45000);
  it.skip('JUDGE recoverStoppedRemote: outer loss during real lease read prevents the subsequent DB receipt patch',async()=>{
    const {withWorkspaceSourceLocks}=await import('../services/workspace-source-lock.js');
    const copy=await run(),id=randomUUID(),environmentId=randomUUID(),leaseId=randomUUID(),remoteCwd='/fixture/task';
    const lease={id:leaseId,companyId,environmentId,heartbeatRunId:copy.runId,provider:'daytona',providerLeaseId:'destroyed-judge'};
    await db.insert(environments).values({id:environmentId,name:environmentId,driver:'sandbox'});
    await db.insert(environmentLeases).values({...lease,status:'released',releasedAt:new Date(),cleanupStatus:'success',metadata:{remoteExecutionTermination:remoteTerminationReceipt(lease,{providerLeaseId:lease.providerLeaseId,state:'destroyed'})}});
    await db.update(agentInstructionWorkingCopies).set({location:`remote:${environmentId}`,executionRoot:path.posix.join(remoteCwd,'.paperclip-runtime','agent-files',agentId,copy.runId),receipt:{...copy.receipt,cleanup:{leaseId,remoteCwd}}}).where(eq(agentInstructionWorkingCopies.runId,copy.runId));
    await db.update(heartbeatRuns).set({status:'succeeded',runtimeMode:'native'}).where(eq(heartbeatRuns.id,copy.runId));
    const row=(await copies.get(companyId,copy.runId))!;await sourceTimeout();
    const entered=judgeLatch(),gate=judgeLatch(),ended=judgeLatch();let signal:AbortSignal|undefined;
    const select=db.select.bind(db);let held=false;
    const spy=vi.spyOn(db,'select').mockImplementation((...args:any[])=>{
      const query=(select as any)(...args);const from=query.from.bind(query);
      query.from=(table:any)=>{const built=from(table);if(table===environmentLeases){const where=built.where.bind(built);built.where=(...w:any[])=>{
        const result=where(...w);if(held)return result;held=true;return Promise.resolve(result).then(async value=>{entered.release();await gate.promise;return value;});};}return built;};return query;
    });
    const op=withWorkspaceSourceLocks(db,{companyId,issueIds:[id]},async(_tx,lost)=>{signal=lost;try{return await copies.recoverStopped();}finally{ended.release();}}).then(value=>({value}),error=>({error:String(error)}));
    try{
      await Promise.race([entered.promise,op.then(x=>{throw Error('early '+JSON.stringify(x))})]);await loseJudgeSource(id);expect(signal?.aborted).toBe(true);
      gate.release();await ended.promise;await op;spy.mockRestore();const current=(await copies.get(companyId,copy.runId))!;
      const proof={before:row.state,after:current.state,errorCode:current.errorCode,copyRetained:!!current,receiptPatchedAfterLoss:current.state!==row.state || current.errorCode!==row.errorCode};
      console.log('RFL_AGENT_RECOVERY',JSON.stringify(proof));await fs.writeFile(path.join(process.env.TASK_OUT!,'consumer-agent-recovery.json'),JSON.stringify(proof,null,2));
      expect(proof.copyRetained).toBe(true);expect(proof.receiptPatchedAfterLoss).toBe(false);
    }finally{gate.release();await ended.promise;await op;spy.mockRestore();}
  },45000);

  it('DELTA checkpoint: loss after canonical apply prevents the next receipt DB patch', async()=>{
    const copy=await run({warm:true}),id=randomUUID();await fs.writeFile(path.join(copy.localRoot,'saved-before-loss.txt'),'saved before loss');
    await sourceTimeout();const entered=judgeLatch(),gate=judgeLatch(),ended=judgeLatch();
    const factory=fileStoreModule.agentFileStore;
    vi.spyOn(fileStoreModule,'agentFileStore').mockImplementation((...args:Parameters<typeof factory>)=>{
      const store=factory(...args),apply=store.apply.bind(store);
      store.apply=async(...input:Parameters<typeof apply>)=>{const result=await apply(...input);entered.release();await gate.promise;return result;};
      return store;
    });
    const service=agentInstructionWorkingCopyService(db);
    const {withWorkspaceSourceLocks}=await import('../services/workspace-source-lock.js');
    const op=withWorkspaceSourceLocks(db,{companyId,issueIds:[id]},async()=>{try{return await service.checkpointWarm({companyId,runId:copy.runId});}finally{ended.release();}}).then(value=>({value}),error=>({error:String(error)}));
    try{
      await Promise.race([entered.promise,op.then(x=>{throw Error('early '+JSON.stringify(x))})]);await loseJudgeSource(id);
      gate.release();await ended.promise;const result=await op;const current=await copies.get(companyId,copy.runId);
      const proof={canonicalBytes:await fs.readFile(path.join(root,'saved-before-loss.txt'),'utf8').catch(()=>null),before:copy.state,after:current?.state,copyRetained:!!current,receiptPatchedAfterLoss:current?.baseHash!==copy.baseHash || current?.state!==copy.state,result};
      console.log('DELTA_AGENT_RECEIPT',JSON.stringify(proof));await fs.writeFile(path.join(process.env.TASK_OUT!,'delta-agent-receipt.json'),JSON.stringify(proof,null,2));
      expect(proof.copyRetained).toBe(true);expect(proof.receiptPatchedAfterLoss).toBe(false);
    }finally{gate.release();await ended.promise;await op;}
  },45000);
});
