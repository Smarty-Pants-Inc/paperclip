import type { IssueQueuedCommentQueue } from "@paperclipai/shared";

/**
 * How a message sent while the agent works is delivered (Paul NOTE 6,
 * smarty-dev#20992). Steer joins the running turn at its next step; Queue
 * waits for the turn to end; Interrupt stops the current step and sends now.
 * Steer and Queue are modes a waiting message keeps; Interrupt is an action.
 */
export type SendMode = "steer" | "queue" | "interrupt";
export type SubmitKey = "enter" | "mod-enter";
export type SteeringDisposition = IssueQueuedCommentQueue["steeringDisposition"];

export const SEND_MODE_LABEL: Record<SendMode, string> = {
  steer: "Steer",
  queue: "Queue",
  interrupt: "Interrupt",
};

export const SEND_MODE_DESCRIPTION: Record<SendMode, string> = {
  steer: "Delivered at the agent's next step, without stopping it.",
  queue: "Sent after the agent finishes this turn.",
  interrupt: "Stops the current step and sends now.",
};

export function isConversationResetDraft(body: string): boolean {
  return body.trim() === "/new";
}

/** Why Steer is not offered, or null when it is. */
export function steerUnavailableReason(input: {
  steeringDisposition: SteeringDisposition | null | undefined;
  draftIsReset?: boolean;
}): string | null {
  if (input.draftIsReset) return "/new starts a new conversation; it always waits for this turn.";
  if (input.steeringDisposition === "temporarily_unavailable") return "Steering is temporarily unavailable.";
  if (input.steeringDisposition === "unsupported") return "Not available: this runner can't take messages mid-turn.";
  // Unknown (nothing waiting yet): Steer, which falls back to the turn boundary if the runner can't take it.
  return null;
}

/** Steer while the agent works and the runner takes it; otherwise Queue. A /new is always Queue. */
export function defaultSendMode(input: {
  steeringDisposition: SteeringDisposition | null | undefined;
  draftIsReset?: boolean;
}): Exclude<SendMode, "interrupt"> {
  return steerUnavailableReason(input) === null ? "steer" : "queue";
}

type KeyEventLike = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
};

/**
 * The send chord an Enter key event means, or null for a new line (or no
 * send at all). "default" sends in the composer's default mode.
 *
 * | Action    | Enter sends (default) | "Ctrl/⌘+Enter to submit" on |
 * | Default   | Enter                 | Ctrl/⌘+Enter                |
 * | Queue     | Ctrl/⌘+Enter          | Ctrl/⌘+Shift+Enter          |
 * | Interrupt | Ctrl/⌘+Alt+Enter      | Ctrl/⌘+Alt+Enter            |
 *
 * Interrupt is ignored when AltGr is held: on Windows international layouts
 * AltGr reports as Ctrl+Alt, and typing a character must never interrupt.
 */
export function resolveSendIntent(
  event: KeyEventLike,
  submitKey: SubmitKey,
  options: { working: boolean } = { working: true },
): SendChord | null {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return null;
  const mod = event.ctrlKey || event.metaKey;
  // Idle (and document editors): every send chord just sends, as before.
  if (!options.working) {
    if (event.shiftKey || event.altKey) return null;
    return submitKey === "enter" || mod ? "default" : null;
  }
  if (event.altKey) {
    if (!mod || event.shiftKey) return null;
    if (event.getModifierState?.("AltGraph")) return null;
    return "interrupt";
  }
  if (submitKey === "enter") {
    if (event.shiftKey) return null;
    return mod ? "queue" : "default";
  }
  if (!mod) return null;
  return event.shiftKey ? "queue" : "default";
}

/** The key shown next to a mode in the Send menu. The default mode shows the plain send key. */
export function sendModeShortcut(
  mode: SendMode,
  submitKey: SubmitKey,
  options: { isMac: boolean; defaultMode: Exclude<SendMode, "interrupt"> },
): string {
  const mod = options.isMac ? "⌘" : "Ctrl";
  const join = (keys: string[]) => keys.join(options.isMac ? "" : "+");
  if (mode === "interrupt") return join([mod, options.isMac ? "⌥" : "Alt", options.isMac ? "↩" : "Enter"]);
  const enter = options.isMac ? "↩" : "Enter";
  const plain = submitKey === "enter" ? enter : join([mod, enter]);
  const other = submitKey === "enter" ? join([mod, enter]) : join([mod, options.isMac ? "⇧" : "Shift", enter]);
  if (mode === options.defaultMode) return plain;
  return mode === "queue" ? other : plain;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export type SendChord = "default" | "queue" | "interrupt";
