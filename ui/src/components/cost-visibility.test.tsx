// @vitest-environment jsdom
// Policy regression: cost-only built-in UI is hidden; operational token data survives.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttentionItem } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { foldAttentionObligations } from "../lib/attention-obligations";
import { revisionSummary } from "../pages/agent-detail/AgentHistoryDialog";
import { ApprovalCardPanel } from "./ApprovalCardPanel";
import { ActivityRow } from "./ActivityRow";
import { ContextUsageCard } from "./ContextUsageMeter";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { BudgetOverridePayload } from "./ApprovalPayload";
import { TaskChatUsageReadout } from "./task-chat/TaskChatUsageReadout";
import { normalizeTranscript } from "./transcript/RunTranscriptView";
import { estimateStatusCardCost } from "../pages/StatusCards/format";
import type { TaskChatUsageItem } from "./task-chat/task-chat-model";

describe("additional built-in money surfaces", () => {
  it("preserves context token accounting without a Cost row", () => {
    const markup = renderToStaticMarkup(<ContextUsageCard usage={{ usedTokens: 120, contextWindow: 1000, costUsd: 0.25, totals: { inputTokens: 120, outputTokens: 40 } }} />);
    expect(markup).toContain("120");
    expect(markup).toContain("40");
    expect(markup).not.toMatch(/Cost|\$|—/);
  });
  it("omits hire-agent spending limits while retaining the hire approval", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.approvals.detail("approval-money"), { payload: { name: "Helper", budgetMonthlyCents: 5000 } });
    const item = { id: "hire-helper", companyId: "company", sourceKind: "approval", subject: { id: "approval-money", title: "Hire Helper", metadata: { type: "hire_agent" } } } as unknown as AttentionItem;
    const markup = renderToStaticMarkup(<QueryClientProvider client={client}><ApprovalCardPanel item={item} companyId="company" /></QueryClientProvider>);
    expect(markup).toContain("Helper");
    expect(markup).not.toMatch(/month|spending|\$|—/);
    client.clear();
  });
  it("hides budget incidents and budget override evidence in decision feeds", () => {
    const items = [
      { id: "stop", sourceKind: "budget_alert", subject: { metadata: {} } },
      { id: "override", sourceKind: "approval", subject: { metadata: { type: "budget_override_required" } } },
      { id: "review", sourceKind: "review", subject: { metadata: {} } },
    ] as AttentionItem[];
    expect(foldAttentionObligations(items).cards.map(item => item.id)).toEqual(["review"]);
  });
  it("omits budget configuration labels from history", () => {
    expect(revisionSummary({ changedKeys: ["name", "budgetMonthlyCents"], rolledBackFromRevisionId: null })).toBe("Changed name");
  });
  it("omits money-only activity records", () => {
    const event = { action: "cost.recorded" } as Parameters<typeof ActivityRow>[0]["event"];
    expect(renderToStaticMarkup(<ActivityRow event={event} agentMap={new Map()} entityNameMap={new Map()} />)).toBe("");
  });
  it("hides the sidebar budget marker including its accessible label", () => {
    expect(renderToStaticMarkup(<BudgetSidebarMarker />)).toBe("");
  });
  it("hides budget override payload amounts", () => {
    expect(renderToStaticMarkup(<BudgetOverridePayload payload={{ budgetAmount: 10000, observedAmount: 12000 }} />)).toBe("");
  });
  it("keeps chat input/output and context while omitting dollars", () => {
    const item = { kind: "usage", usage: { used: 100, size: 1000, inputTokens: 120, outputTokens: 40, costUsd: 0.25 } } as TaskChatUsageItem;
    const markup = renderToStaticMarkup(<TaskChatUsageReadout item={item} />);
    expect(markup).toContain("120");
    expect(markup).toContain("40");
    expect(markup).toContain("ctx");
    expect(markup).not.toContain("$");
  });
  it("keeps transcript token totals without a cost field", () => {
    const blocks = normalizeTranscript([{ kind: "result", ts: "2026-11-17T00:00:00Z", text: "Completed", errors: [], isError: false, inputTokens: 120, outputTokens: 40, cachedTokens: 0, subtype: "success", costUsd: 0.25 }], false);
    const text = JSON.stringify(blocks);
    expect(text).toContain("120 / 40");
    expect(text).not.toMatch(/120 \/ 40 \/|cost unknown|\$/);
  });
  it("keeps status-card token estimates without currency placeholders", () => {
    const estimate = estimateStatusCardCost({ mode: "manual", triggers: { statusTransitions: true, membershipChanges: true, humanComments: true, assigneeChanges: true, anyUpdate: false } });
    expect(estimate.cost).toContain("tok");
    expect(estimate.cost).not.toMatch(/\$|—|·/);
  });
});
