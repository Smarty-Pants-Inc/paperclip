import { agents, companies, heartbeatRuns, issueAttachments, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isLowTrustQuarantined } from "../source-trust.js";
import { authorizationService, type AuthorizationActor } from "../authorization.js";
import { budgetServiceInTransaction } from "../budgets.js";
import { evaluateIssueThreadInteractionResolverAudience } from "../issue-thread-interaction-resolution.js";
import { isIssueReviewVerdictInteraction, resolveIssueReviewRequester } from "../issue-review-policy.js";
import { nativeRunKeyScope } from "./native-skill-test-scope.js";

export type NativeAddressedInteractionBinding = {
  companyId: string; issueId: string; agentId: string; runId: string;
};
export type NativeAddressedInteractionGrant = NativeAddressedInteractionBinding & {
  interaction: typeof issueThreadInteractions.$inferSelect;
};

export function readNativeAddressedInteractionId(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Record<string, unknown>;
  return value.wakeReason === "interaction_pending"
    && typeof value.interactionId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.interactionId)
    && !value.nativeReviewInteractionId
    ? value.interactionId : null;
}

export async function getNativeAddressedInteractionGrant(db: Db, binding: NativeAddressedInteractionBinding, options: {
  requireRunning?: boolean;
  phase?: "pending" | "settlement" | "resolved";
  expectedStatus?: "accepted" | "rejected";
} = {}): Promise<NativeAddressedInteractionGrant | null> {
  const [row] = await db.select({ run: {
    runtimeMode: heartbeatRuns.runtimeMode, status: heartbeatRuns.status,
    contextSnapshot: heartbeatRuns.contextSnapshot, responsibleUserId: heartbeatRuns.responsibleUserId,
  }, issue: {
    id: issues.id, companyId: issues.companyId, status: issues.status, hiddenAt: issues.hiddenAt,
    workMode: issues.workMode, reviewPolicy: issues.reviewPolicy,
    createdByAgentId: issues.createdByAgentId, createdByUserId: issues.createdByUserId,
  }, agent: { status: agents.status }, company: { status: companies.status } })
    .from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, heartbeatRuns.nativeIssueId), eq(issues.companyId, heartbeatRuns.companyId)))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId))).limit(1);
  if (!row || row.run.runtimeMode !== "native"
    || !(options.phase === "resolved" ? ["running", "succeeded", "failed"]
      : options.requireRunning === false ? ["queued", "running"] : ["running"]).includes(row.run.status)
    || ["paused", "terminated", "pending_approval", "error"].includes(row.agent.status)
    || row.company.status !== "active") return null;
  const interactionId = readNativeAddressedInteractionId(row.run.contextSnapshot);
  if (!interactionId) return null;
  const [interaction] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId))).limit(1);
  if (!interaction || interaction.kind !== "request_confirmation" || interaction.addresseeAgentId !== binding.agentId
    || interaction.addresseeUserId) return null;
  const payload = interaction.payload as unknown as Record<string, unknown> | null;
  if (!payload || payload.target != null || payload.toolAction !== undefined || payload.secretProposal !== undefined) return null;
  const phase = options.phase ?? "pending";
  if (interaction.status === "pending") {
    if (phase === "resolved" || ["done", "cancelled"].includes(row.issue.status) || row.issue.hiddenAt) return null;
  } else if (phase === "pending" || !["accepted", "rejected"].includes(interaction.status)
    || interaction.resolvedByAgentId !== binding.agentId || interaction.resolvedByRunId !== binding.runId
    || (options.expectedStatus && interaction.status !== options.expectedStatus)) return null;
  let additionalRestriction: Parameters<typeof evaluateIssueThreadInteractionResolverAudience>[0]["additionalRestriction"];
  if (row.issue.status === "in_review" && await isIssueReviewVerdictInteraction(db, { issue: row.issue, interaction })) {
    const requester = await resolveIssueReviewRequester(db, row.issue);
    additionalRestriction = { policy: row.issue.reviewPolicy ?? "anyone", source: "issue_review",
      excludedActor: row.issue.reviewPolicy === "not_creator" && requester ? { type: requester.type, id: requester.id } : null };
  }
  if (!evaluateIssueThreadInteractionResolverAudience({ interaction, additionalRestriction,
    actor: { type: "agent", agentId: binding.agentId, runId: binding.runId },
    governedAction: payload.toolAction !== undefined || payload.secretProposal !== undefined }).allowed) return null;
  const actor: AuthorizationActor = { type: "agent", companyId: binding.companyId, agentId: binding.agentId,
    runId: binding.runId, source: "agent_jwt", onBehalfOfUserId: row.run.responsibleUserId,
    keyScope: nativeRunKeyScope({ ...binding, contextSnapshot: row.run.contextSnapshot, workMode: row.issue.workMode }) };
  for (const action of ["issue:read", "issue:mutate"] as const) {
    if (!(await authorizationService(db).decide({ actor, action,
      resource: { type: "issue", companyId: binding.companyId, issueId: binding.issueId } })).allowed) return null;
  }
  if (await budgetServiceInTransaction(db).getInvocationBlock(binding.companyId, binding.agentId,
    { issueId: binding.issueId, runId: binding.runId, admittedRecovery: true })) return null;
  return { ...binding, interaction };
}

