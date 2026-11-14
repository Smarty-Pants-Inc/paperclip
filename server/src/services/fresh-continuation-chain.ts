import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personCommentOriginSql } from "./person-input-origin.js";

type FreshContinuationChainInput = { companyId: string; issueId: string; runId: string };

function automaticChainParent(alias: string, issueId: string): SQL {
  const run = sql.identifier(alias);
  return sql`case when exists (
    select 1 from agent_wakeup_requests wake
    where wake.company_id = ${run}.company_id and wake.id = ${run}.wakeup_request_id
      and wake.run_id = ${run}.id and wake.requested_by_actor_type = 'user'
      and wake.requested_by_actor_id is not null
      and exists (select 1 from issue_comments message
        where message.company_id = ${run}.company_id and message.issue_id = ${issueId}
          and message.author_user_id = wake.requested_by_actor_id and ${personCommentOriginSql("message")}
          and message.metadata#>>'{inputOrigin,admittedRunId}' = ${run}.id::text
          and (message.id::text = ${run}.context_snapshot->>'wakeCommentId'
            or message.id::text = ${run}.context_snapshot->>'commentId'
            or coalesce(${run}.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? message.id::text)))
    or exists (select 1 from issue_recovery_actions receipt
      where receipt.company_id = ${run}.company_id and receipt.source_issue_id = ${issueId}
        and receipt.status = 'resolved'
        and receipt.evidence#>>'{explicitUserContinuation,runId}' = ${run}.id::text
        and nullif(receipt.evidence#>>'{explicitUserContinuation,actorId}', '') is not null
        and receipt.evidence#>'{explicitUserContinuation,automaticRetry}' is null
        and exists (select 1 from issue_comments message
          where message.company_id = ${run}.company_id and message.issue_id = ${issueId}
            and message.id::text = receipt.evidence#>>'{explicitUserContinuation,commentId}'
            and message.author_user_id = receipt.evidence#>>'{explicitUserContinuation,actorId}'
            and ${personCommentOriginSql("message")}
            and message.metadata#>>'{inputOrigin,admittedRunId}' = ${run}.id::text))
    then null else coalesce(${run}.retry_of_run_id::text, nullif(${run}.context_snapshot->>'previousRunId', ''),
      nullif(${run}.context_snapshot->>'retryOfRunId', '')) end`;
}

function freshContinuationSourceChain(input: FreshContinuationChainInput): SQL {
  const uuid = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
  return sql`with recursive source_chain as (
    select source.id, ${automaticChainParent("source", input.issueId)} as parent_id
    from heartbeat_runs source where source.company_id = ${input.companyId} and source.id = ${input.runId}
      and (source.issue_id = ${input.issueId} or source.native_issue_id = ${input.issueId}
        or source.context_snapshot->>'issueId' = ${input.issueId})
    union
    select parent.id, ${automaticChainParent("parent", input.issueId)}
    from heartbeat_runs parent join source_chain child
      on parent.id = case when child.parent_id ~ ${uuid} then child.parent_id::uuid end
    where parent.company_id = ${input.companyId}
      and (parent.issue_id = ${input.issueId} or parent.native_issue_id = ${input.issueId}
        or parent.context_snapshot->>'issueId' = ${input.issueId})
  )`;
}

export async function freshContinuationDescendsFrom(db: Db, input: FreshContinuationChainInput & { ancestorRunId: string }) {
  const [result] = await db.execute<{ related: boolean }>(sql`${freshContinuationSourceChain(input)}
    select exists (select 1 from source_chain where id::text = ${input.ancestorRunId}) as related`);
  return result?.related === true;
}

export async function freshContinuationChain(db: Db, input: FreshContinuationChainInput) {
  const [chain] = await db.execute<{ rootRunId: string; attempts: number }>(sql`${freshContinuationSourceChain(input)}
    select coalesce((select id::text from source_chain ancestor
      order by (parent_id is null or not exists (select 1 from source_chain parent where parent.id::text = ancestor.parent_id)) desc,
        id limit 1), ${input.runId}) as "rootRunId",
      (select count(*)::int from issue_recovery_actions action
        where action.company_id = ${input.companyId} and action.source_issue_id = ${input.issueId}
          and action.evidence#>>'{freshContinuation,sourceRunId}' in (select id::text from source_chain)) as attempts`);
  return chain!;
}
