import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db, type heartbeatRuns } from "@paperclipai/db";
import { admittedNativeResourceDisposition, nativeStopWorkspaceOutcome } from "./native-failed-workspace-recovery.js";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { hasStopOnlyCleanup, prepareSupersededWarmSandboxStop } from "../sandbox-stop-and-retain.js";
import { warmSandboxExpiryCandidateCondition } from "../warm-sandbox-expiry.js";
import { logger } from "../../middleware/logger.js";
import { readLeaseReleaseDeferral } from "../environment-lease-release-deferral.js";

/** Lease policies whose box a warm Stop can hand off (native-failed-workspace-recovery). */
const reusableNativeLeasePolicies = ["reuse_by_environment", "reuse_by_execution_workspace"];

/** Marker on the stop-and-retain intent: the handed-off box's proof was unavailable. */
export const HANDED_OFF_WARM_STOP_KEY = "handedOffWarmProofUnavailable";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "nativeIssueId" | "status" | "resultJson" | "runtimeMode" | "runnerProfileJson">;

/** A remote lease with no stop receipt that a person's Stop of a warm
 * (keep_running) turn handed off: native run, lease retained and unreleased
 * with a reusable policy, no stop in flight on it, the warm-stop helper says
 * handoff. */
export function handedOffWarmLease(run: Run, lease: typeof environmentLeases.$inferSelect): boolean {
  return !(run.runtimeMode !== "native" || lease.status !== "retained" || lease.releasedAt
    || !reusableNativeLeasePolicies.includes(lease.leasePolicy)
    || lease.metadata?.pendingCleanupInFlight === true || hasStopOnlyCleanup(lease)
    || nativeStopWorkspaceOutcome({ admittedDisposition: admittedNativeResourceDisposition(run.runnerProfileJson),
      stopped: run.status === "cancelled" && hasAcknowledgedNativeRunStopRequest(run), source: lease }) !== "handoff");
}

/** The marker that ties a handed-off lease to THIS run's handoff (adopt-h6-xred3):
 * - idle_receipt (H6's card proof): the run's nativeRetainedIdleCheckpoint names
 *   this run/company/issue/session and the settled coordinator's boot/generation;
 * - runner_exit (the Send gate): the lease's HANDED_OFF_WARM_EXIT_KEY stamp names
 *   this run. A lease shape alone never passes. */
export type WarmHandoffMarker =
  | { kind: "idle_receipt"; nativeSessionId: string | null; bootId: string | null; generation: number | null }
  | { kind: "runner_exit" };

function handoffMarkerNamesRun(run: Pick<Run, "id" | "companyId" | "nativeIssueId" | "runnerProfileJson">,
  lease: typeof environmentLeases.$inferSelect, marker: WarmHandoffMarker): boolean {
  if (marker.kind === "runner_exit") {
    const evidence = lease.metadata?.[HANDED_OFF_WARM_EXIT_KEY] as { runId?: unknown } | undefined;
    return evidence?.runId === run.id;
  }
  const value = run.runnerProfileJson?.nativeRetainedIdleCheckpoint;
  const receipt = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return receipt.schema === "paperclip.native-retained-idle-checkpoint.v1"
    && receipt.companyId === run.companyId && receipt.runId === run.id && receipt.issueId === run.nativeIssueId
    && typeof receipt.sessionId === "string" && receipt.sessionId === marker.nativeSessionId
    && marker.bootId !== null && receipt.bootId === marker.bootId
    && marker.generation !== null && receipt.generation === marker.generation;
}

/** adopt-h6-xred3: ONE "retained warm handoff" lease predicate, used by H6's
 * Stop-pending card proof (agent-execution-stop.ts provedWarmTurnHandoff) and
 * the Send gate (handedOffWarmLeaseSettled below). It accepts BOTH states of the
 * same handed-off lease: active and uncleaned before the release, and
 * retained/success after it (environment-runtime.ts releaseLease("retained",
 * { cleanupStatus: "success" }), releasedAt stays null), only when it is THIS
 * run's lease (company, run AND issue: lease.issueId must equal the run's
 * nativeIssueId; a lease with no issue, or a run with none, is refused, since the
 * only producer, the warm acquisition in environment-runtime.ts, writes the
 * run's task issue) and carries the caller's marker naming this run. It refuses a
 * released/terminated lease, a stop receipt, a stop in flight, stop-only
 * cleanup (stop_and_retain / export resume), a release deferral, a failed
 * cleanup and a non-reusable or local lease. */
