import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { PROVIDER_LAUNCH_PROFILE_MISMATCH, runnerRecoveryFailureClass } from "../../vendor/paperclip-runner/index.js";
import { RUNNER_REUSE_REFUSAL_NEXT_ACTION, runnerReuseRefusalText } from "./runner-reuse-refusal-notice.js";

export { NATIVE_RUNNER_LAUNCH_PROFILE_MISMATCH } from "./runner-reuse-refusal-notice.js";

/** Core consumes the Runner's normalized class, not provider names or prose. */
export function runnerLaunchProfileMismatch(error: unknown): boolean {
  return runnerRecoveryFailureClass(error) === PROVIDER_LAUNCH_PROFILE_MISMATCH;
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
    const [existing] = await tx.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      sql`(${issueComments.metadata}->>'authorizationReason' = ${authorizationReason}
        or (${issueComments.deletedAt} is null and ${issueComments.authorType} = 'system'
          and ${issueComments.metadata}->>'sourceRunId' = ${runId}
          and starts_with(${issueComments.metadata}->>'authorizationReason', 'unanswered_message:')))`)).limit(1);
    const body = runnerReuseRefusalText(reason);
    if (existing) {
      // A previous-release sweep may have won the durable issue fence. Repair
      // that very note, keeping its message identity and source-run evidence;
      // another connection/restart must not retain misleading resend advice.
      if (existing.deletedAt === null && existing.authorType === "system") {
        let hasNextAction = false;
        const nextAction = { type: "key_value" as const, label: "Next action", value: RUNNER_REUSE_REFUSAL_NEXT_ACTION };
        const sections = (existing.metadata?.sections ?? []).map(section => ({ ...section,
          rows: section.rows.map(row => {
            if (row.type !== "key_value" || row.label !== "Next action") return row;
            hasNextAction = true;
            return nextAction;
          }),
        }));
        if (!hasNextAction) sections.push({ title: "Recovery", rows: [nextAction] });
        const metadata = { ...existing.metadata, version: 1 as const, sections };
        const presentation = { ...existing.presentation, kind: "system_notice" as const, tone: "warning" as const,
          title: "Runner recovery needed", detailsDefaultOpen: false };
        if (existing.body !== body || JSON.stringify(existing.metadata) !== JSON.stringify(metadata)
          || JSON.stringify(existing.presentation) !== JSON.stringify(presentation)) {
          await tx.update(issueComments).set({ body, metadata, presentation, updatedAt: new Date() }).where(eq(issueComments.id, existing.id));
        }
      }
      return;
    }
    await issueService(db).addComment(issueId, body,
      {}, { authorType: "system", presentation: { kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false },
        metadata: { version: 1, authorizationReason, sourceRunId: runId, sections: [
          { title: "Recovery", rows: [{ type: "key_value", label: "Next action", value: RUNNER_REUSE_REFUSAL_NEXT_ACTION }] },
          { title: "Run evidence", rows: [{ type: "run_link", runId, agentId, title: "Runner recovery needed" }] },
        ] } }, tx);
  });
}
