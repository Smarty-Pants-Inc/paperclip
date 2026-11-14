import { agents, authUsers, companyMemberships, heartbeatRuns, issueComments, issues, issueThreadInteractions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { ActivityPublication } from "../../types/activity-publication.js";
import { persistActivity } from "../activity-log.js";
import { canActorReadIssuePrivacy } from "../authorization.js";
import { insertIssueComment } from "../issue-comment-writes.js";
import { isIssueReviewVerdictInteraction } from "../issue-review-policy.js";
import { getSameIssueDocumentConfirmationTargetRefusal } from "../issue-thread-interactions.js";
import { agentLinkRow, keyValueRow, type NoticeMetadataRow } from "../recovery/notice-format.js";
import { buildStrandedRecoveryEscalationNotice } from "../recovery/stranded-notice.js";
import { NativeAddressedInteractionAdmissionError, readNativeAddressedInteractionId,
  type NativeAddressedInteractionBinding, type NativeAddressedInteractionRefusal,
  type NativeAddressedInteractionRefusalReason } from "./native-addressed-interaction.js";

export const NATIVE_ADDRESSED_INTERACTION_FAILED = "native_addressed_interaction_failed";
export const NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE =
  "Paperclip could not handle the addressed confirmation card; it remains pending.";
export const NATIVE_ADDRESSED_INTERACTION_FAILURE_ACTION =
  "This addressed card run has stopped. Check the card's current state before sending a new card event. Automatic retry is stopped.";

type AddressedFailure = { interactionId: string; state: string };

/** Lifecycle identity only: recognizing a refused response never grants tools or a verdict. */
async function readOrdinaryAddressedFailureIdentity(db: Db, binding: NativeAddressedInteractionBinding, options: {
  failed?: boolean;
  lockCard?: boolean;
  error?: unknown;
} = {}): Promise<AddressedFailure | null> {
  const [row] = await db.select({ run: heartbeatRuns, issue: issues }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, heartbeatRuns.nativeIssueId), eq(issues.companyId, heartbeatRuns.companyId)))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId))).limit(1);
  if (!row || row.run.runtimeMode !== "native" || row.run.status !== (options.failed ? "failed" : "running")
    || row.issue.executionRunId === binding.runId
    || row.issue.checkoutRunId === binding.runId) return null;
  const context = row.run.contextSnapshot;
  const interactionId = readNativeAddressedInteractionId(context);
  if (!interactionId || context?.nativeReviewDecisionId
    || (context?.issueId !== undefined && context.issueId !== binding.issueId)
    || (context?.taskId !== undefined && context.taskId !== binding.issueId)) return null;
  const query = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId))).limit(1);
  const [interaction] = await (options.lockCard ? query.for("update") : query);
  if (!interaction) return null;
  const payload = interaction.payload as unknown as Record<string, unknown> | null;
  if (!admissionRefusal(options.error, binding, interactionId)) {
    // An assignee is a response-only participant here only with a matched
    // captured refusal; ordinary owner/provider failures keep their own path.
    if (row.issue.assigneeAgentId === binding.agentId) return null;
    // Only the system reports captured refusals to the card owner. This does not
    // grant the receiver private access or authorize any governed action.
    if (!await canActorReadIssuePrivacy(db, { type: "agent", companyId: binding.companyId, agentId: binding.agentId,
      runId: binding.runId, source: "agent_jwt", onBehalfOfUserId: row.run.responsibleUserId }, row.issue)) return null;
    if (payload?.toolAction !== undefined || payload?.secretProposal !== undefined) return null;
    // Provider errors retain the ordinary response-only classifier, including
    // only verified current same-issue document targets. This is identity, not authority.
    if (interaction.kind !== "request_confirmation" || interaction.addresseeAgentId !== binding.agentId
      || interaction.addresseeUserId || !payload) return null;
    if (payload.target != null && await getSameIssueDocumentConfirmationTargetRefusal(db, {
      companyId: binding.companyId, issueId: binding.issueId, target: payload.target,
    })) return null;
    if (row.issue.status === "in_review" && await isIssueReviewVerdictInteraction(db, { issue: row.issue, interaction })) return null;
  }
  return { interactionId, state: interaction.status };
}

