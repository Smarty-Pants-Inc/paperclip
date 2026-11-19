// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTaskHandoff, Issue, IssueDocument, IssueThreadInteraction } from "@paperclipai/shared";
import { TaskChatThread } from "./TaskChatThread";
import { CoordinatorPresentation } from "./coordinator/CoordinatorPresentation";
import { ThemeProvider } from "@/context/ThemeContext";
import { pendingSuggestedTasksInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import type { TranscriptEntry } from "@/adapters";
import type { LiveRunForIssue } from "@/api/heartbeats";
import type { IssueChatLinkedRun } from "@/lib/issue-chat-messages";

const state = vi.hoisted(() => ({
  coordinator: true,
  transcripts: new Map<string, TranscriptEntry[]>(),
  handoffs: [] as ConversationTaskHandoff[],
  plan: null as IssueDocument | null,
}));
vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), isInitialHydrating: false }),
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: () => ({ transcriptByRun: new Map(state.transcripts), errorsByRun: new Map(),
    terminalHydratedRunIds: new Set(state.transcripts.keys()) }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: state.plan }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: state.coordinator, loaded: true, userId: "viewer" }),
}));
vi.mock("@/components/coordinator/CoordinatorChatTaskHandoffs", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/coordinator/CoordinatorChatTaskHandoffs")>(),
  useCoordinatorChatTaskHandoffs: () => ({ handoffs: state.coordinator ? state.handoffs : [], isSuccess: true, enabled: state.coordinator }),
}));
vi.mock("@/components/coordinator/CoordinatorChatDecisionReceipts", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/coordinator/CoordinatorChatDecisionReceipts")>(),
  useCoordinatorChatDecisionReceipts: () => ({ receipts: [], enabled: false }),
}));
vi.mock("@/components/coordinator/CoordinatorChatPendingQuestions", () => ({
  useCoordinatorChatPendingQuestions: () => ({ questions: [], enabled: false }),
  CoordinatorChatQuestionStatus: () => null,
}));
vi.mock("@/api/issues", async importOriginal => ({
  ...await importOriginal<typeof import("@/api/issues")>(),
  issuesApi: { summaries: vi.fn(async () => []) },
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues/chat", hash: "", search: "", key: "test", state: null }),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor({ value }: { value: string }, ref: ForwardedRef<unknown>) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {} }));
    return <div>{value}</div>;
  }),
}));


import type { IssueRecoveryAction } from "@paperclipai/shared";
import fixture from "./__fixtures__/withheld-reply-thread.json";

// RENDERED-THREAD row (rf-5 C2). The fixture is the REAL thread: the server row
// "RENDERED-THREAD source" (server native-withheld-reply.test.ts) asserts that
// GET /api/issues/:id/comments and GET /api/issues/:id, after the real finalizer
// and worker published a withheld reply, equal this file. Here the person's
// thread renders it: the reply and its file line are shown, and the recovery
// card beside it offers no operator step the person cannot take.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const at = (second: number) => `2026-11-18T12:00:${String(second).padStart(2, "0")}Z`;
const FILE_LINE_LOST = "The file changes from this reply couldn't be saved.";
const run: IssueChatLinkedRun = {
  runId: "answer-run", status: "failed", runtimeMode: "native", adapterType: "paperclip_runner",
  agentId: "agent", agentName: "Worker", createdAt: at(1), startedAt: at(1), finishedAt: at(10),
};
// The GET lists newest first; the thread orders by time.
const comments = [...fixture.comments].reverse().map((comment, index) => ({
  id: `comment-${index}`, body: comment.body, companyId: "company", issueId: "task",
  authorType: comment.authorType as "agent" | "user", authorAgentId: comment.authorType === "agent" ? "agent" : null,
  authorUserId: comment.authorType === "user" ? "viewer" : null, runId: comment.byRun ? "answer-run" : undefined,
  createdByRunId: comment.byRun ? "answer-run" : null, presentation: null, metadata: null,
  createdAt: new Date(at(index * 20)), updatedAt: new Date(at(index * 20)),
}));
const recoveryAction = {
  id: "action", companyId: "company", sourceIssueId: "task", recoveryIssueId: null, ownerAgentId: null, ownerUserId: null,
  previousOwnerAgentId: "agent", returnOwnerAgentId: "agent", fingerprint: "fingerprint", evidence: { runId: "answer-run" },
  wakePolicy: null, monitorPolicy: null, attemptCount: 0, maxAttempts: 3, timeoutAt: null, lastAttemptAt: null, outcome: null,
  resolutionNote: null, resolvedAt: null, createdAt: at(10), updatedAt: at(10), ...fixture.recoveryAction,
} as IssueRecoveryAction;

beforeEach(() => {
  state.coordinator = false; state.handoffs = []; state.plan = null; state.transcripts.clear();
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); client.clear(); vi.restoreAllMocks(); });
async function paint(overrides: Partial<React.ComponentProps<typeof TaskChatThread>> = {}) {
  await act(() => root.render(<QueryClientProvider client={client}><ThemeProvider>
    <CoordinatorPresentation value={state.coordinator}>
      <TaskChatThread issueId="task" companyId="company" currentUserId="viewer" comments={comments} linkedRuns={[run]}
        issueStatus={fixture.issueStatus} recoveryAction={recoveryAction} onAdd={async () => {}} {...overrides} />
    </CoordinatorPresentation>
  </ThemeProvider></QueryClientProvider>));
}

describe("withheld accepted reply in the person's thread", () => {
  it("is the real published thread: one agent reply that ends with the file line, after the person's message", () => {
    expect(fixture.comments.filter(comment => comment.authorType === "agent")).toHaveLength(1);
    expect(fixture.comments.find(comment => comment.authorType === "agent")!.body.endsWith(`\n\n${FILE_LINE_LOST}`)).toBe(true);
    expect(fixture.recoveryAction).toMatchObject({ cause: "native_workspace_sync_out_unrecoverable", ownerType: "board", status: "active" });
    expect(fixture.issueStatus).toBe("blocked");
  });

  it.each([["the task thread", {}], ["the chat thread", { conversationMode: true }]] as const)(
    "%s shows the reply and its file line, and the card beside it gives no false next step", async (_name, mode) => {
      await paint(mode);
      const text = host.textContent ?? "";
      expect(text).toContain("Please rename the helper.");
      expect(text).toContain("I renamed the helper and updated its two callers.");
      expect(text).toContain(FILE_LINE_LOST);
      expect(text.split(FILE_LINE_LOST)).toHaveLength(2);
      // The card is beside the reply (not hidden to make this pass).
      const card = host.querySelector('[data-testid="task-chat-recovery-action-card"]');
      expect(card?.textContent).toContain("Board");
      if (process.env.WH_RENDER_DUMP) (await import("node:fs")).writeFileSync(`${process.env.WH_RENDER_DUMP}.${mode && "conversationMode" in mode ? "chat" : "task"}.txt`, `${text}\n`);
      // The operator's next action is true for an operator, and a false next
      // step for the person: it must not be rendered anywhere on the thread.
      expect(fixture.recoveryAction.nextAction).toMatch(/sandbox/i);
      expect(text).not.toContain(fixture.recoveryAction.nextAction);
      expect(text).not.toMatch(/restore (a|the|the exact) sandbox/i);
      expect(text).not.toMatch(/resolve the task manually/i);
      expect(text).not.toContain("Next action");
      // No Retry or recovery button is offered here either: the box is gone.
      expect([...host.querySelectorAll("button")].map(button => button.textContent ?? "")
        .filter(label => /retry|try again|recover|restore/i.test(label))).toEqual([]);
    });
});
