// Leaf: the one visible notice that stands on a task's conversation, read the
// same way by the chat card (task-interruption-presentation.ts) as by the
// execution blocker (execution-blocker.ts reads the held notice itself). Never
// import native-session-executor.ts here: it imports modules that import this one.
import { issueComments, type Db } from "@paperclipai/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { answeredPersonMessageSql } from "./person-message-answer.js";
import { HELD_CONVERSATION_NOTICE_REASON_PREFIX, readUnsupersededHeldConversationNotices } from "./native-runtime/pi-session-recovery-notice.js";
import { EXECUTION_DEADLINE_NOTICE_CAUSE, readUnsupersededExecutionDeadlineNotice } from "./execution-deadline-notice.js";

export type StandingRunNotice = {
  /** Machine reason shown with the notice; never raw error text. */
  code: string;
  /** The notice's own saved text, exactly as the thread shows it. */
  text: string;
  source: "held" | "unanswered" | "deadline" | "default";
};

/** The held-conversation notice code: its authorizationReason prefix, without the session id. */
export const HELD_CONVERSATION_NOTICE_CODE = HELD_CONVERSATION_NOTICE_REASON_PREFIX.replace(/:$/, "");

/**
 * The standing notice per issue, one set-based read for the batch. Output only:
 * the card shows its text; whether Retry is offered stays the execution
 * blocker's decision.
 * - unanswered: the sweep's standing notice for the latest unanswered message.
 * - held: a historical unsuperseded held-conversation notice.
 * - deadline: an unsuperseded execution-deadline notice.
 * A current sweep notice keeps precedence over legacy notices.
 */
export async function readStandingRunNotices(db: Db,
  input: { companyId: string; issueIds: readonly string[] }): Promise<Map<string, StandingRunNotice>> {
  const notices = new Map<string, StandingRunNotice>();
  if (!input.issueIds.length) return notices;
  // The sweep is the sole new held-refusal notice writer. Read its exact saved
  // text (including waiting notes), using the shared message/answer relation.
  // Do not wait for the next sweep to hide an already-answered standing note.
  const unansweredPrefix = "unanswered_message:";
  const unanswered = await db.select({ issueId: issueComments.issueId, body: issueComments.body })
    .from(issueComments).where(and(eq(issueComments.companyId, input.companyId),
      inArray(issueComments.issueId, [...new Set(input.issueIds)]), eq(issueComments.authorType, "system"),
      isNull(issueComments.deletedAt), sql`starts_with(${issueComments.metadata}->>'authorizationReason', ${unansweredPrefix})`,
      sql`exists (select 1 from ${issueComments} m where m.company_id = ${issueComments.companyId}
        and m.issue_id = ${issueComments.issueId} and m.author_type = 'user' and m.deleted_at is null
        and m.id::text = substr(${issueComments.metadata}->>'authorizationReason', ${unansweredPrefix.length + 1})
        and not ${answeredPersonMessageSql({ id: sql`m.id`, companyId: sql`m.company_id`, issueId: sql`m.issue_id`, createdAt: sql`m.created_at` })}
        and not exists (select 1 from ${issueComments} newer where newer.company_id = m.company_id
          and newer.issue_id = m.issue_id and newer.author_type = 'user' and newer.deleted_at is null
          and newer.created_at > m.created_at))`))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id));
  for (const notice of unanswered) if (!notices.has(notice.issueId))
    notices.set(notice.issueId, { code: "unanswered_message", text: notice.body, source: "unanswered" });
  // Keep historical executor notices readable. A current sweep note takes
  // precedence so an old resend instruction cannot replace its waiting text.
  for (const [issueId, held] of await readUnsupersededHeldConversationNotices(db, input))
    if (!notices.has(issueId)) notices.set(issueId, { code: HELD_CONVERSATION_NOTICE_CODE, text: held.body, source: "held" });
  const rest = [...new Set(input.issueIds)].filter(issueId => !notices.has(issueId));
  const deadlines = await Promise.all(rest.map(issueId =>
    readUnsupersededExecutionDeadlineNotice(db, { companyId: input.companyId, issueId })));
  rest.forEach((issueId, index) => {
    const deadline = deadlines[index];
    if (deadline) notices.set(issueId,
      { code: EXECUTION_DEADLINE_NOTICE_CAUSE, text: deadline.body, source: "deadline" });
  });
  return notices;
}

export async function readStandingRunNotice(db: Db,
  input: { companyId: string; issueId: string }): Promise<StandingRunNotice | null> {
  return (await readStandingRunNotices(db, { companyId: input.companyId, issueIds: [input.issueId] })).get(input.issueId) ?? null;
}
