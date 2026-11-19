import { and, eq, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export { PAPERCLIP_RECEIVED_MID_TASK_LABEL } from "@paperclipai/adapter-utils/server-utils";

/**
 * A carried steer: a person's message steered into a running turn that the turn
 * did not answer, so its run end put it back in the queue (wake-queue release,
 * restoreUnansweredSteersAtRunEnd: resultJson.restoredSteeredCommentIds; a
 * person's Stop under S10 C1: resultJson.stopRestoredSteeredCommentIds). The
 * next turn's input marks it 'received mid-task'; an ordinary queued message is
 * never in these lists. Returns the given ids that some OTHER run of this issue
 * restored, with the run that restored each one.
 */
export async function carriedSteerRestorers(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; commentIds: readonly string[]; currentRunId?: string | null;
}): Promise<Map<string, string>> {
  const wanted = new Set(input.commentIds);
  if (wanted.size === 0) return new Map();
  const rows = await db.select({ id: heartbeatRuns.id, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
    input.currentRunId ? ne(heartbeatRuns.id, input.currentRunId) : undefined,
    sql`(${heartbeatRuns.resultJson} ? 'restoredSteeredCommentIds' or ${heartbeatRuns.resultJson} ? 'stopRestoredSteeredCommentIds')`,
  ));
  const restorers = new Map<string, string>();
  for (const row of rows) {
    const result = (row.resultJson ?? {}) as Record<string, unknown>;
    for (const key of ["restoredSteeredCommentIds", "stopRestoredSteeredCommentIds"] as const) {
      const ids = Array.isArray(result[key]) ? result[key] as unknown[] : [];
      for (const id of ids) if (typeof id === "string" && wanted.has(id) && !restorers.has(id)) restorers.set(id, row.id);
    }
  }
  return restorers;
}

export async function carriedSteerCommentIds(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; commentIds: readonly string[]; currentRunId?: string | null;
}): Promise<Set<string>> {
  return new Set((await carriedSteerRestorers(db, input)).keys());
}
