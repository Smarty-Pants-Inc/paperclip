// @vitest-environment jsdom
// F-A (RFL 23:47Z, final words): while the run carrying the person's message M is RUNNING with no run event for
// 5 minutes, the rendered thread shows ONE line: "This is taking longer than usual. Your message is saved."
// It retires on a real run event or on an answer to M, and never stands beside the "wasn't answered" group notice.
// Rendered TaskChatThread, chat and task. What each prop stands for:
//   - `comments`: the rows GET /api/issues/:id/comments returns (the person's message; the agent's reply; the
//     sweep's notice with metadata.authorizationReason "unanswered_message:<id>");
//   - `liveRuns` / `activeRun`: the rows GET /api/issues/:id/live-runs and /active-run return (status, startedAt,
//     contextWakeCommentId, outputSilence.lastOutputAt), PLANTED here as literals of that shape;
//   - "a real run event": the REAL client producer, LiveUpdatesProvider's readRunLiveStatusPatchFromPayload, reads
//     the server's heartbeat.run.event payload into the lastEventAt it then writes on the cached run.
import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatThread } from "./TaskChatThread";
import { CoordinatorPresentation } from "./coordinator/CoordinatorPresentation";
import { ThemeProvider } from "@/context/ThemeContext";
import { __liveUpdatesTestUtils } from "@/context/LiveUpdatesProvider";
import { RUN_STALLED_AFTER_MS, RUN_STALLED_LINE } from "./task-chat/useRunStalled";
import type { LiveRunForIssue } from "@/api/heartbeats";

vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), isInitialHydrating: false }),
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: () => ({ transcriptByRun: new Map(), errorsByRun: new Map(), terminalHydratedRunIds: new Set() }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true, userId: "viewer" }),
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
/** The row asserts the bound itself: the run is this far short of 5 silent minutes when the thread first paints. */
const SHORT_OF_BOUND_MS = 700;
const NOTICE_TEXT = "This run finished without a reply to your message. Sending it again is safe.";

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); client.clear(); vi.restoreAllMocks(); });

type Comment = React.ComponentProps<typeof TaskChatThread>["comments"][number];
function scene(surface: "chat" | "task") {
  const silentSince = Date.now() - (RUN_STALLED_AFTER_MS - SHORT_OF_BOUND_MS);
  const message = { id: "message-m", body: "Please summarise the report.", companyId: "company", issueId: "issue", authorType: "user",
    authorAgentId: null, authorUserId: "viewer", presentation: null, metadata: null,
    createdAt: new Date(silentSince - 2_000), updatedAt: new Date(silentSince - 2_000) } as unknown as Comment;
  // The run carrying M: running, started, and not one run event since (no lastEventAt, no saved last output).
  const run: LiveRunForIssue = { id: "run-m", runtimeMode: "native", status: "running", invocationSource: "on_demand", triggerDetail: null,
    contextCommentId: "message-m", contextWakeCommentId: "message-m", startedAt: new Date(silentSince).toISOString(), finishedAt: null,
    createdAt: new Date(silentSince).toISOString(), agentId: "agent", agentName: "Assistant", adapterType: "paperclip_runner", issueId: "issue",
    lastEventAt: null };
  const paint = (comments: Comment[], liveRun: LiveRunForIssue | null) => act(() => root.render(
    <QueryClientProvider client={client}><ThemeProvider><CoordinatorPresentation value={false}>
      <TaskChatThread issueId="issue" companyId="company" conversationMode={surface === "chat"} currentUserId="viewer" issueStatus="in_progress"
        comments={comments} linkedRuns={[]} liveRuns={liveRun ? [liveRun] : []} activeRun={liveRun ?? undefined} onAdd={async () => {}} />
    </CoordinatorPresentation></ThemeProvider></QueryClientProvider>));
  const lines = () => [...host.querySelectorAll('[data-testid="task-chat-run-stalled-line"]')].map(node => node.textContent);
  const occurrences = () => (host.textContent ?? "").split(RUN_STALLED_LINE).length - 1;
  const pastBound = () => act(async () => { await new Promise(resolve => setTimeout(resolve, SHORT_OF_BOUND_MS + 400)); });
  return { message, run, paint, lines, occurrences, pastBound, silentSince };
}

