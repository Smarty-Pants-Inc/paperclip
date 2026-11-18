// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueQueuedCommentEntry, IssueQueuedCommentQueue } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatQueuedMessages } from "./TaskChatQueuedMessages";

// Paul NOTE 6 waiting list, design revision 2 + judge D1-D5 + addendum 2.
function entry(id: string, body: string, extra: Partial<IssueQueuedCommentEntry> = {}): IssueQueuedCommentEntry {
  return {
    comment: {
      id, companyId: "company-1", issueId: "issue-1", authorType: "user", authorAgentId: null, authorUserId: "user-1",
      body, presentation: null, metadata: null, createdAt: new Date(), updatedAt: new Date(),
    },
    position: 0, canEdit: true, canDiscard: true, ...extra,
  };
}

function queueOf(entries: IssueQueuedCommentEntry[], extra: Partial<IssueQueuedCommentQueue> = {}): IssueQueuedCommentQueue {
  return {
    issueId: "issue-1", queueId: "wake-1", state: "deferred", targetRunId: "run-1", revision: "rev-1",
    protocol: "paperclip_runner_v1", steeringDisposition: "available",
    entries: entries.map((candidate, position) => ({ ...candidate, position })), ...extra,
  };
}

const five = () => queueOf([
  entry("m1", "One", { deliveryIntent: "steer" }),
  entry("m2", "Two", { deliveryIntent: "steer" }),
  entry("m3", "Three", { deliveryIntent: "queue" }),
  entry("m4", "Four", { deliveryIntent: "steer" }),
  entry("m5", "Five", { deliveryIntent: "queue" }),
]);

const withReset = () => queueOf([
  entry("m1", "Head", { deliveryIntent: "steer" }),
  entry("reset", "/new", { deliveryIntent: "queue", behindReset: true, queueId: "wake-2", queueRevision: "rev-2" }),
  entry("behind", "After reset", { deliveryIntent: "steer", behindReset: true, queueId: "wake-3", queueRevision: "rev-3" }),
]);

const drag = vi.hoisted(() => ({ end: null as null | ((event: any) => unknown) }));
vi.mock("@dnd-kit/core", async (original) => {
  const actual = await original<typeof import("@dnd-kit/core")>();
  const React = await import("react");
  return { ...actual, DndContext: (props: any) => {
    drag.end = props.onDragEnd;
    return React.createElement(actual.DndContext, props);
  } };
});

