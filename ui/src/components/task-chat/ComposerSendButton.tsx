import { useEffect, useState } from "react";
import { ArrowUp, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  SEND_MODE_DESCRIPTION,
  SEND_MODE_LABEL,
  sendModeShortcut,
  isMacPlatform,
  type SendMode,
  type SubmitKey,
} from "./send-mode";

const PHONE_QUERY = "(max-width: 639px)";

function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return phone;
}

export interface ComposerSendButtonProps {
  /** The agent is working: the ▾ offers Steer, Queue and Interrupt. Idle shows a plain Send. */
  working: boolean;
  /** What a click does now: the default, or a pick that lasts for this one message. */
  mode: Exclude<SendMode, never>;
  defaultMode: Exclude<SendMode, "interrupt">;
  /** Why Steer is grey, or null when it is offered. */
  steerUnavailableReason: string | null;
  submitKey: SubmitKey;
  disabled: boolean;
  busy: boolean;
  title: string;
  onSend: () => void;
  onPick: (mode: SendMode) => void;
  streamlined?: boolean;
}

/**
 * The Send pill. The word on it is what a click does ("Send" for the default
 * Steer, or the picked mode). While the agent works, ▾ lists Steer, Queue and
 * Interrupt with their keys; on a phone ▾ is a 44 px segment opening a
 * bottom sheet with the same rows.
 */
export function ComposerSendButton({
  working,
  mode,
  defaultMode,
  steerUnavailableReason,
  submitKey,
  disabled,
  busy,
  title,
  onSend,
  onPick,
  streamlined = false,
}: ComposerSendButtonProps) {
  const phone = usePhoneLayout();
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMac = isMacPlatform();
  const label = mode === defaultMode ? (mode === "queue" && working ? "Queue" : "Send") : SEND_MODE_LABEL[mode];
  const pill = streamlined
    ? "bg-foreground text-background disabled:bg-foreground disabled:text-background disabled:opacity-100"
    : "bg-primary text-primary-foreground disabled:bg-muted disabled:text-muted-foreground";
  const modes: SendMode[] = ["steer", "queue", "interrupt"];
  const rows = modes.map((option) => {
    const unavailable = option === "steer" ? steerUnavailableReason : null;
    return {
      option,
      unavailable,
      shortcut: unavailable ? null : sendModeShortcut(option, submitKey, { isMac, defaultMode }),
    };
  });

  const sendButton = (
    <button
      type="button"
      onClick={onSend}
      disabled={disabled}
      title={title}
      aria-label={label}
      aria-busy={busy}
      data-testid="task-chat-composer-send"
      data-send-mode={mode}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 px-3 text-sm font-medium transition-colors max-sm:h-11",
        working ? "rounded-l-full" : "rounded-full",
        pill,
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
      <span>{label}</span>
    </button>
  );
  if (!working) return sendButton;

  const trigger = (
    <button
      type="button"
      aria-label="Send options"
      title="Choose how this message is sent"
      disabled={disabled && busy}
      data-testid="task-chat-composer-send-menu"
      onClick={phone ? () => setSheetOpen(true) : undefined}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-r-full transition-colors max-sm:h-11 max-sm:w-11",
        pill,
      )}
    >
      <ChevronDown className="h-4 w-4" aria-hidden />
    </button>
  );

  return (
    <div className="flex shrink-0 items-stretch gap-px" role="group" aria-label="Send">
      {sendButton}
      {phone ? (
        <>
          {trigger}
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="bottom" className="gap-0 rounded-t-2xl p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <SheetTitle className="px-3 pb-2 pt-1 text-sm font-medium text-muted-foreground">Send this message as</SheetTitle>
              {rows.map(({ option, unavailable }) => (
                <button
                  key={option}
                  type="button"
                  disabled={Boolean(unavailable)}
                  title={unavailable ?? undefined}
                  onClick={() => { setSheetOpen(false); onPick(option); }}
                  data-testid={`task-chat-send-mode-${option}`}
                  className="flex min-h-15 w-full flex-col items-start justify-center rounded-lg px-3 py-2 text-left hover:bg-accent disabled:opacity-50"
                >
                  <span className="text-sm font-medium">{SEND_MODE_LABEL[option]}{option === mode ? " ✓" : ""}</span>
                  <span className="text-xs text-muted-foreground">{unavailable ?? SEND_MODE_DESCRIPTION[option]}</span>
                </button>
              ))}
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">Send this message as</DropdownMenuLabel>
            {rows.map(({ option, unavailable, shortcut }) => (
              <DropdownMenuItem
                key={option}
                disabled={Boolean(unavailable)}
                onSelect={() => onPick(option)}
                title={unavailable ?? undefined}
                data-testid={`task-chat-send-mode-${option}`}
                className="flex items-start gap-3 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{SEND_MODE_LABEL[option]}{option === mode ? " ✓" : ""}</span>
                  <span className="text-xs text-muted-foreground">{unavailable ?? SEND_MODE_DESCRIPTION[option]}</span>
                </span>
                {shortcut ? <kbd className="shrink-0 pt-0.5 font-sans text-xs text-muted-foreground" data-testid={`task-chat-send-mode-key-${option}`}>{shortcut}</kbd> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