describe.each(["chat", "task"] as const)("F-A: the stalled-run line on the rendered thread (%s)", surface => {
  it("hung: no run event for 5 minutes -> the line, once, at the bound (not before)", async () => {
    const s = scene(surface);
    await s.paint([s.message], s.run);
    expect(host.textContent, "the person's message is on the thread").toContain("Please summarise the report.");
    expect(s.lines(), "short of 5 minutes: no line").toEqual([]);
    await s.pastBound();
    expect(s.lines(), "at 5 silent minutes: the line").toEqual([RUN_STALLED_LINE]);
    expect(RUN_STALLED_LINE).toBe("This is taking longer than usual. Your message is saved.");
    expect(s.occurrences(), "ONE line on the whole thread").toBe(1);
    // It stays one line as the thread repaints while the run stays silent.
    await s.paint([s.message], { ...s.run });
    expect(s.occurrences()).toBe(1);
  });

  it("events resume: a real run event retires the line", async () => {
    const s = scene(surface);
    await s.paint([s.message], s.run);
    await s.pastBound();
    expect(s.lines()).toEqual([RUN_STALLED_LINE]);
    // The server's heartbeat.run.event, read by the REAL client producer into the run's lastEventAt.
    const at = new Date().toISOString();
    const patch = __liveUpdatesTestUtils.readRunLiveStatusPatchFromPayload({ runId: s.run.id, agentId: s.run.agentId, issueId: "issue",
      message: "Reading the report", updatedAt: at, lastEventAt: at }, at, "heartbeat.run.event");
    expect(patch?.lastEventAt).toBe(at);
    await s.paint([s.message], { ...s.run, lastEventAt: patch!.lastEventAt });
    expect(s.lines(), "a real run event: the line retires").toEqual([]);
    expect(s.occurrences()).toBe(0);
  });

  it("a saved last-output time (the GET's outputSilence.lastOutputAt) counts as the run's last event: no line on a reload of a working run", async () => {
    const s = scene(surface);
    await s.paint([s.message], { ...s.run, startedAt: new Date(s.silentSince - 30 * 60_000).toISOString(),
      outputSilence: { lastOutputAt: new Date(Date.now() - 20_000).toISOString() } as LiveRunForIssue["outputSilence"] });
    await s.pastBound();
    expect(s.lines()).toEqual([]);
  });

  it("M answered: the agent's reply retires the line", async () => {
    const s = scene(surface);
    await s.paint([s.message], s.run);
    await s.pastBound();
    expect(s.lines()).toEqual([RUN_STALLED_LINE]);
    const reply = { ...s.message, id: "reply", body: "Here is the summary.", authorType: "agent", authorAgentId: "agent", authorUserId: null,
      runId: s.run.id, createdByRunId: s.run.id, createdAt: new Date(), updatedAt: new Date() } as unknown as Comment;
    await s.paint([s.message, reply], s.run);
    expect(s.lines(), "M has its answer: the line retires").toEqual([]);
    expect(s.occurrences()).toBe(0);
    // The run ends; the saved reply is what the thread shows, and still no line.
    await s.paint([s.message, reply], null);
    expect(host.textContent).toContain("Here is the summary.");
    expect(s.occurrences()).toBe(0);
  });

  it("never two lines: with the 'wasn't answered' group notice on the thread, the stalled line does not show", async () => {
    const s = scene(surface);
    const notice = { ...s.message, id: "notice", body: NOTICE_TEXT, authorType: "system", authorUserId: null,
      metadata: { authorizationReason: `unanswered_message:${s.message.id}` },
      createdAt: new Date(s.silentSince - 1_000), updatedAt: new Date(s.silentSince - 1_000) } as unknown as Comment;
    await s.paint([s.message, notice], s.run);
    await s.pastBound();
    expect(s.lines(), "the group notice owns the thread").toEqual([]);
    // Control: the same thread without the notice shows the line.
    await s.paint([s.message], s.run);
    expect(s.lines()).toEqual([RUN_STALLED_LINE]);
  });

  it("not this run's case: a queued run, or a run that carries no person message, shows no line", async () => {
    const s = scene(surface);
    await s.paint([s.message], { ...s.run, status: "queued" });
    await s.pastBound();
    expect(s.lines(), "queued: the waiting header's case, not this line's").toEqual([]);
    await s.paint([s.message], { ...s.run, contextCommentId: null, contextWakeCommentId: null });
    expect(s.lines(), "no message of the person's is carried: nothing to say is saved").toEqual([]);
  });
});
