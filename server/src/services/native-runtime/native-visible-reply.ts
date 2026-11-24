import { and, asc, eq, lte } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { completedPlanProposalIds, isBoundedRunEventText, nativeFinalReplyKey,
  readCompletedAssistantMessageCandidate, RUN_EVENT_TEXT_BOUND_MARKER,
  type CompletedFinalAgentMessageCandidate } from "../heartbeat-run-summary.js";

type Row = { seq: number; payload: unknown; eventType?: string };
type Scope = { runId: string; agentId?: string; normalizedSessionId?: string | null; turnId?: string | null;
  throughSeq?: number; finalEvent?: { seq: number; prpEvent: unknown } };
export type VisibleAssistantReply = CompletedFinalAgentMessageCandidate & { visibleText: true; reasonCode: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }

/** Keep streamed text if an empty, shortened or changed receipt cannot account for it. */
function settledText(delta: string, completed: string): string {
  if (!delta || completed.includes(delta)) return completed || delta;
  const preview = isBoundedRunEventText(completed) ? completed.slice(0, -RUN_EVENT_TEXT_BOUND_MARKER.length) : completed;
  if (!preview || delta.includes(preview)) return delta;
  return `${delta}\n\n${completed}`;
}

/** Compose only persisted display-safe assistant items, never tools or reasoning.
 * Each explicit final closes a segment even when several replies share a turn.
 * Deltas, completions and redactor output tails share the item's identity. */
