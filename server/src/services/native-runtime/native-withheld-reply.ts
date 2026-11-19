import { QueryBuilder } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { chatActions, environmentLeases, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunResults,
  type Db } from "@paperclipai/db";
import { isConversation } from "../agent-conversations.js";
import { resolveChatRunPresentationAuthorizationReason } from "../chat-run-publications.js";
import { notifyChatRunMilestones } from "../chat-run-milestone-notifications.js";
import { publishChatPublicationCommitSignal } from "../chat-publication-reconciliation.js";
import { findHeartbeatRunCompletionComment, resolveHeartbeatRunResponse } from "../heartbeat-run-summary.js";
import { issueService } from "../issues.js";
import type { NativeResponsePresentationScope } from "../native-response-presentation-notifications.js";
import { settledResponsePublicationSql } from "./native-response-publication-receipt.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { FILE_LINE_KEPT, FILE_LINE_LOST, readReplyFileLine, type ReplyFileLine } from "@paperclipai/shared";
import { acceptedReplyAlreadyPresented, acceptedResponseDigestMatches, NATIVE_WITHHELD_REPLY_FAILURE_CODES,
  NATIVE_WITHHELD_REPLY_SCHEMA, REPLY_FILE_LINE_SAVED, selectAcceptedFinalAgentMessage } from "./native-run-finalizer.js";
import { WITHHELD_REPLY_SAVING_DEADLINE_MS, type WithheldReplyTrigger } from "./native-withheld-reply-trigger.js";
import { readNativeWorkspaceExportResume } from "./native-workspace-export-resume.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

/**
 * An accepted answer whose run ended without a committed reply.
 *
 * The committed reply path publishes an accepted answer only after its
 * workspace copy-back succeeds and the run finishes `succeeded`. Two endings
 * never get there, and the person who asked then never sees the saved answer:
 *  - the copy-back failed for good (terminal_failure with one of
 *    NATIVE_WITHHELD_REPLY_FAILURE_CODES); and
 *  - the run was cancelled after acceptance and its retried copy-back later
 *    succeeded: it commits, but stays `cancelled`.
 * Both endings write a pending marker on the run in the statement that ends it
 * (native-run-finalizer.ts). This module publishes that answer exactly once.
 *
 * The file line tells the person what happened to the files the reply may
 * describe. The words live here only, so they can be changed in one place.
 */
// The words live in packages/shared/src/reply-file-line.ts: the thread renders
// the line from the state stored on the presentation decision, never from the
// reply's body. LOST: native_workspace_sync_out_unrecoverable (the box or its
// lease is gone). KEPT: native_workspace_sync_out_retry_exhausted while the box
// is retained for export (preserveNativeWorkspaceExportLease).
export { FILE_LINE_KEPT, FILE_LINE_LOST };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const withheldMarkerState = sql`${heartbeatRuns.resultJson} #>> '{nativeWithheldReply,state}'`;
const terminalWithheld = and(eq(nativeRunFinalizations.phase, "terminal_failure"),
  inArray(nativeRunFinalizations.failureCode, [...NATIVE_WITHHELD_REPLY_FAILURE_CODES]));
const cancelledCommitted = and(eq(nativeRunFinalizations.phase, "committed"), eq(heartbeatRuns.status, "cancelled"));
const withheldMarkerTrigger = sql<string | null>`${heartbeatRuns.resultJson} #>> '{nativeWithheldReply,trigger}'`;
/** An entry written at acceptance is due in every phase, and while the
 * finalizer holds its lease: it needs only the accepted result, which never changes. */
const acceptanceEntry = sql`${withheldMarkerTrigger} = 'acceptance'`;