export async function readNativeAddressedInteractionFailure(db: Db, binding: NativeAddressedInteractionBinding,
  error?: unknown): Promise<AddressedFailure | null> {
  return readOrdinaryAddressedFailureIdentity(db, binding, { error });
}

type RefusalCopy = { cause: string; action: string };
const UNKNOWN_REFUSAL: RefusalCopy = {
  cause: "Paperclip could not verify this run's permission to answer the card.",
  action: "Ask a person with access to inspect the card and its response permissions before deciding it or sending a corrected request.",
};
const REFUSAL_COPY: Record<NativeAddressedInteractionRefusalReason, RefusalCopy> = {
  binding_not_found: { cause: "The response run could not be matched to this task and company.", action: "Have a person inspect the task and create a correctly addressed request if a response is still needed." },
  runtime_mode: { cause: "This run is not using the runtime required for a card response.", action: "Have a person answer the card or configure a supported runtime before sending a new request." },
  context_issue: { cause: "The response event belongs to a different task.", action: "Send a corrected card event from this task, or have a person answer the card." },
  native_issue: { cause: "The response run is bound to a different task.", action: "Have a person inspect the task binding before sending a corrected request." },
  run_status: { cause: "The response run is no longer in a state that can answer the card.", action: "Check the stopped run and let a person answer the card or send a new request." },
  agent_status: { cause: "The responding agent is paused or otherwise unavailable for card responses.", action: "Ask a person or the agent's manager to check its status; a person with access can answer the card instead." },
  company_status: { cause: "The company is not active, so agent responses are stopped.", action: "Ask a company administrator to check its status before further agent work." },
  interaction_context: { cause: "The saved event does not identify an ordinary addressed card response.", action: "Have a person inspect the request and send a corrected card event if needed." },
  interaction_not_found: { cause: "The card could not be found on this task.", action: "Have a person inspect this task's cards before sending another request." },
  interaction_kind: { cause: "This kind of card is not supported by an addressed confirmation response run.", action: "Have a person handle the card through its own controls or replace it with a supported confirmation request." },
  addressee_agent: { cause: "This response run is not for the card's current addressed agent.", action: "Check the addressee and send a corrected request, or have a person with access answer the card." },
  addressee_user: { cause: "The card is addressed to a person and cannot be answered by this agent run.", action: "Ask the addressed person to answer the card; another agent cannot decide it for them." },
  source_run_binding: { cause: "The response event and the card refer to different creating runs.", action: "Have a person inspect the card's origin and send a corrected request if needed." },
  source_run_not_found: { cause: "The card's creating run could not be verified in this company.", action: "Have a person inspect the card's origin before deciding it or replacing the request." },
  source_run_issue: { cause: "The card's creating run does not belong to this task.", action: "Have a person inspect the card's task and origin before replacing the request." },
  source_run_creator: { cause: "The card's creator does not match its creating run.", action: "Have a person inspect who created the card before deciding it or replacing the request." },
  payload_missing: { cause: "The card is missing the confirmation details needed for an agent response.", action: "Have a person inspect the card and replace the incomplete request if needed." },
  target: { cause: "Paperclip could not verify this card's linked target for the response run.", action: "Ask a person with access to inspect the linked item and the card before deciding it or replacing the request. Do not treat a read receipt as approval of the linked work." },
  tool_action: { cause: "The card is bound to a governed tool action that needs independent authorization.", action: "Use the governed action's approval flow; this notice does not authorize the action." },
  secret_proposal: { cause: "The card is bound to a protected secret change that needs independent authorization.", action: "Use the secret change's approval flow; this notice does not authorize the change." },
  pending_in_resolved_phase: { cause: "The run expected a recorded decision, but the card has not been answered.", action: "Have an eligible person answer the card through its normal controls." },
  issue_closed: { cause: "This task is done or cancelled, so the agent cannot answer its pending card.", action: "Have a person with access inspect the task and card; reopen the task only if further work is intended, or withdraw the obsolete request." },
  issue_hidden: { cause: "This task is hidden, so the agent cannot answer its pending card.", action: "Have a person inspect the hidden task and restore it only if a response is still needed." },
  interaction_not_pending: { cause: "The card was no longer pending when this response tried to start.", action: "Inspect the card's recorded outcome before requesting any new response." },
  interaction_not_resolvable: { cause: "The card is no longer available for an accept or decline decision.", action: "Inspect its current state before creating a replacement request." },
  resolved_agent: { cause: "The card's recorded decision belongs to a different agent.", action: "Inspect the recorded decision; do not overwrite it with this response run." },
  resolved_run: { cause: "The card's recorded decision belongs to another run.", action: "Inspect the recorded decision; do not overwrite it with this response run." },
  resolved_status: { cause: "The recorded card outcome differs from the outcome this run expected.", action: "Inspect the recorded decision before sending any new request." },
  audience: UNKNOWN_REFUSAL,
  issue_read: { cause: "The responding agent could not read this task under its current access rules.", action: "Ask a person with access to inspect task privacy and permissions; do not share private card content with the agent." },
  issue_mutate: { cause: "The responding agent does not have permission to record a response on this task.", action: "Have an authorized person answer the card, or ask an administrator to inspect the intended permissions." },
  budget: { cause: "A budget or invocation hold prevents this agent response.", action: "Ask a person responsible for the budget to inspect the hold, or have a person with access answer the card." },
};
const AUDIENCE_COPY: Partial<Record<NonNullable<NativeAddressedInteractionRefusal["audienceCode"]>, RefusalCopy>> = {
  interaction_run_attribution_required: { cause: "The response does not have valid agent run attribution.", action: "Have a person inspect the response run before sending a corrected request." },
  interaction_human_only: { cause: "This card requires a human decision, not an agent response.", action: "Ask an eligible person to answer through the card's controls; if it names a person, only that person may answer." },
  interaction_creator_excluded: { cause: "The card's creator or creating run is not allowed to decide this request.", action: "Ask an eligible person other than the card's creator to answer it, or send the request to a different eligible agent." },
  interaction_addressee_mismatch: REFUSAL_COPY.addressee_agent,
  interaction_governed_action_denied: REFUSAL_COPY.tool_action,
  review_policy_denied: { cause: "The task's review policy does not allow this response: its review requester cannot also decide it, or the requester could not be verified.", action: "Have someone other than the review requester submit the verdict. If the requester is unknown, have a person move the task out of review and back into review to record it, then ask an eligible reviewer." },
};

