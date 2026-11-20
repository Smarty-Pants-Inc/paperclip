// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThreadView } from "./TaskChatThreadView";
import { TaskChatPresentationProvider } from "./presentation-mode";
import type { TaskChatItem } from "./task-chat-model";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

// Two of the person's messages (M1, M2) failed in ONE run; each has its own
// card. Retry on a card must carry that card's message only.
const card = (messageId: string, quote: string): TaskChatItem => ({
  id: `card-${messageId}`,
  kind: "message",
  author: "system",
  text: "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.",
  presentation: { kind: "system_notice", title: "Your message wasn't answered" },
  metadata: {
    version: 1,
    sourceRunId: "failed-run",
    authorizationReason: `unanswered_message:${messageId}`,
    sections: [{ title: "Your message", rows: [{ type: "key_value", label: "Message", value: quote }] }],
  },
} as TaskChatItem);

const items: TaskChatItem[] = [
  { id: "failed-run:failure", kind: "marker", variant: "interrupted", label: "Run failed", collapsible: true, runId: "failed-run" },
  card("M1", "first request"),
  card("M2", "second request"),
];

describe("per-message Retry (one card per owed message)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  const render = (mode: "production" | "streamlined", retry: (runId: string, messageId?: string) => void, pending: string | null = null) =>
    flushSync(() => root!.render(
      <ThemeProvider>
        <TaskChatPresentationProvider mode={mode}>
          <TaskChatThreadView scroll={false} onRetryFailedRun={retry} retryFailedRunId={pending} items={items} />
        </TaskChatPresentationProvider>
      </ThemeProvider>,
    ));
  const buttons = () => {
    for (const toggle of container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')) {
      flushSync(() => toggle.click());
    }
    return [...container.querySelectorAll<HTMLButtonElement>('[data-testid="task-chat-no-live-path-try-again"]')];
  };

  it.each(["production", "streamlined"] as const)("M2's Retry carries M2 only and M1's carries M1 only (%s)", async (mode) => {
    const retry = vi.fn();
    render(mode, retry);
    // Both cards stand, each with its own Retry; the run marker folds into them.
    expect(container.textContent).not.toContain("Run failed");
    const [m1, m2] = buttons();
    expect(buttons()).toHaveLength(2);
    flushSync(() => m2.click());
    await Promise.resolve();
    expect(retry).toHaveBeenLastCalledWith("failed-run", "M2");
    flushSync(() => m1.click());
    await Promise.resolve();
    expect(retry).toHaveBeenLastCalledWith("failed-run", "M1");
    expect(retry.mock.calls).toEqual([["failed-run", "M2"], ["failed-run", "M1"]]);
  });

  it.each(["production", "streamlined"] as const)("a pending M2 Retry disables only M2's card (%s)", (mode) => {
    render(mode, vi.fn(), "failed-run:M2");
    const [m1, m2] = buttons();
    expect(m1.disabled).toBe(false);
    expect(m2.disabled).toBe(true);
  });
});
