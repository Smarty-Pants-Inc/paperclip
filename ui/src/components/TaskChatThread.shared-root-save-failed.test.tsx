// @vitest-environment jsdom
import { act, forwardRef, Profiler, useImperativeHandle, type ForwardedRef } from "react";
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



import type { IssueQueuedCommentQueue, IssueRecoveryAction, TaskInterruptionPresentation } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { WorkspaceExportRecovery } from "./WorkspaceExportRecovery";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";
import { writeFileSync } from "node:fs";
import { readSavedMessageWait } from "@/lib/saved-message-wait";
import fixtures from "./__fixtures__/shared-root-save-failed.json";

// RENDERED rows (d2shared3): a task on a SHARED project checkout whose reply's save failed for good while the person's
// next message M was parked. Every fixture is the REAL state: the bodies of GET /api/issues/:id, .../comments, .../runs
// and .../queued-comments, read by server row native-shared-root-save-failed.test.ts after the real finalizer and the
// real workers ran at the d2shared3 head (built by mkfixture.py of the d2shared3 report from the row's probe output,
// D2SHARED_PROBE_DIR; only host paths replaced). PLANTED states are named in each fixture's `source`.
// Mounted as ui/src/pages/IssueDetail.tsx mounts them: the saved-work panel, the task's status notice, the thread with
// its recovery card and queued messages. Widths as TaskChatThread.withheld-reply.test.tsx: jsdom has no layout engine.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Fixture = (typeof fixtures)[keyof typeof fixtures];
let host: HTMLDivElement, root: Root, client: QueryClient;
const WIDTHS = [390, 1440] as const;
const M = "Also add a summary section to the report.";
const ANSWER = "Done. I rewrote the report and added the notes file.";
const LOST = "The file changes from this reply couldn't be saved.";
const onContinue = vi.fn();

