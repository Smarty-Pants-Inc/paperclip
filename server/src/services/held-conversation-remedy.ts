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
  constructor(readonly admitted: boolean) { super("held-conversation remedy probe rollback"); }
}

/**
 * The ONE text choice for both held-banner writers (the executor's
 * held-predecessor notice and the unanswered sweep's held family). A posted
 * notice is never refreshed, so its remedy must stay true: by default it is
 * the new task, which works in every held state. "Send a new message" is named
 * only when the comment route's own explicit native continuation admission
 * (admitExplicitNativeContinuation, the gate a new composer message meets on
 * this conversation) admits a new message from the conversation's person now.
 * The predicate is CALLED, never copied: its dry run weighs a message sent
 * now without writing one, inside a read-only transaction that is rolled
 * back. Any doubt (no person, no assignee, an error) keeps the default.
 */
export async function heldConversationRemedy(db: Db, input: { companyId: string; issueId: string }): Promise<HeldConversationRemedy> {
  try {
    const [issue] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
    if (!issue?.assigneeAgentId) return NEW_TASK;
    const [person] = await db.select({ userId: issueComments.authorUserId }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "user"), isNotNull(issueComments.authorUserId), isNull(issueComments.deletedAt),
      isNull(issueComments.createdByRunId),
    )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
    if (!person?.userId) return NEW_TASK;
    const { admitExplicitNativeContinuation } = await import("./explicit-native-continuation.js");
    const agentId = issue.assigneeAgentId; const actorId = person.userId;
    try {
      // A pure read: no message is written; the admission weighs one sent now.
      // Read-only (also as a savepoint in a writer's transaction), Postgres
      // refuses any write, and it is always rolled back.
      await db.transaction(async tx => {
        await tx.execute(sql`set transaction read only`);
        const admitted = await admitExplicitNativeContinuation({ db: tx as unknown as Db, companyId: input.companyId,
          issueId: input.issueId, agentId, actorType: "user", actorId, reason: "issue_commented",
          commentId: randomUUID(), prospectiveMessageAt: new Date(), successorRunId: randomUUID(), dryRun: true });
        throw new ProbeRollback(Boolean(admitted));
      });
    } catch (outcome) {
      if (outcome instanceof ProbeRollback) return outcome.admitted ? SEND : NEW_TASK;
      throw outcome;
    }
    return NEW_TASK;
  } catch {
    return NEW_TASK;
  }
}
