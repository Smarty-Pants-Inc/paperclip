import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const directory = (path: string) => { const stat = lstatSync(path, { throwIfNoEntry: false }); return stat?.isDirectory() && !stat.isSymbolicLink(); };
const read = (path: string): string => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("checkpoint_stall_evidence_unsafe");
  return readFileSync(path, "utf8");
};

/** Read-only evidence, not an owner or execution grant. Only the core can
 * classify a checkpoint-only stall; the transport separately proves lineage
 * containment. The server must still check its DB owner and process fences. */
export function readCheckpointStallEvidence(root: string, expected?: Record<string, unknown>, requireContainment = true) {
  const diagnostics = resolve(root, "diagnostics");
  if (!directory(root) || !directory(diagnostics)) return null;
  for (const name of readdirSync(diagnostics).filter(name => /^checkpoint-stall-\d+-[0-9a-f-]{36}$/.test(name)).sort().reverse()) {
    try {
      const evidence = resolve(diagnostics, name);
      if (!directory(evidence) || !directory(resolve(evidence, "committed")) || !directory(resolve(evidence, "committed", "control-plane"))) continue;
      const receipt = record(JSON.parse(read(resolve(evidence, "receipt.json"))));
      let contained: Record<string, unknown> = {};
      try { contained = record(JSON.parse(read(resolve(evidence, "contained.json")))); }
      catch { if (requireContainment) continue; }
      const identity = record(receipt.identity);
      const bytes = read(resolve(evidence, "committed", "control-plane", "control-plane-state.json"));
      const committed = record(JSON.parse(bytes));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (receipt.schema !== "paperclip.checkpoint-only-stall.v1" || requireContainment && contained.schema !== "paperclip.checkpoint-only-stall-contained.v1"
        || receipt.reason !== "runner_event_commit_stalled" || !String(receipt.detail).startsWith("checkpoint_flush_failed:")
        || receipt.committedSha256 !== sha256 || receipt.ackedSourceSeq !== committed.ackedSourceSeq
        || requireContainment && (!Number.isSafeInteger(contained.runnerPid) || Number(contained.runnerPid) <= 0)
        || ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId", "turnId", "itemId"].some(key =>
          typeof identity[key] !== "string" || !identity[key] || requireContainment && record(contained.identity)[key] !== identity[key]
          || record(committed.identity)[key] !== identity[key] || expected && expected[key] !== identity[key])) continue;
      return { name, identity, sha256, bytes, runnerPid: requireContainment ? Number(contained.runnerPid) : 0 };
    } catch { /* Incomplete evidence is held, never discarded or promoted. */ }
  }
  return null;
}
