import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { logActivity } from "../activity-log.js";

export const SUPERSEDED_COMPLETION_ERROR = "chat_completion_superseded";
export const SUPERSEDED_COMPLETION_RETIRED_ACTION = "issue.recovery_action_retired_superseded_completion";

/** A run whose ONLY failure was a superseded automatic chat-completion turn
 * (before 9e501968 it ended as setup_failed / chat_completion_superseded; now
 * it is a succeeded no-op). Any other code or text is a real failure. */
function failedOnlyAsSupersededCompletion(run: { status: string; errorCode: string | null; error: string | null }) {
  return run.status === "failed" && (run.errorCode === "setup_failed" || run.errorCode === SUPERSEDED_COMPLETION_ERROR)
    && (run.error ?? "").trim() === SUPERSEDED_COMPLETION_ERROR;
}

/**
 * The sweep retires EXISTING stranded recovery actions written for a run that
 * failed only because its automatic completion turn was superseded (SMA-4's
 * live action 22d69698 from run 9a73d06a): a false card under a reply that
 * succeeded. Every run the action names must be such a run; a real setup
 * failure, or superseded plus another failure, keeps its card. The run and its
 * trace stay; the retirement is an activity row.
 */
export async function retireSupersededCompletionStrandedActions(db: Db, opts: { companyId?: string; issueId?: string } = {}) {
  const actions = await db.select().from(issueRecoveryActions).where(and(
    opts.companyId ? eq(issueRecoveryActions.companyId, opts.companyId) : undefined,
    opts.issueId ? eq(issueRecoveryActions.sourceIssueId, opts.issueId) : undefined,
    eq(issueRecoveryActions.kind, "stranded_assigned_issue"),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  ));
  let retired = 0;
  for (const action of actions) {
    const evidence = (action.evidence ?? {}) as Record<string, unknown>;
    const runIds = [...new Set([evidence.latestRunId, evidence.sourceRunId]
      .filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (!runIds.length) continue;
    const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
      error: heartbeatRuns.error }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, action.companyId), inArray(heartbeatRuns.id, runIds)));
    if (runs.length !== runIds.length || !runs.every(failedOnlyAsSupersededCompletion)) continue;
    const resolved = await issueRecoveryActionService(db).resolveActiveForIssue({
      companyId: action.companyId, sourceIssueId: action.sourceIssueId, actionId: action.id,
      kind: "stranded_assigned_issue", status: "resolved", outcome: "false_positive",
      resolutionNote: "The run was a superseded automatic chat-completion turn, not a failure.",
    });
    if (!resolved) continue;
    retired += 1;
    await logActivity(db, { companyId: action.companyId, actorType: "system", actorId: "recovery",
      action: SUPERSEDED_COMPLETION_RETIRED_ACTION, entityType: "issue", entityId: action.sourceIssueId,
      details: { recoveryActionId: action.id, runIds } });
  }
  return retired;
}
