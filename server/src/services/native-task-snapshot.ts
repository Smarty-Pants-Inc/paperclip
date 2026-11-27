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
  /** Server-only keyed revisions survive redaction collisions; never disclosed. */
  fieldRevisions?: Record<NativeTaskField, string>;
};
function taskRevisionHasher() {
  // Reuse the vault's HKDF seam, with a fixed, separate purpose. The derived
  // key stays in this server closure, never a context, tool, env or log. Reload
  // on each operation so rotation conservatively reports changed fields once.
  const key = Buffer.from(deriveLocalEncryptedInstanceSecret("native-task-field-revisions:v1"), "base64url");
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical) :
    entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : entry;
  return (value: unknown) => "hmac-sha256:v1:" + createHmac("sha256", key)
    .update(JSON.stringify(canonical(value)) ?? "undefined").digest("hex");
}
export function nativeTaskFieldRevision(value: unknown): string { return taskRevisionHasher()(value); }
export function withNativeTaskRevisions(value: unknown): NativeTaskSnapshot | null {
  const snapshot = readNativeTaskSnapshot(value);
  if (!snapshot) return null;
  const revision = taskRevisionHasher();
  return { ...snapshot, fieldRevisions: Object.fromEntries(nativeTaskSnapshotFields.map(key => [key, revision(snapshot[key])])) as Record<NativeTaskField, string> };
}
export function readNativeTaskSnapshot(value: unknown): NativeTaskSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!["title", "workMode", "status", "priority"].every(key => typeof row[key] === "string") ||
    !taskStringFields.every(key => Object.hasOwn(row, key) && (row[key] === null || typeof row[key] === "string")) ||
    typeof row.titleNeedsGeneration !== "boolean" || !Object.hasOwn(row, "executionPolicy") ||
    (row.executionPolicy !== null && (typeof row.executionPolicy !== "object" || Array.isArray(row.executionPolicy)))) return null;
  const revisions = row.fieldRevisions;
  if (revisions !== undefined && (!revisions || typeof revisions !== "object" || Array.isArray(revisions) ||
    !nativeTaskSnapshotFields.every(key => typeof (revisions as Record<string, unknown>)[key] === "string" && /^hmac-sha256:v1:[a-f0-9]{64}$/.test((revisions as Record<string, string>)[key]!)))) return null;
  return { ...Object.fromEntries(nativeTaskSnapshotFields.map(key => [key, row[key]])),
    ...(revisions ? { fieldRevisions: revisions } : {}) } as NativeTaskSnapshot;
}
/** Redact every display subtree normally, then restore ONLY the known server
 * snapshot's root comparison map. Never grant arbitrary nested/user policy
 * objects a privileged redactor bypass just because a key has this name.
 */
export function restoreServerTaskRevisions(raw: NativeTaskSnapshot | null, display: NativeTaskSnapshot | null): NativeTaskSnapshot | null {
  return raw?.fieldRevisions && display ? { ...display, fieldRevisions: { ...raw.fieldRevisions } } : display;
}
export const NATIVE_TASK_SNAPSHOT_BASIS = "turn_start_plus_own_changes_v3";
/** Legacy commit-row receipts can contain unseen person edits. Never suppress on them. */
export function readNativeEndTaskSnapshot(value: unknown, issueId: string): NativeTaskSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const snapshot = row.issueId === issueId && row.basis === NATIVE_TASK_SNAPSHOT_BASIS ? readNativeTaskSnapshot(row.taskSnapshot) : null;
  return snapshot?.fieldRevisions ? snapshot : null;
}
export function nativeTaskChanges(current: unknown, previous: unknown) {
  const row = readNativeTaskSnapshot(current), before = readNativeTaskSnapshot(previous);
  if (!row || !before) return null;
  return Object.fromEntries(nativeTaskSnapshotFields
    .filter(key => row.fieldRevisions && before.fieldRevisions
      ? row.fieldRevisions[key] !== before.fieldRevisions[key] : !isDeepStrictEqual(row[key], before[key]))
    .map(key => [key, { old: before[key], new: row[key] }]));
}
