/**
 * The one adapter for how a sent chat message is delivered while the agent
 * works (steering-by-default). Every server field name for this contract
 * lives here, so a server rename changes only this file.
 *
 * The CLIENT never decides steer vs queue. It sends the person's pick (or
 * nothing, for the default Send) and shows what the server answered.
 *
 * Server contract (neworg-lead, neworg/steer-server-c3 = 69c95176):
 * - request: `POST /api/issues/:id/comments` body `deliveryIntent`
 *   ('steer' | 'queue' | 'interrupt'). Omitted = steer while a native Pi run
 *   is attached; the ordinary path otherwise.
 * - POST response and GET thread data: `steeredIntoRunId` (string | null),
 *   `steeredAt` (ISO string | null), `steeringStatus`
 *   ('accepted' | 'delivered' | null) and `steeringDeliveryEventSeq`
 *   (number | null). 'accepted' is shown as SENT; only 'delivered' (Pi's own
 *   persisted read of the message) is shown as DELIVERED, on the same bubble.
 * - `deliveryOutcome: 'queued'` and `steeringUnavailableReason` (the D5
 *   reason) arrive in the server's follow-up with these exact names. Until
 *   then a queued POST answers with `steeredIntoRunId: null`, and the waiting
 *   list comes from the server's queued-comments read.
 */

export type CommentDeliveryIntent = "steer" | "queue" | "interrupt";

/** Request fields for one send. The default Send omits the intent. */
export function commentDeliveryRequestFields(
  deliveryIntent: CommentDeliveryIntent | undefined,
): Record<string, unknown> {
  if (!deliveryIntent) return {};
  // `interrupt: true` keeps an Interrupt working on a server that predates
  // `deliveryIntent`; the new server reads `deliveryIntent`.
  return deliveryIntent === "interrupt"
    ? { deliveryIntent, interrupt: true }
    : { deliveryIntent };
}

export type CommentDeliveryOutcome =
  /** The server steered it into the running turn: show it in the thread now. */
  | { kind: "steered"; runId: string; steeredAt: string | null }
  /** The server queued it: show it in the waiting list. */
  | { kind: "queued"; steeringUnavailableReason: string | null }
  /** An ordinary send (the agent was idle, or an interrupt was accepted). */
  | { kind: "sent" };

type DeliveryFields = {
  steeredIntoRunId?: unknown;
  steeredAt?: unknown;
  steeringStatus?: unknown;
  deliveryOutcome?: unknown;
  steeringUnavailableReason?: unknown;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The run a comment was steered into, from the POST response or the GET thread data. */
export function readSteeredIntoRunId(comment: object | null | undefined): string | null {
  if (!comment) return null;
  return stringOrNull((comment as DeliveryFields).steeredIntoRunId);
}

/**
 * How far a steered message got, as the server says: 'sent' (the server
 * handed it to the running turn: `steeringStatus` 'accepted') or 'delivered'
 * (Pi itself read it into the turn: `steeringStatus` 'delivered'). Null for a
 * message that was not steered.
 */
export type SteeredDelivery = "sent" | "delivered";
export function readSteeredDelivery(comment: object | null | undefined): SteeredDelivery | null {
  if (!readSteeredIntoRunId(comment)) return null;
  return (comment as DeliveryFields).steeringStatus === "delivered" ? "delivered" : "sent";
}

/** Exactly what the server answered for one POST. Nothing here is a client guess. */
export function readCommentDelivery(comment: object | null | undefined): CommentDeliveryOutcome {
  const fields = (comment ?? {}) as DeliveryFields;
  const steeredIntoRunId = readSteeredIntoRunId(comment);
  if (steeredIntoRunId) {
    return { kind: "steered", runId: steeredIntoRunId, steeredAt: stringOrNull(fields.steeredAt) };
  }
  if (fields.deliveryOutcome === "queued" || (fields as { queueState?: unknown }).queueState === "queued") {
    return { kind: "queued", steeringUnavailableReason: stringOrNull(fields.steeringUnavailableReason) };
  }
  return { kind: "sent" };
}

/** Key chords, shown as text for the platform. Mac uses ⌘; Windows and Linux use Ctrl. */
export interface SendChordLabels {
  send: string;
  steer: string;
  queue: string;
  interrupt: string;
  newLine: string;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function sendChordLabels(mac: boolean, submitKey: "enter" | "mod-enter"): SendChordLabels {
  const send = submitKey === "mod-enter" ? (mac ? "⌘+Enter" : "Ctrl+Enter") : "Enter";
  return {
    send,
    steer: send,
    queue: mac ? "Ctrl+⌘+Enter" : "Ctrl+Alt+Enter",
    interrupt: mac ? "Shift+⌘+Enter" : "Shift+Ctrl+Enter",
    newLine: submitKey === "mod-enter" ? "Enter" : "Shift+Enter",
  };
}

/**
 * The Queue and Interrupt chords. They hold two modifiers, so they never
 * collide with Enter or "Ctrl/⌘+Enter to submit"; the preference only swaps
 * Send and New line. Queue is ignored while AltGr is held.
 */
export function sendChordIntent(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"> & {
    getModifierState?: (key: string) => boolean;
  },
  mac: boolean,
): Exclude<CommentDeliveryIntent, "steer"> | null {
  if (event.key !== "Enter") return null;
  if (mac) {
    if (event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey) return "interrupt";
    if (event.metaKey && event.ctrlKey && !event.shiftKey && !event.altKey) return "queue";
    return null;
  }
  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) return "interrupt";
  if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey) {
    if (event.getModifierState?.("AltGraph")) return null;
    return "queue";
  }
  return null;
}
