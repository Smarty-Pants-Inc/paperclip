// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { inboxDismissalsApi } from "@/api/inboxDismissals";
import { attentionApi } from "@/api/attention";
import { useCoordinatorAttentionCount } from "@/hooks/useCoordinatorAttentionCount";
import { coordinatorAttentionQueryKey } from "@/lib/coordinator-attention";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, DecisionHistoryItem } from "@paperclipai/shared";
import { CoordinatorNeedsYou } from "./CoordinatorNeedsYou";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ pending: [] as AttentionItem[], history: [] as DecisionHistoryItem[], url: "/decisions", mobile: false, partial: false, historyFail: false, feedFail: false, openPanel: vi.fn(), closePanel: vi.fn(), setPanelVisible: vi.fn(), navigate: vi.fn(), breadcrumbs: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: fixture.breadcrumbs }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({ openPanel: fixture.openPanel, closePanel: fixture.closePanel, setPanelVisible: fixture.setPanelVisible }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: fixture.mobile }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ userId: "reviewer" }) }));
vi.mock("@/lib/router", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/router")>(), useNavigate: () => fixture.navigate }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/inboxDismissals", () => ({ inboxDismissalsApi: {
  list: vi.fn(async () => []),
  snooze: vi.fn(async (_companyId: string, itemKey: string, snoozedUntil: string) => {
    fixture.pending = fixture.pending.map(item => item.dismissalKey === itemKey
      ? { ...item, dismissal: { kind: "snooze", snoozedUntil, isActive: true } } as AttentionItem : item);
  }),
  restore: vi.fn(async (_companyId: string, itemKey: string) => {
    fixture.pending = fixture.pending.map(item => item.dismissalKey === itemKey ? { ...item, dismissal: null } : item);
  }),
} }));
vi.mock("@/api/attention", () => ({ attentionApi: {
  list: vi.fn(async () => { if (fixture.feedFail) throw new Error("Feed unavailable"); return { items: [...fixture.pending] }; }),
  history: async () => { if (fixture.historyFail) throw new Error("History unavailable"); return { items: [...fixture.history], nextCursor: null }; },
} }));
vi.mock("motion/react", () => ({
  LayoutGroup: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
  motion: { article: ({ children, className }: { children: ReactNode; className: string }) => <article className={className}>{children}</article>, div: ({ children, id, tabIndex }: { children: ReactNode; id?: string; tabIndex?: number }) => <div id={id} tabIndex={tabIndex}>{children}</div> },
}));
vi.mock("@/components/PropertiesPanel", () => ({ PROPERTIES_PANE_HEADER_SLOT_ID: "test-sidebar" }));
vi.mock("@/components/DecisionResolver", () => ({ DecisionResolver: () => null }));
vi.mock("@/components/StalledReviewActions", () => ({ StalledReviewActions: ({ issueId, approveLabel, reviewPolicy, footerSlot, onResolved }: { issueId: string; approveLabel: string; reviewPolicy: string; footerSlot?: ReactNode; onResolved: () => void }) => <>{footerSlot}<button data-review-policy={reviewPolicy} onClick={() => {
  fixture.pending = fixture.pending.filter((item) => item.subject.id !== issueId);
  onResolved();
}}>{approveLabel}</button></> }));
vi.mock("@/components/AttentionInteractionResolver", () => ({ AttentionInteractionResolver: ({ issueId, interactionId, footerSlot, onResolved }: { issueId: string; interactionId: string; footerSlot?: ReactNode; onResolved: (interaction: { status: string }) => void }) => <>{footerSlot}<button data-issue-id={issueId} onClick={() => {
  if (fixture.partial) { onResolved({ status: "pending" }); return; }
  fixture.pending = fixture.pending.filter((item) => item.subject.id !== interactionId);
  fixture.history.push({ id: `issue_thread_interaction:${interactionId}`, sourceKind: "issue_thread_interaction", sourceId: interactionId,
    issueId: `task-${interactionId}`, issueIdentifier: `PAP-${interactionId}`, issueTitle: `Task ${interactionId}`, title: "Decision", label: interactionId === "3" ? "Answers recorded" : "Approved", outcome: interactionId === "3" ? "answered" : "accepted", resolvedAt: new Date().toISOString(), resolvedByUserId: "reviewer", resolvedByAgentId: null, agentId: null, agentName: null, projectId: null, projectName: null, href: `/PAP/issues/PAP-${interactionId}#interaction-${interactionId}`, target: null });
  onResolved({ status: "answered" });
}}>Resolve {interactionId}</button></> }));

