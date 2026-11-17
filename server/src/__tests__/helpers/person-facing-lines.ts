import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, issueComments, issueRecoveryActions, type Db } from "@paperclipai/db";
import { getExecutionBlocker } from "../../services/execution-blocker.js";

/** adopt-stopu r2 (rf-4 ii): lines a person must NOT see after an ordinary
 * Stop in U's shape. The exact existing producers:
 * - "new task": execution-blocker.ts:326 (NEW_TASK_CONTINUE_ACTION), :482, :485;
 *   recovery/unanswered-person-message.ts:92, :94, :772; chat-channels.ts:2083.
 * - "did not finish": native-runtime/held-predecessor-notice-text.ts:1 (HELD_PREDECESSOR_NOTICE).
 * - "will start automatically": explicit-native-continuation.ts:336, :388, :396,
 *   :435, :561, :573, :576, :578, :589, :590, :601; execution-projection.ts:600. */
export const STOP_ABSENT_LINES = ["new task", "did not finish", "will start automatically"] as const;

/** Everything the person's transcript and notices are built from for one
 * task: the runs' events (transcript rows, provider notices), the task's
 * comments, its recovery actions' next action, the execution blocker and the
 * wake rows (the admission's blocked/refused line). */
export async function personFacingText(db: Db, companyId: string, issueId: string) {
  const [events, comments, actions, blocker, wakes] = await Promise.all([
    db.select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.companyId, companyId)),
    db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId)),
    db.select({ nextAction: issueRecoveryActions.nextAction }).from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId)),
    getExecutionBlocker(db, companyId, issueId),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
  ]);
  return { sources: { events: events.length, comments: comments.length, actions: actions.length,
    blocker: blocker !== null, wakes: wakes.length },
  text: JSON.stringify({ events, comments, actions, blocker, wakes }).toLowerCase() };
}

/** The absent lines actually found (expected: none). */
export async function stopAbsentLinesFound(db: Db, companyId: string, issueId: string) {
  const { text } = await personFacingText(db, companyId, issueId);
  return STOP_ABSENT_LINES.filter(line => text.includes(line));
}
