import { logger } from "../../middleware/logger.js";

/** S048: a message parked behind a handed-off warm Stop's cleanup
 * (hasPendingRunCleanup, "Waiting for the previous run to finish cleanup") is
 * woken by the event that ends that cleanup (the Stop's workspace export
 * finalized, the warm lease released retained/success), not by the 30 s
 * re-poll. The heartbeat service registers its ordinary resume path
 * (resumeRemoteStopComments through heartbeat.ts resumeSettledRun), which
 * re-proves the Stop and re-applies every admission gate.
 *
 * Callers wake only AFTER their write committed, never inside a transaction.
 * R-ONCE: one wake per (run, event); a repeat of the same event is a no-op,
 * and an admission that already ran is idempotent in the resume path itself. */
export type CleanupSettledEvent = "export_finalized" | "lease_released";
type CleanupSettledResumer = (input: { companyId: string; runId: string }) => Promise<void>;

let resumer: CleanupSettledResumer | null = null;
const woken = new Map<string, number>();
const WOKEN_KEEP_MS = 10 * 60_000;

export function registerCleanupSettledResumer(next: CleanupSettledResumer): () => void {
  resumer = next;
  return () => { if (resumer === next) resumer = null; };
}

export async function wakeAfterCleanupSettled(input: { companyId: string; runId: string; event: CleanupSettledEvent }): Promise<boolean> {
  const now = Date.now();
  for (const [key, at] of woken) if (now - at > WOKEN_KEEP_MS) woken.delete(key);
  const key = `${input.companyId}:${input.runId}:${input.event}`;
  if (!resumer || woken.has(key)) return false;
  woken.set(key, now);
  try {
    await resumer({ companyId: input.companyId, runId: input.runId });
  } catch (error) {
    logger.warn({ err: error, runId: input.runId, event: input.event }, "could not wake a message parked behind Stop cleanup");
  }
  return true;
}

/** Test seam: forget the R-ONCE keys. */
export function resetCleanupSettledWakesForTest() { woken.clear(); }
