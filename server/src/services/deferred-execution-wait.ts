import { HttpError } from "../errors.js";
import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { agentWakeupRequests, issues, type Db } from "@paperclipai/db";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/** The sweep's existing start bound, shared with the remote-cleanup panel. */
export const PENDING_WAIT_START_BOUND_MS = 10 * 60_000;
export const REMOTE_CLEANUP_PERSON_WAIT_MS = PENDING_WAIT_START_BOUND_MS;
export const REMOTE_CLEANUP_EXECUTION_WAIT_MESSAGE = "Your message is saved. The run you stopped is still shutting down, so your message hasn't started yet.";
export const REMOTE_CLEANUP_PERSON_WAIT_EXPIRED_MESSAGE = "Your message is saved, but the run you stopped still hasn't shut down, so it can't start yet. You can delete it if you no longer need it.";

/** Person-facing projection of the saved receipt, not a second notice or timer.
 * The receipt's immutable request time owns the clock: recovery retries and
 * repeated GETs cannot restart it. Admission still owns releasing the hold
 * (U3/U5); at the bound we only stop promising an unbounded automatic start. */
export function executionWaitForPerson(wait: Record<string, unknown>, requestedAt: Date | null | undefined,
  now = Date.now()): { reason: string; message: string } | null {
  if (!isWellFormedExecutionWait(wait)) return null;
  return { reason: wait.reason, message: wait.reason === "remote_cleanup" && requestedAt
    && now >= requestedAt.getTime() + REMOTE_CLEANUP_PERSON_WAIT_MS
    ? REMOTE_CLEANUP_PERSON_WAIT_EXPIRED_MESSAGE : wait.message };
}

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
