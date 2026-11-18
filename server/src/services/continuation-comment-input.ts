import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replay guard: only an attributed, published run reply answers person input.
 * Run-less agent comments and provider acceptance are not answers. Imported
 * person comments remain history, using insertion provenance or legacy import
 * arrival records. Removing failure notices must not re-deliver saved history. */
export function answeredPersonMessageSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  return sql`(exists (select 1 from ${issueComments} a
    join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and exists (select 1 from ${issueComments} b
        where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and (b.id = ${m.id} or b.created_at > ${m.createdAt})
          and (r.context_snapshot->>'wakeCommentId' = b.id::text or r.context_snapshot->>'commentId' = b.id::text
            or r.context_snapshot->>'conversationReplyBoundaryCommentId' = b.id::text
            or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? b.id::text
            or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? b.id::text)))
    or ${importedPersonHistorySql(m)})`;
}

function importedPersonHistorySql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  return sql`exists (select 1 from ${issueComments} p where p.id = ${m.id} and p.author_type = 'user'
    and case when p.origin = 'import' then true else ${m.createdAt} < coalesce(
      (select min(l.created_at) from ${activityLog} l where l.company_id = ${m.companyId}
        and l.action = 'issue.imported' and l.entity_type = 'issue' and l.entity_id = ${m.issueId}::text),
      (select min(c.created_at) from ${activityLog} c where c.company_id = ${m.companyId} and c.action = 'company.imported'
        and c.entity_type = 'company' and c.entity_id = ${m.companyId}::text
        and exists (select 1 from ${issues} i where i.id = ${m.issueId} and i.company_id = ${m.companyId}
          and i.origin_kind = 'company_import'))) end)`;
}

/** THE continuation seam every successor seed uses (wake-queue port, first-turn
 * input, readContinuationCommentInput): the predecessor's still-pending person
 * input. A person's resolution of a question the predecessor's agent asked on
 * this task IS that input, so it comes first (answer-first, 4c1eea8e): the
 * successor seeds from the answer, never the asking turn's comment.
 * `agentId` is the predecessor run's agent, from trusted run state. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const answered = await pendingContinuationInteractionInput(db, input);
  // An interaction-respond wake also names the asking turn's origin comment;
  // carrying it makes the successor's contract re-request that turn and cuts its
  // fresh history before the answer (upstream's seed carries no comment ids at all).
  if (answered.interactionIds) return answered;
  return pendingPersonCommentInput(db, input);
}

/** Rebind the parent's wake comments and first-turn input ids, not its receipt. */
async function pendingPersonCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const carried = carryContinuationCommentInput(input.contextSnapshot);
  const candidates = (carried.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  if (candidates.length === 0) return {};
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), isNull(issueComments.deletedAt),
    // Only still-pending input: a comment with a PUBLISHED agent answer attributed to it (or to a later person
    // input) is never re-presented, or every continuation re-answers it (the re-wake loop, org 19:48Z).
    sql`not ${answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const commentIds = rows.map(row => row.id);
  if (commentIds.length === 0) return {};
  return { ...carried, firstTurnQueuedInput: null, wakeCommentIds: commentIds,
    wakeCommentId: commentIds.at(-1), commentId: commentIds.at(-1) };
}

/** The predecessor's interaction references, only those a person resolved for a
 * question that agent asked on this task. They are candidates: the successor's
 * runtime selection revalidates them through the existing materializer
 * (materializeNativeInteractionResponses), so the person's answer is its input. */
export async function pendingContinuationInteractionInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const context = input.contextSnapshot && typeof input.contextSnapshot === "object" && !Array.isArray(input.contextSnapshot)
    ? input.contextSnapshot as Record<string, unknown> : {};
  const candidates = [...new Set([context.interactionId, ...(Array.isArray(context.interactionIds) ? context.interactionIds : [])]
    .filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (candidates.length === 0) return {};
  const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.id, candidates), eq(issueThreadInteractions.createdByAgentId, input.agentId),
    sql`${issueThreadInteractions.resolvedByUserId} is not null`, isNull(issueThreadInteractions.resolvedByAgentId),
    inArray(issueThreadInteractions.status, ["answered", "accepted", "rejected"]),
  )).orderBy(asc(issueThreadInteractions.resolvedAt), asc(issueThreadInteractions.id));
  const interactionIds = rows.map(row => row.id);
  return interactionIds.length ? { interactionIds, interactionId: interactionIds.at(-1) } : {};
}

/** For fresh recovery seeds whose caller keeps only a predecessor id. */
export async function readContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string | null | undefined;
}): Promise<Record<string, unknown>> {
  if (!input.runId || !UUID.test(input.runId)) return {};
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  if (!source) return {};
  // A person's answer to the predecessor's question is pending input exactly as
  // a pending comment is: an automatic successor that drops it re-asks (RFL 09:35Z).
  return pendingContinuationCommentInput(db, { companyId: input.companyId, issueId: input.issueId,
    agentId: source.agentId, contextSnapshot: source.contextSnapshot });
}
