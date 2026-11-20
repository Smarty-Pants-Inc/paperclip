// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { transcriptToTaskChatItems } from "./transcript-adapter";
import { resolveReasoningDisplay, type ReasoningDisplay } from "./reasoning-display";

const REASONING = "17 + 25 = 42. I will post the answer after checking the arithmetic.\n\nThe full explanation remains available for inspection.\n\nA third paragraph.\n\nA fourth paragraph.\n\nA fifth paragraph is available when expanded.";
const ANSWER = "The answer is 42.";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
function save(name: string) {
  if (!process.env.REASONFOLD_EVIDENCE_DIR) return;
  mkdirSync(process.env.REASONFOLD_EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(process.env.REASONFOLD_EVIDENCE_DIR, name + ".html"), container.outerHTML);
}
function render(stage: "live" | "ended" | "settled", display: ReasoningDisplay, split = false) {
  const items = transcriptToTaskChatItems([
    { kind: "thinking", ts: "2026-11-20T09:00:01Z", itemId: "thought-1", text: REASONING },
    ...(split ? [
      { kind: "tool_call" as const, ts: "2026-11-20T09:00:02Z", name: "Read", input: { path: "README.md" }, toolUseId: "read-1" },
      { kind: "tool_result" as const, ts: "2026-11-20T09:00:03Z", toolUseId: "read-1", content: "Tool output stays folded", isError: false },
      { kind: "thinking" as const, ts: "2026-11-20T09:00:04Z", itemId: "thought-2", text: "Second full reasoning block." },
    ] : []),
    ...(stage === "live" ? [] : [{ kind: "assistant" as const, ts: "2026-11-20T09:00:05Z", text: ANSWER, channel: "final" as const }]),
  ], { running: stage !== "settled", runId: "reasonfold-run" });
  act(() => root.render(<MemoryRouter><ThemeProvider><TaskChatRunnerTurn runId="reasonfold-run" agentName="Assistant" items={items} status={stage === "settled" ? "succeeded" : "running"} startedAtMs={Date.parse("2026-11-20T09:00:00Z")} finishedAtMs={stage === "settled" ? Date.parse("2026-11-20T09:00:06Z") : null} reasoningDisplay={display} /></ThemeProvider></MemoryRouter>));
}
function click(button: HTMLButtonElement) { expect(button).not.toBeNull(); act(() => button.click()); }

describe.each([390, 1440])("T3 reasoning fold at %ipx", (width) => {
  beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); container.style.width = `${width}px`; });
  it("previews up to four lines live, expands the full trace, then folds work on settle with one answer outside", () => {
    const display = resolveReasoningDisplay({}, "agent-1", "paperclip_runner");
    render("live", display);
    const preview = container.querySelector<HTMLElement>('[data-testid="task-chat-reasoning-preview"]');
    expect(preview).not.toBeNull();
    expect(preview?.style.webkitLineClamp).toBe("4");
    expect(preview?.textContent).toContain("17 + 25 = 42");
    expect(preview?.closest("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Thinking");
    save(`runner-${width}-closed`);
    click(preview!.closest("button")!);
    expect(container.querySelector('[data-testid="task-chat-reasoning-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-runner-activity-detail"]')?.textContent).toContain("A fifth paragraph is available when expanded.");
    save(`runner-${width}-open`);
    click(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-activity-phase-toggle"]')!);
    expect(container.querySelector('[data-testid="task-chat-runner-activity-detail"]')).toBeNull();
    render("ended", display);
    expect(container.textContent).toContain("Thought");
    render("settled", display);
    expect(container.textContent).not.toContain("17 + 25");
    expect(container.textContent?.split(ANSWER)).toHaveLength(2);
    const worked = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-work-toggle"]')!;
    expect(worked?.textContent).toContain("Worked for 6s");
    expect(worked?.getAttribute("aria-expanded")).toBe("false");
    save(`runner-${width}-settled`);
    click(worked);
    expect(worked.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="task-chat-turn-timeline"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.closest('[data-testid="task-chat-turn-timeline"]')).toBeNull();
    click(worked);
    act(() => root.unmount()); root = createRoot(container);
    render("settled", display);
    expect(container.textContent).not.toContain("17 + 25");
    expect(container.textContent?.split(ANSWER)).toHaveLength(2);
    save(`runner-${width}-remount`);
  });
  it("keeps reasoning-only and tool-separated blocks in provider order inside the unchanged activity history", () => {
    render("live", resolveReasoningDisplay({}, "agent-1", "paperclip_runner"));
    expect(container.querySelector('[data-testid="task-chat-final-response"]')).toBeNull();
    render("live", "fold", true);
    expect(container.querySelector('[data-testid="task-chat-reasoning-preview"]')?.textContent).toContain("Second full reasoning block.");
    click(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-activity-phase-toggle"]')!);
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-activity-item-id]'));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Thought");
    expect(rows[1]?.textContent).toContain("README.md");
    expect(rows[2]?.textContent).toContain("Thinking");
    expect(container.textContent).not.toContain("Tool output stays folded");
  });
  it("keeps a reasoning-only settled turn inspectable and does not invent a reply", () => {
    const items = transcriptToTaskChatItems([
      { kind: "thinking", ts: "2026-11-20T09:00:01Z", itemId: "only-thought", text: REASONING },
    ], { runId: "only-thought-run", running: false });
    act(() => root.render(<MemoryRouter><ThemeProvider><TaskChatRunnerTurn runId="only-thought-run" items={items} status="succeeded" startedAtMs={null} reasoningDisplay="fold" /></ThemeProvider></MemoryRouter>));
    expect(container.querySelector('[data-testid="task-chat-final-response"]')).toBeNull();
    expect(container.textContent).not.toContain("17 + 25");
    click(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-work-toggle"]')!);
    click(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-activity-phase-toggle"]')!);
    expect(container.textContent).toContain("A fifth paragraph is available when expanded.");
  });
  it("keeps the latest reasoning preview above the current tool", () => {
    const items = transcriptToTaskChatItems([
      { kind: "thinking", ts: "2026-11-20T09:00:01Z", itemId: "tool-thought", text: REASONING },
      { kind: "tool_call", ts: "2026-11-20T09:00:02Z", name: "Bash", input: { command: "git status" }, toolUseId: "tool-now" },
    ], { runId: "tool-now-run", running: true });
    act(() => root.render(<MemoryRouter><ThemeProvider><TaskChatRunnerTurn runId="tool-now-run" items={items} status="running" startedAtMs={null} reasoningDisplay="fold" /></ThemeProvider></MemoryRouter>));
    expect(container.querySelector('[data-testid="task-chat-reasoning-preview"]')?.textContent).toContain("17 + 25 = 42");
    expect(container.querySelector('[data-testid="task-chat-activity-viewport"]')?.textContent).toContain("git status");
    expect(container.querySelector('[data-testid="task-chat-runner-activity-detail"]')).toBeNull();
  });
  it("preserves an explicit saved inline preference live and settled", () => {
    const display = resolveReasoningDisplay({ "agent-1": "inline" }, "agent-1", "paperclip_runner");
    for (const stage of ["live", "settled"] as const) {
      render(stage, display);
      expect(container.querySelector('[data-reasoning-display="inline"]')?.textContent).toContain("17 + 25");
      expect(container.querySelector('[data-testid="task-chat-work-toggle"]')).toBeNull();
    }
  });
});
