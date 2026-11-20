import { and, eq, isNull, like, sql } from "drizzle-orm";
import { activityLog, issueComments, type Db } from "@paperclipai/db";
import { answeredPersonMessageSql, UNANSWERED_MESSAGE_LOOKBACK_MS } from "./person-message-answer.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PluginCommentCauseRefusal = "invalid_comment_cause" | "stale_comment_cause" | "answered_comment_cause";

/** One host-owned reader for RPC admission, locked queue admission and deferred
 * promotion. A plugin name or activity row alone never proves comment authorship.
 * Historical unstamped replies are deliberately ineligible, not replayed. */
export async function readPluginCommentCause(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; pluginId: string; commentId: string;
}): Promise<{ ok: true; comment: typeof issueComments.$inferSelect } | { ok: false; reason: PluginCommentCauseRefusal }> {
  if (!UUID.test(input.commentId)) return { ok: false, reason: "invalid_comment_cause" };
  const [cause] = await db.select({ comment: issueComments,
    answered: answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }),
  }).from(issueComments).innerJoin(activityLog, and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, input.issueId), eq(activityLog.action, "issue.comment.created"),
    eq(activityLog.actorType, "plugin"), eq(activityLog.actorId, input.pluginId),
    sql`${activityLog.details}->>'commentId' = ${issueComments.id}::text`,
  )).where(and(eq(issueComments.id, input.commentId), eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId), isNull(issueComments.deletedAt),
    isNull(issueComments.authorAgentId), isNull(issueComments.authorUserId), eq(issueComments.authorType, "system"),
    like(issueComments.clientRequestId, `plugin-comment:${input.pluginId}:%`))).limit(1);
  if (!cause) return { ok: false, reason: "invalid_comment_cause" };
  if (cause.comment.createdAt.getTime() <= Date.now() - UNANSWERED_MESSAGE_LOOKBACK_MS)
    return { ok: false, reason: "stale_comment_cause" };
  if (cause.answered) return { ok: false, reason: "answered_comment_cause" };
  return { ok: true, comment: cause.comment };
}
