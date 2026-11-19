// Frozen selector shapes from 81b5ac94 (ia) and 351bc0a6 / 4ff03bbf (hedge).
import { and, eq, isNull, sql } from "drizzle-orm";
import { issueComments, agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { commentCarriedSql } from "../../services/interrupt-carry-custody.js";
import { personMessageOwedSql } from "../../services/person-message-answer.js";
export function ia(
  db: Db,
  companyId: string,
  issueId: string,
) {
  return db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.authorUserId} is not null`,
        isNull(issueComments.authorAgentId),
        eq(issueComments.origin, "comment"),
        sql`${issueComments.clientRequestId} is not null`,
        sql`not exists (select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${companyId}
      and ${agentWakeupRequests.idempotencyKey} = 'conversation-comment:' || ${issueComments.id}::text)`,
        // A same-turn hand-off owns this input without a wake. This also closes
        // the POST/outbox crash window and keeps retries from creating a second run.
        sql`not exists (select 1 from ${heartbeatRuns} steered_run where steered_run.company_id = ${companyId}
          and (steered_run.native_issue_id = ${issueId}::uuid or steered_run.context_snapshot->>'issueId' = ${issueId})
          and coalesce(steered_run.context_snapshot->'steeredCommentIds', '[]'::jsonb) ? ${issueComments.id}::text)`,
        // ONE successor (adopt-one-successor): a steer the Interrupt or the run-end restore handed
        // on (carry wake, interruptCarried/restoredSteeredCommentIds) is sent; never a second wake.
        sql`not ${commentCarriedSql(companyId, issueId, sql`${issueComments.id}`)}`,
      ),
    )
    .orderBy(issueComments.createdAt, issueComments.id)
    .limit(100);
}

export function hedge(
  db: Db,
  companyId: string,
  issueId: string,
) {
  return db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.authorUserId} is not null`,
        isNull(issueComments.authorAgentId),
        eq(issueComments.origin, "comment"),
        sql`${issueComments.clientRequestId} is not null`,
        sql`not exists (select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${companyId}
      and ${agentWakeupRequests.idempotencyKey} = 'conversation-comment:' || ${issueComments.id}::text)`,
        // A same-turn hand-off owns this input without a wake. This also closes
        // the POST/outbox crash window and keeps retries from creating a second run.
        sql`not exists (select 1 from ${heartbeatRuns} steered_run where steered_run.company_id = ${companyId}
          and (steered_run.native_issue_id = ${issueId}::uuid or steered_run.context_snapshot->>'issueId' = ${issueId})
          and coalesce(steered_run.context_snapshot->'steeredCommentIds', '[]'::jsonb) ? ${issueComments.id}::text)`,
        // ONE successor (adopt-one-successor): a steer the Interrupt or the run-end restore handed
        // on (carry wake, interruptCarried/restoredSteeredCommentIds) is sent; never a second wake.
        sql`not ${commentCarriedSql(companyId, issueId, sql`${issueComments.id}`)}`,
        // rf-4 R2: the ONE owed floor (person-message-answer.ts), as the sweep and the successor seed read it:
        // a carried message the chat moved past is never re-sent at boot.
        personMessageOwedSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
          issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }),
      ),
    )
    .orderBy(issueComments.createdAt, issueComments.id)
    .limit(100);
}
