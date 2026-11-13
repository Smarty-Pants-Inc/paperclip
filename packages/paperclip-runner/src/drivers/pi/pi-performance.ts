import { performance } from "node:perf_hooks";
import { MAX_PROVIDER_PERFORMANCE_SPANS, type ProviderPerformanceSpan } from "../../contracts/provider-performance.js";

// One epoch anchor per JS process; wall-clock adjustments cannot change elapsed work.
const epochAnchor = performance.timeOrigin;
export const piPerformanceProcessStartedAtMs = epochAnchor;
export const piPerformanceNow = (): number => epochAnchor + performance.now();

export type PiPerformancePhase = Extract<ProviderPerformanceSpan["name"], `provider.pi.${string}`>;
export type PiPerformanceSink = (span: ProviderPerformanceSpan) => void | Promise<void>;

/** Pi-local completed observations only. No identity, payload, or failure text is retained. */
export class PiPerformance {
  readonly #pending: ProviderPerformanceSpan[] = [];
  #sink?: PiPerformanceSink;

  constructor(readonly now: () => number = piPerformanceNow) {}

  start(name: PiPerformancePhase, startedAtMs = this.now()): (outcome: "ok" | "failed") => void {
    let completed = false;
    return outcome => {
      if (completed) return;
      completed = true;
      this.record({ name, startedAtMs, endedAtMs: this.now(), outcome });
    };
  }

  record(span: ProviderPerformanceSpan): void {
    const { name, startedAtMs, endedAtMs, outcome } = span;
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || startedAtMs < 0
      || endedAtMs < startedAtMs || endedAtMs - startedAtMs > 86_400_000) return;
    const row = { name, startedAtMs, endedAtMs, outcome };
    if (this.#sink) {
      try {
        const delivered = this.#sink(row);
        if (delivered) void delivered.catch(() => {});
      } catch { /* Observability must not replace an operational result. */ }
    } else if (this.#pending.length < MAX_PROVIDER_PERFORMANCE_SPANS) this.#pending.push(row);
  }

  setSink(sink?: PiPerformanceSink): void {
    this.#sink = sink;
    if (sink) for (const span of this.#pending.splice(0)) this.record(span);
  }
}

export function piRpcPerformancePhase(command: string): PiPerformancePhase | undefined {
  switch (command) {
    case "get_state": return "provider.pi.rpc.get_state";
    case "set_model": return "provider.pi.rpc.set_model";
    case "get_available_thinking_levels": return "provider.pi.rpc.get_available_thinking_levels";
    case "set_thinking_level": return "provider.pi.rpc.set_thinking_level";
    case "get_commands": return "provider.pi.rpc.get_commands";
    default: return undefined;
  }
}