export function retainedWarmHandoffLease(run: Pick<Run, "id" | "companyId" | "nativeIssueId" | "runnerProfileJson">,
  lease: typeof environmentLeases.$inferSelect, marker: WarmHandoffMarker): boolean {
  const state = (lease.status === "active" && !lease.cleanupStatus)
    || (lease.status === "retained" && lease.cleanupStatus === "success");
  return state && !lease.releasedAt && lease.companyId === run.companyId && lease.heartbeatRunId === run.id
    && run.nativeIssueId !== null && lease.issueId === run.nativeIssueId
    && !!lease.provider && lease.provider !== "local" && reusableNativeLeasePolicies.includes(lease.leasePolicy)
    && lease.metadata?.pendingCleanupInFlight !== true && !readLeaseReleaseDeferral(lease.metadata)
    && !hasStopOnlyCleanup(lease) && lease.metadata?.sandboxStopAndRetainReceipt == null
    && lease.metadata?.remoteExecutionTermination == null
    && handoffMarkerNamesRun(run, lease, marker);
}

/** pl/send-after-stop: ONE predicate for a remote lease with no stop receipt
 * that a person's Stop of a warm (keep_running) turn handed off. It is settled
 * only when the Stop policy says handoff and the lease is this run's retained
 * warm handoff (retainedWarmHandoffLease, either state) whose s3 fence proof
 * says the stopped run's Runner exited. Shared by the explicit Send gate
 * (explicit-native-continuation.ts) and the automatic remote-stop resume
 * (acknowledgedNativeStopExecutionHasStopped). */
export function handedOffWarmLeaseSettled(run: Run, lease: typeof environmentLeases.$inferSelect): boolean {
  // rf-4 row 22a: DB-only. The s3 fence's proof (handedOffWarmOwnerRunnerExited)
  // talks to the box's Runner, so it never runs here (callers hold a transaction
  // or a dryRun); proveHandedOffWarmLeases runs it outside any transaction and
  // persists its answer, which is the only thing read here. That proof still
  // runs only on a released (retained) lease (handedOffWarmLease), never during
  // cancel-finalize's export, so before the release the stamp is normally absent.
  return run.runtimeMode === "native" && nativeStopWorkspaceOutcome({
    admittedDisposition: admittedNativeResourceDisposition(run.runnerProfileJson),
    stopped: run.status === "cancelled" && hasAcknowledgedNativeRunStopRequest(run), source: lease }) === "handoff"
    && retainedWarmHandoffLease(run, lease, { kind: "runner_exit" });
}

/** rf-4 row 22: persisted evidence that the s3 fence proved the stopped run's Runner exited. */
export const HANDED_OFF_WARM_EXIT_KEY = "handedOffWarmOwnerRunnerExited";
/** rf-4 row 22f: bound on the remote proof (stop the idle Runner, wait for its exit). */
export const handedOffWarmProofTimeout = { ms: 20_000 };
const proofsInFlight = new Map<string, Promise<"none" | "proven" | "unproven" | "timed_out">>();
/** A proof for this run is running outside the transaction right now. */
export function handedOffWarmProofInFlight(runId: string): boolean { return proofsInFlight.has(runId); }

/** rf-4 row 22a/22f: run the s3 fence's runner-exit proof for every handed-off
 * warm lease of this run that has no persisted answer yet, OUTSIDE any
 * transaction (callers pass the root Db), bounded by handedOffWarmProofTimeout.
 * Proven -> the evidence key is written on the lease. Timed out, or the proof
 * itself failed (rf-4 row 22f: e.g. the Runner answered 502) -> sas3's
 * stop_and_retain intent (its provider receipt then admits the successor),
 * never for a busy owner (handedOffWarmOwnerBusy). The intent records which:
 * proofFailure "timed_out" or "proof_error". */
