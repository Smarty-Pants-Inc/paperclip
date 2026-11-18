// @vitest-environment jsdom

import type { Agent, CompactIssue, IssueSummary } from "@paperclipai/shared";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { Dashboard, derivePausedAgentBanner, recentTaskIndexRows, withTaskSummaries } from "./Dashboard";

const setBreadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", companies: [{ id: "company-1", issuePrefix: "SOL" }] }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: vi.fn() }) }));
vi.mock("../api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "sol", settled: true }) }));
vi.mock("../hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({}), usePublishSharedQueryData: () => {} }));
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("../components/SmokeLabDashboardCard", () => ({ SmokeLabDashboardCard: () => null }));
vi.mock("../plugins/slots", () => ({ PluginSlotOutlet: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Recorded catch: rf-4 exposed the masked spend via 114.46% beside a $500 cap.
it.each([79.2, 114.46])("masks the Month Spend subtitle (%s) but retains the configured budget", async (percent) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.agents.list("company-1"), [agent({ status: "idle" })]);
  client.setQueryData(queryKeys.dashboard("company-1"), {
    agents: { active: 1, running: 0, paused: 0, error: 0 },
    tasks: { inProgress: 0, open: 0, blocked: 0 },
    costs: { monthSpendCents: 57230, monthBudgetCents: 50000, monthUtilizationPercent: percent },
    budgets: { activeIncidents: 0, pendingApprovals: 0 }, pendingApprovals: 0, runActivity: [],
  });
  client.setQueryData([...queryKeys.activity("company-1"), { limit: 10 }], []);
  client.setQueryData(queryKeys.issues.listIndex("company-1"), []);
  client.setQueryData(queryKeys.projects.list("company-1", { includeArchived: true }), []);
  client.setQueryData(queryKeys.access.companyUserDirectory("company-1"), { users: [] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(MemoryRouter, null,
      createElement(QueryClientProvider, { client }, createElement(Dashboard)))));
    const tile = container.querySelector('a[href$="/costs"]');
    expect(tile?.textContent).toContain("Month Spend");
    expect(tile?.textContent).toContain("— of $500.00 budget");
    expect(tile?.textContent).not.toContain(`${percent}%`);
    expect(tile?.textContent).not.toContain("$572.30");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Agent",
    status: "idle",
    pauseReason: null,
    ...overrides,
  } as unknown as Agent;
}

describe("derivePausedAgentBanner", () => {
  it("returns null with no agents loaded or an empty company", () => {
    expect(derivePausedAgentBanner(undefined)).toBeNull();
    expect(derivePausedAgentBanner([])).toBeNull();
  });

  it("prefers the imported banner and lists only import-paused agents", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "import" }),
      agent({ id: "b", status: "paused", pauseReason: "manual" }),
      agent({ id: "c", status: "idle" }),
    ]);
    expect(banner).toEqual({ kind: "imported", pausedImportedAgentIds: ["a"] });
  });

  it("falls back to the all-paused banner when no import pauses exist", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "paused", pauseReason: "system" }),
    ]);
    expect(banner).toEqual({ kind: "all-paused" });
  });

  it("shows nothing while at least one agent can run and none are import-paused", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "idle" }),
    ]);
    expect(banner).toBeNull();
  });
});

describe("dashboard recent tasks from the task index", () => {
  const row = (id: string, updatedAt: string): CompactIssue =>
    ({ id, identifier: id.toUpperCase(), title: id, status: "blocked", updatedAt, assigneeAgentId: "agent-1" }) as unknown as CompactIssue;

  it("keeps the ten most recently updated tasks, newest first", () => {
    const rows = Array.from({ length: 14 }, (_, index) => row(`t${index}`, new Date(Date.UTC(2026, 10, 1 + index)).toISOString()));
    expect(recentTaskIndexRows(rows.reverse()).map(issue => issue.id)).toEqual(
      ["t13", "t12", "t11", "t10", "t9", "t8", "t7", "t6", "t5", "t4"]);
  });

  it("reads each task's update time once, in one pass over a large company", () => {
    let reads = 0;
    const rows = Array.from({ length: 5_000 }, (_, index) => {
      const at = new Date(Date.UTC(2026, 0, 1) + ((index * 7919) % 5_000) * 60_000).toISOString();
      return Object.defineProperty({ id: `t${index}` }, "updatedAt", { get: () => { reads += 1; return at; } }) as unknown as CompactIssue;
    });
    const recent = recentTaskIndexRows(rows);
    expect(reads).toBe(5_000);
    const sorted = [...rows].sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt))).slice(0, 10);
    expect(recent.map(issue => issue.id)).toEqual(sorted.map(issue => issue.id));
  });

  it("takes the status glyph fields from the task summary and the rest from the index row", () => {
    const summary = { id: "t1", displayStatus: "in_queue", externalConversationState: "waiting",
      blockerAttention: { state: "covered" } } as unknown as IssueSummary;
    const [merged] = withTaskSummaries([row("t1", "2026-11-01T00:00:00.000Z")], [summary]);
    expect(merged).toMatchObject({ id: "t1", title: "t1", assigneeAgentId: "agent-1", displayStatus: "in_queue",
      externalConversationState: "waiting", blockerAttention: { state: "covered" } });
    const [plain] = withTaskSummaries([row("t2", "2026-11-01T00:00:00.000Z")], undefined);
    expect(plain).not.toHaveProperty("displayStatus");
  });
});
