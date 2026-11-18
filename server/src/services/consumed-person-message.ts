import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { carriedInLiveRunSql, completedPersonMessageAnswerSql } from "./person-message-answer.js";
import { runOwnInputIds, senderStoppedWhileAnswering } from "./recovery/person-stopped-message.js";

/**
 * S8 order (RFL F1 / F1b, rf-4 durable release): the ONE rule for a queued
 * person message that is already CONSUMED, so the Interrupt's batch (fix B,
 * routes/issues.ts), the live press (fix A, heartbeat/queue.ts
 * liveQueuedCommentPressId) and the durable release's promotion (wake-queue
 * postgres.ts findNextDeferredWake and the queued-comment liveness) never
 * re-present it. Composed ONLY of app-lead's exported functions, no rule of
 * its own about answers, carries or stops:
 * - ANSWERED: completedPersonMessageAnswerSql (person-message-answer.ts);
 * - carriedInLiveRun: carriedInLiveRunSql (person-message-answer.ts);
 * - sender-stopped: senderStoppedWhileAnswering (recovery/person-stopped-message.ts,
 *   the ONE whole person-stop exclusion: the message's SENDER stopped the run
 *   AND the run had STARTED answering it), asked of every stopped run that
 *   carried the message as its own input (runOwnInputIds). Stopper == sender
 *   is that helper's own check (stoppedBySender).
 */
export function answeredOrCarriedPersonMessageSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL; agentId: SQL;
  excludeRunId?: SQL }): SQL {
  return sql`(${completedPersonMessageAnswerSql(m)} or ${carriedInLiveRunSql(m)})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids among a saved wake's queued comments that are consumed (see above). */
export async function consumedQueuedCommentIds(tx: Pick<Db, "select">, input: { companyId: string; issueId: string;
  agentId: string; commentIds: string[]; excludeRunId?: string | null }): Promise<Set<string>> {
  const ids = [...new Set(input.commentIds.filter(id => UUID.test(id)))];
  if (!ids.length) return new Set();
  const consumed = new Set((await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId), inArray(issueComments.id, ids),
    answeredOrCarriedPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}`,
      agentId: sql`${input.agentId}::uuid`,
      ...(input.excludeRunId ? { excludeRunId: sql`${input.excludeRunId}::uuid` } : {}) })))).map(row => row.id));
  const rest = ids.filter(id => !consumed.has(id));
  if (!rest.length) return consumed;
  const messages = await tx.select({ id: issueComments.id, authorUserId: issueComments.authorUserId }).from(issueComments)
    .where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      inArray(issueComments.id, rest)));
  if (!messages.some(message => message.authorUserId)) return consumed;
  const stopped = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
    resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "cancelled"),
    input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : undefined,
    or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`)));
  for (const message of messages) {
    for (const run of stopped) {
      if (!runOwnInputIds(run.contextSnapshot).includes(message.id)) continue;
      if (await senderStoppedWhileAnswering(tx as unknown as Db, input.companyId,
        { ...run, resultJson: (run.resultJson ?? null) as Record<string, unknown> | null }, message)) {
        consumed.add(message.id);
        break;
      }
    }
  }
  return consumed;
}
