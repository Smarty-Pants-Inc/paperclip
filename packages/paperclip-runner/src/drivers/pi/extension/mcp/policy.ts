import { PiNativeAdmissionError } from "../../pi-native-config.js";
import type { Origin } from "../home/bind-types.js";

function fail(): never { throw new PiNativeAdmissionError("pi_native_mcp_policy", "Native MCP must use the admitted home computer server through built-in codemode, with no direct MCP declarations."); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail(); return value as Record<string, unknown>; }
export interface NativeMcpPolicyInput {
  /** Actual provider-facing declaration names, not pi.getAllTools()' callable inventory. */
  providerToolNames: readonly string[];
  /** Already tokenized --tools selectors. This module never adds mcp__ wildcards. */
  launchToolSelectors: readonly string[];
  config: unknown;
}
/** Read-only validation of Boat's post-start static home config; no second client/registry. */
export function assertNativeMcpPolicy(input: NativeMcpPolicyInput): void {
  if (!input.providerToolNames.includes("codemode") || input.providerToolNames.some(name => name.startsWith("mcp__")) || input.launchToolSelectors.some(name => name.replace(/^[+-]/, "").startsWith("mcp__"))) fail();
  const config = object(input.config), servers = object(config.mcpServers);
  const computer = object(servers.computer);
  if (computer.enabled === false || (typeof computer.command !== "string" && typeof computer.url !== "string")) fail();
  for (const value of Object.values(servers)) {
    const server = object(value);
    if (server.enabled === false) continue;
    if (server.exposure !== undefined && !["codemode", "codemode-deferred", "hidden"].includes(server.exposure as string)) fail();
    for (const exposure of Object.values(object(server.toolExposure ?? {}))) if (!["codemode", "codemode-deferred", "hidden"].includes(exposure as string)) fail();
  }
}
export interface NativeMcpCallInput {
  event: { toolName: string; toolCallId: string; parentToolCallId?: string };
  parent: { toolName: string; toolCallId: string };
  tools: readonly { name: string; sourceInfo: { path: string; source: string }; namespace?: { name: string } }[];
  /** Captured at creation, never read from currentRun when the async call completes. */
  origin: Origin;
}
/** Canonical provenance for authority-owner rechecks; this does not itself grant effects. */
export function describeNativeMcpCall(input: NativeMcpCallInput) {
  const { event, parent, origin } = input;
  const matches = input.tools.filter(tool => tool.name === event.toolName), tool = matches[0];
  if (matches.length !== 1 || parent.toolName !== "codemode" || !parent.toolCallId || !event.toolCallId || event.parentToolCallId !== parent.toolCallId || !event.toolName.startsWith("mcp__") || tool.sourceInfo.path !== "builtin:mcp" || tool.sourceInfo.source !== "builtin" || !tool.namespace?.name.startsWith("mcp__") || !Number.isSafeInteger(origin.epoch) || origin.epoch < 0 || !origin.runId || !origin.turnId) fail();
  return Object.freeze({ toolName: event.toolName, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId, namespace: tool.namespace.name, source: "builtin:mcp" as const, origin: Object.freeze({ ...origin }) });
}
