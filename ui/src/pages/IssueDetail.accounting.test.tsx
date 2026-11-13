// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from "node:fs";
import capture from "../../../packages/paperclip-runner/test-fixtures/pi-rpc/real-session-usage-only.json";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueCostSummary } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { IssueDetailActivityTab } from "./IssueDetail";
import { queryKeys } from "../lib/queryKeys";

vi.mock("../components/IssueRunLedger", () => ({ IssueRunLedger: () => null }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

const measured = capture.events.slice(0, 9).reduce((sum: Record<string, number>, event: { message?: { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } } }) => {
  const usage = event.message?.usage;
  if (usage) {
    sum.inputTokens += usage.input + usage.cacheWrite;
    sum.outputTokens += usage.output;
    sum.cachedInputTokens += usage.cacheRead;
  }
  return sum;
}, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

function renderSummary(usageJson: Record<string, unknown> | null, tree?: Partial<IssueCostSummary>) {
  const id = "captured-task";
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.issues.activity(id), []);
  client.setQueryData(queryKeys.issues.runs(id), usageJson ? [{ id: "captured-run", companyId: "capture", usageJson, resultJson: null }] : []);
  client.setQueryData(queryKeys.issues.approvals(id), []);
  if (tree) client.setQueryData(queryKeys.issues.costSummary(id), {
    issueId: id, issueCount: 2, includeDescendants: true, costCents: 0, inputTokens: 0,
    cachedInputTokens: 0, outputTokens: 0, runCount: 0, runtimeMs: 0, ...tree,
  });
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}>
    <IssueDetailActivityTab issue={{ id } as Issue} issueId={id} companyId="capture" issueStatus="done"
      childIssues={[]} agentMap={new Map()} hasLiveRuns={false} currentUserId={null}
      userProfileMap={new Map()} pendingApprovalAction={null} onApprovalAction={() => {}} />
  </QueryClientProvider>);
  client.clear();
  const el = document.createElement("div");
  el.innerHTML = markup;
  return { markup, text: el.textContent ?? "" };
}

describe("Task Activity Cost Summary completeness (PR #20 RFL)", () => {
  it("qualifies the real compaction capture's 449.5k measured tokens", () => {
    const { markup, text } = renderSummary({ ...measured, provider: "anthropic", model: "paperclip/claude-opus-5-5", accountingUsageLost: true });
    expect(text).toContain("Tokens 449.5k");
    expect(text).toContain("Additional usage unknown");
    if (process.env.COST_SUMMARY_PROOF_DIR) {
      mkdirSync(process.env.COST_SUMMARY_PROOF_DIR, { recursive: true });
      writeFileSync(`${process.env.COST_SUMMARY_PROOF_DIR}/task-activity.html`, markup);
    }
  });

  it.each([0, 0.25])("qualifies direct measured $%s, even without tokens", costUsd => {
    const { text } = renderSummary({ accountingUsageLost: true, costUsd });
    expect(text).toContain("Additional usage unknown");
    expect(text).not.toContain("No cost data yet");
  });

  it("qualifies sub-task rollup tokens and money with the shared marker", () => {
    const { text } = renderSummary(null, { ...measured, costCents: 25, accountingUsageLost: true });
    expect(text).toContain("Including sub-tasks");
    expect(text).toContain("Tokens 449.5k");
    expect(text).toContain("Additional usage unknown");
  });

  it("qualifies an unknown zero tree subtotal without inventing tokens", () => {
    const { text } = renderSummary(null, { issueCount: 1, accountingUsageLost: true });
    expect(text).toContain("Additional usage unknown");
    expect(text).not.toContain("No cost data yet");
  });

  it("does not infer missing usage from explanatory prose or absent/false flags", () => {
    for (const accountingUsageLost of [undefined, false, "true"]) {
      const { text } = renderSummary({ ...measured, accountingUsageLost, pricingProvenance: { evidence: "Additional usage unknown" } },
        { costCents: 25, accountingUsageLost: false });
      expect(text).not.toContain("Additional usage unknown");
    }
  });
});
