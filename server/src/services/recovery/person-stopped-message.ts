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
