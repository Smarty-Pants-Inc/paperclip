import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";

/** One durable run-log event, in persisted sequence order (heartbeat_run_events). */
export interface SteerAnswerEvent {
  seq: number;
  eventType: string;
  turnId?: string | null;
  itemId?: string | null;
  kind?: string | null;
  /** item.completed agentMessage only: the completed block carries non-empty text. */
  hasText?: boolean | null;
  /** Canonical PRP channel; the Codex facade preserves phase as providerPhase. */
  channel?: string | null;
  providerPhase?: string | null;
  /** Durable pre-RPC custody, not a provider ACK. Never binds a prior read. */
  reservation?: boolean;
}

/** A text item's evidence: where its item.started was, and whether it completed with non-empty text. */
interface TextItem {
  start?: number;
  completedAt?: number;
  /** Progress text (Pi: text before a tool call; Codex: commentary): posted only as a steer's answer. */
  progress?: boolean;
}

const STEER_ITEM = /:steer:(.+)$/;
const TURN_END = new Set(["turn.completed", "turn.cancelled", "turn.failed"]);

/**
 * The answered rule for steered person messages (never-OK, live on PV2 s3).
 * A steered message B is ANSWERED by its run only when the run log shows an assistant
 * text item (kind agentMessage, channel final, or the progress text it wrote before its next tool; never reasoning or
 * a tool) with a real item.started
 * after B's delivery userMessage and before that turn's end, whose same item then
 * COMPLETED (item.completed) with non-empty text in that window. Tool calls do not
 * close the window: every later model request in the Pi session contains B in its
 * history. A turn.failed or turn.cancelled terminal invalidates that turn's text.
 *
 * Start evidence is required (rf5 F1). The Pi projector (pi-event-projector.ts) emits a
 * streamed text block's item.started at its first text_start/text_delta, i.e. where the
 * text began, and its item.completed only at message_end. A receipt whose text was never
 * streamed (final-only) projects ONLY item.completed: nothing records when that text
 * began relative to B's read, so it is never an answer (B is carried: a possible
 * duplicate, never a loss). A text item that ended item.failed (Pi stopReason error or
 * aborted, rf5 F2) is not durable text and does not answer either.
 *
 * Delivery is Pi's userMessage item.started, paired as the restart recovery pairs it
 * (steering-delivery.ts unreadSteeredMessageIds): a turn's first userMessage is its own
 * input and carries earlier turns' steers; each later userMessage of the turn delivers
 * the oldest undelivered steer of that turn (or one acknowledged right after it). Unlike
 * restart recovery, a completed turn is NOT a read: only a userMessage is. An
 * acknowledgement the log never recorded is never delivered, so never answered.
 * "Read" alone is not "answered": read, then tools with no text before turn end, is NOT.
 */
export function steeredMessageAnswers(events: Iterable<SteerAnswerEvent>): {
  acknowledged: string[]; delivered: string[]; answered: string[];
  deliveredEventSeqs: Record<string, number>;
  /** Progress text items that are a delivered steer's FIRST text: the answer the person must see (posted before the final). */
  answerItemIds: string[];
} {
  const list = [...events].sort((a, b) => a.seq - b.seq);
  const acknowledged: string[] = [];
  const deliveredAt = new Map<string, number>();
  const pending: Array<{ id: string; turnId: string | null }> = [];
  const inputs = new Map<string | null, number>();
  const early = new Map<string | null, number[]>();
  // A text block's position is where it STARTED: Pi streams a tool call's item.started
  // before the assistant message ends and completes its text block. Only a real
  // item.started places it; a completion never invents a start.
  const textItems = new Map<string, TextItem>();
  const boundaries: Array<{ seq: number; eventType: string }> = [];
  for (const event of list) {
    const turnId = event.turnId ?? null;
    if (event.eventType === "item.completed" && event.kind === "steering_acknowledgement") {
      const id = STEER_ITEM.exec(event.itemId ?? "")?.[1];
      if (!id || acknowledged.includes(id)) continue;
      acknowledged.push(id);
      const reads = early.get(turnId) ?? [];
      if (!event.reservation && reads.length > 0) deliveredAt.set(id, reads.shift()!);
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
      // An item with no id cannot be matched to its start, so it is never evidence.
      if (!event.itemId) continue;
      const item = textItems.get(event.itemId) ?? {};
      textItems.set(event.itemId, item);
      if (event.eventType === "item.started") item.start ??= event.seq;
      else if (event.hasText && item.start !== undefined && (event.channel === "progress"
        || (event.channel === "final" && event.providerPhase !== "commentary"))) {
        item.completedAt = event.seq;
        item.progress = event.channel === "progress";
      }
    } else if (TURN_END.has(event.eventType)) {
      boundaries.push({ seq: event.seq, eventType: event.eventType });
    }
  }
  // A steer's answer is the FIRST completed text the model wrote after reading it, in that turn. A
  // progress answer ("101", then the next tool) is posted as its own reply (native-response-items.ts);
  // whether the steer counts as answered is then decided by the posted reply (person-message-answer.ts).
  const answerItemIds = new Set<string>();
  const answered = acknowledged.filter((id) => {
    const at = deliveredAt.get(id);
    if (at === undefined) return false;
    const terminal = boundaries.find(({ seq }) => seq > at);
    if (terminal && terminal.eventType !== "turn.completed") return false;
    const end = terminal?.seq ?? Number.POSITIVE_INFINITY;
    const answer = [...textItems.entries()].filter(([, item]) => item.start !== undefined && item.start > at && item.start < end
      && item.completedAt !== undefined && item.completedAt < end).sort(([, a], [, b]) => a.start! - b.start!)[0];
    if (answer?.[1].progress) answerItemIds.add(answer[0]);
    return answer !== undefined;
  });
  return { acknowledged, delivered: acknowledged.filter((id) => deliveredAt.has(id)), answered,
    deliveredEventSeqs: Object.fromEntries(deliveredAt), answerItemIds: [...answerItemIds] };
}

