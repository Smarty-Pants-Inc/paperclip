import { and, eq } from "drizzle-orm";
import { agentTaskSessions, issues, type Db } from "@paperclipai/db";
import { PI_CONVERSATION_KEY, readPiConversation } from "./pi-conversation-record.js";

/**
 * Provider-session identity lineage (#20787 J3-17, the reset-record contract).
 *
 * A failover backup manifest names the provider session it saved. A box may
 * later hold a DIFFERENT provider session for the same conversation when a
 * governed step started a new provider thread: a config reset, a resume that
 * failed on a new box (restart-up's same-run replacement), or a forced fresh
 * session. Each such step is recorded here, on the conversation's
 * piConversation lineage, as { previousIdentity -> identity }. The identities
 * are the exact objects the executor compares: the output of
 * providerSessionIdentityFromDurableProviderState, compared by canonical JSON.
 *
 * The executor accepts a changed identity only when these records form an
 * unbroken chain from the backup manifest's identity to the box's current
 * identity, every record in the chain belongs to the same company, task and
 * normalized session, and generations are contiguous. An unrecorded change, a
 * gap or a foreign record still refuses with provider_identity_changed.
 */
export const PROVIDER_IDENTITY_RESET_SCHEMA = "paperclip.provider-identity-reset.v1";
export const PROVIDER_IDENTITY_RESET_REASONS = ["config_changed", "resume_failed_on_new_box", "forced_fresh_session"] as const;
export type ProviderIdentityResetReason = typeof PROVIDER_IDENTITY_RESET_REASONS[number];
/** Older records fall out of the window; a manifest older than it refuses (fail closed). */
export const PROVIDER_IDENTITY_RESET_LIMIT = 32;

export interface ProviderIdentityResetRecord {
  schema: typeof PROVIDER_IDENTITY_RESET_SCHEMA;
  generation: number;
  companyId: string;
  taskKey: string;
  normalizedSessionId: string;
  previousIdentity: Record<string, unknown>;
  identity: Record<string, unknown>;
  reason: ProviderIdentityResetReason;
  recordedAt: string;
  runId: string | null;
}

export interface ProviderIdentityLineageScope {
  companyId: string;
  agentId: string;
  /** The task-session key: the conversation's issue id. */
  taskKey: string;
  normalizedSessionId: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const identityPresent = (value: unknown): value is Record<string, unknown> =>
  plainObject(value) && ["providerSessionId", "providerBackendSessionId", "providerSessionIdentity"]
    .some(field => value[field] !== null && value[field] !== undefined);

function scopedRecord(value: unknown, scope: Omit<ProviderIdentityLineageScope, "agentId">): value is ProviderIdentityResetRecord {
  if (!plainObject(value)) return false;
  return value.schema === PROVIDER_IDENTITY_RESET_SCHEMA
    && Number.isSafeInteger(value.generation) && Number(value.generation) >= 1
    && value.companyId === scope.companyId && value.taskKey === scope.taskKey
    && value.normalizedSessionId === scope.normalizedSessionId
    && identityPresent(value.previousIdentity) && identityPresent(value.identity)
    && canonical(value.previousIdentity) !== canonical(value.identity)
    && (PROVIDER_IDENTITY_RESET_REASONS as readonly unknown[]).includes(value.reason)
    && typeof value.recordedAt === "string";
}

/** The records stored on this conversation's piConversation lineage, unfiltered. */
export function providerIdentityResetsFromSessionParams(params: Record<string, unknown> | null | undefined): unknown[] {
  let conversation: ReturnType<typeof readPiConversation>;
  try { conversation = readPiConversation(params); } catch { return []; }
  const records = (conversation as (typeof conversation & { providerIdentityResets?: unknown }) | null)?.providerIdentityResets;
  return Array.isArray(records) ? records : [];
}

/**
 * Follow the recorded chain from `from`. Returns the identity at its end, or
 * null when the lineage is ambiguous (two records leave the same identity in
 * the next generation). Records that are malformed or belong to another
 * company, task or session are never links, so they leave a gap.
 */
export function providerIdentityChainEnd(input: {
  records: readonly unknown[];
  scope: Omit<ProviderIdentityLineageScope, "agentId">;
  from: unknown;
}): { identity: unknown; steps: number } | null {
  const records = input.records.filter((value): value is ProviderIdentityResetRecord => scopedRecord(value, input.scope));
  let node = canonical(input.from);
  let identity: unknown = input.from;
  let generation: number | null = null;
  let steps = 0;
  for (let guard = 0; guard <= records.length; guard++) {
    const next = records.filter(candidate => canonical(candidate.previousIdentity) === node
      && (generation === null || candidate.generation === generation + 1));
    if (next.length === 0) return { identity, steps };
    if (next.length > 1) return null;
    node = canonical(next[0]!.identity);
    identity = next[0]!.identity;
    generation = next[0]!.generation;
    steps += 1;
  }
  return null;
}

/**
 * True iff the recorded steps form an unbroken chain from the backup
 * manifest's identity (`previous`) to the box's identity (`current`), and
 * `current` is the end of that chain (a box holding a superseded thread of
 * this lineage still refuses).
 */
export function providerIdentityChainAllows(input: {
  records: readonly unknown[];
  scope: Omit<ProviderIdentityLineageScope, "agentId">;
  previous: unknown;
  current: unknown;
}): boolean {
  if (!identityPresent(input.previous) || !identityPresent(input.current)) return false;
  if (canonical(input.previous) === canonical(input.current)) return false;
  const end = providerIdentityChainEnd({ records: input.records, scope: input.scope, from: input.previous });
  return end !== null && end.steps > 0 && canonical(end.identity) === canonical(input.current);
}

const taskSessionScope = (scope: ProviderIdentityLineageScope) => and(
  eq(agentTaskSessions.companyId, scope.companyId), eq(agentTaskSessions.agentId, scope.agentId),
  eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, scope.taskKey));

