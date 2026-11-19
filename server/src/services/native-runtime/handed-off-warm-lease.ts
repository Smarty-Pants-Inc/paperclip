import { assertNoOpenTransaction } from "@paperclipai/db/transaction-context";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db, type heartbeatRuns } from "@paperclipai/db";
import { admittedNativeResourceDisposition, nativeStopWorkspaceOutcome } from "./native-failed-workspace-recovery.js";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { hasStopOnlyCleanup, prepareSupersededWarmSandboxStop } from "../sandbox-stop-and-retain.js";
import { warmSandboxExpiryCandidateCondition } from "../warm-sandbox-expiry.js";
import { logger } from "../../middleware/logger.js";
import { readEnvironmentLeaseController } from "../environment-lease-controller.js";
import { currentControllerBootId } from "../controller-process-identity.js";

/** Lease policies whose box a warm Stop can hand off (native-failed-workspace-recovery). */
const reusableNativeLeasePolicies = ["reuse_by_environment", "reuse_by_execution_workspace"];

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "nativeIssueId" | "status" | "resultJson" | "runtimeMode" | "runnerProfileJson">;

/** A remote lease with no stop receipt that a person's Stop (or Interrupt) of a
 * warm (keep_running) turn handed off: native run, lease retained and unreleased
 * with a reusable policy, no stop in flight on it, the warm-stop helper says handoff. */
export function handedOffWarmLease(run: Run, lease: typeof environmentLeases.$inferSelect): boolean {
  return !(run.runtimeMode !== "native" || lease.status !== "retained" || lease.releasedAt
    || !reusableNativeLeasePolicies.includes(lease.leasePolicy)
    || lease.metadata?.pendingCleanupInFlight === true || hasStopOnlyCleanup(lease)
    || nativeStopWorkspaceOutcome({ admittedDisposition: admittedNativeResourceDisposition(run.runnerProfileJson),
      stopped: run.status === "cancelled" && hasAcknowledgedNativeRunStopRequest(run), source: lease }) !== "handoff");
}

/** pl/send-after-stop: ONE predicate for a handed-off warm lease. Settled only
 * when it is such a lease and the s3 fence's proof that the stopped run's Runner
 * exited is PERSISTED on it. rf-4 row 22a: DB-only. The proof talks to the box's
 * Runner over the network, so it never runs here (callers hold the Send's
 * enqueue/admission transaction, a dryRun or the Interrupt route's lock);
 * proveHandedOffWarmLeases runs it outside any transaction and persists its answer. */
export function handedOffWarmLeaseSettled(run: Run, lease: typeof environmentLeases.$inferSelect): boolean {
  if (!handedOffWarmLease(run, lease)) return false;
  const evidence = lease.metadata?.[HANDED_OFF_WARM_EXIT_KEY] as { runId?: unknown } | undefined;
  return evidence?.runId === run.id;
}

/** rf-4 row 22: persisted evidence that the s3 fence proved the stopped run's Runner exited. */
export const HANDED_OFF_WARM_EXIT_KEY = "handedOffWarmOwnerRunnerExited";
/** Marker of the stop_and_retain intent written when the bounded proof timed out. */
export const HANDED_OFF_WARM_STOP_KEY = "handedOffWarmProofTimedOut";
/** row 12 (pl/send-after-stop3 cdc665ef): marker of the stop_and_retain intent
 * written at once because the proof is UNAVAILABLE in this process (no warm
 * session for the stopped run: a server restart, or the entry already gone). */
export const HANDED_OFF_WARM_UNAVAILABLE_STOP_KEY = "handedOffWarmProofUnavailable";
/** rf-4 row 22f: bound on the remote proof (stop the idle Runner, wait for its exit). */
export const handedOffWarmProofTimeout = { ms: 20_000 };
type ProofOutcome = "none" | "proven" | "unproven" | "timed_out" | "stop_requested";
const proofsInFlight = new Map<string, Promise<ProofOutcome>>();
/** A proof for this run is running outside the transaction right now (process-local). */
export function handedOffWarmProofInFlight(runId: string): boolean { return proofsInFlight.has(runId); }

/** rf-4 row 22a/22f: run the s3 fence's runner-exit proof for every handed-off
 * warm lease of this run that has no persisted answer yet, OUTSIDE any
 * transaction (callers pass the root Db; the tx-guard throws otherwise),
 * bounded by handedOffWarmProofTimeout. Proven -> the evidence key is written on
 * the lease. Timed out -> a stop_and_retain intent (its provider receipt then
 * admits the successor through the receipt path). row 12: proof UNAVAILABLE here
 * (no warm session for the run in this process, e.g. after a server restart) ->
 * the same stop_and_retain intent AT ONCE, never a wait for warm expiry. */
