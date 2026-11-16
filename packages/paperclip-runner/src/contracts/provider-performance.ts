/** Content-free provider diagnostics carried by the existing PRP diagnostic event. */
export const PROVIDER_PERFORMANCE_DIAGNOSTIC = "provider_performance_spans";
export const PROVIDER_PERFORMANCE_ENV = "PAPERCLIP_OPENCODE_PERFORMANCE_DIAGNOSTICS";
export const MAX_PROVIDER_PERFORMANCE_SPANS = 128;
export const MAX_PROVIDER_PERFORMANCE_SPANS_PER_NAME = 16;
export const PROVIDER_PERFORMANCE_PHASES = [
  "provider.context.environment", "provider.context.instructions", "provider.skills.discovery",
  "provider.tools.resolve", "provider.model.resolve", "provider.model.stream",
  "provider.workspace.snapshot.track", "provider.workspace.snapshot.patch", "provider.workspace.snapshot.diff",
  "provider.workspace.git.discover", "provider.workspace.git.default_branch",
  "provider.dependencies.install", "provider.plugins.initialize",
  "runner.pi.open.total", "runner.pi.open.workspace", "runner.pi.open.native_mcp_config",
  "runner.pi.open.company_skills", "runner.pi.open.extension_resolve", "runner.pi.open.models_snapshot",
  "runner.pi.open.model_catalog", "runner.pi.open.model_resolve", "runner.pi.open.compaction_config",
  "runner.pi.open.provider_binding", "runner.pi.open.models_json_write", "runner.pi.open.pi_spawn_to_get_state",
  "runner.pi.open.admission", "runner.pi.open.available_models", "runner.pi.open.tool_inventory",
  "runner.pi.open.settle", "runner.pi.open.bind_receipt", "runner.pi.open.begin_turn",
  "runner.pi.attach", "runner.pi.bind", "runner.pi.begin_turn", "runner.pi.interrupt_wait", "runner.pi.prompt_to_started",
  "runner.pi.tool_inventory", "runner.pi.settle", "runner.pi.stop_children", "runner.pi.park_ready",
  "runner.pi.admission.get_state", "runner.pi.admission.set_model",
  "runner.pi.admission.get_available_thinking_levels", "runner.pi.admission.set_thinking_level",
  "pi.request.sent",
] as const;
export type ProviderPerformancePhase = typeof PROVIDER_PERFORMANCE_PHASES[number];
export interface ProviderPerformanceSpan {
  name: ProviderPerformancePhase;
  startedAtMs: number;
  endedAtMs: number;
  outcome: "ok" | "failed";
  attributes?: { timeoutCode: "pi_bind_timeout" };
}

const names = new Set<string>(PROVIDER_PERFORMANCE_PHASES);
const maxDurationMs = 24 * 60 * 60 * 1000;

/** Project fields rather than forwarding provider attributes or untrusted diagnostic data. */
export function parseProviderPerformanceSpans(payload: unknown, observedAtMs: number): ProviderPerformanceSpan[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const diagnostic = payload as Record<string, unknown>;
  if (diagnostic.code !== PROVIDER_PERFORMANCE_DIAGNOSTIC || !Array.isArray(diagnostic.spans)) return [];
  const counts = new Map<string, number>();
  return diagnostic.spans.slice(0, MAX_PROVIDER_PERFORMANCE_SPANS).flatMap((value): ProviderPerformanceSpan[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const { name, startedAtMs, endedAtMs } = row;
    if (typeof name !== "string" || !names.has(name) || typeof startedAtMs !== "number" || typeof endedAtMs !== "number"
      || !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)
      || startedAtMs < observedAtMs - maxDurationMs || endedAtMs > observedAtMs + 1000
      || endedAtMs < startedAtMs || endedAtMs - startedAtMs > maxDurationMs
      || (name === "pi.request.sent" && endedAtMs !== startedAtMs)) return [];
    const count = counts.get(name) ?? 0;
    if (count >= MAX_PROVIDER_PERFORMANCE_SPANS_PER_NAME) return [];
    counts.set(name, count + 1);
    return [{ name: name as ProviderPerformancePhase, startedAtMs, endedAtMs,
      outcome: row.outcome === "failed" ? "failed" : "ok",
      ...(row.outcome === "failed" && name.startsWith("runner.pi.")
        && row.attributes !== null && typeof row.attributes === "object"
        && (row.attributes as Record<string, unknown>).timeoutCode === "pi_bind_timeout"
        ? { attributes: { timeoutCode: "pi_bind_timeout" as const } } : {}) }];
  });
}