/**
 * A governed new provider thread started on this conversation, before any
 * record names its identity: restart-up's same-run replacement, or a fresh
 * start on a new box while a durable backup names the older thread. It is
 * stored DURABLY in the run that starts the thread, inside the piConversation
 * record beside providerIdentityResets (review-fleet-3 F1, #20787 J3-21), so
 * a stop, crash or swap before the first suspended read does not lose it. The
 * identity is filled in at the first suspended read of the box, before or
 * after a restart, and only for the box named by providerLeaseId (null: the
 * caller could not name the box). Publishing a backup clears it.
 */
export interface PendingProviderIdentityBreak {
  reason: ProviderIdentityResetReason;
  runId: string;
  /** The box the new thread started on; null when the caller cannot name it. */
  providerLeaseId: string | null;
  notedAt: string;
}
/** The durable note's field inside the piConversation record. */
export const PENDING_PROVIDER_IDENTITY_BREAK_KEY = "pendingProviderIdentityBreak";

function pendingBreakFromConversation(conversation: unknown): PendingProviderIdentityBreak | null {
  const value = plainObject(conversation) ? conversation[PENDING_PROVIDER_IDENTITY_BREAK_KEY] : undefined;
  if (!plainObject(value)) return null;
  if (!(PROVIDER_IDENTITY_RESET_REASONS as readonly unknown[]).includes(value.reason)
    || typeof value.runId !== "string" || !value.runId
    || !(value.providerLeaseId === null || (typeof value.providerLeaseId === "string" && value.providerLeaseId))
    || typeof value.notedAt !== "string") return null;
  return { reason: value.reason as ProviderIdentityResetReason, runId: value.runId,
    providerLeaseId: value.providerLeaseId as string | null, notedAt: value.notedAt };
}

const samePendingBreak = (left: PendingProviderIdentityBreak | null, right: PendingProviderIdentityBreak | null) =>
  left !== null && right !== null && canonical(left) === canonical(right);

/** The lineage's records and durable pending note; empty when the conversation is missing or rotated. */
async function readProviderIdentityLineage(db: Pick<Db, "select">, scope: ProviderIdentityLineageScope): Promise<{
  records: unknown[]; pending: PendingProviderIdentityBreak | null;
}> {
  const [session] = await db.select().from(agentTaskSessions).where(taskSessionScope(scope)).limit(1);
  const conversation = (() => { try { return readPiConversation(session?.sessionParamsJson); } catch { return null; } })();
  // Records live with the conversation they describe. A rotated conversation
  // (a new normalized session) starts a new lineage and new backups.
  if (!conversation || conversation.id !== scope.normalizedSessionId) return { records: [], pending: null };
  return { records: providerIdentityResetsFromSessionParams(session?.sessionParamsJson),
    pending: pendingBreakFromConversation(conversation) };
}

export async function readProviderIdentityResets(db: Pick<Db, "select">, scope: ProviderIdentityLineageScope): Promise<unknown[]> {
  return (await readProviderIdentityLineage(db, scope)).records;
}

/** The durable pending note of this conversation, if any. */
export async function readPendingProviderIdentityBreak(db: Pick<Db, "select">, scope: ProviderIdentityLineageScope):
  Promise<PendingProviderIdentityBreak | null> {
  return (await readProviderIdentityLineage(db, scope)).pending;
}

/**
 * Edit this conversation's piConversation record under the issue →
 * task-session lock order used by selectPiConversation. `edit` returns the
 * next conversation (null: no write) and the result.
 */
