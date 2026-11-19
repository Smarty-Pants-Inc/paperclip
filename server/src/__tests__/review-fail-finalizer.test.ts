import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns, issueRelations, issues,
  nativeRunResults, statusDecisions, workspaceOperations,
} from "@paperclipai/db";
import { CONTROL_PLANE_CONFORMANCE_OPEN, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import type { PrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { nativeCompletionFeedback } from "../services/native-runtime/native-completion-feedback.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { issueService } from "../services/issues.js";

// RFL verdict REVIEWFAIL-2dcdb870: a review that found failures was admitted
// and stored, but the authoritative finalizer left the review task in progress
// and queued a same-agent continuation. These rows go through admission, the
// durable result, and the real finalizer on real Postgres.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_REVIEW_FAIL_FINALIZER_TEST_DATABASE_URL");

describe("a FAIL review reaches Done through the real finalizer", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), reviewerId = randomUUID(), builderId = randomUUID();

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("paperclip-review-fail-finalizer-");
    db = createDb(external ?? temporary!.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Review fail", issuePrefix: `RF${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Reviewer", adapterType: "codex_local", status: "running" },
      { id: builderId, companyId, name: "Builder", adapterType: "codex_local", status: "idle" },
    ]);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  async function seed(options: { review: boolean; title: string }) {
    const issueId = randomUUID(), contractId = randomUUID(), runId = randomUUID(), dependentId = randomUUID();
    // The work the review is about is its parent and waits on it (doc/execution-semantics.md "Review Delegation").
    await db.insert(issues).values({ id: dependentId, companyId, title: `Subject of ${options.title}`, status: "blocked",
      assigneeAgentId: builderId, workMode: "standard" });
    await db.insert(issues).values({ id: issueId, companyId, title: options.title, status: "in_progress",
      assigneeAgentId: reviewerId, workMode: "standard", parentId: dependentId,
      executionPolicy: options.review ? { mode: "normal", commentRequired: true, stages: [], taskKind: "review" } : null });
    await db.insert(issueRelations).values({ companyId, issueId, relatedIssueId: dependentId, type: "blocks" });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1", risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "review-v1", objective: options.title, criteria: [{ id: "objective", requirement: options.title }] },
      canonicalSha256: `review-fail-${contractId}`, createdByActorType: "system", createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerId, status: "running", runtimeMode: "native",
      runtimeModeReason: "persisted_before_kill_switch", nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: contractId,
      completionContractId: contractId, completionContractSha256: `review-fail-${contractId}`,
      contextSnapshot: { issueId, source: "issue.assignment" } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId: reviewerId, sessionId: runId,
      completionContractId: contractId, completionContractSha256: `review-fail-${contractId}`, sourceInstanceId: contractId,
      controlPlaneSourceInstanceId: `review-fail-control-${runId}` });
    await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN,
      identity: { companyId, issueId, runId, agentId: reviewerId, sessionId: runId }, sourceInstanceId: contractId });
    return { issueId, runId, dependentId, port };
  }

  const report = (verification: PrpStructuredRunResult["verification"], verdict?: "pass" | "fail") => ({
    schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
    summary: verdict === "fail" ? "Review complete. Three refund tests fail." : "Work complete.",
    completionClaim: { contractRevision: "review-v1", objectiveSatisfied: true,
      criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
    evidence: [], verification, attentionRequests: [], artifacts: [],
    ...(verdict ? { verdict } : {}),
  }) as PrpStructuredRunResult;
  const failedChecks = [
    { commandOrCheck: "pnpm test in the reviewed branch", status: "failed" as const, detail: "3 refund tests fail" },
    { commandOrCheck: "Read the full diff", status: "passed" as const },
  ];
  const passedChecks = [{ commandOrCheck: "pnpm test in the reviewed branch", status: "passed" as const }];

  /** Admission (the finish route's check), then the durable result, then the real finalizer. */
  async function finish(seeded: Awaited<ReturnType<typeof seed>>, result: PrpStructuredRunResult, options: { skipAdmission?: boolean } = {}) {
    if (!options.skipAdmission) await nativeCompletionFeedback(db, seeded.runId, result);
    await seeded.port.completeRun({ result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: `result-${seeded.runId}` });
    await db.insert(workspaceOperations).values({ companyId, heartbeatRunId: seeded.runId, issueId: seeded.issueId,
      phase: "workspace_finalize", status: "succeeded" });
    await finalizeNativeRun({ db, runId: seeded.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
  }
  const issueRow = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  const decision = (issueId: string) => db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))
    .then(rows => rows.at(-1));

  it("review task + done + verdict fail + failed checks -> Done, verdict FAIL recorded and carried downstream, no continuation", async () => {
    const seeded = await seed({ review: true, title: "Review PR #42 (refund rounding)" });
    await finish(seeded, report(failedChecks, "fail"));
    // No same-agent continuation for the reviewer (base: reason completion_evidence_incomplete, same_agent).
    const reviewerWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, reviewerId));
    expect(reviewerWakes.filter(row => JSON.stringify(row).includes(seeded.issueId)).map(row => `${row.reason} ${JSON.stringify(row.payload)}`)).toEqual([]);
    const issue = await issueRow(seeded.issueId);
    expect(`${issue.status} ${(await decision(seeded.issueId))?.reasonCode}`).toBe("done completion_claim_policy_accepted");
    // What the task page reads: the run's accepted result keeps the verdict and the failed check.
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then(rows => rows[0]!);
    expect(run.resultJson).toMatchObject({ finalizationPhase: "committed", reviewVerdict: "fail" });
    // The stored report keeps the failed check failed.
    const stored = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, seeded.runId)).then(rows => rows[0]!);
    expect((stored.resultJson as Record<string, any>).result).toMatchObject({ verdict: "fail",
      verification: [expect.objectContaining({ status: "failed" }), expect.anything()] });
    // The subject's owner is woken by the review's Done and sees the FAIL verdict, not a bare "blocker resolved".
    const subjectWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, builderId))
      .then(rows => rows.filter(row => (row.payload as Record<string, unknown>)?.resolvedBlockerIssueId === seeded.issueId));
    expect(subjectWakes.length).toBeGreaterThan(0);
    for (const wake of subjectWakes) expect(wake.payload).toMatchObject({ resolvedBlockerReviewVerdict: "fail" });
    const summaries = subjectWakes.flatMap(wake => ((wake.payload as Record<string, any>).childIssueSummaries ?? []) as Array<Record<string, unknown>>)
      .filter(entry => entry.id === seeded.issueId);
    expect(summaries.length).toBeGreaterThan(0);
    for (const entry of summaries) expect(String(entry.summary)).toMatch(/^Review verdict: FAIL\. Review complete/);
  }, 120_000);

  it("implementation task + verdict fail + failed checks -> refused at admission with the true line; the finalizer alone still keeps it open", async () => {
    const seeded = await seed({ review: false, title: "Fix refund rounding" });
    await expect(nativeCompletionFeedback(db, seeded.runId, report(failedChecks, "fail")))
      .rejects.toThrow(/verdict is only for a review task, and this task is not marked as one/);
    // Even if a report bypassed admission, the finalizer reads the task's own record, not the verdict.
    await finish(seeded, report(failedChecks, "fail"), { skipAdmission: true });
    expect((await issueRow(seeded.issueId)).status).not.toBe("done");
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then(rows => rows[0]!);
    expect(run.resultJson).not.toHaveProperty("reviewVerdict");
  }, 120_000);

  it("implementation done + failed check (no verdict) -> refused as before", async () => {
    const seeded = await seed({ review: false, title: "Fix refund rounding again" });
    await expect(nativeCompletionFeedback(db, seeded.runId, report(failedChecks)))
      .rejects.toThrow(/failed verification/);
    await expect(nativeCompletionFeedback(db, seeded.runId, report(failedChecks, "pass")))
      .rejects.toThrow(/verdict is only for a review task/);
  }, 120_000);

  it("review task without verdict fail, or with verdict pass, cannot carry a failed check", async () => {
    const seeded = await seed({ review: true, title: "Review PR #43" });
    await expect(nativeCompletionFeedback(db, seeded.runId, report(failedChecks))).rejects.toThrow(/This is a review task/);
    await expect(nativeCompletionFeedback(db, seeded.runId, report(failedChecks, "pass"))).rejects.toThrow(/failed verification/);
  }, 120_000);

  it("review PASS -> Done as before, no FAIL carried", async () => {
    const seeded = await seed({ review: true, title: "Review PR #44" });
    await finish(seeded, report(passedChecks, "pass"));
    expect((await issueRow(seeded.issueId)).status).toBe("done");
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then(rows => rows[0]!);
    // The task page's chip reads resultJson.reviewVerdict (ui task-chat-adapter acceptedRunResultVerdict).
    expect(run.resultJson).toMatchObject({ reviewVerdict: "pass" });
    const subjectWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, builderId))
      .then(rows => rows.filter(row => (row.payload as Record<string, unknown>)?.resolvedBlockerIssueId === seeded.issueId));
    for (const wake of subjectWakes) expect(wake.payload).not.toHaveProperty("resolvedBlockerReviewVerdict");
  }, 120_000);

  it("implementation done with passing checks -> Done as before (positive control)", async () => {
    const seeded = await seed({ review: false, title: "Implement refund rounding" });
    await finish(seeded, report(passedChecks));
    expect((await issueRow(seeded.issueId)).status).toBe("done");
  }, 120_000);

  it("an agent cannot mark its own task as a review task", async () => {
    const seeded = await seed({ review: false, title: "Fix rounding, then call it a review" });
    await expect(issueService(db).update(seeded.issueId, {
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], taskKind: "review" }, actorAgentId: reviewerId,
    } as never)).rejects.toThrow(/cannot change whether its own task is a review task/);
    expect((await issueRow(seeded.issueId)).executionPolicy).toBeNull();
  }, 120_000);
});
