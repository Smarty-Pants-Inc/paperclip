// Shared failure fact for activation, run settlement and the existing notice.
// Keep it independent of the broker's transport and credential dependencies.
export const NATIVE_GITHUB_SETUP_FAILED = "native_github_setup_failed";
export const NATIVE_GITHUB_SETUP_FAILED_ACTION = "GitHub access couldn't be set up for this turn. Retry to try again.";
export class NativeGitHubSetupError extends Error {
  readonly code = NATIVE_GITHUB_SETUP_FAILED;
  constructor() {
    super("GitHub access couldn't be set up for this turn");
    this.name = "NativeGitHubSetupError";
  }
}
