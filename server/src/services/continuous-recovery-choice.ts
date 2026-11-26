import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agentTaskSessions, chatConversations, chatMessageLinks, heartbeatRuns, issueComments,
  issueRecoveryActions, issueThreadInteractions, issues, type agents, type Db,
} from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { isConversation } from "../lib/conversation-wake-policy.js";
import { resolveSessionContinuity } from "./native-runtime/continued-session.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

export const CONTINUOUS_RECOVERY_TITLE = "Choose how to continue this conversation";
export const CONTINUOUS_RECOVERY_PROMPT = "Same-session continuation is blocked. Your conversation history, recorded work, saved-file recovery records and pending messages are preserved. Unsaved files have not been verified. No further attempt will use the unchanged session. Choose Retry fresh / New session to start a new session from the saved conversation and verified work; this does not resume the old session or replay its actions.";
const PREFIX = "continuous-recovery:";
type Task = typeof issues.$inferSelect;
type Agent = Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "adapterConfig">;
type Question = typeof issueThreadInteractions.$inferSelect;

export function usesContinuousSession(agent: Agent, issue: Task, effectiveConfig?: Record<string, unknown>) {
  const config = effectiveConfig ?? { ...parseObject(agent.adapterConfig),
    ...parseObject(parseObject(issue.assigneeAdapterOverrides).adapterConfig) };
  return agent.adapterType === "paperclip_runner" && config.provider === "pi_rpc" &&
    resolveSessionContinuity(config.provider, config.sessionContinuity) === "continuous";
}

/** A refresh/plan/tool-loop flag is not a stock recovery decision. */
export async function isStockFreshRecovery(db: Db, issue: Pick<Task, "id" | "companyId">, context: Record<string, unknown>) {
  if (context.forceFreshSession !== true) return false;
  const source = typeof context.previousRunId === "string" ? context.previousRunId
    : typeof context.retryOfRunId === "string" ? context.retryOfRunId : null;
  const action = typeof context.recoveryActionId === "string" ? context.recoveryActionId : null;
  if (!source && !action) return false;
  const [record] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    action ? sql`${issueRecoveryActions.id}::text = ${action}` : undefined,
    or(inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`),
    source ? or(sql`${issueRecoveryActions.evidence}->>'runId' = ${source}`,
      sql`${issueRecoveryActions.evidence}#>>'{executionReconciliation,runId}' = ${source}`,
      sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${source}`) : undefined,
  )).limit(1);
  return Boolean(record);
}

/** Server-owned identity, not the author of a recovery wake, establishes isolation permission. */
async function recoveryScope(db: Db, issue: Task, agent: Agent, context: Record<string, unknown>) {
  const connected = await db.select({ id: chatConversations.id, generation: chatConversations.sessionGeneration })
    .from(chatConversations).where(and(eq(chatConversations.companyId, issue.companyId), eq(chatConversations.issueId, issue.id)));
  const [session] = await db.select().from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, issue.companyId), eq(agentTaskSessions.agentId, agent.id),
    eq(agentTaskSessions.adapterType, agent.adapterType),
    eq(agentTaskSessions.taskKey, issue.id),
  )).limit(1);
  const [personInput] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
  )).limit(1);
  const chatProvenance = connected.length > 0 || Boolean(context.chatConversationId || context.chatFailedRunRetry) ||
    (typeof context.source === "string" && context.source.startsWith("chat:"));
  const agentOnly = !isConversation(issue) && !issue.conversationAgentId && !issue.conversationUserId && !chatProvenance &&
    !personInput && !issue.createdByUserId && Boolean(issue.createdByAgentId || issue.originKind === "routine_execution");
  let personId = isConversation(issue) ? issue.conversationUserId : null;
  if (!personId && connected.length) {
    // A linked inbound comment carries the authenticated sender. A channel's
    // endpoint owner or the task's responsible user is not its speaker.
    const speakers = await db.selectDistinct({ userId: issueComments.authorUserId }).from(chatMessageLinks)
      .innerJoin(issueComments, and(eq(issueComments.companyId, chatMessageLinks.companyId), eq(issueComments.id, chatMessageLinks.commentId)))
      .where(and(eq(chatMessageLinks.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
        eq(chatMessageLinks.direction, "inbound"), isNull(issueComments.deletedAt),
        sql`${chatMessageLinks.conversationId} = any(${sql.param(connected.map(row => row.id))}::uuid[])`));
    const people = [...new Set(speakers.flatMap(row => row.userId ? [row.userId] : []))];
    if (people.length === 1) personId = people[0]!;
  }
  const scope = PREFIX + createHash("sha256").update(JSON.stringify([
    issue.id, agent.id, issue.conversationSessionGeneration,
    connected.map(row => [row.id, row.generation]).sort(), session?.id ?? null,
    session?.sessionParamsJson?.sessionId ?? session?.sessionDisplayId ?? null,
  ])).digest("hex");
  return { scope, agentOnly, personId, sourceRunId: session?.lastRunId ?? null };
}

function acceptedByPerson(question: Question, personId: string | null) {
  return Boolean(personId && question.addresseeUserId === personId && question.resolvedByUserId === personId &&
    !question.resolvedByAgentId && question.status === "accepted" && parseObject(question.result).outcome === "accepted");
}

/** Call under the issue lock, before recording/delivering a stock fresh recovery. */
export async function continuousRecoveryDecision(db: Db, input: {
  issue: Task; agent: Agent; context?: Record<string, unknown>; sourceRunId?: string; create?: boolean;
  effectiveConfig?: Record<string, unknown>;
}): Promise<{ kind: "unchanged" } | { kind: "agent_only" } | { kind: "choice"; question: Question; accepted: boolean } |
  { kind: "blocked"; reason: string }> {
  if (!usesContinuousSession(input.agent, input.issue, input.effectiveConfig)) return { kind: "unchanged" };
  const { scope, agentOnly, personId, sourceRunId } = await recoveryScope(db, input.issue, input.agent, input.context ?? {});
  const [question] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.issue.companyId), eq(issueThreadInteractions.issueId, input.issue.id),
    eq(issueThreadInteractions.idempotencyKey, scope), eq(issueThreadInteractions.kind, "request_confirmation"),
  )).limit(1);
  if (question) return { kind: "choice", question, accepted: acceptedByPerson(question, personId) };
  if (agentOnly) return { kind: "agent_only" };
  if (!input.create) return { kind: "unchanged" };
  if (!personId) return { kind: "blocked", reason: "continuous_recovery_person_unproven" };
  const source = input.sourceRunId ?? sourceRunId;
  if (!source) return { kind: "blocked", reason: "continuous_recovery_source_missing" };
  const [sourceRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.issue.companyId), eq(heartbeatRuns.id, source), eq(heartbeatRuns.agentId, input.agent.id),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issue.id}`,
  ));
  if (!sourceRun) return { kind: "blocked", reason: "continuous_recovery_source_changed" };
  await issueThreadInteractionService(db).create(input.issue, {
    kind: "request_confirmation", resolverPolicy: "human_only", continuationPolicy: "wake_assignee",
    addresseeUserId: personId, idempotencyKey: scope, title: CONTINUOUS_RECOVERY_TITLE,
    summary: CONTINUOUS_RECOVERY_PROMPT,
    payload: { version: 1, prompt: CONTINUOUS_RECOVERY_PROMPT, acceptLabel: "Retry fresh / New session",
      rejectLabel: "Keep paused", supersedeOnUserComment: false,
      target: { type: "custom", key: scope, revisionId: source, label: "Conversation session recovery" } },
  }, {}, { supersedePendingSiblingInteractions: false });
  const [created] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.issue.companyId), eq(issueThreadInteractions.issueId, input.issue.id),
    eq(issueThreadInteractions.idempotencyKey, scope),
  ));
  return { kind: "choice", question: created!, accepted: false };
}

