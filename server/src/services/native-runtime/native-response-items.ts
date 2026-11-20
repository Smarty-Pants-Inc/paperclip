import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { completedPlanProposalIds, readCompletedAssistantMessageCandidate,
  readTruncatedCompletedAgentMessageItemId, readTruncatedCompletedAssistantMessageCandidate } from "../heartbeat-run-summary.js";
import { readSteeredMessageAnswers } from "./steered-message-answers.js";

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
  // The answer the agent gave to a steered message in progress text (written before its next tool,
  // e.g. "101") is part of the reply too: posted once, in item order, before the final. Other
  // progress/commentary and tool output stay run activity.
  const steerAnswers = new Set((await readSteeredMessageAnswers(db, input)).answerItemIds);
  const candidates = [];
  for (const row of rows) {
    let event = record(record(row.payload).prpEvent);
    if (row.eventType !== "item.completed") continue;
    const itemId = typeof event.itemId === "string" ? event.itemId : null;
    if (!itemId) continue;
    if (steerAnswers.has(itemId) && record(event.payload).channel === "progress")
      event = { ...event, payload: { ...record(event.payload), channel: "final" } };
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
  const selected = candidates.findLast(candidate => candidate.text === input.text && !steerAnswers.has(candidate.itemId));
  if (!selected) return [];
  const items = new Map<string, { itemId: string; text: string }>();
  for (const candidate of candidates) {
    // A steer's answer is posted even when the model wrote it after its own final (Pi read the steer late).
    if ((steerAnswers.has(candidate.itemId) || (candidate.turnId === selected.turnId && candidate.seq <= selected.seq))
      && !items.has(candidate.itemId))
      items.set(candidate.itemId, { itemId: candidate.itemId, text: candidate.text });
  }
  return items.size > 1 ? [...items.values()] : [];
}
