// @vitest-environment jsdom
// Independent RFL round-2 attacks; keep reason: recorded #20378 lost-input regression.
// Real page, toolbar, router, query observers; network and row renderer isolated.
import { useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { MemoryRouter } from "@/lib/router";
import { useLocation, useNavigate, type NavigateFunction, type Location } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CoordinatorTasks } from "./CoordinatorTasks";
const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: mocks.list, listCompact: mocks.list, get: vi.fn(), listLabels: async () => [], update: mocks.update } }));
vi.mock("@/api/attention", () => ({ attentionApi: { taskIndex: async () => ({ taskIds: [] }) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: "judge", loaded: true }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/TaskList", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/TaskList")>(),
  TaskList: ({ items }: { items: { issue: { id: string; title: string } }[] }) => <div data-rows>{items.map(item => <p key={item.issue.id}>{item.issue.title}</p>)}</div>,
}));
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
type Entries = ComponentProps<typeof MemoryRouter>["initialEntries"];
type Controls = { go: NavigateFunction; churn: () => void; remount: () => void; location: Location };
describe("Independent round-2 adversarial Tasks search", () => {
  let root: Root, host: HTMLDivElement, clients: QueryClient[], controls: Record<string, Controls>;
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); controls = {}; clients = [];
    mocks.list.mockImplementation(async (_company: string, filters: { q?: string }) => [createIssue({ id: "row", companyId: "company", parentId: null, title: `Server ${filters.q ?? "all"}` })]);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { vi.useRealTimers(); flushSync(() => root.unmount()); clients.forEach(c => c.clear()); host.remove(); });
  function Live({ id }: { id: string }) {
    const [tick, setTick] = useState(0);
    const [mountKey, setMountKey] = useState(0);
    controls[id] = { go: useNavigate(), churn: () => setTick(t => t + 1), remount: () => setMountKey(k => k + 1), location: useLocation() };
    return <section data-tab={id}><CoordinatorTasks key={mountKey} viewControl={<span data-tick={tick} />} /></section>;
  }
  async function mount(entries: Entries = ["/issues?view=all"], second?: Entries) {
    const sets = second ? [entries, second] : [entries];
    clients = sets.map(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    flushSync(() => root.render(<>{sets.map((e, i) => <QueryClientProvider key={i} client={clients[i]}><TooltipProvider><MemoryRouter initialEntries={e}><Live id={String(i)} /></MemoryRouter></TooltipProvider></QueryClientProvider>)}</>));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Loading tasks"));
    return input();
  }
  const input = (id = "0") => host.querySelector<HTMLInputElement>(`[data-tab="${id}"] input[aria-label="Search tasks"]`)!;
  const q = (id = "0") => new URLSearchParams(controls[id].location.search).get("q") ?? "";
  function change(text: string, id = "0", composing = false) {
    const el = input(id); el.focus(); nativeValue.call(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: composing ? "insertCompositionText" : "insertText", isComposing: composing }));
    flushSync(() => controls[id].churn());
  }
  function type(text: string, id = "0") { for (const key of text) change(input(id).value + key, id); }
  function clear(id = "0") { flushSync(() => host.querySelector<HTMLButtonElement>(`[data-tab="${id}"] button[aria-label="Clear search"]`)!.click()); }

  it("deep links decode q on load and preserve unrelated params after pasted replacement", async () => {
    const el = await mount(["/issues?view=all&q=hello%20%E4%B8%96%E7%95%8C&workspaceId=w"]);
    expect(el.value).toBe("hello 世界"); expect(q()).toBe("hello 世界");
    change("SMAA-1390 & review/日本語");
    expect(el.value).toBe("SMAA-1390 & review/日本語");
    await vi.waitFor(() => expect(q()).toBe(el.value));
    expect(new URLSearchParams(controls["0"].location.search).get("workspaceId")).toBe("w");
  });

  it("isolates two simultaneous tabs' drafts, URL commits and Clear", async () => {
    await mount(["/issues?view=all&q=left"], ["/issues?view=all&q=right"]);
    change("left-draft"); change("right-draft", "1"); clear("0"); type("left-new");
    expect(input().value).toBe("left-new"); expect(input("1").value).toBe("right-draft");
    await vi.waitFor(() => expect(q()).toBe("left-new"));
    await vi.waitFor(() => expect(q("1")).toBe("right-draft"));
  });

  it("Back before a debounce fires cancels it permanently, not just for the next render", async () => {
    await mount(["/issues?view=all&q=earlier", "/issues?view=all"]);
    type("pending"); flushSync(() => controls["0"].go(-1));
    await vi.waitFor(() => expect(input().value).toBe("earlier"));
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(q()).toBe("earlier"); expect(input().value).toBe("earlier");
  });

  it("rapid Clear then typing never resurrects the cleared term", async () => {
    await mount(["/issues?view=all&q=old"]);
    change("pending-old"); clear(); type("new");
    expect(input().value).toBe("new"); await vi.waitFor(() => expect(q()).toBe("new"));
    expect(mocks.list.mock.calls.some(([, f]) => f.q === "pending-old")).toBe(false);
  });

  it("retains composition text across a pause, then commits the final IME text", async () => {
    const el = await mount(); el.focus();
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    change("に", "0", true);
    await vi.waitFor(() => expect(q()).toBe("に"));
    expect(el.value).toBe("に"); expect(document.activeElement).toBe(el);
    change("日本", "0", true);
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
    change("日本");
    await vi.waitFor(() => expect(q()).toBe("日本")); expect(el.value).toBe("日本");
  });

  it("accepts a retained history token on remount as external state, not a pending acknowledgement", async () => {
    await mount([{ pathname: "/issues", search: "?view=all&q=restored", state: { taskSearchCommit: 1 } }]);
    expect(input().value).toBe("restored");
    change("after-reload"); await vi.waitFor(() => expect(q()).toBe("after-reload"));
    expect(input().value).toBe("after-reload");
  });

  it("does not interpret a token in the URL or markup in q as executable/state data", async () => {
    const text = '<img src=x onerror="window.attacked=1">';
    await mount([`/issues?view=all&taskSearchCommit=1&q=${encodeURIComponent(text)}`]);
    expect(input().value).toBe(text); expect(host.querySelector("img[src=x]")).toBeNull();
    type(" safe"); await vi.waitFor(() => expect(q()).toBe(text + " safe"));
    expect((window as unknown as { attacked?: number }).attacked).toBeUndefined();
  });

  it("does not starve the debounce while the page rerenders without more keystrokes", async () => {
    await mount(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    change("stable");
    for (let i = 0; i < 12; i++) { vi.advanceTimersByTime(100); flushSync(() => controls["0"].churn()); }
    // Flush the pending router transition without advancing the debounce another 250ms.
    await new Promise(resolve => setImmediate(resolve));
    expect(q()).toBe("stable");
  });

  it("Back to a retained token from an earlier mount must beat an unacknowledged new commit with the same counter", async () => {
    await mount();
    change("earlier"); await vi.waitFor(() => expect(q()).toBe("earlier"));
    expect(controls["0"].location.state).toHaveProperty("taskSearchCommit");
    flushSync(() => controls["0"].go("/issues?view=all"));
    await vi.waitFor(() => expect(input().value).toBe(""));
    // A reload / leaving Tasks and returning resets hook refs but retains history entries.
    flushSync(() => controls["0"].remount());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    change("SMAA"); vi.advanceTimersByTime(300); // first new commit id=1, router render still pending
    change("SMAA-356"); expect(q()).toBe("");
    flushSync(() => controls["0"].go(-1));
    await vi.waitFor(() => expect(q()).toBe("earlier"));
    expect.soft(input().value).toBe("earlier");
    vi.advanceTimersByTime(500);
    await new Promise(resolve => setImmediate(resolve));
    expect(q()).toBe("earlier");
  });

  it("Back after revisiting the page retains the previous search even after queued typing has had time to settle (base-compatible)", async () => {
    await mount();
    change("earlier"); await vi.waitFor(() => expect(q()).toBe("earlier"));
    flushSync(() => controls["0"].go("/issues?view=all"));
    await vi.waitFor(() => expect(q()).toBe(""));
    flushSync(() => controls["0"].remount());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    change("SMAA"); vi.advanceTimersByTime(300); change("SMAA-356");
    flushSync(() => controls["0"].go(-1));
    await vi.waitFor(() => expect(q()).toBe("earlier"));
    expect.soft(input().value).toBe("earlier");
    vi.advanceTimersByTime(500);
    await new Promise(resolve => setImmediate(resolve));
    expect(q()).toBe("earlier");
  });

  it("loads a bare q deep link while adding the default view", async () => {
    await mount(["/issues?q=SMAA-1390"]);
    await vi.waitFor(() => expect(new URLSearchParams(controls["0"].location.search).has("view")).toBe(true));
    expect(q()).toBe("SMAA-1390"); expect(input().value).toBe("SMAA-1390");
  });

  it("characterizes the broader navigation rule: a sort-only navigation cancels a pending draft", async () => {
    await mount(["/issues?view=all&q=old"]);
    change("pending-new");
    flushSync(() => controls["0"].go("/issues?view=all&q=old&sortField=created&sortDir=asc", { replace: true }));
    await vi.waitFor(() => expect(input().value).toBe("old"));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(q()).toBe("old");
    // Characterization, not an endorsement that sort should discard the search.
  });

  it("a navigation with a colliding history state token is still authoritative", async () => {
    await mount(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    change("draft"); vi.advanceTimersByTime(300);
    change("draft-more");
    flushSync(() => controls["0"].go("/issues?view=all&q=external", { state: { taskSearchCommit: 1 } }));
    await vi.waitFor(() => expect(q()).toBe("external"));
    expect(input().value).toBe("external");
  });
});
