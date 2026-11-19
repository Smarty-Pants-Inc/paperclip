import { and, asc, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { unreadSteeredMessageIds } from "../../vendor/paperclip-runner/index.js";
import { hasRecordedUserStopRequest } from "../acknowledged-native-stop.js";

/**
 * A person's Stop (POST /heartbeat-runs/:runId/cancel, routes/agents.ts) and a
 * person's Interrupt (routes/issues.ts) end the run as status "cancelled" with
 * errorCode "cancelled" or "operator_interrupted", and record
 * cancelledByActorType "user" with the person's cancelledByUserId (the cancel
 * actor the routes pass to run-control's cancelRun; read by upstream's
 * hasRecordedUserStopRequest, acknowledged-native-stop.ts). A stop by another
 * board user, a managing agent (actor type "agent"), the system or a watchdog
 * (no user attribution), a pause (agent_paused), a timeout or a stop the
 * system converted to "failed" is not the sender's own stop.
 */
const PERSON_STOP_ERROR_CODES = new Set(["cancelled", "operator_interrupted"]);

type StoppedRun = { status: string; errorCode: string | null; resultJson: Record<string, unknown> | null;
  contextSnapshot: unknown };

/** The SENDER of the message stopped (or interrupted) this run themselves. */
export function stoppedBySender(run: StoppedRun, senderUserId: string | null): boolean {
  return Boolean(senderUserId) && run.status === "cancelled" && PERSON_STOP_ERROR_CODES.has(run.errorCode ?? "")
    && hasRecordedUserStopRequest(run) && run.resultJson?.cancelledByUserId === senderUserId;
}

/** When the person pressed Stop, from the Stop's OWN record (run-control.ts cancelRun writes
 * resultJson.executionCancellation { state: "requested", requestedAt } at :1478-1490, or startupCancellation.requestedAt
 * for a run stopped before it started; an acknowledged stop keeps acknowledgedAt). Null when the run has no such record. */
export function recordedStopRequestedAt(resultJson: Record<string, unknown> | null | undefined): Date | null {
  const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const execution = object(resultJson?.executionCancellation), startup = object(resultJson?.startupCancellation);
  for (const value of [execution.requestedAt, startup.requestedAt, execution.acknowledgedAt]) {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(at)) return new Date(at);
  }
  return null;
}

/** RFL-2 (RFL 01:05Z ruling on merged8): a card answer is covered by the answerer's own Stop of ANOTHER run (the
 * Stop's hold, STOP_HOLD_YIELDS_TO_SENDER_STOP) only when the answer already existed when they pressed Stop. An
 * answer given AFTER their Stop is not exempt by default: that Stop cannot have stopped a run answering it. (A Stop
 * of the run that WAS answering it is senderStoppedWhileAnswering, whenever the answer was given.) Order is read
 * from the two routes' own stamps: the answer's resolvedAt and the Stop's recorded request time. */
export function cardAnswerGivenBeforeStop(answeredAt: Date, stoppedRun: { resultJson: Record<string, unknown> | null }): boolean {
  const pressedAt = recordedStopRequestedAt(stoppedRun.resultJson);
  return Boolean(pressedAt && answeredAt.getTime() <= pressedAt.getTime());
}

/** The run's OWN first-turn input: its wake comment(s), the comments it took
 * into its first turn and the card answers it carried (interactionId(s)). A
 * steer, a message queued behind it or one delivered after the stop is not here. */
export function runOwnInputIds(contextSnapshot: unknown): string[] {
  const context = (contextSnapshot ?? {}) as Record<string, unknown>;
  const firstTurn = (context.firstTurnQueuedInput ?? {}) as Record<string, unknown>;
  return [context.wakeCommentId, ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
    ...(Array.isArray(firstTurn.commentIds) ? firstTurn.commentIds : []),
    context.interactionId, ...(Array.isArray(context.interactionIds) ? context.interactionIds : [])]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

const kind = sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind'`;

/**
 * The run had STARTED answering this message: the message is the run's own
 * input, the model read the first turn's input (a validated item.started
 * userMessage) and the agent started an assistant item after it. A message the
 * run carried but had not read (an unread steer) is not.
 */
export async function runStartedAnswering(db: Pick<Db, "select">, input: { companyId: string; runId: string; messageId: string;
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

/** The ONE sender-Stop rule (RFL ruling 8): the input's SENDER stopped this run AND the run had STARTED answering
 * it. The person's own Stop line is the one note: the input is not owed a notice and is not carried again. Never
 * one half alone: the unanswered-message sweep and the continuation carry both read this helper. `run` is the
 * newest run that carries the input as its own. */
export async function senderStoppedWhileAnswering(q: Pick<Db, "select">, companyId: string,
  run: { id: string; status: string; errorCode: string | null; resultJson: Record<string, unknown> | null;
    contextSnapshot: unknown } | undefined | null,
  message: { id: string; authorUserId?: string | null }): Promise<boolean> {
  if (!run || !message.authorUserId || !stoppedBySender(run, message.authorUserId)) return false;
  return runStartedAnswering(q, { companyId, runId: run.id, messageId: message.id, contextSnapshot: run.contextSnapshot });
}
