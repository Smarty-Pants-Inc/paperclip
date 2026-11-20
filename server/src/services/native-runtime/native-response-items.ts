import { and, asc, eq, sql } from "drizzle-orm";
import { fromMarkdown } from "mdast-util-from-markdown";
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

// answered-a7: fenced code is found by the CommonMark parser the UI's renderer already uses
// (react-markdown -> mdast-util-from-markdown@2.0.3), not by a hand lexer: ``` and ~~~ fences,
// any opener length >= 3, a closer of the SAME character at least as long with nothing after it.
const OPENER = /^ {0,3}(`{3,}|~{3,})/;
const CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const FENCE_LIKE = /^\s*(`{3,}|~{3,})/;

type Span = { start: number; end: number };
type MdNode = { type: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };

/** Each fenced code block of `text` as its exact source byte span. `ambiguous` is set when a
 * fence is unclosed (runs to the end of its container), the parse fails, or a fence-looking line
 * is left outside every parsed block: such an item is never dropped (never-lose). */
export function fencedCodeSpans(text: string): { spans: Span[]; ambiguous: boolean } {
  let tree: MdNode;
  try { tree = fromMarkdown(text) as MdNode; } catch { return { spans: [], ambiguous: true }; }
  const spans: Span[] = [];
  let ambiguous = false;
  const visit = (node: MdNode) => {
    if (node.type === "code") {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (typeof start !== "number" || typeof end !== "number") { ambiguous = true; return; }
      const source = text.slice(start, end);
      const opener = OPENER.exec(source);
      if (!opener) return; // indented code: not a fence, read as lines (as before)
      spans.push({ start, end });
      const lines = source.split("\n");
      const closer = lines.length > 1 ? CLOSER.exec(lines[lines.length - 1]) : null;
      if (!closer || closer[1][0] !== opener[1][0] || closer[1].length < opener[1].length) ambiguous = true;
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  spans.sort((a, b) => a.start - b.start);
  let at = 0;
  for (const span of [...spans, { start: text.length, end: text.length }]) {
    if (text.slice(at, span.start).split("\n").some(line => FENCE_LIKE.test(line))) ambiguous = true;
    at = span.end;
  }
  return { spans, ambiguous };
}

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

/** A final item's units: each fenced code block (CommonMark, ``` or ~~~) is ONE unit, its exact
 * source bytes; every other line is split at sentence ends. */
export function finalItemUnits(text: string): Set<string> {
  return finalItemParse(text).units;
}

function finalItemParse(text: string): { units: Set<string>; ambiguous: boolean } {
  const units = new Set<string>();
  const { spans, ambiguous } = fencedCodeSpans(text);
  const prose = (segment: string) => { for (const line of segment.split("\n")) for (const unit of lineUnits(line)) units.add(unit); };
  let at = 0;
  for (const span of spans) {
    prose(text.slice(at, span.start));
    units.add(`\u0001${text.slice(span.start, span.end)}`);
    at = span.end;
  }
  prose(text.slice(at));
  return { units, ambiguous };
}

/** Drop an EARLIER item only when a LATER item of the same step holds every one of its units
 * whole and at least one unit more (strict). The last item is never dropped, so every dropped
 * unit stays visible in a posted item. */
export function restatedEarlierFinalsDropped<T extends { text: string }>(items: T[]): T[] {
  const parsed = items.map(item => finalItemParse(item.text));
  const units = parsed.map(item => item.units);
  // Never-lose: an item whose fences parse ambiguously (unclosed, or a fence-like line outside
  // every block) is never dropped, and never used to drop an earlier item (both are kept).
  return items.filter((_, index) => parsed[index].ambiguous || !units.slice(index + 1).some((later, offset) =>
    !parsed[index + 1 + offset].ambiguous &&
    later.size > units[index].size && [...units[index]].every(unit => later.has(unit))));
}
