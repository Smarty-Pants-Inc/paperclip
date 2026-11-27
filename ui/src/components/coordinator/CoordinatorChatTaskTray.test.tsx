// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { CoordinatorChatTaskTray, type CoordinatorChatTaskTrayProps } from "./CoordinatorChatTaskTray";
import { ChatTaskTrayMembershipContext, type ChatTaskTrayItem } from "./useChatTaskTray";
import { ChatComposerAccessoryActiveContext } from "@/components/chat-composer/ChatComposerAccessoryHost";
import { resolveTaskStatusPresentation, taskStatusIconProps } from "@/lib/task-status-presentation";
import { groupForGlyph, CHAT_TASK_TRAY_GROUP_ORDER, CHAT_TASK_TRAY_LABELS } from "./chat-task-tray-model";
const presentationFor = (item: ChatTaskTrayItem) => {
  const source = { ...item, id: item.issueId };
  return resolveTaskStatusPresentation(taskStatusIconProps(source));
};
const state = vi.hoisted(() => ({
  items: [] as ChatTaskTrayItem[], loading: false, stale: false, enabled: true, retry: vi.fn(), newTaskSequence: 0, reduced: false,
}));
vi.mock("./useChatTaskTray", async importActual => ({ ...await importActual<typeof import("./useChatTaskTray")>(), useChatTaskTray: () => state }));
vi.mock("motion/react", () => ({ useReducedMotion: () => state.reduced }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [{ id: "agent", name: "Build Agent" }] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [
  { principalId: "user", user: { name: "Alex Owner", image: "https://not-allowed.example/photo" } },
] }) } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, disableIssueQuicklook: _ignored, ...props }: any) => <a href={to} {...props}>{children}</a> }));
vi.mock("@/context/LiveUpdatesProvider", () => ({ useCompanyLiveEvent: () => {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, client: QueryClient;
let activeAccessory = true;
let membership = vi.fn();
const props: CoordinatorChatTaskTrayProps = { companyId: "company", conversationIssueId: "chat", viewerUserId: "viewer", sessionGeneration: 1, onOpenConversationTasks: vi.fn() };
const item = (n: number, patch: Partial<ChatTaskTrayItem> = {}): ChatTaskTrayItem => ({
  id: `handoff-${n}`, issueId: `task-${n}`, identifier: `TEST-${n}`, title: `Task ${n}`, status: "todo",
  createdAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 120000).toISOString(), sourceRunId: null, suggestionInteractionId: null, ...patch,
});
const paint = (patch: Partial<CoordinatorChatTaskTrayProps> = {}) => act(() => root.render(<QueryClientProvider client={client}>
  <ChatTaskTrayMembershipContext.Provider value={membership}>
    <ChatComposerAccessoryActiveContext.Provider value={activeAccessory}><CoordinatorChatTaskTray {...props} {...patch} /></ChatComposerAccessoryActiveContext.Provider>
  </ChatTaskTrayMembershipContext.Provider>
</QueryClientProvider>));
const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="chat-task-tray${id ? `-${id}` : ""}"]`);
const click = (id: string) => act(() => get(id)!.click());
const key = (node: Element, value: string) => act(() => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, code: value, bubbles: true })));
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
beforeEach(() => {
  state.items = []; state.loading = false; state.stale = false; state.enabled = true; state.newTaskSequence = 0; state.reduced = false; state.retry.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  props.onOpenConversationTasks = vi.fn(); activeAccessory = true; membership = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(async () => { await act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });
describe("chat task tray", () => {
  it("renders no tray at zero, but a loading row until the complete first snapshot", async () => {
    await paint(); expect(get("")).toBeNull();
    state.loading = true; await paint();
    expect(get("")!.textContent).toContain("Loading open tasks…");
    state.loading = false; state.stale = true; await paint(); expect(get("")!.textContent).toContain("Status unavailable");
    await act(() => [...get("")!.querySelectorAll("button")][0].click()); expect(state.retry).toHaveBeenCalledOnce();
  });
  it("renders one task as a link with title, id, status, owner, age, no chevron; Space activates it", async () => {
    state.items = [item(1, { status: "in_progress", assigneeAgentId: "agent" })]; await paint(); await settle();
    const row = get("single")!;
    expect(row.tagName).toBe("A"); expect(row.getAttribute("href")).toBe("/issues/TEST-1");
    expect(row.textContent).toContain("Task 1"); expect(row.textContent).toContain("TEST-1");
    expect(row.textContent).toContain("In Progress"); expect(row.textContent).toContain("Build Agent"); expect(row.textContent).toContain("2m ago");
    expect(get("summary")).toBeNull(); expect(row.querySelector("button")).toBeNull();
    const activated = vi.fn((event: Event) => event.preventDefault()); row.addEventListener("click", activated);
    await key(row, " "); expect(activated).toHaveBeenCalledOnce();
  });
  it("keeps a several-task row folded, opens upward in a portal, and a second click folds it", async () => {
    state.items = [item(1), item(2, { status: "in_progress" }), item(3, { status: "blocked" })]; await paint();
    expect(get("summary")!.tagName).toBe("BUTTON");
    expect(get("summary")!.getAttribute("aria-expanded")).toBe("false");
    // Both supported bases own the status decision in the shared resolver.
    const counts = { working: 0, "needs-you": 0, waiting: 0, "up-next": 0 };
    for (const task of state.items) counts[groupForGlyph(presentationFor(task).glyphStatus)!]++;
    for (const group of CHAT_TASK_TRAY_GROUP_ORDER) {
      const count = get(`count-${group}`);
      if (counts[group]) expect(count!.textContent).toContain(`${counts[group]} ${CHAT_TASK_TRAY_LABELS[group].toLowerCase()}`);
      else expect(count).toBeNull();
    }
    expect(get("summary")!.textContent).toContain("+1");
    await click("summary"); expect(get("summary")!.getAttribute("aria-expanded")).toBe("true");
    expect(get("panel")!.getAttribute("data-side")).toBe("top");
    expect(host.contains(get("panel"))).toBe(false);
    expect(document.querySelectorAll('[data-testid="chat-task-tray-row"]')).toHaveLength(3);
    const headings = [...get("panel")!.querySelectorAll("h3")].map(node => node.textContent);
    expect(headings).toEqual(CHAT_TASK_TRAY_GROUP_ORDER.filter(group => counts[group])
      .map(group => `${CHAT_TASK_TRAY_LABELS[group]} · ${counts[group]}`));
    await click("summary"); expect(get("panel")).toBeNull();
  });
  it("Escape closes and returns focus to the same summary row", async () => {
    state.items = [item(1), item(2)]; await paint(); await click("summary"); await settle();
    await key(document.activeElement!, "Escape"); await settle();
    expect(get("panel")).toBeNull(); expect(document.activeElement).toBe(get("summary"));
  });
  it("shows the filter at 10, searches owners without changing counts, and opens the Tasks tab", async () => {
    state.items = Array.from({ length: 10 }, (_, i) => item(i, i === 9 ? { assigneeUserId: "user" } : {})); await paint(); await settle(); await click("summary");
    expect(get("filter")).not.toBeNull();
    const input = get("filter") as HTMLInputElement;
    async function type(value: string) {
      await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    await type("Alex"); expect(document.querySelectorAll('[data-testid="chat-task-tray-row"]')).toHaveLength(1);
    expect(get("summary")!.textContent).toContain("10 open tasks");
    expect(get("panel")!.querySelector('img[src^="https://not-allowed"]')).toBeNull();
    await type("not found"); expect(get("panel")!.textContent).toContain("No open tasks match.");
    await click("open-tasks"); expect(props.onOpenConversationTasks).toHaveBeenCalledOnce(); expect(get("panel")).toBeNull();
  });
  it("hides done and cancelled before counting, closes below two, and disappears when the last task finishes", async () => {
    state.items = [item(1), item(2)]; await paint(); await click("summary");
    state.items = [item(1), item(2, { status: "done" })]; await paint();
    expect(get("panel")).toBeNull(); expect(get("single")).not.toBeNull();
    state.items = [item(1, { status: "cancelled" }), item(2, { status: "done" })]; await paint();
    expect(get("")).toBeNull();
  });
  it("uses the shared resolver's group and label for an evidenced human action", async () => {
    state.items = [item(1), item(2, { status: "blocked", unblockDescriptor: { owner: { userId: "user" }, action: "Approve deploy" } })]; await paint();
    const expected = presentationFor(state.items[1]);
    const group = groupForGlyph(expected.glyphStatus)!;
    expect(get(`count-${group}`)!.textContent).toContain(`1 ${CHAT_TASK_TRAY_LABELS[group].toLowerCase()}`);
    await click("summary"); expect(get("panel")!.textContent).toContain(expected.label);
  });
  it("shimmers once for a new task without opening; respects reduced motion", async () => {
    state.items = [item(1), item(2)]; await paint(); expect(get("")!.hasAttribute("data-shimmer")).toBe(false);
    state.items = [...state.items, item(3)]; state.newTaskSequence = 1; await paint();
    expect(get("")!.dataset.shimmer).toBe("true"); expect(get("panel")).toBeNull();
    await act(() => {
      const light = get("")!.querySelector(".chat-task-tray-shimmer")!;
      // jsdom omits AnimationEvent, so React may select its WebKit event name.
      light.dispatchEvent(new Event("animationend", { bubbles: true }));
      light.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
    });
    expect(get("")!.hasAttribute("data-shimmer")).toBe(false); await paint(); expect(get("")!.hasAttribute("data-shimmer")).toBe(false);
    state.newTaskSequence = 2; state.reduced = true; await paint(); expect(get("")!.hasAttribute("data-shimmer")).toBe(false);
  });
  it("publishes only current, healthy, selected tray membership and clears it on unmount", async () => {
    state.items = [item(1), item(2, { status: "done" }), item(3, { status: "cancelled" })];
    await paint(); await settle();
    expect([...membership.mock.lastCall![1]]).toEqual(["task-1"]);
    state.loading = true; await paint(); expect(membership.mock.lastCall![1]).toBeNull();
    state.loading = false; state.stale = true; await paint(); expect(membership.mock.lastCall![1]).toBeNull();
    state.stale = false; state.items = [item(1, { status: "in_progress", displayStatus: "done" })];
    await paint(); expect(membership.mock.lastCall![1]).toBeNull();
    state.items = [item(1)]; activeAccessory = false; await paint(); expect(membership.mock.lastCall![1]).toBeNull();
    activeAccessory = true; await paint(); expect([...membership.mock.lastCall![1]]).toEqual(["task-1"]);
    await act(() => root.render(<div />)); expect(membership.mock.lastCall![1]).toBeNull();
  });
  it("queues one pulse per new task in a batch without opening the list", async () => {
    state.items = [item(1), item(2)]; await paint();
    state.items = [...state.items, item(3), item(4), item(5)]; state.newTaskSequence = 3; await paint();
    for (let n = 0; n < 3; n++) {
      expect(get("")!.dataset.shimmer).toBe("true");
      expect(get("panel")).toBeNull();
      await act(() => {
        const light = get("")!.querySelector(".chat-task-tray-shimmer")!;
        light.dispatchEvent(new Event("animationend", { bubbles: true }));
        light.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
      });
    }
    expect(get("")!.hasAttribute("data-shimmer")).toBe(false);
  });
  it("keeps cached rows marked stale with Retry, and resets open state on scope change", async () => {
    state.items = [item(1), item(2)]; state.stale = true; await paint();
    expect(get("")!.dataset.stale).toBe("true"); expect(get("")!.textContent).toContain("Stale");
    await click("summary"); expect(get("panel")).not.toBeNull();
    await paint({ sessionGeneration: 2 }); expect(get("panel")).toBeNull(); expect(get("summary")!.getAttribute("aria-expanded")).toBe("false");
  });
});
