import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns,
  issueComments, issueExecutionDecisions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions,
} from "@paperclipai/db";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { claimNativeRestartRecoveries } from "./native-restart-recovery.js";

describe("saved native review decision recovery", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("native-review-decision-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  // The route suite proves the PATCH writes this exact deferred shape. These
  // integration cases start at that durable boundary, before any finish report.
  // Keep reason: crash-only failure path plus run/company/task authority boundary.
  async function savedChangesRequest() {
    const companyId = randomUUID(), agentId = randomUUID(), writerId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), stageId = randomUUID(), decisionId = randomUUID();
    const sessionId = randomUUID(), contractId = randomUUID(), runnerId = randomUUID();
    const contractSha256 = `contract-${runId}`;
    const comment = "Reviewer decision: request changes - cover the retry edge case.";
    const state = { status: "changes_requested", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: writerId },
      completedStageIds: [], lastDecisionId: decisionId, lastDecisionOutcome: "changes_requested", changesRequestedCount: 1 };
    await db.insert(companies).values({ id: companyId, name: "Review recovery", issuePrefix: `RR${companyId.slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", adapterType: "paperclip_runner", status: "active" },
      { id: writerId, companyId, name: "Writer", adapterType: "paperclip_runner", status: "active" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review the retry fix", status: "in_review", assigneeAgentId: agentId,
      executionState: state, executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] } });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "standalone-v1", objective: "Review the retry fix",
        criteria: [{ id: "objective", requirement: "Review the retry fix" }] }, canonicalSha256: contractSha256,
      createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native",
      contextSnapshot: { issueId }, completionContractId: contractId, completionContractSha256: contractSha256,
      nativeSessionId: sessionId, runnerInstanceId: runnerId });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    await db.insert(issueExecutionDecisions).values({ id: decisionId, companyId, issueId, stageId, stageType: "review",
      actorAgentId: agentId, outcome: "changes_requested", body: comment, createdByRunId: runId });
    await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId, createdByRunId: runId, body: comment });
    const port = new PaperclipControlPlanePort(db, { companyId, agentId, issueId, runId, sessionId, completionContractId: contractId,
      completionContractSha256: contractSha256, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: randomUUID() });
    await port.openRun({ identity: { companyId, agentId, issueId, runId, sessionId }, backendKind: "mock", sourceInstanceId: runnerId });
    return { companyId, agentId, writerId, issueId, runId, decisionId, state, comment, port };
  }

  async function expectReturnedOnce(value: Awaited<ReturnType<typeof savedChangesRequest>>) {
    const [task] = await db.select().from(issues).where(eq(issues.id, value.issueId));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, value.companyId));
    expect({ task, wakes }).toMatchObject({ task: { status: "in_progress", assigneeAgentId: value.writerId,
      assigneeUserId: null, executionRunId: null, checkoutRunId: null, executionState: value.state },
      wakes: [expect.objectContaining({ agentId: value.writerId, reason: "execution_changes_requested", status: "queued" })] });
    expect(wakes).toHaveLength(1);
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, value.issueId));
    expect(decisions.map(row => row.reasonCode)).toEqual(["execution_stage_changes_requested"]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, value.issueId));
    expect(comments).toEqual([expect.objectContaining({ body: value.comment, createdByRunId: value.runId })]);
  }

  it("C3-2 applies the saved changes request once even after the reviewer reports failure and a block", async () => {
    const value = await savedChangesRequest();
    await value.port.completeRun({ callerResultId: randomUUID(),
      result: { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "blocked", summary: "Reviewer failed after saving the decision.",
        completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, objectiveSatisfied: false,
          remainingWork: [{ description: "Repair the reviewer environment", blocksCompletion: true }] },
        blocker: { reasonCode: "missing_access", owner: { kind: "user", name: "Board operator" }, scope: "task_wide",
          unblockAction: "Repair the reviewer environment" } },
      terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "blocked" },
    });
    await finalizeNativeRun({ db, runId: value.runId, workspaceFinalizeStatus: "succeeded" });
    await finalizeNativeRun({ db, runId: value.runId, workspaceFinalizeStatus: "succeeded" });
    await expectReturnedOnce(value);
  });

  // KNOWN GAP, after the move (RFL 04:5xZ C3-1): process loss before finish leaves the saved
  // decision unapplied (same gap as #20373 approve). it.fails keeps the suite green and
  // flips loudly when the owner (native-run-finalizer via native-finalization-reconciler) is fixed.
  it.fails("C3-1 returns the saved changes request after process loss with no finish report (after-the-move RED)", async () => {
    const value = await savedChangesRequest();
    // Durable terminal-loss outcome, not completeRun: no semantic result exists.
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "process_lost", error: "Reviewer process lost before finish",
      nativePhase: "terminal_failure", finishedAt: new Date() }).where(eq(heartbeatRuns.id, value.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "process_lost" })
      .where(eq(nativeRunFinalizations.runId, value.runId));
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, value.runId))).toEqual([]);
    // Exercise both existing recovery owners. Neither may start a replacement
    // reviewer and pretend its different run id owns the saved decision.
    await claimNativeRestartRecoveries({ db, runIds: [value.runId], restartKind: "hard" });
    await reconcileNativeFinalizations(db, [value.runId]);
    await reconcileNativeFinalizations(db, [value.runId]);
    // Deliberately RED until the existing terminal finalization owner supports
    // a saved policy decision without fabricating a provider finish result.
    await expectReturnedOnce(value);
  });
});
