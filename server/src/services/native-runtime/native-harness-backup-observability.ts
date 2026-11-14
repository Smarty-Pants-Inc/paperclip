import { logger } from "../../middleware/logger.js";

// Process-lifetime capture outcome totals, exposed with nativeRecovery in
// protected health responses; these reset on server restart.
const counters = {
  harnessBackupCaptureSkipped: 0,
  harnessBackupCaptureFailed: 0,
};

export function nativeHarnessBackupCounters(): Readonly<typeof counters> {
  return { ...counters };
}

// Never use exception messages, stacks, stderr, or caller-provided error names
// in unconditional server logs. Classification is a closed projection, not a
// best-effort scrub of arbitrary provider/storage/transcript content.
export function nativeHarnessBackupErrorFields(error: unknown): {
  errorCode: "permission_denied" | "not_found" | "io_error" | "timeout" | "unknown";
} {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "EACCES": case "EPERM": return { errorCode: "permission_denied" };
    case "ENOENT": return { errorCode: "not_found" };
    case "EIO": return { errorCode: "io_error" };
    case "ETIMEDOUT": return { errorCode: "timeout" };
    default: return { errorCode: "unknown" };
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
