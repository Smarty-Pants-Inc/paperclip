import type { Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { companyMemberships, issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "../services/run-identity.js";

/** Privacy requires the current run's person's own act, not inherited responsibility. */
export async function privateRequestActor(
  db: Db, actor: Request["actor"], companyId: string, resource: "task" | "project",
): Promise<Request["actor"]> {
  if (actor.type !== "agent") return actor;
  const refusal = `Cannot make a ${resource} private: a person must ask for it through the current run`;
  if (actor.source !== "agent_jwt" || !actor.runId || !actor.agentId || actor.companyId !== companyId) {
    throw forbidden(refusal);
  }
  const identity = await captureRunIdentity(db, {
    companyId, agentId: actor.agentId, runId: actor.runId,
  }, { readScope: "identity" });
  const context = identity.context;
  const userId = context?.responsibleUserId;
  if (!context || !userId || userId !== actor.onBehalfOfUserId || context.cause === "company_default") throw forbidden(refusal);
  if (context.cause !== "manual_user_wake") {
    if (!context.messageId) throw forbidden(refusal);
    const [act] = await db.select({ userId: issueComments.authorUserId }).from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), eq(issueComments.id, context.messageId),
        eq(issueComments.authorUserId, userId),
        sql`${["instruction", "steering", "queued_comment_interrupt"].includes(context.cause)}`))
      .unionAll(db.select({ userId: issueThreadInteractions.resolvedByUserId }).from(issueThreadInteractions)
        .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.id, context.messageId),
          eq(issueThreadInteractions.resolvedByUserId, userId)))).limit(1);
    if (!act) throw forbidden(refusal);
  }
  if (userId === "local-board") {
    return { type: "board", userId, companyIds: [companyId], source: "local_implicit" };
  }
  const [membership] = await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))).limit(1);
  if (!membership) throw forbidden("The person requesting private work must be an active company member");
  // This projection is used only for privacy checks; the write remains an agent action.
  return { type: "board", userId, companyIds: [companyId], source: "session" };
}
