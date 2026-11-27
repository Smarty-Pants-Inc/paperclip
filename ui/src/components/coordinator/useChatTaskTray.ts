import { createContext, useCallback, useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationTaskHandoff } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";

export type ChatTaskTrayItem = ConversationTaskHandoff;
export interface ChatTaskTrayScope {
  companyId: string;
  conversationIssueId: string;
  viewerUserId: string | null;
  sessionGeneration: number | null;
}
export const ChatTaskTrayMembershipContext = createContext<null | ((scope: ChatTaskTrayScope, ids: ReadonlySet<string> | null) => void)>(null);
/** Thread-local, ephemeral membership; no task records are passed to plugins. */
export function useChatTaskTrayMembership(companyId: string | null | undefined, conversationIssueId: string | null | undefined,
  viewerUserId: string | null | undefined) {
  const currentKey = JSON.stringify([companyId, conversationIssueId, viewerUserId]);
  const [membership, setMembership] = useState<{ key: string; ids: ReadonlySet<string> | null } | null>(null);
  const publish = useCallback((scope: ChatTaskTrayScope, ids: ReadonlySet<string> | null) => {
    const key = JSON.stringify([scope.companyId, scope.conversationIssueId, scope.viewerUserId]);
    setMembership(old => {
      if (old?.key === key && (old.ids === ids || (old.ids && ids && old.ids.size === ids.size
          && [...ids].every(id => old.ids!.has(id))))) return old;
      return { key, ids };
    });
  }, []);
  return { taskIds: membership?.key === currentKey ? membership.ids : null, publish };
}
const EMPTY_ITEMS: ChatTaskTrayItem[] = [];
const INDIRECT_EVENT_REFRESH_MS = 2_000;
export function chatTaskTrayScopeKey(scope: ChatTaskTrayScope) {
  return JSON.stringify([scope.companyId, scope.conversationIssueId, scope.viewerUserId, scope.sessionGeneration]);
}
/** Publish only a complete snapshot, never an interim/false count between pages. */
export async function loadChatTaskTray(issueId: string, signal: AbortSignal): Promise<ChatTaskTrayItem[]> {
  const items = new Map<string, ChatTaskTrayItem>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await issuesApi.listChatHandoffs(issueId, { view: "tray", limit: 100, cursor }, { signal });
    signal.throwIfAborted();
    for (const item of page.items) items.set(item.issueId, item);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Open task paging did not advance. Retry.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...items.values()];
}
export function useChatTaskTray(scope: ChatTaskTrayScope) {
  const client = useQueryClient();
  const scopeKey = chatTaskTrayScopeKey(scope);
  const instance = useId();
  const [activation, setActivation] = useState({ scopeKey, epoch: 0 });
  const current = activation.scopeKey === scopeKey ? activation : { scopeKey, epoch: activation.epoch + 1 };
  if (current !== activation) setActivation(current);
  const key = `${scopeKey}:${current.epoch}`;
  // An unsent chat's ephemeral key is not a persisted conversation issue.
  const enabled = !!scope.companyId && !!scope.conversationIssueId && !!scope.viewerUserId
    && !scope.conversationIssueId.startsWith("chat:");
  const queryKey = ["issues", "chat-handoffs", scope.conversationIssueId, scope.viewerUserId,
    "tray", scope.companyId, scope.sessionGeneration, instance, current.epoch];
  const query = useQuery({ queryKey, queryFn: ({ signal }) => loadChatTaskTray(scope.conversationIssueId, signal),
    enabled, retry: false, gcTime: 0 });
  const makeObservation = () => ({ key, ready: false, since: Date.now(), known: new Set<string>(),
    created: new Set<string>(), acceptanceAt: 0,
    events: new Set<number>(), refreshing: false, dirty: false,
    refreshTimer: null as ReturnType<typeof setTimeout> | null });
  const observed = useRef(makeObservation());
  if (observed.current.key !== key) observed.current = makeObservation();
  useEffect(() => {
    const state = observed.current;
    return () => {
      if (state.refreshTimer !== null) clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    };
  }, [key]);
  const [signal, setSignal] = useState(0);
  const [pulse, setPulse] = useState({ key, sequence: 0 });
  const items = query.data ?? EMPTY_ITEMS;
  useCompanyLiveEvent(event => {
    const state = observed.current;
    if (!enabled || state.key !== key || event.companyId !== scope.companyId) return;
    const payload = event.payload;
    const details = payload.details && typeof payload.details === "object" ? payload.details as Record<string, unknown> : {};
    const eventGeneration = details.conversationSessionGeneration ?? details.sessionGeneration;
    if (eventGeneration != null && eventGeneration !== scope.sessionGeneration) return;
    const fresh = Date.parse(event.createdAt) >= state.since;
    const accepted = event.type === "activity.logged" && payload.action === "issue.thread_interaction_accepted"
      && payload.entityType === "issue" && payload.entityId === scope.conversationIssueId;
    const created = event.type === "activity.logged" && payload.action === "issue.created"
      && payload.entityType === "issue" && typeof payload.entityId === "string";
    if (state.ready && fresh && (accepted || created) && !state.events.has(event.id)) {
      state.events.add(event.id);
      if (state.events.size > 256) state.events.delete(state.events.values().next().value!);
      if (accepted) state.acceptanceAt = Math.max(state.acceptanceAt, Date.parse(event.createdAt));
      if (created) {
        state.created.add(payload.entityId as string);
        if (state.created.size > 256) state.created.delete(state.created.values().next().value!);
      }
      setSignal(value => value + 1);
    }
    const ids = new Set(items.map(item => item.issueId));
    const lifecycle = event.type === "heartbeat.run.status" || event.type === "heartbeat.run.queued";
    const affectedIds = [payload.issueId, payload.entityType === "issue" ? payload.entityId : null,
      details.issueId, details.parentId, details.relatedIssueId, details.blockedIssueId];
    const relevantTask = affectedIds.some(id => typeof id === "string" && ids.has(id));
    const relevantOwner = event.type === "agent.status" && items.some(item => item.assigneeAgentId === payload.agentId);
    const refresh = () => {
      if (observed.current !== state) return;
      state.dirty = true;
      if (state.refreshing) return;
      state.refreshing = true;
      void (async () => {
        try {
          do {
            state.dirty = false;
            const fetching = client.isFetching({ queryKey, exact: true }) > 0;
            await client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
            if (fetching) state.dirty = true;
          } while (state.dirty && observed.current === state);
        } finally {
          state.refreshing = false;
          if (observed.current === state) setSignal(value => value + 1);
        }
      })().catch(() => undefined);
    };
    if (accepted || relevantOwner || ((lifecycle || event.type === "activity.logged") && relevantTask)) {
      refresh();
    } else if ((lifecycle || event.type === "agent.status") && state.refreshTimer === null) {
      // The authorized tray snapshot need not expose a blocker's identity or owner.
      // Coalesce company run/owner events into one trailing exact-query read per
      // window. Do not reset the deadline on bursts, or poll when events stop.
      state.refreshTimer = setTimeout(() => {
        state.refreshTimer = null;
        refresh();
      }, INDIRECT_EVENT_REFRESH_MS);
    }
  });
  useEffect(() => {
    if (!enabled || !query.data || query.isFetching || query.isError) return;
    const state = observed.current;
    if (state.refreshing || client.getQueryState(queryKey)?.fetchStatus === "fetching") return;
    const open = query.data.filter(item => item.status !== "done" && item.status !== "cancelled");
    const added = state.ready ? open.filter(item => !state.known.has(item.issueId)
      && Date.parse(item.createdAt) >= state.since
      && (state.created.has(item.issueId) || (item.suggestionInteractionId && Date.parse(item.createdAt) <= state.acceptanceAt))).length : 0;
    for (const item of query.data) state.known.add(item.issueId);
    state.ready = true;
    // A signal belongs to this completed authorized read, not future discoveries.
    state.acceptanceAt = 0;
    state.created.clear();
    if (added) setPulse(old => ({ key, sequence: (old.key === key ? old.sequence : 0) + added }));
  }, [enabled, key, query.data, query.isFetching, query.isError, signal]);
  const accessUnavailable = query.error && "status" in query.error && [401, 403, 404].includes(Number(query.error.status));
  // The owner-only endpoint returns 404 when this viewer has no conversation tray.
  // Do not present that absence as a failed task status, or hide real read errors.
  const available = enabled && !(query.error && "status" in query.error && Number(query.error.status) === 404);
  return {
    items: available && !accessUnavailable ? items : EMPTY_ITEMS,
    loading: available && !query.data && !query.isError,
    stale: available && query.isError,
    enabled: available, retry: () => { void query.refetch(); },
    newTaskSequence: available && pulse.key === key ? pulse.sequence : 0,
  };
}
