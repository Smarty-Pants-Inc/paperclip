import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { QueryClient, QueryClientContext } from "@tanstack/react-query";
import { findUIAdapter } from "@/adapters/registry";
import { useResolvedViewerId } from "@/hooks/useResolvedViewerId";

export type ReasoningDisplay = "inline" | "folded";
const changeEvent = "paperclip:reasoning-display";
const volatilePreferences = new Map<string, ReasoningDisplay>();
let detachedClient: QueryClient | undefined;
const InlineReasoningContext = createContext(false);
export const useInlineReasoning = () => useContext(InlineReasoningContext);

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key) volatilePreferences.delete(event.key);
    else volatilePreferences.clear();
    notify();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changeEvent, notify);
  };
}

/** Presentation only: one viewer's browser choice never changes agent config. */
export function useReasoningDisplay(adapterType?: string) {
  const contextClient = useContext(QueryClientContext);
  const client = contextClient ?? (detachedClient ??= new QueryClient());
  const { userId } = useResolvedViewerId({ client, enabled: Boolean(contextClient) });
  const key = userId ? `paperclip.reasoning-display.${userId}` : null;
  const preference = useSyncExternalStore(subscribe, () => {
    if (!key) return null;
    const volatile = volatilePreferences.get(key);
    if (volatile) return volatile;
    try {
      const value = window.localStorage.getItem(key);
      if (value === "inline" || value === "folded") return value;
    } catch { /* Storage can be denied; the current page still works. */ }
    return volatilePreferences.get(key) ?? null;
  }, () => null);
  const supported = Boolean(adapterType && findUIAdapter(adapterType)?.transcriptPresentation?.liveReasoningView === "inline");
  return {
    supported,
    display: supported ? preference ?? "inline" : "folded",
    canSave: Boolean(key),
    setDisplay(display: ReasoningDisplay) {
      if (!key) return;
      volatilePreferences.set(key, display);
      try { window.localStorage.setItem(key, display); } catch { /* Keep the in-page choice. */ }
      window.dispatchEvent(new Event(changeEvent));
    },
  };
}

export function RunnerReasoningDisplay({ children }: { children: ReactNode }) {
  const { display } = useReasoningDisplay("paperclip_runner");
  return <InlineReasoningContext.Provider value={display === "inline"}>{children}</InlineReasoningContext.Provider>;
}
