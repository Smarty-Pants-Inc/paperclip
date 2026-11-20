// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueRecoveryAction } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { getIssueDetailQueryOptions } from "@/lib/issueDetailCache";
import { queryKeys } from "@/lib/queryKeys";
import { __liveUpdatesTestUtils as live } from "@/context/LiveUpdatesProvider";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThread } from "./TaskChatThread";

const state = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), isInitialHydrating: false }),
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: () => ({ transcriptByRun: new Map(), errorsByRun: new Map(), terminalHydratedRunIds: new Set() }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: state.mobile }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true, userId: "viewer" }),
}));
vi.mock("@/api/issues", async original => ({ ...await original<typeof import("@/api/issues")>(),
  issuesApi: { get: vi.fn(), summaries: vi.fn(async () => []) },
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues/REC-649", hash: "", search: "", key: "test", state: null }),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function Editor(_props, ref) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {} }));
    return <div data-testid="mounted-composer" />;
  }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const action: IssueRecoveryAction = {
  id: "recovery-1", companyId: "company", sourceIssueId: "issue-1",
  kind: "active_run_watchdog", status: "escalated", ownerType: "board", cause: "execution_stop_pending",
  nextAction: "This recovery needs a human decision before work can continue.", evidence: {},
  attemptCount: 1, maxAttempts: 1,
} as IssueRecoveryAction;
const open = {
  id: action.sourceIssueId, identifier: "REC-649", companyId: "company", title: "Existing chat task",
  status: "in_progress", workMode: "standard", priority: "medium", projectId: null, parentId: null,
  description: null, assigneeAgentId: "agent", assigneeUserId: null, executionRunId: null, issueNumber: 649,
  requestDepth: 0, createdAt: new Date(), updatedAt: new Date(), activeRecoveryAction: action,
  executionBlocker: { cause: "execution_stop_pending", canRetry: false },
} as Issue;
const comments = [{ id: "reply", companyId: "company", issueId: open.id, authorType: "agent" as const,
  authorAgentId: "agent", authorUserId: null, body: "Here is the posted answer.", presentation: null, metadata: null,
  createdAt: new Date(), updatedAt: new Date() }];
let client: QueryClient, root: Root, host: HTMLDivElement;
function Page() {
  // The actual query options and card prop used by IssueDetail, not a local hide flag.
  const { data } = useQuery(getIssueDetailQueryOptions(client, "REC-649"));
  return <TaskChatThread issueId={open.id} companyId="company" currentUserId="viewer" comments={comments}
    issueStatus={data?.status} recoveryAction={data?.activeRecoveryAction} onAdd={async () => {}} />;
}
async function settle(ms = 1) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount(width: number) {
  state.mobile = width < 768;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  await act(async () => root.render(<QueryClientProvider client={client}><ThemeProvider><Page /></ThemeProvider></QueryClientProvider>));
  await settle(); await settle();
  expect(host.querySelector('[data-testid="task-chat-recovery-action-card"]')?.textContent).toContain("RECOVERY ESCALATED");
  expect(host.textContent).toContain("Here is the posted answer.");
  return host.querySelector('[data-testid="mounted-composer"]');
}
async function activity(name: string, details?: Record<string, unknown>) {
  await act(async () => live.invalidateActivityQueries(client, "company", {
    entityType: "issue", entityId: open.id, actorType: "system", actorId: "recovery", action: name, details,
  }, { userId: "viewer", agentId: null }, { pathname: "/issues/REC-649", isForegrounded: true }));
  await settle(); await settle();
}
function expectGone(composer: Element | null) {
  expect(host.querySelector('[data-testid="task-chat-recovery-action-card"]')).toBeNull();
  expect(host.querySelector('[data-testid="mounted-composer"]')).toBe(composer);
  expect(composer).not.toBeNull();
  expect(host.textContent).toContain("Here is the posted answer.");
  expect(client.getQueryData<Issue>(queryKeys.issues.detail("REC-649"))?.executionBlocker).toBeNull();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.issues.detail("REC-649"), open);
  client.setQueryData(queryKeys.auth.session, { user: { id: "viewer" } });
  vi.mocked(issuesApi.get).mockReset().mockResolvedValue({ ...open, activeRecoveryAction: null, executionBlocker: null });
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); vi.restoreAllMocks(); vi.useRealTimers();
});
for (const width of [390, 1440]) describe(`recovery card live at ${width}`, () => {
  it.each([
    ["issue.updated", undefined],
    ["issue.comment_added", { commentId: "reply" }],
    ["issue.execution_stop_confirmed", undefined],
    ["issue.execution_stop_pending_resolved", undefined],
    ["issue.recovery_action_resolved", undefined],
  ] as const)("removes a server-cleared card on %s without remounting", async (name, details) => {
    const composer = await mount(width);
    await activity(name, details);
    expectGone(composer);
  });
  it.each(["cancelled", "resolved"] as const)("removes a card returned as %s, not just an absent action", async status => {
    const composer = await mount(width);
    vi.mocked(issuesApi.get).mockResolvedValue({ ...open, activeRecoveryAction: { ...action, status }, executionBlocker: null });
    await activity("issue.comment_added", { commentId: "reply" });
    expectGone(composer);
    vi.mocked(issuesApi.get).mockClear();
    await settle(10_001);
    expect(issuesApi.get).not.toHaveBeenCalled();
  });
  it("retains ordinary visible-update deferral and no polling after the card clears", async () => {
    const composer = await mount(width);
    await activity("issue.execution_stop_confirmed");
    expectGone(composer);
    vi.mocked(issuesApi.get).mockClear().mockResolvedValue(open);
    await activity("issue.updated");
    await settle(10_001);
    expect(issuesApi.get).not.toHaveBeenCalled();
    expectGone(composer);
  });
  it("keeps a still-open recovery, including after reply activity and the backstop", async () => {
    vi.mocked(issuesApi.get).mockResolvedValue(open);
    await mount(width);
    await activity("issue.comment_added", { commentId: "reply" });
    await settle(10_001); await settle();
    expect(issuesApi.get).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="task-chat-recovery-action-card"]')).not.toBeNull();
  });
  it("rechecks while visible when cancellation commits after the last event, then stops polling", async () => {
    const composer = await mount(width);
    await settle(10_001); await settle();
    expectGone(composer);
    vi.mocked(issuesApi.get).mockClear();
    await settle(30_000); await settle();
    expect(issuesApi.get).not.toHaveBeenCalled();
  });
  it("does not refetch a different issue or remove a live hold on unrelated activity", async () => {
    await mount(width);
    await act(async () => live.invalidateActivityQueries(client, "company", {
      entityType: "issue", entityId: "other-issue", action: "issue.updated", actorType: "system",
    }, { userId: "viewer", agentId: null }, { pathname: "/issues/REC-649", isForegrounded: true }));
    await settle();
    expect(issuesApi.get).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="task-chat-recovery-action-card"]')).not.toBeNull();
  });
});
