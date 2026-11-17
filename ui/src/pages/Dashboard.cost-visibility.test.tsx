// @vitest-environment jsdom
// Recorded policy regression: built-in money surfaces must not leak to owners.
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@paperclipai/shared";
import { Dashboard } from "./Dashboard";
import { queryKeys } from "../lib/queryKeys";

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", companies: [{ id: "company-1" }] }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "owner", settled: true }) }));
vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => false }));
vi.mock("../hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({}), usePublishSharedQueryData: () => {} }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/dashboard" }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("../components/SmokeLabDashboardCard", () => ({ SmokeLabDashboardCard: () => null }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("../components/ActivityCharts", () => ({ ChartCard: () => null, RunActivityChart: () => null, PriorityChart: () => null, IssueStatusChart: () => null, SuccessRateChart: () => null }));

const summary: DashboardSummary = {
  companyId: "company-1", agents: { active: 1, running: 0, paused: 0, error: 0 },
  tasks: { open: 1, inProgress: 1, blocked: 0, done: 0 },
  costs: { monthSpendCents: 12345, monthBudgetCents: 10000, monthUtilizationPercent: 123 },
  pendingApprovals: 2, budgets: { activeIncidents: 1, pendingApprovals: 3, pausedAgents: 1, pausedProjects: 1 }, runActivity: [],
};

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.dashboard("company-1"), summary);
  client.setQueryData(queryKeys.agents.list("company-1"), [{ id: "a", status: "idle" }]);
  client.setQueryData(queryKeys.issues.listIndex("company-1"), []);
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>);
  client.clear();
  return markup;
}

describe("Dashboard money policy", () => {
  it("omits the Month Spend tile while retaining ordinary operational metrics", () => {
    const markup = render();
    expect(markup).not.toMatch(/Month Spend|Unlimited budget|href="\/costs"/);
    expect(markup).toContain("Tasks In Progress");
    expect(markup).toContain("Agents Enabled");
  });
  it("omits budget incident and pending-budget copy", () => {
    expect(render()).not.toMatch(/budget incident|Open budgets|budget overrides/);
  });
});
