import { notifyStrandedAgentStatus } from "../../../services/live-run-recovery-notifications.js";
import { assertAgentInteraction } from "../../../services/agent-interaction-policy.js";
import { notifyExecutionRunWork } from "../../../services/execution-control-notifications.js";
import { notifyStatusCardIssueChange } from "../../../services/status-card-notifications.js";
import { notifyExternalAgentSettlement } from "../../external-agents/index.js";
import { notifyNativeStatusReassessment } from "../../../services/native-status-reassessment-notifications.js";
import { notifyUnsafeWorkspaceExportRecovery } from "../../../services/unsafe-workspace-export-notifications.js";
import { notifyCancelledWorkspacePreservation } from "../../../services/cancelled-workspace-preservation-notifications.js";
import { notifyInstructionCollection } from "../../../services/instruction-collection-notifications.js";
import { notifyChatInboundWakeNotices } from "../../../services/chat-inbound-wake-notice-notifications.js";
import { notifyChatRunMilestones } from "../../../services/chat-run-milestone-notifications.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { IssueComment, IssueCommentMetadata, IssueQueuedCommentQueue } from "@paperclipai/shared";
import {
  buildQueuedCommentQueueSnapshot,
  decideQueuedCommentQueueSteering,
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "../../../services/issue-queued-comment-queue.js";
import { logActivity as persistActivityLogRow, type ActivityPublication } from "../../../services/activity-log.js";
import { decideQueuedCommentWakeLookup } from "../domain/policy.js";
import { firstTurnClaimedCommentIds, firstTurnQueuedCommentIds, firstTurnWakeColumns } from "../../../services/native-runtime/first-turn-queued-input.js";
import { parseObject, readNonEmptyString } from "../domain/values.js";
import { QueuedCommentMutationError, QueuedCommentMutationForbiddenError } from "../application/queued-comment-use-cases.js";
import { notifyDeferredExecutionWork } from "../../../services/deferred-execution-notifications.js";
import type {
  LockedQueuedCommentState,
  QueuedCommentActor,
  QueuedCommentActivityLogInput,
  QueuedCommentActivityPublication,
  QueuedCommentIssueLockWriter,
  QueuedCommentQueueTransaction,
  QueuedCommentRunRow,
  QueuedCommentWakeRow,
} from "../application/queued-comment-ports.js";

type WakeRow = typeof agentWakeupRequests.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;

function toWakeRow(row: WakeRow): QueuedCommentWakeRow {
  return { id: row.id, agentId: row.agentId, status: row.status, runId: row.runId, payload: parseObject(row.payload) };
}

function toRunRow(row: RunRow): QueuedCommentRunRow {
  return { id: row.id, status: row.status, runtimeMode: row.runtimeMode,
    runtimeModeResolvedAt: row.runtimeModeResolvedAt, runnerProfileJson: row.runnerProfileJson,
    contextSnapshot: parseObject(row.contextSnapshot) };
}

export type QueuedCommentQueuePostgresAdapterDeps = {
  /** `issueReferenceService(db).syncComment`; runs on the module's own transaction. */
  syncCommentReferences(commentId: string, tx: Db): Promise<void>;
  /** `issueReferenceService(db).deleteCommentSource`; runs on the module's own transaction. */
  deleteCommentReferenceSource(commentId: string, tx: Db): Promise<void>;
  /** `externalObjectService(db, opts).syncCommentSafely`; runs on the module's own transaction. */
  syncCommentExternalObjectsSafely(commentId: string, tx: Db): Promise<void>;
};

function buildTransaction(tx: Db, companyId: string, issueId: string, deps: QueuedCommentQueuePostgresAdapterDeps, wakeAgentId: string, actor: QueuedCommentActor): QueuedCommentQueueTransaction {
  // Messages the active run took into its first turn leave the visible queue
  // but stay on the wake until that turn is accepted, so a run that fails
  // before then still leaves them queued. Queue edits keep them.
  let heldByFirstTurn: string[] = [];
  return {
    async updateCommentBody({ issueId, commentId, body, updatedAt }) {
      const [existing] = await tx.select({ body: issueComments.body }).from(issueComments).where(and(
        eq(issueComments.id, commentId), eq(issueComments.issueId, issueId), eq(issueComments.companyId, companyId)));
      if (!existing) return false;
      await assertAgentInteraction(tx, { companyId, actorAgentId: actor.actorType === "agent" ? actor.actorId : null,
        operation: "comment", issueId, texts: body === existing.body ? [] : [body], lock: true });
      await notifyStatusCardIssueChange(tx, companyId);
      const updated = await tx
        .update(issueComments)
        .set({ body, updatedAt })
        .where(and(eq(issueComments.id, commentId), eq(issueComments.issueId, issueId), eq(issueComments.companyId, companyId)))
        .returning({ id: issueComments.id })
        .then((rows) => rows[0] ?? null);
      return updated !== null;
    },

    async touchIssueUpdatedAt({ issueId, updatedAt }) {
      await notifyStatusCardIssueChange(tx, companyId);
      await tx.update(issues).set({ updatedAt }).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    },

    async updateWakeQueuedCommentIds({ wakeId, payload, ids, updatedAt }) {
      const kept = [...heldByFirstTurn.filter((id) => !ids.includes(id)), ...ids];
      const row = await tx
        .update(agentWakeupRequests)
        .set({ payload: withQueuedCommentIdsInWakePayload(payload, kept), updatedAt })
        .where(and(eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.companyId, companyId)))
        .returning()
        .then((rows) => rows[0]);
      return toWakeRow(row);
    },

    async updateQueueRunCommentIds({ queueRunId, contextSnapshot, ids, updatedAt }) {
      await notifyChatRunMilestones(tx, { companyId, issueId });
      const row = await tx
        .update(heartbeatRuns)
        .set({ contextSnapshot: withQueuedCommentIdsInRunContext(contextSnapshot, ids), updatedAt })
        .where(and(eq(heartbeatRuns.id, queueRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toRunRow(row) : null;
    },

    async deleteComment({ issueId, commentId, actor, now, restorePoint }) {
      await notifyChatRunMilestones(tx, { companyId, issueId });
      // Soft discard: the row and its words stay; deletedAt keeps it out of every
      // agent input and the discardedFromQueue marker keeps it out of the thread.
      const row = await tx
        .update(issueComments)
        .set({
          deletedAt: now,
          deletedByType: actor.actorType,
          deletedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
          deletedByUserId: actor.actorType === "user" ? actor.actorId : null,
          deletedByRunId: actor.runId,
          metadata: sql`coalesce(${issueComments.metadata}, '{"version":1}'::jsonb) || ${JSON.stringify({
            discardedFromQueue: true, ...(restorePoint ? { queuedDiscard: restorePoint } : {}),
          })}::jsonb`,
          updatedAt: now,
        })
        .where(and(
          eq(issueComments.id, commentId), eq(issueComments.issueId, issueId), eq(issueComments.companyId, companyId),
          isNull(issueComments.deletedAt),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? (row as IssueComment) : null;
    },

    async cancelWake({ wakeId, reason, now }) {
      if (heldByFirstTurn.length > 0) {
        const [held] = await tx.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.companyId, companyId)));
        if (held) {
          await tx.update(agentWakeupRequests)
            .set({ payload: withQueuedCommentIdsInWakePayload(held.payload, heldByFirstTurn), updatedAt: now })
            .where(and(eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.companyId, companyId)));
          return;
        }
      }
      await notifyStrandedAgentStatus(tx, { companyId, agentId: wakeAgentId });
      await notifyChatInboundWakeNotices(tx, { companyId, issueId });
      await tx
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt: now, error: reason, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.companyId, companyId)));
    },

    async cancelQueueRun({ queueRunId, reason, now }) {
      await notifyExecutionRunWork(tx, { companyId, runId: queueRunId });
      await notifyUnsafeWorkspaceExportRecovery(tx, { companyId, issueId });
      await notifyInstructionCollection(tx, { companyId, runId: queueRunId });
      await notifyExternalAgentSettlement(tx, { companyId, runId: queueRunId });
      await notifyCancelledWorkspacePreservation(tx, { companyId, runId: queueRunId });
      await notifyChatRunMilestones(tx, { companyId, issueId });
      const row = await tx
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: now, error: reason, errorCode: "queued_comment_discarded", updatedAt: now })
        .where(and(eq(heartbeatRuns.id, queueRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")))
        .returning({ id: heartbeatRuns.id })
        .then((rows) => rows[0] ?? null);
      return row ? { id: row.id } : null;
    },

    async clearExecutionLockAndTouchIssue({ issueId, executionRunId, updatedAt }) {
      await notifyNativeStatusReassessment(tx, { companyId, issueId });
      await notifyUnsafeWorkspaceExportRecovery(tx, { companyId, issueId });
      await tx
        .update(issues)
        .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), eq(issues.executionRunId, executionRunId)));
    },

    async buildQueueSnapshot({ issue, actor, wake, state, queueRun, activeRun }): Promise<IssueQueuedCommentQueue> {
      const wakeCommentIds = queuedCommentIdsFromWakePayload(wake?.payload ?? null);
      const claimed = state === "deferred" ? firstTurnClaimedCommentIds(activeRun) : new Set<string>();
      if (wake) heldByFirstTurn = wakeCommentIds.filter((id) => claimed.has(id));
      const commentIds = wakeCommentIds.filter((id) => !claimed.has(id));
      const rows =
        commentIds.length > 0
          ? await tx
              .select()
              .from(issueComments)
              .where(
                and(
                  eq(issueComments.companyId, companyId),
                  eq(issueComments.issueId, issue.id),
                  inArray(issueComments.id, commentIds),
                ),
              )
          : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const comments = commentIds.flatMap((id) => {
        const row = byId.get(id);
        return row && !row.deletedAt ? [row] : [];
      });

      const assignedAgent = issue.assigneeAgentId
        ? await tx
            .select({ adapterType: agents.adapterType })
            .from(agents)
            .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, companyId)))
            .limit(1)
            .then((agentRows) => agentRows[0] ?? null)
        : null;

      // A queue mutation never delivers same-turn steering itself, so this
      // adapter never probes the live runner: it answers
      // "temporarily_unavailable" wherever the shared rule says a caller
      // may probe. Only the read path probes the live provider.
      const steering = decideQueuedCommentQueueSteering({
        state,
        queueRunRuntimeMode: queueRun?.runtimeMode ?? null,
        activeRun,
        assignedAgentAdapterType: assignedAgent?.adapterType ?? null,
        queuedCommentCount: comments.length,
      });
      const steeringDisposition: IssueQueuedCommentQueue["steeringDisposition"] =
        steering.kind === "probe" ? "temporarily_unavailable" : steering.kind;

      const queue = buildQueuedCommentQueueSnapshot({
        issueId: issue.id,
        queueId: wake?.id ?? null,
        state,
        activeRunId: activeRun?.id ?? null,
        protocol: steering.protocol,
        steeringDisposition,
        comments,
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      // Same view as the read path: what the starting run's first turn takes is sent.
      const firstTurnWake = wake && state === "deferred" && activeRun?.status === "running" && wakeCommentIds.length > 0
        ? await tx.select(firstTurnWakeColumns).from(agentWakeupRequests)
            .where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, companyId)))
            .limit(1).then((wakeRows) => wakeRows[0] ?? null)
        : null;
      const firstTurnCommentIds = wake && firstTurnWake && activeRun
        ? await firstTurnQueuedCommentIds(tx, { companyId, issueId: issue.id, runId: activeRun.id,
            wake: { ...firstTurnWake, status: wake.status, payload: wake.payload } })
        : [];
      if (firstTurnCommentIds.length > 0) queue.firstTurnCommentIds = firstTurnCommentIds;
      return queue;
    },

    async syncCommentReferences(commentId) {
      await deps.syncCommentReferences(commentId, tx);
    },
    async deleteCommentReferenceSource(commentId) {
      await deps.deleteCommentReferenceSource(commentId, tx);
    },
    async syncCommentExternalObjectsSafely(commentId) {
      await deps.syncCommentExternalObjectsSafely(commentId, tx);
    },

    async logActivity(input: QueuedCommentActivityLogInput): Promise<QueuedCommentActivityPublication> {
      const publications: ActivityPublication[] = [];
      await persistActivityLogRow(
        tx,
        {
          companyId,
          actorType: input.actorType,
          actorId: input.actorId,
          agentId: input.agentId,
          runId: input.runId,
          agentApiKeyId: input.agentApiKeyId,
          action: input.action,
          entityType: "issue",
          entityId: input.entityId,
          details: input.details,
        },
        publications,
      );
      return publications[0];
    },
  };
}

