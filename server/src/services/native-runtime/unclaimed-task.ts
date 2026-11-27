import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, issueComments, type heartbeatRuns, type Db } from "@paperclipai/db";

export const PI_UNCLAIMED_CONTINUATION_KEY = "native-pi-unclaimed";
export const UNCLAIMED_TASK_OWNER_REASON = "server_unclaimed_task";
export const UNCLAIMED_TASK_OWNER_MISSING_REASON = "native_unclaimed_task_owner_missing";
export const UNCLAIMED_TASK_OWNER_MISSING_NOTICE = "This task stopped twice without filing its result and has no owner to confirm it. Assign an owner or reply here to continue.";

/** Person input owns the next turn, including an older message still in its queue.
 * Read again under the status committer's issue lock before issuing repair effects.
 */
export async function hasUnclaimedTaskPersonInput(db: Pick<Db, "select">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "companyId" | "agentId" | "startedAt" | "createdAt">,
  issueId: string): Promise<boolean> {
  const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.authorType, "user"), isNull(issueComments.authorAgentId),
    isNull(issueComments.deletedAt), isNull(issueComments.createdByRunId),
    or(gt(issueComments.createdAt, run.startedAt ?? run.createdAt), sql`exists (
      select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${run.companyId}
      and ${agentWakeupRequests.agentId} = ${run.agentId} and ${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution')
      and ${agentWakeupRequests.payload}->>'issueId' = ${issueId}
      and ${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}' @> jsonb_build_array(${issueComments.id}::text))`),
  )).limit(1);
  return Boolean(comment);
}
