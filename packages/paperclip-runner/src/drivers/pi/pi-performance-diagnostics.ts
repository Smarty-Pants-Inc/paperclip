import {
  parseProviderPerformanceSpans,
  MAX_PROVIDER_PERFORMANCE_SPANS,
  MAX_PROVIDER_PERFORMANCE_SPANS_PER_NAME,
  PROVIDER_PERFORMANCE_DIAGNOSTIC,
  type ProviderPerformanceSpan,
} from "../../contracts/provider-performance.js";

/** Partition owned spans without losing rows at the diagnostic reader's caps. */
export function* piPerformanceSpanBatches(spans: readonly ProviderPerformanceSpan[]): Generator<ProviderPerformanceSpan[]> {
  let batch: ProviderPerformanceSpan[] = [];
  const counts = new Map<ProviderPerformanceSpan["name"], number>();
  for (const span of spans) {
    const count = counts.get(span.name) ?? 0;
    if (batch.length >= MAX_PROVIDER_PERFORMANCE_SPANS || count >= MAX_PROVIDER_PERFORMANCE_SPANS_PER_NAME) {
      yield batch;
      batch = []; counts.clear();
    }
    batch.push(span);
    counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
  }
  if (batch.length) yield batch;
}

/** Owned data on Pi's existing custom-entry seam, not a separate transport. */
export const PI_PERFORMANCE_ENTRY = "paperclip.provider-performance.v1";
interface PiPerformanceApi {
  on(event: "before_provider_request", handler: () => void): unknown;
  appendEntry?(customType: string, data: unknown): void;
}

/** Observe the logical pre-dispatch hook, never the provider payload or result. */
export function installPiPerformanceDiagnostics(pi: PiPerformanceApi): void {
  pi.on("before_provider_request", () => {
    try {
      const at = Date.now();
      pi.appendEntry?.(PI_PERFORMANCE_ENTRY, {
        code: PROVIDER_PERFORMANCE_DIAGNOSTIC,
        spans: [{ name: "pi.request.sent", startedAtMs: at, endedAtMs: at, outcome: "ok" }],
      });
    } catch { /* Measurement failure must not change provider work or leak an error. */ }
    // Any non-undefined return would REPLACE Pi's request payload.
  });
}

/** Startup precedes RPC's session subscription (and factory execution precedes
 * appendEntry initialization). Use the existing stderr diagnostic fallback until
 * the transport can hand these same closed spans to recordOpenTimings. No RPC,
 * session entry, provider data, or awaited diagnostic work is added. */
export const PI_OPEN_PERFORMANCE_PREFIX = "pi.open.span ";
type PiExtensionOpenPhase = Extract<ProviderPerformanceSpan["name"], `runner.pi.open.extension_${string}`>;

export function startPiExtensionOpenSpan(name: PiExtensionOpenPhase): (outcome?: ProviderPerformanceSpan["outcome"]) => void {
  const startedAtMs = Date.now();
  return (outcome = "ok") => {
    try {
      console.error(PI_OPEN_PERFORMANCE_PREFIX + JSON.stringify({ code: PROVIDER_PERFORMANCE_DIAGNOSTIC,
        spans: [{ name, startedAtMs, endedAtMs: Math.max(startedAtMs, Date.now()), outcome }] }));
    } catch { /* Measurement must never replace startup's result. */ }
  };
}

export function measurePiExtensionOpen<T>(name: PiExtensionOpenPhase, work: () => T): T {
  const finish = startPiExtensionOpenSpan(name);
  let outcome: ProviderPerformanceSpan["outcome"] = "failed";
  try { const result = work(); outcome = "ok"; return result; }
  finally { finish(outcome); }
}

/** Strict, bounded startup-only projection; never forward arbitrary stderr. */
export function piExtensionOpenPerformanceSpans(line: string, observedAtMs: number): ProviderPerformanceSpan[] {
  if (line.length > 1024 || !line.startsWith(PI_OPEN_PERFORMANCE_PREFIX)) return [];
  try {
    return parseProviderPerformanceSpans(JSON.parse(line.slice(PI_OPEN_PERFORMANCE_PREFIX.length)), observedAtMs)
      .filter(span => span.name.startsWith("runner.pi.open.extension_")).slice(0, 1);
  } catch { return []; }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Read only owned, bounded timing fields BEFORE any generic serialization/redaction. */
export function piPerformanceEntrySpans(value: unknown, observedAtMs: number): ProviderPerformanceSpan[] {
  try {
    const entry = record(value);
    if (entry.type !== "custom" || entry.customType !== PI_PERFORMANCE_ENTRY) return [];
    return parseProviderPerformanceSpans(entry.data, observedAtMs).filter(span => span.name === "pi.request.sent");
  } catch { return []; }
}
