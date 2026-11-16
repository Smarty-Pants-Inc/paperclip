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

export async function readProviderIdentityResets(db: Pick<Db, "select">, scope: ProviderIdentityLineageScope): Promise<unknown[]> {
  const [session] = await db.select().from(agentTaskSessions).where(taskSessionScope(scope)).limit(1);
  const conversation = (() => { try { return readPiConversation(session?.sessionParamsJson); } catch { return null; } })();
  // Records live with the conversation they describe. A rotated conversation
  // (a new normalized session) starts a new lineage and new backups.
  if (!conversation || conversation.id !== scope.normalizedSessionId) return [];
  return providerIdentityResetsFromSessionParams(session?.sessionParamsJson);
}

/**
 * Append one step to the lineage under the issue → task-session lock order
 * used by selectPiConversation. The step must extend the newest record (or
 * start the lineage); anything else would leave a gap and is refused.
 */
export async function appendProviderIdentityReset(db: Db, input: {
  scope: ProviderIdentityLineageScope;
  previousIdentity: Record<string, unknown>;
  identity: Record<string, unknown>;
  reason: ProviderIdentityResetReason;
  runId: string | null;
  recordedAt?: Date;
}): Promise<ProviderIdentityResetRecord> {
  if (!identityPresent(input.previousIdentity) || !identityPresent(input.identity)
    || canonical(input.previousIdentity) === canonical(input.identity)) {
    throw new Error("provider_identity_reset_identity_invalid");
  }
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues)
      .where(and(eq(issues.id, input.scope.taskKey), eq(issues.companyId, input.scope.companyId))).for("no key update");
    if (!issue) throw new Error("provider_identity_reset_lineage_missing");
    const [session] = await tx.select().from(agentTaskSessions).where(taskSessionScope(input.scope)).for("update");
    const conversation = readPiConversation(session?.sessionParamsJson);
    if (!session || !conversation || conversation.id !== input.scope.normalizedSessionId) {
      throw new Error("provider_identity_reset_lineage_missing");
    }
    const records = providerIdentityResetsFromSessionParams(session.sessionParamsJson)
      .filter((value): value is ProviderIdentityResetRecord => scopedRecord(value, input.scope));
    const newest = records.reduce<ProviderIdentityResetRecord | null>(
      (latest, candidate) => !latest || candidate.generation > latest.generation ? candidate : latest, null);
    if (newest && canonical(newest.previousIdentity) === canonical(input.previousIdentity)
      && canonical(newest.identity) === canonical(input.identity)) return newest;
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
    const params = session.sessionParamsJson ?? {};
    await tx.update(agentTaskSessions).set({
      sessionParamsJson: { ...params, [PI_CONVERSATION_KEY]: { ...conversation, providerIdentityResets: kept } },
      updatedAt: new Date(),
    }).where(eq(agentTaskSessions.id, session.id));
    return record;
  });
}

/**
 * A governed new provider thread that this process started (restart-up's
 * same-run replacement after a failed resume). The executor turns it into a
 * durable record at the first suspended-state read that sees the new thread,
 * which is the run's own checkpoint, an idle close or a restart close.
 */
type PendingProviderIdentityBreak = {
  reason: ProviderIdentityResetReason; runId: string; notedAt: number;
  /** The box the new thread started on; null when the caller cannot name it. */
  providerLeaseId: string | null;
};
const pendingProviderIdentityBreaks = new Map<string, PendingProviderIdentityBreak>();
const pendingKey = (scope: ProviderIdentityLineageScope) =>
  JSON.stringify([scope.companyId, scope.agentId, scope.taskKey, scope.normalizedSessionId]);

export function noteProviderIdentityBreak(scope: ProviderIdentityLineageScope, reason: ProviderIdentityResetReason, runId: string,
  providerLeaseId: string | null = null): void {
  pendingProviderIdentityBreaks.set(pendingKey(scope), { reason, runId, notedAt: Date.now(), providerLeaseId });
}

export function pendingProviderIdentityBreak(scope: ProviderIdentityLineageScope): PendingProviderIdentityBreak | null {
  return pendingProviderIdentityBreaks.get(pendingKey(scope)) ?? null;
}

/** A published backup names the new thread itself; a later change needs its own break. */
export function clearProviderIdentityBreak(scope: ProviderIdentityLineageScope): void {
  pendingProviderIdentityBreaks.delete(pendingKey(scope));
}

/** Test seam: a server restart loses the in-process pending notes. */
export function clearPendingProviderIdentityBreaksForTest(): void {
  pendingProviderIdentityBreaks.clear();
}

/**
 * The executor's decision when a box's provider identity differs from the
 * newest compatible backup manifest. Recorded chain: allow. A pending break
 * from this process: record the step from the chain's end, then allow only
 * if the stored chain now reaches the box. Otherwise refuse.
 */
export async function recordedProviderIdentityTransitionIsAllowed(input: {
  db: Db;
  scope: ProviderIdentityLineageScope;
  previous: unknown;
  current: unknown;
  /** The box whose state was read. */
  providerLeaseId?: string | null;
}): Promise<boolean> {
  if (!identityPresent(input.previous) || !identityPresent(input.current)) return false;
  const records = await readProviderIdentityResets(input.db, input.scope);
  if (providerIdentityChainAllows({ records, scope: input.scope, previous: input.previous, current: input.current })) return true;
  const pending = pendingProviderIdentityBreak(input.scope);
  if (!pending) return false;
  // A new thread noted on one box never authorizes the state of another.
  if (pending.providerLeaseId !== null && pending.providerLeaseId !== (input.providerLeaseId ?? null)) return false;
  const end = providerIdentityChainEnd({ records, scope: input.scope, from: input.previous });
  if (!end || !identityPresent(end.identity)) return false;
  try {
    await appendProviderIdentityReset(input.db, { scope: input.scope, previousIdentity: end.identity,
      identity: input.current, reason: pending.reason, runId: pending.runId });
  } catch {
    return false;
  }
  if (pendingProviderIdentityBreak(input.scope) === pending) pendingProviderIdentityBreaks.delete(pendingKey(input.scope));
  const stored = await readProviderIdentityResets(input.db, input.scope);
  return providerIdentityChainAllows({ records: stored, scope: input.scope, previous: input.previous, current: input.current });
}