/** Runs with a pending withheld reply, in the reply-presentation worker's candidate shape. */
export function nativeWithheldReplyCandidates(scope?: NativeResponsePresentationScope, after?: string, runId?: string) {
  const db = new QueryBuilder();
  return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    issueId: nativeRunFinalizations.issueId, agentId: heartbeatRuns.agentId, nextAttemptAt: sql<Date | null>`null::timestamptz`.as("next_attempt_at"),
    endpointId: chatActions.endpointId, principalId: chatActions.principalId,
    publicationNextAttemptAt: sql<string | null>`${heartbeatRuns.resultJson} #>> '{responsePublication,nextAttemptAt}'`.as("publication_next_attempt_at"),
    // A withheld reply owns the same durable, bounded publication retry as an ordinary task reply.
    taskReply: sql<boolean>`true`.as("task_reply"),
    trigger: withheldMarkerTrigger.as("withheld_trigger"),
  }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
    .leftJoin(chatActions, and(eq(chatActions.id, heartbeatRuns.wakeupRequestId),
      eq(chatActions.companyId, heartbeatRuns.companyId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.companyId, nativeRunFinalizations.companyId), eq(nativeRunResults.issueId, nativeRunFinalizations.issueId),
      eq(nativeRunResults.runId, heartbeatRuns.id)))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"), or(isNull(nativeRunFinalizations.leaseOwner), acceptanceEntry),
      sql`${withheldMarkerState} = 'pending'`,
      or(terminalWithheld, cancelledCommitted, acceptanceEntry),
      eq(nativeRunResults.schemaStatus, "accepted"),
      // A reply published at acceptance comes back once, at the terminal
      // write, to settle its file line; nothing is posted again.
      or(sql`jsonb_typeof(${heartbeatRuns.resultJson} #> '{presentationDecision,commentId}') is distinct from 'string'`,
        sql`${heartbeatRuns.resultJson} #>> '{presentationDecision,fileLine,state}' = 'saving'`),
      sql`${heartbeatRuns.resultJson} #>> '{responsePublication,state}' is distinct from 'failed'`,
      scope ? and(eq(heartbeatRuns.companyId, scope.companyId), scope.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined) : undefined,
      scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
      scope?.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined,
      after ? gt(heartbeatRuns.id, after) : undefined, runId ? eq(heartbeatRuns.id, runId) : undefined,
    )).orderBy(asc(heartbeatRuns.id)).limit(100);
}

/**
 * Publish a withheld accepted reply exactly once. Returns true when it posted.
 *
 * `trigger` names the outbox entry being served: "terminal" (the run ended
 * without a committed reply) or "acceptance" (the result was just accepted;
 * WITHHELD_REPLY_TRIGGER). It is idempotent by (run, resultId,
 * canonicalSha256): a second call for a key that already has its comment
 * posts nothing, and at most settles that reply's file line.
 *
 * The file line is a bounded state on the presentation decision, not text in
 * the body: "terminal" writes lost/kept (or saved for decision (i)) directly;
 * "acceptance" starts `saving` with a deadline and is settled by the commit
 * (saved, native-run-finalizer.ts) or by the terminal entry (lost/kept).
 *
 * Never twice:
 *  - it locks the finalization coordinator first, in the committed reply
 *    path's order (coordinator, issue, run). The two publishers need different
 *    states of that locked row, so only one of them can hold its precondition;
 *  - both return early through acceptedReplyAlreadyPresented once a comment id
 *    is recorded, so a later commit (a board Retry that succeeds) posts nothing;
 *  - the comment id is recorded in the transaction that inserts the comment.
 */
