import type { Db } from "@paperclipai/db";
import { forbidden, HttpError } from "../errors.js";
import { assertCanManageSubordinateAgent } from "./agent-subtree-management.js";
import type { AuthorizationActor } from "./authorization.js";

/** The agent half of task Retry (#21271). An agent may retry only a non-chat
 * task assigned to itself, or to an agent in its current reporting subtree under
 * the same direct authority as agent lifecycle controls. Chat stays owner-only. */
export const AGENT_TASK_RETRY_DENIED =
  "Agents may retry only a task assigned to themselves or to an agent they manage.";
export async function assertAgentTaskRetryAllowed(db: Db, actor: AuthorizationActor, issue: {
  companyId: string; assigneeAgentId: string | null; conversationAgentId?: string | null;
}) {
  if (actor.type !== "agent") throw forbidden(AGENT_TASK_RETRY_DENIED);
  if (issue.conversationAgentId) throw forbidden("Only the conversation owner can retry a chat run");
  if (!actor.agentId || actor.companyId !== issue.companyId || !issue.assigneeAgentId)
    throw forbidden(AGENT_TASK_RETRY_DENIED);
  if (issue.assigneeAgentId === actor.agentId) return;
  try {
    await assertCanManageSubordinateAgent(db, actor, { id: issue.assigneeAgentId, companyId: issue.companyId });
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) throw forbidden(AGENT_TASK_RETRY_DENIED);
    throw error;
  }
}
