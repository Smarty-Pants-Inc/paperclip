import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { deriveCommentId, extractWakeCommentIds } from "../../modules/run-dispatch/index.js";

/** The person-message window a fresh-thread restore carries (the unanswered-message sweep's own lookback). */
export const FRESH_THREAD_OWED_LOOKBACK_MS = 24 * 60 * 60_000;
/** Bound on carried owed messages; the payload builder truncates and sets fallbackFetchNeeded past its own cap. */
export const FRESH_THREAD_OWED_MESSAGES_MAX = 20;

/**
 * RESTORE-INPUT: a turn that starts a fresh provider thread from saved history
 * (selectPiConversation / selectFreshContinuationThread consumed the recorded
 * fresh-continuation boundary) must not leave the person's owed messages in the
 * saved history only: the model then answers just the latest one. Every person
 * message the ONE answered rule (answeredPersonMessageSql) says is still owed is
 * carried as this run's explicit queued input, oldest first, each once:
 * - the run's context (wakeCommentIds/wakeCommentId/commentId), persisted on the
 *   run row, so the restore run CARRIES them and its reply answers them (the
 *   answered rule's carried keys) and their cards retire on the per-message path;
 * - the wake payload rebuilt by the existing builder, so the prompt lists them
 *   under the existing 'New comments in order:' header with its in-order
 *   direct-answer line (chat or task).
 * Returns the carried ids (empty when nothing is owed).
 */
export async function carryOwedMessagesIntoFreshThread(db: Db, input: {
  companyId: string; agentId: string; issueId: string; runId: string; context: Record<string, unknown>;
}): Promise<string[]> {
  const since = new Date(Date.now() - FRESH_THREAD_OWED_LOOKBACK_MS);
  // The current conversation only: a chat reset (/new) boundary ends the earlier
  // conversation, exactly as the saved-history handoff reads it. An invalid
  // boundary never exposes the earlier conversation.
  const [issue] = await db.select({ boundaryId: issues.conversationBoundaryCommentId }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).limit(1);
  const [boundary] = issue?.boundaryId ? await db.select({ id: issueComments.id, createdAt: issueComments.createdAt })
    .from(issueComments).where(and(eq(issueComments.id, issue.boundaryId), eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId))).limit(1) : [];
  if (!issue || (issue.boundaryId && !boundary)) return [];
  const owed = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt), gt(issueComments.createdAt, since),
    boundary ? sql`(${issueComments.createdAt}, ${issueComments.id}) > (${boundary.createdAt.toISOString()}::timestamptz, ${boundary.id}::uuid)` : undefined,
    sql`not ${answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id)).limit(FRESH_THREAD_OWED_MESSAGES_MAX);
  if (owed.length === 0) return [];
  const current = deriveCommentId(input.context, null);
  const candidates = [...new Set([...extractWakeCommentIds(input.context), ...(current ? [current] : []), ...owed.map(row => row.id)])];
  // One order for the whole batch: thread order (oldest first), each id once.
  const ordered = (await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates))).orderBy(asc(issueComments.createdAt), asc(issueComments.id))).map(row => row.id);
  if (ordered.length === 0) return [];
  const carried = { wakeCommentIds: ordered, wakeCommentId: ordered.at(-1)!, commentId: ordered.at(-1)! };
  Object.assign(input.context, carried);
  await db.update(heartbeatRuns).set({
    contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify(carried)}::jsonb`,
  }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const { buildPaperclipWakePayload, PAPERCLIP_WAKE_PAYLOAD_KEY } = await import("../heartbeat/run-preparation.js");
  const rebuilt = await buildPaperclipWakePayload({ db, companyId: input.companyId, agentId: input.agentId,
    runId: input.runId, contextSnapshot: input.context }) as Record<string, unknown> | null;
  if (rebuilt) {
    const existing = input.context[PAPERCLIP_WAKE_PAYLOAD_KEY];
    // Keep every other field the run's preparation already decided (chat provider, contracts);
    // replace only the comment batch the builder derives from the carried ids.
    input.context[PAPERCLIP_WAKE_PAYLOAD_KEY] = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing as Record<string, unknown>, commentIds: rebuilt.commentIds, latestCommentId: rebuilt.latestCommentId,
        comments: rebuilt.comments, commentWindow: rebuilt.commentWindow, truncated: rebuilt.truncated,
        fallbackFetchNeeded: rebuilt.fallbackFetchNeeded }
      : rebuilt;
  }
  return ordered;
}
