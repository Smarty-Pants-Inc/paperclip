import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { validatePrpStructuredRunResult, type PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import {
  PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_DESCRIPTION,
} from "../../../../packages/paperclip-runner/src/contracts/completion-result.js";
import { normalizeLegacyPrpStructuredRunResult } from "../../../../packages/paperclip-runner/src/protocol/result-normalization.js";

// Live SMA-674 (run cecfd76c): a reviewer whose review found failures was
// refused by the failed-verification guard, then relabelled the failed checks
// "passed" and was accepted. A finished review whose verdict is FAIL is a valid
// finish; "my own work failed its checks" is still refused; nothing tells the
// agent to relabel a failed check.
let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { temporary = await startRecoveryPostgres("review-verdict-finish-"); db = createDb(temporary.connectionString); });
afterAll(async () => { await temporary?.cleanup(); });

async function fixture(title: string) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), contractId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Review verdict", issuePrefix: `R${companyId.slice(0, 7)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "paperclip_runner", status: "active" });
  await db.insert(issues).values({ id: issueId, companyId, title, status: "in_progress", assigneeAgentId: agentId });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native", completionContractId: contractId,
    contextSnapshot: { issueId, source: "issue.assignment" } });
  await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "control", contractJson: { revision: "1", criteria: [{ id: "objective", requirement: title }] } });
  await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
  return runId;
}

const failedChecks = [
  { commandOrCheck: "pnpm test in the reviewed branch", status: "failed" as const, detail: "3 tests fail: refund rounding" },
  { commandOrCheck: "Read the full diff", status: "passed" as const },
];
const base = (verification: PrpStructuredRunResult["verification"]): PrpStructuredRunResult => ({
  schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Review complete. Verdict: FAIL. Three refund tests fail.",
  completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
  evidence: [], verification, attentionRequests: [], artifacts: [],
});

it("(a) accepts a finished review whose verdict is FAIL with its failed checks, and keeps the verdict in the recorded result", async () => {
  const runId = await fixture("Review PR #42 (refund rounding)");
  const report = { ...base(failedChecks), verdict: "fail" } as PrpStructuredRunResult;
  await expect(nativeCompletionFeedback(db, runId, report)).resolves.toMatch(/accepted/);
  // The recorded result keeps the verdict and the failed check unchanged.
  const recorded = normalizeLegacyPrpStructuredRunResult(report) as Record<string, unknown>;
  expect(validatePrpStructuredRunResult(recorded).ok).toBe(true);
  expect(recorded.verdict).toBe("fail");
  expect(recorded.verification).toEqual([expect.objectContaining({ status: "failed" }), expect.objectContaining({ status: "passed" })]);
}, 60_000);

it("(b) still refuses an implementation that claims done while its own check failed", async () => {
  const runId = await fixture("Fix refund rounding");
  await expect(nativeCompletionFeedback(db, runId, base(failedChecks))).rejects.toThrow("failed verification");
  // A pass verdict cannot carry a failed check either.
  await expect(nativeCompletionFeedback(db, runId, { ...base(failedChecks), verdict: "pass" } as PrpStructuredRunResult)).rejects.toThrow("failed verification");
}, 60_000);

it("(c) the refusal and the tool text tell the agent to report the failure truthfully, never to relabel it", async () => {
  const runId = await fixture("Review PR #43");
  const error = await nativeCompletionFeedback(db, runId, base(failedChecks)).then(() => null, (e: Error) => e.message);
  expect(error).toContain("Report the failure truthfully");
  expect(error).toContain('verdict "fail"');
  expect(error).toMatch(/Never change a failed check to passed/);
  for (const text of [PRP_COMPLETION_TOOL_DESCRIPTION, JSON.stringify(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA), JSON.stringify(PRP_COMPLETION_RESULT_OUTPUT_SCHEMA)]) {
    expect(text).toContain("verdict");
    expect(text).toMatch(/[Nn]ever (relabel|change) a failed check/);
  }
}, 60_000);
