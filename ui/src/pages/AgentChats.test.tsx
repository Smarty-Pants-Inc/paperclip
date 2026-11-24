// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { recordAgentChatVisit } from "@/lib/recent-agent-chats";
import { AgentChats } from "./AgentChats";

const state = vi.hoisted(() => ({
  primaryAgentId: null as string | null,
  primaryLoading: false,
  companyId: "company-a",
  userId: "user-a",
  agents: [] as Agent[],
  chats: [] as { id: string; conversationAgentId: string }[],
  chatsFetched: true,
  chatsError: null as Error | null,
  sessionError: null as Error | null,
  navigate: vi.fn(),
}));

vi.mock("@/components/primary-agent/PrimaryAgentPresentation", () => ({ usePrimaryAgentPresentation: () => ({ primaryAgentId: state.primaryAgentId, loading: state.primaryLoading }) }));

vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({
  useAgentChatNavigation: () => ({
    companyId: state.companyId,
    userId: state.userId,
    enabled: true,
    loaded: true,
    agents: { data: state.agents, isSuccess: true, isFetched: true, isPending: false, error: null },
    chats: { data: state.chatsFetched ? state.chats : undefined, isFetched: state.chatsFetched, isSuccess: state.chatsFetched && !state.chatsError, error: state.chatsError },
    session: { data: state.sessionError ? undefined : {}, isFetched: !state.sessionError, isPending: false, error: state.sessionError },
  }),
  useOpenAgentChat: () => vi.fn(),
}));
vi.mock("@/lib/router", () => ({
  useNavigate: () => state.navigate,
  useLocation: () => ({ pathname: "/chats" }),
  Link: ({ to, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props} />,
}));
vi.mock("@/components/AgentAvatar", () => ({ AgentAvatar: () => null }));
vi.mock("@/components/AgentChatPin", async (importOriginal) => ({ ...await importOriginal<typeof import("@/components/AgentChatPin")>(), useAgentChatPins: () => ({ orderedKeys: [], keys: new Set() }), AgentChatPin: () => null }));
vi.mock("@/hooks/useResourceMemberships", () => ({ useResourceMemberships: () => ({ isSuccess: false }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewAgent: vi.fn() }) }));
vi.mock("@/api/agents", () => ({ agentsApi: { get: async (id: string) => ({ id, name: id, status: "terminated" }) } }));

let queryClient: QueryClient;
let root: Root;
let container: HTMLDivElement;
const agent = (id: string, companyId = "company-a") => ({
  id, companyId, name: id, urlKey: `${id}-slug`, role: "engineer", status: "idle",
} as Agent);

async function render() {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><AgentChats /></QueryClientProvider>));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.primaryAgentId = null;
  state.primaryLoading = false;
  state.companyId = "company-a";
  state.userId = "user-a";
  state.agents = [agent("alice"), agent("bob")];
  state.chats = [];
  state.chatsFetched = true;
  state.chatsError = null;
  state.sessionError = null;
  state.navigate.mockReset();
  for (const id of ["alice", "bob", "removed", "retired-id"])
    recordAgentChatVisit("company-a", "user-a", id, null);
  localStorage.setItem("paperclip.recentAgentChats:company-a:user-a", "[]");
  localStorage.setItem("paperclip.recentAgentChats:company-b:user-a", "[]");
  localStorage.setItem("paperclip.recentAgentChats:company-a:user-b", "[]");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("Chat landing", () => {
  it("lists chats instead of redirecting to the primary or a recent conversation", async () => {
    state.primaryAgentId = "alice";
    recordAgentChatVisit("company-a", "user-a", "removed");
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('a[href="/chats/alice-slug"]')).not.toBeNull();
    recordAgentChatVisit("company-a", "user-a", "bob");
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('a[href="/chats/bob-slug"]')).not.toBeNull();
  });

  it("shows the list without waiting for a primary or requiring an available primary", async () => {
    state.primaryLoading = true;
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Search chats"]')).not.toBeNull();
    state.primaryLoading = false;
    state.primaryAgentId = "removed";
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('a[href="/chats/alice-slug"]')).not.toBeNull();
  });

  it("opens a chosen chat with a push so Back returns to the list", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    recordAgentChatVisit("company-a", "user-a", "bob");
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href="/chats/bob-slug"]')!.click());
    expect(state.navigate).toHaveBeenCalledWith("/chats/bob-slug");
  });

  it("ignores unavailable and other-scope visits while listing this company's agents", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    recordAgentChatVisit("company-a", "user-a", "removed");
    recordAgentChatVisit("company-b", "user-a", "other-company-agent");
    recordAgentChatVisit("company-a", "user-b", "other-user-agent");
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('nav a')].map(a => a.getAttribute("href"))).toEqual(["/chats/alice-slug", "/chats/bob-slug"]);
  });

  it("lists historical chats for agents missing from the active roster", async () => {
    recordAgentChatVisit("company-a", "user-a", "retired-id");
    state.chats = [{ id: "chat-retired", conversationAgentId: "retired-id" }];
    await render();
    await vi.waitFor(() => expect(container.querySelector('a[href="/chats/retired-id"]')).not.toBeNull());
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("loads history in the list without redirecting to a recent historical chat", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    recordAgentChatVisit("company-a", "user-a", "retired-id");
    state.chatsFetched = false;
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading agents");
    state.chatsFetched = true;
    state.chats = [{ id: "chat-retired", conversationAgentId: "retired-id" }];
    await render();
    await vi.waitFor(() => expect(container.querySelector('a[href="/chats/retired-id"]')).not.toBeNull());
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("lists all agents rather than a six-agent chooser when no saved chat remains", async () => {
    state.agents = Array.from({ length: 8 }, (_, i) => agent(`agent-${i}`));
    recordAgentChatVisit("company-a", "user-a", "removed");
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelectorAll('nav a')).toHaveLength(8);
  });

  it("does not reopen an inaccessible saved conversation even when its agent remains available", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    recordAgentChatVisit("company-a", "user-a", "bob", "deleted-chat");
    state.chats = [{ id: "chat-alice", conversationAgentId: "alice" }];
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('a[href="/chats/alice-slug"]')).not.toBeNull();
  });

  it("shows the list's retry state when history fails instead of reopening an agent", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice", "chat-alice");
    state.chatsFetched = false;
    state.chatsError = new Error("History unavailable");
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  });

  it("loads the list instead of reopening a visited empty chat", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice", null);
    state.chatsFetched = false;
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading agents");
  });

  it("shows a retry state when identity fails instead of waiting for disabled history", async () => {
    recordAgentChatVisit("company-a", "user-a", "alice");
    state.sessionError = new Error("Session unavailable");
    state.chatsFetched = false;
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Couldn[’']t load your chats/);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
  });
});
