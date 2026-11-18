import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { expect } from "vitest";
import { terminalizeLegacyExecution, legacyExecutionNeedsReconciliationWithEvidence } from "../../services/legacy-execution-recovery.js";
import { getExecutionBlocker } from "../../services/execution-blocker.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";

/** Cross the existing failure/next-try boundary with the actual exclusion
 * error. Only the provider command is stubbed; terminalization and queue writes
 * are real. No new error code or retry policy is installed by this fix. */
export async function queueGitExclusionNextTry(db: Db, companyId: string, agentId: string, userId: string, runId: string, error: Error) {
  const [issue] = await db.insert(issues).values({ companyId, title: "Continue after exclusion timeout", status: "in_progress",
    assigneeAgentId: agentId, responsibleUserId: userId, executionRunId: runId }).returning();
  const [comment] = await db.insert(issueComments).values({ companyId, issueId: issue!.id, authorType: "user", authorUserId: userId,
    body: "Please finish this task." }).returning();
  const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "legacy", issueId: issue!.id,
    contextSnapshot: { issueId: issue!.id, wakeReason: "issue_commented", wakeCommentId: comment!.id } })
    .where(eq(heartbeatRuns.id, runId)).returning();
  const terminal = await terminalizeLegacyExecution({ db, run: run!, status: "failed", reconcileIfNeeded: true,
    patch: { error: error.message, errorCode: "adapter_failed", finishedAt: new Date(),
      // failRun records this when instruction preparation throws before dispatch.
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } } });
  expect(terminal).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
  expect(await legacyExecutionNeedsReconciliationWithEvidence(db, terminal!)).toBe(false);
  expect(await getExecutionBlocker(db, companyId, issue!.id)).toBeNull();
  const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
    resolveResponsibleUserId: async () => userId,
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  }), recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } });
  expect((await release({ companyId, runId, now: new Date() })).outcome.kind).toBe("queued_recovery");
  const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
  expect(await successors()).toEqual([expect.objectContaining({ status: "queued", responsibleUserId: userId,
    contextSnapshot: expect.objectContaining({ wakeCommentId: comment!.id }) })]);
  await release({ companyId, runId, now: new Date() });
  expect(await successors()).toHaveLength(1);
  return (await successors())[0]!.id;
}
