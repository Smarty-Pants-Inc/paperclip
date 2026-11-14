import { logger } from "../../middleware/logger.js";

// Process-lifetime observation totals, exposed with nativeRecovery in protected
// health responses. Repeated sightings of the same pending tree count again;
// these are not a durable inventory or a count of unique lost transcripts.
const counters = {
  harnessBackupCaptureSkipped: 0,
  harnessBackupCaptureFailed: 0,
  harnessBackupStalePendingObserved: 0,
};

export function nativeHarnessBackupCounters(): Readonly<typeof counters> {
  return { ...counters };
}

// Never use exception messages, stacks, stderr, or caller-provided error names
// in unconditional server logs. Classification is a closed projection, not a
// best-effort scrub of arbitrary provider/storage/transcript content.
export function nativeHarnessBackupErrorFields(error: unknown): {
  errorCode: "permission_denied" | "not_found" | "io_error" | "timeout" | "unknown";
  errorClass?: string;
} {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "EACCES": case "EPERM": return { errorCode: "permission_denied" };
    case "ENOENT": return { errorCode: "not_found" };
    case "EIO": return { errorCode: "io_error" };
    case "ETIMEDOUT": return { errorCode: "timeout" };
    default: {
      // Error.name is caller-controlled; only the constructor identifies a class.
      const name: unknown = error instanceof Error ? Object.getPrototypeOf(error)?.constructor?.name : undefined;
      return { errorCode: "unknown", ...(typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)
        ? { errorClass: name } : {}) };
    }
  }
}

export function reportNativeHarnessBackupCapture(input: {
  scopeDigest: string;
  runId: string;
  nativeSessionId: string | null;
} & (
  | { outcome: "skipped"; reason: "remote_filesystem_unavailable" | "checkpoint_incomplete"; incompleteReason?: string | null }
  | { outcome: "failed"; reason: "capture_failed"; error: unknown }
)) {
  if (input.outcome === "skipped") counters.harnessBackupCaptureSkipped++;
  else counters.harnessBackupCaptureFailed++;
  const fields = input.outcome === "failed" ? nativeHarnessBackupErrorFields(input.error)
    : input.reason === "checkpoint_incomplete" ? {
      incompleteReason: input.incompleteReason === "unavailable" || input.incompleteReason === "not_suspended"
        || input.incompleteReason === "provider_unopened" ? input.incompleteReason : "unknown",
    } : {};
  logger.warn({ scopeDigest: input.scopeDigest, runId: input.runId, nativeSessionId: input.nativeSessionId,
    outcome: input.outcome, reason: input.reason, ...fields }, input.outcome === "skipped"
    ? "Native harness backup capture skipped"
    : "Native harness backup capture failed");
}

export function reportNativeHarnessBackupStalePending(input: {
  scopeDigest: string;
  pendingRoot: string;
  ageMs: number;
  hasCurrent: boolean;
}) {
  counters.harnessBackupStalePendingObserved++;
  logger.warn({ scopeDigest: input.scopeDigest, pendingRoot: input.pendingRoot, ageMs: input.ageMs,
    hasCurrent: input.hasCurrent, reason: "stale_pending_backup",
    operatorAction: input.hasCurrent ? "inspect_pending_backup" : "no_current_backup_operator_recovery_required",
  }, "Native harness backup pending capture is stale; left in place for operator inspection");
}