describe("TaskChatQueuedMessages: Steering and Queued sections", () => {
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
    const props = {
      queue: five(),
      onEdit: vi.fn(),
      onReorder: vi.fn().mockResolvedValue(undefined),
      onSteer: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn().mockResolvedValue(undefined),
      onInterrupt: vi.fn().mockResolvedValue(undefined),
      onSetIntent: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    flushSync(() => root.render(<MemoryRouter><ThemeProvider><TaskChatQueuedMessages {...props} /></ThemeProvider></MemoryRouter>));
    return props;
  }
  const q = (selector: string) => container.querySelector<HTMLElement>(selector);
  const button = (id: string) => q(`[data-testid="${id}"]`) as HTMLButtonElement | null;
  const rowIds = (section: string) => [...container.querySelectorAll<HTMLElement>(
    `[data-testid="task-chat-queued-section-${section}"] [data-testid^="task-chat-queued-message-"]`)]
    .map((row) => row.dataset.testid!.replace("task-chat-queued-message-", ""));

  it("JUDGE D1: drops into Steering refuse /new and behind-reset rows without any mutation", async () => {
    const props = render({ queue: withReset() });
    for (const id of ["reset", "behind"]) {
      await act(async () => { await drag.end!({ active: { id }, over: { id: "m1" } }); });
      expect(props.onReorder).not.toHaveBeenCalled();
      expect(props.onSetIntent).not.toHaveBeenCalled();
      expect(container.textContent).toContain(id === "reset" ? "/new always waits for this turn" : "this message is behind /new");
    }
  });

  it("JUDGE D1: moving a Queued row into nonempty Steering stores the server order and mode", async () => {
    const props = render();
    await act(async () => { await drag.end!({ active: { id: "m3" }, over: { id: "m2" } }); });
    expect(props.onReorder).toHaveBeenCalledWith(["m1", "m3", "m2", "m4", "m5"], "rev-1");
    expect(props.onSetIntent).toHaveBeenCalledWith("m3", "steer");
    expect(rowIds("steering")).toEqual(["m1", "m3", "m2", "m4"]);
  });

  // Keep reason: rf5's real empty-section drop and silently clamped message regressions.
  it("drops a Queued row into empty Steering at the head and stores Steer", async () => {
    const props = render({ queue: queueOf([
      entry("q1", "First queued", { deliveryIntent: "queue" }),
      entry("q2", "Second queued", { deliveryIntent: "queue" }),
    ]) });
    expect(q('[data-testid="task-chat-queued-drop-steering"]')).not.toBeNull();
    await act(async () => { await drag.end!({ active: { id: "q2" }, over: { id: "task-chat-queued-drop-steering" } }); });
    expect(props.onReorder).toHaveBeenCalledWith(["q2", "q1"], "rev-1");
    expect(props.onSetIntent).toHaveBeenCalledWith("q2", "steer");
    expect(rowIds("steering")).toEqual(["q2"]);
    expect(rowIds("queued")).toEqual(["q1"]);
  });

  it("an already-head Queue row can drop into empty Steering without changing its order", async () => {
    const props = render({ queue: queueOf([entry("q1", "First queued", { deliveryIntent: "queue" })]) });
    await act(async () => { await drag.end!({ active: { id: "q1" }, over: { id: "task-chat-queued-drop-steering" } }); });
    expect(props.onSetIntent).toHaveBeenCalledWith("q1", "steer");
    expect(rowIds("steering")).toEqual(["q1"]);
  });

  it.each(["reset", "behind"])("empty Steering refuses %s with the /new reason and no mutation", async (id) => {
    const props = render({ queue: queueOf(withReset().entries.slice(1)) });
    await act(async () => { await drag.end!({ active: { id }, over: { id: "task-chat-queued-drop-steering" } }); });
    expect(props.onReorder).not.toHaveBeenCalled();
    expect(props.onSetIntent).not.toHaveBeenCalled();
    expect(container.textContent).toContain(id === "reset" ? "/new always waits for this turn" : "this message is behind /new");
    expect(rowIds("steering")).toEqual([]);
  });

  it.each([
    { readOnly: true },
    { onSetIntent: undefined },
    { queue: queueOf([entry("q1", "Queued", { deliveryIntent: "queue" })], { steeringDisposition: "unsupported" }) },
  ])("empty Steering cannot mutate when unavailable: %j", async (overrides) => {
    const props = render({ queue: queueOf([entry("q1", "Queued", { deliveryIntent: "queue" })]), ...overrides });
    await act(async () => { await drag.end!({ active: { id: "q1" }, over: { id: "task-chat-queued-drop-steering" } }); });
    expect(props.onReorder).not.toHaveBeenCalled();
    if (props.onSetIntent) expect(props.onSetIntent).not.toHaveBeenCalled();
    expect(rowIds("steering")).toEqual([]);
  });

  it("a failed empty-Steering drop restores the row and shows the error", async () => {
    render({ queue: queueOf([entry("q1", "Queued", { deliveryIntent: "queue" })]),
      onReorder: vi.fn().mockRejectedValue(new Error("conflict")) });
    await act(async () => { await drag.end!({ active: { id: "q1" }, over: { id: "task-chat-queued-drop-steering" } }); });
    expect(rowIds("queued")).toEqual(["q1"]);
    expect(container.textContent).toContain("Previous order restored");
  });

  it("clicking the preview expands the FULL long message and collapses again", () => {
    const text = "A paragraph that must remain readable in full. ".repeat(30) + "Final uncut words.";
    render({ queue: queueOf([entry("long", text, { deliveryIntent: "queue" })]) });
    const preview = q('[data-testid="task-chat-queued-preview-long"]')!;
    expect(preview).not.toBeNull();
    expect(preview.getAttribute("aria-expanded")).toBe("false");
    expect(preview.getAttribute("aria-label")).toContain(text);
    expect(preview.querySelector(".line-clamp-2")).not.toBeNull();
    flushSync(() => preview.click());
    expect(preview.getAttribute("aria-expanded")).toBe("true");
    expect(preview.querySelector(".line-clamp-2")).toBeNull();
    expect(preview.textContent).toBe(text);
    flushSync(() => preview.click());
    expect(preview.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["Enter", " "])("the message preview also expands with keyboard %j", (key) => {
    render();
    const preview = q('[data-testid="task-chat-queued-preview-m1"]')!;
    expect(preview).not.toBeNull();
    expect(preview.tabIndex).toBe(0);
    flushSync(() => preview.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(preview.getAttribute("aria-expanded")).toBe("true");
  });

  it("org: lists every one of five waiting messages, never collapsing to one row", () => {
    render();
    expect(container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')).toHaveLength(5);
  });

  it("shows Steering (the head of the order) above Queued, each with a count", () => {
    render();
    expect(rowIds("steering")).toEqual(["m1", "m2"]);
    expect(rowIds("queued")).toEqual(["m3", "m4", "m5"]);
    expect(q('[data-testid="task-chat-queued-count-steering"]')?.textContent).toBe("2");
    expect(q('[data-testid="task-chat-queued-count-queued"]')?.textContent).toBe("3");
    expect(q('[data-testid="task-chat-queued-section-steering"] h3')?.textContent).toContain("Always first. Delivered at the agent's next step, top first");
    expect(q('[data-testid="task-chat-queued-section-queued"] h3')?.textContent).toContain("Sent after the agent finishes this turn, top first");
  });

  it("gives every row a Steer/Queue toggle, Interrupt now, Edit and Delete, and no grey control without a reason", () => {
    render();
    for (const id of ["m1", "m3"]) {
      for (const control of ["mode", "interrupt", "edit", "discard"]) {
        const element = button(`task-chat-queued-${control}-${id}`);
        expect(element, `${control} on ${id}`).not.toBeNull();
        if (element!.disabled) expect(element!.title, `${control} on ${id}`).not.toBe("");
      }
    }
    expect(button("task-chat-queued-mode-m1")?.textContent).toContain("Queue");
    expect(button("task-chat-queued-mode-m3")?.textContent).toContain("Steer");
    expect(button("task-chat-queued-interrupt-m3")?.textContent).toContain("Interrupt now");
    expect(button("task-chat-queued-interrupt-m3")?.title).toBe("Stops the current step and sends this message first; the rest stay queued");
    expect(container.querySelector('[aria-label^="Queued message actions"]')).toBeNull();
    expect(button("task-chat-queued-mode-m1")?.querySelector(".lucide-arrow-left-right")).not.toBeNull();
    expect(button("task-chat-queued-interrupt-m3")?.querySelector(".lucide-zap")).not.toBeNull();
    for (const control of ["mode", "interrupt", "edit", "discard"]) {
      expect(button(`task-chat-queued-${control}-m3`)?.classList).toContain("border");
    }
    expect(button("task-chat-queued-edit-m3")?.textContent).toBe("");
    expect(button("task-chat-queued-edit-m3")?.getAttribute("aria-label")).toBe("Edit queued message: Three");
    expect(button("task-chat-queued-discard-m3")?.getAttribute("aria-label")).toBe("Delete queued message: Three");
  });

  it("the toggle moves a Queued row to the end of Steering and stores its mode", async () => {
    const props = render();
    await act(async () => { button("task-chat-queued-mode-m4")!.click(); });
    expect(props.onReorder).toHaveBeenCalledWith(["m1", "m2", "m4", "m3", "m5"], "rev-1");
    expect(props.onSetIntent).toHaveBeenCalledWith("m4", "steer");
    expect(rowIds("steering")).toEqual(["m1", "m2", "m4"]);
    await act(async () => { button("task-chat-queued-mode-m1")!.click(); });
    expect(props.onSetIntent).toHaveBeenLastCalledWith("m1", "queue");
  });

  it("Interrupt now sends that one message first", async () => {
    const props = render();
    await act(async () => { button("task-chat-queued-interrupt-m4")!.click(); });
    expect(props.onInterrupt).toHaveBeenCalledWith("m4");
  });

  it("D1: a /new row is Queue-only with its caption; rows behind it can't move to Steering", () => {
    render({ queue: withReset() });
    expect(rowIds("steering")).toEqual(["m1"]);
    expect(rowIds("queued")).toEqual(["reset", "behind"]);
    expect(button("task-chat-queued-mode-reset")).toBeNull();
    expect(q('[data-testid="task-chat-queued-reset-caption-reset"]')?.textContent).toBe("Starts a new conversation; always waits for this turn");
    expect(button("task-chat-queued-mode-behind")?.disabled).toBe(true);
    expect(button("task-chat-queued-mode-behind")?.title).toBe("Can't move to Steering: this message is behind /new");
    expect(button("task-chat-queued-grip-behind")?.disabled).toBe(true);
    expect(button("task-chat-queued-grip-behind")?.title).not.toBe("");
    expect(q('[data-testid="task-chat-queued-message-behind"]')?.textContent).toContain("Behind /new: can't steer");
  });

  it("addendum 2: Interrupt now is grey on a /new and on every row behind it, with the reason", () => {
    render({ queue: withReset() });
    expect(button("task-chat-queued-interrupt-m1")?.disabled).toBe(false);
    expect(button("task-chat-queued-interrupt-reset")?.disabled).toBe(true);
    expect(button("task-chat-queued-interrupt-reset")?.title).toBe("Starts a new conversation; it waits for this turn. Use Stop to end the turn now");
    expect(button("task-chat-queued-interrupt-behind")?.disabled).toBe(true);
    expect(button("task-chat-queued-interrupt-behind")?.title).toBe("Behind /new: interrupting would send it into the current conversation");
  });

  it("a row behind a /new deletes from its own wake", async () => {
    const props = render({ queue: withReset() });
    await act(async () => { button("task-chat-queued-discard-behind")!.click(); });
    expect(props.onDiscard).toHaveBeenCalledWith("behind", "rev-3", "wake-3");
  });

  it("D5: when the runner can't take steering, Steering rows stay listed, paused for the turn boundary", () => {
    render({ queue: { ...five(), steeringDisposition: "unsupported" } });
    expect(rowIds("steering")).toEqual(["m1", "m2"]);
    expect(q('[data-testid="task-chat-queued-steering-paused"]')?.textContent).toContain("Steering paused: will send after this turn");
    expect(button("task-chat-queued-mode-m1")?.disabled).toBe(false);
  });

  it("explains Steering 0 when the runner cannot take messages mid-turn", () => {
    render({ queue: queueOf([entry("q1", "Wait", { deliveryIntent: "queue" })], { steeringDisposition: "unsupported" }) });
    expect(q('[data-testid="task-chat-queued-count-steering"]')?.textContent).toBe("0");
    expect(container.textContent).toContain("This runner can't take messages mid-turn, so everything waits in the queue. Use Interrupt now to send one first.");
    expect(container.textContent).not.toContain("Drag a message here");
  });

  it("auto-steers only Steer-mode messages from the head: 'Steers in 5s', never a Queue-mode head", () => {
    render({ autoSteerDelayMs: 5_000, steerHeadOnly: true });
    expect(q('[data-testid="task-chat-queued-auto-steer-m1"]')?.textContent).toMatch(/Steers in [56]s/);
    flushSync(() => root.unmount());
    root = createRoot(container);
    render({ autoSteerDelayMs: 5_000, steerHeadOnly: true, queue: queueOf([
      entry("q1", "Wait", { deliveryIntent: "queue" }), entry("s1", "Steer", { deliveryIntent: "steer" }),
    ]) });
    expect(q('[data-testid^="task-chat-queued-auto-steer-"]')).toBeNull();
  });

  it("D4: editing a 'Steers in' row pauses its countdown", () => {
    render({ autoSteerDelayMs: 5_000, steerHeadOnly: true, editingCommentId: "m1" });
    expect(q('[data-testid="task-chat-queued-auto-steer-m1"]')).toBeNull();
    expect(q('[data-testid="task-chat-queued-paused-m1"]')?.textContent).toBe("Paused while editing");
  });

  it("D3: a read-only viewer sees every message and no controls", () => {
    render({ readOnly: true });
    expect(container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')).toHaveLength(5);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
