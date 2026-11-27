import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { NativeTurnPromptExceedsCommandBoundError, nativeInputRevision } from "./native-runtime/native-turn-budget.js";

type Scope = { companyId: string; issueId: string; agentId?: string };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export function isNativeInputSizeRefusal(code: string | null | undefined): boolean {
  return code === "native_turn_prompt_exceeds_command_bound" || code === "command_payload_too_large";
}
async function currentInputRevision(db: Db, scope: Scope, sourceMessageIds?: ReadonlySet<string>) {
  const [issue] = await db.select({ title: issues.title, description: issues.description }).from(issues)
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId)));
  if (!issue) return null;
  const messages = await db.select({ id: issueComments.id, authorType: issueComments.authorType,
    authorUserId: issueComments.authorUserId, createdByRunId: issueComments.createdByRunId,
    updatedAt: issueComments.updatedAt, deletedAt: issueComments.deletedAt }).from(issueComments)
    .where(and(eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, scope.issueId)))
    .orderBy(asc(issueComments.id));
  // Named refused source messages count whoever authored/repairs them. New
  // person input also changes the request. Unrelated system bookkeeping must
  // not invalidate a hold and replay the same refused source.
  return nativeInputRevision(issue, messages.filter(message => !sourceMessageIds || sourceMessageIds.has(message.id)
    || ((message.authorType === "user" || message.authorUserId) && !message.createdByRunId)).map(message => ({ ...message,
    authorType: message.authorType ?? (message.authorUserId ? "user" : "system"),
    updatedAt: message.updatedAt.toISOString(), deleted: message.deletedAt !== null })));
}
/** Persist the attempted revisions, never a person's later repair. Late command
 * guards use the revision carried by the run before consulting current input. */
export async function nativeInputRefusalEvidence(db: Db, run: { companyId: string; issueId?: string | null;
  nativeIssueId?: string | null; contextSnapshot: unknown }, error: unknown, code: string) {
  if (!isNativeInputSizeRefusal(code)) return {};
  const issueId = run.nativeIssueId ?? run.issueId ?? object(run.contextSnapshot).issueId;
  const carriedRevision = object(run.contextSnapshot).nativeInputRevision;
  const revision = error instanceof NativeTurnPromptExceedsCommandBoundError && error.inputRevision
    ? error.inputRevision : carriedRevision ?? (typeof issueId === "string" ? await currentInputRevision(db, { companyId: run.companyId, issueId }) : null);
  return revision ? { nativeTurnPromptRefusalInput: revision } : {};
}
/** Cheap latest-terminal classification before the full refusal/revision read.
 * Keep coalesce precedence while exposing each existing task index to the planner. */
