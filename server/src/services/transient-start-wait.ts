import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { isUuidLike, readProviderFailure } from "@paperclipai/shared";

/** An availability wait, not a failed provider turn. No new scheduler or budget. */
export const TRANSIENT_START_WAIT_REASON = "transient_start_wait";
export const TRANSIENT_START_NOTICE = "The provider is temporarily unavailable. Retrying automatically.";
export const TRANSIENT_START_TRANSPORT_CLOSED = "provider_startup_transport_closed";
export const TRANSIENT_START_UNAVAILABLE = "provider_startup_unavailable";
const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

type StartRun = Pick<typeof heartbeatRuns.$inferSelect, "companyId" | "issueId" | "scopeKind" | "contextSnapshot" | "resultJson">;
export type TransientStartWait = { version: 1; messageId: string; firstFailureAt: string };

export function readTransientStartWait(run: Pick<StartRun, "contextSnapshot" | "resultJson">): TransientStartWait | null {
  const value = run.contextSnapshot?.transientStartWait ?? run.resultJson?.transientStartWait;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  return saved.version === 1 && typeof saved.messageId === "string" && isUuidLike(saved.messageId) && typeof saved.firstFailureAt === "string"
    && Number.isFinite(Date.parse(saved.firstFailureAt))
    ? saved as TransientStartWait : null;
}

/** Typed startup refusals only; unknown, authentication and ownership failures stay terminal. */
export function transientProviderStartFailure(value: unknown): boolean {
  const failure = readProviderFailure(value);
  return !!failure && failure.phase === "startup" && failure.retryability === "transient"
    && ["rate_limit", "overloaded", "timeout"].includes(failure.category)
    && (failure.httpStatus == null || TRANSIENT_HTTP.has(failure.httpStatus));
}

/** Resolve the durable human message, never just a user-looking wake reason. */
export async function humanMessageStartWait(db: Db, run: StartRun, now: Date): Promise<TransientStartWait | null> {
  if (run.scopeKind !== "issue" || !run.issueId) return null;
  const saved = readTransientStartWait(run);
  const messageId = saved?.messageId ?? run.contextSnapshot?.wakeCommentId ?? run.contextSnapshot?.commentId;
  if (typeof messageId !== "string" || !isUuidLike(messageId)) return null;
  const [message] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, run.issueId),
    eq(issueComments.id, messageId), eq(issueComments.authorType, "user"),
    sql`${issueComments.authorUserId} is not null`, isNull(issueComments.deletedAt),
  ));
  return message ? saved ?? { version: 1, messageId, firstFailureAt: now.toISOString() } : null;
}

export async function environmentStartWait(db: Db, run: typeof heartbeatRuns.$inferSelect, now: Date) {
  const proof = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (run.status !== "failed" || run.errorCode !== "environment_provider_unavailable"
    || proof?.kind !== "bootstrap" || proof.providerWorkStarted !== false
    || !transientProviderStartFailure(run.resultJson?.providerFailure)) return null;
  return humanMessageStartWait(db, run, now);
}

/** Class (i) refusals cost no start: 15s -> 300s, uncapped. Omit the
 * attempt for the conservative five-minute class (ii) schedule. */
export function transientStartRetryAt(now: Date, failure?: unknown, freeAttempt?: number): Date {
  const typed = readProviderFailure(failure);
  const retryAt = typed?.retryAt ? Date.parse(typed.retryAt) : 0;
  const delay = freeAttempt === undefined ? 300_000
    : Math.min(300_000, 15_000 * 2 ** Math.min(5, Math.max(0, freeAttempt - 1)));
  return new Date(Math.max(now.getTime() + delay, Number.isFinite(retryAt) ? retryAt : 0));
}

function noticeKey(messageId: string) { return `transient_start_retry:${messageId}`; }

/** The existing scheduled-retry deadline owner also owns the 60s projection.
 * Reconstructible from durable waiting rows, including same-run native waits. */