export function recoveryChoiceSource(question: Question): string | null {
  const target = parseObject(parseObject(question.payload).target);
  return typeof target.revisionId === "string" ? target.revisionId : null;
}

/** The last defensive door: never turn a stock fresh recovery into retained replay. */
export async function prepareContinuousRecoverySession(db: Db, input: {
  companyId: string; issueId: string; agent: Agent; context: Record<string, unknown>; runId: string;
  effectiveConfig: Record<string, unknown>;
}) {
  const prepared = await db.transaction(async raw => {
    const tx = raw as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    if (!issue || !usesContinuousSession(input.agent, issue, input.effectiveConfig)) return false;
    if ((input.context.explicitFreshSession === true || input.context.conversationReset === true) &&
        !input.context.continuousRecoveryChoiceId) return false;
    const fresh = await isStockFreshRecovery(tx, issue, input.context);
    const decision = await continuousRecoveryDecision(tx, { issue, agent: input.agent, context: input.context,
      effectiveConfig: input.effectiveConfig, create: fresh,
      sourceRunId: typeof input.context.previousRunId === "string" ? input.context.previousRunId : undefined });
    if (decision.kind === "agent_only") return fresh;
    if (decision.kind === "unchanged") return false;
    if (decision.kind === "blocked" || !decision.accepted) return "pending" as const;
    const result = parseObject(decision.question.result);
    if (!fresh || input.context.continuousRecoveryChoiceId !== decision.question.id ||
        (result.freshSessionDispatchRunId && result.freshSessionDispatchRunId !== input.runId)) {
      return "wrong_delivery" as const;
    }
    // The issue lock serializes consumption. This internal receipt stays on
    // the existing interaction result, beside the person's accepted answer.
    await tx.update(issueThreadInteractions).set({ result: sql`coalesce(${issueThreadInteractions.result}, '{}'::jsonb) ||
      ${JSON.stringify({ freshSessionDispatchRunId: input.runId })}::jsonb` }).where(and(
      eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.id, decision.question.id),
      eq(issueThreadInteractions.status, "accepted"), eq(issueThreadInteractions.resolvedByUserId, decision.question.addresseeUserId!),
    ));
    return true;
  });
  // Commit a newly created question before refusing dispatch; throwing inside
  // the transaction would silently discard the person's only decision surface.
  if (prepared === "pending") throw conflict(CONTINUOUS_RECOVERY_PROMPT, { code: "continuous_recovery_choice_pending" });
  if (prepared === "wrong_delivery") throw conflict("The recorded fresh-session choice must be delivered through its recovery continuation.", {
    code: "continuous_recovery_choice_pending",
  });
  return prepared;
}
