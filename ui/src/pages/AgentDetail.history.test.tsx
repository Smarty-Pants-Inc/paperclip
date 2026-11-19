// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDetail, RunsTab } from "./AgentDetail";
import { RunsTab as ProductionRunsTab } from "./AgentDetail.production";
import { ToastProvider } from "../context/ToastContext";
import { PanelProvider } from "../context/PanelContext";
import { DialogProvider } from "../context/DialogContext";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";

const { get, mobile } = vi.hoisted(() => ({ get: vi.fn(), mobile: { value: false } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { get, events: async () => [], workspaceOperations: async () => [] } }));
vi.mock("../api/client", () => ({ api: { get: async (path: string) => path.endsWith("/resource-memberships/me") ? { projectMemberships: {}, agentMemberships: {} } : [] } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ companyIds: ["company-1"], memberships: [] }) } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: mobile.value }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "TEST" }, companies: [] }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { get.mockReset(); });

it.each([
  { Tab: RunsTab, isMobile: false }, { Tab: ProductionRunsTab, isMobile: false },
  { Tab: RunsTab, isMobile: true }, { Tab: ProductionRunsTab, isMobile: true },
])("renders an older selected run when history is empty (%#)", async ({ Tab, isMobile }) => {
  mobile.value = isMobile;
  const run = { id: "older-run", companyId: "company-1", agentId: "agent-1", status: "succeeded", invocationSource: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usageJson: null, resultJson: null,
    contextSnapshot: null, exitCode: 0, error: null, logRef: null, startedAt: null, finishedAt: null } as unknown as HeartbeatRun;
  get.mockResolvedValue(run);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><PanelProvider><ToastProvider>
      <Tab runs={[]} companyId="company-1" agentId="agent-1" agentRouteId="agent-1" selectedRunId="older-run" adapterType="codex_local" adapterConfig={{}} />
    </ToastProvider></PanelProvider></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain("succeeded"); });
    expect(element.textContent).not.toContain("No runs yet.");
    expect(get).toHaveBeenCalledWith("older-run");
  } finally { await act(async () => root.unmount()); client.clear(); element.remove(); }
});

// #20990: another member's Smarty opens only that member's read-only chat.
const smarty = vi.hoisted(() => ({ primaries: [] as Array<{ userId: string; agentId: string }> }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "viewer-a" } }) } }));
vi.mock("../api/primaryAgent", () => ({ primaryAgentApi: { list: async () => smarty.primaries } }));
vi.mock("../api/agents", async importOriginal => {
  const actual = await importOriginal<typeof import("../api/agents")>();
  return { ...actual, agentsApi: { ...actual.agentsApi, get: async () => ({ id: "agent-b", companyId: "company-1", name: "Bea's Smarty",
    urlKey: "beas-smarty", role: "general", status: "idle", permissions: {}, adapterType: "codex_local", adapterConfig: {},
    runtimeConfig: {}, chainOfCommand: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }) } };
});

function Where() { return <output data-testid="where">{useLocation().pathname}</output>; }

async function openAgentPage(path: string, primaries: Array<{ userId: string; agentId: string }>) {
  smarty.primaries = primaries;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><PanelProvider><ToastProvider>
    <DialogProvider><BreadcrumbProvider companyName="Test"><Where /><Routes>
      <Route path="/:companyPrefix/agents/:agentId" element={<AgentDetail />} />
      <Route path="/:companyPrefix/agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="/:companyPrefix/chats/:agentRef" element={<p>Read-only chat route</p>} />
    </Routes></BreadcrumbProvider></DialogProvider>
  </ToastProvider></PanelProvider></MemoryRouter></QueryClientProvider>));
  const settle = async () => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  await settle();
  return { element, where: () => element.querySelector("[data-testid=where]")!.textContent, settle,
    cleanup: async () => { await act(async () => root.unmount()); client.clear(); element.remove(); } };
}

it.each(["/TEST/agents/beas-smarty", "/TEST/agents/beas-smarty/overview"])("lands another member's Smarty on its read-only chat from %s", async path => {
  const page = await openAgentPage(path, [{ userId: "member-b", agentId: "agent-b" }]);
  try {
    await vi.waitFor(async () => { await page.settle(); expect(page.where()).toBe("/TEST/chats/beas-smarty"); });
    expect(page.element.textContent).toContain("Read-only chat route");
  } finally { await page.cleanup(); }
});

it("offers no Chat or New task to a non-owner on another member's Smarty settings tab", async () => {
  const page = await openAgentPage("/TEST/agents/beas-smarty/permissions", [{ userId: "member-b", agentId: "agent-b" }]);
  try {
    await vi.waitFor(async () => { await page.settle(); expect(page.element.querySelector("[aria-label='Open actions for Bea\\'s Smarty']")).not.toBeNull(); });
    expect(page.where()).toBe("/TEST/agents/beas-smarty/permissions");
    expect(page.element.querySelector("[aria-label='Chat with Bea\\'s Smarty']")).toBeNull();
    expect([...page.element.querySelectorAll("button")].map(b => b.textContent)).not.toContain("New task");
  } finally { await page.cleanup(); }
});

it.each([
  { who: "own primary", primaries: [{ userId: "viewer-a", agentId: "agent-b" }] },
  { who: "own primary shared with another member", primaries: [{ userId: "member-b", agentId: "agent-b" }, { userId: "viewer-a", agentId: "agent-b" }] },
  { who: "nobody's primary", primaries: [{ userId: "member-b", agentId: "other-agent" }] },
])("keeps the agent page with Chat and New task for $who", async ({ primaries }) => {
  const page = await openAgentPage("/TEST/agents/beas-smarty", primaries);
  try {
    await vi.waitFor(async () => { await page.settle(); expect(page.element.querySelector("[aria-label='Chat with Bea\\'s Smarty']")).not.toBeNull(); });
    expect(page.where()).toBe("/TEST/agents/beas-smarty/overview");
    expect([...page.element.querySelectorAll("button")].map(b => b.textContent)).toContain("New task");
  } finally { await page.cleanup(); }
});
