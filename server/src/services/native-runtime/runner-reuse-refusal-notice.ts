import { PROVIDER_LAUNCH_PROFILE_MISMATCH, runnerRecoveryFailureClass } from "../../vendor/paperclip-runner/index.js";

export const NATIVE_RUNNER_LAUNCH_PROFILE_MISMATCH = "native_runner_launch_profile_mismatch";
export type RunnerReuseRefusalReason = "runner_launch_profile_mismatch" | "runner_pack_reuse_blocked";
export const RUNNER_REUSE_REFUSAL_NEXT_ACTION =
  "An operator must verify the conversation save and custody, then confirm the old computer stopped before continuing the saved request. Do not resend it.";

/** Shared by immediate and restart/sweep notice writers; no provider parsing. */
export function runnerReuseRefusalReason(run: { errorCode: string | null; error: string | null }): RunnerReuseRefusalReason | null {
  if (run.errorCode === NATIVE_RUNNER_LAUNCH_PROFILE_MISMATCH
    || run.error && runnerRecoveryFailureClass(new Error(run.error)) === PROVIDER_LAUNCH_PROFILE_MISMATCH) {
    return "runner_launch_profile_mismatch";
  }
  if (run.errorCode === "runner_pack_reuse_blocked" || /^(?:Error: )?runner_pack_reuse_blocked(?=$|[:\s])/.test(run.error ?? "")) {
    return "runner_pack_reuse_blocked";
  }
  return null;
}

export function runnerReuseRefusalText(reason: RunnerReuseRefusalReason): string {
  const detail = reason === "runner_launch_profile_mismatch"
    ? "the saved computer's Runner launch profile is incompatible with this release"
    : "the saved conversation, custody and confirmed stop of the old Runner could not all be verified";
  return `I could not run this message because ${detail}. The request is saved and the old computer and conversation were preserved; I did not start an empty conversation or retry the incompatible Runner. Recovery needs a verified conversation save. An operator must verify custody of that save and confirm the old computer is stopped before a fresh computer can continue the saved request. You do not need to send it again.`;
}
