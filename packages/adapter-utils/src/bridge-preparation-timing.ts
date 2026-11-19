/** Run-log diagnostics only. Never pass provider text, paths or authority here. */
export const BRIDGE_PREPARATION_KINDS = [
  "queue_setup", "entrypoint_install", "gateway_ready", "launcher_staging", "path_resolution",
  "gate_off", "capability_absent", "channel_open", "ready_wait", "preface_wait", "fallback",
  "quarantine_list", "stale_entry_settle", "generation_markers", "poll_start_wait",
] as const;
export type BridgePreparationKind = (typeof BRIDGE_PREPARATION_KINDS)[number];

/** Starting/ending a measurement is synchronous; persistence belongs to the caller. */
export type BridgePreparationSpan = (kind: BridgePreparationKind) => (outcome: "ok" | "failed") => void;

export async function measureBridgePreparation<T>(
  span: BridgePreparationSpan | undefined,
  kind: BridgePreparationKind,
  work: () => Promise<T>,
  classify: (value: T) => "ok" | "failed" = () => "ok",
): Promise<T> {
  const end = span?.(kind);
  let outcome: "ok" | "failed" = "failed";
  try {
    const value = await work();
    outcome = classify(value);
    return value;
  } finally {
    end?.(outcome);
  }
}
