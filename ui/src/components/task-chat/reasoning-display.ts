import type { ReasoningDisplay } from "@paperclipai/shared";
import { findUIAdapter } from "@/adapters/registry";

export type { ReasoningDisplay };

/** The reasoning display an adapter declares for its transcripts. */
export function adapterReasoningDisplay(adapterType: string | null | undefined): ReasoningDisplay {
  return adapterType && findUIAdapter(adapterType)?.transcriptPresentation?.liveReasoningView === "inline"
    ? "inline"
    : "fold";
}

/**
 * One place decides how a run's reasoning shows: the person's choice for the
 * run's agent (set on the agent's page and saved on the server), else the
 * adapter's declared default. There is no per-chat or per-browser choice.
 */
export function resolveReasoningDisplay(
  preferences: Readonly<Record<string, ReasoningDisplay>> | null | undefined,
  agentId: string | null | undefined,
  adapterType: string | null | undefined,
): ReasoningDisplay {
  return (agentId ? preferences?.[agentId] : undefined) ?? adapterReasoningDisplay(adapterType);
}
