import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

type FreshContinuationChainInput = { companyId: string; issueId: string; runId: string };
type SqlChainInput = { [K in keyof FreshContinuationChainInput]: string | SQL };

function automaticChainParent(alias: string, issueId: string | SQL): SQL {
  const run = sql.identifier(alias);
  return sql`case when exists (
    select 1 from agent_wakeup_requests wake
    where wake.company_id = ${run}.company_id and wake.id = ${run}.wakeup_request_id
      and wake.run_id = ${run}.id and wake.requested_by_actor_type = 'user'
      and wake.requested_by_actor_id is not null
      and (jsonb_typeof(${run}.context_snapshot->'explicitUserContinuation') = 'object'
        or exists (select 1 from issue_comments message
          where message.company_id = ${run}.company_id and message.issue_id = ${issueId}
            and message.author_type = 'user' and message.author_user_id = wake.requested_by_actor_id
            and message.created_by_run_id is null
            and (message.id::text = ${run}.context_snapshot->>'wakeCommentId'
              or message.id::text = ${run}.context_snapshot->>'commentId'
              or coalesce(${run}.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? message.id::text))))
    or exists (select 1 from issue_recovery_actions receipt
      where receipt.company_id = ${run}.company_id and receipt.source_issue_id = ${issueId}
        and receipt.status = 'resolved'
        and receipt.evidence#>>'{explicitUserContinuation,runId}' = ${run}.id::text
        and nullif(receipt.evidence#>>'{explicitUserContinuation,actorId}', '') is not null
        and receipt.evidence#>'{explicitUserContinuation,automaticRetry}' is null)
    then null else coalesce(${run}.retry_of_run_id::text, nullif(${run}.context_snapshot->>'previousRunId', ''),
      nullif(${run}.context_snapshot->>'retryOfRunId', '')) end`;
}

/** Shared ancestry for answer attribution and automatic recovery. Answer resumes
 * and materialized status continuations are input edges, not fresh retry
 * attempts; only answer attribution opts in, preserving the retry budget. */
export function freshContinuationSourceChainSql(input: SqlChainInput, includeAnswerLineage = false): SQL {
  const uuid = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
  const answerParents = (alias: string): SQL => {
    if (!includeAnswerLineage) return sql`array[]::uuid[]`;
    const run = sql.identifier(alias);
    return sql`array(select distinct q.source_run_id from issue_thread_interactions q
      join heartbeat_runs asking on asking.id = q.source_run_id and asking.company_id = q.company_id
        and asking.agent_id = q.created_by_agent_id
      where q.company_id = ${input.companyId} and q.issue_id = ${input.issueId} and q.status = 'answered'
        and (q.id::text = ${run}.context_snapshot->>'interactionId'
          or exists (select 1 from issue_question_response_deliveries delivery
            where delivery.company_id = q.company_id and delivery.issue_id = q.issue_id
              and delivery.interaction_id = q.id and delivery.target_run_id = ${run}.id))
      union
      select decision.run_id from agent_wakeup_requests wake
        join status_decision_effects effect on effect.company_id = wake.company_id
          and effect.target_type = 'agent_wakeup_request' and effect.target_id = wake.id::text
          and effect.effect_kind in ('enqueue_continuation', 'schedule_retry')
        join status_decisions decision on decision.id = effect.decision_id
          and decision.company_id = effect.company_id and decision.issue_id = effect.issue_id
          and decision.application_state = 'applied'
      where wake.company_id = ${input.companyId} and decision.issue_id = ${input.issueId}
        and wake.agent_id = ${run}.agent_id and wake.run_id = ${run}.id
        and (wake.id = ${run}.wakeup_request_id
          or wake.id::text = ${run}.context_snapshot->>'nativeStatusWakeIntentId')
      order by 1)`;
  };
  return sql`with recursive source_chain as (
    select source.id, ${automaticChainParent("source", input.issueId)} as parent_id,
      ${answerParents("source")} as answer_parent_ids
    from heartbeat_runs source where source.company_id = ${input.companyId} and source.id = ${input.runId}
      and (source.issue_id = ${input.issueId} or source.native_issue_id = ${input.issueId}
        or source.context_snapshot->>'issueId' = ${input.issueId}::text)
    union
    select parent.id, ${automaticChainParent("parent", input.issueId)}, ${answerParents("parent")}
    from source_chain child
      cross join lateral unnest(child.answer_parent_ids || array[
        case when child.parent_id ~ ${uuid} then child.parent_id::uuid end]) edge(parent_id)
      join heartbeat_runs parent on parent.id = edge.parent_id
    where parent.company_id = ${input.companyId}
      and (parent.issue_id = ${input.issueId} or parent.native_issue_id = ${input.issueId}
        or parent.context_snapshot->>'issueId' = ${input.issueId}::text)
  )`;
}

export async function freshContinuationDescendsFrom(db: Db, input: FreshContinuationChainInput & {
  ancestorRunId: string; includeAnswerLineage?: boolean;
}) {
  const [result] = await db.execute<{ related: boolean }>(sql`${freshContinuationSourceChainSql(input, input.includeAnswerLineage)}
    select exists (select 1 from source_chain where id::text = ${input.ancestorRunId}) as related`);
  return result?.related === true;
}

export async function freshContinuationChain(db: Db, input: FreshContinuationChainInput) {
  const [chain] = await db.execute<{ rootRunId: string; attempts: number }>(sql`${freshContinuationSourceChainSql(input)}
    select coalesce((select id::text from source_chain ancestor
      order by (parent_id is null or not exists (select 1 from source_chain parent where parent.id::text = ancestor.parent_id)) desc,
        id limit 1), ${input.runId}) as "rootRunId",
      (select count(*)::int from issue_recovery_actions action
        where action.company_id = ${input.companyId} and action.source_issue_id = ${input.issueId}
          and action.evidence#>>'{freshContinuation,sourceRunId}' in (select id::text from source_chain)) as attempts`);
  return chain!;
}
