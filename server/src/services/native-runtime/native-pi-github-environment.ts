import { configuredEnvironment, configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";

/** The managed run projection is the authority, never company/agent config.
 * See doc/connections/GITHUB.md, "Run projection". Keep the exact names in sync
 * with Pi's TS ceiling and PI_RPC_PROVIDER_ENVIRONMENT_KEYS in Rust.
 */
export const PI_GITHUB_PROJECTION_KEYS = [
  "ZDOTDIR", "BASH_ENV", "GH_CONFIG_DIR", "PAPERCLIP_GITHUB_LAUNCHER_DIR",
  "PAPERCLIP_GITHUB_BROKER_URL", "PAPERCLIP_GITHUB_BROKER_TOKEN", "PAPERCLIP_GITHUB_BRIDGE_TOKEN",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK",
] as const;
export function nativePiGitHubEnvironment(configured: NodeJS.ProcessEnv = {}, projection?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...configured };
  for (const key of PI_GITHUB_PROJECTION_KEYS) delete environment[key];
  if (configured.PAPERCLIP_CONFIGURED_ENV_KEYS !== undefined) {
    // Remove scrubbed names from the existing manifest too, without promoting
    // any previously unlisted value to controller-configured input.
    const ordinary = configuredEnvironment(configured);
    for (const key of PI_GITHUB_PROJECTION_KEYS) delete ordinary[key];
    environment.PAPERCLIP_CONFIGURED_ENV_KEYS = configuredEnvironmentProjection(ordinary).PAPERCLIP_CONFIGURED_ENV_KEYS;
  }
  // Only this run's githubAccess.env can restore managed names. Preserve the
  // rest of that projection too (PATH, safe Git pairs, etc.).
  return { ...environment, ...projection };
}
