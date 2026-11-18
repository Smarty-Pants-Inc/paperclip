import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { answeredPersonMessageSql, carriedInLiveRunSql, completedPersonMessageAnswerSql } from "./person-message-answer.js";

/**
 * S8 order phase 2 (RFL F1 blocker): a queued person message that is already
 * CONSUMED, so an Interrupt's batch (fix B) never re-presents it and it never
 * keeps a press live (fix A). Composed ONLY of the shared person-message-answer.ts
 * functions, no rule of its own about answers or carries:
 * - ANSWERED: completedPersonMessageAnswerSql (a completed run's final answer);
 * - carriedInLiveRun: carriedInLiveRunSql (a live run already owns it);
 * - senderStopped: the message's OWN SENDER stopped a run that had started
 *   answering it. person-message-answer.ts (d2e8fa3e) exports no
 *   senderStoppedWhileAnswering / person-stopped predicate, so this composes
 *   its closest exported form, answeredPersonMessageSql (DELIVERED: a reply
 *   attributed through the stopped run's OWN pending input after it started),
 *   with the stop's identity as the run records it (run-cancellation.ts:
 *   cancelledByUserId / cancelledByActorId of a 'user' stop, or the recorded
 *   cancellation initiator). Only the sender's own Stop counts; another
 *   person's Stop leaves the message waiting. A Send's interrupt is not a Stop.
 *   Stop means stop: the stopped turn's answer is not repeated.
 * This is the ONE consumed rule: the Interrupt's batch (routes/issues.ts),
 * the live press (liveQueuedCommentInterruptSql) and the durable release's
 * promotion (wake-queue postgres.ts findNextDeferredWake and
 * getQueuedCommentLiveness) all read it.
 */
export function senderStoppedWhileAnsweringSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL; agentId: SQL }): SQL {
  return sql`exists (select 1 from ${issueComments} sender join ${heartbeatRuns} person_stopped
      on person_stopped.company_id = sender.company_id
    where sender.id = ${m.id} and sender.company_id = ${m.companyId} and sender.author_user_id is not null
      and person_stopped.agent_id = ${m.agentId}
      and (person_stopped.issue_id = ${m.issueId} or person_stopped.native_issue_id = ${m.issueId}
        or person_stopped.context_snapshot->>'issueId' = ${m.issueId}::text)
      and person_stopped.status in ('cancelled', 'failed')
      and person_stopped.result_json->>'queuedCommentInterruptQueueId' is null
      and ((person_stopped.result_json->>'cancelledByActorType' in ('user', 'board')
          and coalesce(person_stopped.result_json->>'cancelledByUserId', person_stopped.result_json->>'cancelledByActorId') = sender.author_user_id)
        or (person_stopped.result_json#>>'{cancellation,initiator,type}' = 'user'
          and person_stopped.result_json#>>'{cancellation,initiator,id}' = sender.author_user_id))
      and person_stopped.started_at > ${m.createdAt}
      and ${answeredPersonMessageSql({ id: m.id, companyId: m.companyId, issueId: m.issueId,
        createdAt: sql`person_stopped.started_at` })})`;
}

export function consumedQueuedPersonMessageSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL; agentId: SQL;
  excludeRunId?: SQL }): SQL {
  return sql`(${completedPersonMessageAnswerSql(m)}
    or ${carriedInLiveRunSql(m)}
    or ${senderStoppedWhileAnsweringSql(m)})`;
}

/** The ids among a saved wake's queued comments that are consumed (consumedQueuedPersonMessageSql). */
export async function consumedQueuedCommentIds(tx: Pick<Db, "select">, input: { companyId: string; issueId: string;
  agentId: string; commentIds: string[]; excludeRunId?: string | null }): Promise<Set<string>> {
  const ids = [...new Set(input.commentIds.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))];
  if (!ids.length) return new Set();
  const rows = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId), inArray(issueComments.id, ids),
    consumedQueuedPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}`,
      agentId: sql`${input.agentId}::uuid`,
      ...(input.excludeRunId ? { excludeRunId: sql`${input.excludeRunId}::uuid` } : {}) })));
  return new Set(rows.map(row => row.id));
}
