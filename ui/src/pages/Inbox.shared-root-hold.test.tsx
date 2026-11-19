// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import fixtures from "./__fixtures__/shared-root-hold-inbox.json";

// RENDERED rows (d2shared4, F2): the Inbox page, mounted whole, on the REAL bodies of the GETs it reads, while a
// person's message M is held behind "Continue with the files as they are" (a reply's file save partly landed on the
// shared project checkout). The fixture is what server row F2 INBOX-PRESS of
// server/src/services/native-runtime/native-shared-root-hold-surfaces.test.ts read from the real routes
// (built by mkfixture.py of the d2shared4 report from that row's probe output; only host paths replaced), with the
// press that row then sent through the real POST /api/issues/:id/retry and what the GETs said afterwards.
// REAL: the Inbox page, its failed-run row and its retry mutation. MOCKED: the transport only (the api modules return
// the fixture's bodies and record what the page sends).
// Widths: jsdom has no layout engine, so "at 390 / at 1440" is what Tailwind's responsive display classes of the
// rendered markup leave on screen at that viewport width (hidden, sm:flex, sm:hidden, ...), evaluated by onScreen().
const routerMock = vi.hoisted(() => ({ location: { pathname: "/inbox/mine", search: "", hash: "" }, navigate: vi.fn() }));
const state = vi.hoisted(() => ({ companyId: "" as string | null, mobile: false }));
const apiMocks = vi.hoisted(() => ({ inboxMine: vi.fn(), issuesList: vi.fn(), retryTask: vi.fn(), agentsList: vi.fn(), heartbeatRunsList: vi.fn(), authSession: vi.fn() }));
vi.mock("../api/approvals", () => ({ approvalsApi: { list: vi.fn(async () => []) } }));
vi.mock("../api/access", async () => ({ ...await vi.importActual<typeof import("../api/access")>("../api/access"),
  accessApi: { listJoinRequests: vi.fn(async () => []), listUserDirectory: vi.fn(async () => ({ users: [] })) } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: apiMocks.authSession } }));
vi.mock("../api/dashboard", () => ({ dashboardApi: { summary: vi.fn(async () => ({ agents: { error: 0 }, costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 } })) } }));
vi.mock("../api/execution-workspaces", () => ({ executionWorkspacesApi: { listSummariesByIds: vi.fn(async () => []) } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: apiMocks.issuesList, listCompact: apiMocks.issuesList, inboxMine: apiMocks.inboxMine,
  count: vi.fn(async () => ({ count: 0 })), listLabels: vi.fn(async () => []), retryTask: apiMocks.retryTask, markRead: vi.fn(), markUnread: vi.fn(),
  archiveFromInbox: vi.fn(), unarchiveFromInbox: vi.fn() } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: apiMocks.agentsList } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { list: apiMocks.heartbeatRunsList, liveRunsForCompany: vi.fn(async () => []) } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false, enableStreamlinedUi: true })) } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: state.mobile }) }));
vi.mock("../hooks/useInboxBadge", () => ({
  useDismissedInboxAlerts: () => ({ dismissed: new Set(), dismiss: vi.fn() }),
  useInboxDismissals: () => ({ dismissedAtByKey: new Map(), dismiss: vi.fn() }),
  useReadInboxItems: () => ({ readItems: new Set(), markRead: vi.fn(), markUnread: vi.fn() }),
}));
vi.mock("../hooks/useIssueExternalObjects", () => ({
  useIssueExternalObjectSummaries: () => ({ summaries: new Map(), isLoading: false, isReady: true, error: null, refetch: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to, ...props }: ComponentProps<"a"> & { to?: string }) => <a className={className} href={to} {...props}>{children}</a>,
  useLocation: () => routerMock.location,
  useNavigate: () => routerMock.navigate,
}));
import { Inbox } from "./Inbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => { result = callback(); });
  await result;
}

type Fixture = (typeof fixtures)["held_continueRequired"] | (typeof fixtures)["afterPress"] | (typeof fixtures)["ordinaryFailedRun_noHold"]
  | (typeof fixtures)["heldAfterPlainRetry"];