function refusalCopy(refusal: NativeAddressedInteractionRefusal): RefusalCopy {
  const copy = REFUSAL_COPY[refusal.reason] ?? UNKNOWN_REFUSAL;
  if (refusal.reason === "target") {
    const targetCopy: Record<NonNullable<NativeAddressedInteractionRefusal["targetReason"]>, RefusalCopy> = {
      invalid: { cause: "The card's linked target is malformed and could not be verified.", action: "Have a person inspect the card and replace it with a correctly linked request if a response is still needed." },
      unsupported: { cause: "This card uses a linked-target type that this agent response path does not support.", action: "Have a person with access inspect the linked item and use the card's normal controls, or replace the request." },
      wrong_issue: { cause: "The card's linked document target names a different task.", action: "Have a person replace the request with a document target on this task; this response run cannot approve another task's document." },
      unavailable: { cause: "The exact linked document or its current revision is unavailable on this task.", action: "Have a person inspect the document's current link and replace the request if the intended document is available; do not answer until the linked revision can be verified." },
      revision_changed: { cause: "The card's linked document revision does not match the current revision.", action: "Have a person inspect the current document and replace the stale request before requesting a new response." },
    };
    return refusal.targetReason && Object.hasOwn(targetCopy, refusal.targetReason)
      ? targetCopy[refusal.targetReason] : copy;
  }
  if (refusal.reason === "agent_status") {
    const causes: Record<string, string> = {
      paused: "The responding agent is paused, so it cannot answer this card.",
      terminated: "The responding agent has been terminated, so it cannot answer this card.",
      pending_approval: "The responding agent is awaiting approval, so it cannot answer this card.",
      error: "The responding agent is in an error state, so it cannot answer this card.",
    };
    return { ...copy, cause: causes[refusal.status ?? ""] ?? copy.cause,
      ...(refusal.status === "paused" ? { action: "Ask a person with permission or the agent's manager to resume the agent if appropriate, or reassign the request to an eligible responder. A person with access can answer the card instead." } : {}) };
  }
  if (refusal.reason === "run_status") {
    const causes: Record<string, string> = {
      queued: "The response run has not started, so it cannot answer this card yet.",
      succeeded: "The response run has already finished, so it cannot answer this card again.",
      failed: "The response run has failed, so it cannot answer this card.",
      cancelled: "The response run has been cancelled, so it cannot answer this card.",
      timed_out: "The response run has timed out, so it cannot answer this card.",
    };
    return { ...copy, cause: causes[refusal.status ?? ""] ?? copy.cause };
  }
  if (refusal.reason === "audience") {
    if (refusal.audienceCode === "review_policy_denied") return {
      cause: refusal.reviewRequesterKnown
        ? "The task's review policy does not allow the person or agent who requested review to also decide it."
        : "The task requires a reviewer other than its review requester, but Paperclip could not verify who requested review.",
      action: refusal.reviewRequesterKnown
        ? "Have someone other than the review requester submit the verdict."
        : "Have a person move the task out of review and back into review to record its requester, then ask a different eligible reviewer to submit the verdict.",
    };
    return (refusal.audienceCode && AUDIENCE_COPY[refusal.audienceCode]) || UNKNOWN_REFUSAL;
  }
  return copy;
}