const kind = sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind'`;

/** Materialize the SAME evidence at the event boundary, not just at run end.
 * The one answeredPersonMessageSql reader then works during streaming too.
 * A native ack only names an input; Pi's userMessage is the delivery proof.
 */
export async function recordSteeredMessageEvidence(db: Db, input: { companyId: string; runId: string }) {
  await db.transaction(async tx => {
    const [run] = await tx.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
    const context = run?.context ?? {};
    const steered = Array.isArray(context.steeredCommentIds) ? context.steeredCommentIds.filter((id): id is string => typeof id === "string") : [];
    if (!steered.length) return;
    const evidence = await readSteeredMessageAnswers(tx as unknown as Db, input);
    // Replace this run's projection, never union it: a failed/cancelled terminal
    // can invalidate text that was already materialized as answered while streaming.
    await tx.update(heartbeatRuns).set({ contextSnapshot: { ...context,
      answeredSteeredCommentIds: evidence.answered.filter(id => steered.includes(id)),
      steeredDeliveryEventSeqs: Object.fromEntries(Object.entries(evidence.deliveredEventSeqs).filter(([id]) => steered.includes(id))),
      steeredDeliveredAts: Object.fromEntries(Object.entries(evidence.deliveredAts).filter(([id]) => steered.includes(id))),
    } }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  });
}

/** The run's stored events the answered rule reads. Only events the native transport validated count. */
export async function readSteeredMessageAnswers(db: Db, input: { companyId: string; runId: string }) {
  const rows = await db.select({
    seq: heartbeatRunEvents.seq,
    createdAt: heartbeatRunEvents.createdAt,
    emittedAt: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'emittedAt'`,
    eventType: heartbeatRunEvents.eventType,
    turnId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId'`,
    itemId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'itemId'`,
    kind,
    channel: sql<string | null>`${heartbeatRunEvents.payload} #>> '{prpEvent,payload,channel}'`,
    providerPhase: sql<string | null>`${heartbeatRunEvents.payload} #>> '{prpEvent,payload,providerPhase}'`,
    hasText: sql<boolean | null>`length(btrim(coalesce(${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'text', ''))) > 0`,
  }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, input.companyId),
    eq(heartbeatRunEvents.runId, input.runId),
    isNotNull(heartbeatRunEvents.sourceEventId),
    or(
      sql`${heartbeatRunEvents.eventType} in ('turn.completed', 'turn.cancelled', 'turn.failed')`,
      and(eq(heartbeatRunEvents.eventType, "item.completed"), sql`${kind} in ('steering_acknowledgement', 'agentMessage')`),
      and(eq(heartbeatRunEvents.eventType, "item.started"), sql`${kind} in ('userMessage', 'agentMessage')`),
    ),
  )).orderBy(asc(heartbeatRunEvents.seq));
  // A real Pi can read and answer M before the RPC ACK returns (or after its
  // timeout). Its saved pending receipt already names M and its accepted turn.
  // Seed that custody at its actual admission boundary, never an earlier read;
  // delivery and answer still require the SAME persisted Pi read/text facts.
  const [run] = await db.select({ context: heartbeatRuns.contextSnapshot, result: heartbeatRuns.resultJson })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const steered = Array.isArray(run?.context?.steeredCommentIds) ? run.context.steeredCommentIds : [];
  const receipts = run?.result?.queuedSteeringAcknowledgements;
  const reservations: SteerAnswerEvent[] = [];
  for (const id of steered) {
    if (typeof id !== "string" || !receipts || typeof receipts !== "object" || Array.isArray(receipts)) continue;
    const receipt = (receipts as Record<string, unknown>)[id];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) continue;
    const ack = receipt as Record<string, unknown>;
    if (ack.status !== "pending" || typeof ack.turnId !== "string" || typeof ack.acknowledgedAt !== "string"
      || rows.some(row => row.kind === "steering_acknowledgement" && STEER_ITEM.exec(row.itemId ?? "")?.[1] === id)) continue;
    const admittedAt = Date.parse(ack.acknowledgedAt);
    const next = rows.find(row => Number.isFinite(admittedAt) && Date.parse(row.emittedAt ?? "") >= admittedAt);
    if (!next) continue;
    reservations.push({ seq: Number(next.seq) - 0.5, eventType: "item.completed", kind: "steering_acknowledgement",
      itemId: `${ack.turnId}:steer:${id}`, turnId: ack.turnId, reservation: true });
  }
  const evidence = steeredMessageAnswers([...rows.map((row) => ({ ...row, seq: Number(row.seq) })), ...reservations]);
  const times = new Map(rows.map(row => [Number(row.seq), row.createdAt.toISOString()]));
  return { ...evidence, deliveredAts: Object.fromEntries(Object.entries(evidence.deliveredEventSeqs)
    .map(([id, seq]) => [id, times.get(seq)]).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
}
