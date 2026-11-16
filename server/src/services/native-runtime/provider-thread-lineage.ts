import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/**
 * Provider-thread replacement records (smarty-dev#20853 PART 2).
 *
 * Conversation C (the normalized session id, `__paperclipPiConversation`) is
 * deliberately stable across runtime generations. The provider thread under it
 * is not: a failed resume on a new box, or a retired warm owner, can open a new
 * provider thread. Each such replacement is recorded here, keyed on the
 * provider identity ACTUALLY changing (never on configFreshness.reset, which
 * can say reset while the native layer restores the same thread).
 *
 * Identities are the exact objects the backup manifest stores, i.e. the output
 * of providerSessionIdentityFromDurableProviderState (for pi_rpc:
 * { providerSessionId: state.threadId, providerBackendSessionId:
 * state.providerSessionId, providerSessionIdentity: null }). They are compared
 * by canonical JSON and are never re-derived here.
 *
 * Storage: heartbeat_runs.runner_profile_json.providerThreadReplacements on
 * the run that opened the replacement thread (append-only, one entry per
 * distinct new identity). The run row's company/native issue/native session
 * scope the record, and records are immutable once written.
 */
export const PROVIDER_THREAD_REPLACEMENT_SCHEMA = "paperclip.provider-thread-replacement.v1" as const;
export const PROVIDER_THREAD_REPLACEMENTS_KEY = "providerThreadReplacements" as const;

export type ProviderThreadReplacementReason =
  /** The previous thread could not be resumed and the run is on a newly created box. */
  | "resume_failed_on_new_box"
  /** A new thread was opened on the same box (e.g. a retired warm owner). */
  | "provider_thread_replaced";

