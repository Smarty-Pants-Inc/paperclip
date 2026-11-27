// @vitest-environment jsdom
// Regression from the final-review probes: dependencies can be absent from the
// authorized handoff snapshot. Exercise the real company live-event dispatcher.
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
const attention = (covered: boolean) => ({
  state: covered ? "covered" as const : "needs_attention" as const,
  reason: covered ? "active_child" as const : "attention_required" as const,
  unresolvedBlockerCount: 1, coveredBlockerCount: covered ? 1 : 0,
  attentionBlockerCount: covered ? 0 : 1, stalledBlockerCount: 0,
  // Neither a blocker id nor a title is required by the client.
  sampleBlockerIdentifier: null, sampleStalledBlockerIdentifier: null,
});
const parent = (covered: boolean): ChatTaskTrayItem => ({
  id: "handoff-parent", issueId: "parent", identifier: "TEST-1", title: "Parent",
  status: "blocked", createdAt: new Date(0).toISOString(), sourceRunId: null,
  suggestionInteractionId: null, unblockDescriptor: null, assigneeAgentId: "parent-owner",
  blockerAttention: attention(covered),
});
let root: Root, host: HTMLDivElement, client: QueryClient;
let result: ReturnType<typeof useChatTaskTray>;
let items: ChatTaskTrayItem[];
function Consumer({ value }: { value: ChatTaskTrayScope }) { result = useChatTaskTray(value); return <span>{result.items[0]?.blockerAttention?.reason}</span>; }
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
const advance = (ms = 10) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
beforeEach(() => {
  vi.useFakeTimers(); api.list.mockReset(); eventId = 0; subscribers.clear();
  items = [parent(true)]; api.list.mockImplementation(async () => ({ items, nextCursor: null }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(() => root.unmount()); client.clear(); host.remove(); vi.useRealTimers(); });

describe("non-handoff dependency live freshness", () => {
  it("refreshes the parent when only its non-handoff blocker completes a run", async () => {
    await paint(); await advance();
    expect(host.textContent).toBe("active_child");
    items = [parent(false)];
    await live("heartbeat.run.status", { issueId: "child", agentId: "child-owner", runId: "child-run", status: "succeeded" });
    await advance(2_010);
    expect(host.textContent).toBe("attention_required");
    expect(result.items.map(item => item.issueId)).toEqual(["parent"]);
    expect(result.newTaskSequence).toBe(0);
  });
  it("refreshes the parent when only its non-handoff blocker starts a run", async () => {
    items = [parent(false)]; await paint(); await advance();
    expect(host.textContent).toBe("attention_required");
    items = [parent(true)];
    await live("heartbeat.run.status", { issueId: "child", agentId: "child-owner", runId: "child-run", status: "running" });
    await advance(2_010);
    expect(host.textContent).toBe("active_child");
    expect(result.newTaskSequence).toBe(0);
  });
  it("refreshes projected attention on the blocker's owner status, even without a task id", async () => {
    await paint(); await advance(); items = [parent(false)];
    await live("agent.status", { agentId: "child-owner", status: "paused" });
    await advance(2_010);
    expect(host.textContent).toBe("attention_required");
    expect(api.list).toHaveBeenCalledTimes(2);
  });
  it("handles a queued blocker run without needing its relationship", async () => {
    await paint(); await advance(); items = [parent(false)];
    await live("heartbeat.run.queued", { issueId: "child", agentId: "child-owner", runId: "child-run" });
    await advance(2_010);
    expect(host.textContent).toBe("attention_required");
  });
  it("coalesces bursts without postponing the first deadline and never polls in silence", async () => {
    await paint(); await advance();
    await live("heartbeat.run.status", { issueId: "child", status: "running" });
    await advance(1_000);
    for (let n = 0; n < 20; n++) await live("agent.status", { agentId: "child-owner", status: "idle" });
    items = [parent(false)];
    await advance(999); expect(api.list).toHaveBeenCalledTimes(1);
    await advance(11); expect(api.list).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("attention_required");
    await advance(60_000); expect(api.list).toHaveBeenCalledTimes(2);
    // A later event opens one new window; there is no interval.
    items = [parent(true)];
    await live("heartbeat.run.status", { issueId: "child", status: "running" });
    await advance(2_010); expect(api.list).toHaveBeenCalledTimes(3);
    expect(host.textContent).toBe("active_child");
  });
  it("ignores other companies and run progress, and invalidates only the exact tray query", async () => {
    await paint(); await advance();
    const otherKey = ["issues", "chat-handoffs", "other-chat"];
    client.setQueryData(otherKey, { untouched: true });
    await live("heartbeat.run.status", { issueId: "child", status: "succeeded" }, { companyId: "other" });
    await live("agent.status", { agentId: "child-owner", status: "paused" }, { companyId: "other" });
    await live("heartbeat.run.progress", { issueId: "child", status: "running" });
    await advance(5_000); expect(api.list).toHaveBeenCalledTimes(1);
    await live("heartbeat.run.status", { issueId: "child", status: "succeeded" });
    await advance(2_010); expect(api.list).toHaveBeenCalledTimes(2);
    expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
  it("cancels a pending refresh on unmount", async () => {
    await paint(); await advance();
    await live("agent.status", { agentId: "child-owner", status: "paused" });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(() => root.render(null));
    await advance(5_000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(1);
  });
  it.each([
    { viewerUserId: "other-viewer" }, { companyId: "other-company" },
    { conversationIssueId: "other-chat" }, { sessionGeneration: 2 }, { viewerUserId: null },
  ])("cancels the old refresh on scope change %j", async patch => {
    await paint(); await advance();
    await live("heartbeat.run.status", { issueId: "child", status: "succeeded" });
    await paint({ ...scope, ...patch }); await advance();
    const reads = api.list.mock.calls.length;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await advance(5_000);
    expect(invalidate).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(reads);
  });
  it("trails an in-flight read so a dependency event cannot be lost behind an older response", async () => {
    await paint(); await advance();
    let release!: () => void;
    const oldItems = items;
    api.list.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ items: oldItems, nextCursor: null });
    }));
    // Begin a normal refresh, then finish the dependency while it is in flight.
    const pending = client.refetchQueries({ queryKey: ["issues", "chat-handoffs"] });
    items = [parent(false)];
    await live("heartbeat.run.status", { issueId: "child", status: "succeeded" });
    await advance(2_010);
    expect(api.list).toHaveBeenCalledTimes(2);
    await act(async () => { release(); await pending; }); await advance();
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(host.textContent).toBe("attention_required");
    expect(result.newTaskSequence).toBe(0);
  });
});
