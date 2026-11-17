/**
 * fam-retry4 (rf-3 finding 3): a held-conversation note in the transcript is a
 * record of the CONDITION ("...the previous run of this conversation did not
 * finish."). The instruction it was posted with ("Press Retry ...") belongs to
 * the moment it was posted; the live task card (the one Retry authority:
 * Retry, Resume agent, or the hold's words) gives the current action. So the
 * thread renders only the condition: exactly one instruction is visible, the
 * card's, in the board thread and the chat alike.
 */
export const HELD_CONVERSATION_NOTE_REASON_PREFIX = "native_prior_owner_held:";

export function isHeldConversationNote(metadata: unknown): boolean {
  const reason = (metadata as { authorizationReason?: unknown } | null | undefined)?.authorizationReason;
  return typeof reason === "string" && reason.startsWith(HELD_CONVERSATION_NOTE_REASON_PREFIX);
}

/** The note's condition: its first sentence. Other notes are returned unchanged. */
export function heldConversationNoteBody(body: string, metadata: unknown): string {
  if (!isHeldConversationNote(metadata)) return body;
  const condition = body.match(/^[\s\S]*?\.(?=\s|$)/)?.[0]?.trim();
  return condition || body;
}
