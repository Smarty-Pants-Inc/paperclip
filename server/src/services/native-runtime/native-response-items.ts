import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { completedPlanProposalIds, readCompletedAssistantMessageCandidate,
  readTruncatedCompletedAgentMessageItemId, readTruncatedCompletedAssistantMessageCandidate } from "../heartbeat-run-summary.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Expand only the already-authorized final-message presentation, never a
 * semantic summary or commentary. The selected final identifies its turn (and
 * excludes later disposition-only recovery turns). Publication holds the issue
 * lock and writes every item in the same transaction as its durable item key. */
export async function nativeResponseItems(db: Db, input: { companyId: string; runId: string; text: string }) {
  const rows = await db.select({ seq: heartbeatRunEvents.seq, eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRunEvents.runId, input.runId),
      sql`${heartbeatRunEvents.eventType} in ('item.completed', 'plan.proposed')`))
    .orderBy(asc(heartbeatRunEvents.seq));
  const proposedItemIds = completedPlanProposalIds(rows);
  const candidates = [];
  for (const row of rows) {
    const event = record(record(row.payload).prpEvent);
    if (row.eventType !== "item.completed") continue;
    const itemId = typeof event.itemId === "string" ? event.itemId : null;
    if (!itemId) continue;
    let candidate = readCompletedAssistantMessageCandidate({ seq: row.seq, prpEvent: event, proposedItemIds });
    if (!candidate && readTruncatedCompletedAgentMessageItemId(event)) {
      const deltaRows = await db.select({ seq: heartbeatRunEvents.seq, payload: heartbeatRunEvents.payload })
        .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId),
          eq(heartbeatRunEvents.runId, input.runId), eq(heartbeatRunEvents.eventType, "item.delta"),
          sql`${heartbeatRunEvents.payload} #>> '{prpEvent,itemId}' = ${itemId}`)).orderBy(asc(heartbeatRunEvents.seq));
      candidate = readTruncatedCompletedAssistantMessageCandidate({ seq: row.seq, prpEvent: event, deltaRows });
    }
    if (candidate?.channel === "final") candidates.push({ ...candidate, itemId, turnId: event.turnId });
  }
  const selected = candidates.findLast(candidate => candidate.text === input.text);
  if (!selected) return [];
  const items = new Map<string, { itemId: string; text: string }>();
  for (const candidate of candidates) {
    if (candidate.turnId === selected.turnId && candidate.seq <= selected.seq && !items.has(candidate.itemId))
      items.set(candidate.itemId, { itemId: candidate.itemId, text: candidate.text });
  }
  // answered-a6: within this ONE publication step, an earlier final that a later final of the
  // same step restates whole (strictly more) is not posted again. Nothing else changes: no item
  // is trimmed, merged or replaced; equal items are all kept (two questions, two answers).
  const kept = restatedEarlierFinalsDropped([...items.values()]);
  return kept.length > 1 ? kept : [];
}

const FENCE = /^\s*```/;

function normalisedProse(segment: string) {
  // Outside code only: paired ** emphasis, paired __ emphasis around non-identifier text, whitespace runs.
  return segment
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
    .replace(/(^|[^\w])__(?=\S)((?:(?!__).)*?[^\w](?:(?!__).)*?)(?<=\S)__(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ");
}

/** One line of prose -> its sentence units. Inline code spans are kept byte-exact (only their
 * backtick delimiters are left out of the comparison) and never split. */
function lineUnits(line: string): string[] {
  const units: string[] = [];
  let current = "", prose = "";
  const flushProse = () => { current += normalisedProse(prose); prose = ""; };
  const flushUnit = () => { flushProse(); const unit = current.trim(); if (unit) units.push(unit); current = ""; };
  for (let i = 0; i < line.length;) {
    if (line[i] === "`") {
      let ticks = 0;
      while (line[i + ticks] === "`") ticks++;
      const delimiter = "`".repeat(ticks);
      const close = line.indexOf(delimiter, i + ticks);
      if (close >= 0 && line[close + ticks] !== "`") {
        flushProse();
        current += line.slice(i + ticks, close);
        i = close + ticks;
        continue;
      }
      prose += delimiter; i += ticks; continue;
    }
    const char = line[i];
    prose += char; i++;
    if (/[.!?]/.test(char) && i < line.length && /\s/.test(line[i])) flushUnit();
  }
  flushUnit();
  return units;
}

/** A final item's units: each fenced code block (``` ... ```) is ONE unit, byte-exact; every
 * other line is split at sentence ends. */
export function finalItemUnits(text: string): Set<string> {
  const units = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      let end = i + 1;
      while (end < lines.length && !FENCE.test(lines[end])) end++;
      units.add(`\u0001${lines.slice(i, Math.min(end, lines.length - 1) + 1).join("\n")}`);
      i = end;
      continue;
    }
    for (const unit of lineUnits(lines[i])) units.add(unit);
  }
  return units;
}

/** Drop an EARLIER item only when a LATER item of the same step holds every one of its units
 * whole and at least one unit more (strict). The last item is never dropped, so every dropped
 * unit stays visible in a posted item. */
export function restatedEarlierFinalsDropped<T extends { text: string }>(items: T[]): T[] {
  const units = items.map(item => finalItemUnits(item.text));
  return items.filter((_, index) => !units.slice(index + 1).some(later =>
    later.size > units[index].size && [...units[index]].every(unit => later.has(unit))));
}
