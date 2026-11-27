// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { useReasoningDisplay } from "./reasoning-display";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { TaskChatRequestHistoryContext } from "./TaskChatComposerTakeoverContext";
import type { TaskChatItem } from "./task-chat-model";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("fork reasoning presentation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.removeItem("paperclip.reasoning-display.reasoning-viewer-a");
    localStorage.removeItem("paperclip.reasoning-display.reasoning-viewer-b");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove();
    localStorage.removeItem("paperclip.reasoning-display.reasoning-viewer-a");
    localStorage.removeItem("paperclip.reasoning-display.reasoning-viewer-b");
  });
  const render = (items: TaskChatItem[], status = "running") => act(() => root.render(
    <MemoryRouter><ThemeProvider><TaskChatRequestHistoryContext.Provider value="issue-1">
      <TaskChatRunnerTurn runId="run-1" agentName="Runner" items={items} status={status} startedAtMs={Date.now() - 2000} />
    </TaskChatRequestHistoryContext.Provider></ThemeProvider></MemoryRouter>,
  ));
  it("keeps earlier commentary mounted when later commentary streams", () => {
    render([
      {
        id: "commentary",
        kind: "message",
        author: "agent",
        text: "I’ll inspect the card.",
        interstitial: true,
        channel: "progress",
        transcriptIndex: 1,
      },
      {
        id: "reasoning",
        kind: "thinking",
        lines: ["The saved preview can be reused."],
        streaming: true,
        channel: "summary",
        transcriptIndex: 2,
      },
    ]);
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("I’ll inspect the card.");

    render([
      {
        id: "commentary",
        kind: "message",
        author: "agent",
        text: "I’ll inspect the card.",
        interstitial: true,
        channel: "progress",
        transcriptIndex: 1,
      },
      {
        id: "reasoning",
        kind: "thinking",
        lines: ["The saved preview can be reused."],
        streaming: true,
        channel: "summary",
        transcriptIndex: 2,
      },
      {
        id: "commentary-later",
        kind: "message",
        author: "agent",
        text: "I’ve found the rendering seam.",
        interstitial: true,
        channel: "progress",
        transcriptIndex: 3,
      },
    ]);
    const commentary = container.querySelectorAll(
      '[data-testid="task-chat-phase-interstitial"]',
    );
    expect(commentary).toHaveLength(2);
    expect(commentary[0]?.textContent).toContain("I’ll inspect the card.");
    expect(commentary[1]?.textContent).toContain(
      "I’ve found the rendering seam.",
    );
    expect(
      container.querySelector('[data-testid="task-chat-runner-activity-list"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-thinking-inline"]')?.textContent)
      .toContain("The saved preview can be reused.");
  });

  it("shows all provider-authored reasoning inline without opening activity", () => {
    render([
      {
        id: "reasoning",
        kind: "thinking",
        lines: ["Inspecting the task state.", "Checking the steering path."],
        streaming: true,
        channel: "summary",
        transcriptIndex: 2,
      },
    ]);

    const prose = container.querySelector('[data-testid="task-chat-thinking-inline"]');
    expect(prose?.textContent).toContain("Inspecting the task state.");
    expect(prose?.textContent).toContain("Checking the steering path.");
    expect(prose?.classList.contains("italic")).toBe(true);
    expect(prose?.querySelector("button, ul")).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-runner-activity-list"]'),
    ).toBeNull();
  });

  it("keeps summary and detail reasoning inline in chronological order", () => {
    render([
      {
        id: "summary",
        kind: "thinking",
        lines: ["Inspect the current card."],
        streaming: false,
        channel: "summary",
        transcriptIndex: 1,
      },
      {
        id: "detail",
        kind: "thinking",
        lines: ["Keep the canonical revision atomic."],
        streaming: true,
        channel: "detail",
        transcriptIndex: 2,
      },
    ]);
    const prose = container.querySelectorAll('[data-testid="task-chat-thinking-inline"]');
    expect(prose).toHaveLength(2);
    expect(prose[0]?.textContent).toContain("Inspect the current card.");
    expect(prose[1]?.textContent).toContain("Keep the canonical revision atomic.");
    expect(container.querySelector('[data-testid="task-chat-activity-phase-toggle"]')).toBeNull();

  });

  it("keeps reasoning on either side of inspectable tool activity", () => {
    render([
      {
        id: "old-reasoning",
        kind: "thinking",
        lines: ["Inspect the current card."],
        streaming: true,
        transcriptIndex: 1,
      },
      {
        id: "read",
        kind: "tool",
        name: "Read files",
        rawName: "Read",
        status: "completed",
      },
      {
        id: "current-reasoning",
        kind: "thinking",
        lines: ["Verify the updated state."],
        streaming: true,
        transcriptIndex: 3,
      },
    ]);

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-activity-phase-toggle"]',
        )
        ?.click(),
    );

    const prose = container.querySelectorAll('[data-testid="task-chat-thinking-inline"]');
    expect(prose[0]?.textContent).toContain("Inspect the current card.");
    expect(prose[1]?.textContent).toContain("Verify the updated state.");
    const tools = container.querySelector('[data-testid="task-chat-activity-phase"]');
    expect(prose[0]?.compareDocumentPosition(tools!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(tools?.compareDocumentPosition(prose[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

  });

  it("stores Inline / Folded per viewer and updates mounted reasoning", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "reasoning-viewer-a" } });
    localStorage.setItem("paperclip.reasoning-display.reasoning-viewer-a", "folded");
    localStorage.setItem("paperclip.reasoning-display.reasoning-viewer-b", "folded");
    function Preference() {
      const preference = useReasoningDisplay("paperclip_runner");
      return <button data-testid="reasoning-preference" onClick={() => preference.setDisplay("inline")}>{preference.display}</button>;
    }
    const show = () => act(() => root.render(<QueryClientProvider client={client}><MemoryRouter><ThemeProvider>
      <Preference /><TaskChatRunnerTurn status="running" startedAtMs={null} items={[
        { id: "reason", kind: "thinking", lines: ["Visible provider reasoning."], streaming: true },
      ]} />
    </ThemeProvider></MemoryRouter></QueryClientProvider>));
    show();
    expect(container.querySelector('[data-testid="task-chat-thinking-inline"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="reasoning-preference"]')!.click());
    expect(container.querySelector('[data-testid="task-chat-thinking-inline"]')?.textContent).toContain("Visible provider reasoning.");
    expect(localStorage.getItem("paperclip.reasoning-display.reasoning-viewer-a")).toBe("inline");
    act(() => client.setQueryData(queryKeys.auth.session, { user: { id: "reasoning-viewer-b" } }));
    show();
    expect(container.querySelector('[data-testid="task-chat-thinking-inline"]')).toBeNull();
    expect(localStorage.getItem("paperclip.reasoning-display.reasoning-viewer-b")).toBe("folded");
    client.clear();
  });

  it("retains inline reasoning after the turn settles", () => {
    render(
      [
        {
          id: "reasoning",
          kind: "thinking",
          lines: ["Provider-authored trace"],
          channel: "summary",
          transcriptIndex: 1,
        },
      ],
      "succeeded",
    );
    expect(
      container.querySelector('[data-testid="task-chat-live-narration"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-header"]')
        ?.textContent,
    ).toContain("Worked for");
    expect(
      container.querySelector('[data-testid="task-chat-thinking-inline"]')
        ?.textContent,
    ).toContain("Provider-authored trace");
  });
});
