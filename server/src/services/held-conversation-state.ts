/** Stable operator states shared by acquisition, native execution and recovery. */
export const HELD_BOX_LOST = "held_box_lost";
export const REPLACEMENT_DEFERRED_CONVERSATION = "replacement_deferred_unexported_conversation";
export type HeldConversationFailureCode = typeof HELD_BOX_LOST | typeof REPLACEMENT_DEFERRED_CONVERSATION;

export const HELD_BOX_LOST_MESSAGE = "The sandbox holding this task's conversation is gone and no backup could be restored. "
  + "Retry starts a fresh conversation; the earlier messages stay on the task. You can also reset the conversation to start again.";
export const REUSABLE_CONVERSATION_HELD_MESSAGE = "The original sandbox still holds this task's conversation. "
  + "Restore the original configuration to continue, or reset the conversation if you intend to start again. "
  + "A saved backup alone does not allow Paperclip to release the sandbox.";

export class HeldBoxLostError extends Error {
  readonly code = HELD_BOX_LOST;
  readonly retryable = false;
  constructor(options?: ErrorOptions) {
    super(`${HELD_BOX_LOST}: ${HELD_BOX_LOST_MESSAGE}`, options);
    this.name = "HeldBoxLostError";
  }
}

export class ReusableConversationHeldError extends Error {
  readonly code = REPLACEMENT_DEFERRED_CONVERSATION;
  readonly retryable = false;
  constructor(detail?: string, options?: ErrorOptions) {
    super(`${REPLACEMENT_DEFERRED_CONVERSATION}: ${detail ? `${detail}. ` : ""}${REUSABLE_CONVERSATION_HELD_MESSAGE}`, options);
    this.name = "ReusableConversationHeldError";
  }
}

/** Wrappers must not turn a named refusal into an automatic replacement. */
export function heldConversationFailureCode(error: unknown): HeldConversationFailureCode | null {
  const seen = new Set<unknown>();
  for (let value: unknown = error; value && !seen.has(value); value = typeof value === "object" ? (value as { cause?: unknown }).cause : null) {
    seen.add(value);
    const code = typeof value === "object" ? (value as { code?: unknown }).code : null;
    const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
    for (const state of [HELD_BOX_LOST, REPLACEMENT_DEFERRED_CONVERSATION] as const)
      if (code === state || message.startsWith(`${state}:`) || message === state) return state;
  }
  return null;
}

export const LOST_CONVERSATION_SOURCE_KEY = "lostConversationSource";
export const LOST_CONVERSATION_SOURCE_SCHEMA = "paperclip.lost-conversation-source.v1";

type SourceLease = { status: string; cleanupStatus: string | null; failureReason: string | null;
  providerLeaseId: string | null; metadata: Record<string, unknown> | null };
/** Successful cleanup expiry is authoritative even when an older release left no termination receipt.
 * Pending cleanup, a transport refusal, and an expired timestamp alone are not proof. */
export function nativeConversationSourceIsLost(lease: SourceLease): boolean {
  if (lease.status !== "expired" || lease.cleanupStatus !== "success" || !lease.providerLeaseId) return false;
  const marker = lease.metadata?.[LOST_CONVERSATION_SOURCE_KEY] as Record<string, unknown> | undefined;
  return lease.failureReason === "pending_cleanup_retry" || (marker?.schema === LOST_CONVERSATION_SOURCE_SCHEMA
    && marker.providerLeaseId === lease.providerLeaseId && typeof marker.observedAt === "string"
    && Number.isFinite(Date.parse(marker.observedAt)));
}
