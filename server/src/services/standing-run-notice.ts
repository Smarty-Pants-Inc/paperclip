// Leaf: the one visible notice that stands on a task's conversation, read the
// same way by the chat card (task-interruption-presentation.ts) as by the
// execution blocker (execution-blocker.ts reads the held notice itself). Never
// import native-session-executor.ts here: it imports modules that import this one.
import type { Db } from "@paperclipai/db";
import { HELD_CONVERSATION_NOTICE_REASON_PREFIX, readUnsupersededHeldConversationNotices } from "./native-runtime/pi-session-recovery-notice.js";
import { EXECUTION_DEADLINE_NOTICE_CAUSE, readUnsupersededExecutionDeadlineNotice } from "./execution-deadline-notice.js";

export type StandingRunNotice = {
  /** Machine reason shown with the notice; never raw error text. */
  code: string;
  /** The notice's own saved text, exactly as the thread shows it. */
  text: string;
  /** Whether a Retry can work while this notice stands. */
  retryCanWork: boolean;
  source: "held" | "deadline" | "default";
};

/** The held-conversation notice code: its authorizationReason prefix, without the session id. */
export const HELD_CONVERSATION_NOTICE_CODE = HELD_CONVERSATION_NOTICE_REASON_PREFIX.replace(/:$/, "");

/**
 * The standing notice per issue, one set-based read for the batch.
 * - held: an unsuperseded held-conversation notice. It refuses a Retry the same
 *   way it refuses a message (execution-blocker.ts canRetry), so retryCanWork is false.
 * - deadline: an unsuperseded execution-deadline notice, read with
 *   readUnsupersededExecutionDeadlineNotice, the same reader getExecutionBlocker
 *   uses for its canRetry, so the card and the blocker agree. Its text tells
 *   the person to verify the stopped execution first, so retryCanWork is false.
 * - default: the C9 "Your message wasn't answered (error: <code>)" notice adds
 *   one branch here (its retryCanWork is true for a re-send-safe code). A held
 *   notice keeps precedence for its issue.
 */
export async function readStandingRunNotices(db: Db,
  input: { companyId: string; issueIds: readonly string[] }): Promise<Map<string, StandingRunNotice>> {
  const notices = new Map<string, StandingRunNotice>();
  for (const [issueId, held] of await readUnsupersededHeldConversationNotices(db, input))
    notices.set(issueId, { code: HELD_CONVERSATION_NOTICE_CODE, text: held.body, retryCanWork: false, source: "held" });
  const rest = [...new Set(input.issueIds)].filter(issueId => !notices.has(issueId));
  const deadlines = await Promise.all(rest.map(issueId =>
    readUnsupersededExecutionDeadlineNotice(db, { companyId: input.companyId, issueId })));
  rest.forEach((issueId, index) => {
    const deadline = deadlines[index];
    if (deadline) notices.set(issueId,
      { code: EXECUTION_DEADLINE_NOTICE_CAUSE, text: deadline.body, retryCanWork: false, source: "deadline" });
  });
  return notices;
}

export async function readStandingRunNotice(db: Db,
  input: { companyId: string; issueId: string }): Promise<StandingRunNotice | null> {
  return (await readStandingRunNotices(db, { companyId: input.companyId, issueIds: [input.issueId] })).get(input.issueId) ?? null;
}
