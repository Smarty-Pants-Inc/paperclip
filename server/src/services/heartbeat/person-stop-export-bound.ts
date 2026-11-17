import { readLeaseReleaseDeferral } from "../environment-lease-release-deferral.js";

/**
 * adopt-stopu-compose4 (RFL 22:25Z, rf-4 22:53Z): the release-site guard keeps
 * a person-stopped box whose export is unproven and holds the next message, but
 * only up to this bound, measured from the first unproven release
 * (releaseDeferral.failingSince, i.e. the Stop's teardown + at most the 30 s
 * export bound). The deferral retries are capped so one lands AT the bound
 * (run-control deferEnvironmentLeaseRelease retryAtCap); that retry decides.
 * Stop -> message running <= 30 s + 5 min + one probe (5 s) + one export (30 s)
 * = 6.1 min, under rf-4's 10 min.
 */
export const PERSON_STOP_EXPORT_BOUND_MS = 5 * 60_000;
export const PERSON_STOP_PROBE_TIMEOUT_MS = 5_000;
export const PERSON_STOP_EXPORT_UNPROVEN = "person_stop_export_unproven";
export const PERSON_STOP_BOUND_KEY = "personStopExportBound";
// adopt-stopu-cap5 (al/fam-stopu-cap 579574d1) folded in: its exhaustion line, verbatim, is this path's ONE line.
export const PERSON_STOP_WITHOUT_FILES_LINE = "Couldn't restore the files from the stopped turn; they're kept on the previous machine. This reply runs without them.";

export type PersonStopBoundDecision = {
  schema: "paperclip.person-stop-export-bound.v1";
  decision: "same_box" | "without_files";
  /** By line: box_unreachable_target (resolveEnvironmentExecutionTarget/resume failed),
   * box_unreachable_probe (a no-op command on the box failed or timed out),
   * tools_not_proven_stopped (no NSE clean-close proof), box_reachable_tools_stopped. */
  reason: string;
  runId: string;
  providerLeaseId: string;
  decidedAt: string;
};

export function readPersonStopBoundDecision(metadata: Record<string, unknown> | null | undefined): PersonStopBoundDecision | null {
  const value = metadata?.[PERSON_STOP_BOUND_KEY] as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object" || value.schema !== "paperclip.person-stop-export-bound.v1") return null;
  if (value.decision !== "same_box" && value.decision !== "without_files") return null;
  return value as unknown as PersonStopBoundDecision;
}

/** The kept person-Stop box its own successor may resume (rf-4 22:53Z FIRST
 * choice): the lease carries the same_box decision for this provider box. */
export function personStopKeptBoxForSuccessor(lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> | null }) {
  const decision = readPersonStopBoundDecision(lease.metadata);
  return decision?.decision === "same_box" && decision.providerLeaseId === lease.providerLeaseId ? decision : null;
}

/** When the hold ends: failingSince of the person-Stop deferral + the bound. */
export function personStopExportBoundAt(metadata: Record<string, unknown> | null | undefined): number | null {
  const deferral = readLeaseReleaseDeferral(metadata);
  if (deferral?.reason !== PERSON_STOP_EXPORT_UNPROVEN) return null;
  const since = Date.parse(deferral.failingSince);
  return Number.isFinite(since) ? since + PERSON_STOP_EXPORT_BOUND_MS : null;
}

