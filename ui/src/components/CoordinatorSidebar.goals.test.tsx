// @vitest-environment jsdom
// Goals in the More flyout, rendered through the real company router so the
// link carries the active company prefix (`/<prefix>/goals`).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ enableGoalsSidebarLink: undefined as boolean | undefined }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: "reviewer", agents: { data: [] }, chats: { data: [] }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [] }) }));
vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({ useCoordinatorAttentionCount: () => 0 }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableGoalsSidebarLink: fixture.enableGoalsSidebarLink }) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  localStorage.clear(); fixture.enableGoalsSidebarLink = undefined;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

async function openMore() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><MemoryRouter initialEntries={["/COO/issues"]}>
    <CoordinatorSidebar />
  </MemoryRouter></TooltipProvider></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="More workspace pages"]')!.click());
}

describe("Coordinator More: Goals", () => {
  it("links Goals to the company-prefixed goals page when the Goals sidebar link is on", async () => {
    fixture.enableGoalsSidebarLink = true;
    await openMore();
    const goals = [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="popover-content"] a')].find(link => link.textContent === "Goals");
    expect(goals?.getAttribute("href")).toBe("/COO/goals");
  });
  it.each([false, undefined])("has no Goals entry when the Goals sidebar link is %s", async enabled => {
    fixture.enableGoalsSidebarLink = enabled;
    await openMore();
    expect(document.querySelector('[data-slot="popover-content"] a[href="/COO/projects"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="popover-content"] a[href$="/goals"]')).toBeNull();
  });
});
