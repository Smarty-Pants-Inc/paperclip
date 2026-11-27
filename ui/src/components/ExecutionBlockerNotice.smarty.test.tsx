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

const failed: TaskInterruptionPresentation = {
  intentId: "intent", responsibility: "system", state: "failed", nextRetryAt: null,
  canRetry: true, userAction: null, sourceRunIds: ["source"], observedRunId: "source",
};
describe("ordinary task interruption", () => {
  let root: Root;
  let container: HTMLDivElement;
  const retry = vi.fn();
  beforeEach(() => {
    retry.mockReset(); container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  it.each(["personStop"])("does not call a person's %s a failed conversation resume", async key => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} observedStatus="failed"
      observedResultJson={{ [key]: { requestedAt: "2026-11-24T20:00:00Z" } }} canRetry onRetry={retry} />));
    expect(container.textContent).not.toContain("Couldn't resume this conversation");
  });

  it("still reports a failed resume when no person stopped the failed run (a budget cancel's startup fence included)", async () => {
    await act(async () => root.render(<ExecutionBlockerNotice presentation={failed} observedStatus="failed" observedResultJson={{ startupCancellation: { requestedAt: "2026-11-24T20:00:00Z" } }} canRetry onRetry={retry} />));
    expect(container.textContent).toContain("Couldn't resume this conversation");
  });
});
