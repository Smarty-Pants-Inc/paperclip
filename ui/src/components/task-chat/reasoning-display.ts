import { findUIAdapter } from "@/adapters/registry";

/** How a run's reasoning shows in chat: folded into the turn, or inline. */
export type ReasoningDisplay = "fold" | "inline";

/**
 * One place decides how a run's reasoning shows: the run adapter's declared
 * `transcriptPresentation.liveReasoningView`, else fold. There is no per-chat
 * or per-browser choice.
 */
export function adapterReasoningDisplay(adapterType: string | null | undefined): ReasoningDisplay {
  return adapterType && findUIAdapter(adapterType)?.transcriptPresentation?.liveReasoningView === "inline"
    ? "inline"
    : "fold";
}
