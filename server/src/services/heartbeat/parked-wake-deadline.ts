import { and, eq, inArray, isNull, sql, type SQLWrapper } from "drizzle-orm";
import { anchorParkedWakePayloadSql, parkedWakeAnchor, parkedWakeNeedsAnchorSql, parkedWakeSql, personSendSql,
  type Payload } from "./parked-wake-anchor.js";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { issueService } from "../issues.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "../issue-queued-comment-queue.js";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { buildStrandedRecoveryEscalationNotice } from "../recovery/stranded-notice.js";
import { owedPersonMessageSql, runCarriesMessage, PENDING_WAIT_BOUND_MS, UNANSWERED_MESSAGE_NO_RUN_CODE,
  UNANSWERED_MESSAGE_REASON_PREFIX, UNANSWERED_WAITING_ROW_JSON } from "../recovery/unanswered-person-message.js";

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

/** SQL twin of parkedWakeStopping (admission's persisted stop wait). */
export function parkedWakeStoppingSql(payload: SQLWrapper) {
  return sql<boolean>`(coalesce(${payload}->'executionWait'->>'reason', '') in (${sql.join(
    [...PARKED_WAKE_STOPPING_REASONS].map(reason => sql`${reason}`), sql`, `)}))`;
}

/** Noticed and not a stopping park: only the person's Retry sends it. A
 * stopping park's note says it will be sent, so its re-dispatch continues. */
export function parkedWakeHeldForRetrySql(payload: SQLWrapper) {
  return sql<boolean>`(${parkedWakeNoticedSql(payload)} and not ${parkedWakeStoppingSql(payload)})`;
}

/** Past this park's deadline (any wake whose current park's anchor is older
 * than the bound). The periodic re-dispatch scan skips it: the receipt worker
 * writes the one note instead of another silent retry. A stopping park
 * (RFL 11:12Z) is not skipped: it is sent once its stop is confirmed. */
