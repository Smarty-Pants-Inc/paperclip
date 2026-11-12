import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Origin } from "../home/bind-types.js";
import { canonicalJson, isWithin, sha256 } from "../home/manifest.js";

export interface GuardRawArtifact {
  path: string;
  sha256: string;
  length: number;
  toolCallId: string;
  parentToolCallId?: string;
  origin: Origin;
  nativeEntryIds: string[];
  sourceCursor?: string;
  redactionPolicy: "native-tool-context-guard";
  exported: boolean;
}
export interface GuardRawInput {
  sessionRoot: string;
  toolCallId: string;
  parentToolCallId?: string;
  origin: Origin;
  details: unknown;
  entries: readonly unknown[];
  sourceCursor?: string;
  signal?: AbortSignal;
  /** Existing evidence-store adapter: persist bytes, then return independent stored-object readback. */
  retain?: (artifact: Readonly<GuardRawArtifact>, bytes: Uint8Array) => Promise<{ sha256: string; length: number }>;
}
export interface GuardRawManifest {
  completeness: boolean;
  artifacts: GuardRawArtifact[];
  failures: string[];
  recoveryRequired: boolean;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
const stamp = (s: Awaited<ReturnType<typeof lstat>>) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");
function invalid(code: string): never { throw Object.assign(new Error(code), { artifactCode: code }); }
async function readVerifiedSpill(rootInput: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!isAbsolute(rootInput) || !isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === ".")) invalid("spill_path_invalid");
  const root = await realpath(rootInput);
  if (root !== resolve(rootInput) || path !== resolve(path) || path === root || !isWithin(root, path)) invalid("spill_outside_session_root");
  const observations = new Map<string, string>();
  let current = root;
  for (const part of ["", ...relative(root, path).split(sep)]) {
    if (part) current = join(current, part);
    const s = await lstat(current);
    if (s.isSymbolicLink() || (current !== path && !s.isDirectory())) invalid("spill_symlink_forbidden");
    if (current === path && (!s.isFile() || s.nlink !== 1)) invalid("spill_not_private_regular_file");
    observations.set(current, stamp(s));
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (stamp(await file.stat()) !== observations.get(path) || await realpath(path) !== path) invalid("spill_changed_during_read");
    const bytes = await file.readFile({ signal });
    if (stamp(await file.stat()) !== observations.get(path)) invalid("spill_changed_during_read");
    for (const [observed, before] of observations) if (stamp(await lstat(observed)) !== before) invalid("spill_changed_during_read");
    return bytes;
  } finally { await file.close(); }
}
/**
 * Consume native guard details + custom entries; never scrape the preview or implement a cap.
 * A complete local manifest is not an exported/durable-store claim: exported stays false until
 * retain() readback succeeds. Failures are sanitized codes, with source files left untouched.
 */
export async function collectGuardRawArtifacts(input: GuardRawInput): Promise<GuardRawManifest> {
  const artifacts: GuardRawArtifact[] = [], failures: string[] = [];
  try {
    if (!Number.isSafeInteger(input.origin.epoch) || input.origin.epoch < 0 || !input.origin.runId || !input.origin.turnId || !input.toolCallId) invalid("origin_or_call_missing");
    const guard = record(record(input.details).toolContextGuard);
    if (guard.serializationFailed === true || guard.saveError) failures.push("guard_retention_failed");
    if (typeof guard.spillPath !== "string" || !guard.spillPath) invalid("spill_reference_missing");
    const bytes = await readVerifiedSpill(input.sessionRoot, guard.spillPath, input.signal);
    const stored = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (stored.toolCallId !== input.toolCallId || !Array.isArray(stored.content)) invalid("spill_call_or_content_mismatch");
    const normalized = canonicalJson(stored);
    const nativeEntryIds: string[] = [];
    for (const candidate of input.entries) {
      const entry = record(candidate);
      if (entry.type !== "custom" || entry.customType !== "tool-context-guard-full" || typeof entry.id !== "string" || record(entry.data).toolCallId !== input.toolCallId) continue;
      if (canonicalJson(entry.data) === normalized) nativeEntryIds.push(entry.id);
    }
    if (!nativeEntryIds.length) failures.push("native_full_entry_missing_or_mismatched");
    const artifact: GuardRawArtifact = { path: guard.spillPath, sha256: sha256(bytes), length: bytes.length, toolCallId: input.toolCallId, ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}), origin: Object.freeze({ ...input.origin }), nativeEntryIds, ...(input.sourceCursor ? { sourceCursor: input.sourceCursor } : {}), redactionPolicy: "native-tool-context-guard", exported: false };
    artifacts.push(artifact);
    input.signal?.throwIfAborted();
    if (input.retain) {
      try {
        const readback = await input.retain(Object.freeze({ ...artifact }), bytes);
        if (readback.sha256 !== artifact.sha256 || readback.length !== artifact.length) invalid("retention_readback_mismatch");
        artifact.exported = true;
      } catch { failures.push("retention_readback_failed"); }
    }
    input.signal?.throwIfAborted();
  } catch (error) {
    const code = record(error).artifactCode;
    failures.push(typeof code === "string" ? code : "spill_read_or_serialization_failed");
  }
  return { completeness: failures.length === 0, artifacts, failures, recoveryRequired: failures.length > 0 };
}
