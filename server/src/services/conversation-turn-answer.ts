import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { answeredPersonMessageSql } from "./person-message-answer.js";

/** SQL over a conversation run (its company, task and context snapshot): the person message the run carries as its
 * turn (the reply boundary, else the wake comment: settleConversationTurn's own choice) is still OWED an answer by
 * the ONE function (answeredPersonMessageSql, person-message-answer.ts). ONE call; no second answered rule.
 * Final-reply repair reads it (native-response-presentation-query.ts and its twin guard in
 * native-run-finalizer.ts): a chat that an earlier rule parked as "answered" (waiting, In Review) while the message
 * is owed still gets the run's accepted final reply presented, once. */
export function conversationRunMessageOwedSql(run: { companyId: SQL; issueId: SQL; contextSnapshot: SQL }): SQL {
  return sql`exists (select 1 from ${issueComments} m
    where m.company_id = ${run.companyId} and m.issue_id = ${run.issueId} and m.author_type = 'user' and m.deleted_at is null
      and m.id::text = coalesce(${run.contextSnapshot}->>'conversationReplyBoundaryCommentId',
        ${run.contextSnapshot}->>'wakeCommentId', ${run.contextSnapshot}->>'commentId')
      and not ${answeredPersonMessageSql({ id: sql.raw("m.id"), companyId: sql.raw("m.company_id"),
        issueId: sql.raw("m.issue_id"), createdAt: sql.raw("m.created_at") })})`;
}

/** The same read for one run, for the finalizer's guard. */
export async function conversationRunMessageOwed(db: Pick<Db, "select">, input: { companyId: string; issueId: string; runId: string }) {
  const [row] = await db.select({ owed: sql<boolean>`${conversationRunMessageOwedSql({ companyId: sql`${heartbeatRuns.companyId}`,
    issueId: sql`${input.issueId}::uuid`, contextSnapshot: sql`${heartbeatRuns.contextSnapshot}` })}` })
    .from(heartbeatRuns).where(sql`${heartbeatRuns.id} = ${input.runId}::uuid and ${heartbeatRuns.companyId} = ${input.companyId}::uuid`);
  return row?.owed === true;
}
