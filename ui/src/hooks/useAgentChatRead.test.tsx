// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatReadProvider, useAgentChatRead } from "./useAgentChatRead";
import { ApiError, detachInflightGets } from "@/api/client";
import { useAgentChatNavigation } from "./useAgentChatNavigation";
import { queryKeys } from "@/lib/queryKeys";
import { agentChatsApi } from "@/api/agentChats";
const markRead = vi.hoisted(() => vi.fn());
vi.mock("@/api/issues", () => ({ issuesApi: { markRead } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
let root: Root, container: HTMLDivElement, client: QueryClient;
let focused = true, latest = true, visible = true, laterId: string | null = null;
const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
function Message({ id }: { id: string }) {
  const ref = useAgentChatRead(id, id === laterId ? "2026-10-30T12:00:00.124Z" : "2026-10-30T12:00:00.123Z", true);
  return <div ref={ref}>Digest</div>;
}
async function render(ids = [first], companyId = "company-1", userId = "human-1", issueId = "chat-1") {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <AgentChatReadProvider issueId={issueId} companyId={companyId} userId={userId}>
      <div className="task-chat-scroll-viewport">{ids.map(id => <Message key={id} id={id} />)}</div>
    </AgentChatReadProvider>
  </QueryClientProvider>));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  focused = true; latest = true; visible = true; laterId = null;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => latest ? 100 : 300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} });
  markRead.mockReset().mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("reads only visible foreground messages at the bottom, including arrivals sharing a millisecond", async () => {
  focused = false; await render(); expect(markRead).not.toHaveBeenCalled();
  focused = true; latest = false; await render(); expect(markRead).not.toHaveBeenCalled();
  latest = true; await render(); expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  await render([first, second]); expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
  await render([first, second]); expect(markRead).toHaveBeenCalledTimes(2);
});
it("does not clear concurrent unseen arrivals while a read request is pending", async () => {
  let finish!: () => void;
  markRead.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); expect(markRead).toHaveBeenCalledTimes(1);
  focused = false; await render([first, second]);
  await act(async () => finish()); expect(markRead).toHaveBeenCalledTimes(1);
  focused = true; await render([first, second]); expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
});
it("automatically retries a failed visible message without another focus event", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new TypeError("Network unavailable"));
  await render();
  expect(markRead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(2);
});
it("retries only the seen cutoff when another message arrives out of view", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new TypeError("Network unavailable"));
  await render();
  focused = false; await render([first, second]);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  focused = true; await render([first, second]);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
});
it("coalesces a newly seen message into the pending retry", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new TypeError("Network unavailable"));
  // A later millisecond: ids sharing one are all sent (#21268, R3 below).
  laterId = second;
  await render();
  await render([first, second]);
  expect(markRead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", second);
  await render([first, second]);
  expect(markRead).toHaveBeenCalledTimes(2);
});
it("respects the server retry delay for a rate-limited read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValueOnce(new ApiError("Rate limited", 429, {}, { retryAfterMs: 2_000 }));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
  expect(markRead).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(markRead).toHaveBeenCalledTimes(2);
});
it("stops after bounded retries and recovers the retained cutoff on reconnect", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new ApiError("Unavailable", 503, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(markRead).toHaveBeenCalledTimes(3);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t mark this chat read.");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(3);
  markRead.mockResolvedValue({});
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(markRead).toHaveBeenCalledTimes(4);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it.each(["company", "human", "chat", "unmount"])("cancels a pending retry after %s changes", async kind => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new TypeError("Network unavailable"));
  await render();
  expect(markRead).toHaveBeenCalledTimes(1);
  focused = false;
  if (kind === "unmount") await act(async () => { root.render(null); });
  else await render([first], kind === "company" ? "company-2" : "company-1", kind === "human" ? "human-2" : "human-1", kind === "chat" ? "chat-2" : "chat-1");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(1);
});
it("resumes an exhausted cutoff when the chat becomes visible again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new TypeError("Network unavailable"));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(markRead).toHaveBeenCalledTimes(3);
  markRead.mockResolvedValue({});
  visible = false;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(markRead).toHaveBeenCalledTimes(3);
  visible = true;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(markRead).toHaveBeenCalledTimes(4);
  expect(markRead).toHaveBeenLastCalledWith("chat-1", first);
});
it("does not retry a denied read receipt", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  markRead.mockRejectedValue(new ApiError("Forbidden", 403, {}));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t mark this chat read.");
});
it("discards an in-flight failure after the human changes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let fail!: (cause: Error) => void;
  markRead.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
  await render();
  focused = false; await render([first], "company-1", "human-2");
  await act(async () => { fail(new TypeError("Network unavailable")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(markRead).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

// --- #21268: the unread chat badge that would not clear ----------------------
// Real read provider, real chat-list hook and the real API client; only `fetch`
// is replaced, by a server model with exact (microsecond) comment cutoffs.
type Planted = { chat: string; id: string; us: number; createdAt: string };
const chatOne = "33333333-3333-4333-8333-333333333333", chatTwo = "44444444-4444-4444-8444-444444444444";
const reply = (id: string, chat: string, us: number): Planted => ({ chat, id, us, createdAt: new Date(Math.floor(us / 1000)).toISOString() });
// Planted bodies: the reply Paul is looking at, and one in a conversation he has not opened.
const replyInOpenChat = reply("55555555-5555-4555-8555-555555555555", chatOne, Date.parse("2026-11-19T06:08:16.600Z") * 1000 + 119);
const replyElsewhere = reply("66666666-6666-4666-8666-666666666666", chatTwo, Date.parse("2026-11-17T05:52:12.116Z") * 1000 + 374);
// Two replies saved in the same millisecond: .123456 then .123789.
const sameMsOlder = reply("77777777-7777-4777-8777-777777777777", chatOne, Date.parse("2026-11-19T06:10:00.123Z") * 1000 + 456);
const sameMsNewer = reply("88888888-8888-4888-8888-888888888888", chatOne, Date.parse("2026-11-19T06:10:00.123Z") * 1000 + 789);
const server = { comments: [] as Planted[], cutoff: new Map<string, number>(), hold: false, held: [] as (() => void)[], chatGets: 0, aborted: 0 };
const unreadOnServer = (chat: string) => server.comments.some(c => c.chat === chat && c.us > (server.cutoff.get(chat) ?? -1));
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input), method = init?.method ?? "GET";
  const read = /^\/api\/issues\/([^/]+)\/read$/.exec(url);
  if (method === "POST" && read) {
    const through = JSON.parse(String(init?.body)).throughCommentId as string;
    const comment = server.comments.find(c => c.id === through)!;
    server.cutoff.set(read[1], Math.max(server.cutoff.get(read[1]) ?? -1, comment.us));
    return Promise.resolve(json({ id: read[1], lastReadAt: comment.createdAt }));
  }
  if (method === "GET" && url === "/api/companies/company-1/chats") {
    server.chatGets += 1;
    // The server answers from what it holds when the request is handled.
    const snapshot = [chatOne, chatTwo].map(id => ({ id, companyId: "company-1", isUnreadForMe: unreadOnServer(id), updatedAt: "2026-11-19T06:00:00.000Z" }));
    if (!server.hold) return Promise.resolve(json(snapshot));
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { server.aborted += 1; reject(new DOMException("Aborted", "AbortError")); });
      server.held.push(() => resolve(json(snapshot)));
    });
  }
  return Promise.reject(new Error(`unplanned request ${method} ${url}`));
}
function Badge() {
  const { chats } = useAgentChatNavigation();
  // The sidebar's own count: unread conversations (Sidebar.tsx).
  return <output data-testid="chat-badge">{chats.data ? chats.data.filter(chat => chat.isUnreadForMe).length : "loading"}
    {chats.data?.map(chat => <span key={chat.id} data-chat={chat.id} data-unread={String(chat.isUnreadForMe)} />)}</output>;
}
function Reply({ comment }: { comment: Planted }) {
  const ref = useAgentChatRead(comment.id, comment.createdAt, true);
  return <div ref={ref}>{comment.id}</div>;
}
async function settle() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function show(open: Planted[] | null) {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <Badge />
    {open && <AgentChatReadProvider issueId={chatOne} companyId="company-1" userId="human-1">
      <div className="task-chat-scroll-viewport">{open.map(comment => <Reply key={comment.id} comment={comment} />)}</div>
    </AgentChatReadProvider>}
  </QueryClientProvider>));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await settle();
}
/** A reply lands: the live update invalidates the chat list (LiveUpdatesProvider). */
async function arrives(comment: Planted) { server.comments.push(comment); await liveUpdate(); }
async function liveUpdate() {
  await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.agentChats.list("company-1", "human-1") }); });
  await settle();
}
async function releaseHeld() { server.hold = false; for (const release of server.held.splice(0)) release(); await settle(); }
const badge = () => container.querySelector('[data-testid="chat-badge"]');
const unreadInBadge = (chat: string) => badge()?.querySelector(`[data-chat="${chat}"]`)?.getAttribute("data-unread");
let gap = 0, viewportHeight = 600, resizeCallbacks: (() => void)[] = [];
function plantGeometry() {
  // jsdom has no layout: the viewport's distance from the end is planted.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => 2_000);
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(() => 2_000 - viewportHeight - gap);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() =>
    ({ top: 0, bottom: viewportHeight, height: viewportHeight, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} }));
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resizeCallbacks.push(callback); } observe() {} unobserve() {} disconnect() {} });
}
describe("the chat badge clears once the reply is read (#21268)", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@/api/issues")>("@/api/issues");
    markRead.mockImplementation(actual.issuesApi.markRead);
    // A row that failed with a held GET must not leave it for the next row to join.
    for (const release of server.held.splice(0)) release();
    detachInflightGets();
    server.comments = [replyElsewhere]; server.cutoff = new Map(); server.hold = false; server.held = []; server.chatGets = 0; server.aborted = 0;
    gap = 0; viewportHeight = 600; resizeCallbacks = [];
    vi.stubGlobal("fetch", vi.fn(serve));
    plantGeometry();
    client.setQueryDefaults(queryKeys.auth.session, { staleTime: Infinity });
    client.setQueryData(queryKeys.auth.session, { session: { id: "session-1", userId: "human-1" }, user: { id: "human-1" } });
  });
  it.each([[390, 640], [1440, 820]])("R1 at %ipx: a reply read at the end (within the scroller's 48px) leaves no badge, even with an older list GET in flight", async (width, height) => {
    vi.stubGlobal("innerWidth", width); viewportHeight = height; gap = 30;
    await show([]);
    expect(badge()?.textContent).toBe("1"); // only the other conversation
    server.hold = true;
    await arrives(replyInOpenChat); // this GET started before the read: it carries chat one as unread
    await show([replyInOpenChat]);
    expect(markRead).toHaveBeenCalledWith(chatOne, replyInOpenChat.id);
    expect(unreadOnServer(chatOne)).toBe(false);
    expect(server.aborted).toBe(1); // the pre-read GET is cancelled at the network, not just ignored
    await releaseHeld();
    expect(unreadInBadge(chatOne)).toBe("false");
    expect(unreadInBadge(chatTwo)).toBe("true"); // control: another conversation's badge is unaffected
    expect(badge()?.textContent).toBe("1");
  });
  it("R2: a reply that arrived elsewhere shows 1, then opening the thread clears it with no refresh", async () => {
    server.comments = [];
    await show(null);
    expect(badge()?.textContent).toBe("0");
    await arrives(replyInOpenChat);
    expect(badge()?.textContent).toBe("1");
    server.hold = true;
    await liveUpdate(); // another live update: its GET is still in flight when the thread opens
    await show([replyInOpenChat]);
    expect(unreadOnServer(chatOne)).toBe(false);
    await releaseHeld();
    expect(unreadInBadge(chatOne)).toBe("false");
    expect(badge()?.textContent).toBe("0");
  });
  it("R1, first load: a read that lands while the first list GET is still in flight leaves no badge", async () => {
    server.comments.push(replyInOpenChat);
    server.hold = true; // the list's first GET (no cached list yet) carries chat one as unread
    await show([replyInOpenChat]);
    expect(unreadOnServer(chatOne)).toBe(false);
    await releaseHeld();
    expect(unreadInBadge(chatOne)).toBe("false");
    expect(badge()?.textContent).toBe("1");
  });
  it("R1, shared request: the refetch after a read does not join an older GET another caller still holds", async () => {
    await show([]);
    server.hold = true;
    server.comments.push(replyInOpenChat);
    const olderCaller = agentChatsApi.list("company-1"); // same path, started before the read, still wanted
    await liveUpdate();
    await show([replyInOpenChat]);
    expect(unreadOnServer(chatOne)).toBe(false);
    await releaseHeld();
    expect((await olderCaller).find(chat => chat.id === chatOne)?.isUnreadForMe).toBe(true); // it asked first
    expect(unreadInBadge(chatOne)).toBe("false");
  });
  it("R3: replies sharing a millisecond, seen newest first, leave none unread", async () => {
    server.comments = [sameMsOlder, sameMsNewer];
    await show([sameMsNewer, sameMsOlder]);
    expect(markRead).toHaveBeenCalledWith(chatOne, sameMsNewer.id);
    expect(unreadOnServer(chatOne)).toBe(false);
    expect(unreadInBadge(chatOne)).toBe("false");
  });
  it.each([[390, 500, 590], [1440, 700, 790]])("R4 at %ipx: a resize that brings the end into view marks the reply read", async (width, before, after) => {
    vi.stubGlobal("innerWidth", width);
    viewportHeight = before; gap = 120;
    server.comments.push(replyInOpenChat);
    await show([replyInOpenChat]);
    expect(markRead).not.toHaveBeenCalled();
    viewportHeight = after; gap = 30; // the viewport grew; the end is now in view
    await act(async () => { for (const callback of resizeCallbacks) callback(); });
    await settle();
    expect(markRead).toHaveBeenCalledWith(chatOne, replyInOpenChat.id);
    expect(unreadInBadge(chatOne)).toBe("false");
  });
  it("control: scrolled up beyond 48px, the reply stays unread", async () => {
    gap = 49;
    server.comments.push(replyInOpenChat);
    await show([replyInOpenChat]);
    await act(async () => { viewportElement()?.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("resize")); });
    await settle();
    expect(markRead).not.toHaveBeenCalled();
    expect(unreadInBadge(chatOne)).toBe("true");
    expect(unreadInBadge(chatTwo)).toBe("true");
    expect(badge()?.textContent).toBe("2");
  });
});
const viewportElement = () => container.querySelector(".task-chat-scroll-viewport");