function setWidth(width: number) {
  state.mobile = width < 768;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.matchMedia = vi.fn((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query), min = /min-width:\s*(\d+)px/.exec(query);
    return { matches: Boolean((max || min) && (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]))), media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() };
  }) as never;
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function paint(fixture: Fixture) {
  const issue = fixture.issue;
  const comments = [...fixture.comments].reverse().map(comment => ({ id: comment.id, body: comment.body, companyId: issue.companyId, issueId: issue.id,
    authorType: comment.authorType as "agent" | "user" | "system", authorAgentId: comment.authorType === "agent" ? "agent" : null,
    authorUserId: comment.authorType === "user" ? "viewer" : null, runId: comment.createdByRunId ?? undefined, createdByRunId: comment.createdByRunId,
    presentation: null, metadata: null, createdAt: new Date(comment.createdAt), updatedAt: new Date(comment.createdAt) }));
  const linkedRuns: IssueChatLinkedRun[] = fixture.runs.map(run => ({ runId: run.runId, status: run.status, runtimeMode: "native", adapterType: "paperclip_runner",
    agentId: "agent", agentName: "Worker", createdAt: run.createdAt ?? run.startedAt ?? "", startedAt: run.startedAt, finishedAt: run.finishedAt,
    resultJson: run.replyFileLine ? { replyFileLine: run.replyFileLine } : null }));
  const action = issue.activeRecoveryAction as unknown as IssueRecoveryAction | null;
  state.inspect = action ? { active: action, actions: [action], sourceInspection: { schema: "paperclip.workspace-source-inspection.v1",
    actionId: action.id, runId: fixture.rRunId, status: "blocked", failureCode: "source_binding_invalid", scope: "recorded_source_identity",
    observedAt: new Date().toISOString() } } : null;
  const queue = fixture.queue as unknown as IssueQueuedCommentQueue;
  // As IssueDetail.tsx: the task's ONE sentence (the server's) goes to the thread's recovery card, and the page's
  // other two status surfaces for the same run are not mounted with their status beside it.
  const savedMessageWait = readSavedMessageWait(issue.executionBlocker as never);
  await act(() => root.render(<QueryClientProvider client={client}><ThemeProvider>
    <div data-testid="top-status">
      <WorkspaceExportRecovery issueId={issue.id} companyId={issue.companyId} action={savedMessageWait ? null : action}
        showStatus={!issue.interruption && !(issue.executionBlocker as { workspaceRecovery?: unknown } | null)?.workspaceRecovery} />
      <ExecutionBlockerNotice presentation={savedMessageWait ? null : issue.interruption as TaskInterruptionPresentation | null} issueId={issue.id} companyId={issue.companyId}
        canRetry onRetry={() => {}} />
    </div>
    <CoordinatorPresentation value={state.coordinator}>
      <div data-testid="thread"><TaskChatThread issueId={issue.id} companyId={issue.companyId} currentUserId="viewer" comments={comments as never}
        linkedRuns={linkedRuns} liveRuns={[]} issueStatus={issue.status} recoveryAction={action} queuedCommentQueue={queue?.entries?.length ? queue : undefined}
        savedMessageWait={savedMessageWait ? { ...savedMessageWait, onContinue } : null} onResolveRecoveryAction={() => {}}
        onAdd={async () => {}} /></div>
    </CoordinatorPresentation>
  </ThemeProvider></QueryClientProvider>));
  await settle(); await settle();
}
const text = (testId?: string) => (testId ? host.querySelector(`[data-testid="${testId}"]`) : host)?.textContent ?? "";
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const buttons = (testId: string) => [...host.querySelectorAll(`[data-testid="${testId}"] button`)].map(button => button.textContent ?? "");
function dump(name: string, width: number) {
  if (!process.env.D2SHARED_RENDER_DUMP) return;
  const rendered = `FIXTURE: ${name}\nWIDTH: ${width}\nTOP STATUS: ${text("top-status")}\nTOP BUTTONS: ${JSON.stringify(buttons("top-status"))}\nCARD BUTTONS: ${JSON.stringify(buttons("task-chat-recovery-action-card"))}\nTHREAD: ${text("thread")}\n`;
  writeFileSync(`${process.env.D2SHARED_RENDER_DUMP}/render.${name}.${width}.txt`, rendered);
}
beforeEach(() => {
  state.coordinator = false; state.handoffs = []; state.plan = null; state.transcripts.clear(); state.inspect = null;
  localStorage.clear(); onContinue.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "viewer" } });
  client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "viewer", companyIds: Object.values(fixtures).map(fixture => fixture.issue.companyId), source: "session",
    isInstanceAdmin: false, memberships: Object.values(fixtures).map(fixture => ({ companyId: fixture.issue.companyId, membershipRole: "owner", status: "active" })) });
});
afterEach(async () => { vi.useRealTimers(); await act(() => root.unmount()); host.remove(); client.clear(); vi.restoreAllMocks(); });

