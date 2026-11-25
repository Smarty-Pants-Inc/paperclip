import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { issueComments, issueReadStates, type Db } from "@paperclipai/db";
import { markdownToPlainText } from "chat";
import { redactCurrentUserText } from "../log-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

export async function withConversationReadState<T extends { id: string }>(db: Db, companyId: string, userId: string, conversations: T[]) {
  if (!conversations.length) return [] as Array<T & { isUnreadForMe: boolean; unreadMessageCount: number; lastExternalCommentAt: Date | null; latestMessagePreview: string | null }>;
  const eligible = and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, conversations.map(chat => chat.id)),
    sql`${issueComments.deletedAt} is null`,
    sql`${issueComments.authorType} is distinct from 'system'`,
    sql`${issueComments.presentation} ->> 'kind' is distinct from 'system_notice'`,
    eq(issueComments.origin, "comment"),
  );
  // Count history without reading its bodies; fetch only the newest eligible body below.
  const readState = db.select({
    issueId: issueComments.issueId,
    latest: sql<Date>`max(${issueComments.createdAt}) filter (where ${issueComments.authorAgentId} is not null)`.as("latest"),
    unreadMessageCount: sql<number>`count(*) filter (where ${issueComments.authorAgentId} is not null and ${issueComments.createdAt} > coalesce(${issueReadStates.lastReadAt}, to_timestamp(0)))`.mapWith(Number).as("unread_message_count"),
  }).from(issueComments).leftJoin(issueReadStates, and(
    eq(issueReadStates.companyId, companyId), eq(issueReadStates.issueId, issueComments.issueId), eq(issueReadStates.userId, userId),
  )).where(eligible).groupBy(issueComments.issueId).as("read_state");
  const newest = db.select({ body: issueComments.body }).from(issueComments)
    .where(and(eligible, eq(issueComments.issueId, readState.issueId)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1).as("newest");
  const rows = await db.select({ issueId: readState.issueId, latest: readState.latest,
    unreadMessageCount: readState.unreadMessageCount, latestMessageBody: newest.body,
  }).from(readState).leftJoinLateral(newest, sql`true`);
  const byId = new Map(rows.map(row => [row.issueId, row]));
  // Settled once; a failed settings read only omits previews (inside the fail-closed try below).
  const general = instanceSettingsService(db).getGeneral().then(settings => settings, () => null);
  const redactions = createRunSecretRedactionRegistry(db);
  const previews = new Map(await Promise.all(rows.map(async row => {
    try {
      // Stock's notification order: exact registry values on the untouched body, then the
      // username mask; flatten the complete text before cutting (a cut can split a secret).
      const settings = await general;
      if (!settings) return [row.issueId, null] as const;
      const redacted = await redactions.redactForIssueNotification(companyId, row.issueId, row.latestMessageBody ?? "");
      const masked = redactCurrentUserText(redacted, { enabled: settings.censorUsernameInLogs });
      const plain = markdownToPlainText(masked).replace(/\s+/g, " ").trim();
      return [row.issueId, [...plain].slice(0, 240).join("")] as const;
    } catch {
      // No raw fallback when masking, registry resolution or flattening fails.
      return [row.issueId, null] as const;
    }
  })));
  return conversations.map(chat => ({ ...chat, isUnreadForMe: (byId.get(chat.id)?.unreadMessageCount ?? 0) > 0,
    unreadMessageCount: byId.get(chat.id)?.unreadMessageCount ?? 0,
    lastExternalCommentAt: byId.get(chat.id)?.latest ?? null,
    latestMessagePreview: previews.get(chat.id) ?? null }));
}
