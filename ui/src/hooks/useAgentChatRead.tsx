import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isUuidLike } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { isScrolledToEnd, PIN_THRESHOLD_PX } from "@/components/task-chat/scroll-anchor";

type Seen = { id: string; at: number };
const READ_RETRY_DELAYS = [500, 1_500];
const ChatReadContext = createContext<((message: Seen) => void) | null>(null);

export function AgentChatReadProvider({ issueId, companyId, userId, children }: {
  issueId?: string; companyId: string; userId: string | null; children: ReactNode;
}) {
  const client = useQueryClient();
  const [error, setError] = useState(false);
  // `pending` holds every distinct seen id in the newest seen millisecond. Comment
  // times carry microseconds the client cannot see, so ids sharing a millisecond
  // are all sent and the server keeps the greatest exact cutoff.
  const scope = useMemo(() => ({ active: true, pending: [] as Seen[], seenIds: new Set<string>(), sentAt: -Infinity,
    busy: false, failures: 0, exhausted: false, retryTimer: null as ReturnType<typeof setTimeout> | null }), [issueId, companyId, userId]);
  const flush = useCallback(async function flush(): Promise<void> {
    if (!issueId || !scope.active || scope.busy || scope.retryTimer !== null || scope.exhausted) return;
    scope.busy = true;
    try {
      while (scope.active && scope.pending.length > 0) {
        const next = scope.pending[0];
        try {
          await issuesApi.markRead(issueId, next.id);
        } catch (cause) {
          if (!scope.active) return;
          const retryable = !(cause instanceof ApiError) || cause.status === 408 || cause.status === 429 || cause.status >= 500;
          const delay = READ_RETRY_DELAYS[scope.failures];
          if (retryable && delay !== undefined) {
            scope.failures += 1;
            scope.retryTimer = setTimeout(() => { scope.retryTimer = null; void flush(); },
              Math.max(delay, cause instanceof ApiError ? cause.retryAfterMs ?? 0 : 0));
          } else {
            scope.exhausted = true;
            setError(true);
          }
          return;
        }
        if (!scope.active) return;
        scope.pending = scope.pending.filter(item => item.id !== next.id);
        scope.sentAt = Math.max(scope.sentAt, next.at);
        scope.failures = 0;
        setError(false);
        // A GET that started before this write carries the old unread count. Cancel
        // it (its signal aborts the request) so the refetch reads after the write.
        for (const queryKey of [queryKeys.agentChats.list(companyId, userId), ["agent-chat", companyId, userId]]) {
          void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
        }
      }
    } finally { scope.busy = false; }
  }, [issueId, companyId, userId, client, scope]);
  useEffect(() => {
    scope.active = true;
    setError(false);
    if (scope.pending.length > 0) {
      scope.exhausted = false;
      scope.failures = 0;
      queueMicrotask(() => { void flush(); });
    }
    return () => {
      scope.active = false;
      if (scope.retryTimer !== null) { clearTimeout(scope.retryTimer); scope.retryTimer = null; }
    };
  }, [scope, flush]);
  useEffect(() => {
    const retry = () => {
      if (document.visibilityState !== "visible" || !scope.active || !scope.exhausted || scope.pending.length === 0) return;
      scope.exhausted = false;
      scope.failures = 0;
      setError(false);
      void flush();
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [scope, flush]);
  const seen = useCallback((message: Seen) => {
    if (!issueId || !scope.active || scope.seenIds.has(message.id) || message.at < scope.sentAt) return;
    scope.seenIds.add(message.id);
    const newest = scope.pending[0]?.at ?? -Infinity;
    if (message.at > newest) scope.pending = [message];
    else if (message.at === newest) scope.pending.push(message);
    if (scope.exhausted) { scope.exhausted = false; scope.failures = 0; setError(false); }
    if (!scope.busy && scope.retryTimer === null) queueMicrotask(() => { void flush(); });
  }, [issueId, scope, flush]);
  return <ChatReadContext.Provider value={issueId ? seen : null}>
    {error && <p role="alert" className="text-sm text-destructive">Couldn’t mark this chat read.</p>}
    {children}
  </ChatReadContext.Provider>;
}

export function useAgentChatRead(id: string, createdAt: string | undefined, enabled: boolean) {
  const seen = useContext(ChatReadContext);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!seen || !enabled || !element || !isUuidLike(id) || !createdAt) return;
    const at = new Date(createdAt).getTime();
    if (!Number.isFinite(at)) return;
    const viewport = element.closest<HTMLElement>(".task-chat-scroll-viewport");
    const check = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus() || !viewport) return;
      // The scroller's own "at the end" policy: what it follows is what the person has read.
      if (!isScrolledToEnd(viewport)) return;
      const message = element.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
      if (message.height > 0 && message.bottom <= bounds.bottom + PIN_THRESHOLD_PX && message.bottom > bounds.top) seen({ id, at });
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(check, { root: viewport });
    observer?.observe(element);
    // A layout change (window, composer, keyboard) can bring the end into view without a scroll.
    const resize = typeof ResizeObserver === "undefined" || !viewport ? null : new ResizeObserver(check);
    resize?.observe(viewport!);
    window.addEventListener("resize", check);
    viewport?.addEventListener("scroll", check, { passive: true });
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    const frame = requestAnimationFrame(check);
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect(); resize?.disconnect();
      window.removeEventListener("resize", check);
      viewport?.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check);
    };
  }, [seen, id, createdAt, enabled]);
  return ref;
}