export async function latestTaskRunIsNativeInputSizeRefusal(db: Db, scope: Scope): Promise<boolean> {
  const [run] = await db.select({ errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId),
    scope.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined,
    inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "interrupted"]),
    or(eq(heartbeatRuns.nativeIssueId, scope.issueId),
      and(isNull(heartbeatRuns.nativeIssueId), eq(heartbeatRuns.issueId, scope.issueId)),
      and(isNull(heartbeatRuns.nativeIssueId), isNull(heartbeatRuns.issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${scope.issueId}`)),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  return isNativeInputSizeRefusal(run?.errorCode);
}
/** All automatic admissions consult the same durable source revision. User
 * wakes bypass this check: an edit/new request is an explicit attempt. Old
 * refusals without revision evidence fail closed until that person acts. */
export async function hasUnchangedNativeInputRefusal(db: Db, scope: Scope): Promise<boolean> {
  const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
    resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId),
    scope.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined,
    // Pending or cancelled queued work did not consume the refused input.
    inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "interrupted"]),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId') = ${scope.issueId}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (!run || run.status !== "failed" || !isNativeInputSizeRefusal(run.errorCode)) return false;
  const revision = object(object(run.resultJson).nativeTurnPromptRefusalInput);
  const saved = revision.fingerprint;
  if (typeof saved !== "string" || !/^[a-f0-9]{64}$/.test(saved)) return true;
  const sourceIds = Array.isArray(revision.messages)
    ? new Set(revision.messages.flatMap(message => typeof object(message).id === "string" ? [object(message).id as string] : [])) : undefined;
  const current = await currentInputRevision(db, scope, sourceIds);
  return current === null || current.fingerprint === saved;
}

/** Stable content identity: JSONB may reorder object keys on round trip. */
function contentKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(contentKey).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${contentKey(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** One pending held receipt per task/agent, serialized by the same issue row
 * lock as promotion. Keep distinct event payloads, not one lossy last-write.
 * Existing receipt identities are settled as coalesced, never deleted. */
export async function deferNativeInputRefusalWake(db: Db, input: {
  companyId: string; issueId: string; agentId: string; source: string;
  triggerDetail: string | null; reason: string | null; payload: Record<string, unknown>;
  contextSnapshot: Record<string, unknown>; requestedByActorType: string | null;
  requestedByActorId: string | null; idempotencyKey: string | null; requestId?: string | null;
}): Promise<boolean> {
  return db.transaction(async rawTx => {
    const tx = rawTx as unknown as Db;
    await tx.execute(sql`select id from issues where company_id = ${input.companyId} and id = ${input.issueId} for update`);
    if (!await latestTaskRunIsNativeInputSizeRefusal(tx, input) || !await hasUnchangedNativeInputRefusal(tx, input)) return false;
    const rows = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      or(sql`${agentWakeupRequests.payload}->>'nativeInputRefusalHold' = 'true'`,
        input.requestId ? eq(agentWakeupRequests.id, input.requestId) : undefined,
        input.idempotencyKey ? eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey) : undefined),
    )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
    const eventFor = (row: { source: string | null; triggerDetail: string | null; reason: string | null;
      payload: unknown; requestedByActorType: string | null; requestedByActorId: string | null }) => {
      const payload = { ...object(row.payload) };
      delete payload.nativeInputRefusalHold;
      delete payload.nativeInputRefusalWakes;
      const contextSnapshot = { ...object(payload._paperclipWakeContext) };
      delete contextSnapshot.nativeInputRefusalWakes;
      delete payload._paperclipWakeContext;
      return { source: row.source, triggerDetail: row.triggerDetail, reason: row.reason,
        requestedByActorType: row.requestedByActorType, requestedByActorId: row.requestedByActorId, payload, contextSnapshot };
    };
    const events = new Map<string, unknown>();
    for (const row of rows) {
      const prior = object(row.payload).nativeInputRefusalWakes;
      for (const event of Array.isArray(prior) ? prior : [eventFor(row)]) events.set(contentKey(event), event);
    }
    const event = eventFor({ ...input, payload: { ...input.payload, _paperclipWakeContext: input.contextSnapshot } });
    events.set(contentKey(event), event);
    const first = rows[0];
    const seed = first ? object(first.payload) : input.payload;
    const payload = { ...seed, issueId: input.issueId, nativeInputRefusalHold: true,
      nativeInputRefusalWakes: [...events.values()],
      _paperclipWakeContext: { ...object(seed._paperclipWakeContext ?? input.contextSnapshot) } };
    if (first) {
      await tx.update(agentWakeupRequests).set({ payload, updatedAt: new Date(), coalescedCount: first.coalescedCount + 1 })
        .where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, first.id)));
      for (const row of rows.slice(1)) await tx.update(agentWakeupRequests).set({ status: "coalesced", finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, row.id)));
    } else {
      await notifyDeferredExecutionWork(tx, { companyId: input.companyId });
      await tx.insert(agentWakeupRequests).values({ companyId: input.companyId, agentId: input.agentId,
        source: input.source, triggerDetail: input.triggerDetail, reason: input.reason, payload,
        requestedByActorType: input.requestedByActorType, requestedByActorId: input.requestedByActorId,
        idempotencyKey: input.idempotencyKey, status: "deferred_issue_execution" }).onConflictDoNothing();
    }
    return true;
  });
}
