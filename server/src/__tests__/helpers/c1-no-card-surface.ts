import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { taskInterruptionPresentation } from "../../services/task-interruption-presentation.js";

/**
 * C1 record SUPERSEDE-C1-NOSTOP-CARD-1118 condition (2): a flipped 'no card' row
 * must also show what the person sees INSTEAD of the card, never silence.
 * The task API's interruption presentation drives ExecutionBlockerNotice.tsx
 * (:133-155): a system 'failed' state renders "Couldn't finish this attempt.
 * Your message is saved." with Retry when canRetry; 'working', 'retry_scheduled'
 * and 'waiting_for_user' render their own visible line. Otherwise the person sees
 * the observed run's delivered answer (it succeeded), the closed task, or exactly
 * one note. Anything else is silence and fails.
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
    : presentation?.state === "resolved" && observed?.status === "succeeded" ? "delivered_answer"
    : "silent";
  expect(surface, `presentation=${JSON.stringify(presentation)} notes=${notes.length}`).not.toBe("silent");
  if (process.env.C1_SURFACE_LOG) console.log(`C1_SURFACE ${surface}`);
  return surface;
}
