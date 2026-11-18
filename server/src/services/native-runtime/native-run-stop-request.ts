import { readRunCancellation } from "../run-cancellation.js";

// Fork-only home for upstream's `nativeRunHasStopRequest`. Upstream defines it in
// native-tool-receipt-limit.ts (paperclipai/paperclip#21913), which this fork
// does not carry yet; #21959 (native environment blocker retry) needs only this
// helper. The body is byte-identical to upstream's. When #21913 is ported,
// delete this file and import from native-tool-receipt-limit.ts instead.
export function nativeRunHasStopRequest(resultJson: Record<string, unknown> | null | undefined): boolean {
  if (!resultJson) return false;
  const cancellation = readRunCancellation(resultJson);
  return Boolean(resultJson.nativeCancellation || resultJson.executionCancellation || resultJson.cancelledByActorType
    || resultJson.cancelledByUserId || resultJson.interruptedByActorType || resultJson.queuedCommentInterruptQueueId
    || resultJson.issueMutationStopId || resultJson.operatorInterrupted === true
    || (cancellation && cancellation.initiator.type !== "system" && cancellation.initiator.type !== "provider"));
}
