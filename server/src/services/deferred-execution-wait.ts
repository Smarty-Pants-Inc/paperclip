import { HttpError } from "../errors.js";
import { and, eq, inArray, isNull, sql, type SQLWrapper } from "drizzle-orm";
import { agentWakeupRequests, issueComments, issues, type Db } from "@paperclipai/db";
import { QUEUE_CONTEXT_KEY, QUEUE_IDS_KEY, queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/** Admission has saved this refusal on the caller's durable deferred receipt.
 * HTTP callers still receive the existing 409; receipt recovery waits for its
 * owning gate producer instead of treating the refusal as infrastructure debt. */
export class PersistedExecutionWaitRefusal extends HttpError {
  constructor(message: string, details?: unknown) { super(409, message, details); }
}

/** A saved wait is well formed when it has the shape every writer below
 * stores: a JSON object with a non-empty string `reason` and a string
 * `message` (writeDeferredExecutionWait's callers in heartbeat/queue.ts and
 * deferredWorkIntentWait in work-intent-outbox.ts; the queue route reads the
 * same two fields, routes/issues.ts). JSON null, false, a string, an array or
 * an object without those fields is not a wait and grants no Hold50 bypass. */
export function isWellFormedExecutionWait(value: unknown): value is { reason: string; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wait = value as Record<string, unknown>;
  return typeof wait.reason === "string" && wait.reason.trim().length > 0 && typeof wait.message === "string";
}

/** SQL twin of isWellFormedExecutionWait over a wake payload column. */
export function wellFormedExecutionWaitSql(payload: SQLWrapper) {
  return sql<boolean>`(jsonb_typeof(${payload}->'executionWait') = 'object'
    and jsonb_typeof(${payload}->'executionWait'->'reason') = 'string'
    and btrim(${payload}->'executionWait'->>'reason') <> ''
    and jsonb_typeof(${payload}->'executionWait'->'message') = 'string')`;
}

/**
 * The ONE pause-keep predicate (RFL 07:43Z / 07:45Z, person-only). A Pause, the
 * agent's (run-control cancelPendingWakeupsForAgentsInternal, while 'pausing')
 * or the task tree's (issue-tree-control cancelUnclaimedWakeupsForTree, mode
 * "pause"), keeps an unclaimed deferred_issue_execution wake when:
 * - it carries ANY live message a PERSON wrote (queuedCommentIdsFromWakePayload,
 *   comment authorType 'user', not deleted). Not Stop-scoped: held by a
 *   person's Stop, sent while paused, or simply parked; or
 * - its wait's trigger is pause_lifted (the pause itself deferred it).
 * Everything else is cancelled by BOTH Pauses, system-only work included even
 * when it carries its own saved wait. Two forms of the same rule; no other copy.
 */
export function keepsWakeAcrossPause(wake: { status: string; payload: unknown }, isPersonMessage: (commentId: string) => boolean): boolean {
  if (wake.status !== "deferred_issue_execution") return false;
  const payload = wake.payload && typeof wake.payload === "object" && !Array.isArray(wake.payload)
    ? wake.payload as Record<string, unknown> : {};
  const wait = payload.executionWait && typeof payload.executionWait === "object" && !Array.isArray(payload.executionWait)
    ? payload.executionWait as Record<string, unknown> : {};
  if (wait.trigger === "pause_lifted") return true;
  return queuedCommentIdsFromWakePayload(payload).some(isPersonMessage);
}

/** The JS form's person-message reader: the live PERSON-written comments among `commentIds`. */
export async function personMessageIds(db: Pick<Db, "select">, companyId: string, commentIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(commentIds)].filter(id => /^[0-9a-f-]{36}$/i.test(id));
  if (!ids.length) return new Set();
  return new Set((await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.companyId, companyId),
    inArray(issueComments.id, ids), eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt)))).map(row => row.id));
}

/** SQL twin of keepsWakeAcrossPause over agent_wakeup_requests (correlated on the outer wake row). */
export function keepsWakeAcrossPauseSql() {
  const ids = sql`${agentWakeupRequests.payload}->${QUEUE_CONTEXT_KEY}->${QUEUE_IDS_KEY}`;
  return sql<boolean>`(${agentWakeupRequests.status} = 'deferred_issue_execution' and (
    coalesce(${agentWakeupRequests.payload}->'executionWait'->>'trigger', '') = 'pause_lifted'
    or exists (select 1 from ${issueComments} where ${issueComments.companyId} = ${agentWakeupRequests.companyId}
      and ${issueComments.authorType} = 'user' and ${issueComments.deletedAt} is null
      and ${issueComments.id}::text in (select jsonb_array_elements_text(
        case when jsonb_typeof(${ids}) = 'array' then ${ids} else '[]'::jsonb end)))))`;
}

/**
 * Save why a deferred request cannot start yet. When the reason changes, the
 * request's task also records an `issue.execution_waiting` activity. Its live
 * event refreshes an open task page, so a person who just pressed Retry sees
 * the kept failure and the named wait (for example the budget) without
 * reloading. Pass `publications` when the caller's transaction is still open;
 * they must be published after it commits.
 */
export async function writeDeferredExecutionWait(db: Db, scope: { companyId: string; requestId: string },
  condition: Record<string, unknown>, options: { replace?: boolean; publications?: ActivityPublication[] } = {}) {
  const pending: ActivityPublication[] = [];
  const saved = await db.transaction(async tx => {
    const [current] = await tx.select({ payload: agentWakeupRequests.payload, agentId: agentWakeupRequests.agentId }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, scope.requestId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"))).for("update");
    if (!current) return false;
    const previous = current.payload?.executionWait;
    const previousReason = previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>).reason : undefined;
    const reasonChanged = !previous || previousReason !== condition.reason;
    if (reasonChanged) await notifyDeferredExecutionWork(tx, scope);
    const [saved] = await tx.update(agentWakeupRequests).set({
      payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}',
        ${options.replace ? sql`'{}'::jsonb` : sql`coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb)`}
          || ${JSON.stringify(condition)}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, scope.requestId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"))).returning({ id: agentWakeupRequests.id });
    const issueId = current.payload?.issueId;
    if (saved && reasonChanged && typeof issueId === "string" && issueId && typeof condition.reason === "string") {
      const { publication } = await persistActivity(tx as unknown as Db, { companyId: scope.companyId, actorType: "system",
        actorId: "execution-admission", action: "issue.execution_waiting", entityType: "issue", entityId: issueId,
        agentId: current.agentId, details: { requestId: scope.requestId, reason: condition.reason } });
      pending.push(publication);
    }
    return Boolean(saved);
  });
  if (options.publications) options.publications.push(...pending);
  else for (const publication of pending) publishActivity(publication);
  return saved;
}

export async function releaseDecisionHeldExecution(tx: object, scope: { companyId: string; issueId?: string | null }) {
  if (!scope.issueId) return;
  const db = tx as Pick<Db, "select" | "update">;
  await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId))).for("update");
  const held = and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
    sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}' = 'decision_pending'`);
  const receipts = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(held).for("update");
  if (!receipts.length) return;
  for (const { id } of receipts) await notifyDeferredExecutionWork(tx, { companyId: scope.companyId, requestId: id });
  await db.update(agentWakeupRequests).set({
    payload: sql`${agentWakeupRequests.payload} - 'executionWait'`,
    updatedAt: new Date(),
  }).where(and(held, inArray(agentWakeupRequests.id, receipts.map(receipt => receipt.id))));
}
