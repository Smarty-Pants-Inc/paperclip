import { useId, type KeyboardEvent } from "react";
import type { Agent, ReasoningDisplay } from "@paperclipai/shared";
import { AgentPanel } from "@/components/agent-detail/AgentPanels";
import { adapterReasoningDisplay } from "@/components/task-chat/reasoning-display";
import { useOptionalToastActions } from "@/context/ToastContext";
import { useAgentReasoningDisplay } from "@/hooks/useAgentReasoningDisplay";
import { cn } from "@/lib/utils";

const OPTIONS: ReadonlyArray<{ value: ReasoningDisplay; label: string }> = [
  { value: "fold", label: "Folded" },
  { value: "inline", label: "Inline" },
];
const LABELS: Record<ReasoningDisplay, string> = { fold: "Folded", inline: "Inline" };

/**
 * The one place a person chooses how this agent's reasoning shows in chat.
 * Saved as the person's own preference on the server (keyed by agent), so it
 * applies to every chat with this agent on every browser and device. It is
 * never written to the agent, so it is not a configuration change and starts
 * no fresh thread.
 */
export function AgentReasoningDisplaySetting({ agent, className }: {
  agent: Pick<Agent, "id" | "companyId" | "adapterType">;
  className?: string;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const toast = useOptionalToastActions();
  const { display, loaded, isSaving, error, setDisplay } = useAgentReasoningDisplay(agent.id);
  const harnessDefault = adapterReasoningDisplay(agent.adapterType);
  const current = display ?? harnessDefault;

  const choose = (next: ReasoningDisplay) => {
    if (next === current && display !== null) return;
    setDisplay(agent.companyId, next).catch((cause: unknown) => {
      toast?.pushToast({
        title: "Couldn’t save reasoning display",
        body: cause instanceof Error ? cause.message : undefined,
        tone: "error",
      });
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = current === "fold" ? "inline" : "fold";
    choose(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus();
  };

  return (
    <AgentPanel title="Display" aria-label="Display" data-testid="agent-display-settings" className={className}>
      <div className="flex flex-col gap-3 px-(--agent-detail-module-inset) pb-(--agent-detail-module-inset) sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 space-y-1">
          <div id={labelId} className="text-sm text-foreground">Reasoning display</div>
          <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">
            How this agent’s reasoning shows in your chats with it, on every device. Only your view changes, not
            the agent. Default for this harness: {LABELS[harnessDefault]}.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          aria-busy={!loaded}
          onKeyDown={onKeyDown}
          className="inline-flex shrink-0 self-start rounded-md border border-border bg-background p-0.5 sm:self-auto"
          data-testid="agent-reasoning-display"
        >
          {OPTIONS.map(({ value, label }) => {
            const selected = current === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                data-value={value}
                disabled={!loaded || isSaving}
                onClick={() => choose(value)}
                className={cn(
                  "min-h-9 min-w-20 rounded-[5px] px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                  selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-(--agent-detail-module-inset) pb-(--agent-detail-module-inset) text-xs text-destructive">
          Couldn’t load or save your reasoning display. {error instanceof Error ? error.message : ""}
        </p>
      ) : null}
    </AgentPanel>
  );
}
