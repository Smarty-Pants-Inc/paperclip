import { TaskChatPausedTakeover, type TaskComposerPause } from "../components/task-chat/TaskChatPausedTakeover";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IssueRecoveryActionCard } from "../components/IssueRecoveryActionCard";
// @vitest-environment jsdom

import type { Breadcrumb } from "../context/BreadcrumbContext";

import { DispositionRecoveryNotice, type DispositionRecoverySnapshot } from "../components/DispositionRecoveryNotice";
import { RichWorkProductCard } from "../components/task-chat/RichWorkProductCard";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  Issue,
  IssueAttachment,
  IssueComment,
  IssueRecentComments,
  IssueQueuedCommentQueue,
  RequestConfirmationInteraction,
  IssueTreeControlPreview,
  IssueTreeHold,
  IssueWorkProduct,
  Project,
} from "@paperclipai/shared";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactElement,
  ReactNode,
} from "react";
import { NavigationType } from "react-router-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  canBoardManageRuntime,
  canBoardResolveRecoveryAction,
  IssueDetail,
  TaskDetailSurface,
  readRecoveryReconcileWorkspaceId,
  shouldScrollIssueDetailToTopOnNavigation,
} from "./IssueDetail";
import { queryKeys } from "../lib/queryKeys";
import { prefetchIssueDetailForNavigation } from "../lib/issueDetailCache";
import { markCachedSession } from "../lib/cached-session";
import { startPersistedQueryCache } from "../lib/persisted-query-cache";
import { clearLocalInboxArchive, filterLocalInboxArchivedIssues, getLocalInboxArchiveIssueIds } from "../lib/inboxArchiveCache";
import { taskPluginPanelActivationKey } from "@/hooks/useTaskPluginPanels";
import {
  armIssueDetailInboxQuickArchive,
  createIssueDetailLocationState,
  readIssueDetailBreadcrumb,
  rememberIssueDetailLocationState,
} from "../lib/issueDetailBreadcrumb";
import { getRecentTasksStorageKey, readRecentTasks } from "../lib/recent-tasks";
import { getLastProjectId, trackRecentProject } from "../lib/recent-projects";
import { ApiError } from "../api/client";
import type { issuesApi } from "../api/issues";

// These page fixtures exercise Classic task behavior. Preference identity and
// persistence have their own hook tests; keep their readiness explicit here.
const coordinatorPreference = vi.hoisted(() => ({ enabled: false, loaded: true }));
const inlineEditorFixture = vi.hoisted(() => ({ real: false }));
// Set by one row (C1) to the REAL TaskChatComposer, loaded with vi.importActual;
// the TaskChatThread stub then renders it in place of its own takeover.
const taskChatComposerFixture = vi.hoisted(() => ({
  Real: null as null | ((props: Record<string, unknown>) => ReactElement | null),
}));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => coordinatorPreference,
}));
// Set by the steering placement rows to the REAL TaskChatThread (vi.importActual);
// the TaskChatThread stub then renders it with IssueDetail's own props.
const taskChatThreadFixture = vi.hoisted(() => ({
  Real: null as null | ((props: Record<string, unknown>) => ReactElement | null),
}));
// The real composer's rich editor cannot take typing under jsdom. When `stub`
// is on, a plain stand-in keeps the composer's own value/onChange/onSubmit
// contract (Enter = submit), as TaskChatThread.test's editor stand-in does.
const markdownEditorFixture = vi.hoisted(() => ({ stub: false, change: (_value: string) => {} }));
vi.mock("@/components/MarkdownEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/MarkdownEditor")>();
  const React = await import("react");
  const StandIn = React.forwardRef(function StandInMarkdownEditor(
    props: { value: string; onChange: (value: string) => void; onSubmit?: () => void },
    ref: React.ForwardedRef<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {}, clear: () => props.onChange("") }));
    markdownEditorFixture.change = props.onChange;
    return React.createElement("textarea", {
      "data-testid": "stand-in-editor",
      value: props.value,
      readOnly: true,
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          props.onSubmit?.();
        }
      },
    });
  });
  const MarkdownEditor = React.forwardRef(function MarkdownEditorSwitch(props: never, ref) {
    return markdownEditorFixture.stub
      ? React.createElement(StandIn, { ...(props as object), ref } as never)
      : React.createElement(actual.MarkdownEditor, { ...(props as object), ref } as never);
  });
  return { ...actual, MarkdownEditor };
});
// The real issuesApi.addComment (its own request body and receipt check), kept
// before the file's mocks replace it; the steering rows replay it through fetch.
const realIssuesApiFns = vi.hoisted(() => ({
  addComment: null as null | ((...args: unknown[]) => Promise<unknown>),
  reads: {} as Pick<typeof issuesApi, "get" | "getCore" | "listComments" | "recentComments">,
}));

const mockGrokBotApi = vi.hoisted(() => ({ stop: vi.fn().mockResolvedValue({ stopped: true }) }));
vi.mock("../api/grokBot", () => ({ grokBotApi: mockGrokBotApi }));

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  getCore: vi.fn(),
  getComment: vi.fn(),
  recentComments: vi.fn(),
  list: vi.fn(),
  listAll: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  listWorkProducts: vi.fn(),
  checkMonitorNow: vi.fn(),
  listFeedbackVotes: vi.fn(),
  listInteractions: vi.fn(),
  getQueuedComments: vi.fn(),
  interruptQueuedComments: vi.fn(),
  editQueuedComment: vi.fn(),
  reorderQueuedComments: vi.fn(),
  steerQueuedComment: vi.fn(),
  discardQueuedComment: vi.fn(),
  markRead: vi.fn(),
  update: vi.fn(),
  resolveRecoveryAction: vi.fn(),
  recoveryActions: vi.fn(),
  recoverWorkspace: vi.fn(),
  retryTask: vi.fn(),
  previewTreeControl: vi.fn(),
  getTreeControlState: vi.fn(),
  listTreeHolds: vi.fn(),
  createTreeHold: vi.fn(),
  releaseTreeHold: vi.fn(),
  archiveFromInbox: vi.fn(),
  unarchiveFromInbox: vi.fn(),
  addComment: vi.fn(),
  cancelComment: vi.fn(),
  deleteComment: vi.fn(),
  upsertFeedbackVote: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  upsertDocument: vi.fn(),
  getDocument: vi.fn(),
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
}));

const mockActivityApi = vi.hoisted(() => ({
  forIssue: vi.fn(),
  recentForIssue: vi.fn(),
  inputFactsForIssue: vi.fn(),
  runsForIssue: vi.fn(),
  runsByIdsForIssue: vi.fn(),
  recentRunsForIssue: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  events: vi.fn(),
  conversationEvents: vi.fn(),
  log: vi.fn(),
  get: vi.fn(),
  liveRunsForIssue: vi.fn(),
  activeRunForIssue: vi.fn(),
  cancel: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockDecisionsApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({
  key: "task-entry",
  pathname: "/issues/PAP-1",
  search: "",
  hash: "",
  state: null as unknown,
}));
const mockOpenPanel = vi.hoisted(() => vi.fn());
const mockClosePanel = vi.hoisted(() => vi.fn());
const mockSetPanelVisible = vi.hoisted(() => vi.fn());
const mockRequestPanelMaximize = vi.hoisted(() => vi.fn());
const mockClearPanelMaximizeRequest = vi.hoisted(() => vi.fn());
const mockPanelState = vi.hoisted(() => ({ panelVisible: true }));
const mockRouteParams = vi.hoisted(() => ({
  issueId: "PAP-1",
  companyPrefix: "PAP",
}));
const mockSidebarState = vi.hoisted(() => ({ isMobile: false }));
const mockIssuePropertiesRender = vi.hoisted(() => vi.fn());
const mockTaskSidePanelRender = vi.hoisted(() => vi.fn());
const mockTaskPluginPanels = vi.hoisted(() => ({ panels: [] as import("@/hooks/useTaskPluginPanels").TaskPluginPanel[], isLoading: false }));
vi.mock("@/hooks/useTaskPluginPanels", async importOriginal => ({
  ...await importOriginal<typeof import("@/hooks/useTaskPluginPanels")>(),
  useTaskPluginPanels: () => mockTaskPluginPanels,
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbToolbar = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbPanelControl = vi.hoisted(() => vi.fn());
const mockSetMobileToolbar = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockIssuesListRender = vi.hoisted(() => vi.fn());
const mockIssueChatThreadRender = vi.hoisted(() => vi.fn());
const mockImageGalleryRender = vi.hoisted(() => vi.fn());
const mockIssueWorkspaceCardRender = vi.hoisted(() => vi.fn());
const DIRECT_ADAPTER_TYPES = [
  "codex_local",
  "claude_local",
  "opencode_local",
  "process",
  "http",
  "custom_plugin",
] as const;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ?? ResizeObserverStub;

vi.mock("../api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issues")>();
  realIssuesApiFns.addComment = actual.issuesApi.addComment as never;
  const { get, getCore, listComments, recentComments } = actual.issuesApi;
  realIssuesApiFns.reads = { get, getCore, listComments, recentComments };
  // Keep composed API operations real while replacing their request methods.
  // This also exercises the current-revision check used by both queue surfaces.
  return { ...actual, issuesApi: Object.assign(actual.issuesApi, mockIssuesApi) };
});

vi.mock("../api/email", () => ({
  emailApi: { thread: vi.fn().mockResolvedValue(null) },
}));

vi.mock("../api/activity", () => ({
  activityApi: mockActivityApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/decisions", () => ({
  decisionsApi: mockDecisionsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    issueQuicklookSide: _issueQuicklookSide,
    issueQuicklookAlign: _issueQuicklookAlign,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
    issueQuicklookSide?: unknown;
    issueQuicklookAlign?: unknown;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => ({ ...mockRouteParams }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: "company-1",
        name: "Paperclip",
        issuePrefix: "PAP",
        status: "active",
      },
    ],
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Paperclip",
      issuePrefix: "PAP",
      status: "active",
    },
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockOpenNewProject = vi.hoisted(() => vi.fn());
const mockOpenNewGoal = vi.hoisted(() => vi.fn());

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: mockOpenNewIssue,
  }),
  useDialogActions: () => ({
    openNewIssue: mockOpenNewIssue,
    openNewProject: mockOpenNewProject,
    openNewGoal: mockOpenNewGoal,
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: mockOpenPanel,
    closePanel: mockClosePanel,
    panelVisible: mockPanelState.panelVisible,
    setPanelVisible: mockSetPanelVisible,
    requestPanelMaximize: mockRequestPanelMaximize,
    clearPanelMaximizeRequest: mockClearPanelMaximizeRequest,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebarState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
    setBreadcrumbToolbar: mockSetBreadcrumbToolbar,
    setBreadcrumbPanelControl: mockSetBreadcrumbPanelControl,
    setMobileToolbar: mockSetMobileToolbar,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
}));

vi.mock("../components/InlineEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/InlineEditor")>();
  return {
    InlineEditor: (props: Parameters<typeof actual.InlineEditor>[0]) => inlineEditorFixture.real
      ? <actual.InlineEditor {...props} />
      : <div>{props.value || props.placeholder}</div>,
  };
});

vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: (props: {
    onWorkModeChange?: (workMode: string) => void;
    issueWorkMode?: string;
    comments?: Array<{
      body: string;
      clientStatus?: string;
      queueState?: string;
      queueTargetRunId?: string | null;
    }>;
    onAdd?: (body: string) => Promise<void>;
    onInterruptQueued?: (runId: string) => Promise<void>;
    onStopRun?: (runId: string) => Promise<void>;
    stopRunLabel?: string;
    stoppingRunLabel?: string;
    runFinalizationActions?: readonly {
      id: string;
      label: string;
      onSelect: (runId: string) => Promise<void> | void;
    }[];
    composerPause?: TaskComposerPause | null;
    footer?: ReactNode;
  }) => {
    mockIssueChatThreadRender(props);
    return (
      <div data-testid="issue-chat-thread">
        Chat thread
        {props.onStopRun ? (
          <button
            type="button"
            onClick={() => void props.onStopRun?.("run-active-1")}
          >
            {props.stopRunLabel ?? "Stop run"}
          </button>
        ) : null}
        {props.runFinalizationActions?.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void action.onSelect("run-active-1")}
          >
            {action.label}
          </button>
        ))}
        {props.composerPause ? <TaskChatPausedTakeover {...props.composerPause} /> : null}
        {props.footer}
      </div>
    );
  },
}));

// The task chat thread pulls in the MarkdownEditor composer, whose @mdxeditor
// dependency cannot load under jsdom's CSSOM. The stub keeps the suite
// unit-scoped but still renders the threadHeader JSX (the issue header row
// lives inside the thread) so header controls stay testable, records its props
// on the shared thread-render spy, and exposes the same run-control buttons as
// the IssueChatThread stub above.
vi.mock("../components/TaskChatThread", () => ({
  TaskChatThread: (props: {
    recoveryAction?: NonNullable<Issue["activeRecoveryAction"]>;
    onResolveRecoveryAction?: (outcome: import("../components/IssueRecoveryActionCard").RecoveryResolveOutcome) => void;
    comments?: Array<{ metadata?: { recovery?: DispositionRecoverySnapshot } | null }>;
    workProducts?: IssueWorkProduct[];
    threadHeader?: ReactNode;
    onStopRun?: (runId: string) => Promise<void>;
    stopRunLabel?: string;
    onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
    onRejectInteraction?: (
      interaction: RequestConfirmationInteraction,
      reason?: string,
    ) => Promise<void>;
    runFinalizationActions?: readonly {
      id: string;
      label: string;
      onSelect: (runId: string) => Promise<void> | void;
    }[];
    composerPause?: TaskComposerPause | null;
    conversationMode?: boolean;
    draftKey?: string;
    composerDisabledReason?: string | null;
    footer?: ReactNode;
  }) => {
    mockIssueChatThreadRender(props);
    const RealThread = taskChatThreadFixture.Real;
    if (RealThread) return <RealThread {...(props as Record<string, unknown>)} />;
    const RealComposer = taskChatComposerFixture.Real;
    return (
      <div data-testid="task-chat-thread">
        {props.threadHeader}
        Task chat thread
        {props.recoveryAction ? (
          <IssueRecoveryActionCard action={props.recoveryAction} onResolve={props.onResolveRecoveryAction} />
        ) : null}
        {props.comments?.map((comment, index) => comment.metadata?.recovery ? <DispositionRecoveryNotice key={index} snapshot={comment.metadata.recovery} /> : null)}
        {props.workProducts?.map((workProduct) => (
          <RichWorkProductCard
            key={workProduct.id}
            workProduct={workProduct}
            href={workProduct.url}
          />
        ))}
        {props.onStopRun ? (
          <button
            type="button"
            onClick={() => void props.onStopRun?.("run-active-1")}
          >
            {props.stopRunLabel ?? "Stop run"}
          </button>
        ) : null}
        {props.onTryAgainNoLiveExecutionPath ? (
          <button
            type="button"
            data-testid="mock-no-live-path-try-again"
            onClick={() => void props.onTryAgainNoLiveExecutionPath?.()}
          >
            Try again
          </button>
        ) : null}
        {props.runFinalizationActions?.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void action.onSelect("run-active-1")}
          >
            {action.label}
          </button>
        ))}
        {RealComposer ? (
          <RealComposer
            pause={props.composerPause ?? null}
            conversationMode={props.conversationMode}
            draftKey={props.draftKey}
            disabledReason={props.composerDisabledReason}
            onAdd={async () => undefined}
          />
        ) : props.composerPause ? <TaskChatPausedTakeover {...props.composerPause} /> : null}
        {props.footer}
      </div>
    );
  },
}));

vi.mock("../components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: () => <div>Documents</div>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: { issueBadgeById?: Map<string, string> }) => {
    mockIssuesListRender(props);
    return (
      <div>
        Sub-issues
        {Array.from(props.issueBadgeById?.entries() ?? []).map(
          ([issueId, label]) => (
            <span key={issueId}>
              {issueId}:{label}
            </span>
          ),
        )}
      </div>
    );
  },
}));

vi.mock("../components/IssueProperties", () => ({
  IssueProperties: (props: unknown) => {
    mockIssuePropertiesRender(props);
    return <div>Properties</div>;
  },
}));

vi.mock("../components/task-side-panel", () => ({
  TaskSidePanel: (props: unknown) => {
    mockTaskSidePanelRender(props);
    return <div>Task side panel</div>;
  },
}));

vi.mock("../components/IssueRunLedger", () => ({
  IssueRunLedger: () => <div>Runs</div>,
}));

vi.mock("../components/IssueWorkspaceCard", () => ({
  IssueWorkspaceCard: (props: {
    onBrowseFiles?: () => void;
    onOpenFileByPath?: () => void;
  }) => {
    mockIssueWorkspaceCardRender(props);
    return <div>Workspace</div>;
  },
}));

vi.mock("../components/ImageGalleryModal", () => ({
  ImageGalleryModal: (props: {
    items: IssueAttachment[];
    initialIndex: number;
    open: boolean;
  }) => {
    mockImageGalleryRender(props);
    return null;
  },
}));

vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: () => null,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({
    status,
    blockerAttention,
    onChange,
  }: {
    status: string;
    blockerAttention?: Issue["blockerAttention"];
    onChange?: (status: string) => void;
  }) =>
    onChange ? (
      <button
        type="button"
        aria-label={`Change status (current: ${status})`}
        data-status-icon-state={blockerAttention?.state}
        onClick={() => onChange("done")}
      >
        {status}
      </button>
    ) : (
      <span data-status-icon-state={blockerAttention?.state}>{status}</span>
    ),
}));

vi.mock("../components/PriorityIcon", () => ({
  PriorityIcon: ({
    priority,
    onChange,
  }: {
    priority: string;
    onChange?: (priority: string) => void;
  }) =>
    onChange ? (
      <button
        type="button"
        aria-label={`Change priority (current: ${priority})`}
        onClick={() => onChange("high")}
      >
        {priority}
      </button>
    ) : (
      <span>{priority}</span>
    ),
}));

vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: () => <div>Approval</div>,
}));

vi.mock("../components/Identity", () => ({
  deriveInitials: (name: string) => name.slice(0, 2),
  Identity: ({ name, shape }: { name: string; shape?: string }) => (
    <span data-shape={shape ?? "circle"}>{name}</span>
  ),
}));

vi.mock("@/components/ui/button", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  buttonVariants: () => "",
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
    asChild?: boolean;
  }) => (
    <button {...props} type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/separator", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  Separator: () => <hr />,
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/popover", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/dialog", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => (
    <div data-slot="dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogDescription: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <p className={className}>{children}</p>,
  DialogFooter: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogHeader: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogTitle: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <h2 className={className}>{children}</h2>,
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/sheet", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  Sheet: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({
    children,
    className,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => (
    <div data-slot="sheet-content" className={className} data-testid={testId}>
      {children}
      <button type="button" data-slot="sheet-close">
        Close
      </button>
    </div>
  ),
  SheetHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
  SheetTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/scroll-area", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/skeleton", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  Skeleton: () => <div data-testid="skeleton" />,
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/tabs", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  Tabs: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsContent: ({
    children,
    className,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => (
    <div className={className} data-testid={testId}>
      {children}
    </div>
  ),
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

vi.mock("@/components/ui/textarea", async (importOriginal) => {
  // While the steering rows render the REAL thread, every export is the real one;
  // otherwise the stubs below, and any export they do not replace stays real.
  const actual = await importOriginal<Record<string, unknown>>();
  const React = await import("react");
  const stubs: Record<string, unknown> = {
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  };
  return { ...actual, ...Object.fromEntries(Object.entries(stubs).map(([key, Stub]) => [key,
    !actual[key] ? Stub
      // A helper (e.g. buttonVariants) switches per call; a component per render.
      : /^[a-z]/.test(key) ? (...args: unknown[]) =>
        ((taskChatThreadFixture.Real ? actual[key] : Stub) as (...a: unknown[]) => unknown)(...args)
      : React.forwardRef(function UiSwitch(props: object, ref) {
        return React.createElement((taskChatThreadFixture.Real ? actual[key] : Stub) as never, { ...props, ref } as never);
      })])) };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function createTooltipRoot(container: Element): Root {
  const root = createRoot(container);
  return {
    render(children) {
      root.render(<TooltipProvider>{children}</TooltipProvider>);
    },
    unmount() {
      root.unmount();
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

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

function createIssueComment(
  overrides: Partial<IssueComment> = {},
): IssueComment {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Fresh comment",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-04-21T00:00:05.000Z"),
    updatedAt: new Date("2026-04-21T00:00:05.000Z"),
    ...overrides,
  };
}

function createQueuedCommentQueue(
  overrides: Partial<IssueQueuedCommentQueue> = {},
): IssueQueuedCommentQueue {
  const comment = createIssueComment({
    id: "queued-comment-1",
    body: "Queued through the handoff",
  });
  return {
    issueId: "issue-1",
    queueId: "wake-queue-1",
    state: "deferred",
    targetRunId: "run-active-1",
    revision: "queue-revision-1",
    protocol: "paperclip_runner_v1",
    steeringDisposition: "available",
    entries: [{ comment, position: 0, canEdit: true, canDiscard: true }],
    ...overrides,
  };
}

function createAttachment(
  overrides: Partial<IssueAttachment> & { id: string },
): IssueAttachment {
  const { id, ...attachmentOverrides } = overrides;
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: `asset-${id}`,
    provider: "local_disk",
    objectKey: `attachments/${id}`,
    contentType: overrides.contentType ?? "application/octet-stream",
    byteSize: overrides.byteSize ?? 4096,
    sha256: "sha256",
    originalFilename: overrides.originalFilename ?? null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    contentPath: overrides.contentPath ?? `/api/attachments/${id}/content`,
    openPath: overrides.openPath ?? `/api/attachments/${id}/content`,
    downloadPath:
      overrides.downloadPath ?? `/api/attachments/${id}/content?download=1`,
    ...attachmentOverrides,
  };
}

function createArtifactWorkProduct(
  overrides: Partial<IssueWorkProduct> & {
    id: string;
    attachmentId: string;
    contentType: string;
    originalFilename: string;
  },
): IssueWorkProduct {
  const {
    id,
    attachmentId,
    contentType,
    originalFilename,
    ...workProductOverrides
  } = overrides;
  const contentPath = `/api/attachments/${attachmentId}/content`;
  return {
    id,
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: overrides.title ?? originalFilename,
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: {
      attachmentId,
      contentType,
      byteSize: 4096,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename,
    },
    createdByRunId: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    ...workProductOverrides,
  } as IssueWorkProduct;
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

function createPauseHold(
  overrides: Partial<IssueTreeHold> = {},
): IssueTreeHold {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "hold-1",
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "pause",
    status: "active",
    reason: null,
    releasePolicy: { strategy: "manual", note: "full_pause" },
    createdByActorType: "user",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdByRunId: null,
    releasedAt: null,
    releasedByActorType: null,
    releasedByAgentId: null,
    releasedByUserId: null,
    releasedByRunId: null,
    releaseReason: null,
    releaseMetadata: null,
    createdAt: now,
    updatedAt: now,
    members: [
      {
        id: "hold-member-root",
        companyId: "company-1",
        holdId: "hold-1",
        issueId: "issue-1",
        parentIssueId: null,
        depth: 0,
        issueIdentifier: "PAP-1",
        issueTitle: "Issue detail smoke",
        issueStatus: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRunId: null,
        activeRunStatus: null,
        skipped: false,
        skipReason: null,
        createdAt: now,
      },
      {
        id: "hold-member-child",
        companyId: "company-1",
        holdId: "hold-1",
        issueId: "child-1",
        parentIssueId: "issue-1",
        depth: 1,
        issueIdentifier: "PAP-2",
        issueTitle: "Held child",
        issueStatus: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRunId: null,
        activeRunStatus: null,
        skipped: false,
        skipReason: null,
        createdAt: now,
      },
    ],
    ...overrides,
  };
}

function createResumePreview(): IssueTreeControlPreview {
  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "resume",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: 2,
      affectedIssues: 2,
      skippedIssues: 0,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 1,
    },
    countsByStatus: { todo: 2 },
    issues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["hold-1"],
        action: "resume",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Held child",
        status: "todo",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["hold-1"],
        action: "resume",
        skipped: false,
        skipReason: null,
      },
    ],
    skippedIssues: [],
    activeRuns: [],
    affectedAgents: [{ agentId: "agent-1", issueCount: 2, activeRunCount: 0 }],
    warnings: [],
  };
}

function createPausePreview(): IssueTreeControlPreview {
  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "pause",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: 3,
      affectedIssues: 2,
      skippedIssues: 1,
      activeRuns: 1,
      queuedRuns: 0,
      affectedAgents: 0,
    },
    countsByStatus: { todo: 2 },
    issues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Paused child",
        status: "in_review",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-2",
        identifier: "PAP-3",
        title: "Completed child",
        status: "done",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: true,
        skipReason: "terminal_status",
      },
    ],
    skippedIssues: [
      {
        id: "child-2",
        identifier: "PAP-3",
        title: "Completed child",
        status: "done",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: true,
        skipReason: "terminal_status",
      },
    ],
    activeRuns: [],
    affectedAgents: [],
    warnings: [],
  };
}

function createRestorePreview(): IssueTreeControlPreview {
  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "restore",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: 2,
      affectedIssues: 1,
      skippedIssues: 1,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 1,
    },
    countsByStatus: { todo: 1, cancelled: 1 },
    issues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "restore",
        skipped: true,
        skipReason: "not_cancelled",
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Cancelled child",
        status: "cancelled",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["cancel-hold-1"],
        action: "restore",
        skipped: false,
        skipReason: null,
      },
    ],
    skippedIssues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "restore",
        skipped: true,
        skipReason: "not_cancelled",
      },
    ],
    activeRuns: [],
    affectedAgents: [{ agentId: "agent-1", issueCount: 1, activeRunCount: 0 }],
    warnings: [],
  };
}

function createCancelPreview(issueCount = 8): IssueTreeControlPreview {
  const issues = Array.from({ length: issueCount }, (_, index) => ({
    id: index === 0 ? "issue-1" : `child-${index}`,
    identifier: index === 0 ? "PAP-1" : `PAP-${index + 1}`,
    title: index === 0 ? "Issue detail smoke" : `Cancellable child ${index}`,
    status: "todo" as const,
    parentId: index === 0 ? null : "issue-1",
    depth: index === 0 ? 0 : 1,
    assigneeAgentId: null,
    assigneeUserId: null,
    activeRun: null,
    activeHoldIds: [],
    action: "cancel" as const,
    skipped: false,
    skipReason: null,
  }));

  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "cancel",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: issueCount,
      affectedIssues: issueCount,
      skippedIssues: 0,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 0,
    },
    countsByStatus: { todo: issueCount },
    issues,
    skippedIssues: [],
    activeRuns: [],
    affectedAgents: [],
    warnings: [],
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

// Steering placement (steer-ui2). PLANTED, verbatim: the bodies the REAL
// server at neworg/steer-server-c3 (69c95176) answered in neworg-lead's own
// rows in server/src/__tests__/agent-chat-steering.test.ts, captured once with
// a temporary hook (since removed):
//   S-a2 (following text=true): its default POST (steeringStatus 'accepted')
//     and the later thread GET (steeringStatus 'delivered', seq 18);
//   S-f explicit Queue: its POST (deliveryIntent 'queue'), the thread GET and
//     the queued-comments GET.
const STEER_A2_POST_RESPONSE = {"id": "9583981a-c88f-4b2c-baf8-7267730ebdb9", "companyId": "ef9c2ddd-2e52-4280-b50e-9f012683b3f8", "issueId": "bb0c55ce-d401-42e1-b4c9-d24ac00ae59a", "authorAgentId": null, "authorUserId": "chat-owner", "onBehalfOfUserId": null, "authorType": "user", "createdByRunId": null, "derivedAuthorAgentId": null, "derivedCreatedByRunId": null, "derivedAuthorSource": null, "clientRequestId": "9beb8f07-4ea4-49b8-95e7-6aee3f6e971f", "conversationSessionGeneration": null, "origin": "comment", "fastResponseRequestId": null, "body": "Pi must read this after the held tool", "presentation": null, "metadata": null, "deletedAt": null, "deletedByType": null, "deletedByAgentId": null, "deletedByUserId": null, "deletedByRunId": null, "sourceTrust": null, "createdAt": "2026-11-19T07:43:59.580Z", "updatedAt": "2026-11-19T07:43:59.580Z", "steeredIntoRunId": "b28003b2-ffb0-4baa-b81a-0959f15d5966", "steeredAt": "2026-11-19T07:43:59.598Z", "steeringStatus": "accepted", "steeringDeliveryEventSeq": null} as const;
const STEER_A2_THREAD_GET_DELIVERED = [{"id": "9583981a-c88f-4b2c-baf8-7267730ebdb9", "companyId": "ef9c2ddd-2e52-4280-b50e-9f012683b3f8", "issueId": "bb0c55ce-d401-42e1-b4c9-d24ac00ae59a", "authorAgentId": null, "authorUserId": "chat-owner", "onBehalfOfUserId": null, "authorType": "user", "createdByRunId": null, "derivedAuthorAgentId": null, "derivedCreatedByRunId": null, "derivedAuthorSource": null, "clientRequestId": "9beb8f07-4ea4-49b8-95e7-6aee3f6e971f", "conversationSessionGeneration": null, "origin": "comment", "fastResponseRequestId": null, "body": "Pi must read this after the held tool", "presentation": null, "metadata": null, "deletedAt": null, "deletedByType": null, "deletedByAgentId": null, "deletedByUserId": null, "deletedByRunId": null, "sourceTrust": null, "createdAt": "2026-11-19T07:43:59.580Z", "updatedAt": "2026-11-19T07:43:59.580Z", "steeredIntoRunId": "b28003b2-ffb0-4baa-b81a-0959f15d5966", "steeredAt": "2026-11-19T07:43:59.598Z", "steeringStatus": "delivered", "steeringDeliveryEventSeq": 18}, {"id": "25718a32-40e5-4482-98ce-e4c641e3da2c", "companyId": "ef9c2ddd-2e52-4280-b50e-9f012683b3f8", "issueId": "bb0c55ce-d401-42e1-b4c9-d24ac00ae59a", "authorAgentId": null, "authorUserId": "chat-owner", "onBehalfOfUserId": null, "authorType": "user", "createdByRunId": null, "derivedAuthorAgentId": null, "derivedCreatedByRunId": null, "derivedAuthorSource": null, "clientRequestId": null, "conversationSessionGeneration": null, "origin": "comment", "fastResponseRequestId": null, "body": "First message", "presentation": null, "metadata": null, "deletedAt": null, "deletedByType": null, "deletedByAgentId": null, "deletedByUserId": null, "deletedByRunId": null, "sourceTrust": null, "createdAt": "2026-11-19T07:43:59.459Z", "updatedAt": "2026-11-19T07:43:59.459Z", "steeredIntoRunId": null, "steeredAt": null, "steeringStatus": null, "steeringDeliveryEventSeq": null}] as const;
const QUEUE_SF_POST_RESPONSE = {"id": "aa2e7da8-2ed1-4854-a6e8-a255289791c6", "companyId": "4dd77ee4-6ac3-4727-ae38-39b73985af2e", "issueId": "dd731e54-4d0f-4462-bb3f-8da5e3e31352", "authorAgentId": null, "authorUserId": "chat-owner", "onBehalfOfUserId": null, "authorType": "user", "createdByRunId": null, "derivedAuthorAgentId": null, "derivedCreatedByRunId": null, "derivedAuthorSource": null, "clientRequestId": "ab689719-04b5-4271-b65b-cb7abecf83f4", "conversationSessionGeneration": null, "origin": "comment", "fastResponseRequestId": null, "body": "Queue deliberately", "presentation": null, "metadata": null, "deletedAt": null, "deletedByType": null, "deletedByAgentId": null, "deletedByUserId": null, "deletedByRunId": null, "sourceTrust": null, "createdAt": "2026-11-19T07:44:01.735Z", "updatedAt": "2026-11-19T07:44:01.735Z", "steeredIntoRunId": null, "steeredAt": null, "steeringStatus": null, "steeringDeliveryEventSeq": null} as const;
const QUEUE_SF_THREAD_GET = [{"id": "aa2e7da8-2ed1-4854-a6e8-a255289791c6", "companyId": "4dd77ee4-6ac3-4727-ae38-39b73985af2e", "issueId": "dd731e54-4d0f-4462-bb3f-8da5e3e31352", "authorAgentId": null, "authorUserId": "chat-owner", "onBehalfOfUserId": null, "authorType": "user", "createdByRunId": null, "derivedAuthorAgentId": null, "derivedCreatedByRunId": null, "derivedAuthorSource": null, "clientRequestId": "ab689719-04b5-4271-b65b-cb7abecf83f4", "conversationSessionGeneration": null, "origin": "comment", "fastResponseRequestId": null, "body": "Queue deliberately", "presentation": null, "metadata": null, "deletedAt": null, "deletedByType": null, "deletedByAgentId": null, "deletedByUserId": null, "deletedByRunId": null, "sourceTrust": null, "createdAt": "2026-11-19T07:44:01.735Z", "updatedAt": "2026-11-19T07:44:01.735Z", "steeredIntoRunId": null, "steeredAt": null, "steeringStatus": null, "steeringDeliveryEventSeq": null}, {"id": "a34b1ede-69b0-4c65-a68a-ec54fce4dbb5", "companyId": "4dd77ee4-6ac3-4727-ae38-39b73985af2e", "issueId": "dd731e54-4d0f-4462-bb3f-8da5e3e31352", "authorAgentId": null, "authorUserId": "chat-owner", "onBehalfOfUserId": null, "authorType": "user", "createdByRunId": null, "derivedAuthorAgentId": null, "derivedCreatedByRunId": null, "derivedAuthorSource": null, "clientRequestId": null, "conversationSessionGeneration": null, "origin": "comment", "fastResponseRequestId": null, "body": "First message", "presentation": null, "metadata": null, "deletedAt": null, "deletedByType": null, "deletedByAgentId": null, "deletedByUserId": null, "deletedByRunId": null, "sourceTrust": null, "createdAt": "2026-11-19T07:44:01.695Z", "updatedAt": "2026-11-19T07:44:01.695Z", "steeredIntoRunId": null, "steeredAt": null, "steeringStatus": null, "steeringDeliveryEventSeq": null}] as const;
const QUEUE_SF_QUEUED_COMMENTS_GET = {"issueId": "dd731e54-4d0f-4462-bb3f-8da5e3e31352", "queueId": "40779553-6ebe-4b70-98fe-0b3d25c5da98", "state": "deferred", "targetRunId": "52289e09-b836-4484-abd1-e420b9886128", "revision": "a0320dbbe9024a480a94dd567a02c8a9", "protocol": "paperclip_runner_v1", "steeringDisposition": "available", "entries": [{"comment": {"id": "aa2e7da8-2ed1-4854-a6e8-a255289791c6", "companyId": "4dd77ee4-6ac3-4727-ae38-39b73985af2e", "issueId": "dd731e54-4d0f-4462-bb3f-8da5e3e31352", "authorAgentId": null, "authorUserId": "chat-owner", "onBehalfOfUserId": null, "authorType": "user", "createdByRunId": null, "derivedAuthorAgentId": null, "derivedCreatedByRunId": null, "derivedAuthorSource": null, "clientRequestId": "ab689719-04b5-4271-b65b-cb7abecf83f4", "conversationSessionGeneration": null, "origin": "comment", "fastResponseRequestId": null, "body": "Queue deliberately", "presentation": null, "metadata": null, "deletedAt": null, "deletedByType": null, "deletedByAgentId": null, "deletedByUserId": null, "deletedByRunId": null, "sourceTrust": null, "createdAt": "2026-11-19T07:44:01.735Z", "updatedAt": "2026-11-19T07:44:01.735Z"}, "position": 0, "canEdit": true, "canDiscard": true, "behindReset": false}]} as const;
// steer-ui4 (SUPERSEDE-STEER-UI-NO-CLIENT-GUESS-1119): the S-f POST body as the steer
// server head answers it. neworg/steer-B3-c3 3d4ef657 server/src/services/conversation-steering.ts:232-233
// adds `deliveryOutcome` ('queued': the comment waits in a deferred wake) and
// `steeringUnavailableReason` (null: an explicit Queue, not a refused steer) to the same
// body. DERIVED from QUEUE_SF_POST_RESPONSE (captured at 69c95176) plus those two server
// fields; not re-captured.
const QUEUE_SF_POST_RESPONSE_SAYS_QUEUED = { ...QUEUE_SF_POST_RESPONSE, deliveryOutcome: "queued", steeringUnavailableReason: null } as const;

describe("IssueDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function renderIssueView(children: ReactNode = <IssueDetail />) {
    root.render(
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    );
  }

  beforeEach(() => {
    Object.assign(coordinatorPreference, { enabled: false, loaded: true });
    inlineEditorFixture.real = false;
    taskChatComposerFixture.Real = null;
    taskChatThreadFixture.Real = null;
    markdownEditorFixture.stub = false;
    mockTaskPluginPanels.panels = []; mockTaskPluginPanels.isLoading = false;
    localStorage.clear();
    sessionStorage.clear();
    mockPanelState.panelVisible = true;
    mockSidebarState.isMobile = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createTooltipRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], true);
    mockIssuesApi.getCore.mockImplementation((id) => mockIssuesApi.get(id));
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [], latestCommentId: null, hasMore: false });
    mockActivityApi.recentRunsForIssue.mockResolvedValue([]);
    mockActivityApi.runsByIdsForIssue.mockResolvedValue([]);
    mockActivityApi.recentForIssue.mockResolvedValue([]);
    mockActivityApi.inputFactsForIssue.mockResolvedValue([]);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "# Attachment preview",
    } as Response);

    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listAll.mockImplementation((...args) => mockIssuesApi.list(...args));
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listAttachments.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);
    mockIssuesApi.recoveryActions.mockReset();
    mockIssuesApi.recoverWorkspace.mockReset();
    mockIssuesApi.retryTask.mockReset();
    mockIssuesApi.checkMonitorNow.mockReset();
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockIssuesApi.listInteractions.mockResolvedValue([]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(
      createQueuedCommentQueue({
        queueId: null,
        state: null,
        targetRunId: null,
        entries: [],
      }),
    );
    mockIssuesApi.interruptQueuedComments.mockReset().mockResolvedValue(createQueuedCommentQueue());
    mockIssuesApi.editQueuedComment.mockResolvedValue(
      createQueuedCommentQueue(),
    );
    mockIssuesApi.reorderQueuedComments.mockResolvedValue(
      createQueuedCommentQueue(),
    );
    mockIssuesApi.steerQueuedComment.mockResolvedValue(
      createQueuedCommentQueue(),
    );
    mockIssuesApi.discardQueuedComment.mockResolvedValue(
      createQueuedCommentQueue({ entries: [] }),
    );
    mockIssuesApi.markRead.mockResolvedValue({
      id: "issue-1",
      lastReadAt: new Date().toISOString(),
    });
    mockIssuesApi.archiveFromInbox.mockResolvedValue({
      id: "issue-1",
      archivedAt: new Date(),
    });
    mockIssuesApi.unarchiveFromInbox.mockResolvedValue({ ok: true });
    mockIssuesApi.getTreeControlState.mockResolvedValue({
      activePauseHold: null,
    });
    mockIssuesApi.listTreeHolds.mockResolvedValue([]);
    mockActivityApi.forIssue.mockResolvedValue([]);
    mockActivityApi.runsForIssue.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    mockHeartbeatsApi.events.mockResolvedValue([]);
    mockHeartbeatsApi.conversationEvents.mockResolvedValue([]);
    mockHeartbeatsApi.log.mockResolvedValue({ content: "", nextOffset: 0 });
    mockAgentsApi.list.mockResolvedValue([]);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      companyIds: ["company-1"],
      isInstanceAdmin: true,
      source: "session",
      keyId: null,
      user: null,
      userId: null,
    });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockAuthApi.getSession.mockResolvedValue({ session: null, user: null });
    mockProjectsApi.list.mockResolvedValue([]);
    mockDecisionsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: true,
    });
    mockIssuesApi.listAcceptedPlanDecompositions.mockResolvedValue([]);
    mockIssuesApi.getDocument.mockResolvedValue(null);
    mockOpenPanel.mockClear();
    mockClosePanel.mockClear();
    mockSetPanelVisible.mockClear();
    mockRequestPanelMaximize.mockClear();
    mockClearPanelMaximizeRequest.mockClear();
    mockSetBreadcrumbPanelControl.mockClear();
    mockSetMobileToolbar.mockClear();
    mockIssuePropertiesRender.mockClear();
    mockTaskSidePanelRender.mockClear();
    mockIssuesListRender.mockClear();
    mockIssueChatThreadRender.mockClear();
    mockImageGalleryRender.mockClear();
    mockIssueWorkspaceCardRender.mockClear();
    mockNavigate.mockClear();
    mockOpenNewIssue.mockClear();
    mockOpenNewProject.mockClear();
    mockOpenNewGoal.mockClear();
    mockPushToast.mockClear();
    mockLocation.pathname = "/issues/PAP-1";
    mockLocation.search = "";
    mockLocation.hash = "";
    mockLocation.state = null;
    mockRouteParams.issueId = "PAP-1";
    mockRouteParams.companyPrefix = "PAP";
  });

  it("R6 real IssueDetail path renders the system-interrupted refreshed card and retries current B", async () => {
      const evidenceDir = process.env.JUDGE_EVIDENCE_DIR;
      const fixturePath = [resolve(process.cwd(), "ui/src/__fixtures__/refused-card-from-get.json"),
        resolve(process.cwd(), "../ui/src/__fixtures__/refused-card-from-get.json")].find(existsSync)!;
      const action = JSON.parse(readFileSync(fixturePath, "utf8")) as NonNullable<Issue["activeRecoveryAction"]>;
      const manifest = {
        issueId: action.sourceIssueId,
        companyId: action.companyId,
        userId: "local-board",
        actionId: action.id,
        B: String(action.evidence.latestRunId),
        agent: createAgent({ id: action.returnOwnerAgentId ?? "agent-1", companyId: action.companyId }),
      };
      const issue = createIssue({
        id: manifest.issueId,
        companyId: manifest.companyId,
        identifier: String(action.evidence.sourceIdentifier ?? "R6-1"),
        status: "blocked",
        assigneeAgentId: manifest.agent.id,
        activeRecoveryAction: action,
        interruption: {
          intentId: null, responsibility: "system", state: "failed", nextRetryAt: null,
          canRetry: false, userAction: null, sourceRunIds: [manifest.B], observedRunId: manifest.B,
        },
      });
      const trace: Array<Record<string, any>> = [];
      const http = async (method: string, path: string, body?: unknown): Promise<any> => {
        const value = method === "GET" ? issue : { issue, recoveryAction: action };
        trace.push({ method, path, request: body, status: 200,
          actionId: issue.activeRecoveryAction?.id,
          sourceRunId: issue.activeRecoveryAction?.evidence?.latestRunId,
          responsibility: issue.interruption?.responsibility,
        });
        if (evidenceDir) writeFileSync(`${evidenceDir}/ui-request-trace.json`, JSON.stringify(trace, null, 2));
        return value;
      };
      mockRouteParams.issueId = manifest.issueId;
      mockLocation.pathname = `/issues/${manifest.issueId}`;
      mockIssuesApi.get.mockImplementation((id: string) => http("GET", `/api/issues/${id}`));
      mockIssuesApi.resolveRecoveryAction.mockImplementation((id: string, body: unknown) =>
        http("POST", `/api/issues/${id}/recovery-actions/resolve`, body));
      mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ companyIds: [manifest.companyId], isInstanceAdmin: true,
        source: "local_implicit", keyId: null, user: null, userId: manifest.userId });
      mockAgentsApi.list.mockResolvedValue([manifest.agent]);
      mockAuthApi.getSession.mockResolvedValue({ session: { userId: manifest.userId }, user: { id: manifest.userId } });

      const initial = await http("GET", `/api/issues/${manifest.issueId}`);
      expect(initial.interruption?.responsibility).toBe("system");
      expect(initial.activeRecoveryAction?.status).toBe("active");
      expect(initial.activeRecoveryAction?.evidence.latestRunId).toBe(manifest.B);
      expect(initial.activeRecoveryAction?.evidence.taskRetryRefusal.currentRunId).toBe(manifest.B);
      mockRouteParams.issueId = initial.identifier ?? initial.id;
      mockLocation.pathname = `/issues/${mockRouteParams.issueId}`;
      queryClient.setQueryData([...queryKeys.issues.detail(mockRouteParams.issueId), "core"], initial);
      await act(async () => renderIssueView());

      let pageProps: any;
      await waitForAssertion(() => {
        pageProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
        expect(pageProps?.issueId).toBe(manifest.issueId);
        expect(pageProps?.recoveryAction?.id).toBe(initial.activeRecoveryAction.id);
        expect(document.querySelector('[data-testid="task-retry-source-refusal"]')).not.toBeNull();
      }, 100);
      const trigger = document.querySelector<HTMLButtonElement>('[data-testid="recovery-action-resolve-trigger"]');
      expect(trigger).not.toBeNull();
      await act(async () => trigger!.click());
      const retry = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find(button => button.querySelector("span")?.textContent?.trim() === "Try again");
      expect(retry).toBeDefined();
      expect(retry!.disabled).toBe(false);
      await act(async () => retry!.click());
      await waitForAssertion(() => expect(trace.filter(entry => entry.method === "POST")).toHaveLength(1), 100);
      const post = trace.find(entry => entry.method === "POST")!;
      expect(post.status).toBe(200);
      expect(post.request).toEqual({ actionId: manifest.actionId, sourceRunId: manifest.B,
        outcome: "restored", sourceIssueStatus: "todo" });
      await waitForAssertion(() => expect(trace.some(entry => entry.method === "GET" && entry.sourceRunId === manifest.B)).toBe(true), 100);
      if (evidenceDir) writeFileSync(`${evidenceDir}/ui-loopback-result.json`, JSON.stringify({ post, pageProps: {
        recoveryActionId: pageProps.recoveryAction.id,
        recoverySourceRunId: pageProps.recoveryAction.evidence.latestRunId,
        interruptionResponsibility: initial.interruption.responsibility,
      }, passed: true }, null, 2));
    }, 60_000);

  it("clears only the monitor after confirmation and refreshes the task", async () => {
    const nextCheckAt = new Date(Date.now() + 60_000).toISOString();
    const preservedPolicy = { mode: "normal", commentRequired: false, stages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "user", userId: "reviewer-1" }] }], maxReviewRounds: 4, authorizationPolicy: { assignmentPolicy: { mode: "protected" } } };
    const policy = { ...preservedPolicy, monitor: { nextCheckAt, scheduledBy: "board", notes: "Check deployment" } } as Issue["executionPolicy"];
    const monitored = createIssue({ status: "in_progress", executionPolicy: policy, executionState: { monitor: { status: "scheduled", nextCheckAt, attemptCount: 1 } } as Issue["executionState"] });
    const cleared = createIssue({ status: "in_progress", executionPolicy: preservedPolicy as Issue["executionPolicy"] });
    mockIssuesApi.get.mockResolvedValue(monitored);
    mockIssuesApi.update.mockImplementation(async () => {
      mockIssuesApi.get.mockResolvedValue(cleared);
      return cleared;
    });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('[aria-label="Cancel monitor"]')).not.toBeNull());
    await act(async () => (container.querySelector('[aria-label="Cancel monitor"]') as HTMLButtonElement).click());
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
    await act(async () => Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Cancel monitor")!.click());
    await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledWith(monitored.id, { expectedExecutionPolicy: policy, executionPolicy: preservedPolicy }));
    await waitForAssertion(() => expect(container.querySelector('[aria-label="Cancel monitor"]')).toBeNull());
  });

  it.each([false, true])("keeps monitor errors on the checked task (late response: %s)", async (lateResponse) => {
    const monitor = { monitor: { status: "scheduled", nextCheckAt: new Date(Date.now() + 60_000).toISOString(), attemptCount: 1, serviceName: "github" } } as Issue["executionState"];
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", executionState: monitor }));
    const check = createDeferred<never>();
    mockIssuesApi.checkMonitorNow.mockReturnValue(check.promise);
    await act(async () => renderIssueView());
    let button: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Check now");
      expect(button).toBeTruthy();
    });
    await act(async () => button!.click());
    if (!lateResponse) {
      check.reject(new Error("First task monitor failed"));
      await waitForAssertion(() => expect(container.textContent).toContain("First task monitor failed"));
    }
    const second = createIssue({ id: "issue-2", identifier: "PAP-2", title: "Second monitored task", status: "in_progress", executionState: monitor });
    mockIssuesApi.get.mockResolvedValue(second);
    queryClient.setQueryData(queryKeys.issues.detail("PAP-2"), second);
    mockRouteParams.issueId = "PAP-2";
    mockLocation.pathname = "/issues/PAP-2";
    await act(async () => renderIssueView());
    if (lateResponse) check.reject(new Error("First task monitor failed"));
    await flushReact();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Second monitored task");
      expect(container.textContent).not.toContain("First task monitor failed");
      expect(Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === "Check now")?.disabled).toBe(false);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  describe.each(["read", "archive"] as const)("cached task %s account gate", action => {
    it.each(["cached-owner", "other-owner", null])("waits for fresh identity before applying a write (verified=%s)", async verified => {
      const issue = createIssue({ title: "Restored task" });
      const verification = createDeferred<{ user: { id: string } } | null>();
      mockAuthApi.getSession.mockReturnValue(verification.promise);
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "cached-owner" } });
      const cache = startPersistedQueryCache(queryClient, { storage: null, buildId: "test", eventTarget: null });
      markCachedSession(queryClient);
      mockIssuesApi.get.mockReturnValue(new Promise(() => {}));
      const ref = mockRouteParams.issueId!;
      queryClient.setQueryData(queryKeys.issues.detail(ref), issue);
      queryClient.setQueryData([...queryKeys.issues.detail(ref), "core"], issue);
      const inboxKey = [...queryKeys.issues.listMineByMe(issue.companyId), "with-routine-executions", "live-descendant-summary"];
      queryClient.setQueryData(inboxKey, [issue]);
      mockLocation.state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");
      mockIssuesApi.markRead.mockClear();
      mockIssuesApi.archiveFromInbox.mockClear();
      mockNavigate.mockClear();
      try {
        await act(async () => renderIssueView());
        await waitForAssertion(() => expect(container.textContent).toContain(issue.title));
        if (action === "archive") {
          await waitForAssertion(() => expect(container.querySelector('button[aria-label="More task actions"]')).not.toBeNull());
          const more = container.querySelector<HTMLButtonElement>('button[aria-label="More task actions"]');
          await act(async () => more!.click());
          const archive = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
            .find(button => button.textContent?.trim() === "Archive from inbox");
          expect(archive).toBeDefined();
          await act(async () => archive!.click());
          await flushReact();
          expect(mockIssuesApi.archiveFromInbox).not.toHaveBeenCalled();
          expect(queryClient.getQueryData(inboxKey)).toEqual([issue]);
        } else {
          await flushReact();
          expect(mockIssuesApi.markRead).not.toHaveBeenCalled();
        }
        expect(mockNavigate).not.toHaveBeenCalled();
        await act(async () => { verification.resolve(verified ? { user: { id: verified } } : null); });
        await waitForAssertion(() => expect(queryClient.isMutating()).toBe(0));
        expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(verified === "cached-owner" ? 1 : 0);
        expect(mockIssuesApi.archiveFromInbox).toHaveBeenCalledTimes(action === "archive" && verified === "cached-owner" ? 1 : 0);
        if (verified !== "cached-owner") expect(mockNavigate).not.toHaveBeenCalled();
      } finally {
        verification.resolve(null);
        await flushReact();
        cache.dispose();
      }
    });
  });

  describe.each([false, true])("pending archive account cleanup (unmounted=%s)", unmounted => {
    it.each(["success", "failure"] as const)("releases the old account's guard after %s without changing the new account's rows", async outcome => {
      const issue = createIssue({ title: "Old account task" });
      const freshIssue = { ...issue, title: "Fresh account task" };
      const archive = createDeferred<{ id: string; archivedAt: Date }>();
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "old-owner" } });
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "old-owner" } });
      mockIssuesApi.get.mockResolvedValue(issue);
      mockIssuesApi.archiveFromInbox.mockReturnValue(archive.promise);
      const inboxKey = queryKeys.issues.listMineByMe(issue.companyId);
      queryClient.setQueryData(inboxKey, [issue]);
      mockLocation.state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");
      try {
        await act(async () => renderIssueView());
        await waitForAssertion(() => expect(container.querySelector('button[aria-label="More task actions"]')).not.toBeNull());
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More task actions"]')!.click());
        const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
          .find(entry => entry.textContent?.trim() === "Archive from inbox")!;
        await act(async () => button.click());
        await waitForAssertion(() => expect(getLocalInboxArchiveIssueIds(issue.companyId).has(issue.id)).toBe(true));
        await waitForAssertion(() => expect(mockIssuesApi.archiveFromInbox).toHaveBeenCalledWith(issue.id));
        mockNavigate.mockClear();
        mockPushToast.mockClear();
        await act(async () => {
          queryClient.setQueryData(queryKeys.auth.session, null);
          queryClient.setQueryData(queryKeys.auth.session, { user: { id: "new-owner" } });
          queryClient.setQueryData(inboxKey, [freshIssue]);
          if (unmounted) root.unmount();
        });
        await act(async () => {
          if (outcome === "success") archive.resolve({ id: issue.id, archivedAt: new Date() });
          else archive.reject(new Error("Old account archive failed"));
        });
        await waitForAssertion(() => expect(queryClient.isMutating()).toBe(0));
        expect(getLocalInboxArchiveIssueIds(issue.companyId).has(issue.id)).toBe(false);
        expect(filterLocalInboxArchivedIssues(issue.companyId, [freshIssue])).toEqual([freshIssue]);
        expect(queryClient.getQueryData(inboxKey)).toEqual([freshIssue]);
        expect(mockNavigate).not.toHaveBeenCalled();
        expect(mockPushToast).not.toHaveBeenCalled();
      } finally {
        archive.resolve({ id: issue.id, archivedAt: new Date() });
        clearLocalInboxArchive(issue.companyId, issue.id);
      }
    });
  });

  it.each(["cached-owner", "other-owner", null])("retries an opened task's read receipt after session recovery only for its original account (verified=%s)", async verified => {
    const issue = createIssue({ title: "Task awaiting a verified read receipt" });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "cached-owner" } });
    const cache = startPersistedQueryCache(queryClient, { storage: null, buildId: "test", eventTarget: null });
    markCachedSession(queryClient);
    mockAuthApi.getSession.mockRejectedValue(new ApiError("Try again later", 429, {}));
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.markRead.mockClear();
    try {
      await act(async () => renderIssueView());
      await waitForAssertion(() => expect(queryClient.isMutating()).toBeGreaterThan(0));
      await act(async () => {
        await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0), { timeout: 3_000, interval: 10 });
      });
      expect(mockAuthApi.getSession.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mockIssuesApi.markRead).not.toHaveBeenCalled();
      const attempts = mockAuthApi.getSession.mock.calls.length;
      await act(async () => renderIssueView());
      await flushReact();
      expect(queryClient.isMutating()).toBe(0);
      expect(mockAuthApi.getSession).toHaveBeenCalledTimes(attempts);
      mockAuthApi.getSession.mockResolvedValue(verified ? { user: { id: verified } } : null);
      await act(async () => {
        await queryClient.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: () => mockAuthApi.getSession(), retry: false, staleTime: 0 });
      });
      await flushReact();
      await waitForAssertion(() => expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(verified === "cached-owner" ? 1 : 0));
      await waitForAssertion(() => expect(queryClient.isMutating()).toBe(0));
      expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(verified === "cached-owner" ? 1 : 0);
      if (verified === "cached-owner") {
        await act(async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(mockRouteParams.issueId!) });
          await queryClient.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: () => mockAuthApi.getSession(), staleTime: 0 });
        });
        await flushReact();
        expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(1);
      }
    } finally { cache.dispose(); }
  });

  it.each(["success", "failure"] as const)("marks every opened cached task before an earlier read finishes with %s", async outcome => {
    const tasks = [createIssue(), createIssue({ id: "second-task", identifier: "TASK-2" }), createIssue({ id: "third-task", identifier: "TASK-3" })];
    const reads = tasks.map(() => createDeferred<{ id: string; lastReadAt: string }>());
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "reader" } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "reader" } });
    mockIssuesApi.get.mockImplementation(async ref => tasks.find(task => task.id === ref || task.identifier === ref)!);
    mockIssuesApi.markRead.mockReset().mockImplementation(id => reads[tasks.findIndex(task => task.id === id)].promise);
    try {
      for (const [index, task] of tasks.entries()) {
        queryClient.setQueryData(queryKeys.issues.detail(task.id), task);
        queryClient.setQueryData([...queryKeys.issues.detail(task.id), "core"], task);
        mockRouteParams.issueId = task.id;
        mockLocation.pathname = `/issues/${task.id}`;
        await act(async () => renderIssueView());
        await waitForAssertion(() => expect(mockIssuesApi.markRead).toHaveBeenNthCalledWith(index + 1, task.id));
      }
      expect(queryClient.isMutating()).toBe(3);
      await act(async () => root.unmount());
      await act(async () => {
        if (outcome === "failure") reads[0].reject(new ApiError("Try again later", 429, {}));
        else reads[0].resolve({ id: tasks[0].id, lastReadAt: new Date().toISOString() });
        for (let index = 1; index < reads.length; index++) reads[index].resolve({ id: tasks[index].id, lastReadAt: new Date().toISOString() });
      });
      await waitForAssertion(() => expect(queryClient.isMutating()).toBe(0));
      expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(3);
    } finally {
      reads.forEach((read, index) => read.resolve({ id: tasks[index].id, lastReadAt: new Date().toISOString() }));
      await flushReact();
    }
  });

  it("reuses an earlier task's pending read and recovers it independently of a later task's read", async () => {
    const first = createIssue();
    const second = createIssue({ id: "second-task", identifier: "TASK-2" });
    const firstRead = createDeferred<{ id: string; lastReadAt: string }>();
    const secondRead = createDeferred<{ id: string; lastReadAt: string }>();
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "reader" } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "reader" } });
    mockIssuesApi.get.mockImplementation(async ref => ref === second.id ? second : first);
    mockIssuesApi.markRead.mockReset()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
      .mockResolvedValue({ id: first.id, lastReadAt: new Date().toISOString() });
    const openTask = async (task: Issue) => {
      queryClient.setQueryData(queryKeys.issues.detail(task.id), task);
      queryClient.setQueryData([...queryKeys.issues.detail(task.id), "core"], task);
      mockRouteParams.issueId = task.id;
      mockLocation.pathname = `/issues/${task.id}`;
      await act(async () => renderIssueView());
    };
    try {
      await openTask(first);
      await waitForAssertion(() => expect(mockIssuesApi.markRead).toHaveBeenNthCalledWith(1, first.id));
      await openTask(second);
      await waitForAssertion(() => expect(mockIssuesApi.markRead).toHaveBeenNthCalledWith(2, second.id));
      await openTask(first);
      await flushReact();
      expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(2);
      await act(async () => {
        await queryClient.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: () => mockAuthApi.getSession(), staleTime: 0 });
      });
      await flushReact();
      expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(2);
      await act(async () => firstRead.reject(new ApiError("Try again later", 429, {})));
      await waitForAssertion(() => expect(mockIssuesApi.markRead).toHaveBeenNthCalledWith(3, first.id));
      await waitForAssertion(() => expect(queryClient.isMutating()).toBe(1));
      expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(3);
      await act(async () => secondRead.resolve({ id: second.id, lastReadAt: new Date().toISOString() }));
      await waitForAssertion(() => expect(queryClient.isMutating()).toBe(0));
      expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(3);
    } finally {
      firstRead.resolve({ id: first.id, lastReadAt: new Date().toISOString() });
      secondRead.resolve({ id: second.id, lastReadAt: new Date().toISOString() });
      await flushReact();
    }
  });

  it("does not loop a failed read receipt and retries it after a new successful session read", async () => {
    const issue = createIssue();
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "reader" } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "reader" } });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.markRead.mockClear();
    mockIssuesApi.markRead.mockRejectedValueOnce(new ApiError("Try again later", 429, {}));
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(1));
    await waitForAssertion(() => expect(queryClient.isMutating()).toBe(0));
    await act(async () => renderIssueView());
    await flushReact();
    expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      await queryClient.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: () => mockAuthApi.getSession(), staleTime: 0 });
    });
    await waitForAssertion(() => expect(mockIssuesApi.markRead).toHaveBeenCalledTimes(2));
    await waitForAssertion(() => expect(queryClient.isMutating()).toBe(0));
  });

  it.each(["new-project", null])("remembers project %s only after its task update succeeds", async (projectId) => {
    const issue = createIssue({ projectId: "original-project" });
    trackRecentProject("original-project", issue.companyId);
    const failedUpdate = createDeferred<Issue>();
    const successfulUpdate = createDeferred<Issue>();
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.update.mockClear();
    mockIssuesApi.update.mockReturnValueOnce(failedUpdate.promise).mockReturnValueOnce(successfulUpdate.promise);
    await act(async () => renderIssueView());
    let properties!: { onUpdate: (data: Record<string, unknown>) => void };
    await waitForAssertion(() => {
      properties = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children?.props;
      expect(properties?.onUpdate).toBeTypeOf("function");
    });
    await act(async () => properties.onUpdate({ projectId }));
    await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledTimes(1));
    expect(getLastProjectId(issue.companyId)).toBe("original-project");
    await act(async () => failedUpdate.reject(new Error("Project save failed")));
    await waitForAssertion(() => expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't update the task" })));
    expect(getLastProjectId(issue.companyId)).toBe("original-project");
    await act(async () => properties.onUpdate({ projectId }));
    await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledTimes(2));
    expect(getLastProjectId(issue.companyId)).toBe("original-project");
    await act(async () => successfulUpdate.resolve({ ...issue, projectId }));
    await waitForAssertion(() => expect(getLastProjectId(issue.companyId)).toBe(projectId ?? ""));
    expect(getLastProjectId("company-2")).toBeUndefined();
  });

  it("waits for the personal workspace preference before exposing task controls", async () => {
    coordinatorPreference.loaded = false;
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => renderIssueView());
    await flushReact();
    expect(mockIssueChatThreadRender).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="task-detail-presentation-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-task-chat-shell]')).toBeNull();
    expect(container.querySelector('[data-testid="issue-detail-header"]')).toBeNull();
    expect(mockOpenPanel).not.toHaveBeenCalled();
    coordinatorPreference.loaded = true;
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender).toHaveBeenCalled());
  });

  it("keeps a restored title draft when a fresh task read finds a newer title", async () => {
    inlineEditorFixture.real = true;
    coordinatorPreference.loaded = false;
    const issue = createIssue({ title: "Cached title A" });
    const fresh = { ...issue, title: "New title C" };
    const owner = "title-draft-user";
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: owner } });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: owner } });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.getCore.mockImplementation(async (_id, options) => options?.cache === "no-store" ? fresh : issue);
    mockIssuesApi.update.mockClear();
    const key = `paperclip:inline-draft:v2:${owner}:issue:${issue.id}:title`;
    localStorage.setItem(key, JSON.stringify({ version: 1, draft: "Restored title B", base: issue.title }));
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssuesApi.getCore).toHaveBeenCalledWith(issue.id, { cache: "no-store", fresh: true }));
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
    await act(async () => {
      queryClient.setQueryData(queryKeys.issues.detail(issue.identifier!), fresh);
      queryClient.setQueryData([...queryKeys.issues.detail(issue.identifier!), "core"], fresh);
    });
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="issue-detail-header"] textarea')?.value).toBe("Restored title B");
    expect(localStorage.getItem(key)).toContain("Restored title B");
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
  });

  it.each(["save", "failure", "escape", "unchanged", "navigate"])("retains the early title through preference readiness until %s", async (exit) => {
    inlineEditorFixture.real = true;
    coordinatorPreference.loaded = false;
    const issue = createIssue();
    const save = createDeferred<Issue>();
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.update.mockReset().mockReturnValue(save.promise);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "title-editor-user" } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "title-editor-user" } });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('[data-testid="issue-detail-header"] h2')).not.toBeNull());
    await act(async () => (container.querySelector('[data-testid="issue-detail-header"] h2') as HTMLElement).click());
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="issue-detail-header"] textarea')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    coordinatorPreference.loaded = true;
    await act(async () => renderIssueView());
    expect(container.querySelector('[data-testid="issue-detail-header"] textarea')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(issue.title);
    expect(mockIssueChatThreadRender).not.toHaveBeenCalled();

    if (exit === "navigate") {
      const next = createIssue({ id: "issue-2", identifier: "PAP-2", title: "Another task" });
      mockIssuesApi.get.mockResolvedValue(next);
      mockRouteParams.issueId = "PAP-2";
      mockLocation.pathname = "/issues/PAP-2";
      await act(async () => renderIssueView());
      await waitForAssertion(() => expect(mockIssueChatThreadRender).toHaveBeenCalled());
      expect(container.textContent).toContain(next.title);
      expect(input.isConnected).toBe(false);
      expect(mockIssuesApi.update).not.toHaveBeenCalled();
      return;
    }
    if (exit === "save" || exit === "failure") {
      await act(async () => {
        const previous = input.value;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Retained title draft");
        (input as HTMLTextAreaElement & { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: exit === "escape" ? "Escape" : "Enter", bubbles: true })); });
    if (exit === "save" || exit === "failure") {
      await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledWith("PAP-1", { title: "Retained title draft" }));
      expect(container.querySelector('[data-testid="issue-detail-header"] textarea')).toBe(input);
      if (exit === "failure") {
        await act(async () => save.reject(new Error("Title save unavailable")));
        expect(container.querySelector('[data-testid="issue-detail-header"] textarea')).toBe(input);
        expect(input.value).toBe("Retained title draft");
        expect(mockIssueChatThreadRender).not.toHaveBeenCalled();
        return;
      }
      const updated = { ...issue, title: "Retained title draft" };
      mockIssuesApi.get.mockResolvedValue(updated);
      await act(async () => save.resolve(updated));
    } else {
      expect(mockIssuesApi.update).not.toHaveBeenCalled();
    }
    await waitForAssertion(() => expect(mockIssueChatThreadRender).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="issue-detail-header"] textarea')).toBeNull();
    expect(container.textContent).toContain(exit === "save" ? "Retained title draft" : issue.title);
  });

  it("retires an early title edit when navigating to a cached task with preferences still pending", async () => {
    inlineEditorFixture.real = true;
    coordinatorPreference.loaded = false;
    const first = createIssue();
    const second = createIssue({ id: "issue-2", identifier: "PAP-2", title: "Cached second task" });
    mockIssuesApi.get.mockImplementation(async (id) => id === "PAP-2" ? second : first);
    mockIssuesApi.update.mockReset();
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "pending-route-user" } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "pending-route-user" } });
    queryClient.setQueryData(queryKeys.issues.detail("PAP-2"), second);
    queryClient.setQueryData([...queryKeys.issues.detail("PAP-2"), "core"], second);
    queryClient.setQueryData(["issues", "history-expanded", "PAP-2"], true);
    const type = (input: HTMLTextAreaElement, value: string) => {
      const previous = input.value;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      (input as HTMLTextAreaElement & { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('[data-testid="issue-detail-header"] h2')).not.toBeNull());
    await act(async () => (container.querySelector('[data-testid="issue-detail-header"] h2') as HTMLElement).click());
    const firstInput = container.querySelector<HTMLTextAreaElement>('[data-testid="issue-detail-header"] textarea')!;
    await act(async () => type(firstInput, "Only the first task's draft"));
    mockRouteParams.issueId = "PAP-2";
    mockLocation.pathname = "/issues/PAP-2";
    await act(async () => renderIssueView());
    expect(firstInput.isConnected, "the cached destination must retire the first task's editor").toBe(false);
    expect(container.querySelector('[data-testid="issue-detail-header"] textarea')).toBeNull();
    const secondHeading = container.querySelector<HTMLElement>('[data-testid="issue-detail-header"] h2')!;
    expect(secondHeading.textContent).toBe(second.title);
    await act(async () => secondHeading.click());
    const secondInput = container.querySelector<HTMLTextAreaElement>('[data-testid="issue-detail-header"] textarea')!;
    expect(secondInput.value).toBe(second.title);
    await act(async () => type(secondInput, "Only the second task's draft"));
    coordinatorPreference.loaded = true;
    await act(async () => renderIssueView());
    expect(container.querySelector('[data-testid="issue-detail-header"] textarea')).toBe(secondInput);
    expect(document.activeElement).toBe(secondInput);
    expect(secondInput.value).toBe("Only the second task's draft");
    expect(mockIssueChatThreadRender).not.toHaveBeenCalled();
    await act(async () => { secondInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await waitForAssertion(() => expect(mockIssueChatThreadRender).toHaveBeenCalled());
    expect(container.textContent).toContain(second.title);
    expect(container.textContent).not.toContain("Only the first task's draft");
    expect(localStorage.getItem("paperclip:inline-draft:v2:pending-route-user:issue:issue-1:title")).toContain("Only the first task's draft");
    expect(localStorage.getItem("paperclip:inline-draft:v2:pending-route-user:issue:issue-2:title")).toBeNull();
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
  });

  it("supplies direct children and source-created tasks to the feed without promoting grandchildren", async () => {
    const issue = createIssue();
    const child = createIssue({ id: "child", parentId: issue.id, createdByAgentId: "agent-1" });
    const grandchild = createIssue({ id: "grandchild", parentId: child.id, createdByAgentId: "agent-1" });
    const followup = createIssue({ id: "followup", createdByAgentId: "agent-1" });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.listAll.mockImplementation(async (_companyId, filters) => filters?.createdFromIssueId ? [child, followup] : [child, grandchild]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.createdTasks).toEqual([child, child, followup]));
    const updated = { ...child, status: "done" };
    await act(async () => { queryClient.setQueryData(queryKeys.issues.listByDescendantRoot(issue.companyId, issue.id), [updated, grandchild]); });
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.createdTasks[0]).toMatchObject({ id: "child", status: "done" }));
  });

  it("keeps the conversation readable when created tasks fail to load and offers a retry", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.listAll.mockRejectedValue(new Error("Task read unavailable"));
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.textContent).toContain("Could not load created tasks."));
    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.initialHistoryError).toBe(false);
    mockIssuesApi.listAll.mockResolvedValue([]);
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    await waitForAssertion(() => expect(container.textContent).not.toContain("Could not load created tasks."));
  });

  it("loads standalone follow-up cards in the task feed when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: false, enableClassicTaskInterface: false });
    const issue = createIssue();
    const followup = createIssue({ id: "standalone", parentId: null, createdByAgentId: "agent-1" });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.listAll.mockImplementation(async (_companyId, filters) => filters?.createdFromIssueId ? [followup] : []);
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.createdTasks).toEqual([followup]));
    expect(container.querySelector('[data-testid="task-chat-thread"]')).not.toBeNull();
    expect(mockIssuesApi.listAll).toHaveBeenCalledWith(issue.companyId, { createdFromIssueId: issue.id, includeRoutineExecutions: true });
  });

  it("uses Coordinator task presentation and panel scope without changing the Classic preference", async () => {
    coordinatorPreference.enabled = true;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableStreamlinedUi: false,
      enableClassicTaskInterface: true,
    });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-thread"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="issue-chat-thread"]')).toBeNull();
    await waitForAssertion(() => expect(mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children?.props).toMatchObject({ accountScope: "coordinator:user-1" }));
    const editor = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children?.props.documentEditor;
    expect(editor).toMatchObject({ mentions: expect.any(Array), imageUploadHandler: expect.any(Function), onVote: expect.any(Function) });
    mockIssuesApi.uploadAttachment.mockResolvedValue(createAttachment({ id: "document-image" }));
    const image = new File(["image"], "document.png", { type: "image/png" });
    let uploaded: string | undefined;
    await act(async () => { uploaded = await editor.imageUploadHandler(image); });
    expect(uploaded).toBe(createAttachment({ id: "document-image" }).contentPath);
    expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledWith(createIssue().companyId, createIssue().id, image);
    coordinatorPreference.enabled = false;
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('[data-testid="issue-chat-thread"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="task-chat-thread"]')).toBeNull();
  });

  it("keeps a cold Coordinator task compact when Classic settings arrive before the workspace preference", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    coordinatorPreference.loaded = false;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: false, enableClassicTaskInterface: true });
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockInstanceSettingsApi.getExperimental).toHaveBeenCalled());
    await flushReact();
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    expect(mockActivityApi.forIssue).not.toHaveBeenCalled();
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    expect(container.querySelector('[data-task-chat-shell]')).toBeNull();
    expect(container.querySelector('[data-testid="task-detail-presentation-loading"]')).not.toBeNull();

    Object.assign(coordinatorPreference, { enabled: true, loaded: true });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({ compactHistory: true }));
    expect(mockIssuesApi.recentComments).toHaveBeenCalled();
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["issues", "history-expanded", "PAP-1"])).toBe(false);
  });

  it("does not post after the account changes while comment queries cancel", async () => {
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "account-a" } });
    mockIssuesApi.addComment.mockResolvedValue(createIssueComment({ body: "Account A retained text" }));
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => renderIssueView());
    await flushReact();
    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as { onAdd: (body: string) => Promise<void> };
    let release!: () => void;
    const cancellation = new Promise<void>(resolve => { release = resolve; });
    const cancel = vi.spyOn(queryClient, "cancelQueries").mockReturnValue(cancellation);
    let pending!: Promise<unknown>;
    try {
      await act(async () => { pending = props.onAdd("Account A retained text").catch(error => error); });
      await waitForAssertion(() => expect(cancel).toHaveBeenCalledTimes(2));
      await act(async () => {
        queryClient.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } });
        release();
      });
      const result = await pending;
      expect(mockIssuesApi.addComment).not.toHaveBeenCalled();
      expect(result).toMatchObject({ name: "AbortError" });
      await waitForAssertion(() => expect((mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.comments ?? []).some((comment: IssueComment) => comment.body === "Account A retained text")).toBe(false));
    } finally { release(); cancel.mockRestore(); }
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
    expect(breadcrumbs).toEqual([{ label: "Chat" }]);
    const updatedAgent = { ...agent, name: "Updated agent" };
    await act(async () => {
      renderIssueView(<TaskDetailSurface conversation={{ agent: updatedAgent, issue: canonical, ensureIssue: async () => canonical }} />);
    });
    await flushReact();
    expect(mockSetBreadcrumbs.mock.calls.at(-1)![0]).toEqual([{ label: "Chat" }]);

  });

  it.each(["message", "attachment", "plain HTTP message"])("creates an unused conversation only for the first %s and updates its canonical cache", async (kind) => {
    if (kind === "plain HTTP message") vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    mockIssuesApi.markRead.mockClear();
    const agent = createAgent();
    const canonical = createIssue({ conversationAgentId: agent.id, conversationUserId: "user-1", conversationState: "waiting", status: "in_review" });
    const ensureIssue = vi.fn().mockResolvedValue(canonical);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mockIssuesApi.addComment.mockResolvedValue(createIssueComment({ body: "Clarify this goal" }));
    mockIssuesApi.uploadAttachment.mockResolvedValue(createAttachment({ id: "first-upload" }));
    await act(async () => {
      renderIssueView(<TaskDetailSurface conversation={{ agent, issue: null, ensureIssue }} />);
    });
    await flushReact();
    expect(ensureIssue).not.toHaveBeenCalled();
    expect(mockIssuesApi.markRead).not.toHaveBeenCalled();
    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      onAdd: (body: string) => Promise<void>;
      onAttachImage: (file: File) => Promise<IssueAttachment>;
    };
    if (kind !== "attachment") {
      await act(async () => { await props.onAdd("Clarify this goal"); });
      expect(mockIssuesApi.addComment).toHaveBeenCalledWith(canonical.id, "Clarify this goal", undefined, undefined, undefined, expect.any(String));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.comments(canonical.id) });
    } else {
      const file = new File(["image"], "first.png", { type: "image/png" });
      await act(async () => { await props.onAttachImage(file); });
      expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledWith(canonical.companyId, canonical.id, file);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.attachments(canonical.id) });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.detail(canonical.id) });
    }
    expect(ensureIssue).toHaveBeenCalledTimes(1);
  });

  it("retries the chosen initial chat mode after creation succeeded but mode persistence failed", async () => {
    mockIssuesApi.addComment.mockClear();
    mockIssuesApi.update.mockClear();
    const agent = createAgent();
    const canonical = createIssue({ conversationAgentId: agent.id, conversationUserId: "user-1", conversationState: "waiting", status: "in_review", workMode: "standard" });
    const ensureIssue = vi.fn().mockResolvedValue(canonical);
    mockIssuesApi.update.mockRejectedValueOnce(new Error("Mode save failed")).mockResolvedValue({ ...canonical, workMode: "ask" });
    mockIssuesApi.addComment.mockResolvedValue(createIssueComment({ body: "Research only" }));
    const renderChat = async (issue: Issue | null) => {
      await act(async () => renderIssueView(<TaskDetailSurface conversation={{ agent, issue, ensureIssue }} />));
      await flushReact();
      return mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as { onWorkModeChange: (mode: string) => Promise<void>; onAdd: (body: string) => Promise<void> };
    };
    let props = await renderChat(null);
    await act(async () => props.onWorkModeChange("ask"));
    props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
    await act(async () => { await expect(props.onAdd("Research only")).rejects.toThrow("Mode save failed"); });
    expect(mockIssuesApi.addComment).not.toHaveBeenCalled();
    props = await renderChat(canonical);
    await act(async () => props.onAdd("Research only"));
    expect(mockIssuesApi.update).toHaveBeenNthCalledWith(2, canonical.id, { workMode: "ask" });
    expect(mockIssuesApi.addComment).toHaveBeenCalledOnce();
  });

  it.each([false, true])("saves chat model preferences before the ordered message (existing conversation: %s)", async (existing) => {
    const agent = createAgent();
    const canonical = createIssue({ assigneeAgentId: agent.id, conversationAgentId: agent.id, conversationUserId: "user-1", status: "in_review" });
    const ensureIssue = vi.fn().mockResolvedValue(canonical);
    const calls: string[] = [];
    mockIssuesApi.get.mockResolvedValue(canonical);
    mockIssuesApi.update.mockClear().mockImplementation(async () => { calls.push("settings"); return canonical; });
    mockIssuesApi.addComment.mockClear().mockImplementation(async () => { calls.push("comment"); return createIssueComment(); });
    await act(async () => renderIssueView(<TaskDetailSurface conversation={{ agent, issue: existing ? canonical : null, ensureIssue }} />));
    await flushReact();
    const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
    mockIssuesApi.getCore.mockResolvedValueOnce({ ...canonical, assigneeAdapterOverrides: { useProjectWorkspace: true, adapterConfig: { chrome: true, command: "preserved-command", model: "old-model" } } });
    await act(async () => props.onAdd("Outline the launch", undefined, undefined, undefined, "model-message", { model: "gpt-6-astra", effort: "high", fast: false }));
    expect(mockIssuesApi.getCore).toHaveBeenCalledWith(canonical.id, { cache: "no-store", fresh: true });
    expect(ensureIssue).toHaveBeenCalledOnce();
    expect(mockIssuesApi.update).toHaveBeenCalledWith(canonical.id, { assigneeAdapterOverrides: { useProjectWorkspace: true, adapterConfig: { chrome: true, command: "preserved-command", model: "gpt-6-astra", modelReasoningEffort: "high" } } });
    expect(mockIssuesApi.addComment).toHaveBeenCalledWith(canonical.id, "Outline the launch", undefined, undefined, undefined, "model-message");
    expect(calls).toEqual(["settings", "comment"]);
  });

  it("preserves complete task options when sending with model preferences outside a conversation", async () => {
    const canonical = createIssue({ assigneeAgentId: "agent-1", conversationAgentId: null });
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockIssuesApi.get.mockResolvedValue(canonical);
    await act(async () => renderIssueView());
    await flushReact();
    mockIssuesApi.update.mockClear().mockResolvedValue(canonical);
    mockIssuesApi.getCore.mockResolvedValueOnce({ ...canonical, assigneeAdapterOverrides: { adapterConfig: { chrome: true, command: "preserved-command" } } });
    const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
    await act(async () => props.onAdd("Use this model", undefined, undefined, undefined, "task-model-message", { model: "gpt-6-astra", effort: "high", fast: false }));
    expect(mockIssuesApi.getCore).toHaveBeenCalledWith(canonical.identifier, { cache: "no-store", fresh: true });
    expect(mockIssuesApi.update).toHaveBeenCalledWith(canonical.identifier, expect.objectContaining({
      comment: "Use this model",
      assigneeAdapterOverrides: { adapterConfig: { chrome: true, command: "preserved-command", model: "gpt-6-astra", modelReasoningEffort: "high" } },
    }));
  });

  it.each(["failed", "changed-account"])("does not replace settings or send after a %s fresh task read", async (outcome) => {
    const agent = createAgent();
    const canonical = createIssue({ conversationAgentId: agent.id, conversationUserId: "account-a" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "account-a" } });
    mockIssuesApi.get.mockResolvedValue(canonical);
    await act(async () => renderIssueView(<TaskDetailSurface conversation={{ agent, issue: canonical, ensureIssue: async () => canonical }} />));
    await flushReact();
    mockIssuesApi.update.mockClear();
    mockIssuesApi.addComment.mockClear();
    mockIssuesApi.getCore.mockImplementationOnce(async () => {
      if (outcome === "failed") throw new Error("Task refresh failed");
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } });
      return canonical;
    });
    const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
    await act(async () => expect(props.onAdd("Outline the launch", undefined, undefined, undefined, "fresh-task-message", { model: "gpt-6-astra", effort: "high", fast: false })).rejects.toThrow());
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
    expect(mockIssuesApi.addComment).not.toHaveBeenCalled();
  });

  it("does not send a chat message when its selected model preferences fail to save", async () => {
    const agent = createAgent();
    const canonical = createIssue({ conversationAgentId: agent.id, conversationUserId: "user-1" });
    mockIssuesApi.update.mockRejectedValueOnce(new Error("Settings could not be saved"));
    mockIssuesApi.addComment.mockClear();
    await act(async () => renderIssueView(<TaskDetailSurface conversation={{ agent, issue: null, ensureIssue: async () => canonical }} />));
    await flushReact();
    const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
    await act(async () => expect(props.onAdd("Outline the launch", undefined, undefined, undefined, "failed-model-message", { model: "gpt-6-astra", effort: "high", fast: false })).rejects.toThrow("Settings could not be saved"));
    expect(mockIssuesApi.addComment).not.toHaveBeenCalled();
  });

  it("does not send or restore a conversation cache after the account changes during its model save", async () => {
    const agent = createAgent();
    const canonical = createIssue({ conversationAgentId: agent.id, conversationUserId: "account-a" });
    const settingsSave = createDeferred<Issue>();
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "account-a" } });
    mockIssuesApi.get.mockResolvedValue(canonical);
    mockIssuesApi.update.mockClear().mockReturnValueOnce(settingsSave.promise);
    mockIssuesApi.addComment.mockClear();
    await act(async () => renderIssueView(<TaskDetailSurface conversation={{ agent, issue: canonical, ensureIssue: async () => canonical }} />));
    await flushReact();
    const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = props.onAdd("Outline the launch", undefined, undefined, undefined, "changed-account-message", { model: "gpt-6-astra", effort: "high", fast: false }).catch((error: unknown) => error);
    });
    await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledOnce());
    const currentAccountIssue = { ...canonical, title: "Current account cache" };
    await act(async () => {
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "account-b" } });
      queryClient.setQueryData(queryKeys.issues.detail(canonical.id), currentAccountIssue);
      settingsSave.resolve(canonical);
    });
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(mockIssuesApi.addComment).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.issues.detail(canonical.id))).toEqual(currentAccountIssue);
  });

  it("opens artifact cards in the shared gallery at the selected image without duplicating attachments", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.listAttachments.mockResolvedValue([
      createAttachment({
        id: "chat-image",
        contentType: "image/png",
        originalFilename: "chat.png",
      }),
      createAttachment({
        id: "00000000-0000-4000-8000-000000000001",
        contentType: "image/png",
        originalFilename: "artifact.png",
      }),
    ]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([
      createArtifactWorkProduct({
        id: "artifact-1",
        attachmentId: "00000000-0000-4000-8000-000000000001",
        contentType: "image/png",
        originalFilename: "artifact.png",
      }),
      createArtifactWorkProduct({
        id: "artifact-2",
        attachmentId: "00000000-0000-4000-8000-000000000002",
        contentType: "image/png",
        originalFilename: "output.png",
      }),
    ]);
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      expect(
        container.querySelector(
          'button[aria-label="Open gallery: output.png"]',
        ),
      ).not.toBeNull();
    });
    for (const [filename, index] of [
      ["artifact.png", 1],
      ["output.png", 2],
    ] as const) {
      await act(async () => {
        (
          container.querySelector(
            `button[aria-label="Open gallery: ${filename}"]`,
          ) as HTMLButtonElement
        ).click();
      });
      expect(mockImageGalleryRender.mock.calls.at(-1)?.[0]).toMatchObject({
        open: true,
        initialIndex: index,
        items: [
          { id: "chat-image" },
          { id: "00000000-0000-4000-8000-000000000001" },
          {
            id: "work-product-artifact-2",
            downloadPath:
              "/api/attachments/00000000-0000-4000-8000-000000000002/content?download=1",
          },
        ],
      });
    }
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it.each([null, "queued", "running", "succeeded", "failed"])("hides the history disclosure on a fresh task with first run %s", async (status) => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const runs = status ? [{ runId: "first-run", status, agentId: "agent-1", createdAt: new Date().toISOString() }] : [];
    mockActivityApi.recentRunsForIssue.mockResolvedValue(runs);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(mockActivityApi.recentRunsForIssue).toHaveBeenCalled();
      expect(props?.linkedRuns).toMatchObject(runs);
      expect(props?.compactHistory).toBe(true);
      expect(props?.historyControl).toBeNull();
    });
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
  });

  it("forwards exact Stop proof and runtime mode from run history into the task thread", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    const issue = createIssue();
    mockIssuesApi.get.mockResolvedValue(issue);
    const run = { runId: "stopped-run", runtimeMode: "native", status: "cancelled", agentId: "agent-1", createdAt: new Date().toISOString(),
      resultJson: { executionCancellation: { state: "acknowledged", proof: "provider_api_stop_receipt" },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: "stopped-run", companyId: issue.companyId, dispatchState: "acknowledged" } } };
    mockActivityApi.recentRunsForIssue.mockResolvedValue([run]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.companyId).toBe(issue.companyId);
      expect(props?.linkedRuns).toEqual([expect.objectContaining(run)]);
    });
  });

  it("offers Unhide on the hidden-task banner and clears hiddenAt", async () => {
    const hiddenIssue = createIssue({ hiddenAt: new Date("2026-11-15T05:00:00.000Z") });
    mockIssuesApi.get.mockResolvedValue(hiddenIssue);
    mockIssuesApi.getCore.mockResolvedValue(hiddenIssue);
    mockIssuesApi.update.mockReset();
    mockIssuesApi.update.mockResolvedValue({ ...hiddenIssue, hiddenAt: null });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('[data-testid="hidden-task-banner"]')).not.toBeNull());
    const banner = container.querySelector<HTMLElement>('[data-testid="hidden-task-banner"]')!;
    expect(banner.textContent).toContain("This task is hidden");
    const unhide = Array.from(banner.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Unhide");
    expect(unhide).toBeTruthy();
    // The server now returns the task without hiddenAt.
    mockIssuesApi.get.mockResolvedValue({ ...hiddenIssue, hiddenAt: null });
    mockIssuesApi.getCore.mockResolvedValue({ ...hiddenIssue, hiddenAt: null });
    await act(async () => unhide!.click());
    await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledWith(expect.stringMatching(/^(issue-1|PAP-1)$/), { hiddenAt: null }));
    expect(mockNavigate).not.toHaveBeenCalledWith("/issues/all");
    // The response clears hiddenAt, so the banner goes away.
    await waitForAssertion(() => expect(container.querySelector('[data-testid="hidden-task-banner"]')).toBeNull());
  });

  it("toggles the task menu between Hide this task and Unhide this task", async () => {
    const hiddenIssue = createIssue({ hiddenAt: new Date("2026-11-15T05:00:00.000Z") });
    mockIssuesApi.get.mockResolvedValue(hiddenIssue);
    mockIssuesApi.getCore.mockResolvedValue(hiddenIssue);
    mockIssuesApi.update.mockReset();
    mockIssuesApi.update.mockResolvedValue({ ...hiddenIssue, hiddenAt: null });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('button[aria-label="More task actions"]')).not.toBeNull());
    const menuButton = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === label);
    await waitForAssertion(() => expect(menuButton("Unhide this task")).toBeTruthy());
    expect(menuButton("Hide this task")).toBeUndefined();
    mockIssuesApi.get.mockResolvedValue({ ...hiddenIssue, hiddenAt: null });
    mockIssuesApi.getCore.mockResolvedValue({ ...hiddenIssue, hiddenAt: null });
    await act(async () => menuButton("Unhide this task")!.click());
    await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledWith(expect.stringMatching(/^(issue-1|PAP-1)$/), { hiddenAt: null }));
    await waitForAssertion(() => expect(menuButton("Hide this task")).toBeTruthy());
    expect(menuButton("Unhide this task")).toBeUndefined();
  });

  it("offers Unhide this task in the phone inbox toolbar menu for a hidden task", async () => {
    mockSidebarState.isMobile = true;
    mockLocation.state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");
    const hiddenIssue = createIssue({ hiddenAt: new Date("2026-11-15T05:00:00.000Z") });
    mockIssuesApi.get.mockResolvedValue(hiddenIssue);
    mockIssuesApi.getCore.mockResolvedValue(hiddenIssue);
    mockIssuesApi.update.mockReset();
    mockIssuesApi.update.mockResolvedValue({ ...hiddenIssue, hiddenAt: null });
    await act(async () => renderIssueView());
    await flushReact();
    await flushReact();
    await waitForAssertion(() => expect(mockSetMobileToolbar.mock.calls.some(([node]) => Boolean(node))).toBe(true));
    const toolbar = [...mockSetMobileToolbar.mock.calls].map(([node]) => node).filter(Boolean).at(-1) as ReactNode;
    const toolbarContainer = document.createElement("div");
    document.body.appendChild(toolbarContainer);
    const toolbarRoot = createRoot(toolbarContainer);
    try {
      flushSync(() => toolbarRoot.render(toolbar));
      const labels = Array.from(toolbarContainer.querySelectorAll("button")).map((button) => button.textContent?.trim());
      expect(labels).toContain("Unhide this task");
      expect(labels).not.toContain("Hide this task");
      await act(async () => Array.from(toolbarContainer.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.trim() === "Unhide this task")!.click());
      await waitForAssertion(() => expect(mockIssuesApi.update).toHaveBeenCalledWith(expect.stringMatching(/^(issue-1|PAP-1)$/), { hiddenAt: null }));
    } finally {
      flushSync(() => toolbarRoot.unmount());
      toolbarContainer.remove();
    }
  });

  it("loads full first-run activity from the task menu without an older-message disclosure", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const run = { runId: "first-run", runtimeMode: "native", status: "succeeded", agentId: "agent-1", createdAt: new Date().toISOString() };
    mockActivityApi.recentRunsForIssue.mockResolvedValue([run]);
    mockActivityApi.runsForIssue.mockResolvedValue([run]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.linkedRuns).toMatchObject([run]);
      expect(props?.compactHistory).toBe(true);
      expect(props?.historyControl).toBeNull();
    });
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="More task actions"]')!.click();
    });
    const activityButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Show task activity");
    expect(activityButton).toBeTruthy();
    await act(async () => activityButton!.click());
    await waitForAssertion(() => {
      expect(mockActivityApi.runsForIssue).toHaveBeenCalled();
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].compactHistory).toBe(false);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="More task actions"]')!.click();
    });
    expect(Array.from(document.body.querySelectorAll("button"))
      .some((button) => button.textContent?.trim() === "Show task activity")).toBe(false);
  });

  it("does not add a history disclosure when a second run is observed while the page stays open", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const run = (runId: string) => ({ runId, status: "succeeded", agentId: "agent-1", createdAt: new Date().toISOString() });
    const first = run("first"), second = run("second");
    mockActivityApi.recentRunsForIssue.mockResolvedValue([first]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].linkedRuns).toMatchObject([first]));
    mockActivityApi.recentRunsForIssue.mockResolvedValue([second, first]);
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs("PAP-1") }); });
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.linkedRuns).toMatchObject([first, second]);
      expect(props?.historyControl).toBeNull();
    });
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
  });

  // RFL F2 (turn-steps r2): a cold ordinary task must know every completed run
  // behind a visible reply, not just the latest, so the existing history
  // disclosure can open each turn's saved steps. Summaries only, no transcripts.
  it("supplies the run summaries behind every visible reply on a cold ordinary task", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const firstRunId = "11111111-1111-4111-8111-111111111111", secondRunId = "22222222-2222-4222-8222-222222222222";
    const run = (runId: string, minute: number) => ({ runId, runtimeMode: "native", status: "succeeded", agentId: "agent-1",
      createdAt: `2026-04-21T00:0${minute}:00.000Z`, finishedAt: `2026-04-21T00:0${minute}:10.000Z` });
    const first = run(firstRunId, 1), second = run(secondRunId, 2);
    const reply = (id: string, runId: string, minute: number) => createIssueComment({ id, authorType: "agent", authorAgentId: "agent-1",
      authorUserId: null, createdByRunId: runId, body: `Reply ${minute}`, createdAt: new Date(`2026-04-21T00:0${minute}:09.000Z`) } as Partial<IssueComment>);
    const comments = [reply("reply-2", secondRunId, 2), reply("reply-1", firstRunId, 1)];
    mockIssuesApi.recentComments.mockResolvedValue({ comments, latestCommentId: "reply-2", oldestCommentId: "reply-1", hasMore: false });
    mockActivityApi.recentRunsForIssue.mockResolvedValue([second, first]);
    mockActivityApi.runsByIdsForIssue.mockImplementation(async (_issue: string, ids: string[]) => [second, first].filter(r => ids.includes(r.runId)));
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.compactHistory).toBe(true);
      expect(props?.linkedRuns.map((r: { runId: string }) => r.runId).sort()).toEqual([firstRunId, secondRunId]);
    });
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
  });

  it("reveals omitted runs through the history disclosure when there are no older comments", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const run = (runId: string) => ({ runId, status: "succeeded", agentId: "agent-1", createdAt: new Date().toISOString() });
    const latest = run("latest"), older = run("older"), next = run("next");
    mockActivityApi.recentRunsForIssue.mockResolvedValue([latest, older]);
    mockActivityApi.runsForIssue.mockResolvedValue([next, latest, older]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.linkedRuns).toMatchObject([latest]);
      expect(props?.historyControl).toBeTruthy();
    });
    mockActivityApi.recentRunsForIssue.mockResolvedValue([next, latest]);
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs("PAP-1") }); });
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].linkedRuns).toMatchObject([latest, next]));
    const disclosure = mockIssueChatThreadRender.mock.calls.at(-1)?.[0].historyControl;
    expect(disclosure).toBeTruthy();
    await act(async () => disclosure.props.onClick());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.linkedRuns).toMatchObject([next, latest, older]);
      expect(props?.historyControl).toBeNull();
      expect(props?.compactHistory).toBe(false);
    });
  });

  it("does not offer Retry when the execution blocker refuses continuation", async () => {
    const refusalText = "The previous continuation could not be reconciled. Inspect the stopped run before continuing.";
    const interruption: NonNullable<Issue["interruption"]> = {
      intentId: null,
      responsibility: "system",
      state: "failed",
      nextRetryAt: null,
      // The execution blocker is the authoritative retry eligibility for this refusal.
      canRetry: true,
      userAction: null,
      sourceRunIds: ["refused-run"],
      observedRunId: "refused-run",
      notice: { code: "native_continuation_requires_reconciliation", text: refusalText },
    };
    const issue = createIssue({
      status: "blocked",
      assigneeAgentId: "agent-1",
      interruption,
      executionBlocker: {
        recoveryActionId: "recovery-action",
        runId: "refused-run",
        agentId: "agent-1",
        cause: "native_continuation_requires_reconciliation",
        nextAction: "Inspect the stopped run before continuing.",
        canRetry: false,
      },
    });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "local-board" }, user: { id: "local-board" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ companyIds: [issue.companyId], isInstanceAdmin: true,
      source: "local_implicit", keyId: null, user: null, userId: "local-board" });

    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-execution-notice"]')?.textContent).toBe(refusalText));
    await waitForAssertion(() => expect(mockAccessApi.getCurrentBoardAccess).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
    expect(mockIssuesApi.retryTask).not.toHaveBeenCalled();
  });

  it.each([false, true])("refreshes admission with latest comments (compact chat: %s)", async compact => {
    const interruption: NonNullable<Issue["interruption"]> = { intentId: "retry", responsibility: "system", state: "failed",
      nextRetryAt: null, canRetry: true, userAction: null, sourceRunIds: ["failed-run"], observedRunId: "failed-run",
      retryWait: { reason: "remote_cleanup", message: "Retry is waiting for the previous environment to stop. Your message is saved." } };
    let saved = createIssue({ status: "blocked", assigneeAgentId: "agent-1", interruption,
      ...(compact ? { conversationAgentId: "agent-1", conversationUserId: "user-1" } : {}) });
    mockIssuesApi.get.mockImplementation(async () => saved);
    await act(async () => renderIssueView());
    const props = () => mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
    await waitForAssertion(() => expect(props()?.interruption).toMatchObject({ intentId: "retry" }));
    saved = { ...saved, interruption: { ...interruption, intentId: "new-message-receipt" } };
    await act(async () => { await props().onRefreshLatestComments(); });
    await waitForAssertion(() => expect(props()?.interruption).toMatchObject({
      intentId: "new-message-receipt", retryWait: interruption.retryWait,
    }));
  });

  it("opens chats compactly and pages backward without expanding all history", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    const chat = createIssue({ conversationAgentId: "agent-1", conversationUserId: "user-1" });
    const latest = createIssueComment({ id: "10000000-0000-4000-8000-000000000020", body: "Recent chat reply" });
    mockIssuesApi.getCore.mockResolvedValue(chat);
    mockIssuesApi.get.mockResolvedValue(chat);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [latest], latestCommentId: latest.id, oldestCommentId: latest.id, hasMore: true });
    mockIssuesApi.listComments.mockResolvedValue([]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      compactHistory: true, historyControl: null, scrollingHistory: { hasMore: true, loading: false },
    }));
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    expect(mockActivityApi.forIssue).not.toHaveBeenCalled();
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    await act(async () => { await mockIssueChatThreadRender.mock.calls.at(-1)?.[0].onRefreshLatestComments(); });
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    await act(async () => { await mockIssueChatThreadRender.mock.calls.at(-1)?.[0].scrollingHistory.load(); });
    await waitForAssertion(() => expect(mockIssuesApi.listComments.mock.calls.some(([ref, options]) => ref === "PAP-1" && options.order === "desc" && options.after === latest.id && options.limit === 50)).toBe(true));
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].compactHistory).toBe(true);
  });

  it.each([false, true])("keeps chat paging after sending (earlier pages loaded: %s)", async loaded => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    const chat = createIssue({ conversationAgentId: "agent-1", conversationUserId: "user-1" });
    const latest = createIssueComment({ id: "10000000-0000-4000-8000-000000000020" });
    const sent = createIssueComment({ id: "10000000-0000-4000-8000-000000000021", body: "Send before scrolling" });
    const rows = Array.from({ length: 100 }, (_, index) => createIssueComment({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      body: `Earlier ${index}`, createdAt: new Date(100_000 - index * 1000),
    }));
    mockIssuesApi.getCore.mockResolvedValue(chat); mockIssuesApi.get.mockResolvedValue(chat);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [latest], latestCommentId: latest.id, oldestCommentId: latest.id, hasMore: true });
    mockIssuesApi.addComment.mockResolvedValue(sent);
    mockIssuesApi.listComments.mockImplementation(async (_ref, options) => options.order === "asc" ? [sent]
      : options.after === rows[49].id ? rows.slice(50) : rows.slice(0, 50));
    await act(async () => renderIssueView());
    const props = () => mockIssueChatThreadRender.mock.calls.at(-1)![0];
    await waitForAssertion(() => expect(props().scrollingHistory?.hasMore).toBe(true));
    if (loaded) {
      await act(async () => { await props().scrollingHistory.load(); });
      await waitForAssertion(() => expect(props().comments.some((comment: IssueComment) => comment.id === rows[49].id)).toBe(true));
    }
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [sent, latest], latestCommentId: sent.id, oldestCommentId: latest.id, hasMore: true });
    await act(async () => { await props().onAdd(sent.body); });
    await waitForAssertion(() => expect(props().scrollingHistory?.hasMore).toBe(true));
    await act(async () => { await props().scrollingHistory.load(); });
    await waitForAssertion(() => expect(mockIssuesApi.listComments.mock.calls.some(([ref, options]) => ref === "PAP-1"
      && options.order === "desc" && options.limit === 50 && options.after === (loaded ? rows[49].id : latest.id))).toBe(true));
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
  });

  it.each([false, true])("opens a prefetched task without waiting on navigation reads (Coordinator: %s)", async coordinator => {
    coordinatorPreference.enabled = coordinator;
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.getCore.mockResolvedValue(createIssue({ description: "Prefetched instruction" }));
    mockIssuesApi.recentComments.mockResolvedValue({
      comments: [createIssueComment({ body: "Prefetched answer" })],
      latestCommentId: "comment-1", oldestCommentId: "comment-1", hasMore: true,
    });
    await prefetchIssueDetailForNavigation(queryClient, "PAP-1");
    mockIssuesApi.getCore.mockClear().mockReturnValue(createDeferred<Issue>().promise);
    mockIssuesApi.recentComments.mockClear().mockReturnValue(createDeferred<IssueRecentComments>().promise);
    mockIssuesApi.get.mockReturnValue(createDeferred<Issue>().promise);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Issue detail smoke");
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
        compactHistory: true, initialHistoryPending: false,
        comments: [expect.objectContaining({ body: "Prefetched answer" })],
      });
    });
    expect(mockIssuesApi.getCore).not.toHaveBeenCalled();
    expect(mockIssuesApi.recentComments).not.toHaveBeenCalled();
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
  });

  it("reveals a cold task and recent exchange while full detail and older history are stalled", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    const stalled = createDeferred<Issue>();
    mockIssuesApi.getCore.mockResolvedValue(createIssue({ description: "Original instruction" }));
    mockIssuesApi.get.mockReturnValue(stalled.promise);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [createIssueComment({ body: "Latest answer" })], latestCommentId: "comment-1", hasMore: true });
    await act(async () => { renderIssueView(); });
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Issue detail smoke");
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
        compactHistory: true, initialHistoryPending: false,
        comments: [expect.objectContaining({ body: "Latest answer" })],
      });
    });
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    expect(mockActivityApi.forIssue).not.toHaveBeenCalled();
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    const disclosure = mockIssueChatThreadRender.mock.calls.at(-1)?.[0].historyControl;
    await act(async () => { disclosure.props.onClick(); });
    await waitForAssertion(() => {
      expect(mockIssuesApi.listComments).toHaveBeenCalled();
      expect(mockActivityApi.runsForIssue).toHaveBeenCalled();
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].compactHistory).toBe(false);
    });
    expect(queryClient.getQueryData(["issues", "history-expanded", "PAP-1"])).toBe(true);
  });

  it.each(["empty", "saved"])("reveals core work products while the stored request is stalled (%s)", async (projection) => {
    const workProducts = projection === "empty" ? [] : [createArtifactWorkProduct({
      id: "saved-output", attachmentId: "00000000-0000-4000-8000-000000000001", contentType: "text/plain", originalFilename: "evidence.txt",
    })];
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.getCore.mockResolvedValue(createIssue({ workProducts }));
    mockIssuesApi.get.mockReturnValue(createDeferred<Issue>().promise);
    mockIssuesApi.listWorkProducts.mockReturnValue(createDeferred<[]>().promise);
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      initialHistoryPending: false, workProducts,
    }));
    expect(mockIssuesApi.listWorkProducts).toHaveBeenCalled();
  });

  it.each(["..", "../../../../health", "invalid"])("ignores a malformed comment anchor %s", async (target) => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockLocation.hash = `#comment-${target}`;
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      compactHistory: true, initialHistoryPending: false,
    }));
    expect(mockIssuesApi.getComment).not.toHaveBeenCalled();
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
  });

  it.each(["#document-qa-evidence", "#document-plan", "#document-continuation-summary", "#work-product-one", "#attachment-one", "#unknown", "#comment-6e391846-d4aa-410f-9d9a-6a60d74bce37"])("keeps the recent conversation for anchor %s", async (hash) => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockLocation.hash = hash;
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const recent = createIssueComment({ id: "recent-comment", body: "Latest reply" });
    const older = createIssueComment({ id: "6e391846-d4aa-410f-9d9a-6a60d74bce37", body: "Linked older reply" });
    mockIssuesApi.getComment.mockResolvedValue(older);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [recent], latestCommentId: recent.id, hasMore: true });
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({ compactHistory: true });
      expect(mockIssuesApi.recentComments).toHaveBeenCalled();
    });
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    expect(mockActivityApi.forIssue).not.toHaveBeenCalled();
    expect(mockActivityApi.runsForIssue).not.toHaveBeenCalled();
    if (hash.startsWith("#comment-")) {
      await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].comments).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: older.id }), expect.objectContaining({ id: recent.id }),
      ])));
      expect(mockIssuesApi.getComment).toHaveBeenCalledWith("issue-1", older.id, expect.anything());
    } else {
      expect(mockIssuesApi.getComment).not.toHaveBeenCalled();
    }
  });

  it("retains a linked older comment when opening a document without moving the preview cursor", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockLocation.hash = "#comment-6e391846-d4aa-410f-9d9a-6a60d74bce37";
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const recent = createIssueComment({ id: "recent-comment", body: "Latest reply" });
    const older = createIssueComment({ id: "6e391846-d4aa-410f-9d9a-6a60d74bce37", body: "Read my saved evidence" });
    mockIssuesApi.getComment.mockResolvedValue(older);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [recent], latestCommentId: recent.id, hasMore: true });
    await act(async () => renderIssueView());
    const props = () => mockIssueChatThreadRender.mock.calls.at(-1)![0];
    await waitForAssertion(() => expect(props().comments).toEqual(expect.arrayContaining([expect.objectContaining({ id: older.id })])));
    mockLocation.hash = "#document-qa-evidence";
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(props().comments).toEqual(expect.arrayContaining([expect.objectContaining({ id: older.id }), expect.objectContaining({ id: recent.id })])));
    expect(queryClient.getQueryData<IssueRecentComments>([...queryKeys.issues.comments("PAP-1"), "recent"])?.latestCommentId).toBe(recent.id);
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    expect(mockActivityApi.forIssue).not.toHaveBeenCalled();
  });

  it.each([false, true])("loads older history after sending from a cold view (reassign=%s)", async (reassign) => {
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    const issue = createIssue();
    const old = createIssueComment({ id: "old-comment", body: "Earlier instruction" });
    const recent = createIssueComment({ id: "recent-comment", body: "Latest answer" });
    const sent = createIssueComment({ id: "sent-comment", body: "Follow up" });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [recent], latestCommentId: recent.id, hasMore: true });
    mockIssuesApi.addComment.mockResolvedValue(sent);
    mockIssuesApi.update.mockResolvedValue({ ...issue, comment: sent });
    mockIssuesApi.listComments.mockResolvedValue([sent, recent, old]);
    await act(async () => renderIssueView());
    const props = () => mockIssueChatThreadRender.mock.calls.at(-1)![0];
    await waitForAssertion(() => expect(props().comments).toEqual([expect.objectContaining({ id: recent.id })]));
    await act(async () => props().onAdd(sent.body, false, reassign ? { assigneeAgentId: "agent-1", assigneeUserId: null } : undefined));
    await waitForAssertion(() => expect(props().comments.some((comment: IssueComment) => comment.id === sent.id)).toBe(true));
    expect(mockIssuesApi.listComments).not.toHaveBeenCalled();
    await act(async () => props().historyControl.props.onClick());
    await waitForAssertion(() => {
      expect(mockIssuesApi.listComments).toHaveBeenCalled();
      expect(props().comments.some((comment: IssueComment) => comment.id === old.id)).toBe(true);
    });
  });

  it.each(["success", "failure"])("updates and rolls back core-only task edits on %s", async (outcome) => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    const issue = createIssue();
    const pendingSave = createDeferred<Issue>();
    mockIssuesApi.getCore.mockResolvedValue(issue);
    mockIssuesApi.get.mockReturnValue(new Promise(() => {}));
    mockIssuesApi.update.mockReturnValue(pendingSave.promise);
    await act(async () => renderIssueView());
    let properties!: { onUpdate: (data: Record<string, unknown>) => void };
    await waitForAssertion(() => {
      properties = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children?.props;
      expect(properties?.onUpdate).toBeTypeOf("function");
    });
    await act(async () => properties.onUpdate({ title: "Edited before enrichment", status: "in_progress" }));
    await waitForAssertion(() => expect(queryClient.getQueryData<Issue>([...queryKeys.issues.detail("PAP-1"), "core"])?.status).toBe("in_progress"));
    if (outcome === "success") {
      const saved = { ...issue, title: "Saved before enrichment", status: "in_progress" as const };
      mockIssuesApi.getCore.mockResolvedValue(saved);
      await act(async () => pendingSave.resolve(saved));
    } else {
      await act(async () => pendingSave.reject(new Error("Save failed")));
    }
    await waitForAssertion(() => {
      expect(container.textContent).toContain(outcome === "success" ? "Saved before enrichment" : issue.title);
      expect(queryClient.getQueryData<Issue>([...queryKeys.issues.detail("PAP-1"), "core"])?.status).toBe(outcome === "success" ? "in_progress" : issue.status);
    });
    expect(queryClient.getQueryData(queryKeys.issues.detail("PAP-1"))).toBeUndefined();
  });

  it.each(["settled", "deleted"])("reconciles %s watched runs outside the preview after reconnecting", async (outcome) => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const run = (runId: string, status = "succeeded") => ({ runId, status, agentId: "agent-1", createdAt: new Date().toISOString() });
    mockActivityApi.recentRunsForIssue.mockResolvedValue([run("watched", "running")]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].linkedRuns).toEqual([expect.objectContaining({ runId: "watched", status: "running" })]));
    mockActivityApi.recentRunsForIssue.mockResolvedValue([run("newest"), run("middle")]);
    mockActivityApi.runsForIssue.mockClear().mockResolvedValue([run("newest"), run("middle"), ...(outcome === "settled" ? [run("watched")] : [])]);
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs("PAP-1") }); });
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].linkedRuns).toEqual([
      ...(outcome === "settled" ? [expect.objectContaining({ runId: "watched", status: "succeeded" })] : []),
      expect.objectContaining({ runId: "newest", status: "succeeded" }),
    ]));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs("PAP-1") }); });
    expect(mockActivityApi.runsForIssue).toHaveBeenCalledTimes(1);
  });

  it("keeps a delivered message out of the queue when its receipt is older than recent activity", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    const comment = createQueuedCommentQueue().entries[0].comment;
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1" }));
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [comment], latestCommentId: comment.id, hasMore: true });
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-active-1", runtimeMode: "native", status: "running", agentId: "agent-1",
      adapterType: "paperclip_runner", startedAt: "2026-04-21T00:00:00.000Z", createdAt: "2026-04-21T00:00:00.000Z",
    });
    mockActivityApi.inputFactsForIssue.mockResolvedValue([{
      id: "old-receipt", action: "issue.queued_comment_steered", createdAt: "2026-04-21T00:00:06.000Z",
      details: { commentId: comment.id, targetRunId: "run-active-1", duplicate: false },
    }]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props.queuedCommentQueue).toBeNull();
      expect(props.comments).toContainEqual(expect.objectContaining({ id: comment.id, steeredIntoRunId: "run-active-1" }));
    });
    expect(mockActivityApi.inputFactsForIssue).toHaveBeenCalledWith("PAP-1", [comment.id]);
    expect(mockActivityApi.forIssue).not.toHaveBeenCalled();
  });

  it("retains every recent run observed during an open task", async () => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const run = (id: string) => ({ runId: id, agentId: "agent-1", status: "succeeded", runtimeMode: "native", createdAt: new Date().toISOString() });
    mockActivityApi.recentRunsForIssue.mockResolvedValue([run("latest"), run("older")]);
    await act(async () => { renderIssueView(); });
    await waitForAssertion(() => {
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].linkedRuns.map((r: { runId: string }) => r.runId)).toEqual(["latest"]);
    });
    for (const id of ["next", "newest"]) {
      mockActivityApi.recentRunsForIssue.mockResolvedValue([run(id)]);
      await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs("PAP-1") }); });
    }
    await waitForAssertion(() => {
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].linkedRuns.map((r: { runId: string }) => r.runId)).toEqual(["latest", "next", "newest"]);
    });
  });

  it.each(["comments", "description", "empty"])("coordinates %s with the initial cards and supporting history", async (content) => {
    const history = createDeferred<[]>();
    mockIssuesApi.get.mockResolvedValue(createIssue({
      description: content === "description" ? "Saved task description" : null,
    }));
    mockIssuesApi.listComments.mockResolvedValue(content === "comments" ? [createIssueComment()] : []);
    mockActivityApi.forIssue.mockReturnValue(history.promise);
    mockActivityApi.runsForIssue.mockReturnValue(history.promise);
    mockHeartbeatsApi.liveRunsForIssue.mockReturnValue(history.promise);
    mockIssuesApi.listInteractions.mockReturnValue(history.promise);
    mockIssuesApi.listAttachments.mockReturnValue(history.promise);
    mockIssuesApi.listWorkProducts.mockReturnValue(history.promise);

    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
        initialHistoryPending: true,
      });
    });
    // Resolving metadata fills the same thread rather than replacing its content.
    history.resolve([]);
    await waitForAssertion(() => {
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({ initialHistoryPending: false });
    });
  });

  it("loads from the pending state into issue detail without changing hook order", async () => {
    const issueRequest = createDeferred<Issue>();
    mockIssuesApi.get.mockReturnValueOnce(issueRequest.promise);

    await act(async () => {
      renderIssueView();
    });

    // The task response may need slow workspace/recovery enrichment. The
    // thread requests must already be in flight while its skeleton is showing.
    expect(mockActivityApi.forIssue).toHaveBeenCalledWith("PAP-1");
    expect(mockActivityApi.runsForIssue).toHaveBeenCalledWith("PAP-1");

    issueRequest.resolve(createIssue());
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Issue detail smoke");
    expect(container.textContent).toContain("Task chat thread");
    const titleGroup = container.querySelector(
      '[data-slot="task-detail-title"]',
    );
    const identifier = titleGroup?.querySelector(
      '[data-slot="task-title-identifier"]',
    );
    const titleRow = titleGroup?.parentElement;
    const titleActions = container.querySelector(
      '[data-slot="task-title-actions"]',
    );
    expect(titleGroup?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Issue detail smokePAP-1",
    );
    expect(identifier?.textContent).toBe("PAP-1");
    expect(titleRow?.className).toContain("pr-8");
    expect(titleActions?.className).toContain("absolute");
    expect(titleActions?.className).toContain("top-0");
    expect(
      titleActions?.querySelector('button[aria-label="More task actions"]'),
    ).not.toBeNull();
    expect(
      consoleErrorSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes(
          "React has detected a change in the order of Hooks",
        ),
      ),
    ).toBe(false);
  });

  it.each([false, true])(
    "preserves explicit upload receipt IDs through the page mutation (reassign=%s)",
    async (reassign) => {
      const issue = createIssue();
      const id = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
      const file = new File(["fresh"], "fresh.txt", { type: "text/plain" });
      mockIssuesApi.get.mockResolvedValue(issue);
      mockIssuesApi.uploadAttachment.mockResolvedValue({
        id,
        issueId: issue.id,
        companyId: issue.companyId,
        contentPath: `/api/attachments/${id}/content`,
      });
      mockIssuesApi.addComment
        .mockClear()
        .mockResolvedValue(createIssueComment());
      mockIssuesApi.update
        .mockClear()
        .mockResolvedValue({ ...issue, comment: createIssueComment() });
      await act(async () =>
        renderIssueView(),
      );
      await waitForAssertion(() =>
        expect(mockIssueChatThreadRender).toHaveBeenCalled(),
      );
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        onAttachImage(file: File): Promise<{ id: string }>;
        onAdd(
          body: string,
          reopen?: boolean,
          reassignment?: {
            assigneeAgentId: string | null;
            assigneeUserId: string | null;
          },
          attachmentIds?: string[],
        ): Promise<void>;
      };
      let uploaded!: { id: string };
      await act(async () => {
        uploaded = await props.onAttachImage(file);
      });
      expect(uploaded.id).toBe(id);
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      await act(async () =>
        props.onAdd(
          "Inspect the new file",
          undefined,
          reassign
            ? { assigneeAgentId: "agent-2", assigneeUserId: null }
            : undefined,
          [uploaded.id],
        ),
      );
      for (const ref of [issue.id, issue.identifier]) {
        expect(invalidate).toHaveBeenCalledWith({
          queryKey: queryKeys.issues.attachments(ref!),
        });
      }
      if (reassign) {
        expect(mockIssuesApi.update).toHaveBeenCalledWith(issue.identifier, {
          comment: "Inspect the new file",
          commentClientRequestId: undefined,
          assigneeAgentId: "agent-2",
          assigneeUserId: null,
          assigneeAdapterOverrides: null,
          attachmentIds: [id],
        });
        expect(mockIssuesApi.addComment).not.toHaveBeenCalled();
      } else {
        expect(mockIssuesApi.addComment).toHaveBeenCalledWith(
          issue.identifier,
          "Inspect the new file",
          undefined,
          undefined,
          [id],
          expect.any(String),
        );
        expect(mockIssuesApi.update).not.toHaveBeenCalled();
      }
    },
  );

  it("includes the parent in the global Streamlined breadcrumbs while keeping label chips out of the task header", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        ancestors: [
          {
            id: "parent-1",
            identifier: "PAP-0",
            title: "Parent task visible in Properties",
          },
          { id: "root-1", identifier: "PAP-99", title: "Root task" },
        ] as Issue["ancestors"],
        labels: [
          {
            id: "label-1",
            companyId: "company-1",
            name: "Quick win",
            color: "#22c55e",
            createdAt: new Date("2026-04-21T00:00:00.000Z"),
            updatedAt: new Date("2026-04-21T00:00:00.000Z"),
          },
        ],
        labelIds: ["label-1"],
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    expect(container.textContent).not.toContain(
      "Parent task visible in Properties",
    );
    expect(container.textContent).not.toContain("Quick win");
    expect(container.textContent).toContain("Issue detail smoke");
    expect(mockSetBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Tasks", href: "/issues" },
      expect.objectContaining({ label: "Parent task visible in Properties", href: "/issues/PAP-0" }),
      expect.objectContaining({ label: "Issue detail smoke" }),
    ]);
  });

  it.each(["location", "stored", "query"] as const)("preserves the %s collection context when opening the breadcrumb parent", async (source) => {
    const state = createIssueDetailLocationState("Mine", "/issues?view=mine&status=in_progress", "inbox");
    if (source === "location") mockLocation.state = state;
    if (source === "stored") rememberIssueDetailLocationState("PAP-1", state);
    if (source === "query") mockLocation.search = "?from=inbox&fromHref=%2Fissues%3Fview%3Dmine%26status%3Din_progress";
    mockIssuesApi.get.mockResolvedValue(createIssue({
      ancestors: [{ id: "parent-1", identifier: "PAP-0", title: "Parent task" }] as Issue["ancestors"],
    }));
    await act(async () => { renderIssueView(); });
    await flushReact();
    const parentCrumb = mockSetBreadcrumbs.mock.calls.at(-1)![0][1];
    expect(parentCrumb.identifier).toBeUndefined();
    expect(parentCrumb.label).toBe("Parent task");
    expect(parentCrumb.onClick).toBeTypeOf("function");
    parentCrumb.onClick();
    const expected = { label: source === "query" ? "Inbox" : "Mine", href: state.issueDetailBreadcrumb!.href };
    expect(readIssueDetailBreadcrumb("PAP-0", null)).toEqual(expected);

    mockRouteParams.issueId = "PAP-0";
    mockLocation.pathname = "/issues/PAP-0";
    mockLocation.state = null;
    mockLocation.search = "";
    mockIssuesApi.get.mockResolvedValue(createIssue({ id: "parent-1", identifier: "PAP-0", title: "Parent task" }));
    await act(async () => { renderIssueView(); });
    await waitForAssertion(() => {
      const breadcrumbs = mockSetBreadcrumbs.mock.calls.at(-1)![0];
      expect(breadcrumbs[0]).toEqual(expected);
      expect(breadcrumbs.at(-1)?.label).toBe(parentCrumb.label);
    });
  });

  it.each([false, true])("renders a noninteractive private parent with mobile=%s", async (isMobile) => {
    mockSidebarState.isMobile = isMobile;
    mockIssuesApi.get.mockResolvedValue(createIssue({
      ancestors: [{ id: "private-parent", identifier: "PAP-0", locked: true }] as unknown as Issue["ancestors"],
    }));
    await act(async () => { renderIssueView(); });
    await flushReact();
    expect(mockSetBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Tasks", href: "/issues" },
      expect.objectContaining({ label: "Private task", href: undefined }),
      expect.objectContaining({ label: "Issue detail smoke" }),
    ]);
    const parentCrumb = mockSetBreadcrumbs.mock.calls.at(-1)![0][1];
    expect(parentCrumb.identifier).toBeUndefined();
    expect(parentCrumb.onClick).toBeUndefined();
    await act(async () => { renderIssueView(parentCrumb.control); });
    const chip = container.querySelector('[data-testid="locked-issue-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Private");
    expect(container.querySelector('a, [role="link"]')).toBeNull();
  });

  it("keeps the private parent title free of IDs when an open task changes viewport", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({
      ancestors: [{ id: "private-parent", identifier: "PAP-0", locked: true }] as unknown as Issue["ancestors"],
    }));
    const captured: Breadcrumb[][] = [];
    for (const isMobile of [false, true, false]) {
      mockSidebarState.isMobile = isMobile;
      await act(async () => { renderIssueView(); });
      await flushReact();
      captured.push(mockSetBreadcrumbs.mock.calls.at(-1)![0]);
    }

    const { BreadcrumbProvider, useBreadcrumbs } = await vi.importActual<
      typeof import("../context/BreadcrumbContext")
    >("../context/BreadcrumbContext");
    let updateBreadcrumbs: (crumbs: Breadcrumb[]) => void = () => {};
    function RenderBreadcrumbControl() {
      const { breadcrumbs, setBreadcrumbs } = useBreadcrumbs();
      updateBreadcrumbs = setBreadcrumbs;
      return breadcrumbs[1]?.control;
    }
    await act(async () => {
      renderIssueView(<BreadcrumbProvider><RenderBreadcrumbControl /></BreadcrumbProvider>);
    });
    for (const [index, expected] of ["Private", "Private", "Private"].entries()) {
      await act(async () => { updateBreadcrumbs(captured[index]); });
      expect(container.querySelector('[data-testid="locked-issue-chip"]')?.textContent).toBe(expected);
      expect(container.querySelector('a, [role="link"]')).toBeNull();
    }
  });

  it("preserves hierarchy breadcrumbs and label chips when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: false,
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        ancestors: [
          {
            id: "parent-1",
            identifier: "PAP-0",
            title: "Parent task breadcrumb",
          },
        ] as Issue["ancestors"],
        labels: [
          {
            id: "label-1",
            companyId: "company-1",
            name: "Legacy label",
            color: "#22c55e",
            createdAt: new Date("2026-04-21T00:00:00.000Z"),
            updatedAt: new Date("2026-04-21T00:00:00.000Z"),
          },
        ],
        labelIds: ["label-1"],
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    expect(container.textContent).toContain("Parent task breadcrumb");
    expect(container.textContent).toContain("Legacy label");
  });

  it("lifts the redesigned desktop thread into the side-panel header band", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: false,
    });
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      const content = container.querySelector(
        '[data-testid="issue-detail-content"]',
      );
      expect(content).not.toBeNull();
      expect(content!.className).toContain("-mt-4");
      expect(content!.className).toContain("md:-mt-6");
    });
  });

  it.each([
    { coordinator: false, mobile: false }, { coordinator: false, mobile: true },
    { coordinator: true, mobile: false }, { coordinator: true, mobile: true },
  ])("keeps dismissed plugin panes closed (coordinator=$coordinator, mobile=$mobile)", async ({ coordinator, mobile }) => {
    coordinatorPreference.enabled = coordinator;
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
    const task = createIssue();
    mockIssuesApi.get.mockResolvedValue(task);
    const manual = { entityId: "agent-1", runId: "run-1", autoOpen: false,
      slot: { pluginKey: "example.view", id: "screen", displayName: "Live view" } } as import("@/hooks/useTaskPluginPanels").TaskPluginPanel;
    mockTaskPluginPanels.panels = [manual];
    await act(async () => { renderIssueView(); });
    await waitForAssertion(() => expect(mockOpenPanel).toHaveBeenCalled());
    const props = mockOpenPanel.mock.calls.at(-1)![0]?.props.children?.props as {
      accountScope: string; dismissedPluginPanelKeys: Set<string>;
    };
    props.dismissedPluginPanelKeys.add(taskPluginPanelActivationKey(manual, props.accountScope, task));
    mockPanelState.panelVisible = false;
    mockSidebarState.isMobile = mobile;
    mockTaskPluginPanels.panels = [{ ...manual, autoOpen: true }];
    mockSetPanelVisible.mockClear();
    await act(async () => { renderIssueView(); }); await flushReact();
    expect(mockSetPanelVisible).not.toHaveBeenCalledWith(true);
    expect(container.querySelector('[data-testid="mobile-task-side-panel"]')).toBeNull();
    mockTaskPluginPanels.panels = [{ ...manual, runId: "run-2", autoOpen: true }];
    await act(async () => { renderIssueView(); }); await flushReact();
    expect(mockSetPanelVisible).toHaveBeenCalledWith(true);
    if (mobile) expect(container.querySelector('[data-testid="mobile-task-side-panel"]')).not.toBeNull();
  });

  it("does not register a redundant breadcrumb side-panel toggle in Streamlined UI", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockPanelState.panelVisible = false;

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    expect(
      mockSetBreadcrumbToolbar.mock.calls.every(([node]) => node === null),
    ).toBe(true);
  });

  it("retains the production breadcrumb side-panel toggle when Streamlined UI is off", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockPanelState.panelVisible = false;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: false,
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    const toolbar = mockSetBreadcrumbToolbar.mock.calls
      .map(([node]) => node)
      .find((node) => node !== null) as ReactElement<{
      children: ReactElement<{ onToggle: () => void }>;
    }>;
    expect(toolbar).toBeDefined();
    toolbar.props.children.props.onToggle();
    expect(mockSetPanelVisible).toHaveBeenCalledWith(true);
  });

  it("uses task activity for recency and ignores passive revisits", async () => {
    const authRequest = createDeferred<{
      session: { userId: string };
      user: { id: string };
    }>();
    const issue = createIssue({
      title: "Initial recent title",
      status: "todo",
      updatedAt: new Date(100),
    });
    mockAuthApi.getSession.mockReturnValue(authRequest.promise);
    mockIssuesApi.get.mockResolvedValue(issue);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    expect(
      readRecentTasks(getRecentTasksStorageKey("company-1", null), "company-1"),
    ).toEqual([]);

    await act(async () => {
      authRequest.resolve({
        session: { userId: "user-1" },
        user: { id: "user-1" },
      });
    });
    await waitForAssertion(() => {
      expect(
        readRecentTasks(
          getRecentTasksStorageKey("company-1", "user-1"),
          "company-1",
        ),
      ).toEqual([
        expect.objectContaining({
          id: "issue-1",
          title: "Initial recent title",
          status: "todo",
          recordedAt: 100,
        }),
      ]);
    });

    act(() => {
      queryClient.setQueryData(queryKeys.issues.detail("PAP-1"), {
        ...issue,
        title: "Snapshot refresh title",
        status: "in_progress",
        updatedAt: new Date(200),
      });
    });
    await flushReact();

    expect(
      readRecentTasks(
        getRecentTasksStorageKey("company-1", "user-1"),
        "company-1",
      )[0],
    ).toMatchObject({
      title: "Snapshot refresh title",
      status: "in_progress",
      recordedAt: 200,
    });
  });

  it.each([false, true])("renders a linked Decisions-v1 record in task context (Coordinator %s)", async (enabled) => {
    coordinatorPreference.enabled = enabled;
    mockLocation.hash = "#decision-recorded-1";
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableClassicTaskInterface: true, enableStreamlinedUi: false });
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockDecisionsApi.get.mockResolvedValue({
      id: "recorded-1", companyId: "company-1", originIssueId: "issue-1", originAgentId: "agent-1", originRunId: "run-1",
      title: "Choose launch channels", body: "Prepare the approved blog first.", status: "decided", executionStatus: "succeeded",
      chosenOptionId: "blog", options: [{ id: "blog", label: "Own blog first", effects: [] }],
      inputs: [{ id: "reason", label: "Reason" }], inputValues: { reason: "The copy is approved" },
      targetSnapshots: {}, metadata: {}, executions: [], continuationPolicy: "none",
    });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect(container.querySelector("#decision-recorded-1")?.textContent).toContain("The copy is approved"));
    expect(container.querySelector("#decision-recorded-1")?.textContent).toContain("Own blog first");
    expect(container.querySelector("#decision-recorded-1")?.textContent).toContain("Prepare the approved blog first.");
    await waitForAssertion(() => expect(document.activeElement?.id).toBe("decision-recorded-1"));
  });

  it("opens a closed desktop pane and routes an ordinary document to its own tab on direct load", async () => {
    mockPanelState.panelVisible = false;
    mockLocation.hash = "#document-qa-evidence";
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockSetPanelVisible).toHaveBeenCalledWith(true);
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(panel?.props?.documentDeepLink).toMatchObject({
        tab: "document",
        documentKey: "qa-evidence",
      });
    });
  });

  it("leaves ordinary document links to the classic center-column surface", async () => {
    mockPanelState.panelVisible = false;
    mockLocation.hash = "#document-qa-evidence";
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableClassicTaskInterface: true,
    });
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(
        container.querySelector('[data-testid="issue-chat-thread"]'),
      ).not.toBeNull();
      expect(mockSetPanelVisible).not.toHaveBeenCalled();
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(panel?.props?.documentDeepLink).toBeNull();
    });
  });

  it("clears document routing when the URL no longer names a document", async () => {
    mockLocation.hash = "#document-qa-evidence";
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(panel?.props?.documentDeepLink).toMatchObject({
        documentKey: "qa-evidence",
      });
    });

    mockLocation.hash = "#work-product-1";
    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(panel?.props?.documentDeepLink).toBeNull();
    });
  });

  it("opens plan and continuation-summary in the pane without switching to full activity", async () => {
    mockPanelState.panelVisible = false;
    mockLocation.hash = "#document-plan";
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(panel?.props?.documentDeepLink).toMatchObject({
        tab: "plans",
        documentKey: "plan",
      });
    });

    mockSetPanelVisible.mockClear();
    mockLocation.hash = "#document-continuation-summary";
    await act(async () => {
      renderIssueView();
    });
    expect(mockSetPanelVisible).toHaveBeenCalledWith(true);
    await waitForAssertion(() => {
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(panel?.props?.documentDeepLink).toMatchObject({ tab: "document", documentKey: "continuation-summary" });
    });
  });

  it("routes the first document click through the mounted task, including UUID aliases", async () => {
    mockLocation.pathname = "/PAP/issues/PAP-1";
    mockLocation.state = { from: "inbox" };
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => expect(queryClient.getQueryData(queryKeys.issues.detail("PAP-1"))).toBeDefined());
    const getCalls = mockIssuesApi.get.mock.calls.length;
    const link = document.createElement("a");
    link.href = "/PAP/issues/issue-1#document-plan";
    const closePreview = vi.fn((event: Event) => expect(event.defaultPrevented).toBe(true));
    link.addEventListener("click", closePreview);
    container.appendChild(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(closePreview).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("/PAP/issues/PAP-1#document-plan", {
      preventScrollReset: true,
      state: { from: "inbox", taskDocumentScrollEntry: { key: "task-entry", hash: "", pathname: "/PAP/issues/PAP-1" } },
    });
    expect(mockIssuesApi.get).toHaveBeenCalledTimes(getCalls);
  });

  it.each(["modifier", "new-tab", "download"])("preserves native document-link behavior for %s", async (kind) => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => {
      renderIssueView();
    });
    const link = document.createElement("a");
    link.href = "#document-plan";
    if (kind === "new-tab") link.target = "_blank";
    if (kind === "download") link.download = "plan.md";
    container.appendChild(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: kind === "modifier" });
    // Keep jsdom from following the native link after observing our handler.
    link.addEventListener("click", () => expect(event.defaultPrevented).toBe(false), { once: true });
    link.addEventListener("click", (click) => click.preventDefault(), { once: true });
    await act(async () => { link.dispatchEvent(event); });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("replays document routing when the current same-page hash is clicked again", async () => {
    mockLocation.hash = "#document-qa-evidence";
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(
        (panel?.props?.documentDeepLink as { requestId?: number } | null)
          ?.requestId,
      ).toBe(1);
    });

    const link = document.createElement("a");
    link.href = "#document-qa-evidence";
    link.textContent = "QA evidence";
    container.appendChild(link);
    await act(async () => link.click());

    await waitForAssertion(() => {
      const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
        { props?: Record<string, unknown> } | undefined;
      expect(
        (panel?.props?.documentDeepLink as { requestId?: number } | null)
          ?.requestId,
      ).toBe(2);
    });
  });

  it("maximizes the desktop pane once per viewer=full deep link", async () => {
    mockPanelState.panelVisible = false;
    mockLocation.hash = "#document-qa-evidence&viewer=full";
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockSetPanelVisible).toHaveBeenCalledWith(true);
      expect(mockRequestPanelMaximize).toHaveBeenCalledTimes(1);
    });

    // Replaying the same hash (same-page link click) reopens the document but
    // must not re-maximize a pane the user may have deliberately restored.
    const link = document.createElement("a");
    link.href = "#document-qa-evidence&viewer=full";
    link.textContent = "QA evidence";
    container.appendChild(link);
    await act(async () => link.click());
    expect(mockRequestPanelMaximize).toHaveBeenCalledTimes(1);

    // Ending the deep link drops the pending request and re-arms the guard.
    mockLocation.hash = "";
    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      expect(mockClearPanelMaximizeRequest).toHaveBeenCalled();
    });
  });

  it("re-maximizes when navigating to another issue with an identical viewer=full hash", async () => {
    mockPanelState.panelVisible = false;
    mockLocation.hash = "#document-qa-evidence&viewer=full";
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockRequestPanelMaximize).toHaveBeenCalledTimes(1);
    });

    // Navigate to a sibling issue whose URL carries the same document hash.
    // IssueDetail stays mounted; the destination pane must still maximize.
    mockRouteParams.issueId = "PAP-2";
    mockLocation.pathname = "/issues/PAP-2";
    mockIssuesApi.get.mockResolvedValue(
      createIssue({ id: "issue-2", identifier: "PAP-2" }),
    );
    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockRequestPanelMaximize).toHaveBeenCalledTimes(2);
    });
  });

  it("opens Artifacts for existing output without discarding a document deep link", async () => {
    mockLocation.hash = "#document-agents";
    mockIssuesApi.get.mockResolvedValue(createIssue({
      documentSummaries: [{
        id: "agents-doc", companyId: "company-1", issueId: "issue-1",
        key: "agents", title: "AGENTS.md", format: "markdown",
        latestRevisionId: "revision-1", latestRevisionNumber: 1,
        createdByAgentId: "agent-1", createdByUserId: null,
        updatedByAgentId: "agent-1", updatedByUserId: null,
        lockedAt: null, lockedByAgentId: null, lockedByUserId: null,
        createdAt: new Date(), updatedAt: new Date(),
      }],
    }));
    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      const props = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children?.props;
      expect(props?.artifactsOpenRequestId).toBe(1);
      expect(props?.documentDeepLink?.documentKey).toBe("agents");
    });
  });

  it.each([false, true])("registers new artifacts without opening a closed panel (mobile: %s)", async (isMobile) => {
    mockSidebarState.isMobile = isMobile;
    mockLocation.state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");
    mockPanelState.panelVisible = false;
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      expect(queryClient.getQueryData(queryKeys.issues.attachments("PAP-1"))).toEqual([]);
    });
    await flushReact();
    const panelProps = () => (isMobile
      ? mockTaskSidePanelRender.mock.calls.at(-1)?.[0]
      : mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children?.props) as {
        artifactsOpenRequestId?: number;
        onArtifactsOpened: (requestId: number) => void;
      };
    const file = createAttachment({ id: "new-output", createdByAgentId: "agent-1" });
    act(() => { queryClient.setQueryData(queryKeys.issues.attachments("PAP-1"), [file]); });
    await flushReact();
    expect(mockSetPanelVisible).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="mobile-task-side-panel"]')).toBeNull();
    if (isMobile) {
      const toolbar = mockSetMobileToolbar.mock.calls.map(([node]) => node).filter(Boolean).at(-1);
      // The pending arrival is consumed only when the user opens the sheet.
      act(() => toolbar.props.onProperties());
    }
    await waitForAssertion(() => expect(panelProps()?.artifactsOpenRequestId).toBe(1));

    act(() => panelProps().onArtifactsOpened(1));
    await waitForAssertion(() => expect(panelProps().artifactsOpenRequestId).toBeUndefined());
    act(() => { queryClient.setQueryData(queryKeys.issues.attachments("PAP-1"), [{ ...file, originalFilename: "Renamed output" }]); });
    await flushReact();
    expect(panelProps().artifactsOpenRequestId).toBeUndefined();

    act(() => { queryClient.setQueryData(queryKeys.issues.attachments("PAP-1"), [file,
      createAttachment({ id: "next-output", createdByAgentId: "agent-1" }),
    ]); });
    await waitForAssertion(() => expect(panelProps().artifactsOpenRequestId).toBe(2));
  });

  it("opens the mobile properties sheet for a document deep link", async () => {
    mockSidebarState.isMobile = true;
    mockLocation.hash = "#document-qa-evidence";
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockTaskSidePanelRender).toHaveBeenCalledWith(
        expect.objectContaining({
          inline: true,
          documentDeepLink: expect.objectContaining({
            tab: "document",
            documentKey: "qa-evidence",
          }),
        }),
      );
    });
    expect(mockSetPanelVisible).not.toHaveBeenCalled();
    expect(mockOpenPanel).not.toHaveBeenCalled();
  });

  it("opens a plan deep link in the shared mobile side-panel sheet", async () => {
    mockSidebarState.isMobile = true;
    mockLocation.hash = "#document-plan";
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockTaskSidePanelRender).toHaveBeenCalledWith(
        expect.objectContaining({
          inline: true,
          documentDeepLink: expect.objectContaining({
            tab: "plans",
            documentKey: "plan",
          }),
        }),
      );
    });

    const panel = document.querySelector(
      '[data-testid="mobile-task-side-panel"]',
    );
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("inset-0 h-dvh max-h-dvh");
    expect(panel?.className).toContain("w-full");
    expect(panel?.className).toContain("max-w-none");
    expect(panel?.textContent).toContain("Task side panel");
    expect(panel?.querySelector('[data-slot="sheet-close"]')).not.toBeNull();
  });

  it("loads ancestors, subtask membership and created work independently and refreshes on issue activity", async () => {
    const ancestors = [{ id: "parent-task", identifier: "PAP-0", title: "Parent task", status: "in_progress" }] as Issue["ancestors"];
    const createdFrom: Issue["createdFrom"] = {
      issue: { id: "origin-task", identifier: "PAP-168", title: "Origin task", status: "in_progress" },
      run: { id: "run-1", agentId: "qa-agent" },
      agent: { id: "qa-agent", name: "Paperclip QA" },
    };
    const source = createIssue({ ancestors, createdFrom });
    const child = createIssue({ id: "manual-child", parentId: source.id, title: "Manual child" });
    const created = createIssue({ id: "created-task", parentId: null, title: "Created elsewhere" });
    mockIssuesApi.get.mockResolvedValue(source);
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string; createdFromIssueId?: string }) =>
      Promise.resolve(filters?.descendantOf === source.id ? [child] : filters?.createdFromIssueId === source.id ? [created] : []),
    );
    await act(async () => { renderIssueView(); });
    await flushReact();
    await flushReact();
    const taskProjection = () => mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children?.props.tasksTab;
    expect(taskProjection()?.content.props.subtasks.map((row: Issue) => row.id)).toEqual([child.id]);
    expect(taskProjection()?.content.props.createdTasks.map((row: Issue) => row.id)).toEqual([created.id]);
    expect(taskProjection()?.content.props.ancestors).toEqual(ancestors);
    expect(taskProjection()?.content.props.createdFrom).toEqual(createdFrom);
    expect(taskProjection()?.count).toBe(4);

    const next = createIssue({ id: "new-created-task", parentId: source.id });
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string; createdFromIssueId?: string }) =>
      Promise.resolve(filters?.descendantOf === source.id ? [child, next] : filters?.createdFromIssueId === source.id ? [created, next] : []),
    );
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(source.companyId) }); });
    await flushReact();
    expect(taskProjection()?.count).toBe(5);
    expect(taskProjection()?.content.props.createdTasks.map((row: Issue) => row.id)).toContain(next.id);
  });

  it("moves subtask data into the properties panel instead of the chat center pane", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockResolvedValue([
      createIssue({
        id: "child-1",
        parentId: "issue-1",
        identifier: "PAP-2",
        issueNumber: 2,
        title: "Child task",
      }),
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
      { props?: Record<string, unknown> } | undefined;
    expect(panel?.props?.childIssues).toEqual([
      expect.objectContaining({ id: "child-1", identifier: "PAP-2" }),
    ]);
    expect(panel?.props?.onAddSubIssue).toEqual(expect.any(Function));
    expect(container.textContent).not.toContain("Sub-issues");
    expect(mockIssuesListRender).not.toHaveBeenCalled();
  });

  it("hides the full sub-task tree when the task has no subtasks", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockResolvedValue([]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    expect(
      container.querySelector('[data-testid="task-chat-thread"]'),
    ).not.toBeNull();
    expect(mockIssueChatThreadRender).toHaveBeenCalled();

    await flushReact();

    expect(
      container.querySelector('[aria-label="Open file in this issue"]'),
    ).toBeNull();

    expect(container.textContent).not.toContain("Plan decomposition");
    expect(mockIssuesApi.listAcceptedPlanDecompositions).not.toHaveBeenCalled();

    expect(container.textContent).not.toContain("Sub-issues");
    expect(mockIssuesListRender.mock.calls).not.toContainEqual([
      expect.objectContaining({ isLoading: false }),
    ]);
  });

  it("keeps the properties panel stable across unrelated chat-detail renders", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const detail = (
      <QueryClientProvider client={queryClient}>
        <IssueDetail />
      </QueryClientProvider>
    );

    await act(async () => {
      root.render(detail);
    });
    await flushReact();
    await flushReact();

    const panelOpenCount = mockOpenPanel.mock.calls.length;
    expect(panelOpenCount).toBeGreaterThan(0);

    // React Query returns a new mutation result object on render. The panel
    // effect must depend on the stable mutate function rather than that wrapper
    // object, or openPanel's state update recursively renders
    // IssueDetail until React throws "Maximum update depth exceeded".
    await act(async () => {
      root.render(detail);
    });
    await flushReact();

    expect(mockOpenPanel).toHaveBeenCalledTimes(panelOpenCount);
  });

  it("does not loop openPanel when the sub-task list query is still loading (PAP-508)", async () => {
    // While the descendant-issues query is still in flight, `data` is undefined.
    // A literal `= []` default for that `data` mints a new array reference on
    // every render, which destabilizes the child-derived panel key, re-firing
    // openPanel each render until
    // React throws "Maximum update depth exceeded". Keep the list query pending
    // so `data` stays undefined and the stabilization of the empty default is
    // the only thing preventing the loop. A fresh root element is rendered each
    // pass so React actually re-renders IssueDetail (a reused element reference
    // lets the reconciler bail out, masking the loop).
    const pendingListRequest = createDeferred<Issue[]>();
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockReturnValue(pendingListRequest.promise);
    const renderDetail = () => (
      <QueryClientProvider client={queryClient}>
        <IssueDetail />
      </QueryClientProvider>
    );

    await act(async () => {
      root.render(renderDetail());
    });
    await flushReact();
    await flushReact();

    const panelOpenCount = mockOpenPanel.mock.calls.length;
    expect(panelOpenCount).toBeGreaterThan(0);

    await act(async () => {
      root.render(renderDetail());
    });
    await flushReact();

    expect(mockOpenPanel).toHaveBeenCalledTimes(panelOpenCount);

    pendingListRequest.resolve([]);
    await flushReact();
  });

  it.each([false, true])("keeps the panel stable while projects are still loading (Classic: %s)", async classic => {
    const pendingProjects = createDeferred<Project[]>();
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableClassicTaskInterface: classic });
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockProjectsApi.list.mockReturnValue(pendingProjects.promise);
    const renderDetail = () => <QueryClientProvider client={queryClient}><IssueDetail /></QueryClientProvider>;
    try {
      await act(async () => root.render(renderDetail()));
      await flushReact();
      await flushReact();
      const panelOpenCount = mockOpenPanel.mock.calls.length;
      expect(panelOpenCount).toBeGreaterThan(0);
      await act(async () => root.render(renderDetail()));
      await flushReact();
      expect(mockOpenPanel).toHaveBeenCalledTimes(panelOpenCount);
    } finally {
      const beforeCompletion = mockOpenPanel.mock.calls.length;
      pendingProjects.resolve([]);
      await waitForAssertion(() => expect(mockOpenPanel.mock.calls.length).toBeGreaterThan(beforeCompletion));
    }
    const settledCount = mockOpenPanel.mock.calls.length;
    await act(async () => root.render(renderDetail()));
    await flushReact();
    expect(mockOpenPanel).toHaveBeenCalledTimes(settledCount);
  });

  it("does not load or render decision sections in the issue header", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_review",
        reviewAttention: {
          state: "covered",
          reason: "Review has a maintained action path.",
          paths: [
            {
              kind: "interaction",
              label: "Pending request confirmation",
              responder: "Board",
              since: "2026-04-21T00:00:00.000Z",
              ref: "interaction-1",
            },
          ],
        },
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Issue detail smoke");
    expect(
      container.querySelector('[data-testid="issue-review-panel"]'),
    ).toBeNull();
    expect(mockDecisionsApi.list).not.toHaveBeenCalled();
  });

  it("updates status from the task header control and hides the priority control (PAP-411)", async () => {
    const issue = createIssue({ status: "todo", priority: "medium" });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.update.mockImplementation(
      async (_issueId: string, data: Record<string, unknown>) => ({
        ...issue,
        ...data,
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const statusButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change status (current: todo)"]',
    );
    const priorityButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change priority (current: medium)"]',
    );
    expect(statusButton).not.toBeNull();
    // PAP-411: priority UI is hidden behind SHOW_TASK_PRIORITY_UI (off), so the header
    // priority control must not render.
    expect(priorityButton).toBeNull();

    await act(async () => {
      statusButton!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await waitForAssertion(() => {
      expect(mockIssuesApi.update).toHaveBeenCalledWith(issue.identifier, {
        status: "done",
      });
    });
    expect(mockIssuesApi.update).not.toHaveBeenCalledWith(
      issue.identifier,
      expect.objectContaining({ priority: expect.anything() }),
    );

    mockIssuesApi.update.mockReset();
  });

  it.each(["verified", "unverified", "unverified-plain-http", "stale", "denied"] as const)("offers exactly one native export recovery control with %s preservation access or source", async mode => {
    // Plain-HTTP LAN and tailnet previews have no crypto.randomUUID.
    const originalCrypto = globalThis.crypto;
    if (mode === "unverified-plain-http")
      vi.stubGlobal("crypto", { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
    try {
    const action = {
      id: "file-recovery", companyId: "company-1", sourceIssueId: "issue-1",
      kind: "active_run_watchdog", cause: "native_workspace_sync_out_retry_exhausted",
      status: "active", ownerType: "system", evidence: { runId: "stopped-run", workspaceRecovery: {
        schema: "paperclip.workspace-recovery.v1", runId: "stopped-run", status: "blocked",
        stage: "restoring_files", requestIds: [], retryable: true,
      }, systemRecovery: { state: "exhausted", preservationOperationIds: [] } },
    } as unknown as NonNullable<Issue["activeRecoveryAction"]>;
    const interruption: NonNullable<Issue["interruption"]> = { intentId: "held-input", responsibility: "system", state: "failed", nextRetryAt: null,
      canRetry: true, userAction: null, sourceRunIds: ["stopped-run"], observedRunId: "stopped-run",
      retryWait: { reason: "saved_work_recovery_failed",
        message: "Saving the agent's files failed after automatic retries. Retry to try again; the agent will not repeat its work." } };
    const issue = createIssue({ status: "blocked", assigneeAgentId: "agent-1", activeRecoveryAction: action, interruption,
      executionBlocker: { runId: "stopped-run", cause: "native_workspace_sync_out_retry_exhausted", canRetry: false, workspaceRepairRequired: true,
        workspaceRecovery: { status: "blocked", stage: "restoring_files", canRetry: true } } as Issue["executionBlocker"],
    });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "file-operator" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "file-operator", source: "session",
      isInstanceAdmin: false, companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: mode === "denied" ? "viewer" : "operator" }],
    });
    mockIssuesApi.recoveryActions.mockResolvedValue({ active: action, actions: [action], sourceInspection: {
      actionId: mode === "stale" ? "other-action" : action.id, runId: "stopped-run",
      status: mode.startsWith("unverified") ? "blocked" : "verified", scope: "recorded_source_identity",
    } });
    mockIssuesApi.recoverWorkspace.mockResolvedValue({ actionId: action.id, status: "queued" });
    mockIssuesApi.retryTask.mockResolvedValue({ requestId: "export-retry", accepted: true, stale: false, presentation: interruption });
    await act(async () => renderIssueView());
    const labels = () => [...container.querySelectorAll("button")].map(button => button.textContent ?? "");
    if (mode === "denied") {
      await waitForAssertion(() => expect(container.textContent).toContain("A board member with task access"));
      expect(labels().some(label => ["Recover saved files", "Retry"].includes(label))).toBe(false);
      expect(mockIssuesApi.recoverWorkspace).not.toHaveBeenCalled();
      expect(mockIssuesApi.retryTask).not.toHaveBeenCalled();
      return;
    }
    if (mode !== "verified") {
      // The notice says "Retry to try again"; an unverifiable source must not
      // leave it without a Retry. The server re-verifies the source.
      await waitForAssertion(() => expect(labels()).toContain("Retry"));
      expect(labels()).not.toContain("Recover saved files");
      expect(container.textContent).not.toContain("Refresh the task");
      const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!;
      await act(async () => retry.click());
      await waitForAssertion(() => expect(mockIssuesApi.retryTask).toHaveBeenCalledExactlyOnceWith(issue.id, {
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        observedRunId: "stopped-run",
      }));
      expect(mockIssuesApi.recoverWorkspace).not.toHaveBeenCalled();
      expect(mockIssuesApi.resolveRecoveryAction).not.toHaveBeenCalled();
      return;
    }
    await waitForAssertion(() => expect([...container.querySelectorAll("button")]
      .some(button => button.textContent === "Recover saved files")).toBe(true));
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(false);
    const preserve = [...container.querySelectorAll("button")].find(button => button.textContent === "Recover saved files")!;
    await act(async () => preserve.click());
    await waitForAssertion(() => expect(mockIssuesApi.recoverWorkspace).toHaveBeenCalledExactlyOnceWith("issue-1", {
      actionId: action.id, runId: "stopped-run", idempotencyKey: expect.any(String),
    }));
    expect(mockIssuesApi.resolveRecoveryAction).not.toHaveBeenCalled();
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
    expect(issue.executionBlocker?.workspaceRepairRequired).toBe(true);
    expect(container.textContent).not.toContain("Saved files recovered");
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps the existing Retry path for exhausted legacy workspace restoration", async () => {
    const interruption: NonNullable<Issue["interruption"]> = { intentId: "legacy-input", responsibility: "system", state: "failed", nextRetryAt: null,
      canRetry: true, userAction: null, sourceRunIds: ["legacy-run"], observedRunId: "legacy-run" };
    const issue = createIssue({ status: "blocked", assigneeAgentId: "agent-1", interruption,
      activeRecoveryAction: { id: "legacy-recovery", companyId: "company-1", sourceIssueId: "issue-1",
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", status: "active", ownerType: "system",
        evidence: { runId: "legacy-run", workspaceRestoreFailure: "restore_failed",
          workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: ["legacy-lease"] },
          systemRecovery: { state: "exhausted" } },
      } as unknown as NonNullable<Issue["activeRecoveryAction"]>,
      executionBlocker: { runId: "legacy-run", cause: "legacy_execution_requires_reconciliation",
        canRetry: true, workspaceRepairRequired: true } as Issue["executionBlocker"],
    });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "legacy-operator" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ userId: "legacy-operator", source: "session",
      isInstanceAdmin: false, companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "operator" }],
    });
    mockIssuesApi.retryTask.mockResolvedValue({ requestId: "legacy-retry", accepted: true, stale: false, presentation: interruption });
    await act(async () => renderIssueView());
    await waitForAssertion(() => expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry")).toBe(true));
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Recover saved files")).toBe(false);
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!;
    await act(async () => retry.click());
    await waitForAssertion(() => expect(mockIssuesApi.retryTask).toHaveBeenCalledExactlyOnceWith(issue.id, {
      idempotencyKey: expect.any(String), observedRunId: "legacy-run",
    }));
    expect(mockIssuesApi.recoverWorkspace).not.toHaveBeenCalled();
    expect(mockIssuesApi.resolveRecoveryAction).not.toHaveBeenCalled();
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
    expect(issue.executionBlocker?.workspaceRepairRequired).toBe(true);
  });

  it("moves a blocked task back to todo when the no-live-path notice tries again", async () => {
    const activeRecoveryAction = {
      id: "recovery-action-1",
    } as NonNullable<Issue["activeRecoveryAction"]>;
    const issue = createIssue({
      status: "blocked",
      assigneeAgentId: "agent-1",
      activeRecoveryAction,
    });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.resolveRecoveryAction.mockResolvedValue({
      issue: { ...issue, status: "todo", activeRecoveryAction: null },
      recoveryAction: { ...activeRecoveryAction, status: "resolved" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const tryAgain = container.querySelector<HTMLButtonElement>(
      '[data-testid="mock-no-live-path-try-again"]',
    );
    expect(tryAgain).not.toBeNull();

    await act(async () => {
      tryAgain!.click();
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.resolveRecoveryAction).toHaveBeenCalledWith(
        issue.identifier,
        {
          actionId: activeRecoveryAction.id,
          outcome: "restored",
          sourceIssueStatus: "todo",
        },
      );
    });

    mockIssuesApi.resolveRecoveryAction.mockReset();
  });

  it.each(["success", "failure", "pending question", "outdated plan", "current plan"])("connects the inline disposition retry to current state (%s)", async outcome => {
    const fail = outcome === "failure";
    const actionId = "recovery-action-inline";
    const snapshot: DispositionRecoverySnapshot = { kind: "disposition_repair_escalated", actionId, attemptCount: 2, maxAttempts: 2, reason: "unchanged_source_state_exhausted", assigneeAgentId: "agent-1" };
    const issue = createIssue({ status: "blocked", assigneeAgentId: "agent-1", activeRecoveryAction: {
      id: actionId, status: "active", kind: "deliberate_wait_without_target", ownerType: "board", returnOwnerAgentId: "agent-1", wakePolicy: { type: "board_escalation" },
      companyId: "company-1", sourceIssueId: "issue-1", recoveryIssueId: null, ownerAgentId: null, ownerUserId: null,
      previousOwnerAgentId: "agent-1", cause: "deliberate_wait_without_target", fingerprint: "fixture", evidence: {}, nextAction: "Retry", monitorPolicy: null,
      attemptCount: 2, maxAttempts: 2, timeoutAt: null, lastAttemptAt: null, outcome: null, resolutionNote: null, resolvedAt: null, createdAt: new Date(), updatedAt: new Date(),
    } });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.listComments.mockResolvedValue([{ id: "notice-inline", companyId: issue.companyId, issueId: issue.id, authorType: "system", body: "Unrelated prose", createdAt: new Date(), updatedAt: new Date(), metadata: { version: 1, sections: [], recovery: snapshot } }]);
    if (outcome === "pending question") mockIssuesApi.listInteractions.mockResolvedValue([{ id: "question-1", kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] } }]);
    if (outcome.endsWith("plan")) {
      mockIssuesApi.getDocument.mockResolvedValue({
        id: "plan-document", companyId: issue.companyId, issueId: issue.id, key: "plan", title: "Plan", format: "markdown", body: "# Current plan",
        latestRevisionId: "revision-4", latestRevisionNumber: 4,
        createdAt: new Date("2026-11-01T10:00:00Z"), updatedAt: new Date("2026-11-01T10:03:00Z"),
        createdByAgentId: "agent-1", createdByUserId: null, updatedByAgentId: "agent-1", updatedByUserId: null,
        lockedAt: null, lockedByAgentId: null, lockedByUserId: null,
      });
      const fixture = (await import("@/fixtures/issueThreadInteractionFixtures")).genericPendingRequestConfirmationInteraction;
      const revision = outcome === "outdated plan" ? 3 : 4;
      mockIssuesApi.listInteractions.mockResolvedValue([{
        ...fixture, companyId: issue.companyId, issueId: issue.id, createdAt: new Date("2026-11-01T10:01:00Z"),
        payload: { version: 1, prompt: "Approve the plan?", target: { type: "issue_document", key: "plan", documentId: "plan-document", revisionId: `revision-${revision}`, revisionNumber: revision } },
      }]);
    }
    if (fail) mockIssuesApi.resolveRecoveryAction.mockRejectedValue(new Error("The task is now paused."));
    else mockIssuesApi.resolveRecoveryAction.mockResolvedValue({ issue: { ...issue, status: "todo", activeRecoveryAction: null }, recoveryAction: { ...issue.activeRecoveryAction, status: "resolved" } });
    await act(async () => renderIssueView());
    await flushReact(); await flushReact();
    const retry = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Retry agent");
    expect(retry).toBeDefined();
    if (outcome === "pending question" || outcome === "current plan") {
      expect(retry!.disabled).toBe(true);
      expect(container.textContent).toContain("Respond to the pending question or confirmation before retrying.");
      await act(async () => retry!.click());
      expect(mockIssuesApi.resolveRecoveryAction).not.toHaveBeenCalled();
      mockIssuesApi.resolveRecoveryAction.mockReset();
      return;
    }
    expect(retry!.disabled).toBe(false);
    await act(async () => retry!.click());
    await waitForAssertion(() => {
      expect(mockIssuesApi.resolveRecoveryAction).toHaveBeenCalledExactlyOnceWith(issue.identifier, { actionId, outcome: "restored", sourceIssueStatus: "todo" });
      expect(container.textContent).toContain(fail ? "Couldn’t confirm the retry. The task is now paused." : "Retry requested");
    });
    mockIssuesApi.resolveRecoveryAction.mockReset();
  });

  it("removes an inbox-origin archived issue and restores it when the toast Undo action is pressed", async () => {
    const issue = createIssue({
      id: "issue-1",
      identifier: "PAP-1",
      title: "Archive me from detail",
    });
    const otherIssue = createIssue({
      id: "issue-2",
      identifier: "PAP-2",
      title: "Keep me in inbox",
    });
    const archiveRequest = createDeferred<{ id: string; archivedAt: Date }>();
    mockLocation.state = createIssueDetailLocationState(
      "Inbox",
      "/inbox/mine",
      "inbox",
    );
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.archiveFromInbox.mockReturnValue(archiveRequest.promise);

    const mineKey = [
      ...queryKeys.issues.listMineByMe("company-1"),
      "with-routine-executions",
      "live-descendant-summary",
    ] as const;
    const compactKey = [
      ...queryKeys.issues.list("company-1"),
      "compact",
      "with-routine-executions",
      "live-descendant-summary",
    ] as const;
    const touchedKey = [
      ...queryKeys.issues.listTouchedByMe("company-1"),
      "with-routine-executions",
      "live-descendant-summary",
    ] as const;
    const unreadKey = queryKeys.issues.listUnreadTouchedByMe("company-1");
    queryClient.setQueryData<Issue[]>(mineKey, [issue, otherIssue]);
    queryClient.setQueryData<Issue[]>(compactKey, [issue, otherIssue]);
    queryClient.setQueryData<Issue[]>(touchedKey, [issue, otherIssue]);
    queryClient.setQueryData<Issue[]>(unreadKey, [issue, otherIssue]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More task actions"]',
    );
    await act(async () => moreButton!.click());
    const archiveButton =
      Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Archive from inbox") ??
      null;
    expect(archiveButton).not.toBeNull();

    await act(async () => {
      archiveButton!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    await waitForAssertion(() => {
      expect(
        queryClient.getQueryData<Issue[]>(mineKey)?.map((item) => item.id),
      ).toEqual(["issue-2"]);
      expect(
        queryClient.getQueryData<Issue[]>(compactKey)?.map((item) => item.id),
      ).toEqual(["issue-2"]);
      expect(
        queryClient.getQueryData<Issue[]>(touchedKey)?.map((item) => item.id),
      ).toEqual(["issue-2"]);
      expect(
        queryClient.getQueryData<Issue[]>(unreadKey)?.map((item) => item.id),
      ).toEqual(["issue-2"]);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    await act(async () => {
      archiveRequest.resolve({ id: "issue-1", archivedAt: new Date() });
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith("/inbox/mine", { replace: true });
    const archiveToast = mockPushToast.mock.calls
      .map(([toast]) => toast)
      .find((toast) => toast.title === "Task archived from inbox");
    expect(archiveToast).toMatchObject({
      title: "Task archived from inbox",
      tone: "success",
      action: { label: "Undo" },
    });
    expect(archiveToast?.action?.onClick).toEqual(expect.any(Function));

    const staleInboxFetch = createDeferred<Issue[]>();
    const staleInboxRequest = queryClient
      .fetchQuery({
        queryKey: mineKey,
        queryFn: () => staleInboxFetch.promise,
      })
      .catch(() => undefined);
    const staleCompactFetch = createDeferred<Issue[]>();
    const staleCompactRequest = queryClient
      .fetchQuery({
        queryKey: compactKey,
        queryFn: () => staleCompactFetch.promise,
      })
      .catch(() => undefined);
    await waitForAssertion(() => {
      expect(queryClient.isFetching({ queryKey: mineKey })).toBe(1);
      expect(queryClient.isFetching({ queryKey: compactKey })).toBe(1);
    });

    await act(async () => {
      archiveToast.action.onClick();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    staleInboxFetch.resolve([otherIssue]);
    staleCompactFetch.resolve([otherIssue]);
    await staleInboxRequest;
    await staleCompactRequest;
    await waitForAssertion(() => {
      expect(mockIssuesApi.unarchiveFromInbox).toHaveBeenCalledWith("issue-1");
      expect(
        queryClient.getQueryData<Issue[]>(mineKey)?.map((item) => item.id),
      ).toEqual(["issue-1", "issue-2"]);
      expect(
        queryClient.getQueryData<Issue[]>(compactKey)?.map((item) => item.id),
      ).toEqual(["issue-1", "issue-2"]);
      expect(
        queryClient.getQueryData<Issue[]>(touchedKey)?.map((item) => item.id),
      ).toEqual(["issue-1", "issue-2"]);
      expect(
        queryClient.getQueryData<Issue[]>(unreadKey)?.map((item) => item.id),
      ).toEqual(["issue-1", "issue-2"]);
      expect(mockPushToast).toHaveBeenCalledWith({
        title: "Task restored to inbox",
        tone: "success",
      });
    });
  });

  it("keeps an archived task hidden and reports an error when toast Undo fails", async () => {
    const issue = createIssue({
      id: "issue-1",
      identifier: "PAP-1",
      title: "Archive me from detail",
    });
    mockLocation.state = createIssueDetailLocationState(
      "Inbox",
      "/inbox/mine",
      "inbox",
    );
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.unarchiveFromInbox.mockRejectedValue(
      new Error("Inbox policy denied"),
    );

    const mineKey = [
      ...queryKeys.issues.listMineByMe("company-1"),
      "with-routine-executions",
      "live-descendant-summary",
    ] as const;
    queryClient.setQueryData<Issue[]>(mineKey, [issue]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More task actions"]',
    );
    await act(async () => moreButton!.click());
    const archiveButton =
      Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Archive from inbox") ??
      null;
    expect(archiveButton).not.toBeNull();
    await act(async () => {
      archiveButton!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await waitForAssertion(() => {
      expect(queryClient.getQueryData<Issue[]>(mineKey)).toEqual([]);
    });

    const archiveToast = mockPushToast.mock.calls
      .map(([toast]) => toast)
      .find((toast) => toast.title === "Task archived from inbox");
    expect(archiveToast?.action?.onClick).toEqual(expect.any(Function));

    await act(async () => {
      archiveToast.action.onClick();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await waitForAssertion(() => {
      expect(mockIssuesApi.unarchiveFromInbox).toHaveBeenCalledWith("issue-1");
      expect(queryClient.getQueryData<Issue[]>(mineKey)).toEqual([]);
      expect(mockPushToast).toHaveBeenCalledWith({
        title: "Undo failed",
        body: "Inbox policy denied",
        tone: "error",
      });
    });
  });

  it("archives a task-page issue with y and returns to the inbox", async () => {
    mockLocation.state = createIssueDetailLocationState(
      "Tasks",
      "/issues/all",
      "issues",
    );
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      feedbackDataSharingPreference: "prompt",
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More task actions"]',
    );
    await act(async () => moreButton!.click());
    expect(
      Array.from(document.body.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Archive from inbox",
      ),
    ).toBe(false);

    mockIssuesApi.archiveFromInbox.mockClear();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "y", bubbles: true }),
    );
    await waitForAssertion(() => {
      expect(mockIssuesApi.archiveFromInbox).toHaveBeenCalledWith("issue-1");
      expect(mockNavigate).toHaveBeenCalledWith("/inbox", { replace: true });
    });
  });

  it("arms the inbox archive shortcut only for the selected inbox row", async () => {
    mockLocation.state = armIssueDetailInboxQuickArchive(
      createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox"),
    );
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      feedbackDataSharingPreference: "prompt",
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const panel = mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children as
      { props?: Record<string, unknown> } | undefined;
    expect(panel?.props?.issueLinkState).toEqual(
      expect.objectContaining({
        issueDetailSource: "inbox",
        issueDetailInboxQuickArchiveArmed: false,
      }),
    );

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "y", bubbles: true }),
    );
    await waitForAssertion(() => {
      expect(mockIssuesApi.archiveFromInbox).toHaveBeenCalledWith("issue-1");
    });
  });

  it("uses history Back for a live inbox origin and a route fallback for direct links", async () => {
    mockSidebarState.isMobile = true;
    mockLocation.state = createIssueDetailLocationState(
      "Inbox",
      "/inbox/mine",
      "inbox",
    );
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const liveToolbar = [...mockSetMobileToolbar.mock.calls]
      .map(([node]) => node)
      .filter(Boolean)
      .at(-1) as ReactNode;
    const toolbarContainer = document.createElement("div");
    document.body.appendChild(toolbarContainer);
    const toolbarRoot = createRoot(toolbarContainer);
    flushSync(() => toolbarRoot.render(liveToolbar));
    const historyLengthSpy = vi
      .spyOn(window.history, "length", "get")
      .mockReturnValue(2);
    await act(async () => {
      toolbarContainer
        .querySelector<HTMLButtonElement>('button[aria-label="Back to inbox"]')!
        .click();
    });
    expect(mockNavigate).toHaveBeenCalledWith(-1);
    historyLengthSpy.mockRestore();

    flushSync(() => toolbarRoot.unmount());
    toolbarContainer.remove();
    mockNavigate.mockClear();
    mockSetMobileToolbar.mockClear();
    mockLocation.state = null;
    mockLocation.search = "?from=inbox&fromHref=%2Finbox%2Fmine";

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();
    mockNavigate.mockClear();

    const directToolbar = [...mockSetMobileToolbar.mock.calls]
      .map(([node]) => node)
      .filter(Boolean)
      .at(-1) as ReactNode;
    const directToolbarContainer = document.createElement("div");
    document.body.appendChild(directToolbarContainer);
    const directToolbarRoot = createRoot(directToolbarContainer);
    flushSync(() => directToolbarRoot.render(directToolbar));
    await act(async () => {
      directToolbarContainer
        .querySelector<HTMLButtonElement>('button[aria-label="Back to inbox"]')!
        .click();
    });
    expect(mockNavigate).toHaveBeenCalledWith("/inbox/mine");

    flushSync(() => directToolbarRoot.unmount());
    directToolbarContainer.remove();
  });

  it("shows assignee and originating avatars in the issue header metadata", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        assigneeAgentId: "agent-1",
        projectId: "project-1",
        createdByUserId: "user-1",
      }),
    );
    mockAgentsApi.list.mockResolvedValue([createAgent({ name: "CodexCoder" })]);
    mockProjectsApi.list.mockResolvedValue([
      { id: "project-1", name: "Core Product", color: "#2563eb" },
    ]);
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: {
            id: "user-1",
            name: "Dotta",
            email: "dotta@example.com",
            image: null,
          },
        },
      ],
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      const avatarStack = container.querySelector(
        '[data-testid="issue-attribution-avatar-stack"]',
      );
      const assigneeAvatar = container.querySelector(
        '[data-testid="issue-assignee-avatar"]',
      );
      const originatingAvatar = container.querySelector(
        '[data-testid="issue-originating-avatar"]',
      );

      expect(container.textContent).toContain("Core Product");
      expect(avatarStack).toBeTruthy();
      expect(assigneeAvatar?.getAttribute("aria-label")).toBe(
        "Assignee: CodexCoder",
      );
      expect(originatingAvatar?.getAttribute("aria-label")).toBe(
        "Originating: Dotta",
      );
      expect(assigneeAvatar?.getAttribute("title")).toBeNull();
      expect(originatingAvatar?.getAttribute("title")).toBeNull();
      expect(avatarStack?.textContent).not.toContain("Assignee");
      expect(avatarStack?.textContent).not.toContain("Originating");
      expect(avatarStack?.textContent).not.toContain("CodexCoder");
      expect(avatarStack?.textContent).not.toContain("Dotta");
    });

    const pointerEvent = window.PointerEvent ?? MouseEvent;
    const assigneeAvatar = container.querySelector(
      '[data-testid="issue-assignee-avatar"]',
    );
    const originatingAvatar = container.querySelector(
      '[data-testid="issue-originating-avatar"]',
    );

    await act(async () => {
      assigneeAvatar?.dispatchEvent(
        new pointerEvent("pointermove", { bubbles: true }),
      );
    });
    await waitForAssertion(() => {
      const tooltip = document.body.querySelector(
        '[data-testid="issue-assignee-tooltip"]',
      );
      expect(tooltip?.textContent).toContain("Assignee");
      expect(tooltip?.textContent).toContain("CodexCoder");
    });

    await act(async () => {
      originatingAvatar?.dispatchEvent(
        new pointerEvent("pointermove", { bubbles: true }),
      );
    });
    await waitForAssertion(() => {
      const tooltip = document.body.querySelector(
        '[data-testid="issue-originating-tooltip"]',
      );
      expect(tooltip?.textContent).toContain("Originating");
      expect(tooltip?.textContent).toContain("Dotta");
    });
  });

  it("attributes an agent-created issue to the transitive responsible user with a via affordance", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        assigneeAgentId: "agent-1",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        responsibleUserId: "user-1",
      }),
    );
    mockAgentsApi.list.mockResolvedValue([createAgent({ name: "CodexCoder" })]);
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: {
            id: "user-1",
            name: "Dotta",
            email: "dotta@example.com",
            image: null,
          },
        },
      ],
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      const originatingAvatar = container.querySelector(
        '[data-testid="issue-originating-avatar"]',
      );
      expect(originatingAvatar?.getAttribute("aria-label")).toBe(
        "Originating: Dotta · via CodexCoder",
      );
    });

    const pointerEvent = window.PointerEvent ?? MouseEvent;
    const originatingAvatar = container.querySelector(
      '[data-testid="issue-originating-avatar"]',
    );
    await act(async () => {
      originatingAvatar?.dispatchEvent(
        new pointerEvent("pointermove", { bubbles: true }),
      );
    });
    await waitForAssertion(() => {
      const tooltip = document.body.querySelector(
        '[data-testid="issue-originating-tooltip"]',
      );
      expect(tooltip?.textContent).toContain("Dotta");
      expect(tooltip?.textContent).toContain("via CodexCoder");
    });
  });

  it("keeps a queued turn's starting input in history after reopen", async () => {
    const opener = createIssueComment({ id: "reopen-input" });
    const followUp = createIssueComment({ id: "later-input", createdAt: new Date("2026-04-21T00:00:07.000Z") });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "todo", assigneeAgentId: "agent-1", executionRunId: null }));
    mockIssuesApi.listComments.mockResolvedValue([opener, followUp]);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [opener, followUp], latestCommentId: followUp.id, hasMore: false });
    const queuedRuns = [{
      runId: "reopened-run", status: "queued", contextIssueId: "issue-1", agentId: "agent-1",
      adapterType: "paperclip_runner", startedAt: null, finishedAt: null,
      createdAt: "2026-04-21T00:00:06.000Z", invocationSource: "automation",
      wakeupRequestId: "reopen-wake", wakeCommentIds: [opener.id, followUp.id],
    }];
    mockActivityApi.recentRunsForIssue.mockResolvedValue(queuedRuns);
    mockActivityApi.runsForIssue.mockResolvedValue(queuedRuns);
    const queue = createQueuedCommentQueue({
      queueId: "reopen-wake", state: "queued", targetRunId: null,
      steeringDisposition: "temporarily_unavailable",
      entries: [opener, followUp].map((comment, position) => ({ comment, position, canEdit: true, canDiscard: true })),
    });
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockIssuesApi.reorderQueuedComments.mockResolvedValue(queue);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(mockIssuesApi.getQueuedComments).toHaveBeenCalled();
      expect(props?.comments.find((comment: IssueComment) => comment.id === opener.id))
        .toMatchObject({ body: opener.body });
      expect(props?.comments.find((comment: IssueComment) => comment.id === opener.id)?.consumedByRunId).toBeFalsy();
      expect(props?.comments.find((comment: IssueComment) => comment.id === opener.id)?.queueState).toBeUndefined();
      expect(props?.queuedCommentQueue?.entries.map((entry: { comment: IssueComment }) => entry.comment.id))
        .toEqual([followUp.id]);
    });
    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
    await act(async () => props.onReorderQueuedComments([followUp.id], queue.revision));
    expect(mockIssuesApi.reorderQueuedComments).toHaveBeenCalledWith("issue-1", {
      orderedCommentIds: [opener.id, followUp.id], queueId: queue.queueId, revision: queue.revision,
    });
  });

  it.each(["still starting", "sealed into its first turn"] as const)(
    "shows a message the booting run's first turn takes as sent, not queued (%s)",
    async (stage) => {
      const followUp = createIssueComment({ id: "boot-follow-up", body: "Steer while the sandbox boots",
        createdAt: new Date("2026-04-21T00:00:05.000Z"), updatedAt: new Date("2026-04-21T00:00:05.000Z") });
      mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1",
        executionRunId: "run-boot" }));
      mockIssuesApi.listComments.mockResolvedValue([followUp]);
      mockIssuesApi.recentComments.mockResolvedValue({ comments: [followUp], latestCommentId: followUp.id, hasMore: false });
      const bootingRun = {
        id: "run-boot", status: "running", invocationSource: "assignment", triggerDetail: null,
        contextCommentId: null, contextWakeCommentId: null,
        startedAt: "2026-04-21T00:00:00.000Z", finishedAt: null, createdAt: "2026-04-21T00:00:00.000Z",
        agentId: "agent-1", agentName: "Codie", adapterType: "paperclip_runner", issueId: "issue-1",
      };
      mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(bootingRun);
      mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([bootingRun]);
      // Staging PAP-4454: the server hides a sealed message from the queue,
      // and steering is unavailable until the sandbox's session is up.
      mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
        queueId: "boot-wake", state: "deferred", targetRunId: "run-boot",
        steeringDisposition: "temporarily_unavailable",
        entries: stage === "still starting" ? [{ comment: followUp, position: 0, canEdit: true, canDiscard: true }] : [],
        firstTurnCommentIds: [followUp.id],
      }));
      await act(async () => renderIssueView());
      await waitForAssertion(() => {
        expect(mockIssuesApi.getQueuedComments).toHaveBeenCalled();
        const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
        const bubble = props?.comments.find((comment: IssueComment) => comment.id === followUp.id);
        expect(bubble).toMatchObject({ body: followUp.body, consumedByRunId: "run-boot" });
        expect(bubble?.queueState).toBeUndefined();
        expect(props?.queuedCommentQueue?.entries ?? []).toEqual([]);
      });
    },
  );

  it("keeps first-turn messages the view hides in a reorder of the rest", async () => {
    const at = (second: number) => new Date(`2026-04-21T00:00:0${second}.000Z`);
    const joining = createIssueComment({ id: "joins-first-turn", body: "Plain text", createdAt: at(5), updatedAt: at(5) });
    const withFileA = createIssueComment({ id: "with-file-a", body: "First file", createdAt: at(6), updatedAt: at(6) });
    const withFileB = createIssueComment({ id: "with-file-b", body: "Second file", createdAt: at(7), updatedAt: at(7) });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1",
      executionRunId: "run-boot" }));
    mockIssuesApi.listComments.mockResolvedValue([joining, withFileA, withFileB]);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [joining, withFileA, withFileB],
      latestCommentId: withFileB.id, hasMore: false });
    const bootingRun = {
      id: "run-boot", status: "running", invocationSource: "assignment", triggerDetail: null,
      contextCommentId: null, contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z", finishedAt: null, createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1", agentName: "Codie", adapterType: "paperclip_runner", issueId: "issue-1",
    };
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(bootingRun);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([bootingRun]);
    // Until the seal, the server queue still lists the message the first turn will take.
    const queue = createQueuedCommentQueue({
      queueId: "boot-wake", state: "deferred", targetRunId: "run-boot", steeringDisposition: "temporarily_unavailable",
      entries: [joining, withFileA, withFileB].map((comment, position) => ({ comment, position, canEdit: true, canDiscard: true })),
      firstTurnCommentIds: [joining.id],
    });
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockIssuesApi.reorderQueuedComments.mockResolvedValue(queue);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.queuedCommentQueue?.entries.map((entry: { comment: IssueComment }) => entry.comment.id))
        .toEqual([withFileA.id, withFileB.id]);
    });
    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
    await act(async () => props.onReorderQueuedComments([withFileB.id, withFileA.id], queue.revision));
    expect(mockIssuesApi.reorderQueuedComments).toHaveBeenCalledWith("issue-1", {
      orderedCommentIds: [joining.id, withFileB.id, withFileA.id], queueId: "boot-wake", revision: queue.revision,
    });
  });

  it("keeps queue controls for a new message after the run that took an earlier one hands off", async () => {
    const runnerRun = (id: string, startedAt: string) => ({
      id, status: "running" as const, invocationSource: "assignment" as const, triggerDetail: null,
      contextCommentId: null, contextWakeCommentId: null, startedAt, finishedAt: null, createdAt: startedAt,
      agentId: "agent-1", agentName: "Codie", adapterType: "paperclip_runner", issueId: "issue-1",
    });
    const bootRun = runnerRun("run-boot", "2026-04-21T00:00:00.000Z");
    const bootMessage = createIssueComment({ id: "boot-message", body: "Sent while the sandbox boots",
      createdAt: new Date("2026-04-21T00:00:05.000Z"), updatedAt: new Date("2026-04-21T00:00:05.000Z") });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1",
      executionRunId: "run-boot" }));
    mockIssuesApi.addComment.mockResolvedValue(bootMessage);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(bootRun);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([bootRun]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      queueId: null, state: null, targetRunId: null, steeringDisposition: "temporarily_unavailable", entries: [],
    }));
    await act(async () => renderIssueView());
    await flushReact();
    const bootProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as { onAdd: (body: string) => Promise<void> };
    await act(async () => { await bootProps.onAdd(bootMessage.body); });
    await flushReact();

    // The boot run's first turn took the message and finished; a successor runs.
    // The server queue never lists the boot message, only the new follow-up.
    const nextRun = runnerRun("run-next", "2026-04-21T00:10:00.000Z");
    const newMessage = createIssueComment({ id: "new-message", body: "Merge the PR when checks pass",
      createdAt: new Date("2026-04-21T00:11:00.000Z"), updatedAt: new Date("2026-04-21T00:11:00.000Z") });
    mockIssuesApi.listComments.mockResolvedValue([bootMessage, newMessage]);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [bootMessage, newMessage],
      latestCommentId: newMessage.id, hasMore: false });
    const nextQueue = createQueuedCommentQueue({ queueId: "next-wake", state: "deferred", targetRunId: "run-next",
      steeringDisposition: "available",
      entries: [{ comment: newMessage, position: 0, canEdit: true, canDiscard: true }] });
    mockIssuesApi.getQueuedComments.mockResolvedValue(nextQueue);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(nextRun);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([nextRun]);
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1",
      executionRunId: "run-next" }));
    await act(async () => {
      await queryClient.invalidateQueries();
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments("issue-1") });
    });
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      // A stale local entry must not withhold Steer and Discard from the real queue.
      expect(props?.queuedCommentQueue?.entries.map((entry: { comment: IssueComment }) => entry.comment.id))
        .toEqual([newMessage.id]);
      expect(props?.queuedCommentQueue?.queueId).toBe("next-wake");
    });
  });

  it("does not mark the wake comment for the current live run as queued when active-run cache is stale", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        executionRunId: "run-stale",
      }),
    );
    mockIssuesApi.listComments.mockResolvedValue([
      createIssueComment({
        id: "comment-fresh",
        createdAt: new Date("2026-04-21T00:00:05.000Z"),
        updatedAt: new Date("2026-04-21T00:00:05.000Z"),
      }),
    ]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-stale",
      status: "running",
      invocationSource: "issue",
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Coder",
      adapterType: "codex_local",
      issueId: "issue-1",
    });
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([
      {
        id: "run-current",
        status: "running",
        invocationSource: "issue",
        triggerDetail: null,
        contextCommentId: "comment-fresh",
        contextWakeCommentId: "comment-fresh",
        startedAt: "2026-04-21T00:00:01.000Z",
        finishedAt: null,
        createdAt: "2026-04-21T00:00:01.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      comments?: Array<{ id: string; queueState?: string }>;
    };
    const freshComment = props.comments?.find(
      (comment) => comment.id === "comment-fresh",
    );
    expect(freshComment?.queueState).toBeUndefined();
  });

  it.each(["missing_activity", "conflicting_activity"])(
    "keeps the persisted authoring run for private Board replies: %s",
    async (mode) => {
      mockIssuesApi.get.mockResolvedValue(
        createIssue({ status: "in_progress" }),
      );
      mockIssuesApi.listComments.mockResolvedValue([
        createIssueComment({
          id: "private-board-answer",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          createdByRunId: "run-private-board",
          body: "Object: lighthouse. Accent color: amber. Count: 63.",
        }),
        createIssueComment({
          id: "distinct-human-answer",
          body: "Object: lighthouse. Accent color: amber. Count: 63.",
        }),
      ]);
      mockActivityApi.runsForIssue.mockResolvedValue([
        {
          runId: "run-private-board",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          runtimeMode: "native",
          status: "succeeded",
          createdAt: "2026-04-21T00:00:00.000Z",
          startedAt: "2026-04-21T00:00:00.000Z",
          finishedAt: "2026-04-21T00:00:02.000Z",
          contextIssueId: "issue-1",
          resultJson: {
            presentationDecision: {
              schema: "paperclip.run_presentation_decision.v1",
              chosenSource: "existing_issue_comment",
              commentId: "private-board-answer",
            },
          },
          logBytes: 1,
        },
      ]);
      if (mode === "conflicting_activity") {
        mockActivityApi.forIssue.mockResolvedValue([
          {
            action: "issue.comment_added",
            runId: "run-other",
            agentId: "agent-other",
            details: {
              commentId: "private-board-answer",
              interruptedRunId: "run-unrelated-interruption",
            },
          },
        ]);
      }

      await act(async () => {
        renderIssueView();
      });
      await flushReact();
      await flushReact();

      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<Record<string, unknown>>;
      };
      expect(props.comments).toHaveLength(2);
      expect(
        props.comments?.find(
          (comment) => comment.id === "private-board-answer",
        ),
      ).toMatchObject({
        createdByRunId: "run-private-board",
        runId: "run-private-board",
        runAgentId: "agent-1",
        interruptedRunId: null,
      });
      expect(
        props.comments?.find(
          (comment) => comment.id === "distinct-human-answer",
        )?.runId,
      ).toBeUndefined();
    },
  );

  it("recovers historical follow-up provenance from overlapping run chronology", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "done" }));
    mockIssuesApi.listComments.mockResolvedValue([
      createIssueComment({
        id: "comment-follow-up",
        body: "Use three seconds instead.",
        createdAt: new Date("2026-04-21T00:00:30.000Z"),
        updatedAt: new Date("2026-04-21T00:00:30.000Z"),
      }),
    ]);
    mockActivityApi.runsForIssue.mockResolvedValue([
      {
        runId: "run-original",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        status: "succeeded",
        createdAt: "2026-04-21T00:00:00.000Z",
        startedAt: "2026-04-21T00:00:00.000Z",
        finishedAt: "2026-04-21T00:01:00.000Z",
        contextIssueId: "issue-1",
        logBytes: 1,
      },
      {
        runId: "run-successor",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        status: "succeeded",
        createdAt: "2026-04-21T00:01:01.000Z",
        startedAt: "2026-04-21T00:01:01.000Z",
        finishedAt: "2026-04-21T00:01:04.000Z",
        wakeCommentId: "comment-follow-up",
        wakeCommentIds: ["comment-follow-up"],
        contextCommentId: "comment-follow-up",
        contextIssueId: "issue-1",
        logBytes: 1,
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<Record<string, unknown>>;
      };
      expect(
        props.comments?.find((comment) => comment.id === "comment-follow-up"),
      ).toMatchObject({
        followUpRequested: true,
        consumedByRunId: "run-successor",
        conversationAnchorAt: "2026-04-21T00:01:01.000Z",
      });
    });
  });

  it("does not infer follow-up provenance from an unrelated overlapping linked run", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "done" }));
    mockIssuesApi.listComments.mockResolvedValue([
      createIssueComment({
        id: "comment-ordinary",
        body: "Start this ordinary run.",
        createdAt: new Date("2026-04-21T00:00:30.000Z"),
        updatedAt: new Date("2026-04-21T00:00:30.000Z"),
      }),
    ]);
    mockActivityApi.runsForIssue.mockResolvedValue([
      {
        runId: "run-unrelated",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        status: "succeeded",
        createdAt: "2026-04-21T00:00:00.000Z",
        startedAt: "2026-04-21T00:00:00.000Z",
        finishedAt: "2026-04-21T00:01:00.000Z",
        contextIssueId: "another-issue",
        logBytes: 1,
      },
      {
        runId: "run-ordinary",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        status: "succeeded",
        createdAt: "2026-04-21T00:01:01.000Z",
        startedAt: "2026-04-21T00:01:01.000Z",
        finishedAt: "2026-04-21T00:01:04.000Z",
        wakeCommentId: "comment-ordinary",
        wakeCommentIds: ["comment-ordinary"],
        contextCommentId: "comment-ordinary",
        contextIssueId: "issue-1",
        logBytes: 1,
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<Record<string, unknown>>;
      };
      expect(
        props.comments?.find((comment) => comment.id === "comment-ordinary"),
      ).toMatchObject({
        consumedByRunId: "run-ordinary",
        conversationAnchorAt: "2026-04-21T00:01:01.000Z",
      });
      expect(
        props.comments?.find((comment) => comment.id === "comment-ordinary")
          ?.followUpRequested,
      ).toBeUndefined();
    });
  });

  it("recovers follow-up provenance across an intervening activity-linked run", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "done" }));
    mockIssuesApi.listComments.mockResolvedValue([
      createIssueComment({
        id: "comment-follow-up",
        body: "Deliver this after the active run.",
        createdAt: new Date("2026-04-21T00:00:30.000Z"),
        updatedAt: new Date("2026-04-21T00:00:30.000Z"),
      }),
    ]);
    mockActivityApi.runsForIssue.mockResolvedValue([
      {
        runId: "run-source",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        status: "succeeded",
        createdAt: "2026-04-21T00:00:00.000Z",
        startedAt: "2026-04-21T00:00:00.000Z",
        finishedAt: "2026-04-21T00:01:00.000Z",
        contextIssueId: "issue-1",
        logBytes: 1,
      },
      {
        runId: "run-intervening",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        status: "succeeded",
        createdAt: "2026-04-21T00:00:40.000Z",
        startedAt: "2026-04-21T00:00:40.000Z",
        finishedAt: "2026-04-21T00:01:10.000Z",
        contextIssueId: "another-issue",
        logBytes: 1,
      },
      {
        runId: "run-successor",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        status: "succeeded",
        createdAt: "2026-04-21T00:01:11.000Z",
        startedAt: "2026-04-21T00:01:11.000Z",
        finishedAt: "2026-04-21T00:01:14.000Z",
        wakeCommentId: "comment-follow-up",
        wakeCommentIds: ["comment-follow-up"],
        contextCommentId: "comment-follow-up",
        contextIssueId: "issue-1",
        logBytes: 1,
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<Record<string, unknown>>;
      };
      expect(
        props.comments?.find((comment) => comment.id === "comment-follow-up"),
      ).toMatchObject({
        followUpRequested: true,
        consumedByRunId: "run-successor",
        conversationAnchorAt: "2026-04-21T00:01:11.000Z",
      });
    });
  });

  it("keeps acknowledged question answers at their submission time while recording successor delivery", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-successor",
      }),
    );
    mockIssuesApi.listInteractions.mockResolvedValue([
      {
        id: "interaction-answers",
        companyId: "company-1",
        issueId: "issue-1",
        kind: "ask_user_questions",
        status: "answered",
        continuationPolicy: "wake_assignee",
        resolverPolicy: "anyone",
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "anyone",
        resolverPolicyProvenance: "inherited",
        effectiveResolverPolicySource: "requested",
        legacyResolverPolicyAliases: { requested: null, effective: null },
        sourceRunId: "run-source",
        resolvedByUserId: "user-1",
        createdAt: "2026-04-21T00:00:01.000Z",
        updatedAt: "2026-04-21T00:00:04.000Z",
        resolvedAt: "2026-04-21T00:00:04.000Z",
        payload: {
          version: 1,
          questions: [
            {
              id: "runtime",
              prompt: "Which runtime?",
              selectionMode: "single",
              options: [{ id: "node", label: "Node.js" }],
            },
          ],
          questionSet: {
            schema: "paperclip.question_set.v1",
            questions: [
              {
                id: "runtime",
                header: "Runtime",
                prompt: "Which runtime?",
                required: true,
                answerMode: "single_select",
                options: [{ id: "node", label: "Node.js" }],
              },
            ],
          },
        },
        result: {
          version: 1,
          answers: [{ questionId: "runtime", optionIds: ["node"] }],
        },
      },
    ]);
    mockActivityApi.forIssue.mockResolvedValue([
      {
        id: "activity-answer-delivered",
        companyId: "company-1",
        actorType: "system",
        actorId: "question-response-delivery",
        agentId: null,
        runId: "run-successor",
        action: "issue.question_response_delivered",
        entityType: "issue",
        entityId: "issue-1",
        details: {
          interactionId: "interaction-answers",
          sourceRunId: "run-source",
          targetRunId: "run-successor",
          targetTurnId: "turn-successor",
          deliveryMode: "steered",
        },
        createdAt: "2026-04-21T00:00:04.000Z",
      },
    ]);
    mockActivityApi.runsForIssue.mockResolvedValue([
      {
        runId: "run-successor",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "codex_local",
        status: "running",
        createdAt: "2026-04-21T00:00:02.000Z",
        startedAt: "2026-04-21T00:00:02.000Z",
        finishedAt: null,
        wakeCommentId: "comment-queued",
        wakeCommentIds: ["comment-queued"],
        contextCommentId: "comment-queued",
        logBytes: 1,
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<Record<string, unknown>>;
        interactions?: Array<Record<string, unknown>>;
      };
      const delivered = props.comments?.find(
        (comment) => comment.id === "interaction-response:interaction-answers",
      );
      expect(delivered).toMatchObject({
        body: "Answered questions\n\n- Runtime — Which runtime?: Node.js",
        createdAt: new Date("2026-04-21T00:00:04.000Z"),
        updatedAt: new Date("2026-04-21T00:00:04.000Z"),
        consumedByRunId: "run-successor",
        steeredIntoRunId: "run-successor",
        conversationAnchorAt: new Date("2026-04-21T00:00:04.000Z"),
      });
      expect(
        props.comments?.filter((comment) =>
          String(comment.id).startsWith("interaction-response:"),
        ),
      ).toHaveLength(1);
      expect(
        props.interactions?.find(
          (interaction) => interaction.id === "interaction-answers",
        ),
      ).toMatchObject({
        status: "answered",
        sourceRunId: "run-source",
      });
    });
  });

  it.each(["acpx_local", "claude_local", "codex_local"])(
    "projects a resolved plan decision as queued for an active %s legacy run",
    async (adapterType) => {
      mockIssuesApi.get.mockResolvedValue(
        createIssue({
          status: "in_progress",
          assigneeAgentId: "agent-1",
          executionRunId: "run-source",
        }),
      );
      mockIssuesApi.listInteractions.mockResolvedValue([
        {
          id: "interaction-plan",
          companyId: "company-1",
          issueId: "issue-1",
          kind: "request_confirmation",
          status: "accepted",
          continuationPolicy: "wake_assignee",
          resolverPolicy: "anyone",
          requestedResolverPolicy: "anyone",
          effectiveResolverPolicy: "anyone",
          resolverPolicyProvenance: "inherited",
          effectiveResolverPolicySource: "requested",
          legacyResolverPolicyAliases: { requested: null, effective: null },
          sourceRunId: "run-source",
          resolvedByUserId: "user-1",
          createdAt: "2026-04-21T00:00:01.000Z",
          updatedAt: "2026-04-21T00:00:04.000Z",
          resolvedAt: "2026-04-21T00:00:04.000Z",
          payload: {
            version: 1,
            prompt: "Approve this plan?",
            target: {
              type: "issue_document",
              issueId: "issue-1",
              documentId: "document-plan",
              key: "plan",
              revisionId: "revision-1",
              revisionNumber: 1,
              label: "Plan revision 1",
            },
          },
          result: { outcome: "accepted" },
        },
      ]);
      const activeRun = {
        id: "run-source",
        status: "running",
        invocationSource: "issue",
        triggerDetail: null,
        contextCommentId: null,
        contextWakeCommentId: null,
        startedAt: "2026-04-21T00:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-21T00:00:00.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType,
        issueId: "issue-1",
      };
      mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(activeRun);
      mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([activeRun]);

      await act(async () => {
        renderIssueView();
      });
      await flushReact();
      await flushReact();

      await waitForAssertion(() => {
        const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
          comments?: Array<Record<string, unknown>>;
        };
        expect(
          props.comments?.find(
            (comment) => comment.id === "interaction-response:interaction-plan",
          ),
        ).toMatchObject({
          authorType: "user",
          authorUserId: "user-1",
          body: "Approved plan",
          createdAt: new Date("2026-04-21T00:00:04.000Z"),
          conversationAnchorAt: new Date("2026-04-21T00:00:04.000Z"),
          queueState: "queued",
          queueTargetRunId: "run-source",
          queueReason: "active_run",
        });
      });
    },
  );

  it("queues messages against a queued live run and interrupts that exact run", async () => {
    const postedComment = createDeferred<IssueComment>();
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        executionRunId: "run-queued",
      }),
    );
    mockIssuesApi.addComment.mockReturnValue(postedComment.promise);
    mockIssuesApi.getQueuedComments.mockResolvedValue(
      createQueuedCommentQueue({
        queueId: null,
        state: null,
        targetRunId: null,
        protocol: "legacy",
        steeringDisposition: "unsupported",
        entries: [],
      }),
    );
    mockHeartbeatsApi.cancel.mockResolvedValue({});
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([
      {
        id: "run-queued",
        status: "queued",
        invocationSource: "issue",
        triggerDetail: null,
        contextCommentId: null,
        contextWakeCommentId: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-04-21T00:00:01.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      onAdd: (body: string) => Promise<void>;
    };
    await act(async () => {
      void props.onAdd("Queued run message");
      await Promise.resolve();
    });
    await flushReact();

    const queuedProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      comments?: Array<{
        body: string;
        clientStatus?: string;
        queueState?: string;
        queueTargetRunId?: string | null;
      }>;
      queuedCommentQueue?: IssueQueuedCommentQueue | null;
      onInterruptQueued: (runId: string) => Promise<void>;
    };
    const optimisticComment = queuedProps.comments?.find(
      (comment) => comment.body === "Queued run message",
    );
    // supersedes(the optimistic queued projection before the POST answers; RFL CONDITION steer-ui 11-19: the client never decides steer vs queue)
    // supersedes(steer-ui3 11-19: between the click and the POST's answer the thread holds a NEUTRAL pending item, 'Sending…', neither queued nor sent)
    expect(optimisticComment).toMatchObject({ clientStatus: "pending", clientDelivery: "pending", queueTargetRunId: null });
    expect(optimisticComment?.queueState).toBeUndefined();
    expect(queuedProps.queuedCommentQueue?.entries ?? []).toHaveLength(0);

    // supersedes(steer-ui3 11-19: a BARE POST answer was placed in the waiting list by
    // IssueDetail's timestamp rule; SUPERSEDE-STEER-UI-NO-CLIENT-GUESS-1119: only an answer
    // that SAYS queued places it). The server answers queued (deliveryOutcome 'queued',
    // as QUEUE_SF_POST_RESPONSE_SAYS_QUEUED) and its queued-comments read lists it.
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      targetRunId: "run-queued", protocol: "legacy", steeringDisposition: "unsupported",
      entries: [{ comment: createIssueComment({ body: "Queued run message" }), position: 0, canEdit: true, canDiscard: true }],
    }));
    await act(async () => {
      postedComment.resolve({
        ...createIssueComment({ body: "Queued run message" }),
        deliveryOutcome: "queued",
        steeringUnavailableReason: null,
      } as IssueComment);
    });
    await flushReact();

    const persistedProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      comments?: Array<{
        body: string;
        clientStatus?: string;
        queueState?: string;
        queueTargetRunId?: string | null;
      }>;
      queuedCommentQueue?: IssueQueuedCommentQueue | null;
      onInterruptQueued: (runId: string) => Promise<void>;
    };
    const persistedComment = persistedProps.comments?.find(
      (comment) => comment.body === "Queued run message",
    );
    expect(persistedComment).toMatchObject({
      queueState: "queued",
      queueTargetRunId: "run-queued",
    });
    expect(
      persistedProps.queuedCommentQueue?.entries[0]?.comment,
    ).toMatchObject({
      id: "comment-1",
      body: "Queued run message",
    });

    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      targetRunId: "run-queued", protocol: "legacy", steeringDisposition: "unsupported",
    }));
    await act(async () => {
      await persistedProps.onInterruptQueued(
        persistedComment!.queueTargetRunId!,
      );
    });

    expect(mockIssuesApi.interruptQueuedComments).toHaveBeenCalledWith("PAP-1", {
      queueId: "wake-queue-1", revision: "queue-revision-1", targetRunId: "run-queued",
    });
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();
  });

  it.each(["native", "legacy"] as const)("projects a native follow-up into the steering well before the post resolves with %s persisted mode", async (runtimeMode) => {
    const postedComment = createDeferred<IssueComment>();
    const activeRun = {
      id: "run-native",
      runtimeMode,
      status: "running",
      invocationSource: "issue",
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:01.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:01.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
      issueId: "issue-1",
    };
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: activeRun.id,
      }),
    );
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ adapterType: "paperclip_runner" }),
    ]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(activeRun);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([activeRun]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(
      createQueuedCommentQueue({
        queueId: null,
        state: null,
        targetRunId: null,
        entries: [],
        protocol: "legacy",
        steeringDisposition: "temporarily_unavailable",
      }),
    );
    mockIssuesApi.addComment.mockReturnValue(postedComment.promise);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const initialProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      onAdd: (body: string) => Promise<void>;
    };
    await act(async () => {
      void initialProps.onAdd("Use the newer direction");
      await Promise.resolve();
    });
    await flushReact();

    const pendingProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      queuedCommentQueue?: IssueQueuedCommentQueue | null;
    };
    // supersedes(the optimistic queued projection before the POST answers; RFL CONDITION steer-ui 11-19: the client never decides steer vs queue, and between the click and the POST's answer only the composer's pending state shows)
    expect(pendingProps.queuedCommentQueue?.entries ?? []).toHaveLength(0);

    // supersedes(steer-ui3 11-19: a BARE POST answer was placed in the waiting list by
    // IssueDetail's timestamp rule; SUPERSEDE-STEER-UI-NO-CLIENT-GUESS-1119: only an answer
    // that SAYS queued places it). The server answers queued (deliveryOutcome 'queued',
    // as QUEUE_SF_POST_RESPONSE_SAYS_QUEUED) and its queued-comments read lists it.
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      targetRunId: "run-native",
      entries: [{
        comment: createIssueComment({ id: "native-follow-up", body: "Use the newer direction" }),
        position: 0, canEdit: true, canDiscard: true,
      }],
    }));
    await act(async () => {
      postedComment.resolve({
        ...createIssueComment({
          id: "native-follow-up",
          body: "Use the newer direction",
        }),
        deliveryOutcome: "queued",
        steeringUnavailableReason: null,
      } as IssueComment);
    });
    await flushReact();

    const acknowledgedProps = mockIssueChatThreadRender.mock.calls.at(
      -1,
    )?.[0] as {
      queuedCommentQueue?: IssueQueuedCommentQueue | null;
    };
    expect(
      acknowledgedProps.queuedCommentQueue?.entries[0]?.comment,
    ).toMatchObject({
      id: "native-follow-up",
      body: "Use the newer direction",
    });
  });

  it.each(([
    ["history", "before"],
    ["history", "after"],
    ["live", "before"],
    ["live", "after"],
  ] as const).flatMap(([source, order]) =>
    (["same-run", "previous-run", "queued", "adopted"] as const).map(queueTarget => [source, order, queueTarget] as const),
  ))("retires a consumed follow-up from %s when its post resolves %s delivery with a %s snapshot", async (receiptSource, postOrder, queueTarget) => {
    const postedComment = createDeferred<IssueComment>();
    const delivered = createIssueComment({ id: "delivered", body: "Use this direction" });
    const waiting = createIssueComment({ id: "still-waiting", body: "Keep this queued" });
    const run = {
      id: queueTarget === "same-run" ? "run-native" : "run-original", runtimeMode: "native" as const, status: "running",
      invocationSource: "issue", triggerDetail: null,
      contextCommentId: null, contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-21T00:00:01.000Z", agentId: "agent-1",
      agentName: "Runner", adapterType: "paperclip_runner", issueId: "issue-1",
    };
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", executionRunId: run.id }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(run);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([run]);
    mockIssuesApi.addComment.mockReturnValue(postedComment.promise);
    await act(async () => renderIssueView());
    await flushReact();

    type Props = {
      onAdd: (body: string) => Promise<void>;
      comments: Array<Record<string, unknown>>;
      queuedCommentQueue: IssueQueuedCommentQueue | null;
    };
    const props = () => mockIssueChatThreadRender.mock.calls.at(-1)![0] as Props;
    await act(async () => { void props().onAdd(delivered.body); });
    await flushReact();
    // supersedes(the optimistic queued projection before the POST answers; RFL CONDITION steer-ui 11-19: the client never decides steer vs queue, and between the click and the POST's answer only the composer's pending state shows)
    expect(props().queuedCommentQueue?.entries ?? []).toHaveLength(0);
    if (postOrder === "before") {
      await act(async () => postedComment.resolve(delivered));
      await flushReact();
    }

    const staleQueue = createQueuedCommentQueue({
      state: queueTarget === "queued" ? "queued" : "deferred",
      targetRunId: queueTarget === "queued" ? null : run.id,
      entries: [delivered, waiting].map((comment, position) => ({
        comment, position, canEdit: true, canDiscard: true,
      })),
    });
    mockIssuesApi.listComments.mockResolvedValue([delivered, waiting]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(staleQueue);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments("PAP-1") });
      queryClient.setQueryData(queryKeys.issues.queuedComments("issue-1"), staleQueue);
      if (receiptSource === "history") {
        queryClient.setQueryData(queryKeys.issues.runs("PAP-1"), [{
          ...run, runId: "run-native",
          wakeupRequestId: queueTarget === "adopted" ? "other-wake" : staleQueue.queueId,
          queuedCommentSourceWakeIds: queueTarget === "adopted" ? [staleQueue.queueId] : null,
          wakeCommentIds: [delivered.id],
          contextIssueId: "issue-1", logBytes: 1,
        }]);
      } else {
        const consumingRun = {
          ...run, id: "run-native",
          wakeupRequestId: queueTarget === "adopted" ? "other-wake" : staleQueue.queueId,
          queuedCommentSourceWakeIds: queueTarget === "adopted" ? [staleQueue.queueId] : null,
          contextCommentId: delivered.id, contextWakeCommentId: delivered.id,
        };
        mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([consumingRun]);
        mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(consumingRun);
        queryClient.setQueryData(queryKeys.issues.liveRuns("PAP-1"), [consumingRun]);
        queryClient.setQueryData(queryKeys.issues.activeRun("PAP-1"), consumingRun);
      }
    });
    if (postOrder === "after") {
      await act(async () => postedComment.resolve(delivered));
    }
    await waitForAssertion(() => {
      expect(props().queuedCommentQueue?.entries.map(entry => entry.comment.id)).toEqual([waiting.id]);
      const comment = props().comments.find(comment => comment.id === delivered.id);
      expect(comment).toMatchObject({ consumedByRunId: "run-native" });
      expect(comment?.queueState).toBeUndefined();
      expect(comment?.clientStatus).toBeUndefined();
      expect(props().comments.filter(comment => comment.body === delivered.body)).toHaveLength(1);
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.queuedComments("issue-1") });
    });
    expect(props().queuedCommentQueue?.entries.map(entry => entry.comment.id)).toEqual([waiting.id]);
  });

  it("keeps a message the running turn already took out of the queue after the live queue closes", async () => {
    // Posted while the run was still starting; its first turn took it.
    const taken = createIssueComment({ id: "first-turn-message", body: "Include the word PINEAPPLE" });
    const run = {
      id: "run-native", runtimeMode: "native" as const, status: "running",
      invocationSource: "issue", triggerDetail: null,
      contextCommentId: null, contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-21T00:00:01.000Z", agentId: "agent-1",
      agentName: "Runner", adapterType: "paperclip_runner", issueId: "issue-1",
    };
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: run.id }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(run);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([run]);
    mockIssuesApi.listComments.mockResolvedValue([taken]);
    // The deferred wake has retired, so the live queue no longer lists it.
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      queueId: null, state: null, targetRunId: null, entries: [],
    }));
    mockActivityApi.runsForIssue.mockResolvedValue([{
      runId: run.id, agentId: "agent-1", adapterType: "paperclip_runner",
      status: "running", startedAt: run.startedAt, finishedAt: null,
      createdAt: run.createdAt, wakeCommentIds: null, firstTurnCommentIds: [taken.id],
      wakeupRequestId: "wake-start", contextIssueId: "issue-1",
    }]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
      expect(props.queuedCommentQueue?.entries ?? []).toEqual([]);
      const comment = props.comments.find((comment: IssueComment) => comment.id === taken.id);
      expect(comment).toMatchObject({ consumedByRunId: run.id });
      expect(comment?.queueState).toBeUndefined();
    });
  });

  it("keeps an admitted message pending until its queued run starts", async () => {
    const queued = createIssueComment({ id: "not-started" });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-queued" }));
    mockIssuesApi.listComments.mockResolvedValue([queued]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      state: "queued", targetRunId: null,
      entries: [{ comment: queued, position: 0, canEdit: true, canDiscard: true }],
    }));
    mockActivityApi.runsForIssue.mockResolvedValue([{
      runId: "run-queued", agentId: "agent-1", adapterType: "paperclip_runner",
      status: "queued", startedAt: null, finishedAt: null,
      createdAt: "2026-04-21T00:00:01.000Z", wakeCommentIds: [queued.id],
      wakeupRequestId: "wake-queue-1",
      contextIssueId: "issue-1",
    }]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
      expect(props.queuedCommentQueue?.entries.map((entry: { comment: IssueComment }) => entry.comment.id)).toEqual([queued.id]);
      expect(props.comments.find((comment: IssueComment) => comment.id === queued.id)?.consumedByRunId).toBeUndefined();
    });
  });

  it.each(["queued", "deferred"] as const)("preserves an authoritative %s retry after an older run took the same input", async state => {
    const retry = createIssueComment({ id: "retry-message" });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1" }));
    mockIssuesApi.listComments.mockResolvedValue([retry]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      state, targetRunId: state === "deferred" ? "run-new" : null,
      entries: [{ comment: retry, position: 0, canEdit: true, canDiscard: true }],
    }));
    const originalRun = {
      runId: "run-old", agentId: "agent-1", adapterType: "paperclip_runner",
      status: "failed", startedAt: "2026-04-21T00:00:01.000Z",
      finishedAt: "2026-04-21T00:00:02.000Z",
      createdAt: "2026-04-21T00:00:01.000Z", wakeCommentIds: [retry.id],
      wakeupRequestId: "old-wake-queue",
      contextIssueId: "issue-1",
    };
    mockActivityApi.runsForIssue.mockResolvedValue([originalRun]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)![0];
      expect(props.queuedCommentQueue?.entries.map((entry: { comment: IssueComment }) => entry.comment.id)).toEqual([retry.id]);
    });
    await act(async () => {
      queryClient.setQueryData(queryKeys.issues.runs("PAP-1"), [originalRun, {
        ...originalRun, runId: "run-new", status: "running", finishedAt: null,
        startedAt: "2026-04-21T00:00:06.000Z", wakeupRequestId: "wake-queue-1",
      }]);
    });
    await waitForAssertion(() => {
      expect(mockIssueChatThreadRender.mock.calls.at(-1)![0].queuedCommentQueue).toBeNull();
    });
  });

  it("does not rebind a queued message when another run becomes live before its request settles", async () => {
    const postedComment = createDeferred<IssueComment>();
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        executionRunId: "run-original",
      }),
    );
    mockIssuesApi.addComment.mockReturnValue(postedComment.promise);
    mockHeartbeatsApi.cancel.mockResolvedValue({});
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([
      {
        id: "run-original",
        status: "running",
        invocationSource: "issue",
        triggerDetail: null,
        contextCommentId: null,
        contextWakeCommentId: null,
        startedAt: "2026-04-21T00:00:01.000Z",
        finishedAt: null,
        createdAt: "2026-04-21T00:00:01.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const initialProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      onAdd: (body: string) => Promise<void>;
    };
    await act(async () => {
      void initialProps.onAdd("Keep this bound to the original run");
      await Promise.resolve();
    });
    await flushReact();

    const replacementRun = {
      id: "run-replacement",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:02.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:02.000Z",
      agentId: "agent-1",
      agentName: "Coder",
      adapterType: "codex_local",
      issueId: "issue-1",
    };
    await act(async () => {
      queryClient.setQueryData(queryKeys.issues.liveRuns("issue-1"), [
        replacementRun,
      ]);
      queryClient.setQueryData(
        queryKeys.issues.activeRun("issue-1"),
        replacementRun,
      );
    });
    await flushReact();

    const replacementProps = mockIssueChatThreadRender.mock.calls.at(
      -1,
    )?.[0] as {
      comments?: Array<{
        body: string;
        clientStatus?: string;
        queueState?: string;
        queueTargetRunId?: string | null;
      }>;
      onInterruptQueued: (runId: string) => Promise<void>;
    };
    const optimisticComment = replacementProps.comments?.find(
      (comment) => comment.body === "Keep this bound to the original run",
    );
    // supersedes(the optimistic queued projection before the POST answers; RFL CONDITION steer-ui 11-19: the client never decides steer vs queue)
    // supersedes(steer-ui3 11-19: before the POST answers the thread holds only a NEUTRAL pending item, never queued)
    // That item is not queued, so there is no Interrupt binding to rebind to
    // the replacement run.
    expect(optimisticComment).toMatchObject({ clientStatus: "pending", clientDelivery: "pending", queueTargetRunId: null });
    expect(optimisticComment?.queueState).toBeUndefined();
    expect(mockIssuesApi.interruptQueuedComments).not.toHaveBeenCalled();
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();

    // supersedes(steer-ui3 11-19: this row resolved a BARE answer and no longer exercised
    // the Interrupt binding; SUPERSEDE-STEER-UI-NO-CLIENT-GUESS-1119: the binding comes
    // from the SERVER). The answer SAYS queued (deliveryOutcome 'queued', as
    // QUEUE_SF_POST_RESPONSE_SAYS_QUEUED) and the server's queued-comments read lists the
    // message against the run it was submitted to (run-original), while run-replacement
    // is live.
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      targetRunId: "run-original", protocol: "legacy", steeringDisposition: "unsupported",
      entries: [{
        comment: createIssueComment({ body: "Keep this bound to the original run" }),
        position: 0, canEdit: true, canDiscard: true,
      }],
    }));
    await act(async () => {
      postedComment.resolve({
        ...createIssueComment({ body: "Keep this bound to the original run" }),
        deliveryOutcome: "queued",
        steeringUnavailableReason: null,
      } as IssueComment);
    });
    await flushReact();
    await waitForAssertion(() => {
      const answered = (mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as typeof replacementProps)
        .comments?.find((comment) => comment.body === "Keep this bound to the original run");
      expect(answered).toMatchObject({ queueState: "queued", queueTargetRunId: "run-original" });
    });
    const answeredProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as typeof replacementProps;
    const answeredComment = answeredProps.comments?.find(
      (comment) => comment.body === "Keep this bound to the original run",
    );
    // Its Interrupt control stays bound to the server's run, never rebound to the
    // replacement: when the server's queue has moved on, the server refuses it.
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({
      targetRunId: "run-replacement", protocol: "legacy", steeringDisposition: "unsupported",
    }));
    await act(async () => {
      await expect(answeredProps.onInterruptQueued(
        answeredComment!.queueTargetRunId!,
      )).rejects.toThrow("The queued messages changed");
    });
    expect(mockIssuesApi.interruptQueuedComments).not.toHaveBeenCalled();
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();
    mockHeartbeatsApi.cancel.mockClear();
  });

  it("does not optimistically queue a fresh comment from an unlocked stale active-run cache", async () => {
    const postedComment = createDeferred<IssueComment>();
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "todo",
        executionRunId: null,
      }),
    );
    mockIssuesApi.addComment.mockReturnValue(postedComment.promise);
    queryClient.setQueryData(queryKeys.issues.activeRun("PAP-1"), {
      id: "run-stale",
      status: "running",
      invocationSource: "issue",
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Coder",
      adapterType: "codex_local",
      issueId: "issue-1",
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      onAdd: (body: string) => Promise<void>;
      comments?: Array<{
        body: string;
        clientStatus?: string;
        queueState?: string;
      }>;
    };
    await act(async () => {
      void props.onAdd("Fresh comment");
      await Promise.resolve();
    });
    await flushReact();

    const nextProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      comments?: Array<{
        body: string;
        clientStatus?: string;
        queueState?: string;
      }>;
    };
    const optimisticComment = nextProps.comments?.find(
      (comment) => comment.body === "Fresh comment",
    );
    expect(optimisticComment).toMatchObject({ clientStatus: "pending" });
    expect(optimisticComment?.queueState).toBeUndefined();

    const postedAt = new Date("2026-04-21T00:00:10.000Z");
    await act(async () => {
      postedComment.resolve(
        createIssueComment({
          body: "Fresh comment",
          createdAt: postedAt,
          updatedAt: postedAt,
        }),
      );
    });
    await flushReact();

    expect(
      readRecentTasks(
        getRecentTasksStorageKey("company-1", null),
        "company-1",
      )[0],
    ).toMatchObject({
      id: "issue-1",
      recordedAt: postedAt.getTime(),
    });
  });

  it("shows file viewer entry points when the experimental flag is enabled", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: true,
    });

    await act(async () => {
      renderIssueView();
    });

    await flushReact();
    await flushReact();

    expect(
      container.querySelector('[aria-label="Open file in this issue"]'),
    ).not.toBeNull();
  });

  it("starts a planning-mode task as chat-only until its plan document exists", async () => {
    mockSetBreadcrumbToolbar.mockClear();
    mockSetBreadcrumbPanelControl.mockClear();
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        originKind: "manual",
        workMode: "planning",
      }),
    );
    mockIssuesApi.getDocument.mockResolvedValue(null);

    await act(async () => {
      renderIssueView();
    });

    await flushReact();
    await flushReact();

    expect(mockOpenPanel).not.toHaveBeenCalled();
    expect(mockClosePanel).toHaveBeenCalled();
    expect(
      container.querySelector('button[aria-label="Toggle side panel"]'),
    ).toBeNull();
    const toolbar = [...mockSetBreadcrumbToolbar.mock.calls]
      .reverse()
      .map(([node]) => node)
      .find((node) => node !== null);
    expect(toolbar).toBeUndefined();
    const panelControl = [...mockSetBreadcrumbPanelControl.mock.calls]
      .reverse()
      .map(([control]) => control)
      .find((control) => control !== null);
    expect(panelControl).toMatchObject({ open: false });
  });

  it("reveals the planning-mode task sidebar when its plan document exists", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        originKind: "manual",
        workMode: "planning",
      }),
    );
    mockIssuesApi.getDocument.mockResolvedValue({ id: "doc-1", key: "plan" });

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockOpenPanel).toHaveBeenCalled();
    });
  });

  it("keeps the Show properties button clickable on the first task and reveals the sidebar on demand", async () => {
    mockSetBreadcrumbToolbar.mockClear();
    mockSetBreadcrumbPanelControl.mockClear();
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({ originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND }),
    );
    // No plan yet: the panel mount is suppressed by default.
    mockIssuesApi.getDocument.mockResolvedValue(null);

    await act(async () => {
      renderIssueView();
    });

    await flushReact();
    await flushReact();
    expect(mockOpenPanel).not.toHaveBeenCalled();
    expect(mockClosePanel).toHaveBeenCalled();

    // Even though panelVisible is true, the suppressed first task routes the
    // single breadcrumb panel control through its per-task opt-in behavior.
    const panelControl = [...mockSetBreadcrumbPanelControl.mock.calls]
      .reverse()
      .map(([control]) => control)
      .find((control) => control !== null) as {
      open: boolean;
      onToggle: () => void;
    };
    expect(panelControl).toMatchObject({ open: false });
    expect(
      mockSetBreadcrumbToolbar.mock.calls.every(([node]) => node === null),
    ).toBe(true);

    await act(async () => {
      panelControl.onToggle();
    });
    await flushReact();

    // The click overrides the first-task suppression and mounts the panel.
    await waitForAssertion(() => {
      expect(mockOpenPanel).toHaveBeenCalled();
    });
  });

  it("reveals the properties sidebar on the first onboarding task once a plan document exists", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({ originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND }),
    );
    mockIssuesApi.getDocument.mockResolvedValue({ id: "doc-1", key: "plan" });

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockOpenPanel).toHaveBeenCalled();
    });
  });

  it("shows the properties sidebar immediately on a non-first task", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
    });
    mockIssuesApi.get.mockResolvedValue(createIssue({ originKind: "manual" }));

    await act(async () => {
      renderIssueView();
    });

    await waitForAssertion(() => {
      expect(mockOpenPanel).toHaveBeenCalled();
    });
  });

  it("passes blocker attention to the issue detail header status icon", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "blocked",
        blockerAttention: {
          state: "covered",
          reason: "active_child",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-2",
          sampleStalledBlockerIdentifier: null,
        },
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    expect(
      container.querySelector('[data-status-icon-state="covered"]')
        ?.textContent,
    ).toBe("blocked");
  });

  it.each([false, true])(
    "refreshes a released pause and shows partial wake failure=%s inline",
    async (wakeFailed) => {
      const childIssue = createIssue({
        id: "child-1",
        parentId: "issue-1",
        identifier: "PAP-2",
        issueNumber: 2,
        title: "Held child",
      });
      const activeHold = createPauseHold();
      const releasedHold = createPauseHold({
        status: "released",
        releasedAt: new Date("2026-04-21T00:01:00.000Z"),
        releasedByActorType: "user",
        releasedByUserId: "user-1",
        releaseReason: "Ready to continue",
        updatedAt: new Date("2026-04-21T00:01:00.000Z"),
      });
      let activePauseHoldState: null | {
        holdId: string;
        rootIssueId: string;
        issueId: string;
        isRoot: boolean;
        mode: "pause";
        reason: string | null;
        releasePolicy: {
          strategy: "manual" | "after_active_runs_finish";
          note?: string | null;
        } | null;
      } = {
        holdId: "hold-1",
        rootIssueId: "issue-1",
        issueId: "issue-1",
        isRoot: true,
        mode: "pause",
        reason: null,
        releasePolicy: { strategy: "manual", note: "full_pause" },
      };

      mockIssuesApi.get.mockResolvedValue(createIssue());
      mockIssuesApi.list.mockImplementation(
        (_companyId, filters?: { descendantOf?: string }) =>
          Promise.resolve(
            filters?.descendantOf === "issue-1" ? [childIssue] : [],
          ),
      );
      mockIssuesApi.getTreeControlState.mockImplementation(() =>
        Promise.resolve({ activePauseHold: activePauseHoldState }),
      );
      mockIssuesApi.listTreeHolds.mockResolvedValue([activeHold]);
      mockIssuesApi.previewTreeControl.mockResolvedValue(createResumePreview());
      mockAgentsApi.list.mockResolvedValue([createAgent()]);
      mockIssuesApi.releaseTreeHold.mockImplementation(() => {
        activePauseHoldState = null;
        return Promise.resolve({
          ...releasedHold,
          ...(wakeFailed
            ? {
                wakeFailures: [
                  { issueId: "child-1", message: "Agent unavailable" },
                ],
              }
            : {}),
        });
      });
      mockAuthApi.getSession.mockResolvedValue({
        session: { userId: "user-1" },
        user: { id: "user-1" },
      });

      await act(async () => {
        renderIssueView();
      });
      await flushReact();
      await flushReact();

      await waitForAssertion(() => {
        expect(container.textContent).toContain("Subtree is paused.");
      });

      expect(container.querySelector('[data-testid="paused-composer-takeover"]')).toBeTruthy();
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].composerPause.scope).toBe("subtree");
      const taskChatShell = container.querySelector<HTMLElement>(
        "[data-task-chat-shell]",
      );
      expect(taskChatShell?.classList).toContain("gap-3");
      expect(taskChatShell?.classList).not.toContain("gap-6");

      const resumeButton = Array.from(
        container.querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "Resume subtree");
      expect(resumeButton).toBeTruthy();

      await act(async () => {
        resumeButton!.click();
      });
      await flushReact();

      const applyResumeButton = Array.from(container.querySelectorAll("button"))
        .filter((button) => button.textContent?.trim() === "Resume subtree")
        .at(-1);
      expect(applyResumeButton).toBeTruthy();
      expect(container.textContent).toContain("Wake affected agents (1)");

      await act(async () => {
        applyResumeButton!.click();
      });
      await flushReact();
      await flushReact();

      expect(mockIssuesApi.releaseTreeHold).toHaveBeenCalledWith(
        "PAP-1",
        "hold-1",
        {
          reason: null,
          metadata: { wakeAgents: true },
        },
      );
      expect(
        mockIssuesApi.getTreeControlState.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
      expect(mockPushToast).not.toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Subtree resumed",
        }),
      );
      await waitForAssertion(() => {
        expect(container.textContent).not.toContain("Subtree is paused.");
      });
      if (wakeFailed)
        expect(
          container.querySelector('[role="alert"]')?.textContent,
        ).toContain("Pause released");
      else expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("pauses the subtree immediately without preview or confirmation", async () => {
    mockIssuesApi.previewTreeControl.mockClear();
    const childIssue = createIssue({
      id: "child-1",
      parentId: "issue-1",
      identifier: "PAP-2",
      issueNumber: 2,
      title: "Paused child",
    });
    const pausePreview = createPausePreview();
    const pauseHold = createPauseHold({
      id: "pause-hold-1",
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
      members: [],
    });

    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockImplementation(
      (_companyId, filters?: { descendantOf?: string }) =>
        Promise.resolve(
          filters?.descendantOf === "issue-1" ? [childIssue] : [],
        ),
    );
    mockIssuesApi.previewTreeControl.mockResolvedValue(pausePreview);
    mockIssuesApi.createTreeHold.mockResolvedValue({
      hold: pauseHold,
      preview: pausePreview,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector(
      'button[aria-label="More task actions"]',
    ) as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();

    await act(async () => {
      moreButton!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flushReact();

    const pauseMenuButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Pause subtree");
    expect(pauseMenuButton).toBeTruthy();

    await act(async () => {
      pauseMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockIssuesApi.previewTreeControl).not.toHaveBeenCalled();
    expect(container.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });
  });

  it("stops the selected queued Grok run without cancelling a different running run", async () => {
    mockGrokBotApi.stop.mockClear();
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1" }));
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot" } }),
      createAgent({ id: "agent-2", adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot" } }),
    ]);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([
      { id: "run-active-1", agentId: "agent-1", status: "running", runtimeMode: "native", issueId: "issue-1", adapterType: "paperclip_runner" },
      { id: "run-queued-2", agentId: "agent-2", status: "queued", runtimeMode: "native", issueId: "issue-1", adapterType: "paperclip_runner" },
    ]);
    await act(async () => { renderIssueView(); });
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({ stopRunLabel: "Stop Paperclip work" }));
    await act(async () => { await mockIssueChatThreadRender.mock.calls.at(-1)![0].onStopRun("run-queued-2"); });
    expect(mockGrokBotApi.stop).toHaveBeenCalledExactlyOnceWith("company-1", "agent-2", "run-queued-2");
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();
  });

  it.each(["active-run", "composer"])(
    "keeps %s run controls distinct from pausing future work",
    async (control) => {
      mockIssuesApi.createTreeHold.mockClear();
      mockHeartbeatsApi.cancel.mockClear();
      mockHeartbeatsApi.get.mockReset();
      const pausePreview = createPausePreview();
      pausePreview.totals = {
        ...pausePreview.totals,
        totalIssues: 1,
        affectedIssues: 1,
        skippedIssues: 0,
        activeRuns: 1,
      };
      pausePreview.issues = [pausePreview.issues[0]!];
      pausePreview.skippedIssues = [];
      const pauseHold = createPauseHold({
        id: "leaf-pause-hold-1",
        mode: "pause",
        reason: null,
        releasePolicy: { strategy: "manual", note: "leaf_pause" },
        members: [],
      });

      mockIssuesApi.get.mockResolvedValue(
        createIssue({
          status: "in_progress",
          assigneeAgentId: "agent-1",
          executionRunId: "run-active-1",
        }),
      );
      mockIssuesApi.previewTreeControl.mockResolvedValue(pausePreview);
      mockIssuesApi.createTreeHold.mockResolvedValue({
        hold: pauseHold,
        preview: pausePreview,
      });
      mockAgentsApi.list.mockResolvedValue([createAgent()]);
      mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([
        {
          id: "run-active-1",
          agentId: "agent-1",
          status: "running",
          runtimeMode: "legacy",
          issueId: "issue-1",
          adapterType: "process",
        },
      ]);
      mockHeartbeatsApi.get.mockResolvedValue({ id: "run-active-1", status: "cancelled", runtimeMode: "legacy" });
      mockAuthApi.getSession.mockResolvedValue({
        session: { userId: "user-1" },
        user: { id: "user-1" },
      });

      await act(async () => {
        renderIssueView();
      });
      await flushReact();
      await flushReact();

      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
        stopRunLabel: "Pause work",
        stoppingRunLabel: "Pausing...",
        issueWorkMode: "standard",
      });

      const chatPauseButton = Array.from(container.querySelectorAll("button"))
        .filter((button) => button.textContent?.trim() === "Pause work")
        .at(-1);
      expect(chatPauseButton).toBeTruthy();

      await act(async () => {
        if (control === "composer") {
          const stop =
            mockIssueChatThreadRender.mock.calls.at(-1)?.[0].onCancelRun;
          expect(stop).toBeTypeOf("function");
          await stop();
        } else chatPauseButton!.click();
      });
      await flushReact();

      if (control === "composer") {
        expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-active-1");
        expect(mockHeartbeatsApi.get).toHaveBeenCalledWith("run-active-1");
        expect(mockIssuesApi.createTreeHold).not.toHaveBeenCalled();
      } else expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
        mode: "pause",
        reason: null,
        releasePolicy: { strategy: "manual", note: "leaf_pause" },
        metadata: { source: "issue_active_run_control", runId: "run-active-1" },
      });

      const moreButton = container.querySelector(
        'button[aria-label="More task actions"]',
      ) as HTMLButtonElement | null;
      expect(moreButton).toBeTruthy();
      await act(async () => {
        moreButton!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      await flushReact();

      const pauseMenuButton = Array.from(
        container.querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "Pause work");
      expect(pauseMenuButton).toBeTruthy();
      await act(async () => {
        pauseMenuButton!.click();
      });
      await flushReact();
      expect(mockIssuesApi.createTreeHold).toHaveBeenLastCalledWith("PAP-1", {
        mode: "pause",
        reason: null,
        releasePolicy: { strategy: "manual", note: "leaf_pause" },
      });
      expect(mockPushToast).not.toHaveBeenCalled();
      mockIssuesApi.createTreeHold.mockRejectedValueOnce(
        new Error("Unable to pause. Try again."),
      );
      await act(async () => {
        await mockIssueChatThreadRender.mock.calls
          .at(-1)?.[0]
          .onStopRun("run-active-1");
      });
      await flushReact();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Unable to pause. Try again.",
      );
      expect(mockPushToast).not.toHaveBeenCalled();
    },
  );

  // Planted: the run body below is reduced from what the REAL
  // POST /api/issues/:id/tree-holds (mode pause) then GET /api/heartbeat-runs/:id
  // returned on a warm keep_running native turn: executionCancellation requested,
  // nativeCancellation acknowledged, lease retained, no termination receipt.
  // fetch replays it through the real issues and heartbeats API clients.
  it.each([
    ["acknowledged", 1440], ["acknowledged", 390],
    ["unacknowledged", 1440], ["unacknowledged", 390],
    ["legacy", 1440], ["legacy", 390],
  ] as const)("the person's tree Pause on a warm native turn: %s cancellation at %i px", async (kind, width) => {
    // The file merges mockIssuesApi into the real issuesApi; createTreeHold's own body is api.post.
    const { api } = await vi.importActual<typeof import("../api/client")>("../api/client");
    const { heartbeatsApi: realHeartbeatsApi } =
      await vi.importActual<typeof import("../api/heartbeats")>("../api/heartbeats");
    mockSidebarState.isMobile = width < 768;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const runId = "efd1bbd0-971b-463c-b1d0-14cd9564a148";
    const pausePreview = createPausePreview();
    pausePreview.activeRuns = [{ id: runId, issueId: "issue-1", agentId: "agent-1", status: "running",
      startedAt: "2026-11-19T00:59:44.634Z", createdAt: "2026-11-19T00:59:44.491Z" }] as never;
    const pauseHold = createPauseHold({ id: "pause-hold-warm", mode: "pause", reason: null,
      releasePolicy: { strategy: "manual", note: "leaf_pause" }, members: [] });
    const run: Record<string, unknown> = {
      id: runId, companyId: "company-1", status: "cancelled", runtimeMode: "native",
      error: "Cancelled by a board operator's subtree pause",
      resultJson: {
        stopReason: "paused", cancelledByActorType: "user",
        executionCancellation: { state: "requested", requestedAt: "2026-11-19T00:59:45.156Z" },
        nativeCancellation: {
          schema: "paperclip.native-cancellation.v1", runId, companyId: "company-1", scope: "run",
          effects: ["release_run_resources"], dispatched: true, reasonCode: "cancellation_run_only",
          dispatchState: kind === "unacknowledged" ? "pending" : "acknowledged",
          ...(kind === "unacknowledged" ? {} : { acknowledgedAt: "2026-11-19T00:59:45.176Z" }),
        },
      },
    };
    if (kind === "legacy") {
      run.runtimeMode = "legacy";
      delete (run.resultJson as Record<string, unknown>).nativeCancellation;
    }
    const requests: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      const body = url.endsWith("/tree-holds") ? { hold: pauseHold, preview: pausePreview }
        : url.endsWith(`/heartbeat-runs/${runId}`) ? run : null;
      if (!body) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(body), { status: url.endsWith("/tree-holds") ? 201 : 200,
        headers: { "content-type": "application/json" } });
    });
    mockIssuesApi.createTreeHold.mockReset().mockImplementation((id: string, data: unknown) =>
      api.post(`/issues/${id}/tree-holds`, data));
    mockHeartbeatsApi.get.mockReset().mockImplementation((id: string) => realHeartbeatsApi.get(id));
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress", assigneeAgentId: "agent-1", executionRunId: runId,
    }));
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });

    await act(async () => { renderIssueView(); });
    await flushReact();
    await flushReact();
    const moreButton = container.querySelector('button[aria-label="More task actions"]') as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();
    await act(async () => {
      moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();
    const pauseMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause work");
    expect(pauseMenuButton).toBeTruthy();
    const line = "The stop was requested, but work is still stopping";
    const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map((node) => node.textContent ?? "");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => { pauseMenuButton!.click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_500); });
      const at30 = alerts();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      const at60 = alerts();
      expect(requests).toContain("POST /api/issues/PAP-1/tree-holds");
      expect(requests).toContain(`GET /api/heartbeat-runs/${runId}`);
      if (kind === "acknowledged") {
        expect(at30.some((text) => text.includes(line))).toBe(false);
        expect(at60.some((text) => text.includes(line))).toBe(false);
      } else {
        expect(at30.some((text) => text.includes(line))).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // C1 (rf-5). The person's tree Pause on the same warm native turn as the row
  // above (acknowledged cancellation; producer bodies), then the tree-control
  // state read through the real API client (getTreeControlState's own body) and the REAL TaskChatComposer
  // (vi.importActual, rendered by the TaskChatThread stub via
  // taskChatComposerFixture; the stub's own takeover is not rendered).
  // Planted: the GET /api/issues/:id/tree-control/state body below is the one the
  // REAL route returned after the REAL POST /api/issues/:id/tree-holds
  // {mode: pause} on a warm keep_running native turn (scratch harness
  // zz-stopline-c1-hold, producer-tree-pause-state.json):
  //   {"activePauseHold":{"holdId":<hold.id>,"rootIssueId":<issue.id>,"issueId":<issue.id>,
  //     "isRoot":true,"mode":"pause","reason":null,"releasePolicy":<the POST's releasePolicy>}}
  // with the ids mapped to this file's issue and hold, and releasePolicy echoed
  // from the POST this row sends (the route echoes the hold's own policy).
  // Before the POST the read returns {activePauseHold: null}.
  async function renderTreePauseWithStateRead(holdRead: "real" | "null", width: number) {
    const { api } = await vi.importActual<typeof import("../api/client")>("../api/client");
    const { heartbeatsApi: realHeartbeatsApi } =
      await vi.importActual<typeof import("../api/heartbeats")>("../api/heartbeats");
    const { TaskChatComposer } = await vi.importActual<
      typeof import("../components/task-chat/TaskChatComposer")
    >("../components/task-chat/TaskChatComposer");
    taskChatComposerFixture.Real = TaskChatComposer as never;
    mockSidebarState.isMobile = width < 768;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const runId = "efd1bbd0-971b-463c-b1d0-14cd9564a148";
    const pausePreview = createPausePreview();
    pausePreview.activeRuns = [{ id: runId, issueId: "issue-1", agentId: "agent-1", status: "running",
      startedAt: "2026-11-19T00:59:44.634Z", createdAt: "2026-11-19T00:59:44.491Z" }] as never;
    const pauseHold = createPauseHold({ id: "pause-hold-warm", mode: "pause", reason: null,
      releasePolicy: { strategy: "manual", note: "leaf_pause" }, members: [] });
    const run = {
      id: runId, companyId: "company-1", status: "cancelled", runtimeMode: "native",
      error: "Cancelled by a board operator's subtree pause",
      resultJson: {
        stopReason: "paused", cancelledByActorType: "user",
        executionCancellation: { state: "requested", requestedAt: "2026-11-19T00:59:45.156Z" },
        nativeCancellation: {
          schema: "paperclip.native-cancellation.v1", runId, companyId: "company-1", scope: "run",
          effects: ["release_run_resources"], dispatched: true, reasonCode: "cancellation_run_only",
          dispatchState: "acknowledged", acknowledgedAt: "2026-11-19T00:59:45.176Z",
        },
      },
    };
    let postedPolicy: unknown = null;
    const requests: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      let body: unknown = null;
      let status = 200;
      if (url.endsWith("/tree-holds") && method === "POST") {
        postedPolicy = (JSON.parse(String(init?.body)) as { releasePolicy: unknown }).releasePolicy;
        body = { hold: pauseHold, preview: pausePreview };
        status = 201;
      } else if (url.endsWith("/tree-control/state")) {
        body = {
          activePauseHold: postedPolicy !== null && holdRead === "real" ? {
            holdId: pauseHold.id, rootIssueId: "issue-1", issueId: "issue-1", isRoot: true,
            mode: "pause", reason: null, releasePolicy: postedPolicy,
          } : null,
        };
      } else if (url.endsWith(`/heartbeat-runs/${runId}`)) {
        body = run;
      }
      if (!body) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    });
    mockIssuesApi.createTreeHold.mockReset().mockImplementation((id: string, data: unknown) =>
      api.post(`/issues/${id}/tree-holds`, data));
    // The file merges mockIssuesApi into the real issuesApi object, so the real
    // getTreeControlState is replayed by its own body (api.get of the route).
    mockIssuesApi.getTreeControlState.mockReset().mockImplementation((id: string) =>
      api.get(`/issues/${id}/tree-control/state`));
    mockHeartbeatsApi.get.mockReset().mockImplementation((id: string) => realHeartbeatsApi.get(id));
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress", assigneeAgentId: "agent-1", executionRunId: runId,
    }));
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });

    await act(async () => { renderIssueView(); });
    await flushReact();
    await flushReact();
    const openMenu = async () => {
      const moreButton = container.querySelector('button[aria-label="More task actions"]') as HTMLButtonElement | null;
      expect(moreButton).toBeTruthy();
      await act(async () => {
        moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await flushReact();
      return Array.from(container.querySelectorAll("button")).map((button) => ({
        text: button.textContent?.trim() ?? "", disabled: button.disabled, button,
        where: button.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
      }));
    };
    const before = await openMenu();
    const pauseMenuButton = before
      .find((item) => item.where === "issue-detail-header" && item.text === "Pause work")?.button;
    expect(pauseMenuButton).toBeTruthy();
    expect(container.querySelector('[data-testid="paused-composer-takeover"]')).toBeNull();
    const line = "The stop was requested, but work is still stopping";
    const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map((node) => node.textContent ?? "");
    const pausedHeadings = () => Array.from(container.querySelectorAll("h2"))
      .filter((node) => node.textContent?.trim() === "Task is paused.").length;
    let at30 = { alerts: [] as string[], paused: -1 };
    let at60 = { alerts: [] as string[], paused: -1 };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => { pauseMenuButton!.click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_500); });
      at30 = { alerts: alerts(), paused: pausedHeadings() };
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      at60 = { alerts: alerts(), paused: pausedHeadings() };
    } finally {
      vi.useRealTimers();
    }
    return { requests, at30, at60, after: await openMenu() };
  }

  it.each([390, 1440])(
    "C1 (rf-5): after the person's tree Pause the task shows paused (real hold read, real composer) at %i",
    async (width) => {
      const { requests, at30, at60, after } = await renderTreePauseWithStateRead("real", width);
      expect(requests).toContain("POST /api/issues/PAP-1/tree-holds");
      expect(requests).toContain(`GET /api/heartbeat-runs/efd1bbd0-971b-463c-b1d0-14cd9564a148`);
      expect(requests).toContain("GET /api/issues/PAP-1/tree-control/state");
      // 'Task is paused.' is visible exactly once (the real composer's takeover).
      expect(at30.paused).toBe(1);
      expect(at60.paused).toBe(1);
      const takeover = container.querySelector('[data-testid="paused-composer-takeover"]');
      expect(takeover?.textContent).toContain("Resume this task to send a message.");
      // No 'still stopping' red line at +30 s and +60 s.
      expect(at30.alerts.some((text) => text.includes("still stopping"))).toBe(false);
      expect(at60.alerts.some((text) => text.includes("still stopping"))).toBe(false);
      // The real tree control (header 'More task actions' menu) does not offer
      // 'Pause work' again as if unpaused: it offers 'Resume work', and the real
      // composer's takeover offers 'Resume task'. (The TaskChatThread stub draws
      // its per-run stop button, labelled 'Pause work', whenever onStopRun is
      // passed; that is the stub, not the tree control, so it is not read here.)
      const header = after.filter((item) => item.where === "issue-detail-header");
      expect(header.find((item) => item.text === "Pause work")).toBeUndefined();
      expect(header.find((item) => item.text === "Resume work")).toMatchObject({ disabled: false });
      expect(after.find((item) => item.where === "paused-composer-takeover" && item.text === "Resume task"))
        .toMatchObject({ disabled: false });
    },
  );

  it.each([390, 1440])(
    "C1 (rf-5) control: the tree-control state read returns no hold, so no paused takeover at %i",
    async (width) => {
      const { requests, at30, at60, after } = await renderTreePauseWithStateRead("null", width);
      expect(requests).toContain("POST /api/issues/PAP-1/tree-holds");
      expect(requests).toContain("GET /api/issues/PAP-1/tree-control/state");
      expect(at30.paused).toBe(0);
      expect(at60.paused).toBe(0);
      expect(container.querySelector('[data-testid="paused-composer-takeover"]')).toBeNull();
      const header = after.filter((item) => item.where === "issue-detail-header");
      expect(header.find((item) => item.text === "Resume work")).toBeUndefined();
      expect(header.find((item) => item.text === "Pause work")).toMatchObject({ disabled: false });
    },
  );

  // Shape C: reconstructed HTTP candidates, NOT a captured interruption body.
  // ER4-DB-READ-RESULT.md supplies stopq/1440's full IDs/statuses/times and five1's
  // real automatic successor. ER4-RED.md supplies the separate stopq/390 observed
  // predecessor candidate. Historical browser interruption/local state was NOT
  // retained. Keep the cases named as candidates; do not call this a live replay.
  async function renderEmptyReplyCandidate(width: number, five1 = false) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(five1 ? "2026-11-20T07:47:35.600Z" : "2026-11-20T07:40:35.200Z"));
    const { TaskChatThread } = await vi.importActual<typeof import("../components/TaskChatThread")>("../components/TaskChatThread");
    const { heartbeatsApi: realHeartbeats } = await vi.importActual<typeof import("../api/heartbeats")>("../api/heartbeats");
    const { activityApi: realActivity } = await vi.importActual<typeof import("../api/activity")>("../api/activity");
    taskChatThreadFixture.Real = TaskChatThread as never;
    markdownEditorFixture.stub = true;
    mockSidebarState.isMobile = width === 390;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const issueId = five1 ? "76b52fd9-afd9-4c67-b2cf-c0f5c8320e29" : "441ec52c-08ad-4bc0-aed4-3891f8cf1a8d";
    const agentId = five1 ? "4f37be00-9a5c-4492-84c2-c6823f272a9e" : "4172d6e3-c283-4ab0-897a-ca15e5d9b45e";
    const runId = five1 ? "1579797d-5849-49fa-8ec4-3968ce679199" : "7377c533-fc42-435b-a164-1b6ed7ceae68";
    const replyId = five1 ? "b8ad0efd-819c-471f-b8ec-f2c7b947823d" : "47d68bc0-982a-4366-8cad-4f6509cf007f";
    const companyId = "0e778df7-19c4-4064-ae7c-42576082f096";
    const agent = createAgent({ id: agentId, companyId, name: "Runner", adapterType: "paperclip_runner" });
    const settled = { runId, agentId, agentName: agent.name, runtimeMode: "native" as const, adapterType: "paperclip_runner",
      status: "succeeded", createdAt: five1 ? "2026-11-20T07:44:48.873Z" : "2026-11-20T07:39:45.785Z",
      startedAt: five1 ? "2026-11-20T07:44:49.308Z" : "2026-11-20T07:39:45.899Z",
      finishedAt: five1 ? "2026-11-20T07:47:35.111Z" : "2026-11-20T07:40:34.941Z" };
    const reply = createIssueComment({ id: replyId, issueId, companyId, authorType: "agent", authorAgentId: agentId,
      authorUserId: null, createdByRunId: runId, body: five1 ? "DONE" : "19",
      createdAt: new Date(five1 ? "2026-11-20T07:47:35.228Z" : "2026-11-20T07:40:35.080Z") });
    const state = {
      issue: createIssue({ id: issueId, companyId, status: "in_progress", assigneeAgentId: agentId, identifier: null,
        interruption: { state: "working", intentId: null, responsibility: "system", nextRetryAt: null, canRetry: false,
          userAction: null, sourceRunIds: [runId], observedRunId: runId } }),
      comments: [reply], runs: [settled], live: [] as unknown[], active: null as unknown,
      events: {} as Record<string, unknown[]>,
    };
    const requests: string[] = [];
    const posts: Record<string, unknown>[] = [];
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
    const postResponse = createDeferred<Response>();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname;
      requests.push(`${init?.method ?? "GET"} ${path}${url.search}`);
      if (init?.method === "POST" && path.endsWith("/comments")) {
        posts.push(JSON.parse(String(init.body)));
        return postResponse.promise;
      }
      if (path === `/api/issues/${issueId}`) return response(state.issue);
      if (path.endsWith("/recent-comments")) return response({ comments: state.comments, latestCommentId: state.comments.at(-1)?.id, hasMore: false });
      if (path.endsWith("/comments")) return response(url.searchParams.get("order") === "desc" ? [...state.comments].reverse() : state.comments);
      if (path.endsWith("/live-runs")) return response(state.live);
      if (path.endsWith("/active-run")) return response(state.active);
      if (path.endsWith("/runs")) return response(state.runs);
      if (/\/events$/.test(path)) return response(state.events[path.split("/")[3]] ?? []);
      if (/\/log$/.test(path)) return response({ content: "", nextOffset: 0 });
      return response(/pending-questions|\/browsers$|\/mcp-app-views$/.test(path) ? [] : { items: [], nextCursor: null });
    });
    // Real API clients -> real IssueDetail queries/projection -> real TaskChatThread.
    // Only transport is replaced; the thread is never rerendered with planted props.
    for (const key of ["get", "getCore", "listComments", "recentComments"] as const) {
      mockIssuesApi[key].mockReset().mockImplementation(realIssuesApiFns.reads[key] as never);
    }
    mockIssuesApi.addComment.mockReset().mockImplementation((...args: unknown[]) => realIssuesApiFns.addComment!(...args));
    mockHeartbeatsApi.liveRunsForIssue.mockImplementation(realHeartbeats.liveRunsForIssue);
    mockHeartbeatsApi.activeRunForIssue.mockImplementation(realHeartbeats.activeRunForIssue);
    mockHeartbeatsApi.events.mockImplementation(realHeartbeats.events);
    mockHeartbeatsApi.conversationEvents.mockImplementation(realHeartbeats.conversationEvents);
    mockHeartbeatsApi.log.mockImplementation(realHeartbeats.log);
    mockActivityApi.runsForIssue.mockImplementation(realActivity.runsForIssue);
    mockActivityApi.recentRunsForIssue.mockImplementation(realActivity.recentRunsForIssue);
    mockActivityApi.runsByIdsForIssue.mockImplementation(realActivity.runsByIdsForIssue);
    mockAgentsApi.list.mockResolvedValue([agent]);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({ companyIds: [companyId], isInstanceAdmin: true, source: "session", userId: "user-1" });
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
    mockRouteParams.issueId = issueId;
    mockLocation.pathname = `/issues/${issueId}`;
    queryClient.setQueryData(["issues", "history-expanded", issueId], true);
    await act(async () => renderIssueView());
    try {
      await waitForAssertion(() => expect(container.querySelector(`[data-thread-anchor="${replyId}"]`)).not.toBeNull(), 100);
    } catch (error) {
      if (process.env.EMPTY_REPLY_EVIDENCE) writeFileSync(`${process.env.EMPTY_REPLY_EVIDENCE}/setup-${width}.json`, JSON.stringify({
        html: container.innerHTML, requests, errors: consoleErrorSpy.mock.calls.map((call: unknown[]) => call.map(String)),
      }, null, 2));
      throw error;
    }
    let refreshCount = 0;
    const refresh = async () => {
      await act(async () => { await queryClient.invalidateQueries(); });
      await flushReact();
      await flushReact();
      if (process.env.EMPTY_REPLY_EVIDENCE) writeFileSync(`${process.env.EMPTY_REPLY_EVIDENCE}/refresh-${width}-${++refreshCount}.json`, JSON.stringify({
        html: container.innerHTML, requests, props: Object.fromEntries(["comments", "activeRun", "liveRuns", "linkedRuns", "interruption", "composerPause", "composerDisabledReason"].map(key => [key, mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.[key]])), errors: consoleErrorSpy.mock.calls.map((call: unknown[]) => call.map(String)),
      }, null, 2));
    };
    const lane = () => container.querySelector('[data-testid="task-chat-live-transcript"]');
    return { state, settled, reply, runId, issueId, agentId, companyId, requests, posts, postResponse, response, refresh, lane };
  }

  describe.each([390, 1440])("shape C HTTP startup authority at %i", width => {
    afterEach(() => vi.useRealTimers());
    it.each([
      { name: "older stopped observed run (cross-case abbf candidate)", observedRunId: "abbf21f5-6bbd-4900-9d94-38be18f3c68c", joined: true },
      { name: "missing observed run candidate", observedRunId: null, joined: true },
      { name: "answered observed run without run/comment join candidate", observedRunId: "7377c533-fc42-435b-a164-1b6ed7ceae68", joined: false },
    ])("candidate: $name cannot add an identity/Working/Thinking after the reply", async candidate => {
      const view = await renderEmptyReplyCandidate(width);
      view.state.issue.interruption!.observedRunId = candidate.observedRunId;
      if (!candidate.joined) view.state.runs = [];
      const started = performance.now();
      await view.refresh();
      await waitForAssertion(() => expect(view.lane()).toBeNull());
      expect(performance.now() - started).toBeLessThan(1000);
      for (let frame = 0; frame < 5; frame++) {
        await flushReact();
        expect(view.lane()).toBeNull();
        expect(container.textContent).not.toMatch(/Working|Thinking/);
        expect(container.querySelectorAll(`[data-thread-anchor="${view.reply.id}"]`)).toHaveLength(1);
        expect(container.querySelector(`[data-thread-anchor="${view.reply.id}"]`)?.textContent).toContain("19");
      }
      expect(view.requests).toEqual(expect.arrayContaining([
        `GET /api/issues/${view.issueId}?view=core`, `GET /api/issues/${view.issueId}/comments?order=desc&limit=50`,
        `GET /api/issues/${view.issueId}/runs`, `GET /api/issues/${view.issueId}/live-runs`, `GET /api/issues/${view.issueId}/active-run`,
      ]));
    });

    it.each(["intent", "recovery"] as const)("preserves genuinely owed %s startup after the settled reply", async owed => {
      const view = await renderEmptyReplyCandidate(width);
      if (owed === "intent") view.state.issue.interruption!.intentId = "pending-intent-candidate";
      else view.state.issue.interruption!.recoveryStep = "finishing_recovery";
      await view.refresh();
      expect(view.lane()).not.toBeNull();
      expect(container.textContent).toContain("Working");
      expect(container.textContent).toContain("Thinking");
    });

    it("preserves immediate local send and acknowledged admission, then clears after its answer", async () => {
      const view = await renderEmptyReplyCandidate(width);
      await act(async () => markdownEditorFixture.change("Continue"));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')!.click());
      // POST is still pending, no run/intent: startup must already be visible.
      expect(view.lane(), container.textContent ?? "").not.toBeNull();
      expect(container.textContent).toContain("Thinking");
      await waitForAssertion(() => expect(view.posts, container.textContent ?? "").toHaveLength(1));
      const echo = createIssueComment({ issueId: view.issueId, companyId: view.companyId, id: "f8f37bf4-5c3e-4878-9949-12cafc90f5ba",
        clientRequestId: String(view.posts[0].clientRequestId), body: "Continue", createdAt: new Date("2026-11-20T07:41:00.945Z") });
      view.state.comments.push(echo);
      view.postResponse.resolve(view.response(echo, 201));
      await view.refresh();
      expect(view.lane()).not.toBeNull();
      expect(container.textContent).toContain("Thinking");
      const nextRunId = "fb96c417-81e4-49f1-a703-795f0361e53c";
      view.state.issue.interruption!.observedRunId = nextRunId;
      view.state.runs.push({ ...view.settled, runId: nextRunId, createdAt: "2026-11-20T07:41:01.492Z",
        startedAt: "2026-11-20T07:41:01.666Z", finishedAt: "2026-11-20T07:43:45.480Z" });
      view.state.comments.push(createIssueComment({ ...view.reply, id: "03c6c76a-4309-46d3-8da6-aeca1049e057",
        createdByRunId: nextRunId, body: "DONE", createdAt: new Date("2026-11-20T07:43:45.572Z") }));
      await view.refresh();
      expect(view.lane()).toBeNull();
      expect(container.textContent).not.toMatch(/Working|Thinking/);
    });

    it("keeps real five1 successor 5751bc11 queued/running until its report", async () => {
      const view = await renderEmptyReplyCandidate(width, true);
      const successor = { id: "5751bc11-c02a-4eda-babe-c6a31375e88a", runtimeMode: "native", adapterType: "paperclip_runner",
        status: "queued", invocationSource: "automation", triggerDetail: "chat_task_completed", agentId: view.agentId,
        agentName: "Runner", createdAt: "2026-11-20T07:47:35.264Z", startedAt: null as string | null, finishedAt: null as string | null };
      for (const status of ["queued", "running"]) {
        successor.status = status;
        successor.startedAt = status === "running" ? "2026-11-20T07:47:35.501Z" : null;
        view.state.live = [{ ...successor }];
        view.state.active = { ...successor };
        await view.refresh();
        expect(view.lane()).not.toBeNull();
        expect(container.textContent).toContain("Working");
        expect(container.textContent).toContain("Thinking");
        expect(container.querySelector(`[data-thread-anchor="${view.reply.id}"]`)?.textContent).toContain("DONE");
      }
      view.state.live = [];
      view.state.active = null;
      view.state.issue.interruption!.observedRunId = successor.id;
      view.state.runs.push({ ...view.settled, runId: successor.id, createdAt: successor.createdAt,
        startedAt: successor.startedAt!, finishedAt: "2026-11-20T07:47:58.827Z" });
      // Report body was not retained in ER4; marker text is reconstructed, not recorded.
      view.state.comments.push(createIssueComment({ ...view.reply, id: "02c7c94e-542e-4293-9596-c434356dbf27",
        createdByRunId: successor.id, body: "Five-task report (reconstructed content)", createdAt: new Date("2026-11-20T07:47:58.929Z") }));
      // Reconstructed native envelopes let the real transcript transport complete
      // its persistence handoff; these are not claimed as captured event bodies.
      view.state.events[successor.id] = [
        ["item.completed", { kind: "agentMessage", channel: "final", text: "Five-task report (reconstructed content)" }],
        ["run.terminal", { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }],
      ].map(([eventType, payload], index) => ({
        id: index + 1, companyId: view.companyId, runId: successor.id, agentId: view.agentId, seq: index + 1,
        eventType, stream: "system", level: "info", color: null, message: null, createdAt: "2026-11-20T07:47:58.827Z",
        payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceEventId: `candidate-${index + 1}`, sourceSeq: index + 1,
          sourceInstanceId: "candidate-runner", sourceKind: "runner", runId: successor.id, normalizedSessionId: "candidate-session",
          eventType, schemaVersion: 1, priority: 1, emittedAt: "2026-11-20T07:47:58.827Z", payload } },
      }));
      await view.refresh();
      expect(view.lane()).toBeNull();
      await waitForAssertion(() => expect(container.textContent).toContain("Five-task report (reconstructed content)"));
      expect(container.textContent).not.toMatch(/Working|Thinking/);
    });
  });

  // Independent judge-only reconstructed transport discriminators. Not a captured replay.
  describe.each([390, 1440])("independent authority at %i", width => {
    afterEach(() => vi.useRealTimers());
    const save = (name: string, view: Awaited<ReturnType<typeof renderEmptyReplyCandidate>>) => {
      if (process.env.EMPTY_REPLY_EVIDENCE) writeFileSync(`${process.env.EMPTY_REPLY_EVIDENCE}/${name}-${width}.json`, JSON.stringify({
        html: container.innerHTML, requests: view.requests, state: view.state,
        props: Object.fromEntries(["comments", "activeRun", "liveRuns", "linkedRuns", "interruption"].map(key => [key, mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.[key]])),
      }, null, 2));
    };
    it.each(["queued", "running", "scheduled_retry"])("preserves known %s successor when separate live endpoints have no tail", async status => {
      const view = await renderEmptyReplyCandidate(width);
      const successorId = "bdc97038-b764-4e56-9b51-00f149214a7a";
      view.state.issue.interruption!.observedRunId = successorId;
      view.state.issue.interruption!.sourceRunIds = [successorId];
      view.state.runs.push({ ...view.settled, runId: successorId, status,
        createdAt: "2026-11-20T07:40:35.150Z", startedAt: status === "running" ? "2026-11-20T07:40:35.170Z" : null,
        finishedAt: null, scheduledRetryReason: status === "scheduled_retry" ? "workspace_busy" : undefined } as never);
      // Independent GETs: core+run history know the new run. For queued/running,
      // live/active retain the preceding empty poll; a scheduled resource retry
      // legitimately has no live run yet. No local submission or intent exists.
      await view.refresh();
      save(`known-${status}-lag`, view);
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.linkedRuns).toEqual(expect.arrayContaining([expect.objectContaining({ runId: successorId, status })]));
      expect(props?.interruption).toMatchObject({ state: "working", intentId: null, observedRunId: successorId });
      expect(view.lane(), `new ${status} run is owed feedback despite the earlier reply`).not.toBeNull();
      expect(container.textContent).toContain("Working");
      expect(container.querySelector(`[data-thread-anchor="${view.reply.id}"]`)?.textContent).toContain("19");
    });
    it("keeps actual same-turn tool activity after an early saved answer", async () => {
      const view = await renderEmptyReplyCandidate(width);
      view.state.runs[0] = { ...view.settled, status: "running", finishedAt: null } as never;
      const live = { id: view.runId, agentId: view.agentId, agentName: "Runner", runtimeMode: "native", adapterType: "paperclip_runner",
        status: "running", createdAt: view.settled.createdAt, startedAt: view.settled.startedAt, finishedAt: null };
      view.state.live = [live]; view.state.active = live;
      view.state.events[view.runId] = [
        ["item.completed", { kind: "agentMessage", channel: "final", text: "19" }],
        ["tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "independent-tool", transport: "dynamic", operation: "update", name: "write_document", status: "running", input: { key: "plan" }, output: null }],
      ].map(([eventType, payload], index) => ({ id: index + 1, companyId: view.companyId, runId: view.runId, agentId: view.agentId,
        seq: index + 1, eventType, stream: "system", level: "info", message: null, color: null, createdAt: "2026-11-20T07:40:35.100Z",
        payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceEventId: `judge-${index + 1}`, sourceSeq: index + 1,
          sourceInstanceId: "judge-runner", sourceKind: "runner", runId: view.runId, normalizedSessionId: "judge-session", eventType,
          schemaVersion: 1, priority: 1, emittedAt: "2026-11-20T07:40:35.100Z", payload } } }));
      await view.refresh();
      await waitForAssertion(() => expect(container.textContent).toContain("Writing a document"));
      save("ongoing-tool", view);
      expect(view.lane()).not.toBeNull();
      expect(container.textContent).toContain("19");
    });
    it.each([true, false])("holds a streamed terminal answer through a missing late final-comment join (older saved answer=%s)", async olderAnswer => {
      const view = await renderEmptyReplyCandidate(width);
      if (!olderAnswer) view.state.comments = [];
      const successorId = "eb160bb6-ce12-498e-a278-d447862f89b9";
      const body = "Independent final awaiting durable comment";
      const live = { id: successorId, agentId: view.agentId, agentName: "Runner", runtimeMode: "native", adapterType: "paperclip_runner",
        status: "running", createdAt: "2026-11-20T07:40:35.150Z", startedAt: "2026-11-20T07:40:35.170Z", finishedAt: null };
      view.state.live = [live]; view.state.active = live;
      view.state.issue.interruption!.observedRunId = successorId;
      const events = [
        ["item.completed", { kind: "agentMessage", channel: "final", text: body }],
        ["run.terminal", { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }],
      ].map(([eventType, payload], index) => ({ id: index + 1, companyId: view.companyId, runId: successorId, agentId: view.agentId,
        seq: index + 1, eventType, stream: "system", level: "info", message: null, color: null, createdAt: "2026-11-20T07:40:35.180Z",
        payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceEventId: `late-${index + 1}`, sourceSeq: index + 1,
          sourceInstanceId: "judge-runner", sourceKind: "runner", runId: successorId, normalizedSessionId: "judge-session", eventType,
          schemaVersion: 1, priority: 1, emittedAt: "2026-11-20T07:40:35.180Z", payload } } }));
      view.state.events[successorId] = events;
      await view.refresh();
      await waitForAssertion(() => expect(container.textContent).toContain(body));
      view.state.live = []; view.state.active = null;
      view.state.runs.push({ ...view.settled, runId: successorId, createdAt: live.createdAt, startedAt: live.startedAt, finishedAt: "2026-11-20T07:40:35.185Z" });
      await view.refresh();
      save(`terminal-before-comment-older-${olderAnswer}`, view);
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.comments).toHaveLength(olderAnswer ? 1 : 0);
      expect(container.textContent).toContain(body);
      expect(container.textContent).not.toContain("Thinking");
      view.state.comments.push(createIssueComment({ ...view.reply, id: "120ad480-c6ea-4825-8762-b2d9b643ff73", createdByRunId: successorId, body,
        createdAt: new Date("2026-11-20T07:40:35.190Z") }));
      await view.refresh();
      save(`terminal-after-comment-older-${olderAnswer}`, view);
      expect(view.lane()).toBeNull();
      expect(container.textContent?.split(body)).toHaveLength(2);
    });
    it("retains Retry preparation feedback before any new intent or run echo", async () => {
      const view = await renderEmptyReplyCandidate(width);
      const failedId = "aa4ceae4-d372-4d87-8b99-e26a36bdbcf9";
      view.state.runs.push({ ...view.settled, runId: failedId, status: "failed" } as never);
      Object.assign(view.state.issue.interruption!, { state: "failed", canRetry: true, observedRunId: failedId, sourceRunIds: [failedId] });
      const retry = createDeferred<unknown>();
      mockIssuesApi.retryTask.mockReturnValue(retry.promise);
      await view.refresh();
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry" && !button.disabled);
      expect(button).toBeDefined();
      await act(async () => button!.click());
      await waitForAssertion(() => expect(mockIssuesApi.retryTask).toHaveBeenCalled());
      save("retry-preparing", view);
      expect(view.lane()).not.toBeNull();
      expect(container.textContent).toContain("Thinking");
      Object.assign(view.state.issue.interruption!, { state: "working", intentId: "judge-retry", canRetry: false });
      await act(async () => retry.resolve({ requestId: "judge-retry", accepted: true, stale: false, presentation: view.state.issue.interruption }));
      await view.refresh();
      expect(view.lane()).not.toBeNull();
    });
    it("keeps genuine pending confirmation usable after the saved answer", async () => {
      const view = await renderEmptyReplyCandidate(width);
      const { genericPendingRequestConfirmationInteraction } = await import("@/fixtures/issueThreadInteractionFixtures");
      mockIssuesApi.listInteractions.mockResolvedValue([{ ...genericPendingRequestConfirmationInteraction,
        issueId: view.issueId, companyId: view.companyId, sourceRunId: view.runId,
        payload: { version: 1, prompt: "Approve independent follow-up?" },
      }]);
      await view.refresh();
      save("pending-confirmation", view);
      expect(container.textContent).toContain("Approve independent follow-up?");
      expect(container.querySelector('[data-testid="task-chat-composer-send"]')).not.toBeNull();
    });
    it("does not mistake a saved report_progress receipt for an answered turn", async () => {
      const view = await renderEmptyReplyCandidate(width);
      view.state.runs[0] = { ...view.settled, resultJson: { semanticToolReceipts: { progress: {
        operationId: "report_progress", result: { commentId: view.reply.id },
      } } } } as never;
      await view.refresh();
      save("progress-only", view);
      expect(view.lane()).not.toBeNull();
      expect(container.textContent).toContain("Thinking");
    });
  });

  describe.each([390, 1440])("startup observed-run scope at %i", width => {
    afterEach(() => vi.useRealTimers());

    it("keeps feedback for a known running observed run after its early saved answer", async () => {
      const view = await renderEmptyReplyCandidate(width);
      view.state.runs[0] = { ...view.settled, status: "running", finishedAt: null } as never;
      await view.refresh();
      await waitForAssertion(() => {
        expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.linkedRuns).toEqual(expect.arrayContaining([
          expect.objectContaining({ runId: view.runId, status: "running" }),
        ]));
        expect(view.lane()).not.toBeNull();
        expect(container.textContent).toContain("Working");
      });
      expect(container.querySelector(`[data-thread-anchor="${view.reply.id}"]`)?.textContent).toContain("19");
    });

    it("does not let a different historical answer settle a known terminal observed run", async () => {
      const view = await renderEmptyReplyCandidate(width);
      const observedRunId = "de99de12-3d27-4f17-a847-24723bff8f26";
      view.state.issue.interruption!.observedRunId = observedRunId;
      view.state.issue.interruption!.sourceRunIds = [observedRunId];
      view.state.runs.push({ ...view.settled, runId: observedRunId,
        createdAt: "2026-11-20T07:40:35.100Z", startedAt: "2026-11-20T07:40:35.110Z",
        finishedAt: "2026-11-20T07:40:35.190Z" });
      await view.refresh();
      await waitForAssertion(() => {
        const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
        expect(props?.linkedRuns).toEqual(expect.arrayContaining([
          expect.objectContaining({ runId: observedRunId, status: "succeeded" }),
        ]));
        expect(props?.interruption).toMatchObject({ observedRunId, state: "working" });
        expect(view.lane()).not.toBeNull();
        expect(container.textContent).toContain("Working");
      });
      expect(container.querySelector(`[data-thread-anchor="${view.reply.id}"]`)?.textContent).toContain("19");
      view.state.comments.push(createIssueComment({ ...view.reply, id: "bcefc06b-3b63-4f55-ae77-5f43009d271e",
        createdByRunId: observedRunId, body: "Observed run answer", createdAt: new Date("2026-11-20T07:40:35.195Z") }));
      await view.refresh();
      await waitForAssertion(() => expect(view.lane()).toBeNull());
      expect(container.textContent).not.toMatch(/Working|Thinking/);
      expect(container.textContent?.split("Observed run answer")).toHaveLength(2);
    });
  });

  // Steering placement end to end (steer-ui2, Paul 11-19). The REAL TaskChatThread
  // (vi.importActual; the TaskChatThread stub renders it via taskChatThreadFixture
  // with IssueDetail's own props), the REAL TaskChatComposer inside it (Enter / Send ▾),
  // IssueDetail's real addComment mutation and the real issuesApi.addComment request
  // body, replayed through fetch. Every server answer is a PLANTED body above.
  // Derived (named here, nothing invented): before Enter the thread is the planted
  // GET without the new message; between the POST and Pi's read it holds the POST's
  // own body (steeringStatus 'accepted'), as neworg-lead's S-a row reads it.
  async function renderSteeringPlacement(
    width: number,
    flow: "steer" | "queue",
    // steer-ui3: the POST answer DELAYED (gate 4's hand take: POST 2.67 s), or refused.
    answer: { delayMs?: number; failStatus?: 500 | 409; says?: "bare" | "queued" } = {},
  ) {
    const { TaskChatThread } = await vi.importActual<
      typeof import("../components/TaskChatThread")
    >("../components/TaskChatThread");
    taskChatThreadFixture.Real = TaskChatThread as never;
    markdownEditorFixture.stub = true;
    mockSidebarState.isMobile = width < 768;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    // steer-ui4: says 'queued' = the S-f body with the server's deliveryOutcome 'queued';
    // says 'bare' = the S-f body as captured (no steer, no queued marker) and the server's
    // queued-comments read stays empty.
    const post = flow === "steer" ? STEER_A2_POST_RESPONSE
      : answer.says === "queued" ? QUEUE_SF_POST_RESPONSE_SAYS_QUEUED : QUEUE_SF_POST_RESPONSE;
    const finalThread: readonly { id: string }[] = flow === "steer" ? STEER_A2_THREAD_GET_DELIVERED : QUEUE_SF_THREAD_GET;
    const runId = flow === "steer" ? STEER_A2_POST_RESPONSE.steeredIntoRunId : QUEUE_SF_QUEUED_COMMENTS_GET.targetRunId;
    const emptyQueue = createQueuedCommentQueue({ queueId: null, state: null, targetRunId: null, entries: [] });
    const state = {
      thread: finalThread.filter((comment) => comment.id !== post.id) as unknown[],
      queue: emptyQueue as unknown,
    };
    const posts: Array<Record<string, unknown>> = [];
    const fetched: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && /\/api\/issues\/[^/]+\/comments$/.test(url)) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
        if (answer.failStatus) {
          return new Response(JSON.stringify({ error: answer.failStatus === 409 ? "Conflict: the task changed" : "Internal server error" }), {
            status: answer.failStatus, headers: { "content-type": "application/json" },
          });
        }
        state.thread = flow === "steer"
          ? finalThread.map((comment) => comment.id === post.id ? post : comment)
          : [...QUEUE_SF_THREAD_GET];
        state.queue = flow === "steer" || answer.says === "bare" ? emptyQueue : QUEUE_SF_QUEUED_COMMENTS_GET;
        return new Response(JSON.stringify(post), { status: 201, headers: { "content-type": "application/json" } });
      }
      fetched.push(`${method} ${url}`);
      const body = /pending-questions|\/browsers(\?|$)|\/mcp-app-views/.test(url) ? [] : { items: [], nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    mockIssuesApi.addComment.mockReset().mockImplementation((...args: unknown[]) => realIssuesApiFns.addComment!(...args));
    mockIssuesApi.listComments.mockImplementation(async () => state.thread);
    mockIssuesApi.getQueuedComments.mockImplementation(async () => state.queue);
    const activeRun = {
      id: runId, runtimeMode: "native", status: "running", invocationSource: "issue", triggerDetail: null,
      contextCommentId: null, contextWakeCommentId: null, startedAt: "2026-11-19T07:43:59.400Z", finishedAt: null,
      createdAt: "2026-11-19T07:43:59.400Z", agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner",
      issueId: "issue-1",
    };
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress", assigneeAgentId: "agent-1", executionRunId: runId,
    }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(activeRun);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([activeRun]);
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "chat-owner" }, user: { id: "chat-owner" } });

    await act(async () => { renderIssueView(); });
    await flushReact();
    await flushReact();
    await waitForAssertion(() => expect(container.querySelector('[data-testid="stand-in-editor"]')).not.toBeNull());
    await act(async () => { markdownEditorFixture.change(post.body); });
    await flushReact();
    const bubbles = () => Array.from(container.querySelectorAll<HTMLElement>('[data-conversation-message="human"]'))
      .filter((node) => node.textContent?.includes(post.body));
    const waitingText = () => container.querySelector('[data-testid="task-chat-queued-messages"]')?.textContent ?? "";
    return { post, runId, posts, state, bubbles, waitingText, finalThread };
  }

  async function waitUntil(check: () => boolean, timeoutMs = 3000) {
    const started = performance.now();
    while (!check()) {
      if (performance.now() - started > timeoutMs) return false;
      await flushReact();
    }
    return true;
  }

  it.each([390, 1440])(
    "steering placement: Enter while the agent works puts the message in the thread as sent within 1 s (real server bodies), then the same bubble shows delivered at %i",
    async (width) => {
      const { post, runId, posts, state, bubbles, waitingText, finalThread } = await renderSteeringPlacement(width, "steer");
      const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="stand-in-editor"]')!;
      const started = performance.now();
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      // supersedes(steer-ui3): a neutral pending bubble shows first; wait for the server's 'sent'.
      expect(await waitUntil(() => bubbles().some((node) => node.dataset.testid === "task-chat-steered-message" && node.dataset.delivery === "sent"))).toBe(true);
      const elapsed = performance.now() - started;
      expect(elapsed, `Enter to thread: ${elapsed} ms`).toBeLessThan(1000);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/enter-to-thread-${width}.txt`, `${elapsed.toFixed(1)} ms\n${bubbles()[0]!.outerHTML}\n`);
      }
      // The default Send names no intent: the server decides.
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ body: post.body });
      expect(posts[0]).not.toHaveProperty("deliveryIntent");
      const sent = bubbles();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.dataset.steeredIntoRunId).toBe(runId);
      expect(sent[0]!.dataset.delivery).toBe("sent");
      // Steered is sent, never 'Queued' or 'Sending…' (the old client rule called it queued).
      expect(sent[0]!.textContent).not.toMatch(/Queued|Sending…|Interrupt/);
      expect(sent[0]!.querySelector('[data-testid="task-chat-steered-delivery"]')?.textContent).toContain("Sent");
      // No waiting row for a steered message.
      expect(waitingText()).not.toContain(post.body);
      // Pi reads it: the next thread GET (planted) says delivered.
      state.thread = [...finalThread];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments("PAP-1") });
      });
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "delivered")).toBe(true);
      const delivered = bubbles();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.dataset.steeredIntoRunId).toBe(runId);
      expect(delivered[0]!.querySelector('[data-testid="task-chat-steered-delivery"]')?.textContent).toContain("Delivered");
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/delivered-bubble-${width}.txt`, `${delivered[0]!.outerHTML}\n`);
      }
      expect(waitingText()).not.toContain(post.body);
      expect(container.querySelectorAll('[data-testid="task-chat-steered-message"]')).toHaveLength(1);
    },
    15_000,
  );

  // A2r3 projection (neworg/steer-A2r3-c3 8fc517e2, server/src/services/carried-steer.ts:38-94):
  // the thread GET body of the captured A2 steer once its turn ended unread. DERIVED, not
  // re-captured: the captured A2 body plus exactly the fields withCarriedSteerDisplay sets.
  const a2r3 = (fields: Record<string, unknown>) => [
    { ...STEER_A2_THREAD_GET_DELIVERED[0], ...fields },
    STEER_A2_THREAD_GET_DELIVERED[1],
  ];
  const A2R3_CARRIER_RUN_ID = "c4a7e2d1-5b3f-4e8a-9c6d-2f1e0b9a8d7c";
  const A2R3_NOT_DELIVERED = { steeringStatus: null, carriedIntoRunId: null, steeringDeliveryEventSeq: null,
    deliveryOutcome: "ordinary", steeringUnavailableReason: "run_ended_before_read" };
  const A2R3_CARRIED = { steeringStatus: "carried", carriedIntoRunId: A2R3_CARRIER_RUN_ID, steeringDeliveryEventSeq: null,
    deliveryOutcome: "ordinary", steeringUnavailableReason: null };
  const A2R3_CARRIED_DELIVERED = { ...A2R3_CARRIED, steeringStatus: "delivered", steeringDeliveryEventSeq: 7 };

  async function endTheSteeredRun(runId: string, status = "failed") {
    const endedRun = {
      runId, runtimeMode: "native", status, agentId: "agent-1", adapterType: "paperclip_runner",
      createdAt: "2026-11-19T07:43:59.400Z", startedAt: "2026-11-19T07:43:59.400Z", finishedAt: "2026-11-19T07:44:30.000Z",
    };
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([]);
    mockActivityApi.recentRunsForIssue.mockResolvedValue([endedRun]);
    mockActivityApi.runsForIssue.mockResolvedValue([endedRun]);
  }

  // cluster-lead 09:37Z (frame steerkill-g4b-092242/screen-1440/0046-after-reload.jpg):
  // the bubble read '5m ago · Sent' after its run FAILED.
  // supersedes(fe40f9d2 "a steered message whose turn ended unread says 'Not delivered', not 'Sent'; a later
  // server 'delivered' wins") under SUPERSEDE-STEER-NOTDELIVERED-SERVER-FIELD-1119 (RFL: read the server's
  // run_ended_before_read, do not infer). Name unchanged. Re-pinned: 'Not delivered' now comes from the
  // server's steeringUnavailableReason 'run_ended_before_read' (A2r3 projection, steeringStatus null),
  // not from 'accepted' + a terminal run in the client's run lists.
  it.each([390, 1440])(
    "a steered message whose turn ended unread says 'Not delivered', not 'Sent'; a later server 'delivered' wins at %i",
    async (width) => {
      const { post, runId, state, bubbles, finalThread } = await renderSteeringPlacement(width, "steer");
      const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="stand-in-editor"]')!;
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      const delivery = () => bubbles()[0]?.querySelector('[data-testid="task-chat-steered-delivery"]')?.textContent ?? "";
      // accepted + R running: Sent.
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "sent")).toBe(true);
      expect(state.thread).toContainEqual(expect.objectContaining({ id: post.id, steeringStatus: "accepted", steeredIntoRunId: runId }));
      expect(delivery()).toContain("Sent");
      expect(delivery()).not.toContain("Not delivered");
      // R FAILED before Pi read it and no carrier took it: the server says run_ended_before_read.
      await endTheSteeredRun(runId);
      state.thread = a2r3(A2R3_NOT_DELIVERED);
      await act(async () => { await queryClient.invalidateQueries(); });
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "not_delivered")).toBe(true);
      expect(bubbles()).toHaveLength(1);
      expect(bubbles()[0]!.dataset.steeredIntoRunId).toBe(runId);
      expect(delivery()).toContain("Not delivered: the turn ended before the agent read it.");
      expect(delivery()).not.toMatch(/\bSent\b/);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/not-delivered-${width}.txt`, `${bubbles()[0]!.outerHTML}\n`);
      }
      // The server later says 'delivered' (R still ended): the bubble follows the server.
      state.thread = [...finalThread];
      await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments("PAP-1") }); });
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "delivered")).toBe(true);
      expect(delivery()).toContain("Delivered");
      expect(delivery()).not.toContain("Not delivered");
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/after-not-delivered-server-delivered-${width}.txt`, `${bubbles()[0]!.outerHTML}\n`);
      }
    },
    15_000,
  );

  // heldcap (RFL gate 7, B''c GRADES/bc-g7 t2-aged, f001750 1:10): the steer's run ended unread but a LIVE
  // wake still holds it to deliver next. neworg/caption-held 8fb2d8bf (server/src/services/carried-steer.ts:102-105)
  // projects it deliveryOutcome 'queued', steeringStatus null, steeringUnavailableReason null (steeredIntoRunId
  // untouched). It reads 'Waiting: …' in the thread, or sits in the waiting bar when the queue GET lists it, and
  // NEVER 'Not delivered' (a person who believed that re-sent and got two answers). Then it is answered.
  const HELD_BY_LIVE_WAKE = { steeringStatus: null, carriedIntoRunId: null, steeringDeliveryEventSeq: null,
    deliveryOutcome: "queued", steeringUnavailableReason: null };
  const HELD_ANSWERED = { steeringStatus: null, carriedIntoRunId: null, steeringDeliveryEventSeq: null,
    deliveryOutcome: "ordinary", steeringUnavailableReason: null };
  const HELD_WAKE_RUN_ID = "7d1e0c4b-3a2f-4e9d-8b6c-5f4a3e2d1c0b";
  const HELD_ANSWER_TEXT = "Answered: read your held message after the held tool.";
  it.each([
    [390, "kept", "thread"], [1440, "kept", "thread"], [390, "null", "thread"], [1440, "null", "thread"],
    [390, "kept", "queue"], [1440, "kept", "queue"],
  ] as const)(
    "held: a steer a live wake still holds reads 'Waiting: …' (never 'Not delivered'), then reads as answered at %i (steeredIntoRunId %s, %s)",
    async (width, steered, listed) => {
      const { post, runId, state, bubbles, waitingText } = await renderSteeringPlacement(width, "steer");
      const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="stand-in-editor"]')!;
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      const delivery = () => bubbles()[0]?.querySelector('[data-testid="task-chat-steered-delivery"]')?.textContent ?? "";
      const page = () => container.textContent ?? "";
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "sent")).toBe(true);
      expect(state.thread).toContainEqual(expect.objectContaining({ id: post.id, steeringStatus: "accepted", steeredIntoRunId: runId }));
      // The run ends unread; the server's live wake holds the message to deliver next.
      await endTheSteeredRun(runId);
      state.thread = a2r3({ ...HELD_BY_LIVE_WAKE, steeredIntoRunId: steered === "kept" ? runId : null });
      if (listed === "queue") {
        const entryComment = Object.fromEntries(Object.entries(STEER_A2_THREAD_GET_DELIVERED[0])
          .filter(([key]) => !/^steer/.test(key)));
        state.queue = createQueuedCommentQueue({
          queueId: "5c2b1a09-8f7e-4d6c-b5a4-39281706f5e4", state: "deferred", targetRunId: HELD_WAKE_RUN_ID,
          entries: [{ comment: entryComment as never, position: 0, canEdit: true, canDiscard: true, behindReset: false }],
        } as never);
      }
      await act(async () => { await queryClient.invalidateQueries(); });
      if (listed === "thread") {
        expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "waiting")).toBe(true);
        expect(bubbles()).toHaveLength(1);
        expect(delivery().replace(/^ · /, "")).toBe("Waiting: it will be answered when the agent is free.");
        expect(delivery()).not.toMatch(/\bSent\b/);
      } else {
        expect(await waitUntil(() => waitingText().includes(post.body))).toBe(true);
        expect(bubbles().filter((node) => !node.closest('[data-testid="task-chat-queued-messages"]'))).toHaveLength(0);
      }
      expect(page()).not.toContain("Not delivered");
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/held-${listed}-${steered}-${width}.txt`,
          `${listed === "thread" ? bubbles()[0]!.outerHTML : container.querySelector('[data-testid="task-chat-queued-messages"]')!.outerHTML}\n`);
      }
      // The wake's run answers it: the server no longer holds it, the agent's reply follows it.
      state.queue = createQueuedCommentQueue({ queueId: null, state: null, targetRunId: null, entries: [] });
      state.thread = [
        ...a2r3({ ...HELD_ANSWERED, steeredIntoRunId: steered === "kept" ? runId : null }),
        { ...STEER_A2_THREAD_GET_DELIVERED[1], id: "e0f1a2b3-c4d5-4e6f-8a7b-9c0d1e2f3a4b", authorType: "agent",
          authorAgentId: "agent-1", authorUserId: null, clientRequestId: null, createdByRunId: HELD_WAKE_RUN_ID,
          body: HELD_ANSWER_TEXT, createdAt: "2026-11-19T07:45:10.000Z", updatedAt: "2026-11-19T07:45:10.000Z" },
      ];
      await act(async () => { await queryClient.invalidateQueries(); });
      expect(await waitUntil(() => page().includes(HELD_ANSWER_TEXT) && bubbles().length === 1)).toBe(true);
      expect(waitingText()).not.toContain(post.body);
      expect(page()).not.toContain("Waiting: it will be answered when the agent is free.");
      expect(page()).not.toContain("Not delivered");
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/held-answered-${listed}-${steered}-${width}.txt`, `${bubbles()[0]!.outerHTML}\n`);
      }
    },
    15_000,
  );

  // carried: A2r3 's-steer5a i-b' (steerkill-g4s5a-i-b-105057): the turn ended unread, the server took
  // the message into the next turn (steeringStatus 'carried' + carriedIntoRunId), then Pi read it there
  // ('delivered'). Also with no steeredIntoRunId in the body: the server's word alone places the bubble.
  it.each([
    [390, "kept"], [1440, "kept"], [390, "null"], [1440, "null"],
  ] as const)(
    "carried: a steer whose turn ended unread reads 'Taken into the next turn' (never 'Not delivered'), then 'Delivered' at %i (steeredIntoRunId %s)",
    async (width, steered) => {
      const { runId, state, bubbles } = await renderSteeringPlacement(width, "steer");
      const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="stand-in-editor"]')!;
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      const delivery = () => bubbles()[0]?.querySelector('[data-testid="task-chat-steered-delivery"]')?.textContent ?? "";
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "sent")).toBe(true);
      expect(delivery()).toContain("Sent");
      const steeredIntoRunId = steered === "kept" ? runId : null;
      await endTheSteeredRun(runId);
      state.thread = a2r3({ ...A2R3_CARRIED, steeredIntoRunId });
      await act(async () => { await queryClient.invalidateQueries(); });
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "carried")).toBe(true);
      expect(bubbles()).toHaveLength(1);
      expect(delivery()).toContain("Taken into the next turn");
      expect(delivery()).not.toContain("Not delivered");
      expect(delivery()).not.toMatch(/\bSent\b/);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/carried-${steered}-${width}.txt`, `${bubbles()[0]!.outerHTML}\n`);
      }
      state.thread = a2r3({ ...A2R3_CARRIED_DELIVERED, steeredIntoRunId });
      await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments("PAP-1") }); });
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "delivered")).toBe(true);
      expect(delivery()).toContain("Delivered");
      expect(delivery()).not.toContain("Not delivered");
      expect(delivery()).not.toContain("Taken into the next turn");
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/carried-then-delivered-${steered}-${width}.txt`, `${bubbles()[0]!.outerHTML}\n`);
      }
    },
    15_000,
  );

  // No client inference: the server still says 'accepted' with NO reason while the client's run lists
  // show R ended. The bubble keeps the server's word ('Sent'), never 'Not delivered'.
  it.each([390, 1440])(
    "accepted + an ended run with NO server reason is NOT 'Not delivered' (no client inference) at %i",
    async (width) => {
      const { post, runId, state, bubbles } = await renderSteeringPlacement(width, "steer");
      const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="stand-in-editor"]')!;
      await act(async () => {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      const delivery = () => bubbles()[0]?.querySelector('[data-testid="task-chat-steered-delivery"]')?.textContent ?? "";
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "sent")).toBe(true);
      await endTheSteeredRun(runId);
      await act(async () => { await queryClient.invalidateQueries(); });
      await flushReact();
      await flushReact();
      expect(state.thread).toContainEqual(expect.objectContaining({ id: post.id, steeringStatus: "accepted", steeredIntoRunId: runId }));
      expect(mockActivityApi.runsForIssue).toHaveBeenCalled();
      expect(bubbles()).toHaveLength(1);
      expect(bubbles()[0]!.dataset.delivery).toBe("sent");
      expect(delivery()).toContain("Sent");
      expect(delivery()).not.toContain("Not delivered");
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/accepted-ended-no-reason-${width}.txt`, `${bubbles()[0]!.outerHTML}\n`);
      }
    },
    15_000,
  );

  it.each([390, 1440])(
    "steering placement: Send ▾ Queue while the agent works puts the message in the waiting list (real server bodies), never as a steered thread item at %i",
    async (width) => {
      const { post, posts, bubbles, waitingText } = await renderSteeringPlacement(width, "queue");
      const toggle = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-send-menu-toggle"]');
      expect(toggle).not.toBeNull();
      await act(async () => { toggle!.click(); });
      await flushReact();
      const queueItem = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-send-menu-queue"]');
      expect(queueItem).not.toBeNull();
      await act(async () => { queueItem!.click(); });
      expect(await waitUntil(() => waitingText().includes(post.body))).toBe(true);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ body: post.body, deliveryIntent: "queue" });
      expect(container.querySelector('[data-testid="task-chat-queued-list"]')?.textContent).toContain(post.body);
      expect(container.querySelectorAll('[data-testid="task-chat-steered-message"]')).toHaveLength(0);
      expect(bubbles().filter((node) => node.dataset.delivery)).toHaveLength(0);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/queued-list-${width}.txt`,
          `${container.querySelector('[data-testid="task-chat-queued-messages"]')!.outerHTML}\n`);
      }
    },
    15_000,
  );

  // steer-ui3 (Paul 11-19, gate 4 hand take: bubble at +2.87 s, POST 2.67 s). The
  // message is in the thread AT THE KEYDOWN as a NEUTRAL pending bubble ('Sending…';
  // neither 'Sent' nor 'Queued'), then the server's answer confirms it on the SAME
  // node (steered), moves it to the waiting list (queued) or fails (error line, text
  // kept). Every POST answer below is DELAYED 2 s and is a planted server body.
  const DELAYED_POST_MS = 2000;
  async function pressEnterAndReadPending(bubbles: () => HTMLElement[], body: string, width: number, label: string) {
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="stand-in-editor"]')!;
    const started = performance.now();
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(await waitUntil(() => bubbles().some((node) => node.dataset.testid === "task-chat-steered-message"), 300)).toBe(true);
    const elapsed = performance.now() - started;
    expect(elapsed, `Enter to pending bubble: ${elapsed} ms`).toBeLessThanOrEqual(300);
    const pending = bubbles();
    expect(pending).toHaveLength(1);
    const node = pending[0]!;
    expect(node.dataset.delivery).toBe("pending");
    expect(node.textContent).toContain("Sending…");
    // Neutral: never 'Sent' (RFL S-e) or 'Queued' before the server answers.
    expect(node.textContent).not.toMatch(/\bSent\b|Delivered|Queued/);
    expect(node.querySelector('[data-testid="task-chat-steered-delivery"]')).toBeNull();
    expect(node.dataset.steeredIntoRunId).toBeUndefined();
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')?.textContent ?? "").not.toContain(body);
    if (process.env.STEER_UI_EVIDENCE) {
      writeFileSync(`${process.env.STEER_UI_EVIDENCE}/pending-${label}-${width}.txt`, `${elapsed.toFixed(1)} ms\n${node.outerHTML}\n`);
    }
    return { node, started, elapsed };
  }

  it.each([390, 1440])(
    "steer-ui3: Enter while the agent works shows the message in the thread at once as pending ('Sending…'); the delayed steered answer turns the SAME bubble 'Sent' at %i",
    async (width) => {
      const { post, runId, posts, bubbles, waitingText } = await renderSteeringPlacement(width, "steer", { delayMs: DELAYED_POST_MS });
      const { node, started } = await pressEnterAndReadPending(bubbles, post.body, width, "steer");
      // Still pending well into the POST: nothing claims 'Sent' before the server.
      await new Promise((resolve) => setTimeout(resolve, DELAYED_POST_MS / 2));
      await flushReact();
      expect(bubbles()).toHaveLength(1);
      expect(bubbles()[0]).toBe(node);
      expect(node.dataset.delivery).toBe("pending");
      expect(node.textContent).not.toMatch(/\bSent\b/);
      expect(await waitUntil(() => bubbles()[0]?.dataset.delivery === "sent", DELAYED_POST_MS + 3000)).toBe(true);
      const answeredAt = performance.now() - started;
      expect(answeredAt).toBeGreaterThanOrEqual(DELAYED_POST_MS - 50);
      expect(posts).toHaveLength(1);
      expect(posts[0]).not.toHaveProperty("deliveryIntent");
      const sent = bubbles();
      expect(sent).toHaveLength(1);
      // The SAME DOM node: no flicker, no duplicate.
      expect(sent[0]).toBe(node);
      expect(node.isConnected).toBe(true);
      expect(node.dataset.steeredIntoRunId).toBe(runId);
      expect(node.textContent).not.toMatch(/Sending…|Queued/);
      expect(node.querySelector('[data-testid="task-chat-steered-delivery"]')?.textContent).toContain("Sent");
      expect(container.querySelectorAll('[data-testid="task-chat-steered-message"]')).toHaveLength(1);
      expect(waitingText()).not.toContain(post.body);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/pending-then-sent-${width}.txt`, `answered at ${answeredAt.toFixed(1)} ms\n${node.outerHTML}\n`);
      }
    },
    20_000,
  );

  // steer-ui4 (RFL rfl-steerui2 FAIL (1); SUPERSEDE-STEER-UI-NO-CLIENT-GUESS-1119): only the
  // SERVER's queue state places a message in the waiting list. A bare answer is never
  // put there by a client rule (the old IssueDetail timestamp rule: createdAt >= the
  // live run's startedAt).
  it.each([390, 1440])(
    "steer-ui4: a BARE POST answer (no steer, no queued marker) while the agent works stays in the thread, never in the waiting list at %i",
    async (width) => {
      const { post, posts, bubbles, waitingText } = await renderSteeringPlacement(width, "queue", { delayMs: DELAYED_POST_MS, says: "bare" });
      await pressEnterAndReadPending(bubbles, post.body, width, "bare");
      // The answer has landed when the pending bubble is gone.
      expect(await waitUntil(() => !bubbles().some((node) => node.dataset.delivery === "pending"), DELAYED_POST_MS + 3000)).toBe(true);
      // Let the follow-up reads (thread, queued comments) settle.
      for (let i = 0; i < 10; i++) await flushReact();
      expect(posts).toHaveLength(1);
      expect(posts[0]).not.toHaveProperty("deliveryIntent");
      // No client rule puts a bare answer in the waiting list.
      expect(waitingText()).not.toContain(post.body);
      expect(container.querySelector('[data-testid="task-chat-queued-list"]')?.textContent ?? "").not.toContain(post.body);
      // It is in the thread, as the person's message.
      expect(await waitUntil(() => bubbles().length === 1)).toBe(true);
      const shown = bubbles();
      expect(shown).toHaveLength(1);
      expect(shown[0]!.textContent).not.toMatch(/Queued|Sending…/);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/bare-answer-${width}.txt`,
          `${shown[0]!.outerHTML}\nwaiting list: ${JSON.stringify(waitingText())}\n`);
      }
    },
    20_000,
  );

  it.each([390, 1440])(
    "steer-ui4 control: an answer that SAYS queued (deliveryOutcome 'queued' + the server's queued-comments read) moves it to the waiting list at %i",
    async (width) => {
      const { post, posts, bubbles, waitingText } = await renderSteeringPlacement(width, "queue", { delayMs: DELAYED_POST_MS, says: "queued" });
      expect(post).toMatchObject({ deliveryOutcome: "queued" });
      await pressEnterAndReadPending(bubbles, post.body, width, "says-queued");
      expect(await waitUntil(() => waitingText().includes(post.body), DELAYED_POST_MS + 3000)).toBe(true);
      expect(posts).toHaveLength(1);
      expect(container.querySelector('[data-testid="task-chat-queued-list"]')?.textContent).toContain(post.body);
      expect(container.querySelectorAll('[data-testid="task-chat-steered-message"]')).toHaveLength(0);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/says-queued-${width}.txt`,
          `${container.querySelector('[data-testid="task-chat-queued-messages"]')!.outerHTML}\n`);
      }
    },
    20_000,
  );

  it.each([390, 1440])(
    "steer-ui3: the delayed QUEUED answer moves the pending bubble out of the thread and into the waiting list at %i",
    async (width) => {
      const { post, posts, bubbles, waitingText } = await renderSteeringPlacement(width, "queue", { delayMs: DELAYED_POST_MS });
      await pressEnterAndReadPending(bubbles, post.body, width, "queue");
      expect(await waitUntil(() => waitingText().includes(post.body), DELAYED_POST_MS + 3000)).toBe(true);
      expect(posts).toHaveLength(1);
      expect(container.querySelector('[data-testid="task-chat-queued-list"]')?.textContent).toContain(post.body);
      expect(container.querySelectorAll('[data-testid="task-chat-steered-message"]')).toHaveLength(0);
      expect(bubbles().filter((node) => node.dataset.delivery)).toHaveLength(0);
      if (process.env.STEER_UI_EVIDENCE) {
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/pending-then-queued-${width}.txt`,
          `${container.querySelector('[data-testid="task-chat-queued-messages"]')!.outerHTML}\n`);
      }
    },
    20_000,
  );

  it.each([
    [500, 390], [500, 1440], [409, 390], [409, 1440],
  ] as const)(
    "steer-ui3: the delayed %i answer turns the pending bubble into the composer's error line with the text kept, never a silent vanish at %i",
    async (status, width) => {
      const { post, bubbles } = await renderSteeringPlacement(width, "steer", { delayMs: DELAYED_POST_MS, failStatus: status });
      mockPushToast.mockClear();
      await pressEnterAndReadPending(bubbles, post.body, width, `error${status}`);
      const editorText = () => container.querySelector<HTMLTextAreaElement>('[data-testid="stand-in-editor"]')?.value ?? "";
      const errorShown = () => status === 500
        ? container.querySelector('[data-testid="pending-send-notice"]') !== null
        : mockPushToast.mock.calls.some(([toast]) => (toast as { tone?: string }).tone === "error");
      expect(await waitUntil(() => errorShown() && editorText() === post.body, DELAYED_POST_MS + 3000)).toBe(true);
      // The text is kept in the composer to retry or edit; the thread claims nothing.
      expect(editorText()).toBe(post.body);
      expect(container.querySelectorAll('[data-testid="task-chat-steered-message"]')).toHaveLength(0);
      expect(container.textContent ?? "").not.toMatch(/· Sent|· Delivered/);
      if (process.env.STEER_UI_EVIDENCE) {
        const line = status === 500
          ? container.querySelector('[data-testid="pending-send-notice"]')!.outerHTML
          : JSON.stringify(mockPushToast.mock.calls.at(-1)?.[0]);
        writeFileSync(`${process.env.STEER_UI_EVIDENCE}/pending-then-error${status}-${width}.txt`, `editor: ${editorText()}\n${line}\n`);
      }
    },
    20_000,
  );

  it("confirms the composer Stop from the authoritative cancellation response during a status outage", async () => {
    mockIssuesApi.update.mockClear();
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
    mockHeartbeatsApi.cancel.mockReset().mockResolvedValue({
      id: "run-active-1", companyId: "company-1", runtimeMode: "native", status: "cancelled",
      resultJson: { nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: "run-active-1", companyId: "company-1",
        scope: "run", dispatchState: "acknowledged",
      } },
    });
    mockHeartbeatsApi.get.mockReset().mockRejectedValue(new Error("Status request unavailable"));
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1",
    }));
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([{
      id: "run-active-1", agentId: "agent-1", status: "running", runtimeMode: "native",
      issueId: "issue-1", adapterType: "paperclip_runner",
    }]);
    await act(async () => { renderIssueView(); });
    await waitForAssertion(() => expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].onCancelRun).toBeTypeOf("function"));
    await act(async () => {
      await expect(mockIssueChatThreadRender.mock.calls.at(-1)![0].onCancelRun()).resolves.toBeUndefined();
    });
    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledExactlyOnceWith("run-active-1");
    expect(mockHeartbeatsApi.get).not.toHaveBeenCalled();
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
  });

  // C8 (live FAIL 06:00Z gate3): after the person's confirmed Stop the LIVE RUN
  // lane ('Working for 37s · Running an unnamed tool') stayed until a poll.
  // Planted, in the real route shapes: GET /issues/:id/live-runs and
  // /active-run return the running native run; GET /issues/:id/runs lists it;
  // POST /heartbeat-runs/:id/cancel answers the run 'cancelled' with the
  // acknowledged native cancellation record (as the live response did). After
  // the cancel every later live-runs/active-run (and, for the Stop row,
  // runs) read is held pending, so only the cancel response itself can end
  // the lane: no poll, no refetch round trip.
  async function renderC8LiveNativeRun(width: number, cancel: () => Promise<unknown>, holdLinkedRuns = false) {
    mockSidebarState.isMobile = width < 768;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    mockIssuesApi.update.mockClear();
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
    const startedAt = new Date(Date.now() - 37_000).toISOString();
    const liveRun = {
      id: "run-active-1", status: "running", invocationSource: "on_demand", triggerDetail: "manual",
      startedAt, finishedAt: null, createdAt: startedAt, agentId: "agent-1", agentName: "CodexCoder",
      adapterType: "paperclip_runner", runtimeMode: "native", issueId: "issue-1", logBytes: null, lastOutputBytes: 354,
    };
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1" }));
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([liveRun]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(liveRun);
    mockActivityApi.runsForIssue.mockResolvedValue([{
      runId: "run-active-1", status: "running", agentId: "agent-1", adapterType: "paperclip_runner", runtimeMode: "native",
      startedAt, finishedAt: null, createdAt: startedAt, invocationSource: "on_demand", usageJson: null, resultJson: null,
    }]);
    mockHeartbeatsApi.get.mockReset().mockRejectedValue(new Error("Status request unavailable"));
    mockHeartbeatsApi.cancel.mockReset().mockImplementation(cancel);
    await act(async () => { renderIssueView(); });
    const lane = () => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        activeRun?: { id: string; status: string } | null; liveRuns?: Array<{ id: string; status: string }>;
        linkedRuns?: Array<{ runId: string; status: string }>; onCancelRun?: () => Promise<void>;
      } | undefined;
      // TaskChatThread's live lane rule (TaskChatThread.tsx liveRun): the active run, else a live list run.
      const live = (run?: { status: string } | null) => run?.status === "running" || run?.status === "queued";
      return { props, run: (live(props?.activeRun) ? props?.activeRun : props?.liveRuns?.find(live)) ?? null };
    };
    await waitForAssertion(() => {
      expect(lane().run?.id).toBe("run-active-1");
      expect(lane().props?.onCancelRun).toBeTypeOf("function");
    });
    const held = new Promise<never>(() => undefined);
    mockHeartbeatsApi.liveRunsForIssue.mockReturnValue(held);
    mockHeartbeatsApi.activeRunForIssue.mockReturnValue(held);
    if (holdLinkedRuns) mockActivityApi.runsForIssue.mockReturnValue(held);
    return lane;
  }

  it.each([390, 1440])("C8: the person's confirmed Stop ends the live run lane at once, with every run read still pending, at %i", async (width) => {
    let cancelResponseAt = 0;
    const lane = await renderC8LiveNativeRun(width, async () => (cancelResponseAt = Date.now(), {
      id: "run-active-1", companyId: "company-1", runtimeMode: "native", status: "cancelled",
      finishedAt: new Date().toISOString(), error: "Cancelled by a board operator", errorCode: "cancelled",
      resultJson: { stopReason: "cancelled", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId: "run-active-1", companyId: "company-1",
        scope: "run", dispatchState: "acknowledged",
      } },
    }), true);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    // The Stop's own settle waits on the held GET /issues/:id/runs; the lane must not.
    await act(async () => { void lane().props!.onCancelRun!(); });
    // F1 (rf-2): the confirmed Stop's settle also invalidates the COMPANY live-runs
    // cache (['live-runs', companyId]), so a company view need not wait for a socket or poll.
    await waitForAssertion(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.liveRuns("company-1") }));
    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledExactlyOnceWith("run-active-1");
    await waitForAssertion(() => expect(lane().run).toBeNull());
    expect(Date.now() - cancelResponseAt).toBeLessThan(1_000);
    expect(lane().props?.liveRuns?.map((run) => run.id)).not.toContain("run-active-1");
    expect(lane().props?.activeRun ?? null).toBeNull();
    expect(lane().props?.linkedRuns?.find((run) => run.runId === "run-active-1")?.status).toBe("cancelled");
  });

  it.each([390, 1440])("C8 control: a refused Stop keeps the live run lane, at %i", async (width) => {
    const lane = await renderC8LiveNativeRun(width, async () => {
      throw new ApiError("This run can no longer be stopped.", 409, {});
    });
    await act(async () => {
      await expect(lane().props!.onCancelRun!()).rejects.toThrow("This run can no longer be stopped.");
    });
    for (let flush = 0; flush < 20; flush += 1) await flushReact();
    expect(lane().run?.id).toBe("run-active-1");
    expect(lane().run?.status).toBe("running");
  });

  it("routes live-run finalization actions through run cancellation before issue status update", async () => {
    mockHeartbeatsApi.cancel.mockClear();
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-active-1",
      }),
    );
    mockIssuesApi.update.mockImplementation((_id, data) =>
      Promise.resolve(
        createIssue({
          status: data.status as Issue["status"],
          assigneeAgentId: "agent-1",
        }),
      ),
    );
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    const stopAndDoneButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Stop and done");
    expect(stopAndDoneButton).toBeTruthy();

    await act(async () => {
      stopAndDoneButton!.click();
    });
    await flushReact();

    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-active-1");
    expect(mockIssuesApi.update).toHaveBeenCalledWith("PAP-1", {
      status: "done",
    });
    expect(mockHeartbeatsApi.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      mockIssuesApi.update.mock.invocationCallOrder[0],
    );

    const stopAndCancelButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Stop and cancel");
    expect(stopAndCancelButton).toBeTruthy();

    await act(async () => {
      stopAndCancelButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.update).toHaveBeenLastCalledWith("PAP-1", {
      status: "cancelled",
    });
    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatsApi.cancel.mock.invocationCallOrder[1]).toBeLessThan(
      mockIssuesApi.update.mock.invocationCallOrder[1],
    );
  });

  it("reports partial success when run finalization stops the run but task status update fails", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-active-1",
      }),
    );
    mockIssuesApi.update.mockRejectedValue(new Error("Status write failed"));
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    const stopAndDoneButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Stop and done");
    expect(stopAndDoneButton).toBeTruthy();

    await act(async () => {
      stopAndDoneButton!.click();
    });
    await flushReact();

    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-active-1");
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Run stopped; task update failed",
        body: "Run was stopped, but updating the task failed: Status write failed",
        tone: "error",
      }),
    );
  });

  it("passes planning work mode to the issue chat thread", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ workMode: "planning" }));
    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      issueWorkMode: "planning",
    });
  });

  it.each(["accept", "reject"] as const)("refreshes the request after a superseded %s response", async action => {
    const pending = (await import("@/fixtures/issueThreadInteractionFixtures")).genericPendingRequestConfirmationInteraction;
    const expired = { ...pending, status: "expired", result: { version: 1, outcome: "superseded_by_newer_request" } };
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.listInteractions.mockResolvedValue([pending]);
    const error = new ApiError("Interaction has been superseded", 409, { details: { code: "interaction_superseded" } });
    mockIssuesApi.acceptInteraction.mockRejectedValue(error);
    mockIssuesApi.rejectInteraction.mockRejectedValue(error);
    await act(async () => renderIssueView());
    await flushReact();
    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
    const reads = mockIssuesApi.listInteractions.mock.calls.length;
    mockIssuesApi.listInteractions.mockResolvedValue([expired]);
    await act(async () => {
      const resolve = action === "accept" ? props.onAcceptInteraction : props.onRejectInteraction;
      await expect(resolve(pending)).rejects.toBe(error);
    });
    await flushReact();
    expect(mockIssuesApi.listInteractions.mock.calls.length).toBeGreaterThan(reads);
    expect(queryClient.getQueryData(queryKeys.issues.interactions("PAP-1"))).toEqual([expired]);
  });

  it("reports the selected continuation action after rejecting completion", async () => {
    const pendingInteraction = {
      id: "interaction-continue",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "request_confirmation",
      title: "Review completion",
      summary: null,
      status: "pending",
      continuationPolicy: "wake_assignee",
      resolverPolicy: "human_only",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      legacyResolverPolicyAliases: {
        requested: "board_only",
        effective: "board_only",
      },
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      createdAt: new Date("2026-09-06T12:00:00.000Z"),
      updatedAt: new Date("2026-09-06T12:00:00.000Z"),
      resolvedAt: null,
      payload: {
        version: 1,
        prompt: "Is this task ready to complete?",
        acceptLabel: "Approve completion",
        rejectLabel: "Continue work",
      },
      result: null,
    } satisfies RequestConfirmationInteraction;
    const rejectedInteraction = {
      ...pendingInteraction,
      status: "rejected",
      resolvedAt: new Date("2026-09-06T12:01:00.000Z"),
      result: { version: 1, outcome: "rejected", reason: "Run turn 2" },
    } satisfies RequestConfirmationInteraction;
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.rejectInteraction.mockResolvedValue(rejectedInteraction);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      onRejectInteraction?: (
        interaction: RequestConfirmationInteraction,
        reason?: string,
      ) => Promise<void>;
    };
    expect(props.onRejectInteraction).toBeTypeOf("function");

    await act(async () => {
      await props.onRejectInteraction?.(pendingInteraction, "Run turn 2");
    });

    expect(mockIssuesApi.rejectInteraction).toHaveBeenCalledWith(
      "PAP-1",
      pendingInteraction.id,
      "Run turn 2",
    );
    expect(mockPushToast).toHaveBeenCalledWith({
      title: "Selected “Continue work”",
      tone: "success",
    });
  });

  it("passes ask work mode to the issue chat thread", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ workMode: "ask" }));
    await act(async () => {
      renderIssueView();
    });
    await flushReact();

    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      issueWorkMode: "ask",
    });
  });

  it("falls back to execCommand when copying the task from an insecure context", async () => {
    const clipboardWrite = vi.fn(async () => {
      throw new Error("Clipboard API blocked");
    });
    const execCommand = vi.fn(() => true);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const originalExecCommand = Object.getOwnPropertyDescriptor(
      document,
      "execCommand",
    );
    const originalSecureContext = Object.getOwnPropertyDescriptor(
      window,
      "isSecureContext",
    );
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        identifier: "PAP-1",
        title: "Copy me",
        description: "Task body",
      }),
    );

    try {
      await act(async () => {
        renderIssueView();
      });
      await flushReact();

      const moreButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="More task actions"]',
      );
      await act(async () => moreButton!.click());
      const copyButton = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "Copy as markdown");
      expect(copyButton).toBeTruthy();

      await act(async () => {
        copyButton!.click();
        await Promise.resolve();
      });

      expect(clipboardWrite).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Copied to clipboard",
          tone: "success",
        }),
      );
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete navigator.clipboard;
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete document.execCommand;
      }
      if (originalSecureContext) {
        Object.defineProperty(window, "isSecureContext", originalSecureContext);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete window.isSecureContext;
      }
    }
  });

  it.each([false, true])("marks only desktop-width classic chat pages for keyboard viewport sizing (mobile: %s)", async (isMobile) => {
    mockSidebarState.isMobile = isMobile;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableClassicTaskInterface: true });
    mockIssuesApi.get.mockResolvedValue(createIssue());
    await act(async () => { renderIssueView(); });
    await flushReact();
    await flushReact();
    expect(container.querySelector('[data-classic-task-shell]') !== null).toBe(!isMobile);
    expect(container.querySelector('[data-task-chat-shell]')).toBeNull();
  });

  it("renders the legacy issue chat thread when the classic task interface flag is on", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: true,
      enableClassicTaskInterface: true,
    });
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.listInteractions.mockResolvedValue([
      {
        id: "classic-question",
        companyId: "company-1",
        issueId: "issue-1",
        kind: "ask_user_questions",
        status: "answered",
        sourceRunId: "legacy-run",
        resolvedByUserId: "user-1",
        resolvedAt: "2026-04-21T00:00:04.000Z",
        createdAt: "2026-04-21T00:00:01.000Z",
        updatedAt: "2026-04-21T00:00:04.000Z",
        payload: {
          version: 1,
          questions: [
            {
              id: "runtime",
              prompt: "Which runtime?",
              selectionMode: "single",
              options: [{ id: "node", label: "Node.js" }],
            },
          ],
        },
        result: {
          version: 1,
          answers: [{ questionId: "runtime", optionIds: ["node"] }],
        },
      },
    ]);

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    expect(
      container.querySelector('[data-testid="issue-chat-thread"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-thread"]'),
    ).toBeNull();
    expect(mockIssueChatThreadRender).toHaveBeenCalled();
    const classicProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      comments?: Array<{ id: string }>;
    };
    expect(
      classicProps.comments?.some(
        (comment) => comment.id === "interaction-response:classic-question",
      ),
    ).toBe(false);
  });

  it("restores master's task chat thread when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: false,
      enableClassicTaskInterface: false,
    });
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    expect(
      container.querySelector('[data-testid="issue-chat-thread"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-thread"]'),
    ).not.toBeNull();
  });

  it("still honors Classic Task Interface when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: false,
      enableClassicTaskInterface: true,
    });
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    expect(
      container.querySelector('[data-testid="issue-chat-thread"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-thread"]'),
    ).toBeNull();
  });

  it("passes @task mention options to the thread by default", async () => {
    const mentionPoolIssue = {
      ...createIssue(),
      id: "issue-mention-1",
      identifier: "PAP-9",
      title: "Mentionable task",
    };
    mockIssuesApi.list.mockImplementation(
      (_companyId: string, filters?: { sortField?: string }) =>
        Promise.resolve(
          filters?.sortField === "updated" ? [mentionPoolIssue] : [],
        ),
    );
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].mentions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "issue", issueIdentifier: "PAP-9" }),
        ]),
      );
    });
    expect(mockIssuesApi.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ sortField: "updated" }),
    );
  });

  it("forwards composer work mode changes to the issues API", async () => {
    const issue = createIssue();
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.listAttachments.mockResolvedValue([
      {
        id: "attachment-1",
        issueId: issue.id,
        issueCommentId: null,
        originalFilename: "planning-notes.txt",
        contentPath: "/attachments/planning-notes.txt",
        contentType: "text/plain",
        byteSize: 4096,
        uploadedByUserId: null,
        uploadedAt: new Date("2026-04-21T00:02:00.000Z"),
      },
    ]);
    localStorage.setItem(
      "paperclip:issue-comment-draft:issue-1",
      "Draft follow-up message",
    );
    mockIssuesApi.update.mockResolvedValue(
      createIssue({ workMode: "planning" }),
    );

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const lastChatThreadProps =
      mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
    expect(lastChatThreadProps?.issueWorkMode).toBe("standard");
    expect(typeof lastChatThreadProps?.onWorkModeChange).toBe("function");

    await act(async () => {
      lastChatThreadProps?.onWorkModeChange?.("ask");
    });
    await flushReact();

    expect(mockIssuesApi.update).toHaveBeenCalledWith(issue.identifier, {
      workMode: "ask",
    });
    expect(localStorage.getItem("paperclip:issue-comment-draft:issue-1")).toBe(
      "Draft follow-up message",
    );
    localStorage.removeItem("paperclip:issue-comment-draft:issue-1");
  });

  describe.each([false, true])("composer tree control (mobile=%s)", (isMobile) => {
    const treeControlKey = ["issues", "tree-control-state", "PAP-1"];
    const composerProps = () => mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      composerDisabledReason: string | null;
      composerPause: TaskComposerPause | null;
      onAdd: (body: string) => Promise<void>;
    };

    async function renderWithPendingTreeControl() {
      mockSidebarState.isMobile = isMobile;
      mockIssuesApi.get.mockResolvedValue(createIssue());
      let resolve!: (value: Awaited<ReturnType<typeof issuesApi.getTreeControlState>>) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<Awaited<ReturnType<typeof issuesApi.getTreeControlState>>>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const response = { promise, resolve, reject };
      mockIssuesApi.getTreeControlState.mockReturnValue(response.promise);
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <IssueDetail />
          </QueryClientProvider>,
        );
      });
      await waitForAssertion(() => {
        expect(mockIssuesApi.getTreeControlState).toHaveBeenCalledWith("PAP-1");
        expect(mockIssueChatThreadRender).toHaveBeenCalled();
        expect(queryClient.getQueryState(treeControlKey)?.status).toBe("pending");
        expect(queryClient.getQueryState(treeControlKey)?.fetchStatus).toBe("fetching");
      });
      return response;
    }

    it("allows a message while tree control is pending and remains enabled after success", async () => {
      mockIssuesApi.addComment.mockClear().mockResolvedValue(createIssueComment({ body: "Keep working" }));
      const response = await renderWithPendingTreeControl();
      expect(composerProps().composerDisabledReason).toBeNull();
      expect(composerProps().composerPause).toBeNull();
      await act(async () => {
        await composerProps().onAdd("Keep working");
      });
      expect(mockIssuesApi.addComment).toHaveBeenCalledWith(
        "PAP-1", "Keep working", undefined, undefined, undefined, expect.any(String),
      );
      expect(queryClient.getQueryState(treeControlKey)?.status).toBe("pending");

      response.resolve({ activePauseHold: null });
      await waitForAssertion(() => {
        expect(queryClient.getQueryState(treeControlKey)?.status).toBe("success");
        expect(composerProps().composerDisabledReason).toBeNull();
        expect(composerProps().composerPause).toBeNull();
      });
    });

    it("blocks the composer when the pending tree control request fails", async () => {
      const response = await renderWithPendingTreeControl();
      response.reject(new Error("tree control unavailable"));
      await waitForAssertion(() => {
        expect(queryClient.getQueryState(treeControlKey)?.status).toBe("error");
        expect(composerProps().composerDisabledReason).toBe(
          "Couldn’t check whether this task is paused. Refresh to try again.",
        );
      });
    });

    it.each([true, false])("applies a late pause response (root=%s)", async (isRoot) => {
      const response = await renderWithPendingTreeControl();
      response.resolve({
        activePauseHold: {
          holdId: "hold-1",
          rootIssueId: isRoot ? "issue-1" : "parent-1",
          issueId: "issue-1",
          isRoot,
          mode: "pause",
          reason: null,
          releasePolicy: { strategy: "manual" },
        },
      });
      await waitForAssertion(() => {
        expect(composerProps().composerPause?.scope).toBe(isRoot ? "leaf" : "subtree");
        expect(container.querySelector('[data-testid="paused-composer-takeover"]')).not.toBeNull();
      });
    });
  });

  it("renders a quiet task pause notice and defaults leaf resume to wake the assignee", async () => {
    const activeHold = createPauseHold();
    const releasedHold = createPauseHold({
      status: "released",
      releasedAt: new Date("2026-04-21T00:01:00.000Z"),
      releasedByActorType: "user",
      releasedByUserId: "user-1",
      releaseReason: "Ready to continue",
      updatedAt: new Date("2026-04-21T00:01:00.000Z"),
    });

    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_review",
        assigneeAgentId: "agent-1",
      }),
    );
    mockIssuesApi.getTreeControlState.mockResolvedValue({
      activePauseHold: {
        holdId: "hold-1",
        rootIssueId: "issue-1",
        issueId: "issue-1",
        isRoot: true,
        mode: "pause",
        reason: null,
        releasePolicy: { strategy: "manual", note: "leaf_pause" },
      },
    });
    mockIssuesApi.listTreeHolds.mockResolvedValue([activeHold]);
    mockIssuesApi.previewTreeControl.mockResolvedValue(createResumePreview());
    mockIssuesApi.releaseTreeHold.mockResolvedValue(releasedHold);
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Task is paused.");
      expect(container.textContent).toContain("in_review");
      expect(container.textContent).not.toContain("Subtree is paused.");
    });

    const resumeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Resume task",
    );
    expect(resumeButton).toBeTruthy();

    await act(async () => {
      resumeButton!.click();
    });
    await flushReact();
    await flushReact();

    const wakeCheckbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(wakeCheckbox?.checked).toBe(true);

    const applyResumeButton = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent?.trim() === "Resume work")
      .at(-1);
    expect(applyResumeButton).toBeTruthy();

    await act(async () => {
      applyResumeButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.releaseTreeHold).toHaveBeenCalledWith(
      "PAP-1",
      "hold-1",
      {
        reason: null,
        metadata: { wakeAgents: true },
      },
    );
  });

  it("exposes restore subtree from the issue actions menu", async () => {
    const childIssue = createIssue({
      id: "child-1",
      parentId: "issue-1",
      identifier: "PAP-2",
      issueNumber: 2,
      title: "Cancelled child",
      status: "cancelled",
      assigneeAgentId: "agent-1",
    });
    const cancelHold = createPauseHold({
      id: "cancel-hold-1",
      mode: "cancel",
      reason: "bad plan",
      members: [],
    });
    const restorePreview = createRestorePreview();
    const restoreHold = createPauseHold({
      id: "restore-hold-1",
      mode: "restore",
      status: "released",
      reason: null,
      releaseReason: "Restore operation applied",
      releasedAt: new Date("2026-04-21T00:02:00.000Z"),
      members: [],
    });

    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockImplementation(
      (_companyId, filters?: { descendantOf?: string }) =>
        Promise.resolve(
          filters?.descendantOf === "issue-1" ? [childIssue] : [],
        ),
    );
    mockIssuesApi.listTreeHolds.mockImplementation(
      (_issueId, filters?: { mode?: string }) =>
        Promise.resolve(filters?.mode === "cancel" ? [cancelHold] : []),
    );
    mockIssuesApi.previewTreeControl.mockResolvedValue(restorePreview);
    mockIssuesApi.createTreeHold.mockResolvedValue({
      hold: restoreHold,
      preview: restorePreview,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector(
      'button[aria-label="More task actions"]',
    ) as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();

    await act(async () => {
      moreButton!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flushReact();

    const restoreMenuButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Restore subtree...");
    expect(restoreMenuButton).toBeTruthy();

    await act(async () => {
      restoreMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockIssuesApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "restore",
      releasePolicy: { strategy: "manual" },
    });
    expect(container.textContent).toContain("1 task will be restored.");

    const restoreApplyButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Restore 1 task");
    expect(restoreApplyButton).toBeTruthy();

    await act(async () => {
      restoreApplyButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "restore",
      reason: null,
      releasePolicy: { strategy: "manual" },
      metadata: { wakeAgents: false },
    });
  });

  it("confirms cancellation once without a reason, checkbox, or task inventory", async () => {
    mockIssuesApi.createTreeHold.mockClear();
    const childIssue = createIssue({
      id: "child-1",
      parentId: "issue-1",
      identifier: "PAP-2",
      issueNumber: 2,
      title: "Cancellable child",
    });

    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockImplementation(
      (_companyId, filters?: { descendantOf?: string }) =>
        Promise.resolve(
          filters?.descendantOf === "issue-1" ? [childIssue] : [],
        ),
    );
    mockIssuesApi.previewTreeControl.mockResolvedValue(createCancelPreview(24));
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      renderIssueView();
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector(
      'button[aria-label="More task actions"]',
    )!;
    await act(async () => {
      moreButton.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await flushReact();
    const cancelMenuButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Cancel subtree...");
    expect(cancelMenuButton).toBeTruthy();

    await act(async () => {
      cancelMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockIssuesApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "cancel",
      releasePolicy: { strategy: "manual" },
    });

    const dialogContent = container.querySelector(
      '[data-slot="dialog-content"]',
    ) as HTMLDivElement | null;
    expect(dialogContent).toBeTruthy();
    expect(dialogContent!.textContent).toContain("Cancel subtree?");
    expect(dialogContent!.textContent).toContain("24 tasks will be cancelled.");
    expect(dialogContent!.textContent).toContain("Keep tasks");
    expect(
      dialogContent!.querySelector('textarea, input[type="checkbox"]'),
    ).toBeNull();
    expect(dialogContent!.textContent).not.toContain("Cancellable child");
    expect(mockIssuesApi.createTreeHold).not.toHaveBeenCalled();
    const cancelApplyButton = Array.from(
      dialogContent!.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Cancel 24 tasks")!;
    expect(cancelApplyButton.disabled).toBe(false);
    mockIssuesApi.createTreeHold.mockResolvedValue({
      hold: { ...createPauseHold(), mode: "cancel" },
      preview: createCancelPreview(24),
    });
    await act(async () => {
      cancelApplyButton.click();
    });
    await flushReact();
    expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "cancel",
      reason: null,
      releasePolicy: { strategy: "manual" },
    });
  });

  it("keeps the authoritative Paperclip queue mounted after handoff promotion", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-promoted-1",
      }),
    );
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ adapterType: "paperclip_runner" }),
    ]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(
      createQueuedCommentQueue({
        state: "queued",
        targetRunId: null,
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as
        | {
            queuedCommentQueue?: IssueQueuedCommentQueue | null;
          }
        | undefined;
      expect(mockIssuesApi.getQueuedComments).toHaveBeenCalledWith("issue-1");
      expect(props?.queuedCommentQueue).toMatchObject({
        queueId: "wake-queue-1",
        state: "queued",
        targetRunId: null,
      });
    });
  });

  it.each(DIRECT_ADAPTER_TYPES)(
    "loads only the shared queue projection for an active %s run after reassignment",
    async (adapterType) => {
      mockIssuesApi.get.mockResolvedValue(
        createIssue({
          status: "in_progress",
          assigneeAgentId: "agent-1",
          executionRunId: "run-direct-1",
        }),
      );
      mockAgentsApi.list.mockResolvedValue([
        createAgent({ adapterType: "paperclip_runner" }),
      ]);
      const directRun = {
        id: "run-direct-1",
        runtimeMode: "legacy" as const,
        status: "running",
        invocationSource: "issue",
        triggerDetail: null,
        contextCommentId: null,
        contextWakeCommentId: null,
        startedAt: "2026-04-21T00:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-04-21T00:00:00.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType,
        issueId: "issue-1",
      };
      mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(directRun);
      mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([directRun]);
      mockIssuesApi.getQueuedComments.mockClear();

      await act(async () => {
        renderIssueView();
      });
      await flushReact();
      await flushReact();

      expect(mockIssuesApi.getQueuedComments).toHaveBeenCalledWith("issue-1");
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        queuedCommentQueue?: IssueQueuedCommentQueue | null;
        runFinalizationActions?: readonly { id: string; label: string }[];
      };
      expect(props.queuedCommentQueue).toBeNull();
      expect(props.runFinalizationActions).toEqual([
        expect.objectContaining({ id: "cancel", label: "Stop and cancel" }),
        expect.objectContaining({ id: "done", label: "Stop and done" }),
      ]);
    },
  );

  it.each([true, false])("optimistically promotes the last steering message and restores it without a toast on rejection (history loaded: %s)", async historyLoaded => {
    const queue = createQueuedCommentQueue();
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1" }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
    mockIssuesApi.listComments.mockResolvedValue(historyLoaded ? [queue.entries[0].comment] : []);
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-active-1", runtimeMode: "native", status: "running", invocationSource: "issue",
      triggerDetail: null, contextCommentId: null, contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z", finishedAt: null, createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner", issueId: "issue-1",
    });
    let rejectSteer!: (error: Error) => void;
    mockIssuesApi.steerQueuedComment.mockReturnValue(new Promise((_, reject) => { rejectSteer = reject; }));
    await act(async () => { renderIssueView(); });
    type Props = { onSteerQueuedComment: (id: string, revision: string) => Promise<void>; queuedCommentQueue: IssueQueuedCommentQueue | null };
    let props!: Props;
    await waitForAssertion(() => {
      props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
      expect(props.queuedCommentQueue?.entries).toHaveLength(1);
      expect(props.queuedCommentQueue?.queueId).toBe("wake-queue-1");
      expect(props.queuedCommentQueue?.targetRunId).toBe("run-active-1");
    });
    let pending!: Promise<unknown>;
    await act(async () => { pending = props.onSteerQueuedComment("queued-comment-1", queue.revision).catch(error => error); });
    const whilePending = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
    expect(whilePending.queuedCommentQueue).toBeNull();
    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.comments).toContainEqual(expect.objectContaining({
      id: "queued-comment-1", steeredIntoRunId: "run-active-1", queueState: undefined,
    }));
    const failure = new ApiError("This runner does not support steering", 409, { code: "steering_unsupported" });
    await act(async () => { rejectSteer(failure); await pending; });
    expect(await pending).toBe(failure);
    await waitForAssertion(() => {
      expect((mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props).queuedCommentQueue?.entries).toHaveLength(1);
    });
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("promotes a steered message immediately while its durable timeline position refreshes", async () => {
    const queue = createQueuedCommentQueue();
    const steeredQueue = createQueuedCommentQueue({
      queueId: null,
      state: null,
      targetRunId: null,
      entries: [],
      revision: "queue-revision-2",
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-active-1",
      }),
    );
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ adapterType: "paperclip_runner" }),
    ]);
    mockIssuesApi.listComments.mockResolvedValue([queue.entries[0].comment]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-active-1",
      runtimeMode: "native",
      status: "running",
      invocationSource: "issue",
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
      issueId: "issue-1",
    });
    mockIssuesApi.steerQueuedComment.mockResolvedValue(steeredQueue);

    await act(async () => {
      renderIssueView();
    });

    let steer!: (commentId: string, revision: string) => Promise<void>;
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        onSteerQueuedComment?: typeof steer;
        queuedCommentQueue?: IssueQueuedCommentQueue | null;
      };
      expect(props.queuedCommentQueue?.entries).toHaveLength(1);
      expect(props.queuedCommentQueue?.queueId).toBe("wake-queue-1");
      expect(props.onSteerQueuedComment).toBeTypeOf("function");
      steer = props.onSteerQueuedComment!;
    });

    let releaseActivity!: (value: unknown[]) => void;
    const activityRefresh = new Promise<unknown[]>((resolve) => {
      releaseActivity = resolve;
    });
    mockActivityApi.forIssue.mockReturnValue(activityRefresh);

    let steeringPromise!: Promise<void>;
    let deliverySettled = false;
    await act(async () => {
      steeringPromise = steer("queued-comment-1", queue.revision).then(() => { deliverySettled = true; });
      await Promise.resolve();
    });
    await waitForAssertion(() => {
      expect(mockIssuesApi.steerQueuedComment).toHaveBeenCalled();
      expect(mockActivityApi.forIssue.mock.calls.length).toBeGreaterThan(1);
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.queuedCommentQueue).toBeNull();
      expect(deliverySettled).toBe(true);
    });

    const whileRefreshing = mockIssueChatThreadRender.mock.calls.at(
      -1,
    )?.[0] as {
      comments?: Array<{
        id: string;
        steeredIntoRunId?: string | null;
        conversationAnchorAt?: Date | string | null;
      }>;
      queuedCommentQueue?: IssueQueuedCommentQueue | null;
    };
    expect(whileRefreshing.queuedCommentQueue).toBeNull();
    expect(
      whileRefreshing.comments?.find(
        (comment) => comment.id === "queued-comment-1",
      ),
    ).toMatchObject({
      steeredIntoRunId: "run-active-1",
      conversationAnchorAt: expect.any(String),
    });

    releaseActivity([
      {
        id: "activity-steer-1",
        companyId: "company-1",
        issueId: "issue-1",
        action: "issue.queued_comment_steered",
        createdAt: new Date("2026-04-21T00:00:06.000Z"),
        details: {
          commentId: "queued-comment-1",
          targetRunId: "run-active-1",
          duplicate: false,
        },
      },
    ]);
    await act(async () => {
      await steeringPromise;
    });

    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<{
          id: string;
          steeredIntoRunId?: string | null;
          conversationAnchorAt?: Date | string | null;
        }>;
        queuedCommentQueue?: IssueQueuedCommentQueue | null;
      };
      expect(props.queuedCommentQueue).toBeNull();
      expect(
        props.comments?.find((comment) => comment.id === "queued-comment-1"),
      ).toMatchObject({
        steeredIntoRunId: "run-active-1",
        conversationAnchorAt: "2026-04-21T00:00:06.000Z",
      });
      expect(
        props.comments?.find((comment) => comment.id === "queued-comment-1"),
      ).not.toMatchObject({ clientStatus: "queued", queueState: "queued" });
    });
  });

  it.each([
    ["success", true], ["failure", true], ["success", false], ["failure", false],
  ] as const)("optimistically promotes the interrupt queue with no toast on %s (history loaded: %s)", async (outcome, historyLoaded) => {
    const queue = createQueuedCommentQueue({ protocol: "legacy", steeringDisposition: "unsupported" });
    queue.entries.push({ ...queue.entries[0], position: 1, comment: createIssueComment({ id: "queued-comment-2", body: "Second direction" }) });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1" }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "codex_local" })]);
    mockIssuesApi.listComments.mockResolvedValue(historyLoaded ? queue.entries.map(entry => entry.comment) : []);
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-active-1", runtimeMode: "legacy", status: "running", invocationSource: "issue",
      startedAt: "2026-04-21T00:00:00.000Z", finishedAt: null, createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1", agentName: "Coder", adapterType: "codex_local", issueId: "issue-1",
    });
    const delivery = createDeferred<IssueQueuedCommentQueue>();
    mockIssuesApi.interruptQueuedComments.mockReturnValue(delivery.promise);
    await act(async () => { renderIssueView(); });
    type Props = { onInterruptQueued: (runId: string | null) => Promise<void>; queuedCommentQueue: IssueQueuedCommentQueue | null; comments: Array<{ id: string; queueState?: string; conversationAnchorAt?: string }> };
    let props!: Props;
    await waitForAssertion(() => {
      props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
      expect(props.queuedCommentQueue?.entries).toHaveLength(2);
    });
    let pending!: Promise<unknown>;
    await act(async () => { pending = props.onInterruptQueued("run-active-1").catch(error => error); });
    const whilePending = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
    expect(whilePending.queuedCommentQueue).toBeNull();
    for (const entry of queue.entries) expect(whilePending.comments).toContainEqual(expect.objectContaining({
      id: entry.comment.id, queueState: undefined, conversationAnchorAt: expect.any(String),
    }));
    expect(mockPushToast).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "failure") delivery.reject(new Error("Connection lost"));
      else delivery.resolve(createQueuedCommentQueue({ entries: [] }));
      await pending;
    });
    await waitForAssertion(() => {
      const final = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
      if (outcome === "failure") expect(final.queuedCommentQueue?.entries).toHaveLength(2);
      else expect(final.queuedCommentQueue).toBeNull();
    });
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("restores a failed classic interrupt inline without a toast or an unhandled rejection", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: true, enableClassicTaskInterface: true });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1" }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "codex_local" })]);
    mockIssuesApi.listComments.mockResolvedValue([createIssueComment({ id: "queued-comment-1", body: "Next direction", createdAt: new Date("2026-04-21T00:00:05.000Z") })]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-active-1", runtimeMode: "legacy", status: "running", invocationSource: "issue",
      startedAt: "2026-04-21T00:00:00.000Z", finishedAt: null, createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1", agentName: "Coder", adapterType: "codex_local", issueId: "issue-1",
    });
    mockIssuesApi.getQueuedComments.mockResolvedValue(createQueuedCommentQueue({ protocol: "legacy", steeringDisposition: "unsupported" }));
    const delivery = createDeferred<IssueQueuedCommentQueue>();
    mockIssuesApi.interruptQueuedComments.mockReturnValue(delivery.promise);
    await act(async () => { renderIssueView(); });
    type Props = { onInterruptQueued: (runId: string | null) => Promise<void>; comments: Array<{ id: string; queueState?: string }> };
    let props!: Props;
    await waitForAssertion(() => {
      props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
      expect(props.comments).toContainEqual(expect.objectContaining({ id: "queued-comment-1", queueState: "queued" }));
    });
    let pending!: Promise<unknown>;
    await act(async () => { pending = props.onInterruptQueued("run-active-1").catch(error => error); });
    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.comments).toContainEqual(expect.objectContaining({ id: "queued-comment-1", queueState: undefined }));
    await act(async () => { delivery.reject(new Error("Connection lost")); await pending; });
    expect(await pending).toBeUndefined();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Couldn’t interrupt. Message is still queued.");
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]?.comments).toContainEqual(expect.objectContaining({ id: "queued-comment-1", queueState: "queued" }));
    });
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("keeps an unacknowledged queue visible while withholding server controls", async () => {
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
      }),
    );
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ adapterType: "paperclip_runner" }),
    ]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(
      createQueuedCommentQueue({
        queueId: null,
        state: null,
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as
        | {
            queuedCommentQueue?: IssueQueuedCommentQueue | null;
          }
        | undefined;
      expect(mockIssuesApi.getQueuedComments).toHaveBeenCalled();
      expect(props?.queuedCommentQueue).toMatchObject({
        queueId: null,
        entries: [
          expect.objectContaining({
            comment: expect.objectContaining({ id: "queued-comment-1" }),
          }),
        ],
      });
    });
  });

  it.each(["success", "dispatch", "forbidden", "network"] as const)(
    "discards a saved message before queue acknowledgement (%s)",
    async (outcome) => {
      const queue = createQueuedCommentQueue({ queueId: null, state: null });
      const comment = queue.entries[0].comment;
      mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1" }));
      mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
      mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
      mockIssuesApi.recentComments.mockResolvedValue({ comments: [comment], latestCommentId: comment.id, hasMore: false });
      mockIssuesApi.listComments.mockResolvedValue([comment]);
      const failure = outcome === "dispatch"
        ? new ApiError("The queued message is already being dispatched", 409, {
            details: { code: "queued_comment_already_dispatching" },
          })
        : outcome === "forbidden"
          ? new ApiError("Only the queued message author can discard it", 403, {})
          : new Error("Connection lost");
      if (outcome === "success") mockIssuesApi.cancelComment.mockResolvedValue(comment);
      else mockIssuesApi.cancelComment.mockRejectedValue(failure);

      await act(async () => { renderIssueView(); });
      const props = () => mockIssueChatThreadRender.mock.calls.at(-1)![0] as {
        queuedCommentQueue: IssueQueuedCommentQueue | null;
        comments: IssueComment[];
        onDiscardQueuedComment: (commentId: string, revision: string) => Promise<void>;
      };
      await waitForAssertion(() => {
        expect(props().queuedCommentQueue).toMatchObject({
          queueId: null,
          entries: [{ comment: { id: comment.id } }],
        });
      });
      let result: unknown;
      await act(async () => {
        result = await props().onDiscardQueuedComment(comment.id, queue.revision).catch((error: unknown) => error);
      });
      expect(mockIssuesApi.cancelComment).toHaveBeenCalledWith("issue-1", comment.id);
      expect(mockIssuesApi.discardQueuedComment).not.toHaveBeenCalled();
      if (outcome === "success") {
        expect(result).toBeUndefined();
        await waitForAssertion(() => {
          expect(props().queuedCommentQueue).toBeNull();
          expect(props().comments.some((value) => value.id === comment.id)).toBe(false);
        });
      } else {
        expect(result).toBe(failure);
        expect(props().queuedCommentQueue?.entries[0].comment.id).toBe(comment.id);
        expect(props().comments.some((value) => value.id === comment.id)).toBe(true);
        if (outcome === "dispatch") {
          expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Message is already being sent" }));
        }
      }
    },
  );

  it.each([true, false])("keeps a discarded queued comment out of the thread (expanded=%s)", async (expanded) => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], expanded);
    const queue = createQueuedCommentQueue();
    const emptyQueue = createQueuedCommentQueue({
      queueId: null,
      state: null,
      targetRunId: null,
      entries: [],
      revision: "queue-revision-2",
    });
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-active-1",
      }),
    );
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ adapterType: "paperclip_runner" }),
    ]);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [queue.entries[0].comment], latestCommentId: "queued-comment-1", hasMore: false });
    // Keep returning the pre-discard page to exercise the local projection
    // across the queueId -> null transition, as can happen during refetch.
    mockIssuesApi.listComments.mockResolvedValue([queue.entries[0].comment]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockIssuesApi.discardQueuedComment.mockResolvedValue(emptyQueue);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-active-1",
      runtimeMode: "native",
      status: "running",
      invocationSource: "issue",
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
      issueId: "issue-1",
    });

    await act(async () => {
      renderIssueView();
    });

    let discard!: (commentId: string, revision: string) => Promise<void>;
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<{ id: string }>;
        onDiscardQueuedComment?: typeof discard;
        queuedCommentQueue?: IssueQueuedCommentQueue | null;
      };
      expect(
        props.comments?.some((comment) => comment.id === "queued-comment-1"),
      ).toBe(true);
      expect(props.queuedCommentQueue?.queueId).toBe("wake-queue-1");
      expect(props.queuedCommentQueue?.entries).toHaveLength(1);
      discard = props.onDiscardQueuedComment!;
    });

    await act(async () => {
      await discard("queued-comment-1", queue.revision);
    });

    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
        comments?: Array<{ id: string }>;
        queuedCommentQueue?: IssueQueuedCommentQueue | null;
      };
      expect(props.queuedCommentQueue).toBeNull();
      expect(
        props.comments?.some((comment) => comment.id === "queued-comment-1"),
      ).toBe(false);
    });
  });

  it.each(["discard", "discard-unacknowledged", "cancel", "delete"] as const)("keeps %s responses in both comment caches after reopening by either task ref", async (action) => {
    const queue = createQueuedCommentQueue(action === "discard-unacknowledged" ? { queueId: null, state: null } : {});
    const comment = queue.entries[0].comment;
    const earlier = createIssueComment({ id: "earlier-comment", createdAt: new Date("2026-04-21T00:00:01.000Z") });
    const deleted = { ...comment, body: "", deletedAt: new Date() };
    const emptyQueue = createQueuedCommentQueue({ queueId: null, entries: [], targetRunId: null });
    const refs = ["PAP-1", "issue-1"];
    for (const ref of refs) {
      queryClient.setQueryData(["issues", "history-expanded", ref], false);
      queryClient.setQueryData([...queryKeys.issues.comments(ref), "recent"], {
        comments: [earlier, comment], latestCommentId: comment.id, hasMore: true,
      });
      queryClient.setQueryData(queryKeys.issues.comments(ref), { pages: [[comment, earlier]], pageParams: [null] });
      queryClient.setQueryData(queryKeys.issues.earlierComments(ref), { pages: [{ comments: [comment, earlier], nextCursor: earlier.id }], pageParams: [comment.id] });
      queryClient.setQueryData([...queryKeys.issues.comments(ref), "linked", comment.id], comment);
    }
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1" }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [earlier, comment], latestCommentId: comment.id, hasMore: true });
    await act(async () => renderIssueView());
    const props = () => mockIssueChatThreadRender.mock.calls.at(-1)![0];
    await waitForAssertion(() => {
      expect(props().comments.some((value: IssueComment) => value.id === comment.id)).toBe(true);
      expect(props().queuedCommentQueue?.queueId).toBe(queue.queueId);
    });
    const after = action === "delete" ? [earlier, deleted] : [earlier];
    mockIssuesApi.recentComments.mockResolvedValue({ comments: after, latestCommentId: after.at(-1)!.id, hasMore: true });
    mockIssuesApi.listComments.mockResolvedValue(after);
    mockIssuesApi.getQueuedComments.mockResolvedValue(emptyQueue);
    mockIssuesApi.discardQueuedComment.mockResolvedValue(emptyQueue);
    mockIssuesApi.cancelComment.mockResolvedValue(comment);
    mockIssuesApi.deleteComment.mockResolvedValue(deleted);
    let finishStaleRead!: (value: IssueRecentComments) => void;
    const staleRead = queryClient.fetchQuery({
      queryKey: [...queryKeys.issues.comments("PAP-1"), "recent"],
      queryFn: () => new Promise<IssueRecentComments>((resolve) => { finishStaleRead = resolve; }),
    }).catch(() => undefined);
    await act(async () => {
      if (action === "discard" || action === "discard-unacknowledged") await props().onDiscardQueuedComment(comment.id, queue.revision);
      if (action === "cancel") props().onCancelQueued(comment.id);
      if (action === "delete") await props().onDeleteComment(comment.id);
    });
    await waitForAssertion(() => expect(queryClient.isFetching({ queryKey: queryKeys.issues.comments("PAP-1") })).toBe(0));
    await act(async () => {
      finishStaleRead({ comments: [earlier, comment], latestCommentId: comment.id, hasMore: true });
      await staleRead;
    });
    for (const ref of refs) {
      const history = queryClient.getQueryData<{ pages: { comments: IssueComment[]; nextCursor: string }[] }>(queryKeys.issues.earlierComments(ref))!;
      expect(history.pages[0].nextCursor).toBe(earlier.id);
      expect(history.pages[0].comments.find(row => row.id === comment.id)).toEqual(action === "delete" ? deleted : undefined);
    }
    await waitForAssertion(() => {
      for (const ref of refs) {
        const recent = queryClient.getQueryData<IssueRecentComments>([...queryKeys.issues.comments(ref), "recent"]);
        expect(queryClient.getQueryData([...queryKeys.issues.comments(ref), "linked", comment.id])).toEqual(action === "delete" ? deleted : null);
        expect(recent?.comments).toEqual(after);
        expect(recent?.latestCommentId).toBe(after.at(-1)!.id);
        expect(queryClient.getQueryData<{ pages: IssueComment[][] }>(queryKeys.issues.comments(ref))?.pages.flat()).toEqual([...after].reverse());
      }
    });
    for (const ref of refs) {
      await act(async () => renderIssueView(null));
      mockRouteParams.issueId = ref;
      await act(async () => renderIssueView());
      await waitForAssertion(() => {
        const reopened = props().comments.find((value: IssueComment) => value.id === comment.id);
        if (action === "delete") expect(reopened).toMatchObject({ body: "", deletedAt: deleted.deletedAt });
        else expect(reopened).toBeUndefined();
      });
    }
  });

  it("uses queue identity for discard and surfaces a persistent too-late error", async () => {
    const queue = createQueuedCommentQueue();
    mockIssuesApi.get.mockResolvedValue(
      createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionRunId: "run-active-1",
      }),
    );
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ adapterType: "paperclip_runner" }),
    ]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockIssuesApi.discardQueuedComment.mockRejectedValue(
      new ApiError("The queued message is already being dispatched", 409, {
        details: { code: "queued_comment_already_dispatching" },
      }),
    );

    await act(async () => {
      renderIssueView();
    });
    let discard!: (commentId: string, revision: string) => Promise<void>;
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as
        | {
            onDiscardQueuedComment?: typeof discard;
            queuedCommentQueue?: IssueQueuedCommentQueue | null;
          }
        | undefined;
      expect(props?.onDiscardQueuedComment).toBeTypeOf("function");
      expect(props?.queuedCommentQueue?.queueId).toBe("wake-queue-1");
      discard = props!.onDiscardQueuedComment!;
    });

    await expect(discard("queued-comment-1", queue.revision)).rejects.toThrow(
      "already being dispatched",
    );
    expect(mockIssuesApi.discardQueuedComment).toHaveBeenCalledWith(
      "issue-1",
      "queued-comment-1",
      {
        queueId: "wake-queue-1",
        revision: "queue-revision-1",
      },
    );
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Message is already being sent",
        tone: "error",
        ttlMs: 15_000,
      }),
    );
  });
});

describe("canBoardResolveRecoveryAction", () => {
  it("falls back to companyIds when memberships are not populated", () => {
    expect(
      canBoardResolveRecoveryAction("company-1", {
        companyIds: ["company-1"],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
        keyId: null,
        user: null,
        userId: "user-1",
      }),
    ).toBe(true);
  });

  it("uses populated memberships as the authoritative board access source", () => {
    expect(
      canBoardResolveRecoveryAction("company-1", {
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "viewer",
            status: "active",
          },
        ],
        isInstanceAdmin: false,
        source: "session",
        keyId: null,
        user: null,
        userId: "user-1",
      }),
    ).toBe(false);
  });
});

describe("canBoardManageRuntime", () => {
  it("falls back to companyIds when memberships are not populated", () => {
    expect(
      canBoardManageRuntime("company-1", {
        companyIds: ["company-1"],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
        keyId: null,
        user: null,
        userId: "user-1",
      }),
    ).toBe(true);
  });

  it("denies viewers the runtime-manage-gated break-glass affordance", () => {
    expect(
      canBoardManageRuntime("company-1", {
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "viewer",
            status: "active",
          },
        ],
        isInstanceAdmin: false,
        source: "session",
        keyId: null,
        user: null,
        userId: "user-1",
      }),
    ).toBe(false);
  });

  it("allows non-viewer active members (mirrors the backend runtime:manage member gate)", () => {
    expect(
      canBoardManageRuntime("company-1", {
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "operator",
            status: "active",
          },
        ],
        isInstanceAdmin: false,
        source: "session",
        keyId: null,
        user: null,
        userId: "user-1",
      }),
    ).toBe(true);
  });
});

describe("readRecoveryReconcileWorkspaceId", () => {
  const makeAction = (
    evidence: Record<string, unknown>,
    kind = "workspace_validation",
  ) =>
    ({ kind, evidence }) as unknown as Parameters<
      typeof readRecoveryReconcileWorkspaceId
    >[0];

  it("returns null when the action is missing", () => {
    expect(readRecoveryReconcileWorkspaceId(null)).toBeNull();
    expect(readRecoveryReconcileWorkspaceId(undefined)).toBeNull();
  });

  it("returns null for non-workspace_validation actions even with a workspace id in evidence", () => {
    expect(
      readRecoveryReconcileWorkspaceId(
        makeAction(
          { workspaceValidation: { persistedExecutionWorkspaceId: "ws-1" } },
          "stranded_assigned_issue",
        ),
      ),
    ).toBeNull();
  });

  it("prefers persistedExecutionWorkspaceId (git_worktree_branch_incoherence shape)", () => {
    expect(
      readRecoveryReconcileWorkspaceId(
        makeAction({
          workspaceValidation: {
            reason: "git_worktree_branch_incoherence",
            persistedExecutionWorkspaceId: "ws-diverged",
            executionWorkspaceId: "ws-other",
          },
        }),
      ),
    ).toBe("ws-diverged");
  });

  it("falls back to executionWorkspaceId (git_worktree_not_reusable shape)", () => {
    expect(
      readRecoveryReconcileWorkspaceId(
        makeAction({
          workspaceValidation: {
            reason: "git_worktree_not_reusable",
            executionWorkspaceId: "ws-not-reusable",
          },
        }),
      ),
    ).toBe("ws-not-reusable");
  });

  it("returns null when the evidence carries no workspace reference (so the caller falls back to the page-level id)", () => {
    expect(readRecoveryReconcileWorkspaceId(makeAction({}))).toBeNull();
    expect(
      readRecoveryReconcileWorkspaceId(
        makeAction({
          workspaceValidation: { reason: "git_worktree_branch_incoherence" },
        }),
      ),
    ).toBeNull();
  });

  it("ignores non-string / empty workspace ids", () => {
    expect(
      readRecoveryReconcileWorkspaceId(
        makeAction({
          workspaceValidation: { persistedExecutionWorkspaceId: "" },
        }),
      ),
    ).toBeNull();
    expect(
      readRecoveryReconcileWorkspaceId(
        makeAction({
          workspaceValidation: { persistedExecutionWorkspaceId: 42 },
        }),
      ),
    ).toBeNull();
  });
});

describe("shouldScrollIssueDetailToTopOnNavigation", () => {
  it("does not scroll when only URL search params changed for the same issue", () => {
    expect(
      shouldScrollIssueDetailToTopOnNavigation({
        previousIssueId: "PAP-10306",
        nextIssueId: "PAP-10306",
        navigationType: NavigationType.Push,
      }),
    ).toBe(false);
  });

  it("scrolls on forward navigation to a different issue", () => {
    expect(
      shouldScrollIssueDetailToTopOnNavigation({
        previousIssueId: "PAP-1",
        nextIssueId: "PAP-2",
        navigationType: NavigationType.Push,
      }),
    ).toBe(true);
  });

  it("does not scroll on browser back or forward restoration", () => {
    expect(
      shouldScrollIssueDetailToTopOnNavigation({
        previousIssueId: "PAP-1",
        nextIssueId: "PAP-2",
        navigationType: NavigationType.Pop,
      }),
    ).toBe(false);
  });
});
