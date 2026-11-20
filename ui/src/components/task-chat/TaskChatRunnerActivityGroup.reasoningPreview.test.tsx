// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { nativeRunEventsToTranscript } from "../transcript/native-run-events";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import { transcriptToTaskChatItems } from "./transcript-adapter";

const RUN_ID = "rf1-pi-run";
const THOUGHT_A = "Thought A checks the arithmetic before answering.";
const THOUGHT_B = "Thought B confirms the result.";

// Canonical native events emitted for Pi thinking content blocks. Keep the
// whitespace delta intact: event admission is not the preview selector's job.
function thinkingEvent(
  seq: number,
  eventType: "item.started" | "item.delta" | "item.completed",
  itemId: string,
  text: string,
): HeartbeatRunEvent {
  return {
    id: seq, companyId: "rf1-company", runId: RUN_ID, agentId: "rf1-agent",
    seq, eventType, stream: "system", level: "info", color: null, message: null,
    createdAt: new Date("2026-11-20T09:00:00Z"),
    payload: { prpEvent: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1,
      sourceEventId: `pi-event-${seq}`, sourceSeq: seq,
      sourceInstanceId: "pi-runner", sourceKind: "runner", runId: RUN_ID,
      normalizedSessionId: "pi-session", turnId: "pi-turn", itemId,
      eventType, priority: 1, emittedAt: `2026-11-20T09:00:0${seq}Z`,
      payload: { kind: "reasoning", channel: "detail", text },
    } },
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function renderEvents(events: HeartbeatRunEvent[]) {
  const transcript = nativeRunEventsToTranscript(events);
  const items = transcriptToTaskChatItems(transcript, { runId: RUN_ID, running: true });
  act(() => root.render(
    <MemoryRouter><ThemeProvider>
      <TaskChatRunnerTurn runId={RUN_ID} items={items} status="running" startedAtMs={null} reasoningDisplay="fold" />
    </ThemeProvider></MemoryRouter>,
  ));
  return transcript;
}
function preview() {
  return container.querySelector<HTMLElement>('[data-testid="task-chat-reasoning-preview"]');
}
function save(name: string) {
  if (!process.env.REASONFOLD_EVIDENCE_DIR) return;
  mkdirSync(process.env.REASONFOLD_EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(process.env.REASONFOLD_EVIDENCE_DIR, name + ".html"), container.outerHTML);
}

describe.each([390, 1440])("native Pi reasoning preview at %ipx", (width) => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    container.style.width = `${width}px`;
  });

  it("keeps A while B starts with a newline, then switches to B when text arrives", () => {
    const events = [
      thinkingEvent(1, "item.started", "thinking-0", ""),
      thinkingEvent(2, "item.delta", "thinking-0", THOUGHT_A),
      thinkingEvent(3, "item.completed", "thinking-0", THOUGHT_A),
    ];
    renderEvents(events);
    expect(preview()?.textContent).toBe(THOUGHT_A);
    save(`rf1-${width}-A`);

    events.push(
      thinkingEvent(4, "item.started", "thinking-1", ""),
      thinkingEvent(5, "item.delta", "thinking-1", "\n"),
    );
    const transcript = renderEvents(events);
    expect(transcript.at(-1)).toMatchObject({ kind: "thinking", itemId: "thinking-1", text: "\n" });
    save(`rf1-${width}-B-newline`);
    expect(preview()?.textContent).toBe(THOUGHT_A);
    expect(preview()?.style.webkitLineClamp).toBe("4");
    expect(preview()?.closest("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="task-chat-activity-viewport"]')?.textContent).toContain("Thinking");

    events.push(thinkingEvent(6, "item.delta", "thinking-1", THOUGHT_B));
    renderEvents(events);
    expect(preview()?.textContent).toBe(THOUGHT_B);
    expect(preview()?.textContent).not.toContain(THOUGHT_A);
    save(`rf1-${width}-B-text`);

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-activity-phase-toggle"]')!;
    act(() => toggle.click());
    expect(preview()).toBeNull();
    const detail = container.querySelector('[data-testid="task-chat-runner-activity-detail"]');
    expect(detail?.textContent).toContain(THOUGHT_A);
    expect(detail?.textContent).toContain(THOUGHT_B);
    save(`rf1-${width}-expanded`);
  });

  it("has no preview for an all-whitespace history and keeps the current Thinking label", () => {
    const transcript = renderEvents([
      thinkingEvent(1, "item.completed", "thinking-0", " \t\n"),
      thinkingEvent(2, "item.started", "thinking-1", ""),
      thinkingEvent(3, "item.delta", "thinking-1", "\n"),
    ]);
    expect(transcript.filter((entry) => entry.kind === "thinking")).toHaveLength(2);
    expect(preview()).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-activity-viewport"]')?.textContent).toContain("Thinking");
    save(`rf1-${width}-all-whitespace`);
  });
});
