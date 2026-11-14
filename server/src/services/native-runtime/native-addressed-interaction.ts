import { agents, companies, heartbeatRuns, issueAttachments, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isLowTrustQuarantined } from "../source-trust.js";
import { authorizationService, type AuthorizationActor } from "../authorization.js";
import { budgetServiceInTransaction } from "../budgets.js";
import { evaluateIssueThreadInteractionResolverAudience } from "../issue-thread-interaction-resolution.js";
import { getSameIssueDocumentConfirmationTargetRefusal, type SameIssueDocumentConfirmationTargetRefusal } from "../issue-thread-interactions.js";
import { isIssueReviewVerdictInteraction, resolveIssueReviewRequester } from "../issue-review-policy.js";
import { nativeRunKeyScope } from "./native-skill-test-scope.js";
import { readNativeReviewAssignmentContext } from "./native-review-participant.js";

export type NativeAddressedInteractionBinding = {
  companyId: string; issueId: string; agentId: string; runId: string;
};
export type NativeAddressedInteractionGrant = NativeAddressedInteractionBinding & {
  interaction: typeof issueThreadInteractions.$inferSelect;
};
export type NativeAddressedInteractionGrantOptions = {
  requireRunning?: boolean;
  phase?: "pending" | "settlement" | "resolved";
  expectedStatus?: "accepted" | "rejected";
};
export type NativeAddressedInteractionRefusalReason =
  | "binding_not_found" | "runtime_mode" | "context_issue" | "native_issue" | "run_status"
  | "agent_status" | "company_status" | "interaction_context" | "interaction_not_found"
  | "interaction_kind" | "addressee_agent" | "addressee_user" | "source_run_binding"
  | "source_run_not_found" | "source_run_issue" | "source_run_creator" | "payload_missing"
  | "target" | "tool_action" | "secret_proposal" | "pending_in_resolved_phase"
  | "issue_closed" | "issue_hidden" | "interaction_not_pending" | "interaction_not_resolvable"
  | "resolved_agent" | "resolved_run" | "resolved_status" | "audience" | "issue_read" | "issue_mutate" | "budget";
export type NativeAddressedInteractionRefusal = {
  reason: NativeAddressedInteractionRefusalReason;
  interactionId: string | null;
  audienceCode?: Extract<ReturnType<typeof evaluateIssueThreadInteractionResolverAudience>, { allowed: false }>["code"];
  status?: string;
  reviewRequesterKnown?: boolean;
  targetReason?: SameIssueDocumentConfirmationTargetRefusal;
};
export type NativeAddressedInteractionGrantDecision =
  | { allowed: true; grant: NativeAddressedInteractionGrant }
  | { allowed: false; refusal: NativeAddressedInteractionRefusal };

/** Carries the authority's first refusal; failure reporting must not decide it again. */
export class NativeAddressedInteractionAdmissionError extends Error {
  readonly binding: NativeAddressedInteractionBinding;
  readonly refusal: NativeAddressedInteractionRefusal;
  constructor(binding: NativeAddressedInteractionBinding, refusal: NativeAddressedInteractionRefusal) {
    super("native_addressed_interaction_no_longer_available");
    this.name = "NativeAddressedInteractionAdmissionError";
    this.binding = { ...binding };
    this.refusal = { ...refusal };
  }
}

export function readNativeAddressedInteractionId(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Record<string, unknown>;
  return value.wakeReason === "interaction_pending"
    && typeof value.interactionId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.interactionId)
    && !value.nativeReviewInteractionId
    ? value.interactionId : null;
}