async function editLockedLineage<T>(db: Db, scope: ProviderIdentityLineageScope,
  edit: (conversation: Record<string, unknown>) => { next: Record<string, unknown> | null; result: T }): Promise<T> {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues)
      .where(and(eq(issues.id, scope.taskKey), eq(issues.companyId, scope.companyId))).for("no key update");
    if (!issue) throw new Error("provider_identity_reset_lineage_missing");
    const [session] = await tx.select().from(agentTaskSessions).where(taskSessionScope(scope)).for("update");
    const conversation = readPiConversation(session?.sessionParamsJson);
    if (!session || !conversation || conversation.id !== scope.normalizedSessionId) {
      throw new Error("provider_identity_reset_lineage_missing");
    }
    const { next, result } = edit(conversation as unknown as Record<string, unknown>);
    if (next) {
      const params = session.sessionParamsJson ?? {};
      await tx.update(agentTaskSessions).set({
        sessionParamsJson: { ...params, [PI_CONVERSATION_KEY]: next },
        updatedAt: new Date(),
      }).where(eq(agentTaskSessions.id, session.id));
    }
    return result;
  });
}

/**
 * Append one step to the lineage under the issue → task-session lock order
 * used by selectPiConversation. The step must extend the newest record (or
 * start the lineage); anything else would leave a gap and is refused. With
 * `consumePending`, the same transaction drops that durable pending note.
 */
export async function appendProviderIdentityReset(db: Db, input: {
  scope: ProviderIdentityLineageScope;
  previousIdentity: Record<string, unknown>;
  identity: Record<string, unknown>;
  reason: ProviderIdentityResetReason;
  runId: string | null;
  recordedAt?: Date;
  consumePending?: PendingProviderIdentityBreak;
  /**
   * Called once, after commit, only when THIS call wrote a new record (the
   * person-visible line, #20853). An idempotent retry of the newest step is
   * not a new record. A failing callback never undoes or refuses the record.
   */
  onRecorded?: (record: ProviderIdentityResetRecord) => Promise<void> | void;
}): Promise<ProviderIdentityResetRecord> {
  if (!identityPresent(input.previousIdentity) || !identityPresent(input.identity)
    || canonical(input.previousIdentity) === canonical(input.identity)) {
    throw new Error("provider_identity_reset_identity_invalid");
  }
  let created = false;
  const written = await editLockedLineage(db, input.scope, conversation => {
    created = false;
    const records = (Array.isArray(conversation.providerIdentityResets) ? conversation.providerIdentityResets : [])
      .filter((value): value is ProviderIdentityResetRecord => scopedRecord(value, input.scope));
    const newest = records.reduce<ProviderIdentityResetRecord | null>(
      (latest, candidate) => !latest || candidate.generation > latest.generation ? candidate : latest, null);
    const consumes = input.consumePending !== undefined
      && samePendingBreak(pendingBreakFromConversation(conversation), input.consumePending);
    const withoutPending = () => {
      const next = { ...conversation };
      delete next[PENDING_PROVIDER_IDENTITY_BREAK_KEY];
      return next;
    };
    if (newest && canonical(newest.previousIdentity) === canonical(input.previousIdentity)
      && canonical(newest.identity) === canonical(input.identity)) {
      return { next: consumes ? withoutPending() : null, result: newest };
    }
    if (newest && canonical(newest.identity) !== canonical(input.previousIdentity)) {
      throw new Error("provider_identity_reset_chain_broken");
    }
    const record: ProviderIdentityResetRecord = {
      schema: PROVIDER_IDENTITY_RESET_SCHEMA,
      generation: (newest?.generation ?? 0) + 1,
      companyId: input.scope.companyId,
      taskKey: input.scope.taskKey,
      normalizedSessionId: input.scope.normalizedSessionId,
      previousIdentity: structuredClone(input.previousIdentity),
      identity: structuredClone(input.identity),
      reason: input.reason,
      recordedAt: (input.recordedAt ?? new Date()).toISOString(),
      runId: input.runId,
    };
    const kept = [...records, record].sort((left, right) => left.generation - right.generation)
      .slice(-PROVIDER_IDENTITY_RESET_LIMIT);
    created = true;
    return { next: { ...(consumes ? withoutPending() : conversation), providerIdentityResets: kept }, result: record };
  });
  if (created) {
    try { await input.onRecorded?.(written); } catch { /* the record is durable; the line is best effort */ }
  }
  return written;
}

/**
 * In-process copy of each note. It is a fallback only for a note whose
 * durable write failed; a restart loses it (fail closed, as before F1).
 */