export async function publishWithheldAcceptedReply(
  db: Db,
  input: { companyId: string; issueId: string; runId: string },
  trigger: WithheldReplyTrigger,
): Promise<boolean> {
  let agentId: string | null = null;
  const published = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId),
      trigger === "acceptance" ? undefined : isNull(nativeRunFinalizations.leaseOwner),
    )).for("update");
    if (!coordinator?.resultId) return false;
    const terminal = coordinator.phase === "terminal_failure"
      && (NATIVE_WITHHELD_REPLY_FAILURE_CODES as readonly string[]).includes(String(coordinator.failureCode));
    const committed = coordinator.phase === "committed";
    if (trigger === "terminal" && !terminal && !committed) return false;
    const [issue] = await tx.select().from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
    if (!issue) return false;
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.runtimeMode, "native"),
    )).for("update");
    if (!run || isNativeRunnerOwnershipHeld(run)) return false;
    // A committed run is this path's only when it stayed cancelled; every
    // other committed run belongs to the committed reply path.
    if (trigger === "terminal" && !terminal && run.status !== "cancelled") return false;
    const marker = record(record(run.resultJson).nativeWithheldReply);
    if (marker.state !== "pending" || (marker.trigger ?? "terminal") !== trigger) return false;
    if (marker.resultId !== coordinator.resultId) return false;
    const settle = (state: "skipped", reason: string) => tx.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        nativeWithheldReply: { ...marker, state, reason },
      })}::jsonb`, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    // An entry served at acceptance leaves anything it cannot publish to the
    // committed path (or to the terminal entry) instead of holding it pending.
    const leave = async (reason: string) => { if (trigger === "acceptance") await settle("skipped", reason); return false as const; };
    const [accepted] = await tx.select().from(nativeRunResults).where(and(
      eq(nativeRunResults.id, coordinator.resultId), eq(nativeRunResults.runId, run.id),
      eq(nativeRunResults.companyId, input.companyId), eq(nativeRunResults.issueId, input.issueId),
      eq(nativeRunResults.schemaStatus, "accepted"),
    )).for("share");
    const envelope = record(accepted?.resultJson);
    const result = record(envelope.result);
    const acceptedTerminal = record(envelope.terminal);
    if (!accepted || (run.completionContractId && accepted.completionContractId !== run.completionContractId)
      || result.schema !== "paperclip.run_result.v1"
      || acceptedTerminal.runTerminalState !== "succeeded" || acceptedTerminal.turnTerminalState !== "completed") {
      await settle("skipped", "accepted_result_not_a_completed_answer");
      return false;
    }
    const receipt = { schema: NATIVE_WITHHELD_REPLY_SCHEMA, resultId: accepted.id, trigger,
      canonicalSha256: accepted.canonicalSha256, failureCode: terminal ? coordinator.failureCode : null };
    // What happened to this run's files, as far as the server knows now.
    // Decision (i): a committed copy-back lost no files, so there is no line.
    const fileLineNow = async (): Promise<ReplyFileLine> => committed ? REPLY_FILE_LINE_SAVED
      : terminal ? { state: await exportIsRetained(tx, run, coordinator) ? "kept" : "lost", deadlineAt: null }
      : { state: "saving", deadlineAt: new Date(accepted.createdAt.getTime() + WITHHELD_REPLY_SAVING_DEADLINE_MS).toISOString() };
    // The never-twice guard, shared with the committed reply path.
    if (acceptedReplyAlreadyPresented(run)) {
      const decision = record(record(run.resultJson).presentationDecision);
      const shown = readReplyFileLine(decision.fileLine);
      // Idempotent by (run, resultId, canonicalSha256): the reply published at
      // acceptance is this entry's own. Settle its file line; post nothing.
      if (typeof decision.commentId === "string" && shown?.state === "saving" && (terminal || committed)
        && decision.withheldReplyResultId === accepted.id && decision.withheldReplyCanonicalSha256 === accepted.canonicalSha256) {
        const fileLine = await fileLineNow();
        await tx.update(heartbeatRuns).set({
          resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
            presentationDecision: { ...decision, fileLine },
            nativeWithheldReply: { ...receipt, state: "published", fileLine: fileLine.state, commentId: decision.commentId },
          })}::jsonb`, updatedAt: new Date(),
        }).where(eq(heartbeatRuns.id, run.id));
        agentId = run.agentId;
        return false;
      }
      await settle("skipped", "reply_already_presented");
      return false;
    }
    if (!(await acceptedResponseDigestMatches(tx, run, accepted))) return leave("accepted_response_digest_mismatch");
    const conversation = isConversation(issue);
    // The committed path's own eligibility for an ordinary reply, without the
    // parts that need a committed decision: a conversation reply belongs to
    // the conversation's own agent, person and session, and a run that answers
    // an external chat (Slack, email) keeps its own presentation path.
    const currentConversation = conversation
      && issue.conversationAgentId === run.agentId && issue.conversationUserId === run.responsibleUserId
      && record(run.contextSnapshot).issueId === issue.id
      && record(run.contextSnapshot).conversationSessionGeneration === issue.conversationSessionGeneration;
    const authorizationReason = await resolveChatRunPresentationAuthorizationReason(tx, input);
    if ((conversation && !currentConversation) || authorizationReason !== "internal_agent_write") {
      await settle("skipped", conversation && !currentConversation ? "conversation_not_current" : "external_chat_context");
      return false;
    }
    const finalAgentMessage = await selectAcceptedFinalAgentMessage(tx, {
      companyId: input.companyId, runId: run.id, agentId: run.agentId, nativeSessionId: run.nativeSessionId,
      turnId: accepted.turnId, conversation, currentConversation,
    });
    // No saved final message: stay pending. The worker's bounded publication
    // retry names the failure instead of posting a semantic summary as the answer.
    if (!finalAgentMessage) return leave("no_saved_final_message");
    const comments = await tx.select({ id: issueComments.id, body: issueComments.body, presentation: issueComments.presentation })
      .from(issueComments).where(and(
        eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
        eq(issueComments.createdByRunId, run.id), eq(issueComments.authorType, "agent"),
      )).orderBy(desc(issueComments.createdAt), desc(issueComments.id));
    const resolved = resolveHeartbeatRunResponse({
      resultJson: { ...record(run.resultJson), nativeResult: result },
      nativeConversationFinalResponse: conversation,
      existingComment: findHeartbeatRunCompletionComment(comments, run.resultJson),
      finalAgentMessage,
    });
    const key = { withheldReplyResultId: accepted.id, withheldReplyCanonicalSha256: accepted.canonicalSha256 };
    if (resolved.decision.commentAction === "reuse" && typeof resolved.decision.commentId === "string") {
      // The reply is already on the task. Record it; never post again.
      await tx.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
          presentationDecision: { ...resolved.decision,
            reasonCodes: [...resolved.decision.reasonCodes, "terminal_withheld_reply_reused"] },
          nativeWithheldReply: { ...receipt, state: "published", fileLine: null, commentId: resolved.decision.commentId },
        })}::jsonb || ${settledResponsePublicationSql()}`, updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, run.id));
      return false;
    }
    if (!resolved.text || resolved.decision.commentAction !== "create") return leave("no_reply_to_create");
    const fileLine = await fileLineNow();
    await notifyChatRunMilestones(tx, input);
    // The body is the answer alone: the thread renders the file line from the state below.
    const comment = await issueService(db).addComment(input.issueId, resolved.text,
      { agentId: run.agentId, runId: run.id }, { authorizationReason, completionReply: true, withheldAcceptedReply: true }, tx);
    await tx.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        presentationDecision: { ...resolved.decision, commentId: comment.id, fileLine, ...key,
          reasonCodes: [...resolved.decision.reasonCodes,
            trigger === "acceptance" ? "acceptance_withheld_reply_published" : "terminal_withheld_reply_published"] },
        nativeWithheldReply: { ...receipt, state: "published", fileLine: fileLine.state, commentId: comment.id },
      })}::jsonb || ${settledResponsePublicationSql()}`, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    agentId = run.agentId;
    return true;
  });
  // A published reply, or a file line that just settled: the thread re-reads.
  if (agentId) {
    publishChatPublicationCommitSignal({ ...input, agentId, eventType: "run.presentation.resolved" });
  }
  return published;
}

/** The files are kept only when the terminal write retained this run's own
 * box for export: preserveNativeWorkspaceExportLease tags the still-active
 * lease in the terminal transaction. Anything else is reported as not saved. */
async function exportIsRetained(tx: Db, run: typeof heartbeatRuns.$inferSelect,
  coordinator: typeof nativeRunFinalizations.$inferSelect) {
  if (coordinator.failureCode !== "native_workspace_sync_out_retry_exhausted") return false;
  const reference = readNativeWorkspaceSyncReference(record(run.runnerProfileJson).nativeWorkspaceSync);
  if (!reference) return false;
  const [lease] = await tx.select().from(environmentLeases).where(and(
    eq(environmentLeases.id, reference.leaseId), eq(environmentLeases.companyId, run.companyId),
    eq(environmentLeases.heartbeatRunId, run.id),
  )).limit(1);
  if (!lease || ["expired", "failed"].includes(lease.status)) return false;
  const resume = readNativeWorkspaceExportResume(lease);
  return resume?.resultId === coordinator.resultId;
}
