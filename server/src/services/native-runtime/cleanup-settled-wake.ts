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
 * R-ONCE: one resume call per settled (company, run). The two events
 * (export_finalized, lease_released) are two triggers of the same settle, so
 * the second, and any repeat, is a no-op. An optional `settled` check (the
 * heartbeat service passes !hasPendingRunCleanup) keeps an early trigger that
 * fires while cleanup is still pending from consuming the run's one wake: it
 * calls nothing and leaves the wake to the trigger that settles the run (or to
 * the 30 s re-poll). The admission itself is idempotent in the resume path. */
export type CleanupSettledEvent = "export_finalized" | "lease_released";
type CleanupSettledResumer = (input: { companyId: string; runId: string }) => Promise<void>;

type CleanupSettledCheck = (input: { companyId: string; runId: string }) => Promise<boolean>;

let resumer: { resume: CleanupSettledResumer; settled: CleanupSettledCheck | null } | null = null;
const woken = new Map<string, number>();
const WOKEN_KEEP_MS = 10 * 60_000;

export function registerCleanupSettledResumer(next: CleanupSettledResumer, options: { settled?: CleanupSettledCheck } = {}): () => void {
  const entry = { resume: next, settled: options.settled ?? null };
  resumer = entry;
  return () => { if (resumer === entry) resumer = null; };
}

export async function wakeAfterCleanupSettled(input: { companyId: string; runId: string; event: CleanupSettledEvent }): Promise<boolean> {
  const now = Date.now();
  for (const [key, at] of woken) if (now - at > WOKEN_KEEP_MS) woken.delete(key);
  // One settle per (company, run): both events share this key.
  const key = `${input.companyId}:${input.runId}`;
  const entry = resumer;
  if (!entry || woken.has(key)) return false;
  if (entry.settled) {
    let settled = false;
    try {
      settled = await entry.settled({ companyId: input.companyId, runId: input.runId });
    } catch (error) {
      logger.warn({ err: error, runId: input.runId, event: input.event }, "could not check whether Stop cleanup settled; leaving the wake to the re-poll");
    }
    // Not settled yet: consume nothing, so the trigger that settles it still wakes.
    if (!settled || woken.has(key)) return false;
  }
  woken.set(key, now);
  try {
    await entry.resume({ companyId: input.companyId, runId: input.runId });
  } catch (error) {
    logger.warn({ err: error, runId: input.runId, event: input.event }, "could not wake a message parked behind Stop cleanup");
  }
  return true;
}

/** Test seam: forget the R-ONCE keys. */
export function resetCleanupSettledWakesForTest() { woken.clear(); }