async function getAddressedInteractionAuthority(db: Db, binding: NativeAddressedInteractionBinding,
  options: NativeAddressedInteractionGrantOptions = {}, requireNativeBinding = true): Promise<NativeAddressedInteractionGrantDecision> {
  let interactionId: string | null = null;
  const refuse = (reason: NativeAddressedInteractionRefusalReason,
    details: Pick<NativeAddressedInteractionRefusal, "audienceCode" | "status" | "reviewRequesterKnown" | "targetReason"> = {}): NativeAddressedInteractionGrantDecision =>
    ({ allowed: false, refusal: { reason, interactionId, ...details } });
  const [row] = await db.select({ run: {
    runtimeMode: heartbeatRuns.runtimeMode, nativeIssueId: heartbeatRuns.nativeIssueId, status: heartbeatRuns.status,
    contextSnapshot: heartbeatRuns.contextSnapshot, responsibleUserId: heartbeatRuns.responsibleUserId,
  }, issue: {
    id: issues.id, companyId: issues.companyId, status: issues.status, hiddenAt: issues.hiddenAt,
    workMode: issues.workMode, reviewPolicy: issues.reviewPolicy,
    createdByAgentId: issues.createdByAgentId, createdByUserId: issues.createdByUserId,
  }, agent: { status: agents.status }, company: { status: companies.status } })
    .from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, requireNativeBinding ? heartbeatRuns.nativeIssueId : binding.issueId), eq(issues.companyId, heartbeatRuns.companyId)))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), requireNativeBinding ? eq(heartbeatRuns.nativeIssueId, binding.issueId) : undefined)).limit(1);
  if (!row) return refuse("binding_not_found");
  if (requireNativeBinding) {
    if (row.run.runtimeMode !== "native") return refuse("runtime_mode");
  } else {
    if (row.run.contextSnapshot?.issueId !== binding.issueId) return refuse("context_issue");
    if (row.run.nativeIssueId !== null && row.run.nativeIssueId !== binding.issueId) return refuse("native_issue");
  }
  if (!(options.phase === "resolved" ? ["running", "succeeded", "failed"]
    : options.requireRunning === false ? ["queued", "running"] : ["running"]).includes(row.run.status)) return refuse("run_status", { status: row.run.status });
  if (["paused", "terminated", "pending_approval", "error"].includes(row.agent.status)) return refuse("agent_status", { status: row.agent.status });
  if (row.company.status !== "active") return refuse("company_status", { status: row.company.status });
  interactionId = readNativeAddressedInteractionId(row.run.contextSnapshot);
  if (!interactionId) return refuse("interaction_context");
  const [interaction] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId))).limit(1);
  if (!interaction) return refuse("interaction_not_found");
  if (interaction.kind !== "request_confirmation") return refuse("interaction_kind");
  if (interaction.addresseeAgentId !== binding.agentId) return refuse("addressee_agent");
  if (interaction.addresseeUserId) return refuse("addressee_user");
  if ((row.run.contextSnapshot?.sourceRunId ?? null) !== interaction.sourceRunId) return refuse("source_run_binding");
  if (interaction.sourceRunId) {
    const [sourceRun] = await db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, interaction.sourceRunId),
        eq(heartbeatRuns.companyId, binding.companyId))).limit(1);
    if (!sourceRun) return refuse("source_run_not_found");
    if ((sourceRun.nativeIssueId ?? sourceRun.issueId ?? sourceRun.contextSnapshot?.issueId) !== binding.issueId) return refuse("source_run_issue");
    if (interaction.createdByAgentId && sourceRun.agentId !== interaction.createdByAgentId) return refuse("source_run_creator");
  }
  const payload = interaction.payload as unknown as Record<string, unknown> | null;
  if (!payload) return refuse("payload_missing");
  if (payload.target != null) {
    const targetReason = await getSameIssueDocumentConfirmationTargetRefusal(db, {
      companyId: binding.companyId, issueId: binding.issueId, target: payload.target,
    });
    if (targetReason && !(targetReason === "revision_changed"
      && (interaction.status === "accepted" || interaction.status === "rejected")
      && (options.phase === "settlement" || options.phase === "resolved"))) return refuse("target", { targetReason });
  }
  if (payload.toolAction !== undefined) return refuse("tool_action");
  if (payload.secretProposal !== undefined) return refuse("secret_proposal");
  const phase = options.phase ?? "pending";
  if (interaction.status === "pending") {
    if (phase === "resolved") return refuse("pending_in_resolved_phase");
    if (["done", "cancelled"].includes(row.issue.status)) return refuse("issue_closed");
    if (row.issue.hiddenAt) return refuse("issue_hidden");
  } else {
    if (phase === "pending") return refuse("interaction_not_pending");
    if (!["accepted", "rejected"].includes(interaction.status)) return refuse("interaction_not_resolvable");
    if (interaction.resolvedByAgentId !== binding.agentId) return refuse("resolved_agent");
    if (interaction.resolvedByRunId !== binding.runId) return refuse("resolved_run");
    if (options.expectedStatus && interaction.status !== options.expectedStatus) return refuse("resolved_status");
  }
  let additionalRestriction: Parameters<typeof evaluateIssueThreadInteractionResolverAudience>[0]["additionalRestriction"];
  let reviewRequesterKnown: boolean | undefined;
  if (row.issue.status === "in_review" && await isIssueReviewVerdictInteraction(db, { issue: row.issue, interaction })) {
    const requester = await resolveIssueReviewRequester(db, row.issue);
    reviewRequesterKnown = Boolean(requester);
    additionalRestriction = { policy: row.issue.reviewPolicy ?? "anyone", source: "issue_review",
      excludedActor: row.issue.reviewPolicy === "not_creator" && requester ? { type: requester.type, id: requester.id } : null };
  }
  const audience = evaluateIssueThreadInteractionResolverAudience({ interaction, additionalRestriction,
    actor: { type: "agent", agentId: binding.agentId, runId: binding.runId },
    governedAction: payload.toolAction !== undefined || payload.secretProposal !== undefined });
  if (!audience.allowed) return refuse("audience", { audienceCode: audience.code, reviewRequesterKnown });
  const actor: AuthorizationActor = { type: "agent", companyId: binding.companyId, agentId: binding.agentId,
    runId: binding.runId, source: "agent_jwt", onBehalfOfUserId: row.run.responsibleUserId,
    keyScope: nativeRunKeyScope({ ...binding, contextSnapshot: row.run.contextSnapshot, workMode: row.issue.workMode }) };
  for (const action of ["issue:read", "issue:mutate"] as const) {
    if (!(await authorizationService(db).decide({ actor, action,
      resource: { type: "issue", companyId: binding.companyId, issueId: binding.issueId } })).allowed)
      return refuse(action === "issue:read" ? "issue_read" : "issue_mutate");
  }
  if (await budgetServiceInTransaction(db).getInvocationBlock(binding.companyId, binding.agentId,
    { issueId: binding.issueId, runId: binding.runId, admittedRecovery: true })) return refuse("budget");
  return { allowed: true, grant: { ...binding, interaction } };
}

