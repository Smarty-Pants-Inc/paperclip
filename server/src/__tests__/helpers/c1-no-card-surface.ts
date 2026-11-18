import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { answeredPersonMessageSql } from "../../services/person-message-answer.js";
import { taskInterruptionPresentation } from "../../services/task-interruption-presentation.js";

/**
 * C1 r5 (RFL F3): 'delivered' is the product's ONE shared ANSWERED predicate,
 * answeredPersonMessageSql (services/person-message-answer.ts), the same call
 * recovery/stop-pending.ts deliveredToPerson makes. The task must have at least
 * one person message and every one of them must be answered. A run's status
 * is never read: a succeeded run with an empty result and zero comments
 * delivered nothing, so it is silence and fails.
 */
async function personMessagesAnswered(db: Db, issueId: string): Promise<boolean> {
  const m = { id: sql.raw("m.id"), companyId: sql.raw("m.company_id"), issueId: sql.raw("m.issue_id"), createdAt: sql.raw("m.created_at") };
  const [row] = await db.execute<{ messages: number; answered: number }>(sql`select count(*)::int as messages,
      count(*) filter (where ${answeredPersonMessageSql(m)})::int as answered
    from ${issueComments} m
    where m.issue_id = ${issueId} and m.author_type = 'user' and m.deleted_at is null`);
  return Boolean(row && Number(row.messages) > 0 && Number(row.answered) === Number(row.messages));
}

/**
 * C1 record SUPERSEDE-C1-NOSTOP-CARD-1118 condition (2): a flipped 'no card' row
 * must also show what the person sees INSTEAD of the card, never silence.
 * The task API's interruption presentation drives ExecutionBlockerNotice.tsx
 * (:133-155): a system 'failed' state renders "Couldn't finish this attempt.
 * Your message is saved." with Retry when canRetry; 'working', 'retry_scheduled'
 * and 'waiting_for_user' render their own visible line. Otherwise the person sees
 * a delivered answer (every person message on the task answered by the shared
 * predicate, never a run status), the closed task, or exactly one note.
 * Anything else is silence and fails.
 */
export async function expectPersonSeesInsteadOfCard(db: Db, issueId: string) {
  const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
  expect(issue, "task exists").toBeTruthy();
  const presentation = await taskInterruptionPresentation(db, issue!);
  const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  const observed = presentation?.observedRunId
    ? (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, presentation.observedRunId)))[0] : undefined;
  const surface =
    presentation?.responsibility === "system" && presentation.state === "failed" && presentation.canRetry ? "failure_line_retry"
    : presentation && ["working", "retry_scheduled", "waiting_for_user"].includes(presentation.state) ? `state:${presentation.state}`
    : notes.length === 1 ? "one_note"
    : presentation?.state === "resolved" && ["done", "cancelled"].includes(issue!.status) ? "task_closed"
    : presentation?.state === "resolved" && await personMessagesAnswered(db, issueId) ? "delivered_answer"
    : "silent";
  expect(surface, `presentation=${JSON.stringify(presentation)} notes=${notes.length} observedRunStatus=${observed?.status ?? "none"}`).not.toBe("silent");
  if (process.env.C1_SURFACE_LOG) console.log(`C1_SURFACE ${surface}`);
  return surface;
}
