import { QUALIFIED_PI_RPC_PROFILE } from "./generated-profile.js";
export { QUALIFIED_PI_RPC_PROFILE } from "./generated-profile.js";
export type NativePiRpcProfileSnapshot = typeof QUALIFIED_PI_RPC_PROFILE;

/** Exact current release; never accept ACPX or silently replace a saved profile. */
export function parsePiRpcProfile(value: unknown): NativePiRpcProfileSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== Object.keys(QUALIFIED_PI_RPC_PROFILE).length
    || Object.entries(QUALIFIED_PI_RPC_PROFILE).some(([key, expected]) => (value as Record<string, unknown>)[key] !== expected)) {
    throw new Error("Native Pi RPC profile differs from its registered release");
  }
  return { ...QUALIFIED_PI_RPC_PROFILE };
}

/** @earendil-works/pi-coding-agent 1.5.2 docs/rpc-commands.md:282.
 * Native xhigh and max are separate model-dependent values, never aliases.
 */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export function parsePiThinkingLevel(value: unknown): PiThinkingLevel {
  if (typeof value !== "string" || !PI_THINKING_LEVELS.includes(value as PiThinkingLevel)) throw new Error("Invalid native Pi thinking level");
  return value as PiThinkingLevel;
}