export function proveHandedOffWarmLeases(db: Db, run: Run): Promise<ProofOutcome> {
  const running = proofsInFlight.get(run.id);
  if (running) return running;
  const work = (async (): Promise<ProofOutcome> => {
    const leases = (await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id)))).filter(lease => handedOffWarmLease(run, lease) && !handedOffWarmLeaseSettled(run, lease));
    if (!leases.length) return "none";
    assertNoOpenTransaction("runner:handedOffWarmOwnerRunnerExited");
    const { handedOffWarmOwnerRunnerExited, handedOffWarmOwnerProofUnavailable } = await import("./native-session-executor.js");
    let outcome: ProofOutcome = "proven";
    for (const [index, lease] of leases.entries()) {
      let timer: NodeJS.Timeout | undefined;
      const answer = await Promise.race([
        handedOffWarmOwnerRunnerExited({ runId: run.id, providerLeaseId: lease.providerLeaseId }).catch(() => false),
        new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), handedOffWarmProofTimeout.ms); }),
      ]).finally(() => clearTimeout(timer));
      if (answer === true) {
        await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
          [HANDED_OFF_WARM_EXIT_KEY]: { runId: run.id, provenAt: new Date().toISOString() } })}::jsonb`, updatedAt: new Date() })
          .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId)));
        continue;
      }
      if (answer === "timeout") {
        await requestHandedOffWarmLeaseStop(db, run, lease, { [HANDED_OFF_WARM_STOP_KEY]: true, proofTimedOutMs: handedOffWarmProofTimeout.ms }, "proof timed out");
        return "timed_out";
      }
      // row 12 (pl/send-after-stop3 cdc665ef): not proven, the box was handed
      // off under another server boot, and the proof is UNAVAILABLE in this
      // process (no warm session for the run: a server restart). Waiting cannot produce it; only warm expiry would stop the box.
      // Stop and keep it now through the stop-only owner, for this lease and
      // every later one in the same state. A Runner that did not prove exited
      // (its warm session is held here) still waits, as the s3 fence requires.
      if (handedOffByAnotherBoot(lease) && handedOffWarmOwnerProofUnavailable({ runId: run.id, providerLeaseId: lease.providerLeaseId })) {
        for (const unavailable of leases.slice(index))
          if (handedOffByAnotherBoot(unavailable) && handedOffWarmOwnerProofUnavailable({ runId: run.id, providerLeaseId: unavailable.providerLeaseId }))
            await requestHandedOffWarmLeaseStop(db, run, unavailable, { [HANDED_OFF_WARM_UNAVAILABLE_STOP_KEY]: true }, "proof unavailable");
        return "stop_requested";
      }
      outcome = "unproven";
      break;
    }
    return outcome;
  })().finally(() => proofsInFlight.delete(run.id));
  proofsInFlight.set(run.id, work);
  return work;
}

/** row 12: the lease's holder stamp (environment-lease-controller, written
 * when the lease went active) names ANOTHER server boot: this process never
 * held the stopped run's warm session, so its absence here is a restart, not a
 * session this process is still registering. The same boot discriminator as
 * the previous-boot closed-tip stop (environment-runtime (g2)). An unstamped
 * lease proves nothing either way and keeps the existing wait. */
function handedOffByAnotherBoot(lease: typeof environmentLeases.$inferSelect): boolean {
  const holder = readEnvironmentLeaseController(lease.metadata);
  return holder !== null && holder.bootId !== currentControllerBootId();
}

/** pl/send-after-stop3 (cdc665ef) shape: stop and keep a handed-off warm box
 * through the same stop-only owner the warm-window expiry uses (upstream's Stop
 * shape). Its provider receipt (or the lease's stored termination receipt) then
 * admits the successor, which resumes the stopped box or starts on a new one.
 * DB-only, called outside any transaction. Never for a non-retained lease or one
 * another holder uses (warmSandboxExpiryCandidateCondition), and at most once:
 * the intent makes the lease no longer a retained handoff. True when requested. */
async function requestHandedOffWarmLeaseStop(db: Db, run: Run, lease: typeof environmentLeases.$inferSelect,
  marker: Record<string, unknown>, why: string): Promise<boolean> {
  const [candidate] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    warmSandboxExpiryCandidateCondition())).limit(1);
  const requested = candidate && handedOffWarmLease(run, candidate)
    ? await prepareSupersededWarmSandboxStop(db, candidate, marker) : null;
  // rf-4 row 21 (the kind): a refusal is never silent.
  if (!requested) logger.warn({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId,
    candidate: Boolean(candidate), timeoutMs: handedOffWarmProofTimeout.ms },
    `handed-off warm ${why}; no stop-and-retain intent written (the box is not a stop candidate)`);
  return Boolean(requested);
}
