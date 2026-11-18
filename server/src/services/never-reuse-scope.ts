/** B1 fence (a): which not-succeeded endings of P's run make P's box NEVER
 * resumable by another run (no long-stop window). The ONE switch (org,
 * 2026-11-18 23:18Z: "make the scope ONE constant and row BOTH settings");
 * the judges' line picks the value. stoppedReceiptFencesOtherRunResume
 * (remote-execution-termination.ts) is its only reader.
 * - "person_stop" (A, the default until the judges' line): never only for a
 *   P a person stopped (cancelled + cancelledByActorType user/board);
 *   failed, timed_out, interrupted and an unattributed cancel keep the
 *   PREDECESSOR_LONG_STOP_MS window.
 * - "not_succeeded" (B, rf-4's P3): never for EVERY not-succeeded ending.
 * It lives in its own module so the fence rows run every row under both
 * settings (b1-stopped-receipt-resume-fence.test.ts). */
export type NeverReuseScope = "person_stop" | "not_succeeded";

export const NEVER_REUSE_SCOPE: NeverReuseScope = "person_stop";