function admissionRefusal(error: unknown, binding: NativeAddressedInteractionBinding, interactionId: string) {
  if (!(error instanceof NativeAddressedInteractionAdmissionError)
    || error.binding.companyId !== binding.companyId || error.binding.issueId !== binding.issueId
    || error.binding.agentId !== binding.agentId || error.binding.runId !== binding.runId
    || (error.refusal.interactionId !== null && error.refusal.interactionId !== interactionId)) return null;
  return error.refusal;
}

type NoticePerson = { type: "agent" | "user"; id: string; name: string | null };
async function readNoticePerson(db: Db, companyId: string, agentId: string | null, userId: string | null): Promise<NoticePerson | null> {
  if (agentId) {
    const [agent] = await db.select({ id: agents.id, name: agents.name }).from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1);
    return agent ? { type: "agent", ...agent } : null;
  }
  if (userId) {
    const [user] = await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers)
      .innerJoin(companyMemberships, and(eq(companyMemberships.principalId, authUsers.id),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.companyId, companyId)))
      .where(eq(authUsers.id, userId)).limit(1);
    return user ? { type: "user", ...user } : null;
  }
  return null;
}
function personRow(label: string, person: NoticePerson | null): NoticeMetadataRow {
  return person?.type === "agent" ? agentLinkRow(label, person)
    : keyValueRow(label, person?.name ?? "A person with access must inspect the card");
}

