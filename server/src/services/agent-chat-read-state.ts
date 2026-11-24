import { and, eq, inArray, sql } from "drizzle-orm";
import { issueComments, issueReadStates, type Db } from "@paperclipai/db";

export async function withConversationReadState<T extends { id: string }>(db: Db, companyId: string, userId: string, conversations: T[]) {
  if (!conversations.length) return [] as Array<T & { isUnreadForMe: boolean; unreadMessageCount: number; lastExternalCommentAt: Date | null; latestMessagePreview: string | null }>;
  const rows = await db.select({
    issueId: issueComments.issueId,
    latest: sql<Date>`max(${issueComments.createdAt}) filter (where ${issueComments.authorAgentId} is not null)`,
    latestMessagePreview: sql<string>`(array_agg(left(${issueComments.body}, 240) order by ${issueComments.createdAt} desc, ${issueComments.id} desc))[1]`,
    unreadMessageCount: sql<number>`count(*) filter (where ${issueComments.authorAgentId} is not null and ${issueComments.createdAt} > coalesce(${issueReadStates.lastReadAt}, to_timestamp(0)))`.mapWith(Number),
  }).from(issueComments).leftJoin(issueReadStates, and(
    eq(issueReadStates.companyId, companyId), eq(issueReadStates.issueId, issueComments.issueId), eq(issueReadStates.userId, userId),
  )).where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, conversations.map(chat => chat.id)),
    sql`${issueComments.deletedAt} is null`,
    sql`${issueComments.authorType} is distinct from 'system'`,
    sql`${issueComments.presentation} ->> 'kind' is distinct from 'system_notice'`,
    eq(issueComments.origin, "comment"),
  )).groupBy(issueComments.issueId);
  const byId = new Map(rows.map(row => [row.issueId, row]));
  return conversations.map(chat => ({ ...chat, isUnreadForMe: (byId.get(chat.id)?.unreadMessageCount ?? 0) > 0,
    unreadMessageCount: byId.get(chat.id)?.unreadMessageCount ?? 0,
    lastExternalCommentAt: byId.get(chat.id)?.latest ?? null,
    latestMessagePreview: byId.get(chat.id)?.latestMessagePreview ?? null }));
}
