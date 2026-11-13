import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueThreadInteractions, issueWorkProducts, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("F-32H native completion review and pending approval", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-review-f32h-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("does not close an issue when reviewer A accepts its completion card while user U approval is pending", async () => {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const reviewerAgentId = randomUUID();
    const reviewerUserId = `reviewer-${randomUUID()}`;
    const issueId = randomUUID();
    const runId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "F-32H", issuePrefix: `F${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" },
      { id: reviewerAgentId, companyId, name: "Reviewer A", adapterType: "paperclip_runner", status: "active" },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: reviewerUserId, status: "active", membershipRole: "operator" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "F-32H approval gate",
      status: "in_progress",
      assigneeAgentId: workerId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [
        { id: reviewStageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId }] },
        { id: approvalStageId, type: "approval", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "user", userId: reviewerUserId }] },
      ] },
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: workerId, nativeIssueId: issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    const contractId = randomUUID();
    const sessionId = randomUUID();
    const runnerId = randomUUID();
    const contractSha256 = `contract-${runId}`;
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "standalone-v1", objective: "Prepare the site", criteria: [{ id: "objective", requirement: "Prepare the site" }] },
      canonicalSha256: contractSha256, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, completionContractSha256: contractSha256,
      nativeSessionId: sessionId, runnerInstanceId: runnerId }).where(eq(heartbeatRuns.id, runId));
    const [product] = await db.insert(issueWorkProducts).values({ companyId, issueId, type: "artifact", provider: "test",
      title: "Prepared site", status: "completed", reviewState: "approved" }).returning();
    const evidenceRef = `work_product:${product!.id}`;
    const result: PrpStructuredRunResult = { ...CONTROL_PLANE_CONFORMANCE_RESULT,
      reportedWorkDisposition: "needs_review",
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, objectiveSatisfied: false,
        criteria: [{ criterionId: "objective", status: "not_satisfied", evidenceRefs: [] }],
        remainingWork: [{ description: "Review the prepared site", blocksCompletion: true }] },
      evidence: [{ kind: "work_product", ref: evidenceRef }],
      verification: [{ commandOrCheck: "Prepared site", status: "passed", artifactRef: evidenceRef }],
      attentionRequests: [{ kind: "review", summary: "Reviewer A: please review the prepared site.", ownerClass: "agent", targetAgentId: reviewerAgentId }],
    } as PrpStructuredRunResult;
    const identity = { companyId, agentId: workerId, issueId, runId };
    const port = new PaperclipControlPlanePort(db, { ...identity, sessionId, completionContractId: contractId,
      completionContractSha256: contractSha256, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: randomUUID() });
    await port.openRun({ identity: { ...identity, sessionId }, backendKind: "mock", sourceInstanceId: runnerId });
    await port.completeRun({ result, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: "needs_review" }, callerResultId: randomUUID() });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    await db.update(issues).set({ executionState: { status: "pending", currentStageId: approvalStageId, currentStageIndex: 1,
      currentStageType: "approval", currentParticipant: { type: "user", userId: reviewerUserId },
      returnAssignee: { type: "agent", agentId: workerId }, completedStageIds: [reviewStageId],
      lastDecisionId: randomUUID(), lastDecisionOutcome: "approved" } }).where(eq(issues.id, issueId));

    const [issueBefore] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueBefore).toMatchObject({ status: "in_review", executionState: { status: "pending", currentStageId: approvalStageId,
      currentStageType: "approval", currentParticipant: { type: "user", userId: reviewerUserId } } });
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(card).toMatchObject({ kind: "request_confirmation", status: "pending" });
    const reviewRunId = randomUUID();
    const decisionId = (issueBefore!.lastStatusDecisionId ?? "");
    await db.insert(heartbeatRuns).values({ id: reviewRunId, companyId, agentId: reviewerAgentId, nativeIssueId: issueId,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId, nativeReviewInteractionId: card!.id, nativeReviewDecisionId: decisionId } });
    await db.update(issues).set({ executionRunId: reviewRunId }).where(eq(issues.id, issueId));
    await issueThreadInteractionService(db).acceptInteraction(
      { id: issueId, companyId, projectId: null, goalId: null, status: "in_review" }, card!.id, {}, { agentId: reviewerAgentId, runId: reviewRunId });

    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after!.status).not.toBe("done");
  });
});
