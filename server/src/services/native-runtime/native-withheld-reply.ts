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
import { acceptedReplyAlreadyPresented, acceptedResponseDigestMatches, NATIVE_WITHHELD_REPLY_FAILURE_CODES,
  NATIVE_WITHHELD_REPLY_SCHEMA, selectAcceptedFinalAgentMessage } from "./native-run-finalizer.js";
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
/** native_workspace_sync_out_unrecoverable: the box or its lease is gone. */
export const FILE_LINE_LOST = "The file changes from this reply couldn't be saved.";
/** native_workspace_sync_out_retry_exhausted while the box is retained for
 * export (preserveNativeWorkspaceExportLease). The board's "Recover saved
 * files" action (ui WorkspaceExportRecovery.tsx) reads that retained box. */
export const FILE_LINE_KEPT = "The file changes from this reply are kept and can be recovered from the task's saved files.";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const withheldMarkerState = sql`${heartbeatRuns.resultJson} #>> '{nativeWithheldReply,state}'`;
const terminalWithheld = and(eq(nativeRunFinalizations.phase, "terminal_failure"),
  inArray(nativeRunFinalizations.failureCode, [...NATIVE_WITHHELD_REPLY_FAILURE_CODES]));
const cancelledCommitted = and(eq(nativeRunFinalizations.phase, "committed"), eq(heartbeatRuns.status, "cancelled"));

/** Runs with a pending withheld reply, in the reply-presentation worker's candidate shape. */
export function nativeWithheldReplyCandidates(scope?: NativeResponsePresentationScope, after?: string, runId?: string) {
  const db = new QueryBuilder();
  return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    issueId: nativeRunFinalizations.issueId, agentId: heartbeatRuns.agentId, nextAttemptAt: sql<Date | null>`null::timestamptz`.as("next_attempt_at"),
    endpointId: chatActions.endpointId, principalId: chatActions.principalId,
    publicationNextAttemptAt: sql<string | null>`${heartbeatRuns.resultJson} #>> '{responsePublication,nextAttemptAt}'`.as("publication_next_attempt_at"),
    // A withheld reply owns the same durable, bounded publication retry as an ordinary task reply.
    taskReply: sql<boolean>`true`.as("task_reply"),
  }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
    .leftJoin(chatActions, and(eq(chatActions.id, heartbeatRuns.wakeupRequestId),
      eq(chatActions.companyId, heartbeatRuns.companyId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.companyId, nativeRunFinalizations.companyId), eq(nativeRunResults.issueId, nativeRunFinalizations.issueId),
      eq(nativeRunResults.runId, heartbeatRuns.id)))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"), isNull(nativeRunFinalizations.leaseOwner),
      sql`${withheldMarkerState} = 'pending'`,
      or(terminalWithheld, cancelledCommitted),
      eq(nativeRunResults.schemaStatus, "accepted"),
      sql`jsonb_typeof(${heartbeatRuns.resultJson} #> '{presentationDecision,commentId}') is distinct from 'string'`,
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
): Promise<boolean> {
  let agentId: string | null = null;
  const published = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.issueId, input.issueId), isNull(nativeRunFinalizations.leaseOwner),
    )).for("update");
    if (!coordinator?.resultId) return false;
    const terminal = coordinator.phase === "terminal_failure"
      && (NATIVE_WITHHELD_REPLY_FAILURE_CODES as readonly string[]).includes(String(coordinator.failureCode));
    if (!terminal && coordinator.phase !== "committed") return false;
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
    if (!terminal && run.status !== "cancelled") return false;
    const marker = record(record(run.resultJson).nativeWithheldReply);
    if (marker.state !== "pending") return false;
    const settle = (state: "skipped", reason: string) => tx.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        nativeWithheldReply: { ...marker, state, reason },
      })}::jsonb`, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    // The never-twice guard, shared with the committed reply path.
    if (acceptedReplyAlreadyPresented(run)) {
      await settle("skipped", "reply_already_presented");
      return false;
    }
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
    if (!(await acceptedResponseDigestMatches(tx, run, accepted))) return false;
    const conversation = isConversation(issue);
    // The committed path's own selection. A conversation reply may carry the
    // compatible `unknown` channel only for the conversation's own agent and person.
    const currentConversation = conversation
      && issue.conversationAgentId === run.agentId && issue.conversationUserId === run.responsibleUserId;
    const finalAgentMessage = await selectAcceptedFinalAgentMessage(tx, {
      companyId: input.companyId, runId: run.id, agentId: run.agentId, nativeSessionId: run.nativeSessionId,
      turnId: accepted.turnId, conversation, currentConversation,
    });
    // No saved final message: stay pending. The worker's bounded publication
    // retry names the failure instead of posting a semantic summary as the answer.
    if (!finalAgentMessage) return false;
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
    const receipt = { schema: NATIVE_WITHHELD_REPLY_SCHEMA, resultId: accepted.id,
      canonicalSha256: accepted.canonicalSha256, failureCode: terminal ? coordinator.failureCode : null };
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
    if (!resolved.text || resolved.decision.commentAction !== "create") return false;
    // Decision (i): a cancelled run whose copy-back succeeded lost no files.
    const fileLine = !terminal ? null : await exportIsRetained(tx, run, coordinator) ? "kept" as const : "lost" as const;
    const body = fileLine === null ? resolved.text
      : `${resolved.text}\n\n${fileLine === "kept" ? FILE_LINE_KEPT : FILE_LINE_LOST}`;
    const authorizationReason = await resolveChatRunPresentationAuthorizationReason(tx, input);
    await notifyChatRunMilestones(tx, input);
    const comment = await issueService(db).addComment(input.issueId, body,
      { agentId: run.agentId, runId: run.id }, { authorizationReason, completionReply: true, withheldAcceptedReply: true }, tx);
    await tx.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        presentationDecision: { ...resolved.decision, commentId: comment.id,
          reasonCodes: [...resolved.decision.reasonCodes, "terminal_withheld_reply_published"] },
        nativeWithheldReply: { ...receipt, state: "published", fileLine, commentId: comment.id },
      })}::jsonb || ${settledResponsePublicationSql()}`, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    agentId = run.agentId;
    return true;
  });
  if (published && agentId) {
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
