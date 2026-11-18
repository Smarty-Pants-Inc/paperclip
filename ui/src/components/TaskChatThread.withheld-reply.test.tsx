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
  mobile: false,
  inspect: null as unknown,
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
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: state.mobile }) }));
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
  issuesApi: { summaries: vi.fn(async () => []), recoveryActions: vi.fn(async () => state.inspect) },
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


import { FILE_LINE_KEPT, FILE_LINE_KEPT_NO_BUTTON, FILE_LINE_LOST, FILE_LINE_NOT_SAVED_YET, FILE_LINE_SAVING,
  type IssueRecoveryAction } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { WORKSPACE_CHANGES_NOT_SAVED, WORKSPACE_CHANGES_NOT_SAVED_STATUS, WorkspaceExportRecovery } from "./WorkspaceExportRecovery";
import lost from "./__fixtures__/withheld-reply-thread.json";
import kept from "./__fixtures__/withheld-reply-kept-thread.json";
import saving from "./__fixtures__/withheld-reply-saving-thread.json";

// RENDERED rows (rf-5 C2). Each fixture is the REAL state: the server rows
// "RENDERED source, LOST / KEPT / SAVING" (server native-withheld-reply.test.ts)
// assert that GET /api/issues/:id/comments, GET /api/issues/:id/runs, GET
// /api/issues/:id and the saved-files source inspection, after the real
// finalizer and worker ran, equal these files (ids and times removed).
// Here the page renders them the way IssueDetail.tsx does: the top status
// panel (WorkspaceExportRecovery) above the person's thread (TaskChatThread).
// Widths: jsdom has no layout engine. "390" and "1440" set window.innerWidth,
// every matchMedia width query, and the app's own mobile switch (useSidebar).
// PLANTED states are named "PLANTED" in their row and sit beside a real row.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Fixture = typeof lost | typeof kept | typeof saving;
type FileLineState = { state: string; deadlineAt?: string | null } | null;
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const T0 = Date.parse("2026-11-18T12:00:00Z");
const at = (second: number) => new Date(T0 + second * 1000).toISOString();
const ANSWER_START = "I renamed the helper and updated its two callers.";
const WIDTHS = [390, 1440] as const;

