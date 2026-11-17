import type { environmentLeases, heartbeatRuns } from "@paperclipai/db";
import { admittedNativeResourceDisposition, nativeStopWorkspaceOutcome } from "./native-failed-workspace-recovery.js";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { hasStopOnlyCleanup } from "../sandbox-stop-and-retain.js";

/** Lease policies whose box a warm Stop can hand off (native-failed-workspace-recovery). */
const reusableNativeLeasePolicies = ["reuse_by_environment", "reuse_by_execution_workspace"];

/** pl/send-after-stop: ONE predicate for a remote lease with no stop receipt
 * that a person's Stop of a warm (keep_running) turn handed off. It is settled
 * only when: native run, lease retained and unreleased with a reusable policy,
 * no stop in flight on it, the warm-stop helper says handoff, and the s3
 * fence's own proof says the stopped run's Runner exited. Shared by the
 * explicit Send gate (explicit-native-continuation.ts) and the automatic
 * remote-stop resume (acknowledgedNativeStopExecutionHasStopped). */
export async function handedOffWarmLeaseSettled(
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "nativeIssueId" | "status" | "resultJson" | "runtimeMode" | "runnerProfileJson">,
  lease: typeof environmentLeases.$inferSelect,
): Promise<boolean> {
  if (run.runtimeMode !== "native" || lease.status !== "retained" || lease.releasedAt
    || !reusableNativeLeasePolicies.includes(lease.leasePolicy)
    || lease.metadata?.pendingCleanupInFlight === true || hasStopOnlyCleanup(lease)
    || nativeStopWorkspaceOutcome({ admittedDisposition: admittedNativeResourceDisposition(run.runnerProfileJson),
      stopped: run.status === "cancelled" && hasAcknowledgedNativeRunStopRequest(run), source: lease }) !== "handoff") return false;
  const { handedOffWarmOwnerRunnerExited } = await import("./native-session-executor.js");
  return handedOffWarmOwnerRunnerExited({ runId: run.id, providerLeaseId: lease.providerLeaseId });
}
