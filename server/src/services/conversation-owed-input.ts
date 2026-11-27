import { and, eq, inArray, sql } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/** A resource-recovery receipt is not a delivery receipt. Only committed work
 * can promise another turn. Correlated with the current issue/assignee; no
 * historical completed wake, coalesced action or future recovery check owns it.
 * Qualify outer columns explicitly: Drizzle unqualifies selected SQL columns. */
function committedDeliveryOwner() {
  return sql<boolean>`(
    exists (select 1 from agent_wakeup_requests w
      where w.company_id = issues.company_id and w.agent_id = issues.assignee_agent_id
        and w.payload->>'issueId' = issues.id::text
        and w.status in ('queued', 'deferred_issue_execution')
        and coalesce(w.payload->'preDispatchInputOnly', 'false'::jsonb) <> 'true'::jsonb)
    or exists (select 1 from heartbeat_runs r
      where r.company_id = issues.company_id and r.agent_id = issues.assignee_agent_id
        and coalesce(r.native_issue_id::text, r.issue_id::text, r.context_snapshot->>'issueId') = issues.id::text
        and r.status in ('queued', 'running', 'scheduled_retry')
        and (issues.conversation_agent_id is null or r.context_snapshot->>'conversationSessionGeneration' is null
          or r.context_snapshot->>'conversationSessionGeneration' = issues.conversation_session_generation::text))
    or exists (select 1 from issue_recovery_actions a join heartbeat_runs source
      on source.company_id = a.company_id and source.id::text = a.evidence->>'runId'
      where a.company_id = issues.company_id and a.source_issue_id = issues.id
        and a.return_owner_agent_id = issues.assignee_agent_id and a.status = 'resolved'
        and a.evidence->>'continuationDelivery' = 'pending'
        and a.evidence#>>'{executionReconciliation,runId}' = source.id::text
        and source.agent_id = issues.assignee_agent_id
        and coalesce(source.native_issue_id::text, source.issue_id::text, source.context_snapshot->>'issueId') = issues.id::text
        and (issues.conversation_agent_id is null
          or source.context_snapshot->>'conversationSessionGeneration' = issues.conversation_session_generation::text))
  )`;
}

export async function hasCommittedIssueDeliveryOwner(db: Pick<Db, "select">, companyId: string, issueId: string) {
  const [row] = await db.select({ owned: committedDeliveryOwner() }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  return row?.owned === true;
}

/** Read saved person input, not attempted delivery. New-session boundaries,
 * published answers and explicitly returned Stop inputs retire the obligation.
 * Ordinary person comments have a null generation; generated session context
 * has a generation and must not be mistaken for new input. Select the newest
 * eligible person comment before checking its receipts: settling that input
 * must not revive older unmapped comments. */
export async function conversationOwedInputs(db: Pick<Db, "select">, companyId: string, issueIds: string[]) {
  if (!issueIds.length) return new Map<string, { commentId: string; createdAt: Date; deliveryOwner: boolean }>();
  const rows = await db.select({ issueId: issues.id, deliveryOwner: committedDeliveryOwner(),
    input: sql<{ id: string; createdAt: string } | null>`(select jsonb_build_object('id', person.id, 'createdAt', person.created_at)
      from (select person.* from issue_comments person
      where person.company_id = issues.company_id and person.issue_id = issues.id
        and person.author_user_id = issues.conversation_user_id and person.author_agent_id is null
        and coalesce(person.author_type, 'user') = 'user' and person.origin = 'comment'
        and person.deleted_at is null and person.conversation_session_generation is null
        and btrim(person.body) <> '/new'
        and (issues.conversation_boundary_comment_id is null or (person.created_at, person.id) >
          (select boundary.created_at, boundary.id from issue_comments boundary
            where boundary.company_id = issues.company_id and boundary.id = issues.conversation_boundary_comment_id))
      order by person.created_at desc, person.id desc limit 1) person
      where not exists (select 1 from issue_comments reply left join heartbeat_runs answer_run
          on answer_run.company_id = reply.company_id and answer_run.id = coalesce(reply.created_by_run_id, reply.derived_created_by_run_id)
          where reply.company_id = person.company_id and reply.issue_id = person.issue_id
            and reply.author_type = 'agent' and reply.deleted_at is null and btrim(reply.body) <> ''
            and reply.body <> 'Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).'
            and reply.created_at > person.created_at
            and (answer_run.id is null or answer_run.context_snapshot->>'conversationSessionGeneration' is null
              or answer_run.context_snapshot->>'conversationSessionGeneration' = issues.conversation_session_generation::text)
            and (case when jsonb_typeof(answer_run.result_json->'continuousReplies') = 'object'
                and answer_run.result_json->'continuousReplies' <> '{}'::jsonb then
              exists (select 1 from jsonb_each(answer_run.result_json->'continuousReplies') receipt
                where receipt.value->>'commentId' = reply.id::text and receipt.value->'questionCommentIds' ? person.id::text)
              else (not coalesce(answer_run.result_json ? 'presentationDecision', false)
                or answer_run.result_json#>>'{presentationDecision,commentId}' = reply.id::text) end)
            and not exists (select 1 from jsonb_each(case when jsonb_typeof(answer_run.result_json->'semanticToolReceipts') = 'object'
              then answer_run.result_json->'semanticToolReceipts' else '{}'::jsonb end) progress
              where progress.value->>'operationId' = 'report_progress' and progress.value#>>'{result,commentId}' = reply.id::text))
        and not exists (select 1 from heartbeat_runs stopped
          where stopped.company_id = person.company_id and stopped.agent_id = issues.assignee_agent_id
            and coalesce(stopped.native_issue_id::text, stopped.issue_id::text, stopped.context_snapshot->>'issueId') = person.issue_id::text
            and stopped.context_snapshot->>'conversationSessionGeneration' = issues.conversation_session_generation::text
            and coalesce(stopped.result_json#>'{personStop,returned}', '[]'::jsonb) ? person.id::text)
      )` }).from(issues).where(and(
    eq(issues.companyId, companyId), inArray(issues.id, issueIds),
    sql`${issues.conversationAgentId} is not null`, sql`${issues.status} not in ('done', 'cancelled')`,
  ));
  return new Map(rows.flatMap(row => row.input ? [[row.issueId, { commentId: row.input.id,
    createdAt: new Date(row.input.createdAt), deliveryOwner: row.deliveryOwner }]] : []));
}