export function composeNativeVisibleReply(rows: readonly Row[], scope: Scope): VisibleAssistantReply | null {
  const proposedItemIds = completedPlanProposalIds(rows);
  const seenSources = new Set<string>();
  let events = [...rows.map(row => ({ seq: row.seq, event: record(record(row.payload).prpEvent), eventType: row.eventType })),
    ...(scope.finalEvent ? [{ seq: scope.finalEvent.seq, event: record(scope.finalEvent.prpEvent), eventType: "item.completed" }] : [])]
    .sort((a, b) => a.seq - b.seq)
    .filter(({ seq, event, eventType }) => {
      if (event.eventType && eventType && event.eventType !== eventType) return false;
      if (event.schema !== undefined && event.schema !== "paperclip.prp.event.v1") return false;
      if (scope.throughSeq !== undefined && seq > scope.throughSeq) return false;
      if (event.runId !== undefined && event.runId !== scope.runId) return false;
      if (scope.normalizedSessionId && event.normalizedSessionId !== undefined && event.normalizedSessionId !== scope.normalizedSessionId) return false;
      const source = text(event.sourceEventId);
      if (source && seenSources.has(source)) return false;
      if (source) seenSources.add(source);
      return true;
    });
  // Disposition-only recovery must not replace the preceding visible work turn.
  const recovery = [...rows].sort((a, b) => a.seq - b.seq)
    .find(row => record(row.payload).retryReasonCode === "semantic_result_missing")?.seq;
  if (recovery !== undefined && events.some(({ seq, event }) => seq < recovery &&
      record(event.payload).channel === "final")) events = events.filter(({ seq }) => seq < recovery);
  const targetTurn = scope.turnId ?? text(record(scope.finalEvent?.prpEvent).turnId)
    ?? [...events].reverse().find(({ event, eventType }) =>
      ["item.started", "item.delta", "item.completed", "turn.started"].includes(text(event.eventType) ?? eventType ?? ""))?.event.turnId;
  if (targetTurn) events = events.filter(({ event }) => !event.turnId || event.turnId === targetTurn);

  type Item = { id: string; kind: string; channel: string; delta: string; completed: string;
    seq: number; sourceEventId: string | null; itemId: string | null };
  let items = new Map<string, Item>();
  const identities = new Map<string, { kind: string; channel: string }>();
  const closedItems = new Set<string>();
  let last: VisibleAssistantReply | null = null;
  const compose = (boundary?: Item): VisibleAssistantReply | null => {
    const visible = [...items.values()].flatMap(item => {
      const value = settledText(item.delta, item.completed);
      // Reuse the presentation boundary for recorded plan proposals.
      const candidate = readCompletedAssistantMessageCandidate({ seq: item.seq, proposedItemIds,
        prpEvent: { runId: scope.runId, itemId: item.itemId, sourceEventId: item.sourceEventId,
          payload: { kind: "agentMessage", channel: "final", text: value } } });
      if (!candidate) return [];
      try { if (record(JSON.parse(candidate.text)).schema === "paperclip.run_result.v1") return []; } catch { /* Prose is not JSON. */ }
      return [{ item, text: candidate.text }];
    });
    if (!visible.length) return null;
    const owner = boundary ?? visible[visible.length - 1]!.item;
    return { seq: owner.seq, text: visible.map(value => value.text).join("\n\n"),
      sourceEventId: owner.sourceEventId, channel: boundary?.channel === "unknown" ? "unknown" : "final",
      ...(owner.itemId ? { replyKey: nativeFinalReplyKey(scope.runId, owner.itemId) } : {}),
      visibleText: true, reasonCode: "visible_assistant_reply_segment" };
  };
  const observe = (seq: number, event: Record<string, unknown>, eventType: string) => {
    if (!["item.started", "item.delta", "item.completed"].includes(eventType)) return;
    const payload = record(event.payload), nested = record(payload.item);
    const itemId = text(event.itemId) ?? text(payload.itemId) ?? text(nested.id);
    const sourceEventId = text(event.sourceEventId);
    const id = itemId ?? sourceEventId ?? `event:${seq}`;
    if (closedItems.has(id)) return;
    const previous = identities.get(id);
    const kind = (text(payload.kind) ?? text(nested.kind) ?? text(nested.type) ?? previous?.kind ?? "").replaceAll("_", "").toLowerCase();
    const channel = text(payload.channel) ?? text(nested.channel) ?? text(record(payload.update).channel) ?? previous?.channel ?? "unknown";
    identities.set(id, { kind, channel });
    if (!["agentmessage", "assistantmessage"].includes(kind) || !["progress", "commentary", "final", "unknown"].includes(channel)) return;
    const value = text(payload.text) ?? text(nested.text) ?? "";
    const item = items.get(id) ?? { id, kind, channel, delta: "", completed: "", seq, sourceEventId, itemId };
    if (eventType !== "item.started") {
      if (eventType === "item.delta") item.delta += value;
      else item.completed = settledText(item.completed, value);
      item.seq = seq; item.sourceEventId = sourceEventId; item.channel = channel;
      items.set(id, item);
    }
    if (eventType === "item.completed" && channel === "final") {
      last = compose(item);
      for (const key of items.keys()) closedItems.add(key);
      items = new Map();
    }
  };
  for (const { seq, event, eventType: storedType } of events) {
    const eventType = text(event.eventType) ?? storedType ?? "item.completed";
    if (eventType === "turn.started") { items = new Map(); last = null; }
    const payload = record(event.payload);
    if (/^(item|turn|session)\.(completed|failed|cancelled|interrupted|closed)$/.test(eventType) && Array.isArray(payload.outputTails)) {
      payload.outputTails.forEach((raw, index) => {
        const tail = record(raw);
        observe(seq, { ...event, itemId: tail.itemId, sourceEventId: `${event.sourceEventId}:output-tail:${index}`, payload: tail.payload }, "item.delta");
      });
    }
    observe(seq, event, eventType);
  }
  return compose() ?? last;
}

/** Read the complete scoped stream, not a bounded set of completed finals.
 * Event ingestion already applies the transcript's trust/redaction boundary. */
export async function loadNativeVisibleReply(db: Db, scope: Scope & { companyId: string }): Promise<VisibleAssistantReply | null> {
  const rows = await db.select({ seq: heartbeatRunEvents.seq, payload: heartbeatRunEvents.payload, eventType: heartbeatRunEvents.eventType })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.runId),
      scope.agentId ? eq(heartbeatRunEvents.agentId, scope.agentId) : undefined,
      scope.throughSeq !== undefined ? lte(heartbeatRunEvents.seq, scope.throughSeq) : undefined)).orderBy(asc(heartbeatRunEvents.seq));
  return composeNativeVisibleReply(rows, scope);
}
