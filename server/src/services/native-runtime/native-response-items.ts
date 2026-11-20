import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, issueComments, type Db } from "@paperclipai/db";
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
  return items.size > 1 ? onceInPublicationStep([...items.values()]) : [];
}

// answered-a5 (org ruling 12:43Z): the person gets each answer ONCE and as early as today.
// A reply is compared by whole units: each line, split at sentence ends (". ", "! ", "? ").
// A unit is normalised by collapsing whitespace and stripping the markdown marks ** ` _ ;
// units are equal only as WHOLE units, never by substring containment ("101" != "101.5",
// "2 + 2 = 4" != "8 / 2 = 4"). Nothing is ever held: this only shapes what one publication
// step posts.
const SENTENCE_END = /(?<=[.!?])\s+/;
export function normalizedReplyUnit(text: string) {
  // A closing sentence mark is not content: "101." is "101"; "101.5" stays itself.
  return text.replace(/\*\*|`|_/g, "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
}
function lineUnits(line: string) {
  const sentences: string[] = [];
  // A list marker ("1.") belongs to its item, not a sentence of its own.
  for (const sentence of line.split(SENTENCE_END)) {
    if (sentences.length && /^\s*\d+[.)]$/.test(sentences[sentences.length - 1])) sentences[sentences.length - 1] += ` ${sentence}`;
    else sentences.push(sentence);
  }
  return sentences.map(sentence => ({ raw: sentence, unit: normalizedReplyUnit(sentence) }))
    .filter(part => part.unit.length > 0);
}
export function replyUnits(text: string) {
  return text.split(/\r?\n/).flatMap(line => lineUnits(line).map(part => part.unit));
}

/** The text with every whole unit already in `posted` left out; "" when nothing new is left.
 * Units not in `posted` are always kept, in order, so a coda such as "Answered above." stays,
 * and its referent is the earlier reply of this run that holds the left-out units. */
export function withoutPostedUnits(text: string, posted: ReadonlySet<string>) {
  if (posted.size === 0) return text.trim();
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = lineUnits(line);
    if (parts.length === 0) { if (lines.length && lines[lines.length - 1] !== "") lines.push(""); continue; }
    const kept = parts.filter(part => !posted.has(part.unit));
    if (kept.length === parts.length) lines.push(line.trimEnd());
    else if (kept.length) lines.push(kept.map(part => part.raw.trim()).join(" "));
  }
  return lines.join("\n").trim();
}

/** Ruling arm (3): the final items of ONE publication step become replies once. A later item that
 * contains every unit of an earlier one replaces it (one reply, the later text); otherwise both are
 * posted, in order, with the later one's units that the earlier already carries left out. */
export function onceInPublicationStep<T extends { text: string }>(items: T[]): T[] {
  const kept: Array<{ item: T; units: Set<string> }> = [];
  for (const item of items) {
    const units = new Set(replyUnits(item.text));
    for (let index = kept.length - 1; index >= 0; index--) {
      const earlier = kept[index].units;
      if (earlier.size > 0 && [...earlier].every(unit => units.has(unit))) kept.splice(index, 1);
    }
    const before = new Set(kept.flatMap(entry => [...entry.units]));
    const text = withoutPostedUnits(item.text, before);
    if (text) kept.push({ item: text === item.text.trim() ? item : { ...item, text }, units: new Set(replyUnits(text)) });
  }
  return kept.map(entry => entry.item);
}

/** Ruling arm (2): what this run already posted. "Already posted in this run" is read from the
 * run's existing agent reply comments on this issue (created_by_run_id = run, author = the run's
 * agent; deleted replies count, they were seen). Never another run's replies. */
export async function unitsPostedByRun(db: Db, input: { companyId: string; issueId: string; runId: string; agentId: string }) {
  const rows = await db.select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments).where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.createdByRunId, input.runId), eq(issueComments.authorAgentId, input.agentId)))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  return { units: new Set(rows.flatMap(row => replyUnits(row.body))), lastReplyId: rows.at(-1)?.id ?? null };
}