export function parkedWakeExpiredSql(payload: SQLWrapper, now = Date.now()) {
  return sql<boolean>`(${parkedWakeSql(payload)} and not ${parkedWakeStoppingSql(payload)}
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

/** RFL 11:12Z: the note while NO run can start yet (the Send is parked behind
 * an unconfirmed stop of the previous run). No Retry: the receipt worker keeps
 * the park's cadence and sends it when the stop is confirmed. */
export const PARKED_WAKE_STOPPING_TEXT =
  "Your message is saved and will be sent when the previous run has finished stopping, usually within ten minutes.";
export const PARKED_WAKE_STOPPING_WAIT = { reason: "parked_not_started", message: PARKED_WAKE_STOPPING_TEXT } as const;
/** RFL C2: a stop that is never confirmed. At this long after the park's FIRST
 * time the stopping note ("usually within ten minutes") is rewritten ONCE, in
 * place (still one note), to this true line. Retry would not start it: every
 * press re-enters admission, which blocks again on the same unconfirmed stop
 * (explicit-native-continuation.ts:573), so the line names no Retry. */
export const PARKED_WAKE_UNCONFIRMED_MS = 30 * 60_000;
export const PARKED_WAKE_UNCONFIRMED_TEXT =
  "Your message is saved. The previous run has not confirmed it stopped; it will be sent when it does.";
export const PARKED_WAKE_UNCONFIRMED_WAIT = { reason: "parked_not_started", message: PARKED_WAKE_UNCONFIRMED_TEXT } as const;
/** "No run can start yet" is admission's own verdict, persisted on the wake as
 * payload.executionWait by admitExplicitNativeContinuation's blocked():
 * remote_cleanup (explicit-native-continuation.ts:573/:576, no remote stop receipt
 * for the previous run's lease) and execution_settling (:388, the previous run's
 * stop has not settled). Both clear by themselves once the stop is confirmed.
 * NOT send_predates_stop (:448-449, rf-4 Q5): it compares authorizedAt, which for
 * a queued Send is that press's own queuedCommentInterrupt.requestedAt (:280/:288),
 * with the previous run's finishedAt. Both are stored values that no receipt
 * changes, so only a NEW press (a newer requestedAt) clears it: that park keeps
 * the "did not start ... Press Retry" note, whose Retry works. */
export const PARKED_WAKE_STOPPING_REASONS: ReadonlySet<string> = new Set(["remote_cleanup", "execution_settling"]);
/** The queue's line for a noticed stopping park: the 30-min line once written. */
export function parkedWakeStoppingWait(payload: Payload) {
  return typeof payload?.parkedUnconfirmedAt === "string" ? PARKED_WAKE_UNCONFIRMED_WAIT : PARKED_WAKE_STOPPING_WAIT;
}
export function parkedWakeStopping(payload: Payload) {
  const wait = payload?.executionWait as { reason?: unknown } | null | undefined;
  return typeof wait?.reason === "string" && PARKED_WAKE_STOPPING_REASONS.has(wait.reason);
}
/** noticeParkedWakeDeadline's answer for a park whose note is (or now is) the
 * stopping note: the caller keeps retrying on the park's cadence. */
export const PARKED_WAKE_STOPPING = "stopping" as const;

/** noticeParkedWakeDeadline's answer when a run carrying a held message is
 * still queued/running/scheduled_retry: no note yet; check again next pass. */
export const PARKED_WAKE_CARRIER_ACTIVE = "carrier_active" as const;

/**
 * The ONE note for a parked Send past its first-park deadline, written through
 * the unanswered-message notice (same key, unanswered_message:<message id>, so
 * that sweep sees it as this message's note and a later answer supersedes it).
 * A standing waiting note for the message ("it will start by itself") is
 * replaced in place: still one note. The wake is marked parkedNoticeAt in the
 * same transaction, so the note is never repeated per retry. DB writes only.
 */
export async function noticeParkedWakeDeadline(db: Db, scope: { companyId: string; requestId: string }, now = new Date()):
  Promise<boolean | typeof PARKED_WAKE_CARRIER_ACTIVE | typeof PARKED_WAKE_STOPPING> {
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
    if (!current || anchor === null || anchor + parkedWakeDeadlineMs() > now.getTime()) return false;
    const stopping = parkedWakeStopping(current.payload);
    // EACH held X is answered only by the merged line's ONE function (D1: the run's OWN input;
    // D3: a succeeded reply or its accepted result published once, never progress). Ancestry and
    // the latest carrier's status cannot override that verdict, even after this park was noticed.
    const held = queuedCommentIdsFromWakePayload(current.payload);
    const message = { id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` };
    const carried = held.length === 0 ? [] : await tx.select({ id: issueComments.id,
      answered: answeredPersonMessageSql(message), owed: owedPersonMessageSql(message, now),
    }).from(issueComments).where(and(eq(issueComments.companyId, scope.companyId),
      eq(issueComments.issueId, issueId), eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
      inArray(issueComments.id, held)));
    const answered = new Set(carried.filter(row => row.answered).map(row => row.id));
    const open = held.filter(id => !answered.has(id));
    if (held.length > 0 && open.length === 0) {
      await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: now, updatedAt: now,
        error: "parked_send_answered_elsewhere" }).where(eq(agentWakeupRequests.id, scope.requestId));
      return false;
    }
    // Live OWN input can still be answered: do not claim it never started. Reuse the sweep's
    // carry reader; this is a wait, not a second answer predicate or an ancestry walk.
    const active = await tx.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, scope.companyId),
        sql`(${heartbeatRuns.issueId} = ${issueId} or ${heartbeatRuns.nativeIssueId} = ${issueId}
          or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId})`,
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])));
    if (active.some(run => open.some(id => runCarriesMessage(run.contextSnapshot, id)))) return PARKED_WAKE_CARRIER_ACTIVE;
    const payload = answered.size > 0 ? withQueuedCommentIdsInWakePayload(current.payload, open) : current.payload;
    if (answered.size > 0 && parkedWakeNoticed(current.payload)) {
      await tx.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, scope.requestId));
    }
    // The SAME owed/floor decision as unanswered-message discovery, not a second age or answer
    // rule. Out-of-scope X stays held; it is not an answered X and must not be silently retired.
    // Gate BOTH the first note and the 30-minute rewrite before touching either notice marker.
    const owed = new Set(carried.filter(row => row.owed).map(row => row.id));
    const messageId = open.filter(id => owed.has(id)).at(-1);
    if (!messageId) return false;
    if (parkedWakeNoticed(current.payload)) {
      if (!stopping) return false;
      // RFL C2: still unconfirmed 30 min after the first park: rewrite the
      // stopping note ONCE in place (parkedUnconfirmedAt marks it).
      if (anchor + PARKED_WAKE_UNCONFIRMED_MS <= now.getTime() && typeof current.payload?.parkedUnconfirmedAt !== "string") {
        await tx.update(agentWakeupRequests).set({
          payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ parkedUnconfirmedAt: now.toISOString() })}::jsonb`,
        }).where(eq(agentWakeupRequests.id, scope.requestId));
        const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${messageId}`;
        const notice = buildStrandedRecoveryEscalationNotice({
          seed: { title: "Your message is saved", body: PARKED_WAKE_UNCONFIRMED_TEXT, tone: "info",
            nextAction: "No action is needed; it will be sent when the stop is confirmed." },
          recoveryActionId: null, recoveryOwner: null, recoveryResponsibility: "user",
          sourceRun: null, failureCode: UNANSWERED_MESSAGE_NO_RUN_CODE,
        });
        // Only this park's stopping note; an answered/retired note stays retired.
        await tx.update(issueComments).set({ body: notice.body, presentation: notice.presentation,
          metadata: { ...notice.metadata, authorizationReason: reason }, updatedAt: now })
          .where(and(eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, issueId),
            isNull(issueComments.deletedAt), eq(issueComments.body, PARKED_WAKE_STOPPING_TEXT),
            sql`${issueComments.metadata}->>'authorizationReason' = ${reason}`));
      }
      return PARKED_WAKE_STOPPING;
    }
    // First note already past the 30-min line (a late pass): write that line.
    const unconfirmed = stopping && anchor + PARKED_WAKE_UNCONFIRMED_MS <= now.getTime();
    await tx.update(agentWakeupRequests).set({
      payload: sql`${JSON.stringify(payload)}::jsonb || ${JSON.stringify({ parkedNoticeAt: now.toISOString(),
        ...(unconfirmed ? { parkedUnconfirmedAt: now.toISOString() } : {}) })}::jsonb`,
    }).where(eq(agentWakeupRequests.id, scope.requestId));
    const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${messageId}`;
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: stopping
        ? { title: "Your message is saved", body: unconfirmed ? PARKED_WAKE_UNCONFIRMED_TEXT : PARKED_WAKE_STOPPING_TEXT, tone: "info",
          nextAction: unconfirmed ? "No action is needed; it will be sent when the stop is confirmed." : "No action is needed; it will be sent by itself." }
        : { title: "Your message did not start", body: PARKED_WAKE_NOT_STARTED_TEXT, tone: "warning",
          nextAction: "Press Retry to send it now." },
      recoveryActionId: null, recoveryOwner: null, recoveryResponsibility: "user",
      sourceRun: null, failureCode: UNANSWERED_MESSAGE_NO_RUN_CODE,
    });
    const [standing] = await tx.select({ id: issueComments.id,
      waiting: sql<boolean>`coalesce(${issueComments.metadata}->'sections' @> ${UNANSWERED_WAITING_ROW_JSON}::jsonb, false)` })
      .from(issueComments).where(and(eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt), sql`${issueComments.metadata}->>'authorizationReason' = ${reason}`)).limit(1);
    if (standing && !standing.waiting) return stopping ? PARKED_WAKE_STOPPING : false;
    if (standing) {
      await tx.update(issueComments).set({ body: notice.body, presentation: notice.presentation,
        metadata: { ...notice.metadata, authorizationReason: reason }, updatedAt: now })
        .where(eq(issueComments.id, standing.id));
      return stopping ? PARKED_WAKE_STOPPING : true;
    }
    await issueService(tx as unknown as Db).addComment(issueId, notice.body, {}, {
      authorType: "system", presentation: notice.presentation,
      metadata: { ...notice.metadata, authorizationReason: reason },
    }, tx);
    return stopping ? PARKED_WAKE_STOPPING : true;
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