function setWidth(width: number) {
  state.mobile = width < 768;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.matchMedia = vi.fn((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query), min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: Boolean((max || min) && (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]))), media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() };
  }) as never;
}
/** The props the page builds from the real GETs. `fileLine` overrides the served state (named where used). */
function page(fixture: Fixture, options: { fileLine?: FileLineState; workspaceRecovery?: Record<string, unknown>;
  systemRecovery?: Record<string, unknown> } = {}) {
  // The GET lists newest first; the thread orders by time.
  const comments = [...fixture.comments].reverse().map((comment, index) => ({
    id: `comment-${index}`, body: comment.body, companyId: "company", issueId: "task",
    authorType: comment.authorType as "agent" | "user", authorAgentId: comment.authorType === "agent" ? "agent" : null,
    authorUserId: comment.authorType === "user" ? "viewer" : null, runId: comment.byRun ? "answer-run" : undefined,
    createdByRunId: comment.byRun ? "answer-run" : null, presentation: null, metadata: null,
    createdAt: new Date(at(index * 20)), updatedAt: new Date(at(index * 20)),
  }));
  const reply = comments.find(comment => comment.authorType === "agent")!;
  const served = fixture.run.replyFileLine;
  const fileLine: FileLineState = options.fileLine !== undefined ? options.fileLine : served && { state: served.state,
    deadlineAt: served.deadlineAfterAcceptanceMs === null ? null : new Date(T0 + served.deadlineAfterAcceptanceMs).toISOString() };
  const live = fixture.run.status === "running" || fixture.run.status === "queued";
  const resultJson = fileLine ? { replyFileLine: { commentId: reply.id, ...fileLine } } : null;
  const run: IssueChatLinkedRun = { runId: "answer-run", status: fixture.run.status, runtimeMode: "native", adapterType: "paperclip_runner",
    agentId: "agent", agentName: "Worker", createdAt: at(1), startedAt: at(1), finishedAt: live ? null : at(10), resultJson };
  const liveRun: LiveRunForIssue = { id: "answer-run", status: fixture.run.status, runtimeMode: "native", adapterType: "paperclip_runner",
    agentId: "agent", agentName: "Worker", createdAt: at(1), startedAt: at(1), finishedAt: null, invocationSource: "assignment",
    triggerDetail: null, issueId: "task" };
  const source = fixture.recoveryAction;
  const recoveryAction = source ? {
    id: "action", companyId: "company", sourceIssueId: "task", recoveryIssueId: null, ownerAgentId: null, ownerUserId: null,
    previousOwnerAgentId: "agent", returnOwnerAgentId: "agent", fingerprint: "fingerprint", wakePolicy: null, monitorPolicy: null,
    attemptCount: 0, maxAttempts: 3, timeoutAt: null, lastAttemptAt: null, outcome: null, resolutionNote: null, resolvedAt: null,
    createdAt: at(10), updatedAt: at(10), kind: source.kind, status: source.status, ownerType: source.ownerType, cause: source.cause,
    nextAction: source.nextAction,
    evidence: { runId: "answer-run", ...(options.workspaceRecovery ? { workspaceRecovery: options.workspaceRecovery } : {}),
      ...(options.systemRecovery ? { systemRecovery: options.systemRecovery } : {}) },
  } as unknown as IssueRecoveryAction : null;
  state.inspect = recoveryAction ? { active: recoveryAction, actions: [recoveryAction], sourceInspection: {
    schema: "paperclip.workspace-source-inspection.v1", actionId: "action", runId: "answer-run",
    status: source!.sourceInspection, scope: "recorded_source_identity", observedAt: at(11) } } : null;
  return { comments, reply, run, liveRun, live, recoveryAction, issueStatus: fixture.issueStatus };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
/** The page: the top status panel above the thread, as ui/src/pages/IssueDetail.tsx:8353 mounts them. */
async function paint(view: ReturnType<typeof page>, overrides: Partial<React.ComponentProps<typeof TaskChatThread>> = {}) {
  await act(() => root.render(<QueryClientProvider client={client}><ThemeProvider>
    <div data-testid="top-status"><WorkspaceExportRecovery issueId="task" companyId="company" action={view.recoveryAction} /></div>
    <CoordinatorPresentation value={state.coordinator}>
      <div data-testid="thread"><TaskChatThread issueId="task" companyId="company" currentUserId="viewer" comments={view.comments}
        linkedRuns={[view.run]} liveRuns={view.live ? [view.liveRun] : []} activeRun={view.live ? view.liveRun : undefined}
        issueStatus={view.issueStatus} recoveryAction={view.recoveryAction} onAdd={async () => {}} {...overrides} /></div>
    </CoordinatorPresentation>
  </ThemeProvider></QueryClientProvider>));
  await settle(); await settle();
}
const text = (testId?: string) => (testId ? host.querySelector(`[data-testid="${testId}"]`) : host)?.textContent ?? "";
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const buttons = (testId: string) => [...host.querySelectorAll(`[data-testid="${testId}"] button`)].map(button => button.textContent ?? "");
const FILE_LINES = [FILE_LINE_LOST, FILE_LINE_KEPT, FILE_LINE_KEPT_NO_BUTTON, FILE_LINE_SAVING, FILE_LINE_NOT_SAVED_YET];
/** How many file lines the page shows, of any kind (KEPT_NO_BUTTON starts with NOT_SAVED_YET's words: counted once). */
function fileLineCount() {
  const all = text();
  return count(all, FILE_LINE_LOST) + count(all, FILE_LINE_KEPT) + count(all, FILE_LINE_SAVING)
    + count(all, FILE_LINE_NOT_SAVED_YET.replace(/\.$/, ""));
}
function dump(name: string, width: number) {
  if (!process.env.WH_RENDER_DUMP) return;
  const rendered = `WIDTH: ${width}\nTOP STATUS: ${text("top-status")}\nTOP BUTTONS: ${JSON.stringify(buttons("top-status"))}\nTHREAD: ${text("thread")}\n`;
  void import("node:fs").then(fs => fs.writeFileSync(`${process.env.WH_RENDER_DUMP}.${name}.${width}.txt`, rendered));
}
/** True of every rendered row: the reply once, and no step the person cannot take. */
function expectReplyOnceAndNoFalseStep(view: ReturnType<typeof page>) {
  const all = text();
  expect(all).toContain("Please rename the helper.");
  expect(count(all, ANSWER_START)).toBe(1);
  expect(all).not.toMatch(/restore\b.*\bsandbox/i);
  expect(all).not.toMatch(/retained sandbox/i);
  if (view.recoveryAction?.nextAction) expect(all).not.toContain(view.recoveryAction.nextAction);
  expect(text("thread")).not.toContain("Next action");
}

beforeEach(() => {
  state.coordinator = false; state.handoffs = []; state.plan = null; state.transcripts.clear(); state.inspect = null;
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // The board user this page is open for (the same two reads the page makes).
  client.setQueryData(queryKeys.auth.session, { user: { id: "viewer" } });
  client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "viewer", companyIds: ["company"], source: "session",
    isInstanceAdmin: false, memberships: [{ companyId: "company", membershipRole: "owner", status: "active" }] });
  setWidth(1440);
});
afterEach(async () => { vi.useRealTimers(); await act(() => root.unmount()); host.remove(); client.clear(); vi.restoreAllMocks(); });

