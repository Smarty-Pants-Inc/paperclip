import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { readFirstTurnQueuedInputReceipt } from "./first-turn-queued-input.js";

/** Freeze Pi card causality at creation, not at answer delivery. Cursor order is
 * authoritative even when ACKs and the card share a millisecond timestamp. */
export async function nativeQuestionSourceCommentId(db: Db, scope: {
  companyId: string; issueId: string; runId: string; agentId: string;
}, event?: { sourceEventId: string; turnId?: string }): Promise<string | null> {
  const [row] = await db.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId)))
    .where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.nativeIssueId, scope.issueId)));
  if (!row || row.run.runtimeMode !== "native" || row.config.provider !== "pi_rpc") return null;
  const eventScope = and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.runId));
  const [askingEvent] = event ? await db.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents)
    .where(and(eventScope, sql`${heartbeatRunEvents.payload}->'prpEvent'->>'sourceEventId' = ${event.sourceEventId}`)).limit(1) : [];
  const cursor = askingEvent?.seq ?? row.run.nextEventSeq;
  const [latest] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eventScope, lt(heartbeatRunEvents.seq, cursor), eq(heartbeatRunEvents.eventType, "turn.started"),
      sql`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId' is not null`))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const turnId = event?.turnId ?? parseObject(parseObject(latest?.payload).prpEvent).turnId;
  if (typeof turnId !== "string") return null;
  const context = parseObject(row.run.contextSnapshot);
  const initial = [...new Set([
    ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
    ...(typeof context.wakeCommentId === "string" ? [context.wakeCommentId] : []),
    ...(readFirstTurnQueuedInputReceipt(row.run)?.commentIds ?? []),
  ].filter((id): id is string => typeof id === "string"))];
  const acks = Object.entries(parseObject(parseObject(row.run.resultJson).queuedSteeringAcknowledgements))
    .filter(([, value]) => { const receipt = parseObject(value); return receipt.status === "acknowledged"
      && receipt.turnId === turnId && typeof receipt.afterEventSeq === "number" && receipt.afterEventSeq < cursor; })
    .sort((a, b) => Number(parseObject(a[1]).afterEventSeq) - Number(parseObject(b[1]).afterEventSeq)
      || a[0].localeCompare(b[0]));
  const ids = [...new Set([...initial, ...acks.map(([id]) => id)])];
  if (!ids.length) return null;
  const comments = await db.select({ id: issueComments.id, userId: issueComments.authorUserId,
    authorType: issueComments.authorType, agentId: issueComments.authorAgentId, runId: issueComments.createdByRunId }).from(issueComments)
    .where(and(eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, scope.issueId), inArray(issueComments.id, ids)));
  // Older board comments predate authorType; an agent/run-authored row is
  // never a person input, even if it carries an on-behalf-of user identity.
  const isPerson = (comment: typeof comments[number]) => (comment.authorType === "user" || comment.authorType === null)
    && Boolean(comment.userId) && !comment.agentId && !comment.runId;
  const person = initial.map(id => comments.find(comment => comment.id === id))
    .find(comment => comment && isPerson(comment))?.userId ?? row.run.responsibleUserId;
  const samePerson = (id: string) => comments.some(comment => comment.id === id && isPerson(comment)
    && comment.userId === person && person);
  const acknowledged = acks.map(([id]) => id).filter(samePerson).at(-1);
  if (acknowledged) return acknowledged;
  const [firstTurn] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eventScope, eq(heartbeatRunEvents.eventType, "turn.started")))
    .orderBy(asc(heartbeatRunEvents.seq)).limit(1);
  const firstTurnId = parseObject(parseObject(firstTurn?.payload).prpEvent).turnId;
  return (!firstTurnId || firstTurnId === turnId) ? initial.filter(samePerson).at(-1) ?? null : null;
}
