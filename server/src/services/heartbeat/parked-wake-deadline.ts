import { and, eq, isNull, sql, type SQLWrapper } from "drizzle-orm";
import { anchorParkedWakePayloadSql, parkedWakeAnchor, parkedWakeNeedsAnchorSql, parkedWakeSql, personSendSql,
  type Payload } from "./parked-wake-anchor.js";
import { agentWakeupRequests, issueComments, issues, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import { buildStrandedRecoveryEscalationNotice } from "../recovery/stranded-notice.js";
import { PENDING_WAIT_BOUND_MS, UNANSWERED_MESSAGE_NO_RUN_CODE, UNANSWERED_MESSAGE_REASON_PREFIX,
  UNANSWERED_WAITING_ROW_JSON } from "../recovery/unanswered-person-message.js";

/**
 * S124: a parked wake (a person's saved Send, deferred_issue_execution with
 * payload.queuedCommentInterrupt) is retried every 30 s. Its age used to be
 * read from updatedAt, which every failed retry rewrites, so the silence had
 * no end. The park's FIRST time is kept once in payload.firstParkedAt (set
 * once per park, never overwritten); the 30 s cadence stays, and at
 * firstParkedAt + the deadline the wake stops retrying silently and
 * the person gets ONE true note (payload.parkedNoticeAt marks it).
 *
 * The deadline is the bound Paperclip already has for this wait: the
 * unanswered-message pending-attempt bound (a queued re-wake that is never
 * claimed must not keep the person silent).
 *
 * A new press (the queue's Send, which is the note's Retry) writes a newer
 * queuedCommentInterrupt.requestedAt: that is a new park with a fresh anchor.
 *
 * S124c (RFL ruling): only a NAMED wait the PERSON controls may stay
 * unbounded, because its true reason and action are on screen and only the
 * person ends it. That is an explicit allowlist (PERSON_CONTROLLED_WAIT_REASONS).
 * Such a wake has no anchor, no deadline, no re-arm and no note; the scan's
 * rewrite drops any anchor it held, so a park that resumes after the wait
 * anchors afresh. Every OTHER executionWait on a parked Send (interrupt_handoff,
 * remote_cleanup, cleanup_pending, controller_settling, execution_recovery, ...)
 * is the silent loop S124 bounds: first-park anchor, 30 s cadence, ONE note.
 */
export const PARKED_WAKE_RETRY_MS = 30_000;
export { anchorParkedWakePayloadSql, parkedWake, parkedWakeAnchor, parkedWakeNeedsAnchorSql, parkedWakePayload, parkedWakeSql,
  PERSON_CONTROLLED_WAIT_REASONS, personControlledWait, personControlledWaitSql, personSend, personSendSql } from "./parked-wake-anchor.js";

export function parkedWakeDeadlineMs() { return PENDING_WAIT_BOUND_MS; }

/** This park's one note was already written. */
export function parkedWakeNoticed(payload: Payload) {
  return parkedWakeAnchor(payload) !== null && typeof payload?.parkedNoticeAt === "string";
}

/** SQL twin of parkedWakeNoticed over a wake payload column. */
export function parkedWakeNoticedSql(payload: SQLWrapper) {
  return sql<boolean>`(${parkedWakeSql(payload)}
    and ${payload}->>'parkedNoticeAt' is not null and ${payload}->>'firstParkedAt' is not null
    and coalesce(${payload}->'queuedCommentInterrupt'->>'requestedAt', '') <= ${payload}->>'firstParkedAt')`;
}

/** Past this park's deadline (any wake whose current park's anchor is older
 * than the bound). The periodic re-dispatch scan skips it: the receipt worker
 * writes the one note instead of another silent retry. */
export function parkedWakeExpiredSql(payload: SQLWrapper, now = Date.now()) {
  return sql<boolean>`(${parkedWakeSql(payload)}
    and ${payload}->>'firstParkedAt' is not null
    and coalesce(${payload}->'queuedCommentInterrupt'->>'requestedAt', '') <= ${payload}->>'firstParkedAt'
    and ${payload}->>'firstParkedAt' <= ${new Date(now - parkedWakeDeadlineMs()).toISOString()})`;
}

/** The true sentence: the message is kept, nothing started, Retry sends it. */
export const PARKED_WAKE_NOT_STARTED_TEXT =
  "Your message is saved, but it did not start. Press Retry to send it now.";

/** S124e: the queue's line once the one note is written. It says what the note
 * says (nothing started; Send/Retry sends it), never "Sending your messages.". */
export const PARKED_WAKE_NOT_STARTED_WAIT = { reason: "parked_not_started", message: PARKED_WAKE_NOT_STARTED_TEXT } as const;

/**
 * The ONE note for a parked Send past its first-park deadline, written through
 * the unanswered-message notice (same key, unanswered_message:<message id>, so
 * that sweep sees it as this message's note and a later answer supersedes it).
 * A standing waiting note for the message ("it will start by itself") is
 * replaced in place: still one note. The wake is marked parkedNoticeAt in the
 * same transaction, so the note is never repeated per retry. DB writes only.
 */
export async function noticeParkedWakeDeadline(db: Db, scope: { companyId: string; requestId: string }, now = new Date()) {
  const [wake] = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, scope.requestId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
  const issueId = typeof wake?.payload?.issueId === "string" ? wake.payload.issueId : null;
  if (!wake || !issueId) return false;
  return db.transaction(async tx => {
    // Issue fence first, as the notice writers and queue edits take it.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, scope.companyId))).for("no key update");
    const [current] = await tx.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, scope.requestId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"))).for("update");
    const anchor = parkedWakeAnchor(current?.payload);
    if (!current || anchor === null || anchor + parkedWakeDeadlineMs() > now.getTime() || parkedWakeNoticed(current.payload)) return false;
    await tx.update(agentWakeupRequests).set({
      payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ parkedNoticeAt: now.toISOString() })}::jsonb`,
    }).where(eq(agentWakeupRequests.id, scope.requestId));
    const messageId = queuedCommentIdsFromWakePayload(current.payload).at(-1) ?? scope.requestId;
    const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${messageId}`;
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: { title: "Your message did not start", body: PARKED_WAKE_NOT_STARTED_TEXT, tone: "warning",
        nextAction: "Press Retry to send it now." },
      recoveryActionId: null, recoveryOwner: null, recoveryResponsibility: "user",
      sourceRun: null, failureCode: UNANSWERED_MESSAGE_NO_RUN_CODE,
    });
    const [standing] = await tx.select({ id: issueComments.id,
      waiting: sql<boolean>`coalesce(${issueComments.metadata}->'sections' @> ${UNANSWERED_WAITING_ROW_JSON}::jsonb, false)` })
      .from(issueComments).where(and(eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt), sql`${issueComments.metadata}->>'authorizationReason' = ${reason}`)).limit(1);
    if (standing && !standing.waiting) return false;
    if (standing) {
      await tx.update(issueComments).set({ body: notice.body, presentation: notice.presentation,
        metadata: { ...notice.metadata, authorizationReason: reason }, updatedAt: now })
        .where(eq(issueComments.id, standing.id));
      return true;
    }
    await issueService(tx as unknown as Db).addComment(issueId, notice.body, {}, {
      authorType: "system", presentation: notice.presentation,
      metadata: { ...notice.metadata, authorizationReason: reason },
    }, tx);
    return true;
  });
}


/** Store the anchor if this park has none; return the park's anchor (ms). */
export async function anchorParkedWake(db: Db, scope: { companyId: string; requestId: string }) {
  const where = and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, scope.requestId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"));
  const [written] = await db.update(agentWakeupRequests)
    .set({ payload: anchorParkedWakePayloadSql(agentWakeupRequests.payload, agentWakeupRequests.updatedAt, personSendSql()) })
    .where(and(where, parkedWakeNeedsAnchorSql(agentWakeupRequests.payload, personSendSql()))).returning({ payload: agentWakeupRequests.payload });
  if (written) return parkedWakeAnchor(written.payload);
  const [current] = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(where);
  return parkedWakeAnchor(current?.payload);
}
