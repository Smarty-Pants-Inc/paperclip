// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesList } from "./IssuesList";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShowAgentCreatedTasks } from "../hooks/useShowAgentCreatedTasks";
import { taskCollectionPreferencesStorageKey } from "../lib/task-collection-preferences";
import { queryKeys } from "../lib/queryKeys";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  listAll: vi.fn(),
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockKanbanBoard = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockExternalObjectsApi = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
  useDialogActions: () => dialogState,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    ...mockIssuesApi,
    listCompact: mockIssuesApi.list,
  },
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/externalObjects", () => ({
  externalObjectsApi: mockExternalObjectsApi,
}));

vi.mock("./IssueRow", () => ({ IssueRow: ({ issue }: { issue: Issue }) => <div>{issue.title}</div> }));
vi.mock("./KanbanBoard", () => ({
  KANBAN_BOARD_HIGH_VOLUME_THRESHOLD: 100,
  KANBAN_COLD_STATUSES: ["backlog", "done", "cancelled"],
  KANBAN_COLUMN_DEFAULT_PAGE_SIZE: 10,
  KANBAN_COLUMN_PAGE_SIZE_OPTIONS: [10, 25, 50],
  KanbanBoard: (props: { issues: Issue[] }) => { mockKanbanBoard(props); return <div>{props.issues.map(issue => <span key={issue.id}>{issue.title}</span>)}</div>; },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: "person",
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

async function waitForAssertion(assertion: () => void) {
  await vi.waitFor(assertion, { timeout: 1000, interval: 10 });
}
const mountedClients: QueryClient[] = [];
const mountedRoots: ReturnType<typeof createRoot>[] = [];
function renderWithQueryClient(node: ReactNode, container: HTMLDivElement, streamlined?: boolean) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (streamlined !== undefined) queryClient.setQueryData(queryKeys.instance.experimentalSettings, { enableStreamlinedUi: streamlined });
  mountedClients.push(queryClient);
  mountedRoots.push(root);
  act(() => root.render(<QueryClientProvider client={queryClient}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>));
  return { root, queryClient };
}
describe("fork task visibility preferences", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    localStorage.clear(); companyState.selectedCompanyId = "company-1";
    container = document.createElement("div"); document.body.append(container);
    vi.clearAllMocks();
    mockIssuesApi.list.mockResolvedValue([]); mockIssuesApi.listAll.mockResolvedValue([]); mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockAccessApi.listMembers.mockResolvedValue({ members: [], access: {} });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]); mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: false });
    mockExternalObjectsApi.getIssueSummaries.mockResolvedValue({});
  });
  afterEach(() => {
    // Already-unmounted roots (reload and finally paths) are harmless; also clean up a failed assertion.
    act(() => mountedRoots.splice(0).forEach(root => root.unmount()));
    mountedClients.splice(0).forEach(client => client.clear()); container.remove(); localStorage.clear();
  });
  it("loads board issues with a separate result limit for each status column", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const parentIssue = createIssue({
      id: "issue-parent-total-limit",
      title: "Parent total-limited issue",
      status: "todo",
    });
    const backlogIssue = createIssue({
      id: "issue-backlog",
      title: "Backlog column issue",
      status: "backlog",
    });
    const doneIssue = createIssue({
      id: "issue-done",
      title: "Done column issue",
      status: "done",
    });

    mockIssuesApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.displayStatus === "backlog") return Promise.resolve([backlogIssue]);
      if (filters?.displayStatus === "done") return Promise.resolve([doneIssue]);
      return Promise.resolve([]);
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[parentIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        enableAgentCreatedVisibilityFilter
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        displayStatus: "backlog",
        limit: 200,
        includeRoutineExecutions: true,
        includeAgentCreatedTasks: true,
      }), { signal: expect.any(AbortSignal) });
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        displayStatus: "done",
        limit: 200,
        includeRoutineExecutions: true,
        includeAgentCreatedTasks: true,
      }), { signal: expect.any(AbortSignal) });
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ id: "issue-backlog" }),
          expect.objectContaining({ id: "issue-done" }),
        ]),
      }));
      expect(container.textContent).toContain("Backlog column issue");
      expect(container.textContent).toContain("Done column issue");
      expect(container.textContent).not.toContain("Parent total-limited issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("ignores the old visibility flag and subscribes to new saved choices", async () => {
    function PreferenceProbe() {
      return <span>{String(useShowAgentCreatedTasks("example-org", "paperclip:project-issues-view"))}</span>;
    }
    const { root, queryClient } = renderWithQueryClient(<PreferenceProbe />, container);
    try {
      expect(container.textContent).toBe("true");
      const key = taskCollectionPreferencesStorageKey({ companyId: "example-org", collectionKey: "paperclip:project-issues-view" });
      for (const [viewState, shown] of [
        [{ showAgentCreatedTasks: false }, true],
        [{ hideAgentCreatedTasks: true }, false],
        [{ hideAgentCreatedTasks: false }, true],
      ] as const) {
        await act(async () => {
          localStorage.setItem(key, JSON.stringify({ version: 1, companyId: "example-org", collectionKey: "paperclip:project-issues-view", viewState, columns: [] }));
          window.dispatchEvent(new StorageEvent("storage", { key }));
        });
        expect(container.textContent).toBe(String(shown));
      }
    } finally { act(() => root.unmount()); queryClient.clear(); }
  });

  it.each([true, false])("adopts old saved views and retains new checkbox choices across reload (streamlined=%s)", async (streamlined) => {
    const previousCompanyId = companyState.selectedCompanyId;
    companyState.selectedCompanyId = "example-org";
    localStorage.setItem("paperclip:test-issues:example-org", JSON.stringify({ showAgentCreatedTasks: false, sortField: "title", sortDir: "asc", groupBy: "priority" }));
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: streamlined });
    function PreferenceProbe() {
      const included = useShowAgentCreatedTasks("example-org", "paperclip:test-issues");
      return <span data-testid="creation-preference">{String(included)}</span>;
    }
    const manualIssue = createIssue({ id: "manual", title: "Manual issue", createdByUserId: "person", originKind: "manual" });
    const routineIssue = createIssue({ id: "routine", title: "Routine issue", originKind: "routine_execution" });
    const view = <><PreferenceProbe /><IssuesList
      issues={[manualIssue, routineIssue]} agents={[]} projects={[]} viewStateKey="paperclip:test-issues"
      enableAgentCreatedVisibilityFilter onUpdateIssue={() => undefined}
    /></>;
    let mounted = renderWithQueryClient(view, container, streamlined);
    const checkVisibility = async (shown: boolean) => waitForAssertion(() => {
      expect(container.textContent).toContain("Manual issue");
      expect(container.textContent?.includes("Routine issue")).toBe(shown);
      expect(container.querySelector("[data-testid='creation-preference']")?.textContent).toBe(String(shown));
    });
    const toggle = async () => {
      const label = () => Array.from(document.body.querySelectorAll("label")).find(
        (element) => element.textContent?.includes("Show agent-created tasks"),
      );
      if (!label()) await act(async () => {
        const button = Array.from(document.body.querySelectorAll("button")).find((element) => element.title.startsWith("Filter"));
        expect(button).toBeDefined();
        button!.click();
      });
      await waitForAssertion(() => expect(label()).toBeDefined());
      await act(async () => label()!.click());
    };
    const reload = () => {
      act(() => mounted.root.unmount());
      mounted.queryClient.clear();
      mounted = renderWithQueryClient(view, container, streamlined);
    };
    try {
      await checkVisibility(true);
      await toggle();
      await checkVisibility(false);
      const key = taskCollectionPreferencesStorageKey({ companyId: "example-org", collectionKey: "paperclip:test-issues" });
      expect(JSON.parse(localStorage.getItem(key)!).viewState).toMatchObject({ hideAgentCreatedTasks: true, sortField: "title", sortDir: "asc", groupBy: "priority" });
      reload();
      await checkVisibility(false);
      await toggle();
      await checkVisibility(true);
      reload();
      await checkVisibility(true);
    } finally {
      act(() => mounted.root.unmount());
      mounted.queryClient.clear();
      companyState.selectedCompanyId = previousCompanyId;
    }
  });
});
