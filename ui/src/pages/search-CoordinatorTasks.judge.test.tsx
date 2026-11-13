// @vitest-environment jsdom
// Independent #20378 acceptance checks. Keep reason: recorded prod lost-keystroke incident.
// Real CoordinatorTasks, toolbar, router and query observer; network and row rendering are isolated.
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { MemoryRouter } from "@/lib/router";
import { useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CoordinatorTasks } from "./CoordinatorTasks";
import type { Issue } from "@paperclipai/shared";

const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: mocks.list, listCompact: mocks.list, get: vi.fn(), listLabels: async () => [], update: mocks.update } }));
vi.mock("@/api/attention", () => ({ attentionApi: { taskIndex: async () => ({ taskIds: [] }) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: "judge", loaded: true }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/TaskList", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/TaskList")>(),
  TaskList: ({ items }: { items: { issue: { id: string; title: string } }[] }) =>
    <div data-rows>{items.map(item => <p key={item.issue.id} data-task-id={item.issue.id}>{item.issue.title}</p>)}</div>,
}));

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
type Pages = InfiniteData<{ items: Issue[]; hasNextPage: boolean }>;

describe("Independent Tasks query/navigation acceptance", () => {
  let root: Root, host: HTMLDivElement, client: QueryClient;
  let rerender: () => void;
  let go: NavigateFunction;
  let tick: number;
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); tick = 0;
    mocks.list.mockImplementation(async (_company: string, filters: { q?: string }) => [
      createIssue({ id: "row", companyId: "company", parentId: null, title: `Server ${filters.q ?? "all"}` }),
    ]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); });
  function Live() {
    const [version, setVersion] = useState(0);
    rerender = () => setVersion(n => n + 1);
    go = useNavigate();
    return <><output data-location>{useLocation().search}</output><CoordinatorTasks viewControl={<span data-version={version} />} /></>;
  }
  async function mount(entries: string[], empty = false) {
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><MemoryRouter initialEntries={entries}><Live /></MemoryRouter></TooltipProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading tasks"));
    if (!empty) await vi.waitFor(() => expect(host.querySelector("[data-task-id]" )).not.toBeNull());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
    input.focus();
    return input;
  }
  const q = () => new URLSearchParams(host.querySelector("[data-location]")!.textContent!).get("q") ?? "";
  function churn() {
    tick++;
    client.setQueriesData<Pages>({ predicate: query => query.queryKey.includes("coordinator-table") }, old => old && ({
      ...old, pages: old.pages.map(page => ({ ...page, items: page.items.map(issue => ({ ...issue, title: `Live update ${tick}` })) })),
    }));
    flushSync(() => rerender());
    // This is actual query-data churn, not just a changed decorative prop.
    expect(host.querySelector("[data-rows]")!.textContent).toContain(`Live update ${tick}`);
  }
  function type(input: HTMLInputElement, text: string) {
    for (const key of text) {
      nativeValue.call(input, input.value + key);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      churn();
    }
  }

  it("preserves rapid typing while query-cache list updates reach the rendered rows, then settles without a loop", async () => {
    const input = await mount(["/issues?view=all"]);
    type(input, "SMAA-356");
    expect(input.value).toBe("SMAA-356");
    await vi.waitFor(() => expect(q()).toBe("SMAA-356"));
    await vi.waitFor(() => expect(host.querySelector("[data-rows]")!.textContent).toContain("Server SMAA-356"));
    const callCount = mocks.list.mock.calls.length;
    for (let n = 0; n < 20; n++) churn();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(input.value).toBe("SMAA-356");
    expect(q()).toBe("SMAA-356");
    expect(mocks.list).toHaveBeenCalledTimes(callCount);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("restores settled queries through actual Back and Forward history navigation", async () => {
    const input = await mount(["/issues?view=all&q=earlier", "/issues?view=all"]);
    type(input, "SMAA-356");
    await vi.waitFor(() => expect(q()).toBe("SMAA-356"));
    flushSync(() => go(-1));
    await vi.waitFor(() => expect(q()).toBe("earlier"));
    expect(input.value).toBe("earlier");
    flushSync(() => go(1));
    await vi.waitFor(() => expect(q()).toBe("SMAA-356"));
    expect(input.value).toBe("SMAA-356");
  });

  it("clears a pending draft with the toolbar clear button", async () => {
    const input = await mount(["/issues?view=all"]);
    type(input, "SMAA-356");
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click());
    await vi.waitFor(() => expect(q()).toBe(""));
    expect(input.value).toBe("");
  });

  it("Clear filters cancels a pending draft even when the last committed URL has no query", async () => {
    mocks.list.mockResolvedValue([]);
    const input = await mount(["/issues?view=all&status=todo"], true);
    for (const key of "SMAA-356") {
      nativeValue.call(input, input.value + key);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync(() => rerender());
    }
    const clear = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Clear filters")!;
    flushSync(() => clear.click());
    await vi.waitFor(() => expect(host.querySelector("[data-location]")!.textContent).not.toContain("status="));
    expect(q()).toBe("");
    await vi.waitFor(() => expect(input.value).toBe(""));
  });

  it("Back during a pending draft must win even when the history query equals a sent prefix", async () => {
    const input = await mount(["/issues?view=all&q=S", "/issues?view=all"]);
    type(input, "SMAA-356");
    // Last navigation is explicit user intent, not an acknowledgement of typing S.
    flushSync(() => go(-1));
    await vi.waitFor(() => expect(q()).toBe("S"));
    await vi.waitFor(() => expect(input.value).toBe("S"));
  });

  it("Back to the same URL query cancels a pending draft instead of leaving field/results inconsistent", async () => {
    const input = await mount(["/issues?view=all&label=old", "/issues?view=all"]);
    type(input, "SMAA-356");
    flushSync(() => go(-1));
    await vi.waitFor(() => expect(host.querySelector("[data-location]")!.textContent).toContain("label=old"));
    expect(q()).toBe("");
    await vi.waitFor(() => expect(input.value).toBe(""));
  });
});