export async function getNativeAddressedInteractionAttachmentSelections(db: Db, binding: NativeAddressedInteractionBinding, options: {
  requireRunning?: boolean;
} = {}): Promise<Array<{ id: string; commentId: string }> | null> {
  const grant = await getNativeAddressedInteractionGrant(db, binding, options);
  if (!grant) return null;
  const commentIds = [...new Set([grant.interaction.sourceCommentId,
    ...(Array.isArray(grant.interaction.originCommentIds) ? grant.interaction.originCommentIds : []),
  ].filter((id): id is string => typeof id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))];
  if (commentIds.length === 0) return [];
  const rows = await db.select({ id: issueAttachments.id, commentId: issueComments.id, sourceTrust: issueComments.sourceTrust })
    .from(issueAttachments)
    .innerJoin(issueComments, and(eq(issueComments.id, issueAttachments.issueCommentId),
      eq(issueComments.companyId, binding.companyId), eq(issueComments.issueId, binding.issueId), isNull(issueComments.deletedAt)))
    .where(and(eq(issueAttachments.companyId, binding.companyId), eq(issueAttachments.issueId, binding.issueId),
      inArray(issueAttachments.issueCommentId, commentIds)))
    .orderBy(issueAttachments.createdAt, issueAttachments.id);
  return rows.filter(row => !isLowTrustQuarantined(row.sourceTrust))
    .map(row => ({ id: row.id, commentId: row.commentId }));
}

export const NATIVE_ADDRESSED_INTERACTION_TOOLS = new Set([
  "get_task_context", "get_task_history", "list_documents", "read_document", "list_document_revisions", "read_current_wake_comments", "search_api", "call_api",
]);

export function addressedInteractionResponseStatus(grant: NativeAddressedInteractionGrant, operation: { method: string; path: string }, input: {
  pathParams?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; files?: unknown[]; contentType?: string; saveResponse?: boolean;
}): "accepted" | "rejected" | null {
  const decision = operation.path === "/api/issues/{id}/interactions/{interactionId}/accept" ? "accepted"
    : operation.path === "/api/issues/{id}/interactions/{interactionId}/reject" ? "rejected" : null;
  if (operation.method !== "POST" || !decision || input.pathParams?.id !== grant.issueId
    || input.pathParams?.interactionId !== grant.interaction.id
    || Object.keys(input.pathParams ?? {}).some(key => !["id", "interactionId"].includes(key))
    || Object.keys(input.query ?? {}).length || input.files?.length || input.saveResponse
    || (input.contentType !== undefined && input.contentType !== "application/json")) return null;
  const body = input.body ?? {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some(key => key !== "reason")) return null;
  const reason = (body as { reason?: unknown }).reason;
  if (reason !== undefined && typeof reason !== "string") return null;
  return decision;
}
