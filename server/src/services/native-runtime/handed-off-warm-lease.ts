import { assertNoOpenTransaction } from "@paperclipai/db/transaction-context";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db, type heartbeatRuns } from "@paperclipai/db";
import { admittedNativeResourceDisposition, nativeStopWorkspaceOutcome } from "./native-failed-workspace-recovery.js";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { hasStopOnlyCleanup, prepareSupersededWarmSandboxStop } from "../sandbox-stop-and-retain.js";
import { warmSandboxExpiryCandidateCondition } from "../warm-sandbox-expiry.js";
import { logger } from "../../middleware/logger.js";

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
/** rf-4 row 22f: bound on the remote proof (stop the idle Runner, wait for its exit). */
export const handedOffWarmProofTimeout = { ms: 20_000 };
type ProofOutcome = "none" | "proven" | "unproven" | "timed_out";
const proofsInFlight = new Map<string, Promise<ProofOutcome>>();
/** A proof for this run is running outside the transaction right now (process-local). */
export function handedOffWarmProofInFlight(runId: string): boolean { return proofsInFlight.has(runId); }

/** rf-4 row 22a/22f: run the s3 fence's runner-exit proof for every handed-off
 * warm lease of this run that has no persisted answer yet, OUTSIDE any
 * transaction (callers pass the root Db; the tx-guard throws otherwise),
 * bounded by handedOffWarmProofTimeout. Proven -> the evidence key is written on
 * the lease. Timed out -> a stop_and_retain intent (its provider receipt then
 * admits the successor through the receipt path). */
export function proveHandedOffWarmLeases(db: Db, run: Run): Promise<ProofOutcome> {
  const running = proofsInFlight.get(run.id);
  if (running) return running;
  const work = (async (): Promise<ProofOutcome> => {
    const leases = (await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id)))).filter(lease => handedOffWarmLease(run, lease) && !handedOffWarmLeaseSettled(run, lease));
    if (!leases.length) return "none";
    assertNoOpenTransaction("runner:handedOffWarmOwnerRunnerExited");
    const { handedOffWarmOwnerRunnerExited } = await import("./native-session-executor.js");
    let outcome: ProofOutcome = "proven";
    for (const lease of leases) {
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
        const [candidate] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
          eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
          warmSandboxExpiryCandidateCondition())).limit(1);
        const requested = candidate && handedOffWarmLease(run, candidate)
          ? await prepareSupersededWarmSandboxStop(db, candidate, { [HANDED_OFF_WARM_STOP_KEY]: true, proofTimedOutMs: handedOffWarmProofTimeout.ms })
          : null;
        // rf-4 row 21 (the kind): a refusal is never silent.
        if (!requested) logger.warn({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId,
          candidate: Boolean(candidate), timeoutMs: handedOffWarmProofTimeout.ms },
          "handed-off warm proof timed out; no stop-and-retain intent written (the box is not a stop candidate)");
        return "timed_out";
      }
      outcome = "unproven";
      break;
    }
    return outcome;
  })().finally(() => proofsInFlight.delete(run.id));
  proofsInFlight.set(run.id, work);
  return work;
}
