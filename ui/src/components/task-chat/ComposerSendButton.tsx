import { useEffect, useState } from "react";
import { Check, ChevronDown, CornerDownRight, ListEnd, Loader2, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  SEND_MODE_DESCRIPTION,
  SEND_MODE_LABEL,
  sendModeShortcut,
  isMacPlatform,
  type SendMode,
  type SubmitKey,
} from "./send-mode";

const PHONE_QUERY = "(max-width: 639px)";
const MODE_ICON = { steer: CornerDownRight, queue: ListEnd, interrupt: Zap };

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
  const SendIcon = MODE_ICON[mode];
  const modes: SendMode[] = ["steer", "queue", "interrupt"];
  const rows = modes.map((option) => {
    const unavailable = option === "steer" ? steerUnavailableReason : null;
    return {
      option,
      Icon: MODE_ICON[option],
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
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SendIcon className="h-4 w-4" aria-hidden />}
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
            <SheetContent side="bottom" showCloseButton={false} className="gap-0 rounded-t-2xl p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <div className="flex min-h-11 items-center justify-between">
                <SheetTitle className="px-3 text-sm font-medium text-muted-foreground">Send this message as</SheetTitle>
                <SheetClose aria-label="Close send modes" className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                  <X className="size-4" aria-hidden />
                </SheetClose>
              </div>
              {rows.map(({ option, Icon, unavailable }) => (
                <button
                  key={option}
                  type="button"
                  disabled={Boolean(unavailable)}
                  title={unavailable ?? undefined}
                  onClick={() => { setSheetOpen(false); onPick(option); }}
                  data-testid={`task-chat-send-mode-${option}`}
                  className={cn("flex min-h-15 w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-accent disabled:opacity-50", option === mode && "bg-accent")}
                >
                  <span className="flex h-5 w-4 shrink-0 items-center">{option === mode ? <Check className="size-3.5" aria-hidden /> : null}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4 shrink-0" aria-hidden />{SEND_MODE_LABEL[option]}</span>
                    <span className="text-xs text-foreground/70">{unavailable ?? SEND_MODE_DESCRIPTION[option]}</span>
                  </span>
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
            {rows.map(({ option, Icon, unavailable, shortcut }) => (
              <DropdownMenuItem
                key={option}
                disabled={Boolean(unavailable)}
                onSelect={() => onPick(option)}
                title={unavailable ?? undefined}
                data-testid={`task-chat-send-mode-${option}`}
                className={cn("grid grid-cols-[auto_1fr_auto] items-start gap-x-2 gap-y-0.5 py-2", option === mode && "bg-accent")}
              >
                <span className="flex h-5 w-4 items-center">{option === mode ? <Check className="size-3.5" aria-hidden /> : null}</span>
                <span className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4 shrink-0" aria-hidden />{SEND_MODE_LABEL[option]}</span>
                {shortcut ? <kbd className="pt-0.5 font-sans text-xs text-foreground/70" data-testid={`task-chat-send-mode-key-${option}`}>{shortcut}</kbd> : <span />}
                <span className="col-span-2 col-start-2 text-xs text-foreground/70">{unavailable ?? SEND_MODE_DESCRIPTION[option]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
