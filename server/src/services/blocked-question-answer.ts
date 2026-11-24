import { and, eq, exists, gte, inArray, isNotNull, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueQuestionResponseDeliveries, issueThreadInteractions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { queuedInteractionId } from "./queued-interaction-response.js";
import { ordinaryQuestionCondition } from "./issue-question-context.js";
import { NATIVE_AGENT_BLOCKER_HANDOFF_CODE } from "./native-runtime/native-agent-blocker.js";
import { NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE } from "./native-runtime/native-environment-blocker.js";

const BOARD_BOUND_BLOCKER_REASON_CODES = [NATIVE_AGENT_BLOCKER_HANDOFF_CODE, NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE];
const AGENT_REPORTED_BLOCKER_REASON_CODES = ["current_track_blocker_waiting", "task_wide_blocker_bound", ...BOARD_BOUND_BLOCKER_REASON_CODES];
const PERSON_RESOLVED_BLOCKER_OWNER_KINDS = ["user", "board", "external", "unspecified"];

export type AgentBlockingQuestionState = { lastStatusDecisionId: string; statusVersion: number };

export async function questionsAwaitedByAgentBlock(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string | null | undefined; reasonCode: string | null;
  toStatus: string; unblockOwner: unknown; blockerOwnerKind?: string;
  runId?: string; runStartedAt?: Date | null;
}): Promise<string[]> {
  const personResolves = input.blockerOwnerKind === undefined || BOARD_BOUND_BLOCKER_REASON_CODES.includes(input.reasonCode ?? "")
    ? input.unblockOwner === "board"
    : PERSON_RESOLVED_BLOCKER_OWNER_KINDS.includes(input.blockerOwnerKind);
  if (!input.agentId || input.toStatus !== "blocked" || !personResolves
    || !AGENT_REPORTED_BLOCKER_REASON_CODES.includes(input.reasonCode ?? "")) return [];
  // A successor can still be waiting on a card that was answered after its
  // input baseline. Preserve that exact card's binding, not all old answers.
  // The durable response must remain owed: neither native delivery/steering
  // to this run nor a started continuation may have consumed it already.
  const answeredDuringRun = input.runId && input.runStartedAt ? and(
    eq(issueThreadInteractions.status, "answered"),
    isNotNull(issueThreadInteractions.resolvedByUserId),
    lte(issueThreadInteractions.createdAt, input.runStartedAt),
    gte(issueThreadInteractions.resolvedAt, input.runStartedAt),
    exists(db.select({ id: issueQuestionResponseDeliveries.id }).from(issueQuestionResponseDeliveries).where(and(
      eq(issueQuestionResponseDeliveries.companyId, input.companyId),
      eq(issueQuestionResponseDeliveries.issueId, input.issueId),
      eq(issueQuestionResponseDeliveries.interactionId, issueThreadInteractions.id),
      sql`${issueQuestionResponseDeliveries.sourceRunId} is not distinct from ${issueThreadInteractions.sourceRunId}`,
      sql`${issueQuestionResponseDeliveries.targetRunId} is distinct from ${input.runId}`,
      or(isNull(issueQuestionResponseDeliveries.deliveryMode), ne(issueQuestionResponseDeliveries.deliveryMode, "steered")),
    ))),
    notExists(db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
      sql`${heartbeatRuns.contextSnapshot}->>'interactionId' = ${issueThreadInteractions.id}::text`,
      sql`${heartbeatRuns.contextSnapshot}->>'interactionStatus' = 'answered'`,
      isNotNull(heartbeatRuns.startedAt),
      inArray(heartbeatRuns.status, ["running", "succeeded"]),
    ))),
  ) : undefined;
  const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.createdByAgentId, input.agentId),
    or(eq(issueThreadInteractions.status, "pending"), answeredDuringRun),
    isNull(issueThreadInteractions.dismissedAt),
    ordinaryQuestionCondition(),
  ));
  return rows.map((row) => row.id).sort();
}

export async function agentBlockingQuestionState(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown;
}): Promise<AgentBlockingQuestionState | null> {
  const interactionId = queuedInteractionId(input.context);
  if (!interactionId) return null;
  const interactionStatus = (input.context as Record<string, unknown>).interactionStatus;
  const [row] = await db
    .select({ lastStatusDecisionId: statusDecisions.id, statusVersion: issues.statusVersion })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, issues.lastStatusDecisionId),
      eq(statusDecisions.companyId, issues.companyId),
      eq(statusDecisions.issueId, issues.id),
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, statusDecisions.runId),
      eq(heartbeatRuns.companyId, statusDecisions.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.createdByAgentId, input.agentId),
      eq(issueThreadInteractions.status, String(interactionStatus)),
      isNotNull(issueThreadInteractions.resolvedByUserId),
      isNotNull(issueThreadInteractions.resolvedAt),
      eq(issues.status, "blocked"),
      eq(issues.assigneeAgentId, input.agentId),
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.toStatus, "blocked"),
      inArray(statusDecisions.reasonCode, AGENT_REPORTED_BLOCKER_REASON_CODES),
      sql`coalesce(${statusDecisions.decisionJson}->'awaitingInteractionIds', '[]'::jsonb) ? ${interactionId}`,
      sql`${statusDecisions.decisionJson}->>'projectedStatusVersion' = ${issues.statusVersion}::text`,
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .limit(1);
  return row ? { lastStatusDecisionId: row.lastStatusDecisionId, statusVersion: Number(row.statusVersion) } : null;
}
