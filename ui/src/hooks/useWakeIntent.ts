import { useCallback, useEffect, useRef } from "react";
import { issuesApi } from "@/api/issues";

const TYPING_INTERVAL_MS = 60_000;
// Shared by every composer for a task, including across unmounts.
const lastTypingSent = new Map<string, number>();

function isVisible() {
  return typeof document !== "undefined" && document.visibilityState !== "hidden";
}

export function useWakeIntent(issueId: string | null | undefined, { enabled }: { enabled: boolean }) {
  const openedIssue = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !issueId) {
      openedIssue.current = null;
      return;
    }
    if (openedIssue.current !== issueId) openedIssue.current = null;
    const noteOpen = () => {
      if (!isVisible() || openedIssue.current === issueId) return;
      openedIssue.current = issueId;
      void issuesApi.wakeIntent(issueId, "open");
    };
    noteOpen();
    document.addEventListener("visibilitychange", noteOpen);
    return () => document.removeEventListener("visibilitychange", noteOpen);
  }, [issueId, enabled]);

  const noteTyping = useCallback(() => {
    if (!enabled || !issueId || !isVisible()) return;
    const now = Date.now();
    const previous = lastTypingSent.get(issueId);
    if (previous !== undefined && now - previous < TYPING_INTERVAL_MS) return;
    lastTypingSent.set(issueId, now);
    void issuesApi.wakeIntent(issueId, "typing");
  }, [issueId, enabled]);

  return { noteTyping };
}
