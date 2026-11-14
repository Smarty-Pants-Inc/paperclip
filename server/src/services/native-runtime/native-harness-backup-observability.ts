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

export function reportNativeHarnessBackupCapture(input: {
  scopeDigest: string;
  runId: string;
  nativeSessionId: string | null;
} & (
  | { outcome: "skipped"; reason: "remote_filesystem_unavailable" | "checkpoint_incomplete"; incompleteReason?: string | null }
  | { outcome: "failed"; reason: "capture_failed"; detail: string }
)) {
  if (input.outcome === "skipped") counters.harnessBackupCaptureSkipped++;
  else counters.harnessBackupCaptureFailed++;
  logger.warn(input, input.outcome === "skipped"
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
  logger.warn({ ...input, reason: "stale_pending_backup",
    operatorAction: input.hasCurrent ? "inspect_pending_backup" : "no_current_backup_operator_recovery_required",
  }, "Native harness backup pending capture is stale; left in place for operator inspection");
}
