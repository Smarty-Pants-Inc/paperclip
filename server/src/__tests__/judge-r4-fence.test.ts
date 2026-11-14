// Independent Round-2 checks. Keep reasons: data safety, and the SMAA-1431
// committed-result/workspace-only failure incident. No provider or external calls.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issues, issueComments, nativeRunFinalizations,
  nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun, recordNativeFinalizationFailure } from "../services/native-runtime/native-run-finalizer.js";
import { nativeWorkspaceFinalizationWork } from "../services/native-runtime/native-workspace-finalization-work.js";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL } from "../services/remote-workspace-transport.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("RFL round 2 independent copy-back judgment", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rfl-copyback-round2-"));
    temporary = await startEmbeddedPostgresTestDatabase("rfl-copyback-round2-db-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Independent copyback judge", issuePrefix: "JCB" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Accepted-result worker", adapterType: "paperclip_runner" });
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); await rm(root, { recursive: true, force: true }); });

  async function seed() {
    const runId = randomUUID(), issueId = randomUUID(), contractId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved result with unfinished files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "rfl-copyback-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "rfl-copyback-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: sourceInstanceId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const binding = { companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: "rfl-copyback-v2" };
    await new PaperclipControlPlanePort(db, binding).completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: `${runId}:result` });
    return binding;
  }
  async function committed(f: Awaited<ReturnType<typeof seed>>) {
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [c] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [r] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(c.phase).toBe("committed"); expect(r.resultJson?.finalizationPhase).toBe("committed");
  }
  const failure = (runId: string, disk = false) => recordNativeFinalizationFailure({ db, runId,
    error: new Error("native_workspace_sync_out_failed"), failureScope: "workspace", projectRunStatus: true,
    ...(disk ? { failureCause: REMOTE_WORKSPACE_SANDBOX_DISK_FULL } : {}) });
  const notices = (f: Awaited<ReturnType<typeof seed>>, reader = db) => reader.select().from(issueComments).where(and(
    eq(issueComments.issueId, f.issueId), eq(issueComments.createdByRunId, f.runId), eq(issueComments.authorType, "system")));


  it.each(['missing','pending','running','failed','other-run-success','other-phase-success','same-run-success'] as const)('R4 R2-F1 fence: %s',async kind=>{
    const f=await seed(); await committed(f);
    const [before]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
    if(kind!=='missing') {
      const other=kind==='other-run-success'?await seed():f;
      await db.insert(workspaceOperations).values({companyId,issueId:other.issueId,heartbeatRunId:other.runId,
        phase:kind==='other-phase-success'?'workspace_prepare':'workspace_finalize',
        status:(['pending','running','failed'].includes(kind)?kind:'succeeded') as 'pending'|'running'|'failed'|'succeeded'});
    }
    await failure(f.runId);
    const [after]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
    console.log('JUDGE_FENCE',JSON.stringify({kind,phase:after.phase,nextAttempt:after.nextAttemptAt}));
    if(kind==='same-run-success') expect(after).toEqual(before);
    else {
      expect(after.phase).toBe('retryable_failure');
      expect(after.nextAttemptAt!.getTime()-after.updatedAt.getTime()).toBe(30000);
    }
  });
});
