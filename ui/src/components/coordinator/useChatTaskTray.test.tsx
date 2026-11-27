// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { useChatTaskTray, type ChatTaskTrayScope, type ChatTaskTrayItem } from "./useChatTaskTray";
import { __liveUpdatesTestUtils, type CompanyLiveEventHandler } from "@/context/LiveUpdatesProvider";
import type { LiveEvent } from "@paperclipai/shared";
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { listChatHandoffs: api.list } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const scope: ChatTaskTrayScope = { companyId: "company", conversationIssueId: "chat", viewerUserId: "viewer", sessionGeneration: 1 };
const item = (n: number): ChatTaskTrayItem => ({ id: `handoff-${n}`, issueId: `task-${n}`, identifier: `TEST-${n}`,
  title: `Task ${n}`, status: "todo", createdAt: new Date().toISOString(), sourceRunId: null, suggestionInteractionId: null });
let root: Root, host: HTMLDivElement, client: QueryClient;
let result: ReturnType<typeof useChatTaskTray>;
function Consumer({ value }: { value: ChatTaskTrayScope }) { result = useChatTaskTray(value); return <span>{result.items.length}</span>; }
const subscribers = new Set<CompanyLiveEventHandler>();
const subscription = { companyId: scope.companyId, subscribe(handler: CompanyLiveEventHandler) {
  subscribers.add(handler); return () => { subscribers.delete(handler); };
} };
const SubscriptionContext = __liveUpdatesTestUtils.LiveEventSubscriptionContext;
const paint = (value = scope) => act(() => root.render(<QueryClientProvider client={client}>
  <SubscriptionContext.Provider value={subscription}><Consumer value={value} /></SubscriptionContext.Provider>
</QueryClientProvider>));
let eventId = 0;
const gate = () => ({ cooldownHits: new Map<string, number[]>(), suppressUntil: 0, observedRunOutcomes: new Set<string>() });
const live = (type: LiveEvent["type"], payload: LiveEvent["payload"], overrides: Partial<LiveEvent> = {}) => act(() => {
  const event = { id: ++eventId, type, companyId: scope.companyId, payload, createdAt: new Date().toISOString(), ...overrides };
  __liveUpdatesTestUtils.handleLiveEvent(client, scope.companyId, "/TEST/issues/chat", event, () => null, gate(), { userId: scope.viewerUserId, agentId: null });
  __liveUpdatesTestUtils.dispatchLiveEventToSubscribers(subscribers, scope.companyId, event);
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const refresh = () => act(async () => { await client.invalidateQueries({ queryKey: ["issues", "chat-handoffs"] }); });
beforeEach(() => {
  api.list.mockReset(); eventId = 0; subscribers.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(() => root.unmount()); client.clear(); host.remove(); });
describe("open chat task snapshot", () => {
  it("does not read an unpersisted draft chat or expose a loading/error tray", async () => {
    api.list.mockRejectedValue(Object.assign(new Error("Conversation not found"), { status: 404 }));
    await paint({ ...scope, conversationIssueId: "chat:agent" }); await settle();
    expect(result.enabled).toBe(false);
    expect(result.loading).toBe(false); expect(result.stale).toBe(false);
    expect(result.items).toEqual([]);
    expect(api.list).not.toHaveBeenCalled();
    api.list.mockResolvedValue({ items: [item(1)], nextCursor: null });
    await paint(); await settle();
    expect(result.enabled).toBe(true); expect(result.items.map(row => row.issueId)).toEqual(["task-1"]);
    await paint({ ...scope, conversationIssueId: "chat:agent" }); await settle();
    expect(result.enabled).toBe(false); expect(result.items).toEqual([]);
    expect(result.loading).toBe(false); expect(result.stale).toBe(false);
  });
  it.each([false, true])("has no tray for a missing or another viewer's real conversation (cached tasks: %s)", async cachedTasks => {
    if (cachedTasks) {
      api.list.mockResolvedValue({ items: [item(1)], nextCursor: null });
      await paint(); await settle(); expect(result.items).toHaveLength(1);
    }
    api.list.mockRejectedValue(Object.assign(new Error("Conversation not found"), { status: 404 }));
    if (cachedTasks) { await refresh(); } else { await paint(); }
    await settle();
    expect(result.items).toEqual([]); expect(result.enabled).toBe(false);
    expect(result.loading).toBe(false); expect(result.stale).toBe(false);
  });
  it.each([401, 403, 500, null])("keeps real read errors actionable, rather than treating them as empty (%s)", async status => {
    api.list.mockRejectedValue(Object.assign(new Error("Read failed"), status === null ? {} : { status }));
    await paint(); await settle();
    expect(result.enabled).toBe(true); expect(result.stale).toBe(true); expect(result.loading).toBe(false);
    api.list.mockResolvedValue({ items: [item(1)], nextCursor: null });
    await act(() => result.retry()); await settle();
    expect(result.stale).toBe(false); expect(result.items.map(row => row.issueId)).toEqual(["task-1"]);
  });
  it("keeps a successful empty real conversation healthy, but exposes a real read failure and Retry", async () => {
    api.list.mockResolvedValue({ items: [], nextCursor: null });
    await paint(); await settle();
    expect(result.enabled).toBe(true); expect(result.items).toEqual([]);
    expect(result.loading).toBe(false); expect(result.stale).toBe(false);
    api.list.mockRejectedValue(Object.assign(new Error("Unavailable"), { status: 500 }));
    await refresh(); await settle();
    expect(result.loading).toBe(false); expect(result.stale).toBe(true);
    api.list.mockResolvedValue({ items: [item(1)], nextCursor: null });
    await act(() => result.retry()); await settle();
    expect(result.stale).toBe(false); expect(result.items.map(row => row.issueId)).toEqual(["task-1"]);
  });
  it.each([false, true])("reverts a cancelled mid-page refresh without a false unavailable state (has tasks: %s)", async hasTasks => {
    const items = hasTasks ? [item(1)] : [];
    api.list.mockResolvedValue({ items, nextCursor: null });
    await paint(); await settle();
    let pendingSignal: AbortSignal | undefined;
    api.list.mockImplementation((_id, filters, { signal }) => filters.cursor
      ? new Promise((_resolve, reject) => {
        pendingSignal = signal;
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }) : Promise.resolve({ items: [item(2)], nextCursor: "next" }));
    await live("heartbeat.run.status", { issueId: "task-1", runId: "run-1", status: "succeeded" });
    // Empty trays have no relevant task ID, so start their equivalent refetch explicitly.
    if (!hasTasks) await act(() => { void client.invalidateQueries({ queryKey: ["issues", "chat-handoffs"] }); });
    await settle(); expect(pendingSignal).toBeDefined();
    await act(async () => { await client.cancelQueries({ queryKey: ["issues", "chat-handoffs"] }); });
    await settle();
    expect(pendingSignal!.aborted).toBe(true);
    expect(result.items).toEqual(items); expect(result.loading).toBe(false); expect(result.stale).toBe(false);
  });
  it("drains 205 tasks atomically, uses tray/100, dedupes task id and does not shimmer on load or paging", async () => {
    let release!: (value: unknown) => void;
    api.list.mockImplementation((_id, filters) => filters.cursor === "page-3"
      ? new Promise(resolve => { release = resolve; })
      : Promise.resolve(filters.cursor ? { items: Array.from({ length: 100 }, (_, i) => item(i + 100)), nextCursor: "page-3" }
        : { items: Array.from({ length: 100 }, (_, i) => item(i)), nextCursor: "page-2" }));
    await paint(); await settle();
    expect(result.loading).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.newTaskSequence).toBe(0);
    await act(() => release({ items: [item(200), item(201), item(202), item(203), item(204), { ...item(1), id: "other-receipt" }], nextCursor: null }));
    await settle();
    expect(result.items).toHaveLength(205);
    expect(result.loading).toBe(false);
    expect(api.list.mock.calls.map(call => call[1])).toEqual([
      { view: "tray", limit: 100, cursor: null }, { view: "tray", limit: 100, cursor: "page-2" }, { view: "tray", limit: 100, cursor: "page-3" },
    ]);
    expect(result.newTaskSequence).toBe(0);
  });
  it.each([
    { viewerUserId: "other" }, { companyId: "other" }, { conversationIssueId: "other" }, { sessionGeneration: 2 },
  ])("clears synchronously on scope change %j and ignores late old data", async patch => {
    api.list.mockResolvedValueOnce({ items: [item(1)], nextCursor: null });
    await paint(); await settle(); expect(result.items).toHaveLength(1);
    let release!: (value: unknown) => void;
    api.list.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await paint({ ...scope, ...patch });
    expect(result.items).toEqual([]); expect(result.loading).toBe(true); expect(result.newTaskSequence).toBe(0);
    await act(() => release({ items: [item(2)], nextCursor: null })); await settle();
    expect(result.items.map(row => row.issueId)).toEqual(["task-2"]);
    await paint(scope);
    expect(result.items).toEqual([]); // Returning does not reveal the previous private cache.
  });
  it("retains the last full snapshot on page failure and retries without publishing a partial count", async () => {
    api.list.mockResolvedValue({ items: [item(1)], nextCursor: null });
    await paint(); await settle();
    api.list.mockImplementation((_id, filters) => filters.cursor
      ? Promise.reject(new Error("unavailable")) : Promise.resolve({ items: [item(2)], nextCursor: "next" }));
    await refresh(); await settle();
    expect(result.stale).toBe(true);
    expect(result.items.map(row => row.issueId)).toEqual(["task-1"]);
    api.list.mockResolvedValue({ items: [item(2)], nextCursor: null });
    await act(() => result.retry()); await settle();
    expect(result.stale).toBe(false); expect(result.items.map(row => row.issueId)).toEqual(["task-2"]);
  });
  it("shimmers only for a genuinely new live creation after load, once, not discoveries during refetch or replays", async () => {
    let items = [item(1)];
    api.list.mockImplementation(async () => ({ items, nextCursor: null }));
    await paint(); await settle();
    items = [...items, { ...item(2), createdAt: new Date(0).toISOString() }]; await refresh(); await settle();
    expect(result.newTaskSequence).toBe(0);
    items = [...items, item(3)]; await refresh(); await settle();
    expect(result.newTaskSequence).toBe(0); // A recent discovery alone is not a creation signal.
    items = [...items, item(4)];
    await live("activity.logged", { action: "issue.created", entityType: "issue", entityId: "task-4" }); await settle();
    expect(result.newTaskSequence).toBe(1);
    await refresh(); await settle();
    expect(result.newTaskSequence).toBe(1);
    items = items.filter(task => task.issueId !== "task-4"); await refresh(); await settle();
    items = [...items, item(4)]; await refresh(); await settle();
    expect(result.newTaskSequence).toBe(1);
  });
  it("shimmers once when suggestion acceptance adds a new open task without issue.created", async () => {
    let items = [item(1)];
    api.list.mockImplementation(async () => ({ items, nextCursor: null }));
    await paint(); await settle();
    items = [...items, { ...item(2), suggestionInteractionId: "accepted-2" }];
    // The real producer uses the conversation as entityId. Signed-in details may be omitted.
    const accepted = { action: "issue.thread_interaction_accepted", entityType: "issue", entityId: "chat" };
    await live("activity.logged", accepted); await settle();
    expect(result.newTaskSequence).toBe(1);
    await live("activity.logged", accepted, { id: eventId }); await settle();
    await refresh(); await settle();
    expect(result.newTaskSequence).toBe(1);
  });
  it("does not shimmer when a creation event arrives during the initial full load", async () => {
    let release!: (value: unknown) => void;
    api.list.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await paint();
    await live("activity.logged", { action: "issue.thread_interaction_accepted", entityType: "issue", entityId: "chat" });
    await act(() => release({ items: [{ ...item(1), suggestionInteractionId: "initial" }], nextCursor: null })); await settle();
    expect(result.newTaskSequence).toBe(0);
  });
  it("refreshes run-only start/end and owner changes through the real live dispatcher, without polling", async () => {
    let items: ChatTaskTrayItem[] = [{ ...item(1), assigneeAgentId: "agent-1", status: "in_progress", displayStatus: "todo" }];
    api.list.mockImplementation(async () => ({ items, nextCursor: null }));
    await paint(); await settle();
    const initial = api.list.mock.calls.length;
    await live("heartbeat.run.status", { issueId: "other-task", agentId: "other-agent", runId: "other-run", status: "running" });
    await live("heartbeat.run.progress", { issueId: "task-1", runId: "run-1", status: "running" });
    await live("heartbeat.run.status", { issueId: "task-1", runId: "run-1", status: "running" }, { companyId: "other-company" });
    await settle(); expect(api.list).toHaveBeenCalledTimes(initial);
    items = [{ ...items[0], displayStatus: "in_progress" }];
    await live("heartbeat.run.status", { issueId: "task-1", agentId: "agent-1", runId: "run-1", status: "running" }); await settle();
    expect(result.items[0].displayStatus).toBe("in_progress");
    expect(api.list.mock.calls.length).toBeGreaterThan(initial);
    items = [{ ...items[0], displayStatus: "todo" }];
    await live("heartbeat.run.status", { issueId: "task-1", agentId: "agent-1", runId: "run-1", status: "succeeded" }); await settle();
    expect(result.items[0].displayStatus).toBe("todo");
    const afterRun = api.list.mock.calls.length;
    await live("agent.status", { agentId: "agent-1", status: "paused" }); await settle();
    expect(api.list.mock.calls.length).toBeGreaterThan(afterRun);
    const afterOwner = api.list.mock.calls.length;
    items = [{ ...items[0], status: "blocked", blockerAttention: { state: "covered", reason: "active_child",
      unresolvedBlockerCount: 1, coveredBlockerCount: 1, attentionBlockerCount: 0, stalledBlockerCount: 0,
      sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null } }];
    await live("activity.logged", { action: "issue.blockers_updated", entityType: "issue", entityId: "task-1",
      details: { addedBlockedByIssueIds: ["child-1"] } }); await settle();
    expect(result.items[0].blockerAttention?.unresolvedBlockerCount).toBe(1);
    expect(api.list.mock.calls.length).toBeGreaterThan(afterOwner);
    const afterBlocker = api.list.mock.calls.length;
    await settle(); expect(api.list).toHaveBeenCalledTimes(afterBlocker); // No timer/refetch loop.
  });
  it("coalesces an event burst and performs a trailing read when the current read was already in flight", async () => {
    api.list.mockResolvedValue({ items: [item(1)], nextCursor: null });
    await paint(); await settle();
    let release!: (value: unknown) => void;
    api.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await live("heartbeat.run.status", { issueId: "task-1", runId: "run-1", status: "running" });
    for (let n = 0; n < 12; n++) await live("heartbeat.run.status", { issueId: "task-1", runId: "run-1", status: "succeeded" });
    expect(release, "run status starts a tray read").toBeTypeOf("function");
    await act(() => release({ items: [item(1)], nextCursor: null })); await settle();
    expect(api.list).toHaveBeenCalledTimes(3); // Initial + in-flight + one trailing read, not 13.
  });
  it("excludes other chats, old events and old sessions even when fresh result IDs become readable", async () => {
    let items = [item(1)];
    api.list.mockImplementation(async () => ({ items, nextCursor: null }));
    await paint(); await settle();
    items = [...items, { ...item(2), suggestionInteractionId: "suggestion-2" }];
    const accepted = { action: "issue.thread_interaction_accepted", entityType: "issue", entityId: "chat" };
    await live("activity.logged", { ...accepted, entityId: "other-chat" }); await settle();
    await live("activity.logged", accepted, { createdAt: new Date(0).toISOString() }); await settle();
    await live("activity.logged", { ...accepted, details: { conversationSessionGeneration: 0 } }); await settle();
    await refresh(); await settle(); expect(result.newTaskSequence).toBe(0);
    items = [...items, { ...item(3), suggestionInteractionId: "suggestion-3" }];
    await live("activity.logged", accepted); await settle(); expect(result.newTaskSequence).toBe(1);
  });
  it("does not reuse an acceptance signal for a later permission/refetch discovery", async () => {
    let items = [item(1)];
    const hidden = { ...item(2), suggestionInteractionId: "unreadable-at-acceptance" };
    api.list.mockImplementation(async () => ({ items, nextCursor: null }));
    await paint(); await settle();
    await live("activity.logged", { action: "issue.thread_interaction_accepted", entityType: "issue", entityId: "chat" }); await settle();
    expect(result.newTaskSequence).toBe(0);
    items = [...items, hidden]; await refresh(); await settle();
    expect(result.newTaskSequence).toBe(0);
    items = [...items, { ...item(3), suggestionInteractionId: "fresh-acceptance" }];
    await live("activity.logged", { action: "issue.thread_interaction_accepted", entityType: "issue", entityId: "chat" }); await settle();
    expect(result.newTaskSequence).toBe(1);
  });
  it("clears revoked data and fails a repeated cursor rather than looping", async () => {
    api.list.mockResolvedValue({ items: [item(1)], nextCursor: null });
    await paint(); await settle();
    api.list.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await refresh(); await settle(); expect(result.items).toEqual([]); expect(result.stale).toBe(true);
    api.list.mockResolvedValue({ items: [item(1)], nextCursor: "same" });
    await act(() => result.retry()); await settle();
    expect(result.stale).toBe(true);
  });
});
