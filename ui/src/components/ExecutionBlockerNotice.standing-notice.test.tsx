// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import type { AnchorHTMLAttributes } from "react";
import { ExecutionBlockerNotice } from "./ExecutionBlockerNotice";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

// The held notice's one wording (server native-runtime/held-predecessor-notice-text.ts).
const HELD = "Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.";
const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["source"], observedRunId: "source",
};

// One component renders the chat task-status card on phone and desktop (IssueDetail).
describe("chat card with a standing notice (C9 G1)", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (presentation: TaskInterruptionPresentation) =>
    act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={retry} />));

  it("shows the standing notice instead of the generic text, with no Retry", async () => {
    await render({ ...failed, canRetry: false, notice: { code: "native_prior_owner_held", text: HELD } });
    expect(container.querySelector('[data-testid="task-execution-notice"]')?.textContent).toBe(HELD);
    expect(container.textContent).not.toContain("Couldn’t finish this attempt");
    expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows the notice over a Retry wait message", async () => {
    await render({ ...failed, canRetry: false, notice: { code: "native_prior_owner_held", text: HELD },
      retryWait: { reason: "workspace_repair_required", message: "Retry is waiting for Paperclip to recover the saved files. Your message is saved." } });
    expect(container.textContent).toContain(HELD);
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps a re-send-safe notice's Retry", async () => {
    const text = "Your message wasn't answered (error: unclassified_failure). Sending it again is safe; if it fails again, assign this agent a new task.";
    await render({ ...failed, canRetry: true, notice: { code: "unclassified_failure", text } });
    expect(container.textContent).toContain(text);
    expect(container.querySelector('[data-testid="task-execution-retry"]')?.textContent).toBe("Retry");
  });

  it("shows the notice beside a provider failure, with no Retry", async () => {
    await render({ ...failed, canRetry: false, notice: { code: "native_prior_owner_held", text: HELD },
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "openai", phase: "turn", category: "overloaded",
        message: "The provider is overloaded.", retryability: "transient" } });
    expect(container.textContent).toContain(HELD);
    expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
  });

  it("keeps the generic text and Retry with no notice", async () => {
    await render(failed);
    expect(container.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(container.querySelector('[data-testid="task-execution-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-execution-retry"]')?.textContent).toBe("Retry");
  });
  // C1 (RFL 3x4): every branch that renders the card's Retry obeys presentation.canRetry=false.
  const refused = { ...failed, canRetry: false, notice: { code: "native_prior_owner_held", text: HELD } };
  const renderWith = (props: { error?: Error; takingLonger?: boolean }, presentation: TaskInterruptionPresentation) =>
    act(async () => root.render(<ExecutionBlockerNotice presentation={presentation} canRetry onRetry={retry} {...props} />));
  it.each([
    ["error", { error: new Error("Retry request failed") }],
    ["takingLonger", { takingLonger: true }],
  ] as const)("(C1) the %s branch shows no Retry over a standing refusal and keeps the notice", async (_branch, props) => {
    await renderWith(props, refused);
    expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="task-execution-notice"]')?.textContent).toBe(HELD);
  });
  it.each([
    ["error", { error: new Error("Retry request failed") }],
    ["takingLonger", { takingLonger: true }],
  ] as const)("(C1) the %s branch shows no Retry when canRetry=false without a notice", async (_branch, props) => {
    await renderWith(props, { ...failed, canRetry: false });
    expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
  });
  it.each([
    ["error", { error: new Error("Retry request failed") }],
    ["takingLonger", { takingLonger: true }],
  ] as const)("(C1 control) the %s branch keeps Retry when the card allows it", async (_branch, props) => {
    await renderWith(props, failed);
    expect(container.querySelector('[data-testid="task-execution-retry"]')?.textContent).toBe("Retry");
  });
  it("(C1) the provider-failure branch shows no Retry when canRetry=false", async () => {
    await render({ ...refused, providerFailure: { kind: "rate_limited", provider: "openai", message: "Rate limited" } } as never);
    expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
  });
});
