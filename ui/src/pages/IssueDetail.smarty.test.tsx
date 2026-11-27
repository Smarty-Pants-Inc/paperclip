// @vitest-environment jsdom
// Only fork breadcrumb and guarded owed-message Retry wiring; upstream's broad page suite stays deleted.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IssueDetail, TaskDetailSurface } from "./IssueDetail";
const coordinatorPreference = vi.hoisted(() => ({ enabled: false, loaded: true }));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockIssueChatThreadRender = vi.hoisted(() => vi.fn());
const mockIssuesApi = vi.hoisted(() => Object.fromEntries([
  "get", "getCore", "recentComments", "list", "listAll", "listComments", "listAttachments", "listWorkProducts", "listInteractions",
  "listAcceptedPlanDecompositions", "getDocument", "listFeedbackVotes", "getQueuedComments", "markRead", "retryTask",
  "resolveRecoveryAction", "update", "recoveryActions", "getTreeControlState", "listTreeHolds",
].map(name => [name, vi.fn()])));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn(), listUserDirectory: vi.fn() }));
const mockActivityApi = vi.hoisted(() => Object.fromEntries([
  "forIssue", "recentForIssue", "inputFactsForIssue", "runsForIssue", "runsByIdsForIssue", "recentRunsForIssue",
].map(name => [name, vi.fn()])));
vi.mock("@/api/issues", async importOriginal => {
  const actual = await importOriginal<typeof import("@/api/issues")>();
  return { ...actual, issuesApi: Object.assign(actual.issuesApi, mockIssuesApi) };
});
vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForIssue: async () => [], activeRunForIssue: async () => null } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/decisions", () => ({ decisionsApi: { list: async () => [] } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: {
  getGeneral: async () => ({ feedbackDataSharingPreference: "prompt" }),
  getExperimental: async () => ({ enableStreamlinedUi: true, enableIssuePlanDecompositions: false, enableExperimentalFileViewer: false, enableExternalObjects: false }),
} }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => coordinatorPreference }));
vi.mock("@/hooks/usePageSettled", () => ({ usePageSettled: () => true, PAGE_SETTLED_MAX_WAIT_MS: 0 }));
vi.mock("@/hooks/useTaskPluginPanels", () => ({ useTaskPluginPanels: () => ({ panels: [], isLoading: false }), taskPluginPanelActivationKey: () => "" }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useLocation: () => ({ key: "fork-task", pathname: "/issues/PAP-1", search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate, useNavigationType: () => "PUSH", useParams: () => ({ issueId: "PAP-1", companyPrefix: "PAP" }),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({
  companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" }],
  selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
  loading: false, selectionSource: "manual", setSelectedCompanyId: vi.fn(),
}) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({
  setBreadcrumbs: mockSetBreadcrumbs, setBreadcrumbToolbar: vi.fn(), setBreadcrumbPanelControl: vi.fn(), setMobileToolbar: vi.fn(),
}) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({
  openPanel: vi.fn(), closePanel: vi.fn(), panelVisible: true, setPanelVisible: vi.fn(), requestPanelMaximize: vi.fn(), clearPanelMaximizeRequest: vi.fn(),
}) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/hooks/useProjectOrder", () => ({ useProjectOrder: ({ projects }: { projects: unknown[] }) => ({ orderedProjects: projects }) }));
vi.mock("@/plugins/slots", () => ({ PluginSlotMount: () => null, PluginSlotOutlet: () => null, usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }) }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
// The page's recovery eligibility and useTaskRetry remain real. Only the heavy composer is replaced.
vi.mock("../components/TaskChatThread", () => ({ TaskChatThread: (props: { threadHeader?: ReactNode; onTryAgainNoLiveExecutionPath?: () => void }) => {
  mockIssueChatThreadRender(props);
  return <div>{props.threadHeader}{props.onTryAgainNoLiveExecutionPath && <button onClick={props.onTryAgainNoLiveExecutionPath}>Retry saved message</button>}</div>;
} }));
vi.mock("../components/IssueChatThread", () => ({ IssueChatThread: () => null }));
vi.mock("../components/InlineEditor", () => ({ InlineEditor: ({ value }: { value: string }) => <div>{value}</div> }));
vi.mock("../components/IssueDocumentsSection", () => ({ IssueDocumentsSection: () => null }));
vi.mock("../components/IssuesList", () => ({ IssuesList: () => null }));
vi.mock("../components/IssueProperties", () => ({ IssueProperties: () => null }));
vi.mock("../components/task-side-panel", () => ({ TaskSidePanel: () => null }));
vi.mock("../components/IssueRunLedger", () => ({ IssueRunLedger: () => null }));
vi.mock("../components/IssueWorkspaceCard", () => ({ IssueWorkspaceCard: () => null }));
vi.mock("../components/ImageGalleryModal", () => ({ ImageGalleryModal: () => null }));
vi.mock("../components/ScrollToBottom", () => ({ ScrollToBottom: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Issue detail smoke",
    description: "Loads after the initial pending query.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    createdByAgentId: null,
    createdByUserId: null,
    identifier: "PAP-1",
    issueNumber: 1,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: "default",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    ancestors: [],
    documentSummaries: [],
    ...overrides,
  } as Issue;
}
function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "CodexCoder",
    urlKey: "codexcoder",
    role: "engineer",
    title: "Software Engineer",
    icon: "code",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    ...overrides,
  };
}

async function flushReact() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function waitForAssertion(assertion: () => void) { await vi.waitFor(assertion, { timeout: 1000, interval: 10 }); }
describe("fork task detail contracts", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  function renderIssueView(children: ReactNode = <IssueDetail />) {
    root.render(<QueryClientProvider client={queryClient}><TooltipProvider>{children}</TooltipProvider></QueryClientProvider>);
  }
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
    coordinatorPreference.enabled = false;
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], true);
    for (const method of ["list", "listAll", "listComments", "listAttachments", "listWorkProducts", "listInteractions", "listAcceptedPlanDecompositions", "listFeedbackVotes", "recoveryActions", "listTreeHolds"]) mockIssuesApi[method].mockResolvedValue([]);
    for (const method of Object.values(mockActivityApi)) method.mockResolvedValue([]);
    mockIssuesApi.getCore.mockImplementation(id => mockIssuesApi.get(id));
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [], latestCommentId: null, hasMore: false });
    mockIssuesApi.getDocument.mockResolvedValue(null);
    mockIssuesApi.getQueuedComments.mockResolvedValue({ queueId: null, state: null, targetRunId: null, entries: [], revision: 0 });
    mockIssuesApi.getTreeControlState.mockResolvedValue({ activePauseHold: null });
    mockIssuesApi.markRead.mockResolvedValue({ id: "issue-1", lastReadAt: new Date().toISOString() });
    mockAuthApi.getSession.mockResolvedValue({ session: null, user: null });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ companyIds: ["company-1"], isInstanceAdmin: true, source: "session", userId: null });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); queryClient.clear(); container.remove();
    localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  it.each([false, true])("keeps an existing conversation on its agent-addressed route (Coordinator %s)", async (coordinator) => {
    coordinatorPreference.enabled = coordinator;
    const agent = createAgent();
    const canonical = createIssue({ conversationAgentId: agent.id, conversationUserId: "user-1", conversationState: "waiting", status: "in_review" });
    mockIssuesApi.get.mockResolvedValue(canonical);
    await act(async () => {
      renderIssueView(<TaskDetailSurface conversation={{ agent, issue: canonical, ensureIssue: async () => canonical }} />);
    });
    await flushReact();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockIssuesApi.markRead).not.toHaveBeenCalled();
    const [breadcrumbs] = mockSetBreadcrumbs.mock.calls.at(-1)!;
    expect(breadcrumbs).toEqual([{ label: "All chats", href: "/chats" }, { label: agent.name }]);
    const updatedAgent = { ...agent, name: "Updated agent" };
    await act(async () => {
      renderIssueView(<TaskDetailSurface conversation={{ agent: updatedAgent, issue: canonical, ensureIssue: async () => canonical }} />);
    });
    await flushReact();
    expect(mockSetBreadcrumbs.mock.calls.at(-1)![0]).toEqual([{ label: "All chats", href: "/chats" }, { label: updatedAgent.name }]);

  });

  it("wires the owed-message Retry to the guarded task endpoint rather than resource settlement", async () => {
    const interruption: NonNullable<Issue["interruption"]> = { intentId: null, responsibility: "system", state: "failed",
      nextRetryAt: null, canRetry: true, userAction: null, sourceRunIds: ["owed-run"], observedRunId: "owed-run",
      unansweredCommentId: "owed-message" };
    const issue = createIssue({ status: "blocked", assigneeAgentId: "agent-1", conversationAgentId: "agent-1",
      conversationUserId: "chat-owner", conversationState: "active", interruption });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "chat-owner" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "chat-owner", source: "session",
      isInstanceAdmin: false, companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "operator" }] });
    mockIssuesApi.retryTask.mockResolvedValue({ requestId: "owed-retry", accepted: true, stale: false, presentation: interruption });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.onTryAgainNoLiveExecutionPath)
      .toEqual(expect.any(Function)));
    await act(async () => mockIssueChatThreadRender.mock.calls.at(-1)![0].onTryAgainNoLiveExecutionPath());
    await waitForAssertion(() => expect(mockIssuesApi.retryTask).toHaveBeenCalledExactlyOnceWith(issue.id, {
      idempotencyKey: expect.any(String), observedRunId: "owed-run",
    }));
    expect(mockIssuesApi.resolveRecoveryAction).not.toHaveBeenCalled();
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
  });
});