// RFL's words (11:45Z), byte-exact, and the existing queue wait words.
const LINE = "Your message is saved. The last reply's file changes couldn't be saved; your message starts now on the project's files as they are.";
const PARTLY = "The last reply's file changes couldn't be saved, and part of them may already be in the project's files. Your message will start once you choose Continue.";
const WAIT = "Waiting for the previous environment to stop. Your message will start automatically.";
const CONTINUE = "Continue with the files as they are";
// The two status texts that stood beside the line at df8a8dbd (WorkspaceExportRecovery.tsx, ExecutionBlockerNotice.tsx).
const STALE = ["The saved files need recovery before work can continue.", "Couldn’t finish this attempt.", "Couldn't finish this attempt."];
/** Exactly ONE of the three sentences is on the page, once; none of the stale status texts stands beside it. */
function expectOnlyLine(sentence: string | null) {
  const all = text();
  for (const candidate of [LINE, PARTLY, WAIT]) expect(count(all, candidate), candidate).toBe(candidate === sentence ? 1 : 0);
  for (const stale of STALE) expect(all).not.toContain(stale);
  if (sentence !== LINE) expect(all).not.toContain("starts now");
  expect(all).not.toContain("Your Retry is saved.");
  expect(all).not.toContain("Create a new task to continue the work.");
  expect(all).not.toContain("This recovery needs a human decision.");
  if (sentence) { expect(count(text("task-chat-recovery-action-card"), sentence)).toBe(1); expect(text("top-status")).toBe(""); }
}
describe("shared project root, the save failed for good, a message parked: the real GETs at the d2shared3 head, rendered", () => {
  for (const width of WIDTHS) {
    it(`${width}px: while R's box is not stopped the ONE line is the wait line (never 'starts now'), with no second status beside it`, async () => {
      setWidth(width);
      for (const name of ["terminalMoment_waiting", "parked_boxNotStopped_waiting"] as const) {
        await paint(fixtures[name]); dump(name, width);
        expect(count(text("thread"), ANSWER)).toBe(1);
        expect(text("thread")).toContain(LOST);
        expect(text("thread")).toContain(M);
        expect(count(text("thread"), "next turn answered")).toBe(0);
        expectOnlyLine(WAIT);
        expect(buttons("top-status")).toEqual([]);
        expect(buttons("task-chat-recovery-action-card")).not.toContain(CONTINUE);
      }
    });
    it(`${width}px: a mixed checkout HOLDS the message: the second line once, ONE button, 'Continue with the files as they are', and nothing else to press on the card or above the thread`, async () => {
      setWidth(width);
      await paint(fixtures.held_continueRequired); dump("held_continueRequired", width);
      expect(text("thread")).toContain(M);
      expect(count(text("thread"), "next turn answered")).toBe(0);
      expectOnlyLine(PARTLY);
      expect(buttons("top-status")).toEqual([]);
      expect(buttons("task-chat-recovery-action-card")).toEqual([CONTINUE]);
      await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="recovery-action-primary"]')!.click(); });
      expect(onContinue).toHaveBeenCalledTimes(1);
      await paint(fixtures.answered_afterContinue); dump("answered_afterContinue", width);
      expect(count(text("thread"), "next turn answered")).toBe(1);
      expect(count(text("thread"), M)).toBe(1);
      expectOnlyLine(null);
      expect(text("top-status")).toBe("");
      expect(text()).not.toContain(CONTINUE);
    });
    it(`${width}px: once R's box is stopped and the files match, the message is answered ONCE with the first line in the thread once; nothing is left queued`, async () => {
      setWidth(width);
      await paint(fixtures.answered_boxStopped); dump("answered_boxStopped", width);
      const all = text("thread");
      expect(count(all, ANSWER)).toBe(1);
      expect(count(all, "next turn answered")).toBe(1);
      expect(count(all, M)).toBe(1);
      expect(all).toContain(LOST);
      // The line is the thread's system update (collapsed: its first sentence is on screen).
      expect(count(all, "Your message is saved.")).toBe(1);
      expect(all).not.toContain("Paperclip could not recover the unsaved files");
      expect(all).not.toContain("new workspace");
      expect(text("top-status")).toBe("");
      expect(fixtures.answered_boxStopped.comments.filter(comment => comment.body === LINE)).toHaveLength(1);
      expect(text()).not.toContain(WAIT); expect(text()).not.toContain(PARTLY);
    });
    it(`${width}px: one of the three 'unrecoverable' codes keeps the old screen: none of the three sentences, no Continue`, async () => {
      setWidth(width);
      await paint(fixtures.oldCode_beforeRetry); dump("oldCode_beforeRetry", width);
      for (const sentence of [LINE, PARTLY, WAIT, CONTINUE]) expect(text()).not.toContain(sentence);
      expect(readSavedMessageWait(fixtures.oldCode_beforeRetry.issue.executionBlocker as never)).toBeNull();
    });
  }
});
