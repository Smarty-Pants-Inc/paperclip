import type { PrpEvent } from "../../protocol/replay-contract.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export const PI_COMPANY_OBSERVABILITY = {
  flag: "PAPERCLIP_OBSERVABILITY_PI", serviceName: "paperclip-pi", scopeName: "paperclip.pi",
  turnSpanName: "paperclip.pi.turn", usageSpanName: "pi.model.usage", providerToolPrefix: "pi tool",
  overflowSpanName: "pi.turn.overflow", langfuseMapping: true, preserveOverflow: true, appendUserMessages: true,
} as const;

/** Our image-N compatibility adapter, ONLY for the exporter's private feed.
 * No I/O or source mutation. One projector per session, bounded to one active
 * turn; receipt ordinals reset at run boundaries, not warm turn boundaries.
 * The projector already deduplicates native receipts. Never sum its cumulative
 * usage items: only runDelta is incremental. */
export function createPiObservabilityEvents(): (event: PrpEvent) => PrpEvent[] {
  let start: PrpEvent | undefined;
  let submitted = false;
  let runId: string | undefined;
  let ordinal = 0;
  return function piObservabilityEvents(event) {
    if (event.eventType === "turn.started" && event.turnId) {
      if (runId !== event.runId) { runId = event.runId; ordinal = 0; }
      start = event; submitted = false;
      return [];
    }
    // The paired item is cumulative, even when it shares a receipt id.
    if (event.eventType === "item.completed" && event.payload.kind === "usage") return [];
    if (!start || event.runId !== start.runId || event.turnId !== start.turnId) return [];
    const output: PrpEvent[] = [];
    const user = event.eventType === "item.completed" && event.payload.kind === "userMessage";
    if (!submitted) {
      // A user item's start is not consumption. Wait for its completed receipt.
      if (event.eventType === "item.started" && event.payload.kind === "userMessage") return [];
      output.push({ ...start, eventType: "turn.submitted", payload: { text: user ? event.payload.text : "" } });
      submitted = true;
      if (user) return output;
    }
    if (event.eventType === "usage.reported") {
      ordinal++;
      const payload = event.payload;
      if (payload.runDeltaAvailable !== true) {
        output.push({ ...event, eventType: "item.completed", payload: { kind: "usageAccounting", incomplete: true, skipped: true } });
      } else {
        const delta = record(payload.runDelta);
        const providerCost = known(delta.providerCostUsd);
        const cost = providerCost ? delta.providerCostUsd : known(payload.estimatedCostUsd) ? payload.estimatedCostUsd : undefined;
        output.push({ ...event, eventType: "item.completed", payload: {
          kind: "usage", usageMessageId: typeof payload.providerRequestId === "string" && payload.providerRequestId
            ? payload.providerRequestId : `${event.runId}:${ordinal}`,
          accountingComplete: payload.accountingComplete === true,
          model: payload.model,
          costProvenance: providerCost ? "provider_reported" : cost !== undefined ? "catalog_estimate" : "unknown",
          usage: { input: delta.inputTokens, output: delta.outputTokens,
            cache: { read: delta.cacheReadTokens, write: delta.cacheWriteTokens }, costUsd: cost },
        } });
      }
    } else output.push(event); // Includes later consumed steers and queued follow-ups.
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType)) start = undefined;
    return output;
  };
}