const WIDTHS = [390, 1440] as const;
// RFL's words (11:45Z), byte-exact, and the hold's ONE action.
const PARTLY = "The last reply's file changes couldn't be saved, and part of them may already be in the project's files. Your message will start once you choose Continue.";
const CONTINUE = "Continue with the files as they are";
const TODAY = "Couldn’t finish this attempt. Your message is saved.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What is on screen at a viewport width, from Tailwind's responsive display classes (default breakpoints).
const BREAKPOINTS: Array<[string, number]> = [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];
const DISPLAYS = new Set(["block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid", "contents", "table", "table-cell", "table-row", "list-item"]);
function displayedAt(element: Element, width: number) {
  const classes = [...element.classList];
  if (classes.includes("sr-only")) return false;
  let shown = !classes.includes("hidden");
  for (const [prefix, min] of BREAKPOINTS) {
    for (const name of classes) {
      if (name.startsWith(`max-${prefix}:`) && width < min) { const value = name.slice(prefix.length + 5); if (value === "hidden") shown = false; else if (DISPLAYS.has(value)) shown = true; }
    }
    if (width < min) continue;
    for (const name of classes) {
      if (!name.startsWith(`${prefix}:`)) continue;
      const value = name.slice(prefix.length + 1);
      if (value === "hidden") shown = false; else if (DISPLAYS.has(value)) shown = true;
    }
  }
  return shown;
}
function onScreen(element: Element, width: number) {
  for (let node: Element | null = element; node; node = node.parentElement) if (!displayedAt(node, width)) return false;
  return true;
}
function screenText(root: Element, width: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (text.trim() && node.parentElement && onScreen(node.parentElement, width)) parts.push(text.trim());
  }
  return parts.join("\n");
}
/** Buttons with words on them that are on screen at this width (icon-only controls have none). */
const screenButtons = (root: Element, width: number) => [...root.querySelectorAll("button")]
  .filter(button => onScreen(button, width) && (button.textContent ?? "").trim());
/** The row's own actions on the failed run. "Archive" is the Inbox's control for every item (it is not a remedy). */
const remedies = (root: Element, width: number) => screenButtons(root, width).filter(button => (button.textContent ?? "").trim() !== "Archive");
const labels = (buttons: Element[]) => buttons.map(button => (button.textContent ?? "").trim());
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

let host: HTMLDivElement, root: Root, client: QueryClient;
function serve(fixture: Fixture) {
  state.companyId = fixture.companyId;
  apiMocks.authSession.mockResolvedValue({ user: { id: fixture.inboxMine.userId }, session: { userId: fixture.inboxMine.userId } });
  apiMocks.inboxMine.mockResolvedValue(fixture.inboxMine);
  apiMocks.heartbeatRunsList.mockResolvedValue(fixture.inboxRuns);
  apiMocks.issuesList.mockImplementation(async (_companyId: string, filters?: { ids?: string[] }) => filters?.ids ? fixture.inboxRows : []);
  apiMocks.agentsList.mockResolvedValue(fixture.agents);
}
async function mount(fixture: Fixture, width: number) {
  state.mobile = width < 768;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  serve(fixture);
  await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
}
/** The failed-run row of R's task: the row whose link opens the task. */
const failedRunRow = (fixture: Fixture) => host.querySelector(`a[href="/issues/${fixture.issueId}"]`)?.closest("div.group") ?? null;
function dump(name: string, width: number, row: Element | null) {
  if (!process.env.D2SHARED4_RENDER_DUMP) return;
  const rendered = [`FIXTURE: ${name}`, `SOURCE: ${fixtures.source}`, `WIDTH: ${width}`, "",
    "INBOX FAILED-RUN ROW, on screen:", row ? screenText(row, width) : "(no failed-run row)", "",
    `ROW BUTTONS, on screen: ${JSON.stringify(row ? labels(screenButtons(row, width)) : [])}`, "",
    "WHOLE INBOX PAGE, on screen:", screenText(host, width), ""].join("\n");
  writeFileSync(`${process.env.D2SHARED4_RENDER_DUMP}/inbox.${name}.${width}.txt`, rendered);
  writeFileSync(`${process.env.D2SHARED4_RENDER_DUMP}/inbox.${name}.${width}.html`, host.innerHTML);
}

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  routerMock.navigate.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); client.clear(); });

