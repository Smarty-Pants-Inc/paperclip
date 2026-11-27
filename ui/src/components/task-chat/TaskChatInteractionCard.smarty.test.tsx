// @vitest-environment jsdom
// Fork-only native review regressions; upstream's pruned general card suite stays deleted.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import type { IssueThreadInteraction, RequestConfirmationInteraction } from "@/lib/issue-thread-interactions";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TaskChatInteractionCard } from "./TaskChatInteractionCard";
import { IssueThreadInteractionCard } from "../IssueThreadInteractionCard";
import { ResumeReviewAction } from "../ResumeReviewAction";
import type { TaskChatInteractionItem } from "./task-chat-model";
const coordinator = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: coordinator.enabled, loaded: true }),
}));
vi.mock("@/lib/router", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/router")>(),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));
// Only the classic Revise editor is a boundary; the cards and ResumeReviewAction stay real.
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    <textarea value={value} onChange={event => onChange(event.target.value)} />,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function createRequestConfirmation(
  overrides: Partial<RequestConfirmationInteraction> = {},
): RequestConfirmationInteraction {
  return {
    id: "confirmation-1",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Approve the plan",
    summary: "Review and approve the latest plan.",
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:01:00.000Z"),
    resolvedAt: null,
    payload: {
      version: 1,
      prompt: "Approve the plan?",
    },
    result: null,
    ...overrides,
  };
}

function interactionItem(
  interaction: IssueThreadInteraction,
): TaskChatInteractionItem {
  return {
    id: `interaction:${interaction.id}`,
    kind: "interaction",
    interaction,
  };
}

describe("TaskChatInteractionCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    coordinator.enabled = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it.each([undefined, false, true].flatMap(canResumeReview =>
    (["timeline", "takeover"] as const).map(presentation => ({ canResumeReview, presentation }))))(
    "shows Resume review only with the server capability ($canResumeReview, $presentation)", ({ canResumeReview, presentation }) => {
    const interaction = createRequestConfirmation({ title: "Review requested", canResumeReview,
      payload: { version: 1, prompt: "Review the completed work.", target: { type: "custom", key: "native_completion_review", revisionId: "decision-1" } } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
      <TaskChatInteractionCard item={interactionItem(interaction)} presentation={presentation} showPendingRequest />
    </ThemeProvider></TooltipProvider></QueryClientProvider>));
    expect(Array.from(container.querySelectorAll("button")).some(button => button.textContent === "Resume review")).toBe(canResumeReview === true);
  });

  it.each(["timeline", "takeover"] as const)("resumes the same review from its %s page card without resolving the card", async presentation => {
    const request = vi.spyOn(issuesApi, "resumeReview").mockResolvedValue({ wakeId: "resume-wake" });
    onTestFinished(() => request.mockRestore());
    const accept = vi.fn(), reject = vi.fn();
    const interaction = createRequestConfirmation({ canResumeReview: true, title: "Review requested" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "review-operator" } });
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
      <TaskChatInteractionCard item={interactionItem(interaction)} presentation={presentation} showPendingRequest onAcceptInteraction={accept} onRejectInteraction={reject} />
    </ThemeProvider></TooltipProvider></QueryClientProvider>));
    const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Resume review")!;
    await act(async () => { button.click(); });
    await act(async () => { await vi.waitFor(() => expect(request).toHaveBeenCalledWith(interaction.issueId, interaction.id)); });
    expect(accept).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  // catch: rfl-0481v2-READ.md MUST 1 — the pending body kept its band,
  // but switching the real parent to a closed receipt removed it entirely.
  it.each([false, true].flatMap(enabled =>
    (["timeline", "takeover", "classic"] as const).flatMap(presentation =>
      (["accepted", "rejected", "cancelled", "expired"] as const).map(status => ({ enabled, presentation, status })))))(
    "keeps one native resume band across pending → $status and remount ($presentation, coordinator=$enabled)",
    ({ enabled, presentation, status }) => {
      coordinator.enabled = enabled;
      const interaction = createRequestConfirmation({ canResumeReview: true,
        payload: { version: 1, prompt: "Review the work", target: { type: "custom", key: "native_completion_review", revisionId: "decision-1" } } });
      const client = new QueryClient();
      const render = (card: RequestConfirmationInteraction, version = 0) => flushSync(() => root.render(
        <QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
          <section key={version}>
            {presentation === "classic" ? <IssueThreadInteractionCard interaction={card} />
              : <TaskChatInteractionCard item={interactionItem(card)} presentation={presentation} showPendingRequest />}
          </section>
          <p data-following-log>Following log content</p>
        </ThemeProvider></TooltipProvider></QueryClientProvider>));
      render(interaction);
      expect(container.querySelectorAll('[data-resume-review-slot]')).toHaveLength(1);
      const footprint = container.querySelector('[data-resume-review-slot]')!.className;
      const resolved = { ...interaction, status, canResumeReview: false };
      render(resolved);
      for (const version of [0, 1]) {
        render(resolved, version);
        expect(container.querySelectorAll('[data-resume-review-slot]')).toHaveLength(1);
        const slot = container.querySelector('[data-resume-review-slot]')!;
        expect(slot.className).toBe(footprint);
        expect(slot.closest("details")).toBeNull(); // closed receipts cannot hide the band
        expect(slot.textContent).toBe("");
        expect(container.querySelector('[data-following-log]')!.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      }
    },
  );

  it("keeps non-native resolved confirmations free of resume bands", () => {
    flushSync(() => root.render(<TooltipProvider><ThemeProvider>
      <TaskChatInteractionCard item={interactionItem(createRequestConfirmation({ status: "accepted" }))} />
    </ThemeProvider></TooltipProvider>));
    expect(container.querySelector('[data-resume-review-slot]')).toBeNull();
  });

  it("keeps the native review action footprint through eligibility changes and reload", () => {
    const interaction = createRequestConfirmation({ canResumeReview: true,
      payload: { version: 1, prompt: "Review the work", target: { type: "custom", key: "native_completion_review", revisionId: "decision-1" } } });
    const client = new QueryClient();
    const render = (canResumeReview: boolean | undefined) => flushSync(() => root.render(
      <QueryClientProvider client={client}><ResumeReviewAction interaction={{ ...interaction, canResumeReview }} /></QueryClientProvider>));
    render(undefined);
    const slot = container.querySelector('[data-resume-review-slot]');
    expect(slot).not.toBeNull();
    const footprint = slot!.className;
    for (const capability of [true, false, undefined, true]) {
      render(capability);
      expect(container.querySelector('[data-resume-review-slot]')).toBe(slot);
      expect(slot!.className).toBe(footprint);
      expect(container.querySelectorAll('button')).toHaveLength(capability === true ? 1 : 0);
    }
  });

  it("shares pending resume work between timeline and open-card views, including same-turn presses", async () => {
    let finish!: (result: { wakeId: string }) => void;
    const request = vi.spyOn(issuesApi, "resumeReview").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    onTestFinished(() => request.mockRestore());
    const interaction = createRequestConfirmation({ canResumeReview: true });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "review-operator" } });
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
      <TaskChatInteractionCard item={interactionItem(interaction)} presentation="timeline" showPendingRequest />
      <TaskChatInteractionCard item={interactionItem(interaction)} presentation="takeover" showPendingRequest />
    </ThemeProvider></TooltipProvider></QueryClientProvider>));
    const buttons = Array.from(container.querySelectorAll("button")).filter(button => button.textContent === "Resume review");
    expect(buttons).toHaveLength(2);
    try {
      await act(async () => { buttons[0].click(); buttons[1].click(); });
      await act(async () => { await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1)); });
      await act(async () => { await vi.waitFor(() => expect(buttons.every(button => button.disabled)).toBe(true)); });
    } finally {
      await act(async () => { finish?.({ wakeId: "resume-wake" }); });
    }
  });

  it("keeps the slot after success and reload, and enables a later Stop of the same review", async () => {
    const request = vi.spyOn(issuesApi, "resumeReview").mockResolvedValue({ wakeId: "resume-wake" });
    onTestFinished(() => request.mockRestore());
    const interaction = createRequestConfirmation({ canResumeReview: true,
      payload: { version: 1, prompt: "Review the work", target: { type: "custom", key: "native_completion_review", revisionId: "decision-1" } } });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "review-operator" } });
    const key = queryKeys.issues.interactions(interaction.issueId);
    client.setQueryData(key, [interaction]);
    function CachedCard() {
      const { data = [] } = useQuery<RequestConfirmationInteraction[]>({ queryKey: key, enabled: false });
      return data[0] ? <ResumeReviewAction interaction={data[0]} /> : null;
    }
    const render = (version: number) => flushSync(() => root.render(<QueryClientProvider client={client}><CachedCard key={version} /></QueryClientProvider>));
    render(0);
    const slot = container.querySelector('[data-resume-review-slot]')!;
    await act(async () => { container.querySelector('button')!.click(); });
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('button')).toBeNull()); });
    expect(container.querySelector('[data-resume-review-slot]')).toBe(slot);
    render(1); // Reload/remount using the authoritative post-resume capability.
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-resume-review-slot]')?.className).toBe(slot.className);
    await act(async () => { client.setQueryData(key, [{ ...interaction, canResumeReview: true }]); });
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('button')?.disabled).toBe(false)); });
    await act(async () => { container.querySelector('button')!.click(); });
    await act(async () => { await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2)); });
  });

  it("renders only one resume action when classic Revise is open", async () => {
    const interaction = createRequestConfirmation({ canResumeReview: true });
    const client = new QueryClient();
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><ThemeProvider>
      <IssueThreadInteractionCard interaction={interaction} onAcceptInteraction={vi.fn()} onRejectInteraction={vi.fn()} />
    </ThemeProvider></TooltipProvider></QueryClientProvider>));
    const revise = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Revise"));
    expect(revise).toBeDefined();
    await act(async () => { revise!.click(); });
    expect(Array.from(container.querySelectorAll("button")).filter(button => button.textContent === "Resume review")).toHaveLength(1);
  });

  it("hides Resume review on a resolved card even if a stale capability is present", () => {
    const interaction = createRequestConfirmation({ status: "accepted", canResumeReview: true });
    flushSync(() => root.render(<TooltipProvider><ThemeProvider>
      <TaskChatInteractionCard item={interactionItem(interaction)} presentation="timeline" />
    </ThemeProvider></TooltipProvider>));
    expect(container.textContent).not.toContain("Resume review");
  });
});