const pendingProviderIdentityBreaks = new Map<string, PendingProviderIdentityBreak>();
const pendingKey = (scope: ProviderIdentityLineageScope) =>
  JSON.stringify([scope.companyId, scope.agentId, scope.taskKey, scope.normalizedSessionId]);

/**
 * Note a governed new provider thread, durably, in the run that starts it.
 * Returns false when the durable write failed (missing or rotated
 * conversation, database error); the in-process note then remains the only
 * copy, and a restart before the first suspended read refuses the thread.
 */
export async function noteProviderIdentityBreak(db: Db, scope: ProviderIdentityLineageScope,
  reason: ProviderIdentityResetReason, runId: string, providerLeaseId: string | null = null,
  notedAt: Date = new Date()): Promise<boolean> {
  const note: PendingProviderIdentityBreak = { reason, runId, providerLeaseId, notedAt: notedAt.toISOString() };
  pendingProviderIdentityBreaks.set(pendingKey(scope), note);
  try {
    await editLockedLineage(db, scope, conversation => ({
      next: { ...conversation, [PENDING_PROVIDER_IDENTITY_BREAK_KEY]: note }, result: undefined }));
    return true;
  } catch {
    return false;
  }
}

/** The in-process copy of this conversation's note (see noteProviderIdentityBreak). */
export function pendingProviderIdentityBreak(scope: ProviderIdentityLineageScope): PendingProviderIdentityBreak | null {
  return pendingProviderIdentityBreaks.get(pendingKey(scope)) ?? null;
}

/**
 * A published backup names the new thread itself; a later change needs its
 * own break. Clears the in-process and the durable note (same lock order).
 */
export async function clearProviderIdentityBreak(db: Db, scope: ProviderIdentityLineageScope): Promise<void> {
  pendingProviderIdentityBreaks.delete(pendingKey(scope));
  const { pending } = await readProviderIdentityLineage(db, scope);
  if (!pending) return;
  await editLockedLineage(db, scope, conversation => {
    if (conversation[PENDING_PROVIDER_IDENTITY_BREAK_KEY] === undefined) return { next: null, result: undefined };
    const next = { ...conversation };
    delete next[PENDING_PROVIDER_IDENTITY_BREAK_KEY];
    return { next, result: undefined };
  });
}

/** Test seam: a server restart loses the in-process notes (the durable ones stay). */
export function clearPendingProviderIdentityBreaksForTest(): void {
  pendingProviderIdentityBreaks.clear();
}

/**
 * The executor's decision when a box's provider identity differs from the
 * newest compatible backup manifest. Recorded chain: allow. A pending note
 * (durable, else this process's copy) for this box: record the step from the
 * chain's end and drop the note in the same transaction, then allow only if
 * the stored chain now reaches the box. Otherwise refuse.
 */
export async function recordedProviderIdentityTransitionIsAllowed(input: {
  db: Db;
  scope: ProviderIdentityLineageScope;
  previous: unknown;
  current: unknown;
  /** The box whose state was read. */
  providerLeaseId?: string | null;
  /** Passed to appendProviderIdentityReset: a NEW record only (#20853). */
  onRecorded?: (record: ProviderIdentityResetRecord) => Promise<void> | void;
}): Promise<boolean> {
  if (!identityPresent(input.previous) || !identityPresent(input.current)) return false;
  const lineage = await readProviderIdentityLineage(input.db, input.scope);
  const { records } = lineage;
  if (providerIdentityChainAllows({ records, scope: input.scope, previous: input.previous, current: input.current })) return true;
  const memory = pendingProviderIdentityBreak(input.scope);
  const pending = lineage.pending ?? memory;
  if (!pending) return false;
  // A new thread noted on one box never authorizes the state of another.
  if (pending.providerLeaseId !== null && pending.providerLeaseId !== (input.providerLeaseId ?? null)) return false;
  const end = providerIdentityChainEnd({ records, scope: input.scope, from: input.previous });
  if (!end || !identityPresent(end.identity)) return false;
  try {
    await appendProviderIdentityReset(input.db, { scope: input.scope, previousIdentity: end.identity,
      identity: input.current, reason: pending.reason, runId: pending.runId, onRecorded: input.onRecorded,
      ...(lineage.pending ? { consumePending: lineage.pending } : {}) });
    if (samePendingBreak(pendingProviderIdentityBreak(input.scope), pending)) pendingProviderIdentityBreaks.delete(pendingKey(input.scope));
  } catch {
    // A concurrent reader may have recorded the same step; the stored chain decides.
  }
  const stored = await readProviderIdentityResets(input.db, input.scope);
  return providerIdentityChainAllows({ records: stored, scope: input.scope, previous: input.previous, current: input.current });
}
