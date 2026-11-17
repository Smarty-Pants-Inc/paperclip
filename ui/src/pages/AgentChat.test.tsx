// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { AgentChat } from "./AgentChat";

const api = vi.hoisted(() => ({ enabled: true, list: vi.fn(), get: vi.fn(), getChat: vi.fn(), listChats: vi.fn(), directory: vi.fn(), primaries: vi.fn(), ensure: vi.fn(), session: vi.fn() }));
const agentId = "18c5ad50-9d70-4e24-bd82-337e1d45a414";
vi.mock("@/api/agents", () => ({ agentsApi: { list: api.list, get: api.get } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: api.getChat, list: api.listChats, ensure: api.ensure } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: api.directory } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.session } }));
vi.mock("@/api/primaryAgent", () => ({ primaryAgentApi: { list: api.primaries } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-a" }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: api.enabled, loaded: true }) }));
vi.mock("@/lib/router", () => ({ useParams: () => ({ agentRef: "18c5ad50-9d70-4e24-bd82-337e1d45a414" }), Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
// Keep reason: data safety at the page→task surface boundary. Browser captures
// exercise the real TaskDetailSurface and its owner-only composer separately.
vi.mock("./IssueDetail", () => ({ TaskDetailSurface: ({ conversation }: { conversation: { agent: Agent; issue: Issue | null } }) => <div data-issue-id={conversation.issue?.id}>
  History for {conversation.agent.name}
  {(!conversation.issue?.conversationUserId || conversation.issue.conversationUserId === "viewer-a") && <textarea aria-label="Message" />}
</div> }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync(() => {});
}
async function waitFor(assertion: () => void) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { assertion(); return; } catch (error) { if (attempt === 49) throw error; await settle(); }
  }
}
function render() {
  flushSync(() => root.render(<QueryClientProvider client={client}><AgentChat /></QueryClientProvider>));
}
async function failRoster(status: number, cached = true) {
  if (cached) client.setQueryData(queryKeys.agents.list("company-a"), []);
  api.list.mockRejectedValue(new ApiError(status === 429 ? "Rate limited" : "Denied", status, {}));
  await client.fetchQuery({ queryKey: queryKeys.agents.list("company-a"), queryFn: api.list, staleTime: 0 }).catch(() => {});
  expect(client.getQueryState(queryKeys.agents.list("company-a"))?.status).toBe("error");
}
beforeEach(() => {
  vi.clearAllMocks();
  api.enabled = true;
  api.primaries.mockResolvedValue([]);
  api.listChats.mockResolvedValue([{ id: "member-chat", companyId: "company-a", conversationAgentId: agentId, conversationUserId: "member-b", title: "Launch plan", updatedAt: "2026-11-15T12:00:00Z" }]);
  api.directory.mockResolvedValue({ users: [{ principalId: "member-b", status: "active", user: { id: "member-b", name: "Member B" } }] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(["primary-agent", "company-a", "members", "viewer-a"], []);
  client.setQueryData(queryKeys.auth.session, { user: { id: "viewer-a" } });
  api.session.mockResolvedValue({ user: { id: "viewer-a" } });
  api.get.mockResolvedValue({ id: agentId, companyId: "company-a", name: "Retired helper", status: "terminated" });
  api.getChat.mockResolvedValue({ id: "existing-chat" });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });

it("explains when Agent Chat is disabled without creating a conversation", async () => {
  api.enabled = false;
  api.list.mockResolvedValue([{ id: agentId, companyId: "company-a", name: "Helper" }]);
  render();
  await waitFor(() => expect(container.textContent).toContain("Agent Chat is disabled"));
  expect(api.ensure).not.toHaveBeenCalled();
  expect(api.getChat).not.toHaveBeenCalled();
});

it.each(["cached_refetch_failed", "fresh"])("opens historical chat from an available roster (%s)", async state => {
  if (state === "cached_refetch_failed") await failRoster(429);
  else client.setQueryData(queryKeys.agents.list("company-a"), []);
  render();
  await waitFor(() => expect(container.textContent).toContain("History for Retired helper"));
  expect(api.get).toHaveBeenCalledWith(agentId, "company-a");
  expect(api.getChat).toHaveBeenCalledWith("company-a", agentId);
  expect(container.textContent).not.toContain("Agent not found");
  expect(api.ensure).not.toHaveBeenCalled();
});

it("offers a working retry when the historical lookup also fails", async () => {
  await failRoster(429);
  api.get.mockRejectedValue(new ApiError("Rate limited", 429, {}));
  render();
  await waitFor(() => expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(true));
  expect(container.textContent).not.toContain("Agent not found");
  api.get.mockResolvedValue({ id: agentId, companyId: "company-a", name: "Retired helper" });
  flushSync(() => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry")!.click());
  await waitFor(() => expect(container.textContent).toContain("History for Retired helper"));
  expect(api.ensure).not.toHaveBeenCalled();
});

it.each([[403, true], [429, false]] as const)("retains roster error controls without starting a historical lookup (%s, cached %s)", async (status, cached) => {
  await failRoster(status, cached);
  render();
  await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(status === 429);
  expect(api.get).not.toHaveBeenCalled();
  expect(api.getChat).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Agent not found");
});

it("does not display a historical agent from another company", async () => {
  await failRoster(429);
  api.get.mockResolvedValue({ id: agentId, companyId: "company-b", name: "Private helper" });
  render();
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  await waitFor(() => expect(container.textContent).toContain("Agent not found"));
  expect(container.textContent).not.toContain("Private helper");
  expect(api.getChat).not.toHaveBeenCalled();
});


it("opens a stale navigation conversation immediately while revalidating in the background", async () => {
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000, gcTime: Infinity } });
  client.setQueryData(queryKeys.agents.list("company-a"), [{ id: agentId, companyId: "company-a", name: "Helper" }]);
  client.setQueryData(queryKeys.agentChats.list("company-a", "viewer-a"), [{
    id: "existing-chat", companyId: "company-a", conversationAgentId: agentId,
  } as Issue], { updatedAt: Date.now() - 60_000 });
  api.getChat.mockImplementation(() => new Promise(() => {}));
  render();
  expect(container.textContent).toContain("History for Helper");
  expect(container.textContent).not.toContain("Loading conversation");
  await waitFor(() => expect(api.getChat).toHaveBeenCalledWith("company-a", agentId));
  expect(api.ensure).not.toHaveBeenCalled();
});

function paulSmarty() {
  api.list.mockResolvedValue([{ id: agentId, companyId: "company-a", name: "Paul's Smarty" }]);
  client.setQueryData(["primary-agent", "company-a", "members", "viewer-a"], [{ userId: "paul", agentId }]);
  api.directory.mockResolvedValue({ users: [{ principalId: "paul", status: "active", user: { id: "paul", name: "Paul" } }] });
  api.listChats.mockResolvedValue([
    { id: "unrelated", conversationUserId: "another-member", conversationAgentId: agentId },
    { id: "paul-chat", companyId: "company-a", conversationAgentId: agentId, conversationUserId: "paul" },
  ]);
}

it("Kate opens Paul's Smarty: only Paul's chat, read-only, without toggle or own-chat lookup", async () => {
  paulSmarty();
  render();
  await waitFor(() => expect(container.textContent).toContain("Paul's chat with Paul's Smarty"));
  expect(container.querySelector('[data-issue-id="paul-chat"]')).not.toBeNull();
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector('[aria-label="Conversation members"]')).toBeNull();
  expect(container.textContent).not.toContain("All members");
  expect(container.querySelector('[data-issue-id="unrelated"]')).toBeNull();
  expect(api.getChat).not.toHaveBeenCalled();
  expect(api.ensure).not.toHaveBeenCalled();
});

it.each(["own", "unclaimed", "shared-with-me"])("Kate opens %s Smarty: interactive own chat without toggle", async mode => {
  api.list.mockResolvedValue([{ id: agentId, companyId: "company-a", name: "Helper" }]);
  client.setQueryData(["primary-agent", "company-a", "members", "viewer-a"], mode === "unclaimed" ? [] : [
    ...(mode === "shared-with-me" ? [{ userId: "paul", agentId }] : []), { userId: "viewer-a", agentId },
  ]);
  render();
  await waitFor(() => expect(container.querySelector("textarea")).not.toBeNull());
  expect(container.querySelector('[data-issue-id="existing-chat"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Conversation members"]')).toBeNull();
  expect(api.listChats).not.toHaveBeenCalled();
});

it("shows one plain line when the other member has no shared chat, without creating one", async () => {
  paulSmarty(); api.listChats.mockResolvedValue([]);
  render();
  await waitFor(() => expect(container.textContent).toBe("Paul hasn't chatted with Paul's Smarty yet"));
  expect(container.querySelector("textarea")).toBeNull();
  expect(api.getChat).not.toHaveBeenCalled();
  expect(api.ensure).not.toHaveBeenCalled();
});

it("finds the owner's conversation beyond the first members=all page", async () => {
  paulSmarty();
  api.listChats.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, conversationUserId: `other-${i}` })))
    .mockResolvedValueOnce([{ id: "paul-chat", conversationAgentId: agentId, conversationUserId: "paul" }]);
  render();
  await waitFor(() => expect(container.querySelector('[data-issue-id="paul-chat"]')).not.toBeNull());
  expect(api.listChats).toHaveBeenLastCalledWith("company-a", { agentId, members: "all", limit: 100, offset: 100 });
});