export async function appendNativeAddressedInteractionFailureNotice(db: Db, binding: NativeAddressedInteractionBinding,
  interactionId: string, error?: unknown): Promise<ActivityPublication | null> {
  return db.transaction(async tx => {
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
    if (!issue) return null;
    const [coordinator] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId),
      eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.phase, "terminal_failure"),
      eq(nativeRunFinalizations.failureCode, NATIVE_ADDRESSED_INTERACTION_FAILED),
      isNull(nativeRunFinalizations.resultId), isNull(nativeRunFinalizations.nextAttemptAt))).for("update");
    if (!coordinator) return null;
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId),
      eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.nativePhase, "terminal_failure"),
      eq(heartbeatRuns.errorCode, NATIVE_ADDRESSED_INTERACTION_FAILED))).for("update");
    if (!run) return null;
    const current = await readOrdinaryAddressedFailureIdentity(tx as unknown as Db, binding, { failed: true, lockCard: true, error });
    if (!current || current.interactionId !== interactionId || current.state !== "pending") return null;
    const refusal = admissionRefusal(error, binding, interactionId);
    const reason = refusal?.reason ?? "provider_failure";
    const agentStatus = reason === "agent_status" && refusal?.status
      && ["paused", "terminated", "pending_approval", "error"].includes(refusal.status) ? refusal.status : null;
    const reasonKey = agentStatus ? `${reason}:${agentStatus}` : reason;
    // The explicit reason namespace cannot be mistaken for a C8 run UUID.
    const cardKey = `native-addressed-failure:${interactionId}`;
    const clientRequestId = `${cardKey}:reason:${reasonKey}`;
    const legacyRunKey = `^${cardKey}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, binding.companyId), eq(issueComments.issueId, binding.issueId),
      eq(issueComments.authorType, "system"), or(eq(issueComments.clientRequestId, clientRequestId),
        reason === "provider_failure" ? sql`${issueComments.clientRequestId} ~* ${legacyRunKey}` : undefined))).limit(1);
    if (existing) return null;
    const [card] = await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, binding.companyId),
      eq(issueThreadInteractions.issueId, binding.issueId))).limit(1);
    if (!card) return null;
    // The card creator owns repair of this request, not the response agent and
    // not a potentially different current task assignee. Missing creator => human inspection.
    const owner = await readNoticePerson(tx as unknown as Db, binding.companyId, card.createdByAgentId, card.createdByUserId);
    const addressee = await readNoticePerson(tx as unknown as Db, binding.companyId, card.addresseeAgentId, card.addresseeUserId);
    const responder = await readNoticePerson(tx as unknown as Db, binding.companyId, binding.agentId, null);
    const copy = refusal ? refusalCopy(refusal) : null;
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: { title: "Card response stopped", tone: "danger",
        body: copy ? `For ${owner?.name ?? "the card creator"}, the card owner: Paperclip could not let ${responder?.name ?? "the responding agent"} answer this card${addressee?.name ? ` addressed to ${addressee.name}` : ""}. ${copy.cause} The card remains pending. Automatic retry is stopped. ${copy.action}`
          : NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE,
        nextAction: copy?.action ?? NATIVE_ADDRESSED_INTERACTION_FAILURE_ACTION },
      recoveryActionId: null, recoveryOwner: owner?.type === "agent" ? owner : null,
      recoveryResponsibility: "user", continuesAutomatically: false,
      sourceRun: { id: binding.runId, agentId: binding.agentId, status: "failed" },
    });
    notice.metadata.sections.push({ title: "Card", rows: [keyValueRow("Card", interactionId),
      personRow("Recovery owner", owner), keyValueRow("Owner basis", "Card creator"), personRow("Addressee", addressee)] });
    const [comment] = await insertIssueComment(tx, { companyId: binding.companyId, issueId: binding.issueId,
      authorType: "system", authorAgentId: null, authorUserId: null, createdByRunId: binding.runId, clientRequestId,
      body: notice.body, presentation: notice.presentation, metadata: notice.metadata });
    if (!comment) throw new Error("native_addressed_interaction_failure_notice_missing");
    return (await persistActivity(tx as unknown as Db, { companyId: binding.companyId, actorType: "system", actorId: "system",
      agentId: binding.agentId, runId: binding.runId, action: "issue.addressed_interaction_failed", entityType: "issue",
      entityId: binding.issueId, details: { interactionId, commentId: comment.id, state: current.state,
        failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED, failureReason: reason,
        ...(agentStatus ? { agentStatus } : {}), ...(refusal ? { refusalReason: refusal.reason,
          ...(refusal.audienceCode ? { audienceCode: refusal.audienceCode } : {}) } : {}) } })).publication;
  });
}
