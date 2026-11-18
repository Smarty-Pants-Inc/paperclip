import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import request from "supertest";
import { agents, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedCompanyWithBoardAccess, routeApp } from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { createSystemRecovery } from "../services/system-recovery-state.js";
import { runExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { claimNativeSessionResumptions } from "../services/native-runtime/native-finalization-reconciler.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";

// Independent judge check: data-safety hold must survive the existing ordinary
// recovery read model and writers, not merely a freshly inserted standalone row.
describe("judge: Stop-pending remains a person's visible durable obligation", () => {
 let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>; let db: Db;
 beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("judge-stop-projection-"); db = createDb(database.connectionString, { maxConnections: 4 }); db.$client.options.onnotice = () => {}; }, 90000);
 beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
 afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
 async function fixture() {
  const { companyId, actor } = await seedCompanyWithBoardAccess(db, "Judge real API projection");
  const agentId=randomUUID(), issueId=randomUUID(), runId=randomUUID(); const old=new Date(Date.now()-30*86400000);
  await db.insert(agents).values({id:agentId,companyId,name:"Prior execution owner",adapterType:"http",status:"active",lifecycleState:"ready",lifecycleHolds:[],lifecycleRequiredPluginIds:[]});
  await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,invocationSource:"on_demand",status:"cancelled",runtimeMode:"legacy",executionStage:"dispatching",startedAt:old,finishedAt:old,runnerProfileJson:{adapterDispatch:{adapterType:"http"}},resultJson:{}});
  await db.insert(issues).values({id:issueId,companyId,title:"Locked until previous execution stops",status:"in_progress",checkoutRunId:runId,executionRunId:runId,executionLockedAt:old});
  return {companyId,actor,agentId,issueId,runId};
 }
 it("keeps the Stop instruction visible when an exhausted workspace recovery owns the existing card", async () => {
  const f=await fixture();
  const state={...createSystemRecovery(f.runId),state:"exhausted",attempts:6,retriesUsed:5,failure:{code:"provider_unavailable",retryClass:"retry_transient",evidenceFingerprint:"prior-failure"}};
  await db.insert(issueRecoveryActions).values({companyId:f.companyId,sourceIssueId:f.issueId,kind:"active_run_watchdog",cause:"workspace_restore_unavailable",fingerprint:"saved-work",ownerType:"system",status:"escalated",nextAction:"Saved work recovery is exhausted.",evidence:{runId:f.runId,systemRecovery:state,workspaceRecovery:{sourceRunId:f.runId}},attemptCount:6,maxAttempts:6});
  expect((await recoveryService(db,{enqueueWakeup:vi.fn()}).sweepStaleIssueLocks()).cleared).toBe(0);
  const response=await request(routeApp(db,f.actor,issueRoutes)).get(`/api/issues/${f.issueId}`).expect(200);
  writeFileSync(process.env.TASK_OUT + "/stop-api-exhausted-workspace.json", JSON.stringify({case:"exhausted-workspace-projection",activeRecoveryAction:response.body.activeRecoveryAction},null,2));
  expect(response.body.activeRecoveryAction.evidence.stopPending.code).toBe("execution_stop_pending");
  expect(response.body.activeRecoveryAction.nextAction).toContain("execution_stop_pending");
 });
 it("does not let an ordinary source-scoped recovery upsert erase an unproved Stop obligation", async () => {
  const f=await fixture(); const recovery=recoveryService(db,{enqueueWakeup:vi.fn()});
  expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
  // The same source-scoped writer is used by native run/finalization recovery.
  await issueRecoveryActionService(db).upsertSourceScoped({companyId:f.companyId,sourceIssueId:f.issueId,kind:"active_run_watchdog",cause:"native_finalization_invalid",fingerprint:"new-finalizer-evidence",ownerType:"board",nextAction:"Inspect finalizer failure.",evidence:{runId:f.runId},attemptCount:1,maxAttempts:3,supersedeOnIdentityChange:true});
  const response=await request(routeApp(db,f.actor,issueRoutes)).get(`/api/issues/${f.issueId}`).expect(200);
  expect((await db.select().from(issues).where(eq(issues.id,f.issueId)))[0]).toMatchObject({checkoutRunId:f.runId,executionRunId:f.runId});
  writeFileSync(process.env.TASK_OUT + "/stop-api-upsert-erasure.json", JSON.stringify({case:"ordinary-upsert-erasure",activeRecoveryAction:response.body.activeRecoveryAction,checkoutRunId:response.body.checkoutRunId,executionRunId:response.body.executionRunId},null,2));
  expect(response.body.activeRecoveryAction.evidence.stopPending).toMatchObject({code:"execution_stop_pending",runIds:[f.runId]});
  expect(response.body.activeRecoveryAction.nextAction).toContain("execution_stop_pending");
 });
 it("exposes a thirty-day cancelled native lock whose empty retry coordinator has no future attempt or owner", async () => {
  const f=await fixture();
  await db.update(agents).set({adapterType:"paperclip_runner"}).where(eq(agents.id,f.agentId));
  await db.update(heartbeatRuns).set({runtimeMode:"native",nativeIssueId:f.issueId}).where(eq(heartbeatRuns.id,f.runId));
  await db.insert(nativeRunFinalizations).values({companyId:f.companyId,runId:f.runId,issueId:f.issueId,phase:"retryable_failure",resultId:null,leaseOwner:null,leaseExpiresAt:null,nextAttemptAt:null});
  expect(await runExecutionsHaveStopped(db,f.companyId,[f.runId])).toBe(false);
  const enqueueWakeup=vi.fn();
  for(let pass=0;pass<3;pass++) {
   const recovery=recoveryService(db,{enqueueWakeup});
   await recovery.reconcileStrandedAssignedIssues();
   expect(await claimNativeSessionResumptions({db,runnerInstanceId:"judge-recovery",runIds:[f.runId]})).toEqual([]);
   expect(await claimNativeRestartRecoveries({db,runIds:[f.runId],restartKind:"hard"})).toEqual([]);
   expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
  }
  expect(enqueueWakeup).not.toHaveBeenCalled();
  const response=await request(routeApp(db,f.actor,issueRoutes)).get(`/api/issues/${f.issueId}`).expect(200);
  expect((await db.select().from(issues).where(eq(issues.id,f.issueId)))[0]).toMatchObject({checkoutRunId:f.runId,executionRunId:f.runId});
  writeFileSync(process.env.TASK_OUT + "/stop-api-ownerless-native-retry.json", JSON.stringify({case:"ownerless-cancelled-native-retry",activeRecoveryAction:response.body.activeRecoveryAction,checkoutRunId:response.body.checkoutRunId,executionRunId:response.body.executionRunId,automaticWakes:enqueueWakeup.mock.calls.length},null,2));
  expect(response.body.activeRecoveryAction).toMatchObject({cause:"execution_stop_pending",ownerType:"board",status:"escalated"});
 });
});
