import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { issueComments, issues, type Db } from "@paperclipai/db";
import {
  HELD_PREDECESSOR_NEW_TASK_ACTION, HELD_PREDECESSOR_NOTICE, HELD_PREDECESSOR_SEND_ACTION, HELD_PREDECESSOR_SEND_NOTICE,
} from "./native-runtime/held-predecessor-notice-text.js";

export type HeldConversationRemedy = { body: string; nextAction: string; newMessageAdmitted: boolean };

const NEW_TASK: HeldConversationRemedy = {
  body: HELD_PREDECESSOR_NOTICE, nextAction: HELD_PREDECESSOR_NEW_TASK_ACTION, newMessageAdmitted: false };
const SEND: HeldConversationRemedy = {
  body: HELD_PREDECESSOR_SEND_NOTICE, nextAction: HELD_PREDECESSOR_SEND_ACTION, newMessageAdmitted: true };

class ProbeRollback extends Error {
  constructor(readonly decision: NewMessageDecision) { super("held-conversation remedy probe rollback"); }
}

type NewMessageDecision = { blocked: boolean; admitted: boolean };

/**
 * The ONE pure read of how this conversation's admission decides a new
 * message from its person sent now. It CALLS the deciders dispatch calls for a
 * person's comment wake (heartbeat/queue.ts): getExecutionBlocker, then
 * admitExplicitNativeContinuation, never a copy. Dispatch defers that wake
 * when there is a blocker and the admission does not admit it. On the legacy
 * runtime (process/local adapters) the admission never admits, so the blocker
 * (e.g. active_run_watchdog's legacy_execution_requires_reconciliation) alone
 * decides. The admission's dry run weighs a message sent now without writing
 * one, inside a read-only transaction that is always rolled back. With no
 * assignee or no person there is nothing to admit (admitted: false). An error
 * returns null (doubt).
 */
async function decideNewMessage(db: Db, input: { companyId: string; issueId: string }): Promise<NewMessageDecision | null> {
  try {
    const [issue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
    if (!issue) return null;
    const [person] = await db.select({ userId: issueComments.authorUserId }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "user"), isNotNull(issueComments.authorUserId), isNull(issueComments.deletedAt),
      isNull(issueComments.createdByRunId),
    )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
    const { admitExplicitNativeContinuation } = await import("./explicit-native-continuation.js");
    const { getExecutionBlocker } = await import("./execution-blocker.js");
    const agentId = issue.assigneeAgentId; const actorId = person?.userId;
    try {
      // A pure read: no message is written; the admission weighs one sent now.
      // Read-only (also as a savepoint in a writer's transaction), Postgres
      // refuses any write, and it is always rolled back.
      await db.transaction(async tx => {
        await tx.execute(sql`set transaction read only`);
        const blocker = await getExecutionBlocker(tx as unknown as Db, input.companyId, input.issueId);
        // No assignee or no person: nothing to admit (the held remedy keeps its default).
        const admitted = agentId && actorId ? await admitExplicitNativeContinuation({ db: tx as unknown as Db,
          companyId: input.companyId, issueId: input.issueId, agentId, actorType: "user", actorId, reason: "issue_commented",
          commentId: randomUUID(), prospectiveMessageAt: new Date(), successorRunId: randomUUID(), dryRun: true }) : null;
        throw new ProbeRollback({ blocked: Boolean(blocker), admitted: Boolean(admitted) });
      });
    } catch (outcome) {
      if (outcome instanceof ProbeRollback) return outcome.decision;
      throw outcome;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The ONE text choice for both held-banner writers (the executor's
 * held-predecessor notice and the unanswered sweep's held family). A posted
 * notice is never refreshed, so its remedy must stay true: by default it is
 * the new task, which works in every held state. "Send a new message" is named
 * only when the comment route's own explicit native continuation admission
 * (admitExplicitNativeContinuation, the gate a new composer message meets on
 * this conversation) admits a new message from the conversation's person now,
 * and even then it is hedged with the new task (a later hold may defer it).
 */
export async function heldConversationRemedy(db: Db, input: { companyId: string; issueId: string }): Promise<HeldConversationRemedy> {
  return (await decideNewMessage(db, input))?.admitted ? SEND : NEW_TASK;
}

/**
 * Whether a new message sent now would run: dispatch's own rule, no blocker
 * or an admitted continuation. The unanswered sweep's "sending it again is
 * safe" notices name that remedy only when this is true; otherwise the
 * remedy is the new task. Any doubt answers false.
 */
export async function newMessageWouldRun(db: Db, input: { companyId: string; issueId: string }): Promise<boolean> {
  const decision = await decideNewMessage(db, input);
  return Boolean(decision && (!decision.blocked || decision.admitted));
}