export interface ProviderThreadReplacementRecord {
  schema: typeof PROVIDER_THREAD_REPLACEMENT_SCHEMA;
  normalizedSessionId: string;
  companyId: string;
  taskId: string;
  runId: string;
  /** Provider-thread generation under this normalized session: the first thread is 1. */
  generation: number;
  previousIdentity: Record<string, unknown>;
  identity: Record<string, unknown>;
  reason: ProviderThreadReplacementReason;
  recordedAt: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Canonical JSON (sorted keys), the same comparison the backup-manifest check uses. */
export function canonicalProviderIdentity(identity: unknown): string {
  return JSON.stringify(canonical(identity ?? null));
}

function identityPresent(identity: unknown): identity is Record<string, unknown> {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  return Object.values(identity).some(value => value !== null && value !== undefined && value !== "");
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function readProviderThreadReplacementRecord(value: unknown): ProviderThreadReplacementRecord | null {
  const entry = value as Partial<ProviderThreadReplacementRecord> | null;
  if (!entry || typeof entry !== "object" || entry.schema !== PROVIDER_THREAD_REPLACEMENT_SCHEMA
    || !nonEmpty(entry.normalizedSessionId) || !nonEmpty(entry.companyId) || !nonEmpty(entry.taskId) || !nonEmpty(entry.runId)
    || !Number.isSafeInteger(entry.generation) || (entry.generation as number) < 2
    || !identityPresent(entry.previousIdentity) || !identityPresent(entry.identity)
    || !nonEmpty(entry.reason) || !nonEmpty(entry.recordedAt)) return null;
  return entry as ProviderThreadReplacementRecord;
}

/**
 * Decide whether a newly captured provider identity is a replacement. Returns
 * null when there is no previous identity (the first thread) or when the
 * identity is unchanged (a restore of the same thread, whatever the
 * config-freshness flag said).
 */
export function planProviderThreadReplacement(input: {
  normalizedSessionId: string;
  companyId: string;
  taskId: string;
  runId: string;
  previousIdentity: unknown;
  identity: unknown;
  reason: ProviderThreadReplacementReason;
  priorRecords: readonly ProviderThreadReplacementRecord[];
  now?: Date;
}): ProviderThreadReplacementRecord | null {
  if (!identityPresent(input.previousIdentity) || !identityPresent(input.identity)) return null;
  if (canonicalProviderIdentity(input.previousIdentity) === canonicalProviderIdentity(input.identity)) return null;
  const generation = input.priorRecords
    .filter(record => record.normalizedSessionId === input.normalizedSessionId
      && record.companyId === input.companyId && record.taskId === input.taskId)
    .reduce((highest, record) => Math.max(highest, record.generation), 1) + 1;
  return {
    schema: PROVIDER_THREAD_REPLACEMENT_SCHEMA,
    normalizedSessionId: input.normalizedSessionId,
    companyId: input.companyId,
    taskId: input.taskId,
    runId: input.runId,
    generation,
    previousIdentity: structuredClone(input.previousIdentity),
    identity: structuredClone(input.identity),
    reason: input.reason,
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * True only when recorded replacements form an unbroken chain from the
 * manifest identity to the current identity, every step inside the same
 * normalized session, company and task. Identical identities are a zero-step
 * chain. A gap, a foreign record or an unrecorded change returns false.
 */
export function providerThreadChainLinks(input: {
  records: readonly unknown[];
  manifestIdentity: unknown;
  currentIdentity: unknown;
  normalizedSessionId: string;
  companyId?: string;
  taskId?: string;
}): boolean {
  if (!identityPresent(input.manifestIdentity) || !identityPresent(input.currentIdentity)) return false;
  const target = canonicalProviderIdentity(input.currentIdentity);
  let current = canonicalProviderIdentity(input.manifestIdentity);
  if (current === target) return true;
  const records = input.records.map(readProviderThreadReplacementRecord)
    .filter((record): record is ProviderThreadReplacementRecord => record !== null
      && record.normalizedSessionId === input.normalizedSessionId
      && (input.companyId === undefined || record.companyId === input.companyId)
      && (input.taskId === undefined || record.taskId === input.taskId))
    .sort((left, right) => left.generation - right.generation || left.recordedAt.localeCompare(right.recordedAt));
  let scope: { companyId: string; taskId: string } | null = null;
  const visited = new Set<string>([current]);
  for (;;) {
    const step = records.find(record => canonicalProviderIdentity(record.previousIdentity) === current
      && (!scope || (record.companyId === scope.companyId && record.taskId === scope.taskId)));
    if (!step) return false;
    scope ??= { companyId: step.companyId, taskId: step.taskId };
    current = canonicalProviderIdentity(step.identity);
    if (current === target) return true;
    if (visited.has(current)) return false;
    visited.add(current);
  }
}

const REASON_TEXT: Record<ProviderThreadReplacementReason, string> = {
  resume_failed_on_new_box: "its earlier session could not be resumed on a new machine",
  provider_thread_replaced: "its earlier session could not be continued",
};

/** The one person-visible run-log line for a recorded replacement. */
export function providerThreadRestartLine(record: Pick<ProviderThreadReplacementRecord, "reason">,
  options: { carriedHistory: boolean }): string {
  return `[paperclip] The agent restarted its session because ${REASON_TEXT[record.reason]}. `
    + (options.carriedHistory
      ? "This chat's earlier messages were given to the new session as history.\n"
      : "The new session does not have this chat's earlier context.\n");
}

const replacementScope = (input: { companyId: string; taskId: string; normalizedSessionId: string }) => and(
  eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.nativeIssueId, input.taskId),
  eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
  sql`${heartbeatRuns.runnerProfileJson} ? ${PROVIDER_THREAD_REPLACEMENTS_KEY}`);

/** All replacement records of one normalized session, in generation order. */
export async function loadProviderThreadReplacements(db: Pick<Db, "select">, input: {
  companyId: string; taskId: string; normalizedSessionId: string;
}): Promise<ProviderThreadReplacementRecord[]> {
  const rows = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(replacementScope(input));
  return rows.flatMap(row => {
    const entries = (row.profile as Record<string, unknown> | null)?.[PROVIDER_THREAD_REPLACEMENTS_KEY];
    return Array.isArray(entries) ? entries.map(readProviderThreadReplacementRecord) : [];
  }).filter((record): record is ProviderThreadReplacementRecord => record !== null
    && record.companyId === input.companyId && record.taskId === input.taskId
    && record.normalizedSessionId === input.normalizedSessionId)
    .sort((left, right) => left.generation - right.generation || left.recordedAt.localeCompare(right.recordedAt));
}

/**
 * Record a replacement on the run that opened the new thread. Returns the
 * record when one was written, null when the identity did not change or the
 * same replacement is already recorded (a retried checkpoint).
 */
export async function recordProviderThreadReplacement(db: Db, input: {
  companyId: string; taskId: string; runId: string; normalizedSessionId: string;
  previousIdentity: unknown; identity: unknown; reason: ProviderThreadReplacementReason; now?: Date;
}): Promise<ProviderThreadReplacementRecord | null> {
  return db.transaction(async tx => {
    const [run] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      nativeIssueId: heartbeatRuns.nativeIssueId, nativeSessionId: heartbeatRuns.nativeSessionId,
      profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).for("update");
    if (!run || run.nativeIssueId !== input.taskId || run.nativeSessionId !== input.normalizedSessionId) {
      throw new Error("provider_thread_replacement_binding_mismatch");
    }
    const priorRecords = await loadProviderThreadReplacements(tx, input);
    const existing = Array.isArray((run.profile as Record<string, unknown> | null)?.[PROVIDER_THREAD_REPLACEMENTS_KEY])
      ? ((run.profile as Record<string, unknown>)[PROVIDER_THREAD_REPLACEMENTS_KEY] as unknown[]) : [];
    if (existing.map(readProviderThreadReplacementRecord).some(record => record
      && canonicalProviderIdentity(record.identity) === canonicalProviderIdentity(input.identity))) return null;
    const record = planProviderThreadReplacement({ ...input, priorRecords });
    if (!record) return null;
    await tx.update(heartbeatRuns).set({
      runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || jsonb_build_object(
        ${PROVIDER_THREAD_REPLACEMENTS_KEY}::text, ${JSON.stringify([...existing, record])}::jsonb)`,
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    return record;
  });
}

/** dev-lead's identity check: does an unbroken recorded chain link the backup manifest to this identity? */
export async function providerThreadChainIsRecorded(db: Pick<Db, "select">, input: {
  companyId: string; taskId: string; normalizedSessionId: string; manifestIdentity: unknown; currentIdentity: unknown;
}): Promise<boolean> {
  const records = await loadProviderThreadReplacements(db, input);
  return providerThreadChainLinks({ ...input, records });
}

/**
 * The executor's single call at checkpoint capture: record the replacement
 * (if the identity really changed) and, only when a record was written, put
 * ONE plain line in the run log. A kept thread writes nothing.
 */
export async function recordAndAnnounceProviderThreadReplacement(input: Parameters<typeof recordProviderThreadReplacement>[1] & {
  db: Db;
  carriedHistory: boolean;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
}): Promise<ProviderThreadReplacementRecord | null> {
  const { db, carriedHistory, onLog, ...recordInput } = input;
  const record = await recordProviderThreadReplacement(db, recordInput);
  if (record) await onLog?.("stdout", providerThreadRestartLine(record, { carriedHistory }));
  return record;
}
