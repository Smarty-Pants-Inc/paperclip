import { randomUUID } from "node:crypto";
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
    const [refused] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
      inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "interrupted"]),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (refused) await restoreRefusedNativeInputWakes(tx, refused);
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
      delete payload.nativeInputRefusalAgentIds;
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
    const owners = new Set([input.agentId, ...rows.flatMap(row => {
      const prior = object(row.payload).nativeInputRefusalAgentIds;
      return Array.isArray(prior) ? prior.filter((id): id is string => typeof id === "string") : [row.agentId];
    })]);
    const payload = { ...seed, issueId: input.issueId, nativeInputRefusalHold: true,
      nativeInputRefusalAgentIds: [...owners], nativeInputRefusalWakes: [...events.values()],
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

/** A legacy prompt's view cut is not delivery. Split its bound receipt under
 * the ordinary issue lock; release/promotion then carries the remainder forward.
 * Re-entry expands pending debt only. Once a successor adopts a generation,
 * its snapshot owns those events; additional debt needs a new pending receipt. */
export async function deferUndeliveredNativeInputWakes(db: Db, scope: Required<Scope> & { runId: string }, omitted: unknown[]): Promise<void> {
  if (!omitted.length) return;
  await db.transaction(async rawTx => {
    const tx = rawTx as unknown as Db;
    await tx.execute(sql`select id from issues where company_id = ${scope.companyId} and id = ${scope.issueId} for update`);
    const key = `native-saved-wake-remainder:${scope.runId}`;
    const bound = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, scope.agentId),
      eq(agentWakeupRequests.runId, scope.runId), sql`${agentWakeupRequests.payload}->>'nativeInputRefusalHold' = 'true'`,
    )).for("update");
    const generations = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, scope.agentId),
      or(eq(agentWakeupRequests.idempotencyKey, key), sql`${agentWakeupRequests.idempotencyKey} like ${key + ":%"}`),
    )).for("update");
    const eventsOf = (row: typeof generations[number] | undefined): unknown[] => {
      const events = object(row?.payload).nativeInputRefusalWakes;
      return Array.isArray(events) ? events : [];
    };
    const pending = generations.find(row => row.status === "deferred_issue_execution" && row.runId === null);
    // Historical generations are delivery obligations already transferred to
    // another receipt/run. Do not enlarge them or copy their events back out
    // of the successor's immutable snapshot on repeated fallback admission.
    const transferred = new Set(generations.filter(row => row !== pending).flatMap(eventsOf).map(contentKey));
    const owed = new Map<string, unknown>();
    for (const event of [...eventsOf(pending), ...omitted]) {
      const identity = contentKey(event);
      if (!transferred.has(identity)) owed.set(identity, event);
    }
    if (!owed.size) return;
    const owners = new Set([scope.agentId]);
    for (const row of bound) {
      const payload = object(row.payload), events = payload.nativeInputRefusalWakes;
      if (!Array.isArray(events)) continue;
      const kept = events.filter(event => !owed.has(contentKey(event)));
      if (kept.length === events.length) continue;
      for (const id of Array.isArray(payload.nativeInputRefusalAgentIds) ? payload.nativeInputRefusalAgentIds : []) if (typeof id === "string") owners.add(id);
      await tx.update(agentWakeupRequests).set({ payload: { ...payload, nativeInputRefusalWakes: kept }, updatedAt: new Date() })
        .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, row.id), eq(agentWakeupRequests.runId, scope.runId)));
    }
    const payload = { issueId: scope.issueId, nativeInputRefusalHold: true, nativeInputRefusalAgentIds: [...owners],
      nativeInputRefusalWakes: [...owed.values()], _paperclipWakeContext: { issueId: scope.issueId, wakeReason: "saved_automatic_events_owed" } };
    const updated = pending ? await tx.update(agentWakeupRequests).set({ payload, updatedAt: new Date() }).where(and(
      eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, pending.id),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId)))
      .returning({ id: agentWakeupRequests.id }) : [];
    if (!updated.length) {
      // The locked transition must actually retain custody. Never silently
      // treat a zero-row update as preservation. If custody moved, only the
      // extra events belong in the new generation, not the adopted events.
      if (pending) for (const event of eventsOf(pending)) owed.delete(contentKey(event));
      if (!owed.size) return;
      await tx.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
        source: "automation", reason: "saved_automatic_events_owed", requestedByActorType: "system",
        status: "deferred_issue_execution", idempotencyKey: generations.length ? `${key}:${randomUUID()}` : key,
        payload: { ...payload, nativeInputRefusalWakes: [...owed.values()] } });
    }
    await notifyDeferredExecutionWork(tx, { companyId: scope.companyId });
  });
}

