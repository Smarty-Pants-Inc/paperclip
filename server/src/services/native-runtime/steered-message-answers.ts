import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";

/** One durable run-log event, in persisted sequence order (heartbeat_run_events). */
export interface SteerAnswerEvent {
  seq: number;
  eventType: string;
  turnId?: string | null;
  itemId?: string | null;
  kind?: string | null;
  /** item.completed agentMessage only: the completed block carries non-empty text. */
  hasText?: boolean | null;
}

const STEER_ITEM = /:steer:(.+)$/;
/**
 * Projector kinds of a tool call's item.started (Pi: pi-event-projector.ts toolPayload,
 * "commandExecution" for bash, "tool" otherwise; Codex/OpenCode: mcpToolCall, dynamicToolCall,
 * fileChange, webSearch). tool.execution.started is the Pi execution of a call.
 */
const TOOL_KINDS = new Set(["commandExecution", "tool", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch"]);
const TURN_END = new Set(["turn.completed", "turn.cancelled", "turn.failed"]);

/**
 * The answered rule for steered person messages (never-OK, live on PV2 s3).
 * A steered message B is ANSWERED by its run only when the run log shows an assistant
 * TEXT item (kind agentMessage with completed non-empty text; never reasoning, never a
 * tool) that STARTED after B's delivery userMessage and before the next tool call
 * (item.started of a tool kind, or tool.execution.started) or the turn's end.
 *
 * Delivery is Pi's userMessage item.started, paired as the restart recovery pairs it
 * (steering-delivery.ts unreadSteeredMessageIds): a turn's first userMessage is its own
 * input and carries earlier turns' steers; each later userMessage of the turn delivers
 * the oldest undelivered steer of that turn (or one acknowledged right after it). Unlike
 * restart recovery, a completed turn is NOT a read: only a userMessage is. An
 * acknowledgement the log never recorded is never delivered, so never answered.
 * "Read" alone is not "answered": read, then a tool call with no text between, is NOT.
 */
export function steeredMessageAnswers(events: Iterable<SteerAnswerEvent>): {
  acknowledged: string[]; delivered: string[]; answered: string[];
} {
  const list = [...events].sort((a, b) => a.seq - b.seq);
  const acknowledged: string[] = [];
  const deliveredAt = new Map<string, number>();
  const pending: Array<{ id: string; turnId: string | null }> = [];
  const inputs = new Map<string | null, number>();
  const early = new Map<string | null, number[]>();
  // A text block's position is where it STARTED: Pi streams a tool call's item.started
  // before the assistant message ends and completes its text block.
  const textStart = new Map<string, number>();
  const texts: number[] = [];
  const boundaries: number[] = [];
  for (const event of list) {
    const turnId = event.turnId ?? null;
    if (event.eventType === "item.completed" && event.kind === "steering_acknowledgement") {
      const id = STEER_ITEM.exec(event.itemId ?? "")?.[1];
      if (!id || acknowledged.includes(id)) continue;
      acknowledged.push(id);
      const reads = early.get(turnId) ?? [];
      if (reads.length > 0) deliveredAt.set(id, reads.shift()!);
      else pending.push({ id, turnId });
    } else if (event.eventType === "item.started" && event.kind === "userMessage") {
      const count = (inputs.get(turnId) ?? 0) + 1;
      inputs.set(turnId, count);
      if (count === 1) {
        for (let index = pending.length - 1; index >= 0; index -= 1)
          if (pending[index]!.turnId !== turnId) deliveredAt.set(pending.splice(index, 1)[0]!.id, event.seq);
        continue;
      }
      const index = pending.findIndex((entry) => entry.turnId === turnId);
      if (index >= 0) deliveredAt.set(pending.splice(index, 1)[0]!.id, event.seq);
      else early.set(turnId, [...(early.get(turnId) ?? []), event.seq]);
    } else if (event.kind === "agentMessage" && (event.eventType === "item.started" || event.eventType === "item.completed")) {
      const key = event.itemId ?? `seq:${event.seq}`;
      if (!textStart.has(key)) textStart.set(key, event.seq);
      if (event.eventType === "item.completed" && event.hasText) texts.push(textStart.get(key)!);
    } else if (event.eventType === "tool.execution.started"
      || (event.eventType === "item.started" && TOOL_KINDS.has(event.kind ?? ""))
      || TURN_END.has(event.eventType)) {
      boundaries.push(event.seq);
    }
  }
  const answered = acknowledged.filter((id) => {
    const at = deliveredAt.get(id);
    if (at === undefined) return false;
    const end = boundaries.find((seq) => seq > at) ?? Number.POSITIVE_INFINITY;
    return texts.some((start) => start > at && start < end);
  });
  return { acknowledged, delivered: acknowledged.filter((id) => deliveredAt.has(id)), answered };
}

const kind = sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind'`;

/** The run's stored events the answered rule reads. Only events the native transport validated count. */
export async function readSteeredMessageAnswers(db: Db, input: { companyId: string; runId: string }) {
  const rows = await db.select({
    seq: heartbeatRunEvents.seq,
    eventType: heartbeatRunEvents.eventType,
    turnId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId'`,
    itemId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'itemId'`,
    kind,
    hasText: sql<boolean | null>`length(btrim(coalesce(${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'text', ''))) > 0`,
  }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, input.companyId),
    eq(heartbeatRunEvents.runId, input.runId),
    isNotNull(heartbeatRunEvents.sourceEventId),
    or(
      sql`${heartbeatRunEvents.eventType} in ('turn.completed', 'turn.cancelled', 'turn.failed', 'tool.execution.started')`,
      and(eq(heartbeatRunEvents.eventType, "item.completed"), sql`${kind} in ('steering_acknowledgement', 'agentMessage')`),
      and(eq(heartbeatRunEvents.eventType, "item.started"), sql`${kind} in ('userMessage', 'agentMessage', ${sql.join(
        [...TOOL_KINDS].map((value) => sql`${value}`), sql`, `)})`),
    ),
  )).orderBy(asc(heartbeatRunEvents.seq));
  return steeredMessageAnswers(rows.map((row) => ({ ...row, seq: Number(row.seq) })));
}