export function createQueuedCommentIssueLockWriter(db: Db, deps: QueuedCommentQueuePostgresAdapterDeps): QueuedCommentIssueLockWriter {
  return {
    async withLockedQueue(input, fn) {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const companyId = input.issue.companyId;

        await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, input.issue.id), eq(issues.companyId, companyId)))
          .for("update");

        const wakeRow = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.id, input.queueId),
              eq(agentWakeupRequests.companyId, companyId),
              input.issue.assigneeAgentId ? eq(agentWakeupRequests.agentId, input.issue.assigneeAgentId) : undefined,
            ),
          )
          .for("update")
          .limit(1)
          .then((rows) => rows[0] ?? null);

        const wakePayload = parseObject(wakeRow?.payload);
        const lookup = decideQueuedCommentWakeLookup({
          wakePresent: wakeRow !== null,
          wakeIssueIdMatches: readNonEmptyString(wakePayload.issueId) === input.issue.id,
          hasQueuedCommentIds: queuedCommentIdsFromWakePayload(wakeRow?.payload ?? null).length > 0,
          wakeStatus: wakeRow?.status ?? null,
          wakeHasRunId: Boolean(wakeRow?.runId),
        });

        if (lookup.kind === "not_pending") {
          throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
        }
        if (lookup.kind === "already_dispatching") {
          throw new QueuedCommentMutationError("queued_comment_already_dispatching", "The queued message is already being dispatched");
        }

        // Unreachable: `decideQueuedCommentWakeLookup` only returns "deferred" or "check_queue_run" when the wake row is present.
        if (!wakeRow) throw new Error("wake-queue: queued-comment lookup resolved without a wake row");

        let state: "deferred" | "queued";
        let queueRunRow: RunRow | null = null;

        if (lookup.kind === "deferred") {
          state = "deferred";
        } else {
          // check_queue_run: `wakeHasRunId` was true for this branch to have been reached.
          queueRunRow = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, wakeRow.runId!),
                eq(heartbeatRuns.companyId, companyId),
                eq(heartbeatRuns.agentId, wakeRow.agentId),
                eq(heartbeatRuns.wakeupRequestId, wakeRow.id),
              ),
            )
            .for("update")
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!queueRunRow || queueRunRow.status !== "queued") {
            throw new QueuedCommentMutationError(
              "queued_comment_already_dispatching",
              "The queued message is already being dispatched",
            );
          }
          state = "queued";
        }

        const activeRunId = state === "deferred" ? input.issue.executionRunId : null;
        const activeRunRow = activeRunId
          ? await tx
              .select()
              .from(heartbeatRuns)
              .where(and(eq(heartbeatRuns.id, activeRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")))
              .for("update")
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;

        const transaction = buildTransaction(tx, companyId, input.issue.id, deps, wakeRow.agentId, input.actor);
        const wake = toWakeRow(wakeRow);
        const queueRun = queueRunRow ? toRunRow(queueRunRow) : null;
        const activeRun = activeRunRow ? toRunRow(activeRunRow) : null;

        const queue = await transaction.buildQueueSnapshot({
          issue: input.issue,
          actor: input.actor,
          wake,
          state,
          queueRun,
          activeRun,
        });

        const locked: LockedQueuedCommentState = { wake, state, queueRun, activeRun, queue };
        await assertAgentInteraction(tx, { companyId, actorAgentId: input.actor.actorType === "agent" ? input.actor.actorId : null,
          operation: "comment", issueId: input.issue.id, lock: true });
        return fn(locked, transaction);
      });
    },
  };
}