/** Called under the issue lock after the terminal refusal is durable. Binding
 * an owed receipt to an attempt is not delivery if that attempt never fit. */
export async function restoreRefusedNativeInputWakes(db: Db, run: {
  id: string; companyId: string; agentId: string; status: string; errorCode: string | null;
}) {
  if (run.status !== "failed" || !isNativeInputSizeRefusal(run.errorCode)) return;
  const restored = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.runId, run.id),
    sql`${agentWakeupRequests.payload}->>'nativeInputRefusalHold' = 'true'`,
  ));
  for (const row of restored) {
    const payload = object(row.payload), prior = payload.nativeInputRefusalAgentIds;
    const owners = new Set([run.agentId, ...(Array.isArray(prior) ? prior.filter((id): id is string => typeof id === "string") : [row.agentId])]);
    await db.update(agentWakeupRequests).set({ runId: null, status: "deferred_issue_execution", finishedAt: null,
      payload: { ...payload, nativeInputRefusalAgentIds: [...owners] }, updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, row.id), eq(agentWakeupRequests.runId, run.id)));
  }
  if (restored.length) await notifyDeferredExecutionWork(db, { companyId: run.companyId });
}

/** A reassigned held receipt retains the original refusal's revision gate.
 * All source holds must be repaired before a merged aggregate is delivered. */
export async function heldNativeInputWakeIsUnchanged(db: Db, scope: Required<Scope>, payload: unknown): Promise<boolean> {
  const owners = object(payload).nativeInputRefusalAgentIds;
  const ids = [scope.agentId, ...(Array.isArray(owners) ? owners.filter((id): id is string => typeof id === "string") : [])];
  for (const agentId of new Set(ids)) {
    const ownerScope = { ...scope, agentId };
    if (await latestTaskRunIsNativeInputSizeRefusal(db, ownerScope) && await hasUnchangedNativeInputRefusal(db, ownerScope)) return true;
  }
  return false;
}

/** Reassignment changes custody, not the input revision or its owed content.
 * The caller holds the same issue lock used for admission and release. */
export async function handOverNativeInputWakes(db: Db, scope: { companyId: string; issueId: string }) {
  const [issue] = await db.select({ agentId: issues.assigneeAgentId }).from(issues).where(and(
    eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId)));
  if (!issue?.agentId) return;
  const rows = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    isNull(agentWakeupRequests.runId), sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
    sql`${agentWakeupRequests.payload}->>'nativeInputRefusalHold' = 'true'`,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
  if (rows.length < 2 && !rows.some(row => row.agentId !== issue.agentId)) return;
  const events = new Map<string, unknown>(), owners = new Set<string>();
  for (const row of rows) {
    const payload = object(row.payload), prior = payload.nativeInputRefusalAgentIds;
    for (const id of Array.isArray(prior) ? prior : [row.agentId]) if (typeof id === "string") owners.add(id);
    const saved = payload.nativeInputRefusalWakes;
    for (const event of Array.isArray(saved) ? saved : [{ source: row.source, triggerDetail: row.triggerDetail, reason: row.reason,
      requestedByActorType: row.requestedByActorType, requestedByActorId: row.requestedByActorId,
      payload: Object.fromEntries(Object.entries(payload).filter(([key]) => !["nativeInputRefusalHold", "_paperclipWakeContext"].includes(key))),
      contextSnapshot: object(payload._paperclipWakeContext) }]) events.set(contentKey(event), event);
  }
  const first = rows[0]!;
  await db.update(agentWakeupRequests).set({ agentId: issue.agentId, payload: { ...object(first.payload),
    nativeInputRefusalWakes: [...events.values()], nativeInputRefusalAgentIds: [...owners] }, updatedAt: new Date(),
  }).where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, first.id)));
  for (const row of rows.slice(1)) await db.update(agentWakeupRequests).set({ status: "coalesced", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, row.id)));
}

/** Final execution boundary for old queued receipts as well as new admissions.
 * Caller holds the issue lock; use issue -> wake -> run order throughout. A
 * declined queued attempt never consumed its receipt, so return it to pending. */
