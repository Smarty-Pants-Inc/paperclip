// @vitest-environment jsdom
// Independent requirement probes. The 10-second/remount probes render the real
// recovery card from a normal issue GET, without a ToastProvider.
import { readFileSync } from "node:fs";
import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { IssueRecoveryActionCard } from "./components/IssueRecoveryActionCard";
import { ToastProvider, useToastActions, type ToastInput } from "./context/ToastContext";
import { ToastViewport } from "./components/ToastViewport";
import { apiErrorFromResponse } from "./api/api-error";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("@/hooks/useWorkspaceIsolationControls", () => ({
  useWorkspaceIsolationControls: () => ({ hidden: new Set<string>(), loaded: true }),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const refusal = "The failed run changed before Try again was accepted. The recovery card remains unresolved; refresh the task and try again.";
const cardRefusal = "This recovery card was made for an older run. The task changed before Try again was accepted, so this card cannot retry the current task.";
const error = apiErrorFromResponse(new Response(null, { status: 409 }), {
  error: refusal, details: { code: "task_retry_source_changed" },
});
const payload: ToastInput = { title: "Recovery resolution failed", body: error.message, tone: "error" };

function readNormalGetCard(): IssueRecoveryAction {
  const evidenceDir = process.env.JUDGE_EVIDENCE_DIR;
  if (!evidenceDir) throw new Error("JUDGE_EVIDENCE_DIR must contain the server judge's normal GET fixture");
  return JSON.parse(readFileSync(`${evidenceDir}/refused-card-from-get.json`, "utf8")) as IssueRecoveryAction;
}

describe("Judge: native-continuation recovery refusal stays visible on the card", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let pushToast: (input: ToastInput) => string | null;
  function Actions() { pushToast = useToastActions().pushToast; return null; }
  function mountToast() {
    root = createRoot(container);
    act(() => root!.render(<ToastProvider><Actions /><ToastViewport /></ToastProvider>));
  }
  function mountFromNormalGet() {
    const action = readNormalGetCard();
    root = createRoot(container);
    const queryClient = new QueryClient();
    act(() => root!.render(
      <QueryClientProvider client={queryClient}>
        <IssueRecoveryActionCard action={action} onResolve={() => {}} />
      </QueryClientProvider>,
    ));
  }
  function expectRefusalAndAvailableAction() {
    expect(container.querySelector('[data-testid="task-retry-source-refusal"]')?.textContent).toContain(cardRefusal);
    const resolve = container.querySelector<HTMLButtonElement>('[data-testid="recovery-action-resolve-trigger"]');
    expect(resolve).not.toBeNull();
    expect(resolve!.disabled).toBe(false);
  }
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    container.remove();
    localStorage.clear();
    vi.useRealTimers();
  });
  it("the existing error contract displays the concrete refusal immediately", () => {
    mountToast();
    act(() => { pushToast(payload); vi.advanceTimersByTime(30); });
    expect(container.textContent).toContain(refusal);
    expect(container.querySelector('aside[aria-live="polite"]')).not.toBeNull();
  });
  it("the only refusal explanation must not disappear after ten seconds", () => {
    mountFromNormalGet();
    expect(localStorage.length).toBe(0);
    expectRefusalAndAvailableAction();
    act(() => { vi.advanceTimersByTime(10_001); });
    console.info("JUDGE refusal card after TTL", { text: container.textContent, elapsedMs: 10_001 });
    expectRefusalAndAvailableAction();
  });
  it("the refusal explanation must survive a new page/provider mount", () => {
    mountFromNormalGet();
    expect(localStorage.length).toBe(0);
    expectRefusalAndAvailableAction();
    act(() => root!.unmount());
    root = undefined;
    expect(localStorage.length).toBe(0);
    mountFromNormalGet();
    console.info("JUDGE refusal card after remount", { text: container.textContent });
    expectRefusalAndAvailableAction();
  });
});
