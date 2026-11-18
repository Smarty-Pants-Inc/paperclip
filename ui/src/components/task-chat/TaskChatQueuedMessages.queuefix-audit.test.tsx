// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueQueuedCommentQueue } from "@paperclipai/shared";
import type { DragEndEvent } from "@dnd-kit/core";

// Carried verbatim from 609e414's new audit rows; the queue-UX suite wins
// in the original file. Only the browser sensor boundary is substituted.
const dragSensor = vi.hoisted(() => ({ end: null as null | ((event: DragEndEvent) => void) }));
vi.mock("@dnd-kit/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return { ...actual, DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
    dragSensor.end = props.onDragEnd ?? null;
    return <actual.DndContext {...props} />;
  } };
});
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { reorderQueuedMessageEntries, TaskChatQueuedMessages } from "./TaskChatQueuedMessages";

const queue: IssueQueuedCommentQueue = {
  issueId: "issue-1",
  queueId: "wake-1",
  state: "deferred",
  targetRunId: "run-1",
  revision: "rev-1",
  protocol: "paperclip_runner_v1",
  steeringDisposition: "available",
  entries: ["First queued message", "Second queued message"].map(
    (body, position) => ({
      comment: {
        id: `comment-${position + 1}`,
        companyId: "company-1",
        issueId: "issue-1",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        body,
        presentation: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      position,
      canEdit: true,
      canDiscard: true,
    }),
  ),
};

describe("TaskChatQueuedMessages", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });
  function render(overrides: Partial<ComponentProps<typeof TaskChatQueuedMessages>> = {}) {
    const props = { queue, onEdit: vi.fn(), onReorder: vi.fn().mockResolvedValue(undefined),
      onSteer: vi.fn().mockResolvedValue(undefined), onDiscard: vi.fn().mockResolvedValue(undefined), ...overrides };
    flushSync(() => root.render(<MemoryRouter><ThemeProvider><TaskChatQueuedMessages {...props} /></ThemeProvider></MemoryRouter>));
    return props;
  }

  it("AUDIT offers mid-turn reorder handles for the Agent Chat per-message wake queue", () => {
    const entries = [queue.entries[0],
      { ...queue.entries[1], queueId: "wake-2", queueRevision: "rev-2" },
      { ...queue.entries[1], comment: { ...queue.entries[1].comment, id: "comment-3", body: "Third queued message" },
        queueId: "wake-3", queueRevision: "rev-3", position: 2 }];
    render({ queue: { ...queue, steeringDisposition: "unsupported", entries } });
    const handles = [...container.querySelectorAll<HTMLButtonElement>('[aria-label^="Reorder queued message:"]')];
    console.log("AUDIT QUEUE HANDLES", JSON.stringify(handles.map(button => ({ label: button.getAttribute("aria-label"), disabled: button.disabled, title: button.title }))));
    expect(handles).toHaveLength(3);
    expect(handles.map(button => button.disabled)).toEqual([false, false, false]);
  });

  it("AUDIT can calculate a reorder across the Agent Chat per-message wakes", () => {
    const entries = [queue.entries[0], { ...queue.entries[1], queueId: "wake-2", queueRevision: "rev-2" }];
    const reordered = reorderQueuedMessageEntries(entries, "comment-1", "comment-2");
    console.log("AUDIT QUEUE HELPER", JSON.stringify({ reordered }));
    expect(reordered?.map(entry => entry.comment.id)).toEqual(["comment-2", "comment-1"]);
  });

  describe.each(["ordinary", "card response", "Interrupt", "Stop", "capacity retry"] as const)("shown order across %s", kind => {
    it.each([false, true])("shows send order unless dragged, then exactly the submitted order (drag=%s)", async drag => {
      // The saved card itself stays immutable (the row above); these are
      // ordinary messages waiting behind the card-response turn.
      const entries = [queue.entries[0], { ...queue.entries[1], queueId: "wake-2", queueRevision: "rev-2" }];
      const candidate: IssueQueuedCommentQueue = { ...queue, entries,
        targetRunId: kind === "Stop" ? null : queue.targetRunId,
        steeringDisposition: "unsupported",
        ...(kind === "Stop" ? { executionWait: { reason: "stopped_by_person",
          message: "Stopped. These messages are waiting: Send them, or delete any first." } } : {}),
        ...(kind === "capacity retry" ? { executionWait: { reason: "heartbeat.daily_run_limit",
          message: "Waiting for capacity. Your messages are saved." } } : {}),
      };
      const props = render({ queue: candidate });
      const shown = () => [...container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')]
        .map(row => row.getAttribute("data-testid")!.replace("task-chat-queued-message-", ""));
      expect(shown()).toEqual(["comment-1", "comment-2"]);
      if (drag) {
        expect([...container.querySelectorAll<HTMLButtonElement>('[aria-label^="Reorder queued message:"]')]
          .map(button => button.disabled)).toEqual([false, false]);
        await act(async () => { dragSensor.end!({ active: { id: "comment-2" }, over: { id: "comment-1" } } as DragEndEvent); });
        expect(props.onReorder).toHaveBeenCalledWith(["comment-2", "comment-1"], "rev-1");
        expect(shown()).toEqual(["comment-2", "comment-1"]);
      } else {
        expect(props.onReorder).not.toHaveBeenCalled();
        expect(shown()).toEqual(["comment-1", "comment-2"]);
      }
      expect(props.onSteer).not.toHaveBeenCalled();
    });
  });
});
