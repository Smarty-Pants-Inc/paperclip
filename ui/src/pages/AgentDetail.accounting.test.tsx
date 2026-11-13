// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentActionButtons } from "../components/AgentActionButtons";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { RunAccountingMetrics } from "./AgentDetail";
import { CostAmount } from "../components/CostAmount";
import { SubscriptionTokenUsage } from "../components/SubscriptionCostCard";
import { hasUnavailableProviderAccounting } from "../lib/utils";

vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

const unavailable = { providerAccounting: { usage: null, cost: null, externallyBilled: true } };
const run = (usageJson: HeartbeatRun["usageJson"], resultJson: HeartbeatRun["resultJson"] = null) => ({ usageJson, resultJson } as HeartbeatRun);

describe("run accounting provenance", () => {
  it("renders persisted unavailable accounting without zero usage or zero dollars", () => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, unavailable)} />);
    expect(markup.match(/Unavailable/g)).toHaveLength(4);
    expect(markup).not.toContain("$0");
    expect(markup).not.toContain(">0<");
  });

  it("retains reported historical usage independently of the agent's current provider", () => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens: 120, outputTokens: 20, cachedInputTokens: 40, costUsd: 0.12 })} />);
    expect(markup).toContain("120");
    expect(markup).toContain("20");
    expect(markup).toContain("40");
    expect(markup).toContain("$0.1200");
    expect(markup).not.toContain("Unavailable");
  });

  it.each([0, 120])("qualifies lower-bound counts even when the measured subtotal is %s", inputTokens => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens, outputTokens: 0, accountingUsageLost: true })} />);
    expect(markup).toContain("Additional usage unknown");
    expect(markup).toContain(`>${inputTokens}<`);
  });

  it("does not infer missing usage from an ordinary estimate or explanatory prose", () => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens: 120, outputTokens: 20, costStatus: "estimated",
      pricingProvenance: { evidence: "Additional usage unknown" } })} />);
    expect(markup).not.toContain("Additional usage unknown");
  });

  it("qualifies company and agent amounts with the same typed lower-bound marker", () => {
    const markup = renderToStaticMarkup(<CostAmount costCents={25} accountingUsageLost />);
    expect(markup).toContain("Additional usage unknown");
    expect(markup).toContain("$0.25");
    expect(renderToStaticMarkup(<CostAmount costCents={25} />)).not.toContain("Additional usage unknown");
  });

  it("qualifies subscription usage without qualifying the unrelated monthly fee", () => {
    const usage = { inputTokens: 120, cachedInputTokens: 20, outputTokens: 10, costCents: "0", eventCount: 1,
      estimatedEventCount: 0, unpricedEventCount: 0, accountingUsageLost: true };
    expect(renderToStaticMarkup(<SubscriptionTokenUsage usage={usage} />)).toContain("Additional usage unknown");
    expect(renderToStaticMarkup(<SubscriptionTokenUsage usage={{ ...usage, accountingUsageLost: false }} />))
      .not.toContain("Additional usage unknown");
  });

  it("requires the saved externally billed and unavailable facts", () => {
    expect(hasUnavailableProviderAccounting(unavailable)).toBe(true);
    expect(hasUnavailableProviderAccounting(null)).toBe(false);
    expect(hasUnavailableProviderAccounting({ providerAccounting: { usage: null, cost: null } })).toBe(false);
    expect(hasUnavailableProviderAccounting({ providerAccounting: { usage: { inputTokens: 2 }, cost: 1, externallyBilled: true } })).toBe(false);
  });
});


describe("provider trace support", () => {
  const renderActions = (provider: string) => {
    const agent: Agent = {
      id: "agent-1", companyId: "company-1", name: "Researcher", urlKey: "researcher", role: "researcher",
      title: null, icon: null, status: "active", reportsTo: null, capabilities: null,
      adapterType: "paperclip_runner", adapterConfig: { provider }, runtimeConfig: {},
      budgetMonthlyCents: 0, spentMonthlyCents: 0, permissions: { canCreateAgents: false },
      pauseReason: null, pausedAt: null, lastHeartbeatAt: null, metadata: null,
      createdAt: new Date("2026-10-10T00:00:00Z"), updatedAt: new Date("2026-10-10T00:00:00Z"),
    };
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentActionButtons agent={agent} />
      </QueryClientProvider>,
    );
  };

  it("keeps normal Muse actions but removes the unsupported raw traffic promise", () => {
    const markup = renderActions("muse");
    expect(markup).toContain("Run now");
    expect(markup).toContain("Pause");
    expect(markup).not.toContain("Run with provider trace");
    expect(markup).not.toContain("Capture exact provider traffic");
  });

  it.each(["codex", "openai_dot"])("keeps normal %s actions without a separate trace button", provider => {
    const markup = renderActions(provider);
    expect(markup).toContain("Run now");
    expect(markup).toContain("Pause");
    expect(markup).not.toContain("Run with provider trace");
    expect(markup).not.toContain("Capture exact provider traffic");
  });
});