export async function decideNativeAddressedInteractionGrant(db: Db, binding: NativeAddressedInteractionBinding,
  options: NativeAddressedInteractionGrantOptions = {}): Promise<NativeAddressedInteractionGrantDecision> {
  return getAddressedInteractionAuthority(db, binding, options);
}

/** Admission callers use this once, rather than re-reading authority to explain a null grant. */
export async function requireNativeAddressedInteractionGrant(db: Db, binding: NativeAddressedInteractionBinding,
  options: NativeAddressedInteractionGrantOptions = {}): Promise<NativeAddressedInteractionGrant> {
  const decision = await decideNativeAddressedInteractionGrant(db, binding, options);
  if (!decision.allowed) throw new NativeAddressedInteractionAdmissionError(binding, decision.refusal);
  return decision.grant;
}

export async function getNativeAddressedInteractionGrant(db: Db, binding: NativeAddressedInteractionBinding,
  options: NativeAddressedInteractionGrantOptions = {}): Promise<NativeAddressedInteractionGrant | null> {
  const decision = await decideNativeAddressedInteractionGrant(db, binding, options);
  return decision.allowed ? decision.grant : null;
}

export async function classifyAddressedInteractionExecutionCandidate(db: Db, binding: NativeAddressedInteractionBinding,
  persistedContextSnapshot: unknown): Promise<"ordinary" | "response_only" | "denied"> {
  if (!persistedContextSnapshot || typeof persistedContextSnapshot !== "object") return "ordinary";
  const context = persistedContextSnapshot as Record<string, unknown>;
  if (context.wakeReason !== "interaction_pending") return "ordinary";
  if (context.nativeReviewInteractionId) return readNativeReviewAssignmentContext(context) ? "ordinary" : "denied";
  if (!readNativeAddressedInteractionId(context)) return "denied";
  const authority = await getAddressedInteractionAuthority(db, binding, { requireRunning: false }, false);
  return authority.allowed ? "response_only" : "denied";
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
