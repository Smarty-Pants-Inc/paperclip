import { isDeepStrictEqual } from "node:util";
import { createHmac } from "node:crypto";
import { deriveLocalEncryptedInstanceSecret } from "../secrets/local-encrypted-provider.js";

// Only agent-visible fields, never checkout/run bookkeeping or timestamps.
const taskStringFields = ["identifier", "title", "description", "workMode", "status", "priority",
  "assigneeAgentId", "assigneeUserId", "parentId", "projectId", "goalId", "conversationAgentId",
  "reviewPolicy", "responsibleUserId", "billingCode"] as const;
export const nativeTaskSnapshotFields = [...taskStringFields, "titleNeedsGeneration", "executionPolicy"] as const;
export type NativeTaskField = typeof nativeTaskSnapshotFields[number];
export type NativeTaskSnapshot = Record<typeof taskStringFields[number], string | null> & {
  titleNeedsGeneration: boolean;
  executionPolicy: Record<string, unknown> | null;
  /** Reserved server-owned metadata, removed by path before any projection. */
  paperclipFieldRevisions?: Record<NativeTaskField, string>;
  paperclipRevisionKeyId?: string;
};
function taskRevisionHasher() {
  // Reuse the vault's HKDF seam. Reload per operation; an epoch mismatch means
  // one full prompt, not claims that every unchanged task field changed.
  const key = Buffer.from(deriveLocalEncryptedInstanceSecret("native-task-field-revisions:v1"), "base64url");
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical) :
    entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : entry;
  const revision = (value: unknown) => "hmac-sha256:v1:" + createHmac("sha256", key)
    .update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
  return { revision, keyId: revision("paperclip-native-task-revision-key-id:v1") };
}
export function nativeTaskFieldRevision(value: unknown): string { return taskRevisionHasher().revision(value); }
export function withNativeTaskRevisions(value: unknown): NativeTaskSnapshot | null {
  const snapshot = readNativeTaskSnapshot(value);
  if (!snapshot) return null;
  const { revision, keyId } = taskRevisionHasher();
  return { ...snapshot, paperclipRevisionKeyId: keyId,
    paperclipFieldRevisions: Object.fromEntries(nativeTaskSnapshotFields.map(key => [key, revision(snapshot[key])])) as Record<NativeTaskField, string> };
}
const isRevision = (value: unknown): value is string => typeof value === "string" && /^hmac-sha256:v1:[a-f0-9]{64}$/.test(value);
export function readNativeTaskSnapshot(value: unknown): NativeTaskSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!["title", "workMode", "status", "priority"].every(key => typeof row[key] === "string") ||
    !taskStringFields.every(key => Object.hasOwn(row, key) && (row[key] === null || typeof row[key] === "string")) ||
    typeof row.titleNeedsGeneration !== "boolean" || !Object.hasOwn(row, "executionPolicy") ||
    (row.executionPolicy !== null && (typeof row.executionPolicy !== "object" || Array.isArray(row.executionPolicy)))) return null;
  const revisions = row.paperclipFieldRevisions;
  if (revisions !== undefined && (!revisions || typeof revisions !== "object" || Array.isArray(revisions) ||
    !isRevision(row.paperclipRevisionKeyId) ||
    !nativeTaskSnapshotFields.every(key => isRevision((revisions as Record<string, unknown>)[key])))) return null;
  return { ...Object.fromEntries(nativeTaskSnapshotFields.map(key => [key, row[key]])),
    ...(revisions ? { paperclipFieldRevisions: revisions, paperclipRevisionKeyId: row.paperclipRevisionKeyId } : {}) } as NativeTaskSnapshot;
}
/** Redact display values without passing opaque hashes through text redaction,
 * then restore ONLY this server snapshot's root metadata, never user subtrees.
 */
export function restoreServerTaskRevisions(raw: NativeTaskSnapshot | null, display: NativeTaskSnapshot | null): NativeTaskSnapshot | null {
  return raw?.paperclipFieldRevisions && display ? { ...display,
    paperclipFieldRevisions: { ...raw.paperclipFieldRevisions }, paperclipRevisionKeyId: raw.paperclipRevisionKeyId } : display;
}
export const NATIVE_TASK_SNAPSHOT_BASIS = "turn_start_plus_own_changes_v4";
/** Legacy or incomplete receipts take one full prompt without resetting a session. */
export function readNativeEndTaskSnapshot(value: unknown, issueId: string): NativeTaskSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const snapshot = row.issueId === issueId && row.basis === NATIVE_TASK_SNAPSHOT_BASIS ? readNativeTaskSnapshot(row.taskSnapshot) : null;
  return snapshot?.paperclipFieldRevisions ? snapshot : null;
}
export function nativeTaskChanges(current: unknown, previous: unknown) {
  const row = readNativeTaskSnapshot(current), before = readNativeTaskSnapshot(previous);
  if (!row || !before) return null;
  if ((row.paperclipFieldRevisions || before.paperclipFieldRevisions) &&
    (!row.paperclipFieldRevisions || !before.paperclipFieldRevisions || row.paperclipRevisionKeyId !== before.paperclipRevisionKeyId)) return null;
  return Object.fromEntries(nativeTaskSnapshotFields
    .filter(key => row.paperclipFieldRevisions && before.paperclipFieldRevisions
      ? row.paperclipFieldRevisions[key] !== before.paperclipFieldRevisions[key] : !isDeepStrictEqual(row[key], before[key]))
    .map(key => [key, { old: before[key], new: row[key] }]));
}