it("never flashes the interactive view while primary ownership is loading", async () => {
  paulSmarty(); client.removeQueries({ queryKey: ["primary-agent"] });
  api.primaries.mockImplementation(() => new Promise(() => {}));
  render(); await settle(); await settle();
  expect(container.textContent).toContain("Loading conversation");
  expect(container.querySelector("textarea")).toBeNull();
  expect(api.getChat).not.toHaveBeenCalled();
});

it("shows ownership lookup errors instead of falling back to an interactive view", async () => {
  paulSmarty(); client.removeQueries({ queryKey: ["primary-agent"] });
  api.primaries.mockRejectedValue(new ApiError("Denied", 403, {}));
  render();
  await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.querySelector("textarea")).toBeNull();
  expect(api.getChat).not.toHaveBeenCalled();
});

it("does not reuse another account's cached conversation", async () => {
  client.setQueryData(queryKeys.agents.list("company-a"), [{ id: agentId, companyId: "company-a", name: "Helper" }]);
  client.setQueryData(queryKeys.agentChats.list("company-a", "viewer-b"), [{
    id: "private-chat", companyId: "company-a", conversationAgentId: agentId,
  } as Issue]);
  api.getChat.mockImplementation(() => new Promise(() => {}));
  render();
  expect(container.textContent).toContain("Loading conversation");
  await waitFor(() => expect(api.getChat).toHaveBeenCalled());
});