export async function deferUnchangedNativeInputRunClaim(db: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string): Promise<boolean> {
  const [wake] = run.wakeupRequestId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.agentId, run.agentId),
  )).for("update") : [];
  const payload = object(wake?.payload), context = object(run.contextSnapshot);
  const automatic = wake ? wake.source === "automation" || wake.requestedByActorType !== "user" : run.invocationSource !== "on_demand" || Boolean(run.scheduledRetryReason);
  if (payload.nativeInputRefusalHold !== true && context.nativeInputRefusalHold !== true && !automatic) return false;
  const scope = { companyId: run.companyId, agentId: run.agentId, issueId };
  if (!await heldNativeInputWakeIsUnchanged(db, scope, payload)) return false;
  const [lockedRun] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).for("update");
  if (!lockedRun || lockedRun.status !== "queued") return true;
  if (wake && wake.runId === run.id) {
    await db.update(agentWakeupRequests).set({ status: "deferred_issue_execution", runId: null, claimedAt: null, finishedAt: null,
      payload: { ...payload, issueId, nativeInputRefusalHold: true,
        nativeInputRefusalWakes: Array.isArray(payload.nativeInputRefusalWakes) ? payload.nativeInputRefusalWakes : [{
          source: wake.source, triggerDetail: wake.triggerDetail, reason: wake.reason, requestedByActorType: wake.requestedByActorType,
          requestedByActorId: wake.requestedByActorId, payload: Object.fromEntries(Object.entries(payload).filter(([key]) => !["nativeInputRefusalHold", "_paperclipWakeContext"].includes(key))),
          contextSnapshot: object(payload._paperclipWakeContext ?? run.contextSnapshot),
        }],
        nativeInputRefusalAgentIds: [...new Set([run.agentId, ...(Array.isArray(payload.nativeInputRefusalAgentIds) ? payload.nativeInputRefusalAgentIds.filter((id): id is string => typeof id === "string") : [])])],
        _paperclipWakeContext: object(payload._paperclipWakeContext ?? run.contextSnapshot) }, updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.runId, run.id)));
    await notifyDeferredExecutionWork(db, { companyId: run.companyId });
  } else if (!wake) {
    await deferNativeInputRefusalWake(db, { ...scope, source: "automation", triggerDetail: run.triggerDetail,
      reason: typeof context.wakeReason === "string" ? context.wakeReason : "native_input_refusal_claim_held",
      payload: { issueId }, contextSnapshot: context, requestedByActorType: "system", requestedByActorId: null, idempotencyKey: null });
  }
  await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
    errorCode: "native_input_refusal_claim_held", error: "Required input is unchanged since the size refusal; its wake remains pending.",
    resultJson: { ...object(lockedRun.resultJson), ...(!lockedRun.startedAt ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : {}) },
  }).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")));
  await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: new Date() })
    .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), eq(issues.executionRunId, run.id)));
  return true;
}

/** Assignment revokes the old person's execution grant, not their undelivered
 * message. Copy owed data into a system-owned receipt before revoking the old
 * request. This does not transfer a person's authority to another agent. */
export async function retainRefusedPersonMessagesOnAssignment(db: Db, scope: Required<Scope>) {
  if (!await latestTaskRunIsNativeInputSizeRefusal(db, scope)) return;
  const pending = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, scope.agentId),
    eq(agentWakeupRequests.requestedByActorType, "user"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    isNull(agentWakeupRequests.runId),
    sql`coalesce(${agentWakeupRequests.payload}->>'issueId', ${agentWakeupRequests.payload}->>'taskId',
      ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId', ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId') = ${scope.issueId}`,
  )).for("update");
  for (const row of pending) {
    const payload = object(row.payload), contextSnapshot = object(payload._paperclipWakeContext);
    const ids = [payload.commentId, contextSnapshot.wakeCommentId, contextSnapshot.commentId,
      ...(Array.isArray(contextSnapshot.wakeCommentIds) ? contextSnapshot.wakeCommentIds : [])];
    // Assignment-only human grants are deliberately not replayable content.
    if (!ids.some(id => typeof id === "string") && !Array.isArray(payload.nativeInputRefusalWakes)) continue;
    await db.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: scope.agentId,
      source: "automation", reason: row.reason, triggerDetail: row.triggerDetail, requestedByActorType: "system",
      status: "deferred_issue_execution", payload: { ...payload, issueId: scope.issueId, nativeInputRefusalHold: true,
        nativeInputRefusalAgentIds: [...new Set([scope.agentId, ...(Array.isArray(payload.nativeInputRefusalAgentIds) ? payload.nativeInputRefusalAgentIds.filter((id): id is string => typeof id === "string") : [])])],
        nativeInputRefusalWakes: Array.isArray(payload.nativeInputRefusalWakes) ? payload.nativeInputRefusalWakes : [{
          source: row.source, reason: row.reason, triggerDetail: row.triggerDetail, requestedByActorType: row.requestedByActorType,
          requestedByActorId: row.requestedByActorId, payload: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "_paperclipWakeContext")), contextSnapshot,
        }],
      } });
  }
  if (pending.length) await notifyDeferredExecutionWork(db, { companyId: scope.companyId });
}
