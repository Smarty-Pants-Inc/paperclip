// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { MemoryRouter } from "@/lib/router";
import { Issues } from "./Issues";
import { saveTaskCollectionPreferences } from "../lib/task-collection-preferences";

const mocks = vi.hoisted(() => ({ list: vi.fn(), listProps: vi.fn() }));
vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: false }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/issues", () => ({ issuesApi: { listCompact: mocks.list } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("../hooks/useUpdateIssueMutation", () => ({ useUpdateIssueMutation: () => ({ mutate: vi.fn() }) }));
vi.mock("../components/IssuesList", () => ({ IssuesList: (props: { issues: Issue[]; enableHiddenVisibilityFilter?: boolean; searchFilters?: Record<string, unknown> }) => {
  mocks.listProps(props);
  return <output>{props.issues.map(issue => issue.id).join(",")}</output>;
} }));

afterEach(() => { localStorage.clear(); vi.clearAllMocks(); });

it("asks the server for hidden tasks only after Show hidden tasks is turned on, and never for search", async () => {
  mocks.list.mockImplementation(async (_company, filters) => filters.includeHidden
    ? [{ id: "shown-task" }, { id: "hidden-task", hiddenAt: "2026-11-15T05:00:00.000Z" }]
    : [{ id: "shown-task" }]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/issues?view=all"]}><Issues /></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("shown-task"));
    expect(mocks.list.mock.calls[0]?.[1].includeHidden).toBeFalsy();
    expect(mocks.listProps.mock.lastCall?.[0].enableHiddenVisibilityFilter).toBe(true);

    // The list's Filters panel persists the choice; the page follows it.
    saveTaskCollectionPreferences(
      { companyId: "company", collectionKey: "paperclip:issues-view" },
      { viewState: { showHiddenTasks: true }, columns: [] },
    );
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("shown-task,hidden-task"));
    expect(mocks.list.mock.lastCall?.[1]).toMatchObject({ includeHidden: true, offset: 0 });
    expect(mocks.listProps.mock.lastCall?.[0].searchFilters?.includeHidden).toBeUndefined();

    saveTaskCollectionPreferences(
      { companyId: "company", collectionKey: "paperclip:issues-view" },
      { viewState: { showHiddenTasks: false }, columns: [] },
    );
    await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("shown-task"));
    expect(mocks.list.mock.lastCall?.[1].includeHidden).toBeFalsy();
  } finally {
    flushSync(() => root.unmount()); client.clear(); host.remove();
  }
});
