import { assertNoOpenTransaction } from "@paperclipai/db/transaction-context";
import { and, eq } from "drizzle-orm";
import { environmentLeases, type Db, type heartbeatRuns } from "@paperclipai/db";
import { admittedNativeResourceDisposition, nativeStopWorkspaceOutcome } from "./native-failed-workspace-recovery.js";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { hasStopOnlyCleanup, prepareSupersededWarmSandboxStop } from "../sandbox-stop-and-retain.js";
import { warmSandboxExpiryCandidateCondition } from "../warm-sandbox-expiry.js";

/** Lease policies whose box a warm Stop can hand off (native-failed-workspace-recovery). */
const reusableNativeLeasePolicies = ["reuse_by_environment", "reuse_by_execution_workspace"];

/** Marker on the stop-and-retain intent: the handed-off box's proof was unavailable. */
export const HANDED_OFF_WARM_STOP_KEY = "handedOffWarmProofUnavailable";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "nativeIssueId" | "status" | "resultJson" | "runtimeMode" | "runnerProfileJson">;

/** A remote lease with no stop receipt that a person's Stop of a warm
 * (keep_running) turn handed off: native run, lease retained and unreleased
 * with a reusable policy, no stop in flight on it, the warm-stop helper says
 * handoff. */
function handedOffWarmLease(run: Run, lease: typeof environmentLeases.$inferSelect): boolean {
  return !(run.runtimeMode !== "native" || lease.status !== "retained" || lease.releasedAt
    || !reusableNativeLeasePolicies.includes(lease.leasePolicy)
    || lease.metadata?.pendingCleanupInFlight === true || hasStopOnlyCleanup(lease)
    || nativeStopWorkspaceOutcome({ admittedDisposition: admittedNativeResourceDisposition(run.runnerProfileJson),
      stopped: run.status === "cancelled" && hasAcknowledgedNativeRunStopRequest(run), source: lease }) !== "handoff");
}

/** pl/send-after-stop: ONE predicate for a remote lease with no stop receipt
 * that a person's Stop of a warm (keep_running) turn handed off. It is settled
 * only when it is such a lease (handedOffWarmLease) and the s3 fence's own
 * proof says the stopped run's Runner exited. Shared by the explicit Send gate
 * (explicit-native-continuation.ts) and the automatic remote-stop resume
 * (acknowledgedNativeStopExecutionHasStopped). */
export async function handedOffWarmLeaseSettled(run: Run, lease: typeof environmentLeases.$inferSelect): Promise<boolean> {
  if (!handedOffWarmLease(run, lease)) return false;
  // ad056b15's shape: the s3 fence's proof drives the Runner over the network.
  assertNoOpenTransaction("runner:handedOffWarmOwnerRunnerExited");
  const { handedOffWarmOwnerRunnerExited } = await import("./native-session-executor.js");
  return handedOffWarmOwnerRunnerExited({ runId: run.id, providerLeaseId: lease.providerLeaseId });
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
  const { handedOffWarmOwnerProofUnavailable } = await import("./native-session-executor.js");
  if (!handedOffWarmOwnerProofUnavailable({ runId: run.id, providerLeaseId: lease.providerLeaseId })) return false;
  const [candidate] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    warmSandboxExpiryCandidateCondition())).limit(1);
  if (!candidate || !handedOffWarmLease(run, candidate)) return false;
  return Boolean(await prepareSupersededWarmSandboxStop(db, candidate, { [HANDED_OFF_WARM_STOP_KEY]: true }));
}
