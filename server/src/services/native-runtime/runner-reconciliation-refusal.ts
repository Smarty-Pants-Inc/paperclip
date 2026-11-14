import { PROVIDER_LAUNCH_PROFILE_MISMATCH, runnerPrepareRefusalCode } from "../../vendor/paperclip-runner/index.js";

/** The Runner owns command diagnostics and normalization. Core matches codes,
 * never provider names, launch arguments, or text embedded in model output. */
export function runnerLaunchProfileMismatch(error: unknown): boolean {
  return runnerPrepareRefusalCode(error) === PROVIDER_LAUNCH_PROFILE_MISMATCH;
}
