import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";

export const NATIVE_RUNNER_LAUNCH_PROFILE_MISMATCH = "native_runner_launch_profile_mismatch";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** A failed Runner command receipt, never a provider/model message. The warm
 * recovery boundary serializes the receipt into its Error; preserve that case
 * without accepting an arbitrary mention of the launch-profile diagnostic. */
export function runnerLaunchProfileMismatch(error: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  const value = record(error);
  let receipt = record(value.runnerCommandResult);
  if (error instanceof Error) {
    const match = /^(?:native_session_recovery_failed: )?(?:Error: )?PRP command (run\.(?:attach|prepare)) failed: (\{[^\n]*\})$/.exec(error.message);
    if (match) {
      try {
        const parsed = record(JSON.parse(match[2]!));
        if (parsed.commandType === match[1]) receipt = parsed;
      } catch { /* A malformed receipt is not authority. */ }
    }
  }
  const result = record(receipt.result);
  if (["run.attach", "run.prepare"].includes(String(receipt.commandType)) && receipt.status === "failed"
    && result.code === "command_execution_failed" && typeof result.message === "string"
    && (/^(?:Pi|OpenCode|Cursor Cloud|ACPX descriptor sidecar)(?: run\.prepare)? launch does not match the runner-owned qualified profile$/.test(result.message)
      || /^(?:Pi|OpenCode|Cursor Cloud) runner launch profile changed across durable recovery$/.test(result.message))) return true;
  return runnerLaunchProfileMismatch(value.cause, depth + 1);
}

/** Refusal is the safe escape when we cannot prove that retiring the computer
 * preserves its only conversation copy. One durable note for this refused turn,
 * independent of an idle chat's todo status. No reset, retry or history erasure.
 * The issue → run lock and generation checks fence replay across chat resets. */
export async function noticeRunnerReuseRefusal(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
  normalizedSessionId?: string;
  reason: "runner_launch_profile_mismatch" | "runner_pack_reuse_blocked";
}): Promise<void> {
  const { companyId, issueId, agentId, runId, normalizedSessionId, reason } = input;
  await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("no key update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))).for("update");
    // Lease admission runs before native runtime selection binds nativeIssueId.
    // Use the same server-owned task binding precedence as comment admission,
    // not a caller-supplied issue id alone (a foreign native binding wins).
    const runIssueId = run?.nativeIssueId ?? run?.issueId ?? run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId;
    if (!issue || !run || !["running", "failed"].includes(run.status) || run.resultJson?.startupCancellation
      || runIssueId !== issueId || (normalizedSessionId && run.nativeSessionId !== normalizedSessionId)
      || issue.assigneeAgentId !== agentId || (issue.conversationAgentId && (issue.conversationAgentId !== agentId
        || run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration))) return;
    const authorizationReason = `${reason}:${runId}`;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      sql`(${issueComments.metadata}->>'authorizationReason' = ${authorizationReason}
        or (${issueComments.deletedAt} is null and ${issueComments.authorType} = 'system'
          and ${issueComments.metadata}->>'sourceRunId' = ${runId}
          and starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')))`)).limit(1);
    if (existing) return;
    const detail = reason === "runner_launch_profile_mismatch"
      ? "the saved computer's Runner launch profile is incompatible with this release"
      : "the Runner changed and a complete saved conversation could not be verified";
    await issueService(db).addComment(issueId,
      `I could not run this message because ${detail}. The old computer and conversation were preserved; I did not start an empty conversation or retry the incompatible Runner. Recovery needs a verified conversation save before a fresh computer can be used.`,
      {}, { authorType: "system", presentation: { kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false },
        metadata: { version: 1, authorizationReason, sections: [{ rows: [{ type: "run_link", runId, agentId, title: "Runner recovery needed" }] }] } }, tx);
  });
}