export function proveHandedOffWarmLeases(db: Db, run: Run): Promise<"none" | "proven" | "unproven" | "timed_out"> {
  const running = proofsInFlight.get(run.id);
  if (running) return running;
  const work = (async () => {
    const leases = (await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id)))).filter(lease => handedOffWarmLease(run, lease) && !handedOffWarmLeaseSettled(run, lease));
    if (!leases.length) return "none" as const;
    const { handedOffWarmOwnerRunnerExited, handedOffWarmOwnerBusy } = await import("./native-session-executor.js");
    let outcome: "proven" | "unproven" | "timed_out" = "proven";
    for (const lease of leases) {
      let timer: NodeJS.Timeout | undefined;
      const answer = await Promise.race([
        // rf-4 row 22f: a proof ERROR is not "not exited"; it takes the timeout's fallback below.
        handedOffWarmOwnerRunnerExited({ runId: run.id, providerLeaseId: lease.providerLeaseId })
          .catch((error: unknown) => ({ proofError: error })),
        new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), handedOffWarmProofTimeout.ms); }),
      ]).finally(() => clearTimeout(timer));
      if (answer === true) {
        await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
          [HANDED_OFF_WARM_EXIT_KEY]: { runId: run.id, provenAt: new Date().toISOString() } })}::jsonb`, updatedAt: new Date() })
          .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId)));
        continue;
      }
      if (answer === "timeout" || typeof answer === "object") {
        const proofFailure = answer === "timeout" ? "timed_out" as const : "proof_error" as const;
        // Never stop a busy owner: the warm entry's own idle check (busy or preparing).
        if (handedOffWarmOwnerBusy({ runId: run.id, providerLeaseId: lease.providerLeaseId })) {
          logger.warn({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId, proofFailure },
            "handed-off warm proof failed but the owner is busy; no stop-and-retain intent written (the messages stay held)");
          outcome = "unproven";
          break;
        }
        if (proofFailure === "proof_error") logger.warn({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId,
          proofError: String((answer as { proofError: unknown }).proofError) }, "handed-off warm proof failed; taking the bounded stop-and-retain fallback");
        const [candidate] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
          eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
          warmSandboxExpiryCandidateCondition())).limit(1);
        const requested = candidate && handedOffWarmLease(run, candidate)
          ? await prepareSupersededWarmSandboxStop(db, candidate, { [HANDED_OFF_WARM_STOP_KEY]: true, proofFailure,
            ...(proofFailure === "timed_out" ? { proofTimedOutMs: handedOffWarmProofTimeout.ms } : {}) })
          : null;
        // rf-4 row 21 (the kind): a refusal is never silent. No intent here means
        // the box is not a stop candidate (warmSandboxExpiryCandidateCondition:
        // e.g. another live lease holds the same provider box, or a stop is in flight).
        if (!requested) logger.warn({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId,
          candidate: Boolean(candidate), proofFailure, timeoutMs: handedOffWarmProofTimeout.ms },
          "handed-off warm proof failed; no stop-and-retain intent written (the box is not a stop candidate)");
        return "timed_out" as const;
      }
      outcome = "unproven";
      break;
    }
    return outcome;
  })().finally(() => proofsInFlight.delete(run.id));
  proofsInFlight.set(run.id, work);
  return work;
}

/** pl/send-after-stop3: the predicate above refused a handed-off warm lease
 * ONLY because the proof is unavailable here (no warm session for it in this
 * process, e.g. after a controller restart). Waiting cannot produce that proof,
 * only the warm-window expiry would stop the box; so stop and keep it NOW
 * through the same stop-only owner the expiry uses (upstream's Stop shape).
 * Its provider receipt then admits the successor, which resumes the same
 * stopped box. Never on a dry run, never for a busy owner or one whose proof
 * is obtainable, never for a non-retained lease or one another holder uses
 * (warmSandboxExpiryCandidateCondition), and at most once: the intent it
 * records makes the lease no longer a retained handoff. True when requested. */
export async function requestHandedOffWarmLeaseStop(db: Db, run: Run, lease: typeof environmentLeases.$inferSelect,
  options: { dryRun?: boolean } = {}): Promise<boolean> {
  if (options.dryRun || !handedOffWarmLease(run, lease)) return false;
  // rf-4 row 22b: a proof running right now (proveHandedOffWarmLeases, outside
  // any transaction) is the proof being obtained: it persists the evidence, or
  // on its bound writes this same stop-and-retain intent itself. Never race it.
  if (handedOffWarmProofInFlight(run.id)) return false;
  const { handedOffWarmOwnerProofUnavailable } = await import("./native-session-executor.js");
  if (!handedOffWarmOwnerProofUnavailable({ runId: run.id, providerLeaseId: lease.providerLeaseId })) return false;
  const [candidate] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    warmSandboxExpiryCandidateCondition())).limit(1);
  if (!candidate || !handedOffWarmLease(run, candidate)) return false;
  return Boolean(await prepareSupersededWarmSandboxStop(db, candidate, { [HANDED_OFF_WARM_STOP_KEY]: true }));
}
