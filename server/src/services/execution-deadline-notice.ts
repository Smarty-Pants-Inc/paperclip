import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { EXECUTION_FINALIZATION_DEADLINE_EXCEEDED } from "./execution-control-deadline.js";

/** Cause recorded when execution reconciliation fails a run at its control
 * deadline: upstream's own constant, so the writer and this reader share it. */
export const EXECUTION_DEADLINE_NOTICE_CAUSE = EXECUTION_FINALIZATION_DEADLINE_EXCEEDED;

/** authorizationReason prefix of the task-thread notice that reconciliation
 * commits with that failure; the failed run id follows it. */
export const EXECUTION_DEADLINE_NOTICE_REASON_PREFIX = `${EXECUTION_DEADLINE_NOTICE_CAUSE}:`;

export const EXECUTION_DEADLINE_NOTICE_BODY =
  "Paperclip could not resume or finish this reply before its execution deadline. "
    + "Open the failed run for details. Before retrying, verify that the previous execution has stopped "
    + "and reconcile any uncertain action.";

export type ExecutionDeadlineNotice = { commentId: string; body: string; createdAt: Date };

/**
 * The issue's newest execution-deadline notice, unless a LATER run (created
 * after the notice) on the same issue succeeded with a committed result. The
 * notice warns against retrying before the stopped execution is verified, so
 * while it stands the blocker must not offer Retry over it.
 */
export async function readUnsupersededExecutionDeadlineNotice(db: Db,
  input: { companyId: string; issueId: string }): Promise<ExecutionDeadlineNotice | null> {
  const reason = sql<string>`${issueComments.metadata}->>'authorizationReason'`;
  const [row] = await db.select({
    commentId: issueComments.id,
    body: issueComments.body,
    createdAt: issueComments.createdAt,
    // Compared in SQL so the notice and run timestamps keep full precision.
    superseded: sql<boolean>`exists (select 1 from ${heartbeatRuns} later
      where later.company_id = issue_comments.company_id
        and (later.native_issue_id = issue_comments.issue_id
          or later.context_snapshot->>'issueId' = issue_comments.issue_id::text)
        and later.status = 'succeeded'
        and (later.runtime_mode <> 'native' or exists (select 1 from ${nativeRunFinalizations} finalization
          where finalization.company_id = later.company_id and finalization.run_id = later.id
            and finalization.phase = 'committed'))
        and later.created_at > issue_comments.created_at)`,
  }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"),
    isNull(issueComments.deletedAt),
    sql`starts_with(${reason}, ${EXECUTION_DEADLINE_NOTICE_REASON_PREFIX})`,
  )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  return row && !row.superseded ? { commentId: row.commentId, body: row.body, createdAt: row.createdAt } : null;
}