describe("the Inbox failed-run row while a message is held for Continue: the real GETs, rendered", () => {
  for (const width of WIDTHS) {
    it(`${width}px: the row says the task's ONE sentence once and offers the ONE action 'Continue with the files as they are' (no 'Couldn't finish this attempt', no plain Retry); pressing it sends the card's continue_with_files once, and the answered task leaves nothing to press`, async () => {
      const held = fixtures.held_continueRequired;
      await mount(held, width);
      const row = await vi.waitFor(() => { const found = failedRunRow(held); expect(found, "the Inbox shows R's failed-run row").toBeTruthy(); return found!; });
      dump("held_continueRequired", width, row);
      // The SAME sentence the task's card and the queue line say (the task's blocker, in the same real state).
      expect(held.taskBlocker).toEqual({ nextAction: PARTLY, savedMessageWait: "continue_required" });
      expect(held.queueWait).toMatchObject({ reason: "checkout_continue_required", message: PARTLY });
      expect(count(screenText(row, width), PARTLY), "the sentence, once, in the row").toBe(1);
      expect(count(screenText(host, width), PARTLY), "the sentence, once, on the page").toBe(1);
      expect(screenText(host, width)).not.toMatch(/Couldn[’']t finish this attempt/);
      expect(screenText(host, width)).not.toContain("Retry is waiting");
      // The sentence is shown whole: never clipped to one line.
      const sentence = [...row.querySelectorAll("span")].find(span => span.textContent === PARTLY && onScreen(span, width))!;
      expect(sentence.className).not.toMatch(/truncate|line-clamp|max-w-/);
      // ONE action with words on it: Continue. Never a plain Retry.
      expect(labels(remedies(row, width))).toEqual([CONTINUE]);
      expect(labels(screenButtons(host, width))).not.toContain("Retry");
      // Pressing it: the real route's own answer to that press, and what the Inbox's GETs said afterwards (the fixture).
      apiMocks.retryTask.mockResolvedValue(held.pressed.body);
      serve(fixtures.afterPress);
      await act(async () => { (remedies(row, width)[0] as HTMLButtonElement).click(); });
      await vi.waitFor(() => expect(apiMocks.retryTask).toHaveBeenCalledTimes(1));
      const [pressedIssueId, pressedBody] = apiMocks.retryTask.mock.calls[0];
      expect(pressedIssueId).toBe(held.issueId);
      // Exactly what server row F2 INBOX-PRESS sent through the real route (which then answered M exactly once).
      expect(pressedBody).toEqual({ idempotencyKey: expect.stringMatching(UUID), observedRunId: held.rRunId, retryAction: "continue_with_files" });
      expect({ ...pressedBody, idempotencyKey: undefined }).toEqual({ ...held.pressed.sent, idempotencyKey: undefined });
      expect(held.pressed).toMatchObject({ route: "POST /api/issues/:id/retry", status: 202, body: { accepted: true } });
      expect([(fixtures.afterPress.runsThatCarryM as Array<{ status: string }>).map(run => run.status), fixtures.afterPress.attributedRepliesToM]).toEqual([["succeeded"], 1]);
      // The Inbox reads again: M is answered, R's failed-run row is gone, and nothing is left to press a second time.
      await vi.waitFor(() => expect(failedRunRow(held)).toBeNull());
      dump("afterPress", width, failedRunRow(held));
      expect(screenText(host, width)).not.toContain(PARTLY);
      expect(labels(screenButtons(host, width)).filter(label => label === CONTINUE || label === "Retry")).toEqual([]);
      expect(apiMocks.retryTask).toHaveBeenCalledTimes(1);
    });

    it(`${width}px: after a plain Retry was sent to the route during the hold (accepted, M still held), the row still says the ONE sentence and offers only Continue, never 'Retry is waiting ...' with another Retry`, async () => {
      const held = fixtures.heldAfterPlainRetry;
      expect(held.plainRetry).toMatchObject({ status: 202, accepted: true });
      expect([held.runsThatCarryM, held.attributedRepliesToM, held.taskBlocker?.savedMessageWait]).toEqual([[], 0, "continue_required"]);
      await mount(held, width);
      const row = await vi.waitFor(() => { const found = failedRunRow(held); expect(found, "the Inbox shows R's failed-run row").toBeTruthy(); return found!; });
      dump("heldAfterPlainRetry", width, row);
      expect(count(screenText(host, width), PARTLY), "the sentence, once, on the page").toBe(1);
      expect(screenText(host, width)).not.toMatch(/Retry is waiting|Couldn[’']t finish this attempt/);
      expect(labels(remedies(row, width))).toEqual([CONTINUE]);
      apiMocks.retryTask.mockResolvedValue(fixtures.held_continueRequired.pressed.body);
      await act(async () => { (remedies(row, width)[0] as HTMLButtonElement).click(); });
      await vi.waitFor(() => expect(apiMocks.retryTask).toHaveBeenCalledTimes(1));
      expect(apiMocks.retryTask.mock.calls[0]).toEqual([held.issueId, { idempotencyKey: expect.stringMatching(UUID), observedRunId: held.rRunId, retryAction: "continue_with_files" }]);
    });

    it(`${width}px CONTROL: an ordinary failed run with no message held keeps today's text and its plain Retry`, async () => {
      const ordinary = fixtures.ordinaryFailedRun_noHold;
      await mount(ordinary, width);
      const row = await vi.waitFor(() => { const found = failedRunRow(ordinary); expect(found, "the Inbox shows R's failed-run row").toBeTruthy(); return found!; });
      dump("ordinaryFailedRun_noHold", width, row);
      expect(ordinary.taskBlocker?.savedMessageWait ?? null).toBeNull();
      expect(count(screenText(row, width), TODAY)).toBe(1);
      expect(screenText(host, width)).not.toContain(PARTLY);
      expect(screenText(host, width)).not.toContain(CONTINUE);
      expect(labels(remedies(row, width))).toEqual(["Retry"]);
      apiMocks.retryTask.mockResolvedValue({ requestId: "retry", accepted: true, stale: false, presentation: null });
      await act(async () => { (remedies(row, width)[0] as HTMLButtonElement).click(); });
      await vi.waitFor(() => expect(apiMocks.retryTask).toHaveBeenCalledTimes(1));
      // The plain Retry: no retry action.
      expect(apiMocks.retryTask.mock.calls[0]).toEqual([ordinary.issueId, { idempotencyKey: expect.stringMatching(UUID), observedRunId: ordinary.rRunId }]);
    });
  }
});