async function pendingNotices(db: Db, runId?: string, cutoff: Date | null = null) {
  return db.select({ run: heartbeatRuns }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, heartbeatRuns.issueId), eq(issues.companyId, heartbeatRuns.companyId)))
    .leftJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(
      ...(runId ? [eq(heartbeatRuns.id, runId)] : []),
      ...(cutoff ? [gte(heartbeatRuns.createdAt, cutoff)] : []),
      sql`jsonb_typeof(${heartbeatRuns.resultJson}->'startupCancellation') is distinct from 'object'`,
      sql`jsonb_typeof(${heartbeatRuns.resultJson}->'nativeCancellation') is distinct from 'object'`,
      eq(issues.assigneeAgentId, heartbeatRuns.agentId),
      sql`${issues.status} in ('in_progress', 'in_review')`,
      sql`(${issues.executionRunId} is null or ${issues.executionRunId} = ${heartbeatRuns.id})`,
      sql`(${issues.checkoutRunId} is null or ${issues.checkoutRunId} = ${heartbeatRuns.id})`,
      sql`(${issues.conversationAgentId} is null or ${heartbeatRuns.contextSnapshot}->>'conversationSessionGeneration' = ${issues.conversationSessionGeneration}::text)`,
      sql`((${heartbeatRuns.status} = 'scheduled_retry' and ${heartbeatRuns.scheduledRetryReason} = ${TRANSIENT_START_WAIT_REASON})
        or (${heartbeatRuns.status} = 'failed' and ${nativeRunFinalizations.phase} = 'retryable_failure'
          and ${nativeRunFinalizations.failureDetail}->>'recoveryMode' = 'bootstrap_retry'))`,
      sql`coalesce(${heartbeatRuns.contextSnapshot}->'transientStartWait', ${heartbeatRuns.resultJson}->'transientStartWait') is not null`,
      sql`exists (select 1 from issue_comments message where message.company_id = ${heartbeatRuns.companyId}
        and message.issue_id = ${heartbeatRuns.issueId} and message.id::text =
        coalesce(${heartbeatRuns.contextSnapshot}#>>'{transientStartWait,messageId}', ${heartbeatRuns.resultJson}#>>'{transientStartWait,messageId}')
        and message.author_type = 'user' and message.author_user_id is not null and message.deleted_at is null)`,
      sql`not exists (select 1 from issue_comments notice where notice.company_id = ${heartbeatRuns.companyId}
        and notice.issue_id = ${heartbeatRuns.issueId} and notice.metadata->>'authorizationReason' =
        'transient_start_retry:' || coalesce(${heartbeatRuns.contextSnapshot}#>>'{transientStartWait,messageId}', ${heartbeatRuns.resultJson}#>>'{transientStartWait,messageId}'))`,
    ));
}

export async function nextTransientStartNoticeAt(db: Db, cutoff: Date | null = null): Promise<Date | null> {
  const dates = (await pendingNotices(db, undefined, cutoff)).flatMap(({ run }) => {
    const wait = readTransientStartWait(run);
    return wait ? [Date.parse(wait.firstFailureAt) + 60_000] : [];
  });
  return dates.length ? new Date(Math.min(...dates)) : null;
}

export async function projectTransientStartNotices(db: Db, now: Date, cutoff: Date | null = null) {
  for (const { run } of await pendingNotices(db, undefined, cutoff)) {
    const wait = readTransientStartWait(run);
    if (!wait || !run.issueId || Date.parse(wait.firstFailureAt) + 60_000 > now.getTime()) continue;
    await db.transaction(async tx => {
      // Same lock order as retry admission; restart and concurrent deadline
      // deliveries share one persistent projection identity per human message.
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, run.issueId!)).for("update");
      if (!(await pendingNotices(tx as unknown as Db, run.id, cutoff)).length) return;
      if (!await humanMessageStartWait(tx as unknown as Db, run, now)) return;
      const { issueService } = await import("./issues.js");
      await issueService(db).addComment(run.issueId!, TRANSIENT_START_NOTICE, {}, {
        authorType: "system", presentation: { kind: "system_notice", tone: "neutral", density: "compact", detailsDefaultOpen: false },
        metadata: { version: 1, authorizationReason: noticeKey(wait.messageId),
          sections: [{ rows: [{ type: "run_link", runId: run.id, agentId: run.agentId, title: "Automatic retry" }] }] },
      }, tx);
    });
  }
}