function queryByRole(scope: HTMLElement, role: "button" | "menuitem", { name }: { name: string; exact: true }) {
  return [...scope.querySelectorAll<HTMLElement>(role === "button" ? "button" : '[role="menuitem"]')]
    .find(element => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === name) ?? null;
}
function getByRole(scope: HTMLElement, role: "button" | "menuitem", options: { name: string; exact: true }) {
  const element = queryByRole(scope, role, options);
  expect(element, `${role}: ${options.name}`).not.toBeNull();
  return element!;
}
function Location() { return <output data-location>{useLocation().search}</output>; }
function AttentionCount() { return <output data-attention-count>{useCoordinatorAttentionCount("company")}</output>; }

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  fixture.pending = ["1", "2", "3"].map((id) => ({ id, dismissalKey: `attention:interaction:${id}`, sourceKind: "issue_thread_interaction", inlineResolvable: true, subject: { id, kind: "interaction", title: `Review ${id}`, metadata: { issueId: `task-${id}` } }, relatedIssue: { id: `task-${id}`, identifier: `PAP-${id}`, title: `Task ${id}`, href: `/PAP/issues/PAP-${id}` }, activityAt: new Date().toISOString() } as unknown as AttentionItem));
  fixture.history = []; fixture.url = "/decisions"; vi.clearAllMocks();
  fixture.historyFail = false; fixture.feedFail = false; fixture.partial = false; fixture.mobile = false;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
  expect(button, text).toBeTruthy();
  await act(async () => button!.click()); await flush();
}
describe("Coordinator Needs You", () => {
  it.each([false, true])("snoozes an interaction into a collapsed section and restores it (phone: %s)", async mobile => {
    fixture.mobile = mobile;
    fixture.pending = [fixture.pending[0]];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/decisions"]}><CoordinatorNeedsYou /><AttentionCount /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(container.querySelector("[data-attention-count]")?.textContent).toBe("1");
    expect(client.getQueryData(coordinatorAttentionQueryKey("company"))).toBeUndefined();
    expect(attentionApi.list).toHaveBeenCalledWith("company", { all: true, includeDismissed: true });
    const before = Date.now();
    // Radix menus open on pointerdown; exercise the actual menu, not a hook mock.
    await act(async () => getByRole(container, "button", { name: "Snooze", exact: true }).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    ));
    await flush();
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual([
      "1 hour", "4 hours", "Tomorrow morning", "Next week",
    ]);
    await act(async () => getByRole(document.body, "menuitem", { name: "1 hour", exact: true }).click());
    await flush(); await flush();
    expect(inboxDismissalsApi.snooze).toHaveBeenCalledWith("company", "attention:interaction:1", expect.any(String));
    const until = vi.mocked(inboxDismissalsApi.snooze).mock.calls[0][2];
    expect(Date.parse(until)).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(Date.parse(until)).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(queryByRole(container, "button", { name: "Resolve 1", exact: true })).toBeNull();
    expect(container.querySelector("[data-attention-count]")?.textContent).toBe("0");
    expect(client.getQueryData(coordinatorAttentionQueryKey("company"))).toBeUndefined();
    const toggle = getByRole(container, "button", { name: "Snoozed", exact: true });
    expect(toggle.textContent).toContain("Snoozed (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(queryByRole(container, "button", { name: "Restore", exact: true })).toBeNull();
    await act(async () => toggle.click()); await flush();
    expect(container.textContent).toContain("Review 1");
    expect(container.textContent).toContain("Reappears in 1h");
    await act(async () => getByRole(container, "button", { name: "Restore", exact: true }).click());
    await flush(); await flush();
    expect(inboxDismissalsApi.restore).toHaveBeenCalledWith("company", "attention:interaction:1");
    expect(getByRole(container, "button", { name: "Resolve 1", exact: true })).toBeTruthy();
    expect(container.querySelector("[data-attention-count]")?.textContent).toBe("1");
    expect(queryByRole(container, "button", { name: "Snoozed", exact: true })).toBeNull();
    client.clear();
  });

  it("keeps active dismissals out of the main list but allows expired snoozes to reappear", async () => {
    const [snoozed, dismissed, expired] = fixture.pending;
    fixture.pending = [
      { ...snoozed, dismissal: { kind: "snooze", isActive: true, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() } },
      { ...dismissed, dismissal: { kind: "dismiss", isActive: true } },
      { ...expired, dismissal: { kind: "snooze", isActive: false, snoozedUntil: new Date(Date.now() - 1).toISOString() } },
    ] as AttentionItem[];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><CoordinatorNeedsYou /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(queryByRole(container, "button", { name: "Resolve 1", exact: true })).toBeNull();
    expect(queryByRole(container, "button", { name: "Resolve 2", exact: true })).toBeNull();
    expect(getByRole(container, "button", { name: "Resolve 3", exact: true })).toBeTruthy();
    expect(getByRole(container, "button", { name: "Snoozed", exact: true }).textContent).toContain("(1)");
    client.clear();
  });

  it.each(["decision", "review"] as const)("offers the same Snooze menu on a pending %s card", async sourceKind => {
    fixture.pending = [{ ...fixture.pending[0], sourceKind,
      dismissalKey: `attention:${sourceKind}:1`,
      subject: { ...fixture.pending[0].subject, id: "1", kind: sourceKind === "review" ? "issue" : "decision", title: "Pending choice", metadata: { reviewAttentionState: "stalled" } },
    }] as AttentionItem[];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><CoordinatorNeedsYou /></MemoryRouter></QueryClientProvider>));
    await flush();
    await act(async () => getByRole(container, "button", { name: "Snooze", exact: true }).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    await flush();
    await act(async () => getByRole(document.body, "menuitem", { name: "4 hours", exact: true }).click());
    await flush(); await flush();
    expect(inboxDismissalsApi.snooze).toHaveBeenCalledWith("company", `attention:${sourceKind}:1`, expect.any(String));
    expect(container.querySelector(".coordinator-decision-card")).toBeNull();
    expect(getByRole(container, "button", { name: "Snoozed", exact: true }).textContent).toContain("(1)");
    client.clear();
  });

  it("reveals and focuses a linked decision beyond the first rendering window, then consumes only its URL parameter", async () => {
    fixture.url = "/decisions?decisionId=target&q=kept";
    fixture.pending = Array.from({ length: 61 }, (_, index) => ({ ...fixture.pending[0], id: `decision-${index}`, sourceKind: "decision",
      subject: { id: index === 60 ? "target" : `decision-${index}`, kind: "decision", title: `Decision ${index}` },
      activityAt: new Date(Date.now() - index * 1000).toISOString(),
    })) as AttentionItem[];
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scroll });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush(); await flush();
    const card = container.querySelector("#coordinator-decision-target");
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    expect(container.querySelector("[data-location]")?.textContent).toBe("?q=kept");
    // Consumed links must not refocus on an ordinary feed refresh.
    scroll.mockClear();
    await act(async () => { await client.invalidateQueries({ queryKey: ["attention"] }); }); await flush();
    expect(scroll).not.toHaveBeenCalled();
    client.clear();
  });
  it("opens searchable history from both phone buttons without the hidden desktop panel", async () => {
    fixture.mobile = true;
    fixture.pending = [];
    fixture.history = [{ id: "old-decision", sourceKind: "issue_thread_interaction", sourceId: "old", issueId: "task-1", issueIdentifier: "PAP-1", issueTitle: "Earlier launch", title: "Review", label: "Approved", outcome: "accepted", resolvedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), resolvedByUserId: "reviewer", resolvedByAgentId: null, agentId: null, agentName: null, projectId: null, projectName: null, href: "/PAP/issues/PAP-1#interaction-old", target: null }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    for (const label of ["Decision history", "Open decision history"]) {
      const trigger = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
      expect(trigger).toBeTruthy();
      await act(async () => trigger!.click()); await flush();
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.querySelector('[aria-label="Search decision history"]')).not.toBeNull();
      expect(dialog!.textContent).toContain("Earlier launch");
      expect(fixture.openPanel).not.toHaveBeenCalled();
      const close = [...dialog!.querySelectorAll("button")].find(button => button.textContent === "Close");
      await act(async () => close!.click()); await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    client.clear();
  });
  it("keeps a partial review actionable even when history is unavailable", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    fixture.partial = true; fixture.historyFail = true;
    await click("Resolve 1"); await flush();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Resolve 1")).toBe(true);
    expect(container.querySelector('[data-motion="gather"]')).toBeNull();
    fixture.partial = false;
    await click("Resolve 1"); await flush();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Resolve 1")).toBe(false);
    client.clear();
  });
  it.each([false, true])("does not restore a saved decision when history refresh fails (stale feed: %s)", async staleFeed => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    fixture.historyFail = true; fixture.feedFail = staleFeed;
    await click("Resolve 1"); await flush();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Resolve 1")).toBe(false);
    expect(container.textContent).toContain("Recent decisions could not be loaded");
    expect(container.textContent).toContain("Resolve 2");
    client.clear();
  });
  it("sorts, groups, and filters the recent decisions shown beneath the toolbar", async () => {
    fixture.pending = [];
    const now = Date.now();
    fixture.history = [
      { id: "recent-old", sourceId: "old", issueIdentifier: "PAP-1", issueTitle: "First task", projectId: "launch", projectName: "Launch", resolvedAt: new Date(now - 180_000).toISOString() },
      { id: "recent-middle", sourceId: "middle", issueIdentifier: "PAP-2", issueTitle: "Second task", projectId: "other", projectName: "Other", resolvedAt: new Date(now - 120_000).toISOString() },
      { id: "recent-new", sourceId: "new", issueIdentifier: "PAP-3", issueTitle: "Third task", projectId: "launch", projectName: "Launch", resolvedAt: new Date(now - 60_000).toISOString() },
    ].map((item) => ({ sourceKind: "issue_thread_interaction", issueId: item.sourceId, agentId: null, agentName: null,
      title: "Review", outcome: "accepted", label: "Approved", resolvedByUserId: "reviewer", resolvedByAgentId: null,
      href: `/PAP/issues/${item.issueIdentifier}`, target: null, ...item })) as DecisionHistoryItem[];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    const visibleIds = () => [...container.querySelectorAll('[aria-label="Recent Decisions"] .coordinator-decision-receipt')]
      .map((item) => item.textContent?.match(/PAP-\d+/)?.[0]);
    const changeSelect = async (label: string, value: string) => {
      const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
      expect(select).not.toBeNull();
      await act(async () => { select!.value = value; select!.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    expect(visibleIds()).toEqual(["PAP-3", "PAP-2", "PAP-1"]);
    await changeSelect("Sort decisions", "oldest");
    expect(visibleIds()).toEqual(["PAP-1", "PAP-2", "PAP-3"]);
    await changeSelect("Group decisions", "task");
    expect([...container.querySelectorAll('[aria-label="Recent Decisions"] h3')].map((item) => item.textContent)).toEqual(["PAP-1", "PAP-2", "PAP-3"]);
    await changeSelect("Filter decisions by project", "launch");
    expect(visibleIds()).toEqual(["PAP-1", "PAP-3"]);
    client.clear();
  });

  it("resizes and gathers light in place before moving the saved receipt into Recent Decisions", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
    HTMLElement.prototype.animate = animate;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { width: 500, height: this.querySelector("article") ? 320 : 80 } as DOMRect;
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: (name: string) => name.endsWith("ease") ? "ease-out" : name.includes("light") ? "1400ms" : name.includes("morph") ? "480ms" : "0ms" } as CSSStyleDeclaration);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(container.querySelector("[data-motion]")).toBeNull();
    vi.useFakeTimers();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve 1")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const transition = container.querySelector('[data-motion="gather"]');
    expect(transition?.textContent).toContain("Approved");
    expect(transition?.textContent).toContain("PAP-1");
    expect(container.querySelector('[aria-label="Recent Decisions"]')).toBeNull();
    expect(animate.mock.calls[0]?.[0]).toEqual([{ height: "320px", width: "500px" }, { height: "80px", width: "500px" }]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 480 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(container.querySelector("[data-motion]")).toBeNull();
    expect(container.querySelector('[aria-label="Recent Decisions"]')?.textContent).toContain("PAP-1");
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(1);
    client.clear();
  });
  it("renders a pending canonical question from persistent chat with its original resolver and context", async () => {
    fixture.pending = [{ id: "issue_thread_interaction:interaction:chat-question", sourceKind: "issue_thread_interaction", inlineResolvable: true,
      subject: { id: "chat-question", kind: "interaction", title: "Choose the screen", metadata: { kind: "ask_user_questions", issueId: "chat-issue" } },
      relatedIssue: { id: "chat-issue", identifier: "PAP-10", title: "Chat with Chief of Staff", href: "/PAP/issues/PAP-10" },
      detail: { kind: "questions", questionCount: 1, firstQuestionText: "Which screen should we redesign?", images: [] },
      activityAt: new Date().toISOString() } as unknown as AttentionItem];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector('[data-issue-id="chat-issue"]')?.textContent).toBe("Resolve chat-question");
    expect(container.textContent).toContain("Chat with Chief of Staff");
    expect(container.textContent).not.toContain("You're caught up.");
    await click("PAP-10");
    expect(fixture.navigate).toHaveBeenCalledWith("/PAP/issues/PAP-10");
  });
  it("keeps a distinct stalled task actionable after its document decision is recorded", async () => {
    fixture.pending = [{ id: "review:task-1", sourceKind: "review", inlineResolvable: true,
      subject: { id: "task-1", kind: "issue", title: "Launch copy", identifier: "PAP-1", href: "/PAP/issues/PAP-1", metadata: { reviewAttentionState: "stalled", reviewPolicy: "human_only" } },
      activityAt: new Date().toISOString() } as unknown as AttentionItem];
    fixture.history = [{ id: "issue_thread_interaction:approved-copy", sourceKind: "issue_thread_interaction", sourceId: "approved-copy", issueId: "task-1", issueIdentifier: "PAP-1", issueTitle: "Launch copy", title: "Copy review", label: "Approved", outcome: "accepted", resolvedAt: new Date().toISOString(), resolvedByUserId: "reviewer", resolvedByAgentId: null, agentId: null, agentName: null, projectId: null, projectName: null, href: "/PAP/issues/PAP-1#interaction-approved-copy", target: null }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(container.textContent).toContain("Choose how this task continues");
    expect(container.textContent).not.toContain("Open to review");
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(1);
    expect(container.querySelector("[data-review-policy]")?.getAttribute("data-review-policy")).toBe("human_only");
    await click("Mark task done");
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).toContain("You're caught up.");
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(1);
  });
  it("retains all three decisions as receipts, including an answered question, and opens history only on demand", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(fixture.openPanel).not.toHaveBeenCalled();
    expect(container.querySelectorAll("article")).toHaveLength(3);
    await click("Resolve 1"); await click("Resolve 2"); await click("Resolve 3");
    await flush();
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).toContain("Recent Decisions");
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(3);
    expect(container.textContent).toContain("Answers recorded");
    await click("PAP-3");
    expect(fixture.navigate).toHaveBeenCalledWith("/PAP/issues/PAP-3#interaction-3");
    await click("Decision history");
    expect(fixture.openPanel).toHaveBeenCalled();
    expect(fixture.setPanelVisible).toHaveBeenCalledWith(true);
    // The shared desktop hide control changes visibility without closing
    // this tab. Clicking history again must reveal the already-open tab.
    fixture.setPanelVisible(false);
    fixture.setPanelVisible.mockClear();
    await click("Decision history");
    expect(fixture.setPanelVisible).toHaveBeenCalledWith(true);
  });
});
