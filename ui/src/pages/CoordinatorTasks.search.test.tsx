// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { MemoryRouter } from "@/lib/router";
import { useLocation, useNavigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CoordinatorTasks } from "./CoordinatorTasks";

// #20378: the real Tasks toolbar search (TaskListToolbar -> ToolbarSearch) on the
// Coordinator Tasks page, which is what production renders.
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: mocks.list, listCompact: mocks.list, get: vi.fn(), listLabels: async () => [], update: vi.fn() } }));
vi.mock("@/api/attention", () => ({ attentionApi: { taskIndex: async () => ({ taskIds: [] }) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: "person", loaded: true }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/TaskList", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/TaskList")>(),
  TaskList: ({ items }: { items: { issue: { id: string; title: string } }[] }) =>
    <div>{items.map(item => <p key={item.issue.id} data-task-id={item.issue.id}>{item.issue.title}</p>)}</div>,
}));

const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

describe("Coordinator Tasks search box (#20378)", () => {
  let root: Root, host: HTMLDivElement, client: QueryClient;
  let churn: () => void = () => {};
  let go: (to: string) => void = () => {};
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    mocks.list.mockImplementation(async (_company: string, filters: { q?: string }) => [
      createIssue({ id: filters.q ? `match-${filters.q}` : "row", companyId: "company", parentId: null, title: filters.q ? `Match ${filters.q}` : "Row" }),
    ]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); });

  // Live task churn: an urgent re-render of the whole Tasks page, as live
  // updates on production do between keystrokes.
  function Live() {
    const [tick, setTick] = useState(0);
    churn = () => setTick(value => value + 1);
    go = useNavigate();
    return <><output data-location>{useLocation().search}</output><CoordinatorTasks key="tasks" viewControl={<span data-tick={tick} />} /></>;
  }

  async function mount(url: string) {
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><MemoryRouter initialEntries={[url]}><Live /></MemoryRouter></TooltipProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading tasks"));
    return host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
  }
  const location = () => new URLSearchParams(host.querySelector("[data-location]")!.textContent!);

  // One keystroke = one browser `input` event on the focused field. Keys arrive
  // before the router's location transition (react-router 7 BrowserRouter and
  // MemoryRouter wrap location updates in React.startTransition) commits, and
  // the list re-renders in between, as on production.
  function type(input: HTMLInputElement, text: string) {
    for (const key of text) {
      setInputValue.call(input, input.value + key);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync(() => churn());
    }
  }
  function clear(input: HTMLInputElement) {
    setInputValue.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync(() => churn());
  }

  it("keeps every typed character while the URL update and list refresh are still pending", async () => {
    const input = await mount("/issues?view=all");
    input.focus();
    type(input, "SMAA-356");
    expect(input.value).toBe("SMAA-356");
    await vi.waitFor(() => expect(location().get("q")).toBe("SMAA-356"));
    await vi.waitFor(() => expect(host.querySelector('[data-task-id="match-SMAA-356"]')).not.toBeNull());
    expect(input.value).toBe("SMAA-356");
  });

  it("replaces an earlier search instead of reverting to the stale URL value", async () => {
    const input = await mount("/issues?view=all&q=56");
    expect(input.value).toBe("56");
    input.focus();
    clear(input);
    type(input, "SMAA-1390");
    expect(input.value).toBe("SMAA-1390");
    await vi.waitFor(() => expect(location().get("q")).toBe("SMAA-1390"));
    expect(input.value).toBe("SMAA-1390");
  });

  it("still follows search changes that come from the URL", async () => {
    const input = await mount("/issues?view=all");
    input.focus();
    type(input, "draft");
    await vi.waitFor(() => expect(location().get("q")).toBe("draft"));
    flushSync(() => go("/issues?view=all&q=release"));
    await vi.waitFor(() => expect(input.value).toBe("release"));
    flushSync(() => go("/issues?view=all"));
    await vi.waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps keys typed after a pause while that pause's search is still reaching the URL", async () => {
    const input = await mount("/issues?view=all");
    input.focus();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      type(input, "SMAA");
      vi.advanceTimersByTime(300); // the pause: "SMAA" is sent in a transition
      type(input, "-356"); // more keys before that transition commits
      expect(location().get("q")).toBeNull();
      await vi.waitFor(() => expect(location().get("q")).toBe("SMAA"));
      expect(input.value).toBe("SMAA-356");
      vi.advanceTimersByTime(300);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(location().get("q")).toBe("SMAA-356"));
    expect(input.value).toBe("SMAA-356");
  });

  it("clears with the clear button", async () => {
    const input = await mount("/issues?view=all&q=56");
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click());
    expect(input.value).toBe("");
    await vi.waitFor(() => expect(location().has("q")).toBe(false));
    expect(input.value).toBe("");
  });
});