/** How long after a Delete the same person can still restore the message (Undo). The bar offers Undo for ~8 s. */
export const QUEUED_COMMENT_RESTORE_WINDOW_MS = 60_000;

const DISCARD_REASON = "Queued message discarded before dispatch";

/**
 * Undo of a queued Delete. Under the issue lock: the comment must be a
 * discarded queued message, deleted by this same person within the window.
 * It is put back into its own queue (the wake it was discarded from) at its
 * original place among the messages still waiting, and deletedAt is cleared.
 * When that Delete had emptied the queue (wake cancelled by the discard), the
 * wake is revived as a deferred wake holding only this message and the
 * deferred-execution worker is hinted, so it is admitted once, in order, by
 * the ordinary path. A queue that has already been dispatched cannot take it
 * back: that is refused and the message stays deleted.
 */
export async function restoreDiscardedQueuedComment(
  db: Db,
  deps: QueuedCommentQueuePostgresAdapterDeps,
  input: { issue: { id: string; companyId: string }; actor: QueuedCommentActor; commentId: string; now: Date; windowMs?: number },
): Promise<{ queueId: string }> {
  const { companyId } = input.issue;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, input.issue.id), eq(issues.companyId, companyId))).for("update");
    const comment = await tx.select().from(issueComments).where(and(
      eq(issueComments.id, input.commentId), eq(issueComments.issueId, input.issue.id), eq(issueComments.companyId, companyId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    const metadata = parseObject(comment?.metadata);
    const point = parseObject(metadata.queuedDiscard);
    const queueId = readNonEmptyString(point.queueId);
    if (!comment || !comment.deletedAt || metadata.discardedFromQueue !== true || !queueId) {
      throw new QueuedCommentMutationError("queued_comment_not_restorable", "This message can't be restored");
    }
    if (input.actor.actorType !== "user" || !comment.deletedByUserId || comment.deletedByUserId !== input.actor.actorId) {
      throw new QueuedCommentMutationForbiddenError("Only the person who deleted this message can restore it");
    }
    if (input.now.getTime() - new Date(comment.deletedAt).getTime() > (input.windowMs ?? QUEUED_COMMENT_RESTORE_WINDOW_MS)) {
      throw new QueuedCommentMutationError("queued_comment_restore_expired", "Too late to undo: the message stays deleted");
    }
    const wakeRow = await tx.select().from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.id, queueId), eq(agentWakeupRequests.companyId, companyId)))
      .for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!wakeRow || readNonEmptyString(parseObject(wakeRow.payload).issueId) !== input.issue.id) {
      throw new QueuedCommentMutationError("queued_comment_not_restorable", "This message can't be restored");
    }
    const originalOrder = Array.isArray(point.order) ? point.order.filter((id): id is string => typeof id === "string") : [];
    const currentIds = queuedCommentIdsFromWakePayload(wakeRow.payload);
    const pending = wakeRow.status === "deferred_issue_execution";
    let queueRunRow: RunRow | null = null;
    if (!pending && wakeRow.status === "queued" && wakeRow.runId) {
      queueRunRow = await tx.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, wakeRow.runId), eq(heartbeatRuns.companyId, companyId)))
        .for("update").limit(1).then((rows) => rows[0] ?? null);
    }
    const revivable = wakeRow.status === "cancelled" && wakeRow.error === DISCARD_REASON && currentIds.length <= 1;
    if (!pending && queueRunRow?.status !== "queued" && !revivable) {
      throw new QueuedCommentMutationError("queued_comment_not_restorable",
        "Too late to undo: the other queued messages were already sent. The message stays deleted.");
    }
    // Same place: right after the nearest earlier message (in the order at
    // Delete) that is still waiting, else first.
    const withoutSelf = revivable ? [] : currentIds.filter((id) => id !== input.commentId);
    const before = originalOrder.slice(0, Math.max(0, originalOrder.indexOf(input.commentId)));
    let insertAt = 0;
    for (const id of before) {
      const at = withoutSelf.indexOf(id);
      if (at >= 0) insertAt = Math.max(insertAt, at + 1);
    }
    const ids = [...withoutSelf.slice(0, insertAt), input.commentId, ...withoutSelf.slice(insertAt)];

    const restoredMetadata = { ...metadata };
    delete restoredMetadata.discardedFromQueue;
    delete restoredMetadata.queuedDiscard;
    await tx.update(issueComments).set({
      deletedAt: null, deletedByType: null, deletedByAgentId: null, deletedByUserId: null, deletedByRunId: null,
      metadata: restoredMetadata as unknown as IssueCommentMetadata, updatedAt: input.now,
    }).where(eq(issueComments.id, comment.id));
    await deps.syncCommentReferences(comment.id, tx);
    await deps.syncCommentExternalObjectsSafely(comment.id, tx);

    if (revivable) {
      // The Delete emptied the queue and cancelled its wake (and any queued
      // run). Revive the wake as deferred with only this message; the
      // deferred-execution worker admits it once through the ordinary path.
      await tx.update(agentWakeupRequests).set({
        status: "deferred_issue_execution", runId: null, finishedAt: null, error: null,
        payload: withQueuedCommentIdsInWakePayload(wakeRow.payload, ids), updatedAt: input.now,
      }).where(eq(agentWakeupRequests.id, wakeRow.id));
      await notifyDeferredExecutionWork(tx, { companyId, requestId: wakeRow.id });
    } else {
      await tx.update(agentWakeupRequests).set({
        payload: withQueuedCommentIdsInWakePayload(wakeRow.payload, ids), updatedAt: input.now,
      }).where(eq(agentWakeupRequests.id, wakeRow.id));
      if (queueRunRow) {
        const updated = await tx.update(heartbeatRuns).set({
          contextSnapshot: withQueuedCommentIdsInRunContext(parseObject(queueRunRow.contextSnapshot), ids), updatedAt: input.now,
        }).where(and(eq(heartbeatRuns.id, queueRunRow.id), eq(heartbeatRuns.status, "queued")))
          .returning({ id: heartbeatRuns.id });
        // Rolls the whole restore back: the message stays deleted.
        if (updated.length === 0) {
          throw new QueuedCommentMutationError("queued_comment_not_restorable",
            "Too late to undo: the other queued messages were already sent. The message stays deleted.");
        }
      }
    }
    await notifyStatusCardIssueChange(tx, companyId);
    await tx.update(issues).set({ updatedAt: input.now })
      .where(and(eq(issues.id, input.issue.id), eq(issues.companyId, companyId)));
    return { queueId: wakeRow.id };
  });
}
