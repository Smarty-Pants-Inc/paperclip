import { and, asc, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { unreadSteeredMessageIds } from "../../vendor/paperclip-runner/index.js";
import { hasRecordedUserStopRequest } from "../acknowledged-native-stop.js";

/**
 * A person's Stop (POST /heartbeat-runs/:runId/cancel, routes/agents.ts) and a
 * person's Interrupt (operatorInterruptCancelOptions, routes/issues.ts) end the
 * run as status "cancelled" with errorCode "cancelled" or
 * "operator_interrupted", and record cancelledByActorType "user" with the
 * person's cancelledByUserId (run-control.ts cancelRun). A stop by another
 * board user, a managing agent (actor type "agent"), the system or a watchdog
 * (no user attribution), a pause (agent_paused) or a stop the system converted
 * to "failed" is not the sender's own stop.
 */
const PERSON_STOP_ERROR_CODES = new Set(["cancelled", "operator_interrupted"]);

type StoppedRun = { status: string; errorCode: string | null; resultJson: Record<string, unknown> | null;
  contextSnapshot: unknown };

/** The SENDER of the message stopped (or interrupted) this run themselves. */
export function stoppedBySender(run: StoppedRun, senderUserId: string | null): boolean {
  return Boolean(senderUserId) && run.status === "cancelled" && PERSON_STOP_ERROR_CODES.has(run.errorCode ?? "")
    && hasRecordedUserStopRequest(run) && run.resultJson?.cancelledByUserId === senderUserId;
}

/** The run's OWN first-turn input: its wake comment(s) and the comments it took
 * into its first turn. A steer, a message queued behind it or one delivered
 * after the stop is not here. */
export function runOwnInputIds(contextSnapshot: unknown): string[] {
  const context = (contextSnapshot ?? {}) as Record<string, unknown>;
  const firstTurn = (context.firstTurnQueuedInput ?? {}) as Record<string, unknown>;
  return [context.wakeCommentId, ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
    ...(Array.isArray(firstTurn.commentIds) ? firstTurn.commentIds : [])]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

const kind = sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind'`;

/**
 * The run had STARTED answering this message: the message is the run's own
 * input, the model read the first turn's input (a validated item.started
 * userMessage) and the agent started an assistant item after it. A message the
 * run carried but had not read (an unread steer) is not.
 */
export async function runStartedAnswering(db: Db, input: { companyId: string; runId: string; messageId: string;
  contextSnapshot: unknown }): Promise<boolean> {
  if (!runOwnInputIds(input.contextSnapshot).includes(input.messageId)) return false;
  const rows = await db.select({ seq: heartbeatRunEvents.seq, eventType: heartbeatRunEvents.eventType, kind,
    turnId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId'`,
    itemId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'itemId'` })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRunEvents.runId, input.runId), isNotNull(heartbeatRunEvents.sourceEventId),
      or(eq(heartbeatRunEvents.eventType, "item.started"), eq(heartbeatRunEvents.eventType, "turn.completed"),
        and(eq(heartbeatRunEvents.eventType, "item.completed"), sql`${kind} = 'steering_acknowledgement'`)) as SQL))
    .orderBy(asc(heartbeatRunEvents.seq));
  if (unreadSteeredMessageIds(rows).includes(input.messageId)) return false;
  const read = rows.find(row => row.eventType === "item.started" && row.kind === "userMessage");
  return Boolean(read && rows.some(row => row.eventType === "item.started" && row.seq > read.seq
    && row.kind && row.kind !== "userMessage"));
}

/** The durable held-list state (routes/issues.ts buildQueuedCommentQueue):
 * a chat's last turn was stopped by a person, there is no active turn, and
 * its plain-message queue head is deferred without a different execution wait.
 * The whole list, including separate wakes behind /new, awaits the person's
 * Send. Send records queuedCommentInterrupt before admission; consuming or
 * deleting a message removes it from this predicate. Native and legacy share
 * this queue state; neither a recovery incident nor a clock is its authority. */
export function personHeldChatMessageSql(m: { id: SQL; companyId: SQL; issueId: SQL }): SQL {
  return sql`exists (select 1 from issues held_issue
    join lateral (select r.status, r.result_json from heartbeat_runs r
      where r.company_id = held_issue.company_id and r.agent_id = held_issue.conversation_agent_id
        and r.context_snapshot->>'issueId' = held_issue.id::text
      order by r.created_at desc, r.id desc limit 1) stopped on true
    join lateral (select w.status, w.payload from agent_wakeup_requests w
      where w.company_id = held_issue.company_id and w.agent_id = held_issue.assignee_agent_id
        and w.payload->>'issueId' = held_issue.id::text
        and w.payload->>'interactionId' is null
        and (w.status = 'deferred_issue_execution' or (w.status = 'queued' and exists (
          select 1 from heartbeat_runs qr where qr.company_id = w.company_id and qr.agent_id = w.agent_id
            and qr.id = w.run_id and qr.wakeup_request_id = w.id and qr.status = 'queued')))
        and exists (select 1 from issue_comments c where c.company_id = held_issue.company_id
          and c.issue_id = held_issue.id and c.author_type = 'user' and c.deleted_at is null
          and coalesce(w.payload->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? c.id::text)
      order by w.requested_at asc limit 1) head on true
    where held_issue.company_id = ${m.companyId} and held_issue.id = ${m.issueId}
      and held_issue.conversation_agent_id = held_issue.assignee_agent_id and held_issue.assignee_user_id is null
      and stopped.status = 'cancelled' and stopped.result_json->>'cancelledByActorType' = 'user'
      and coalesce(stopped.result_json->>'queuedCommentInterruptQueueId', '') = ''
      and head.status = 'deferred_issue_execution' and head.payload->>'queuedCommentInterrupt' is null
      and not (coalesce(jsonb_typeof(head.payload->'executionWait'->'reason') = 'string', false)
        and coalesce(jsonb_typeof(head.payload->'executionWait'->'message') = 'string', false))
      and not exists (select 1 from heartbeat_runs active where active.company_id = held_issue.company_id
        and active.agent_id = held_issue.assignee_agent_id and active.status = 'running'
        and (active.id = held_issue.execution_run_id or active.context_snapshot->>'issueId' = held_issue.id::text))
      and exists (select 1 from agent_wakeup_requests held where held.company_id = held_issue.company_id
        and held.agent_id = held_issue.assignee_agent_id and held.payload->>'issueId' = held_issue.id::text
        and held.status in ('deferred_issue_execution', 'queued') and held.payload->>'interactionId' is null
        and held.payload->>'queuedCommentInterrupt' is null
        and coalesce(held.payload->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text))`;
}

/** SQL: a cancelled run on the issue that the message's sender stopped and that
 * carried the message as its own input (discovery only; the decision decides). */
export function personStoppedCarrierSql(m: { id: SQL; companyId: SQL; issueId: SQL; authorUserId: SQL }): SQL {
  return sql`exists (select 1 from heartbeat_runs r where r.company_id = ${m.companyId} and r.native_issue_id = ${m.issueId}
    and r.status = 'cancelled' and r.error_code in ('cancelled', 'operator_interrupted')
    and r.result_json->>'cancelledByActorType' = 'user' and r.result_json->>'cancelledByUserId' = ${m.authorUserId}
    and (r.context_snapshot->>'wakeCommentId' = ${m.id}::text
      or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text
      or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${m.id}::text))`;
}
