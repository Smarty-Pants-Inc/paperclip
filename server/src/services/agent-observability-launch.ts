import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE } from "@paperclipai/shared";
import { buildProviderObservabilityLaunch, type ProviderObservabilityLaunch } from "@paperclipai/adapter-utils/agent-observability";
import type { ResolvedAgentObservability } from "./agent-observability.js";

/** Shared by early instruction preparation and final launch; legacy Pi stays unsupported. */
export function agentObservabilityKind(harness: string, adapterType: string): ProviderObservabilityLaunch["kind"] | undefined {
  return harness === "codex_local" ? "codex" : harness === "claude_local" ? "claude"
    : adapterType === "paperclip_runner" ? harness === "opencode_local" ? "opencode" : harness === "pi_rpc" ? "pi" : undefined : undefined;
}

export function agentObservabilityLaunch(snapshot: ResolvedAgentObservability, input: {
  kind: ProviderObservabilityLaunch["kind"]; companyId: string; agentId: string; runId?: string; taskId?: string | null;
}) {
  return buildProviderObservabilityLaunch({ ...input, revision: snapshot.revision, compatibilityKey: snapshot.compatibilityKey,
    enabled: snapshot.state === "enabled", capture: snapshot.state === "enabled" ? snapshot.capture : DEFAULT_AGENT_OBSERVABILITY_CAPTURE,
    ...(snapshot.state === "enabled" ? { logsEndpoint: snapshot.logsEndpoint, tracesEndpoint: snapshot.tracesEndpoint, headers: snapshot.headers } : {}) });
}