describe("withheld accepted reply: the real published state, rendered", () => {
  it("the fixtures are the real threads: one agent reply whose body is the answer alone; the file line is state", () => {
    for (const fixture of [lost, kept, saving]) {
      const replies = fixture.comments.filter(comment => comment.authorType === "agent");
      expect(replies).toHaveLength(1);
      for (const line of FILE_LINES) expect(replies[0].body).not.toContain(line);
      expect(fixture.run.replyFileLine?.onTheReply).toBe(true);
    }
    expect(lost.recoveryAction).toMatchObject({ cause: "native_workspace_sync_out_unrecoverable", ownerType: "board", status: "active" });
    expect(lost.run).toMatchObject({ status: "failed", replyFileLine: { state: "lost" } });
    expect(kept.recoveryAction).toMatchObject({ cause: "native_workspace_sync_out_retry_exhausted" });
    expect(kept.run).toMatchObject({ status: "failed", replyFileLine: { state: "kept" } });
    expect(saving.run).toEqual({ status: "running", replyFileLine: { onTheReply: true, state: "saving", deadlineAfterAcceptanceMs: 600_000 } });
  });

  // The page passes the board's handlers; the card then offers its resolve menu.
  const board = { onResolveRecoveryAction: async () => {}, canFalsePositiveRecoveryAction: true };
  describe.each(WIDTHS)("at %i px", width => {
    beforeEach(() => setWidth(width));

    it.each([["task", {}], ["chat", { conversationMode: true }], ["board", board]] as const)(
      "LOST (real), %s thread: the reply once, the LOST line once, no false next step, and the top line asks for nothing the person cannot do", async (name, mode) => {
        const view = page(lost);
        await paint(view, mode);
        dump(`lost-${name}`, width);
        expectReplyOnceAndNoFalseStep(view);
        expect(count(text("thread"), FILE_LINE_LOST)).toBe(1);
        expect(fileLineCount()).toBe(1);
        // The card is beside the reply (not hidden to make this pass).
        expect(host.querySelector('[data-testid="task-chat-recovery-action-card"]')?.textContent).toContain("Board");
        expect(text()).not.toMatch(/resolve the task manually/i);
        // No Retry or recovery button is offered in the thread: the box is gone.
        expect(buttons("thread").filter(label => /retry|try again|recover|restore/i.test(label))).toEqual([]);
        // The top line: the box is gone, so nothing is or will be "recovered" from it, and it must not
        // say the files "need recovery before work can continue" while it offers no way to recover them.
        const top = host.querySelector('[data-testid="top-status"] [role="status"]')?.textContent ?? "";
        expect(top).toBe(WORKSPACE_CHANGES_NOT_SAVED);
        expect(buttons("top-status")).not.toContain("Recover saved files");
        expect(text()).not.toMatch(/need recovery before work can continue/i);
        expect(top).not.toMatch(/recovered/i);
        expect(text()).not.toContain("Working");
      });

    it("LOST, PLANTED (the recorded recovery says recovered + complete): the top line never says 'recovered'", async () => {
      // PLANTED: workspaceRecovery/systemRecovery in the shape WorkspaceExportRecovery.control.test.tsx uses for `saved`.
      // Beside the real LOST row above, whose real evidence carries neither.
      const view = page(lost, { workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: "answer-run", status: "recovered",
        requestIds: [] }, systemRecovery: { state: "complete", preservationOperationIds: ["operation-1"] } });
      await paint(view);
      dump("lost-planted-recovered", width);
      const top = host.querySelector('[data-testid="top-status"] [role="status"]')?.textContent ?? "";
      expect(top).toBe(WORKSPACE_CHANGES_NOT_SAVED_STATUS);
      expect(top).toBe("This run could not save its workspace changes. Task recovery is still being checked.");
      expect(text("top-status")).not.toMatch(/recovered/i);
      expectReplyOnceAndNoFalseStep(view);
      expect(fileLineCount()).toBe(1);
    });

    it("the control for that sentence: the same PLANTED recovered state for the KEPT cause still says 'Saved files recovered'", async () => {
      const view = page(kept, { workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: "answer-run", status: "recovered",
        requestIds: [] }, systemRecovery: { state: "complete", preservationOperationIds: ["operation-1"] } });
      await paint(view);
      expect(host.querySelector('[data-testid="top-status"] [role="status"]')?.textContent)
        .toBe("Saved files recovered. Task recovery is still being checked.");
    });

    it("KEPT (real): the reply once and one KEPT line; without the Recover saved files button it promises no button", async () => {
      const view = page(kept);
      await paint(view);
      dump("kept", width);
      expectReplyOnceAndNoFalseStep(view);
      // The real state straight after the failure: the panel shows no "Recover saved files" button yet.
      expect(buttons("top-status")).not.toContain("Recover saved files");
      expect(count(text("thread"), FILE_LINE_KEPT_NO_BUTTON)).toBe(1);
      expect(text()).not.toContain(FILE_LINE_KEPT);
      expect(fileLineCount()).toBe(1);
      expect(text()).not.toContain("Working");
    });

    it("KEPT, PLANTED (recovery blocked + retryable, so the button is shown): the line names the saved files, once", async () => {
      // PLANTED: the state system recovery writes later (WorkspaceExportRecovery.control.test.tsx's own shape). Beside the real KEPT row above.
      const view = page(kept, { workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: "answer-run", status: "blocked",
        stage: "restoring_files", attempt: 6, requestIds: [], retryable: true }, systemRecovery: { state: "exhausted", preservationOperationIds: [] } });
      await paint(view);
      dump("kept-planted-button", width);
      expect(buttons("top-status")).toContain("Recover saved files");
      expect(count(text("thread"), FILE_LINE_KEPT)).toBe(1);
      expect(text()).not.toContain(FILE_LINE_KEPT_NO_BUTTON);
      expect(fileLineCount()).toBe(1);
      expectReplyOnceAndNoFalseStep(view);
    });

    it("SAVING (real, published at acceptance): the reply once with 'Saving…', and the still-running turn no longer shows 'Working'", async () => {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0 + 5_000);
      const view = page(saving);
      expect(view.live).toBe(true);
      await paint(view);
      dump("saving", width);
      expectReplyOnceAndNoFalseStep(view);
      expect(count(text("thread"), FILE_LINE_SAVING)).toBe(1);
      expect(fileLineCount()).toBe(1);
      expect(text()).not.toContain("Working");
      expect(host.querySelector('[data-testid="task-chat-live-transcript"]')).toBeNull();
    });

    it("the control for 'Working': the same running run with no presented reply still shows 'Working'", async () => {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0 + 5_000);
      const view = page(saving, { fileLine: null });
      await paint({ ...view, comments: view.comments.filter(comment => comment.authorType !== "agent") });
      expect(text()).toContain("Working");
      expect(fileLineCount()).toBe(0);
    });

    it("SAVING -> SAVED (the healthy commit): the line shows, then clears; the reply is still there once", async () => {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0 + 5_000);
      await paint(page(saving));
      expect(count(text("thread"), FILE_LINE_SAVING)).toBe(1);
      // The served state after the commit, as the server row A1 reads it from the real GET: { commentId, state: "saved" }.
      const committed = page({ ...saving, issueStatus: "in_review", run: { ...saving.run, status: "succeeded" } } as Fixture, { fileLine: { state: "saved" } });
      await paint(committed);
      dump("saving-then-saved", width);
      expectReplyOnceAndNoFalseStep(committed);
      expect(fileLineCount()).toBe(0);
      expect(text()).not.toContain("Working");
    });

    it("SAVING -> LOST / KEPT (the terminal write): the same reply, the settled line once", async () => {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0 + 5_000);
      await paint(page(saving));
      expect(count(text("thread"), FILE_LINE_SAVING)).toBe(1);
      await paint(page(lost));
      expect(count(text("thread"), FILE_LINE_LOST)).toBe(1);
      expect(fileLineCount()).toBe(1);
      await paint(page(kept));
      expect(count(text("thread"), FILE_LINE_KEPT_NO_BUTTON)).toBe(1);
      expect(fileLineCount()).toBe(1);
      expect(count(text(), ANSWER_START)).toBe(1);
    });

    it("SAVING past its deadline (FAKE CLOCK, for the deadline only): never stays 'Saving…'; it says the files aren't saved yet", async () => {
      // FAKE CLOCK (named): Date and the timer that fires at the deadline. Nothing else is faked.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(T0 + 5_000);
      const view = page(saving);
      await act(() => root.render(<QueryClientProvider client={client}><ThemeProvider><CoordinatorPresentation value={state.coordinator}>
        <div data-testid="thread"><TaskChatThread issueId="task" companyId="company" currentUserId="viewer" comments={view.comments}
          linkedRuns={[view.run]} liveRuns={[view.liveRun]} activeRun={view.liveRun} issueStatus={view.issueStatus} onAdd={async () => {}} /></div>
      </CoordinatorPresentation></ThemeProvider></QueryClientProvider>));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(count(text("thread"), FILE_LINE_SAVING)).toBe(1);
      // One second before the deadline (acceptance + 10 min) it still says Saving…
      await act(async () => { await vi.advanceTimersByTimeAsync(600_000 - 5_000 - 1_000 - 1_000); });
      expect(count(text("thread"), FILE_LINE_SAVING)).toBe(1);
      // …and with no new data from the server, at the deadline it stops.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
      dump("saving-past-deadline", width);
      expect(text()).not.toContain(FILE_LINE_SAVING);
      expect(count(text("thread"), FILE_LINE_NOT_SAVED_YET)).toBe(1);
      expect(fileLineCount()).toBe(1);
      expect(count(text(), ANSWER_START)).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(24 * 3_600_000); });
      expect(text()).not.toContain(FILE_LINE_SAVING);
      expect(count(text("thread"), FILE_LINE_NOT_SAVED_YET)).toBe(1);
    });
  });
});
