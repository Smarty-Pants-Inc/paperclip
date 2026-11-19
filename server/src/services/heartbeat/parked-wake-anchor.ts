import { sql, type SQLWrapper } from "drizzle-orm";
import { agentWakeupRequests } from "@paperclipai/db";

/**
 * S124/S124d pure helpers (no service imports, so the low-level writers such
 * as deferred-execution-wait.ts can anchor a park without an import cycle).
 * The deadline, note and scan live in parked-wake-deadline.ts.
 */
export type Payload = Record<string, unknown> | null | undefined;
/**
 * The executionWait reasons the person controls, by writer:
 * - "agent.not_invokable": the person's own agent pause (heartbeat/queue.ts
 *   enqueueWakeup invokability refusal, saveDeferredMessage/writeSkippedRequest).
 * - "budget.blocked": a budget limit (heartbeat/queue.ts budget refusal, same writers).
 * Nothing else: a wait the person cannot end is never left silent.
 */
export const PERSON_CONTROLLED_WAIT_REASONS = ["agent.not_invokable", "budget.blocked"] as const;

/** The wake waits on a person-controlled named wait (unbounded by S124). */
export function personControlledWait(payload: Payload) {
  const wait = payload?.executionWait;
  if (!wait || typeof wait !== "object" || Array.isArray(wait)) return false;
  return (PERSON_CONTROLLED_WAIT_REASONS as readonly string[]).includes(String((wait as Record<string, unknown>).reason ?? ""));
}

/** SQL twin of personControlledWait over a wake payload column. */
export function personControlledWaitSql(payload: SQLWrapper) {
  return sql<boolean>`(coalesce(${payload}->'executionWait'->>'reason', '') in (${sql.join(
    PERSON_CONTROLLED_WAIT_REASONS.map(reason => sql`${reason}`), sql`, `)}))`;
}
/**
 * S124d (RFL): the bounded population is EVERY Stop/Send deferred receipt, not
 * only one with queuedCommentInterrupt: a person's saved message held by any
 * executionWait (remote_cleanup, interrupt_handoff, controller_settling, ...)
 * is the same silent park. Only the two person-controlled waits are exempt.
 * A non-QCI receipt is anchored only when a person sent it (actorType "user");
 * the stored anchor is then the gate for every payload-only read below.
 */
export function parkedWakePayload(payload: Payload) {
  if (!payload || personControlledWait(payload)) return false;
  const wait = payload.executionWait;
  return Boolean(payload.queuedCommentInterrupt) || Boolean(wait && typeof wait === "object" && !Array.isArray(wait));
}

/** A person's saved Send (not a task Retry press, which has its own receipt path). */
export function personSend(actorType: string | null | undefined, reason: string | null | undefined) {
  return actorType === "user" && reason !== "task_retry";
}

/** SQL twin of personSend over the agent_wakeup_requests row being read or written. */
export function personSendSql() {
  return sql<boolean>`(coalesce(${agentWakeupRequests.requestedByActorType}, '') = 'user'
    and coalesce(${agentWakeupRequests.reason}, '') <> 'task_retry')`;
}

/** The wake is in the bounded population (JS twin of parkedWakeSql with a person predicate). */
export function parkedWake(payload: Payload, wake: { actorType: string | null | undefined; reason: string | null | undefined }) {
  return parkedWakePayload(payload) && (Boolean(payload?.queuedCommentInterrupt) || personSend(wake.actorType, wake.reason));
}

/** SQL twin: a QCI Send, or (given personSendSql()) a person's executionWait Send receipt. */
export function parkedWakeSql(payload: SQLWrapper, person?: SQLWrapper) {
  return sql<boolean>`((${payload}->'queuedCommentInterrupt' is not null
    or (jsonb_typeof(${payload}->'executionWait') = 'object'${person ? sql` and ${person}` : sql``}))
    and not ${personControlledWaitSql(payload)})`;
}

function pressedAt(payload: Payload): number | null {
  const press = payload?.queuedCommentInterrupt;
  if (!press || typeof press !== "object" || Array.isArray(press)) return null;
  const at = Date.parse(String((press as Record<string, unknown>).requestedAt ?? ""));
  return Number.isFinite(at) ? at : null;
}

/** The current park's anchor (ms), or null when it has none yet or the stored
 * one belongs to an earlier press. */
export function parkedWakeAnchor(payload: Payload): number | null {
  if (!parkedWakePayload(payload)) return null;
  const anchor = Date.parse(String(payload?.firstParkedAt ?? ""));
  if (!Number.isFinite(anchor)) return null;
  const press = pressedAt(payload);
  return press !== null && press > anchor ? null : anchor;
}

/** The current park has no anchor yet (none stored, or a newer press). */
export function parkedWakeNeedsAnchorSql(payload: SQLWrapper, person?: SQLWrapper) {
  return sql<boolean>`(${parkedWakeSql(payload, person)}
    and (${payload}->>'firstParkedAt' is null
      or coalesce(${payload}->'queuedCommentInterrupt'->>'requestedAt', '') > ${payload}->>'firstParkedAt'))`;
}

/**
 * SET expression: store the park's FIRST time once. In an UPDATE the row's
 * updated_at here is the value before this write, i.e. the park (or the last
 * edit) before the first retry rewrites it; never earlier than the press.
 * A stored anchor of the current press is never overwritten.
 */
export function anchorParkedWakePayloadSql(payload: SQLWrapper, updatedAt: SQLWrapper, person?: SQLWrapper) {
  const press = sql`${payload}->'queuedCommentInterrupt'->>'requestedAt'`;
  return sql`case when ${personControlledWaitSql(payload)} then ${payload} - 'firstParkedAt' - 'parkedNoticeAt'
    when ${parkedWakeNeedsAnchorSql(payload, person)} then (${payload} - 'parkedNoticeAt') || jsonb_build_object('firstParkedAt',
    to_char(greatest(${updatedAt}, case when ${press} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' then (${press})::timestamptz end)
      at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    else ${payload} end`;
}
