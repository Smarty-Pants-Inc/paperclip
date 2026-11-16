import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { canonicalNativeJson as canonicalJson } from "./canonical.js";

/**
 * Minimal record store for a provider identity that changed by a recorded
 * replacement (#20853 PART 2's contract). MERGE NOTE: fresh-thread-20853g owns
 * the real record store and isRecordedProviderIdentityChain; this writer keeps
 * the SAME record shape so that store can replace it without a data change.
 *
 * One record is written only when the provider session actually changed. Its
 * identity objects are exactly those the harness backup gate compares
 * (native-session-executor.ts providerSessionIdentityFromDurableProviderState,
 * compared at the next backup by canonical JSON).
 */
export const NATIVE_PROVIDER_IDENTITY_RECORD_SCHEMA = "paperclip.native-provider-identity-record.v1";
const RECORDS_FILE = "provider-identity-records.json";

export type NativeProviderIdentityChangeReason = "resume_failed_on_new_box" | "runner_state_lost";

export interface NativeProviderIdentityRecord {
  schema: typeof NATIVE_PROVIDER_IDENTITY_RECORD_SCHEMA;
  generation: number;
  companyId: string;
  taskId: string;
  normalizedSessionId: string;
  runId: string;
  previousIdentity: Record<string, unknown>;
  identity: Record<string, unknown>;
  reason: NativeProviderIdentityChangeReason;
  recordedAt: string;
}

/** The ONE person-visible line written with each record (run transcript). */
export const NATIVE_PROVIDER_IDENTITY_PERSON_LINE_PREFIX = "[paperclip] ";
export function nativeProviderIdentityPersonLine(reason: NativeProviderIdentityChangeReason): string {
  return `${NATIVE_PROVIDER_IDENTITY_PERSON_LINE_PREFIX}${reason === "resume_failed_on_new_box"
    ? "This task moved to a new computer that did not have the earlier conversation, so the agent continued in a new conversation with the task's saved history."
    : "The agent's earlier conversation could not be restored, so the agent continued in a new conversation with the task's saved history."}\n`;
}

function recordsPath(root: string): string {
  return resolve(root, RECORDS_FILE);
}

function isRecord(value: unknown): value is NativeProviderIdentityRecord {
  const item = value as Partial<NativeProviderIdentityRecord> | null;
  return !!item && typeof item === "object" && item.schema === NATIVE_PROVIDER_IDENTITY_RECORD_SCHEMA
    && Number.isSafeInteger(item.generation) && typeof item.companyId === "string" && typeof item.taskId === "string"
    && typeof item.normalizedSessionId === "string" && typeof item.runId === "string"
    && !!item.previousIdentity && typeof item.previousIdentity === "object"
    && !!item.identity && typeof item.identity === "object"
    && (item.reason === "resume_failed_on_new_box" || item.reason === "runner_state_lost")
    && typeof item.recordedAt === "string";
}

/** Every valid record under this controller state root, oldest first. A
 * missing or unreadable store has no records (it can never widen a gate). */
export function readNativeProviderIdentityRecords(root: string): NativeProviderIdentityRecord[] {
  const path = recordsPath(root);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

/** Append one record when the provider identity actually changed; returns it,
 * or null when previous and current are the same identity. */
export function recordNativeProviderIdentityChange(root: string, input: {
  companyId: string; taskId: string; normalizedSessionId: string; runId: string;
  previousIdentity: Record<string, unknown>; identity: Record<string, unknown>;
  reason: NativeProviderIdentityChangeReason; now?: Date;
}): NativeProviderIdentityRecord | null {
  if (canonicalJson(input.previousIdentity) === canonicalJson(input.identity)) return null;
  const records = readNativeProviderIdentityRecords(root);
  const scoped = records.filter(item => item.companyId === input.companyId && item.taskId === input.taskId
    && item.normalizedSessionId === input.normalizedSessionId);
  const next: NativeProviderIdentityRecord = {
    schema: NATIVE_PROVIDER_IDENTITY_RECORD_SCHEMA,
    generation: scoped.reduce((highest, item) => Math.max(highest, item.generation), 0) + 1,
    companyId: input.companyId, taskId: input.taskId, normalizedSessionId: input.normalizedSessionId, runId: input.runId,
    previousIdentity: structuredClone(input.previousIdentity), identity: structuredClone(input.identity),
    reason: input.reason, recordedAt: (input.now ?? new Date()).toISOString(),
  };
  const path = recordsPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify([...records, next], null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return next;
}

/** True only when recorded replacements of this exact task conversation lead,
 * in generation order, from `previous` to `current` (canonical JSON equality). */
export function isRecordedProviderIdentityChain(records: readonly NativeProviderIdentityRecord[], input: {
  companyId: string; taskId: string; normalizedSessionId: string;
  previous: unknown; current: unknown;
}): boolean {
  const scoped = records.filter(item => item.companyId === input.companyId && item.taskId === input.taskId
    && item.normalizedSessionId === input.normalizedSessionId).sort((a, b) => a.generation - b.generation);
  let cursor = canonicalJson(input.previous);
  const target = canonicalJson(input.current);
  if (cursor === target) return false;
  for (const item of scoped) {
    if (canonicalJson(item.previousIdentity) !== cursor) continue;
    cursor = canonicalJson(item.identity);
    if (cursor === target) return true;
  }
  return false;
}
