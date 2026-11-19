/**
 * The one adapter for how a sent chat message is delivered while the agent
 * works (steering-by-default). Every server field name for this contract
 * lives here, so the final names from the server change only this file.
 *
 * The CLIENT never decides steer vs queue. It sends the person's pick (or
 * nothing, for the default Send) and shows what the server answered.
 *
 * PROVISIONAL server contract (neworg-lead):
 * - request: `POST /api/issues/:id/comments` body `deliveryIntent`
 *   ('steer' | 'queue' | 'interrupt'). Omitted while the agent works = steer.
 * - response / thread data: a steered comment carries `steeredIntoRunId`
 *   (string | null) and `steeredAt` (ISO string | null).
 * - response: a queued comment says so with `deliveryOutcome: 'queued'`; when
 *   steering was asked for (or was the default) but the server could not
 *   steer, it also carries `steeringUnavailableReason` (the D5 reason).
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
