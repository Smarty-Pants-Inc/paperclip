import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, completionContracts, createDb, heartbeatRuns, issues,
  issueThreadInteractions, nativeRunResults, projects, statusDecisions, workAssessments,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveAndRetainRunTrustPreset } from "../services/run-trust-preset.js";
import { isIssueWithinLowTrustBoundary } from "../services/trust-preset-resolver.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native completion review dispatch trust", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-review-trust-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed(withProject = true) {
    const companyId = randomUUID(), agentId = randomUUID(), workerId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), sourceRunId = randomUUID();
    const projectId = withProject ? randomUUID() : null;
    const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    const decisionId = randomUUID(), interactionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", role: "engineer", adapterType: "paperclip_runner" },
      { id: agentId, companyId, name: "Reviewer", role: "qa", adapterType: "paperclip_runner", permissions: {
        authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET, trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET, allowedSecretBindingIds: [], allowedToolClasses: ["read"],
        } },
      } },
    ]);
    if (projectId) await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Review work", status: "in_review",
      assigneeAgentId: workerId, statusVersion: 3 });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: workerId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: sourceRunId,
      completionContractId: contractId, completionContractSha256: contractId });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: sourceRunId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: sourceRunId,
      contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress", priorStatusVersion: 2, policyVersion: "phase6-v1", assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: sourceRunId, assessmentId,
      decisionVersion: 1, policyVersion: "phase6-v1", fromStatus: "in_progress", toStatus: "in_review",
      reasonCode: "review", decisionJson: { projectedStatusVersion: 3 }, decisionDigest: decisionId, applicationState: "applied" });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, kind: "request_confirmation",
      sourceRunId, addresseeAgentId: agentId, payload: { version: 1, prompt: "Review",
        target: { type: "custom", key: "native_completion_review", revisionId: decisionId } } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId, projectId, nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId,
        marker: "preserve", executionPolicy: { retryPolicy: { maxAttempts: 2 } } } });
    await db.update(issues).set({ executionRunId: runId, lastStatusDecisionId: decisionId }).where(eq(issues.id, issueId));
    return { companyId, agentId, workerId, issueId, runId, projectId, interactionId };
  }
  async function launch(input: Awaited<ReturnType<typeof seed>>) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    const project = input.projectId ? (await db.select().from(projects).where(eq(projects.id, input.projectId)))[0] : null;
    return resolveAndRetainRunTrustPreset(db, { ...input, agent, issue, project });
  }

  it.each([true, false])("retains exact-task containment for a valid review (project=%s)", async (withProject) => {
    const input = await seed(withProject);
    const result = await launch(input);
    expect(result.trustPreset.kind).toBe("low_trust_review");
    if (result.trustPreset.kind !== "low_trust_review") throw new Error("Review denied");
    expect(result.trustPreset.boundary).toMatchObject({ companyId: input.companyId, issueIds: [input.issueId],
      allowedSecretBindingIds: [], allowedToolClasses: ["read"] });
    expect(result.trustPreset.boundary.projectIds).toBeUndefined();
    expect(isIssueWithinLowTrustBoundary(result.trustPreset.boundary, { companyId: input.companyId, id: randomUUID(), projectId: input.projectId })).toBe(false);
    const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    expect(retained.contextSnapshot).toMatchObject({ marker: "preserve", executionPolicy: {
      retryPolicy: { maxAttempts: 2 }, authorizationPolicy: { trustBoundary: { issueIds: [input.issueId] } },
    } });
    expect((await launch(input)).executionPolicy).toEqual(result.executionPolicy);
  });

  it.each(["ordinary wake", "forged review", "stale review", "lost lock", "empty issue set"])("denies %s", async (scenario) => {
    const input = await seed();
    if (scenario === "ordinary wake") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: input.issueId } }).where(eq(heartbeatRuns.id, input.runId));
    if (scenario === "forged review") await db.update(issueThreadInteractions).set({ addresseeAgentId: input.workerId }).where(eq(issueThreadInteractions.id, input.interactionId));
    if (scenario === "stale review") await db.update(issues).set({ statusVersion: 4 }).where(eq(issues.id, input.issueId));
    if (scenario === "lost lock") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, input.issueId));
    if (scenario === "empty issue set") await db.update(issues).set({ executionPolicy: { authorizationPolicy: {
      trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, issueIds: [] },
    } } }).where(eq(issues.id, input.issueId));
    expect((await launch(input)).trustPreset).toMatchObject({ kind: "denied", reason: "missing_low_trust_boundary_scope" });
  });
});
