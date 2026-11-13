import { configuredEnvironment, configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";

/** The managed run projection is the authority, never company/agent config.
 * See doc/connections/GITHUB.md, "Run projection". Keep the exact names in sync
 * with Pi's TS ceiling and PI_GITHUB_PROJECTION_KEYS in the Rust supervisor.
 */
export const PI_GITHUB_PROJECTION_KEYS = [
  "ZDOTDIR", "BASH_ENV", "GH_CONFIG_DIR", "PAPERCLIP_GITHUB_LAUNCHER_DIR",
  "PAPERCLIP_GITHUB_BROKER_URL", "PAPERCLIP_GITHUB_BROKER_TOKEN", "PAPERCLIP_GITHUB_BRIDGE_TOKEN",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK",
] as const;
// The payload contains broker capabilities; the suffix also makes existing
// environment/command log redactors treat the entire serialized value as secret.
export const PI_GITHUB_PROJECTION_ENV = "PAPERCLIP_PI_GITHUB_PROJECTION_SECRET";

export function nativePiGitHubEnvironment(configured: NodeJS.ProcessEnv = {}, projection?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...configured };
  for (const key of [...PI_GITHUB_PROJECTION_KEYS, PI_GITHUB_PROJECTION_ENV]) delete environment[key];
  if (configured.PAPERCLIP_CONFIGURED_ENV_KEYS !== undefined) {
    // Remove scrubbed names from the existing manifest too, without promoting
    // any previously unlisted value to controller-configured input.
    const ordinary = configuredEnvironment(configured);
    for (const key of PI_GITHUB_PROJECTION_KEYS) delete ordinary[key];
    environment.PAPERCLIP_CONFIGURED_ENV_KEYS = configuredEnvironmentProjection(ordinary).PAPERCLIP_CONFIGURED_ENV_KEYS;
  }
  // An explicit empty payload also overwrites any guest-injected ambient
  // payload when no connection exists; absence must not confer authority.
  if (projection === undefined) return { ...environment, [PI_GITHUB_PROJECTION_ENV]: "{}" };
  const managed = Object.fromEntries(PI_GITHUB_PROJECTION_KEYS.flatMap(key =>
    projection[key] === undefined ? [] : [[key, projection[key]]],
  ));
  // Preserve the rest of Paperclip's projection (PATH, safe Git pairs, etc.).
  // The private payload carries provenance across runnerd's process boundary;
  // it cannot be supplied by configured input and is never forwarded to Pi.
  return { ...environment, ...projection, [PI_GITHUB_PROJECTION_ENV]: JSON.stringify(managed) };
}
