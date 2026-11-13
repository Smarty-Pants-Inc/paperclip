import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, assets, companies, completionContracts, createDb, heartbeatRuns,
  issueAttachments, issueThreadInteractions, issues, nativeRunResults,
  statusDecisions, workAssessments,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

// Trust boundary: the native reviewer needs stored asset identities, not worker-authored hashes.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native review attachment manifest", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-review-manifest-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), issueId = randomUUID(), workerId = randomUUID(), reviewerId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review manifests", issuePrefix: `M${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Worker", status: "idle", adapterType: "paperclip_runner" },
      { id: reviewerId, companyId, name: "Reviewer", status: "running", adapterType: "paperclip_runner" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Review delivered bytes", status: "in_review", statusVersion: 3, assigneeAgentId: workerId });
    const [contract] = await db.insert(completionContracts).values({ companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "low", completionAuthority: "agent",
      incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: randomUUID(), createdByActorType: "user", createdByActorId: "local-board" }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: workerId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded",
      completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256 }).returning();
    const [result] = await db.insert(nativeRunResults).values({ companyId, issueId, runId: source!.id, completionContractId: contract!.id,
      serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() }).returning();
    const [assessment] = await db.insert(workAssessments).values({ companyId, issueId, runId: source!.id, contractId: contract!.id, resultId: result!.id,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 2,
      policyVersion: "fixture", assessmentJson: {}, inputDigest: randomUUID() }).returning();
    const [decision] = await db.insert(statusDecisions).values({ companyId, issueId, runId: source!.id, assessmentId: assessment!.id, decisionVersion: 1,
      policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "explicit_review",
      decisionJson: { projectedStatusVersion: 3 }, decisionDigest: randomUUID(), applicationState: "applied" }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_confirmation", sourceRunId: source!.id,
      addresseeAgentId: reviewerId, createdByAgentId: workerId, payload: { version: 1, prompt: "Worker claims sha256 is not-the-stored-hash.",
        target: { type: "custom", key: "native_completion_review", revisionId: decision!.id } } }).returning();
    const nativeReview = { nativeReviewInteractionId: interaction!.id, nativeReviewDecisionId: decision!.id };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerId, nativeIssueId: issueId, runtimeMode: "native", status: "running",
      contextSnapshot: { issueId, ...nativeReview } });
    await db.update(issues).set({ lastStatusDecisionId: decision!.id, executionRunId: runId }).where(eq(issues.id, issueId));
    const binding = { companyId, issueId, agentId: reviewerId, runId, nativeReview };
    const authority = new PaperclipRunnerToolAuthority(db, binding);
    const read = () => authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
    return { companyId, issueId, workerId, reviewerId, runId, nativeReview, binding, read };
  }

  async function attach(companyId: string, issueId: string, index: number) {
    const assetId = randomUUID(), id = randomUUID(), sha256 = String(index).repeat(64);
    const createdAt = new Date(`2026-11-12T01:02:0${index}.000Z`);
    const originalFilename = `delivery-${index}.csv`, byteSize = 48 * index;
    await db.insert(assets).values({ id: assetId, companyId, provider: "local_disk", objectKey: `private-storage/${assetId}`,
      contentType: "text/csv", byteSize, sha256, originalFilename });
    await db.insert(issueAttachments).values({ id, companyId, issueId, assetId, createdAt });
    return { id, originalFilename, byteSize, sha256, createdAt };
  }

  it("returns both exact stored identities for the authorized task without storage or credential fields", async () => {
    const f = await fixture();
    const first = await attach(f.companyId, f.issueId, 1), second = await attach(f.companyId, f.issueId, 2);
    const other = await fixture();
    await attach(other.companyId, other.issueId, 3);
    const [sibling] = await db.insert(issues).values({ companyId: f.companyId, title: "Not the reviewed task" }).returning();
    await attach(f.companyId, sibling!.id, 4);
    const context = await f.read() as { attachmentManifest: unknown };
    expect(context).toMatchObject({ activeTask: { id: f.issueId, assigneeAgentId: f.workerId }, assignedReview: { id: f.nativeReview.nativeReviewInteractionId } });
    expect(context.attachmentManifest).toEqual([second, first]);
  });

  it("returns an empty manifest for an authorized review with no attachments", async () => {
    const f = await fixture();
    expect((await f.read() as { attachmentManifest: unknown }).attachmentManifest).toEqual([]);
  });

  it.each(["reassigned", "stale", "stopped", "lock_lost", "unadmitted", "private"] as const)("returns no context or manifest when reviewer authority is %s", async reason => {
    const f = await fixture();
    await attach(f.companyId, f.issueId, 1);
    if (reason === "reassigned") await db.update(issueThreadInteractions).set({ addresseeAgentId: f.workerId }).where(eq(issueThreadInteractions.id, f.nativeReview.nativeReviewInteractionId));
    if (reason === "stale") await db.update(issues).set({ statusVersion: 4 }).where(eq(issues.id, f.issueId));
    if (reason === "stopped") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    if (reason === "lock_lost") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    if (reason === "unadmitted") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
    if (reason === "private") await db.update(issues).set({ visibility: "private", createdByUserId: "someone-else" }).where(eq(issues.id, f.issueId));
    const expectedError = reason === "stopped" ? "paperclip_runner_tool_binding_not_authorized"
      : reason === "unadmitted" ? "The run was not admitted for this review."
      : reason === "private" ? "The task is no longer available to this run"
      : "The assigned review is no longer available to this run.";
    await expect(f.read()).rejects.toThrow(expectedError);
  });
});
