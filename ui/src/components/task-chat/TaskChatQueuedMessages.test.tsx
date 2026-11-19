// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueQueuedCommentQueue, TaskInterruptionPresentation } from "@paperclipai/shared";
import { ExecutionBlockerNotice } from "@/components/ExecutionBlockerNotice";
import { mergePendingIssueQueuedComments } from "@/lib/issue-queued-comment-queue";
import { readCommentDelivery } from "@/api/comment-delivery";
import { commentsToTaskChatItems } from "./task-chat-adapter";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import {
  QUEUE_ROW_REORDER_EDIT_STEER_ENABLED,
  queueHeldByPersonStop,
  reorderQueuedMessageEntries,
  TaskChatQueuedMessages,
} from "./TaskChatQueuedMessages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

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

  function render(
    overrides: Partial<ComponentProps<typeof TaskChatQueuedMessages>> = {},
  ) {
    const props = {
      queue,
      onEdit: vi.fn(),
      onReorder: vi.fn().mockResolvedValue(undefined),
      onSteer: vi.fn().mockResolvedValue(undefined),
      onDiscard: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    flushSync(() => root.render(<MemoryRouter><ThemeProvider><TaskChatQueuedMessages {...props} /></ThemeProvider></MemoryRouter>));
    return props;
  }

  // SUPERSEDE-QUEUE-ROW-HIDE-1119 (org 10:19Z): in this build a queued row
  // offers only Delete and the row's Interrupt; drag (the grip), Edit (row
  // button + menu) and the per-row Steer are hidden behind
  // QUEUE_ROW_REORDER_EDIT_STEER_ENABLED until neworg-lead's Q1 brings their
  // server rows. Each row below that pinned drag/edit/steer is re-pinned, by
  // name, to this 'hidden in this build' check; its own body runs again when
  // the constant returns to true.
  async function pinHiddenInThisBuild(advance?: (ms: number) => Promise<void>) {
    const props = render({ queue, onInterrupt: vi.fn().mockResolvedValue(undefined), autoSteerDelayMs: 5_000 });
    expectQueuedRowsOnlyDeleteAndInterrupt();
    if (advance) await advance(10_000);
    expectQueuedRowsOnlyDeleteAndInterrupt();
    expect(props.onSteer).not.toHaveBeenCalled();
    expect(props.onEdit).not.toHaveBeenCalled();
    expect(props.onReorder).not.toHaveBeenCalled();
  }

  function expectQueuedRowsOnlyDeleteAndInterrupt() {
    for (const entry of queue.entries) {
      const id = entry.comment.id;
      const row = container.querySelector(`[data-testid="task-chat-queued-message-${id}"]`)!;
      expect(row.textContent).toContain(entry.comment.body);
      expect(row.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-discard-${id}"]`)?.disabled).toBe(false);
      expect(row.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-interrupt-${id}"]`)?.textContent).toBe("Interrupt");
      expect(row.querySelector('[aria-label^="Reorder queued message:"]')).toBeNull();
      expect(row.querySelector(`[data-testid="task-chat-queued-steer-${id}"]`)).toBeNull();
      expect(row.querySelector(`[data-testid="task-chat-queued-auto-steer-${id}"]`)).toBeNull();
      expect(row.querySelector('[title="Queued message actions"]')).toBeNull();
      expect([...row.querySelectorAll("button")].map(button => button.textContent?.trim() || button.getAttribute("aria-label")))
        .toEqual([`Interrupt`, `Discard queued message: ${entry.comment.body}`]);
    }
  }

  it("keeps saved input visible without duplicating the task status", () => {
    const message = "Waiting for the previous environment to stop. Your message will start automatically.";
    render({ queue: { ...queue, executionWait: { reason: "remote_cleanup", message } } });
    expect(container.textContent).not.toContain(message);
    expect(container.textContent).toContain("First queued message");
    render();
    expect(container.textContent).not.toContain(message);
  });

  it("says why a chat message held in the outbox waits, without offering queue actions", () => {
    const message = "CEO reached its daily run limit. Your message is saved and sends automatically when the limit resets at 00:00 UTC.";
    render({ queue: { ...queue, queueId: null, targetRunId: null, steeringDisposition: "unsupported",
      executionWait: { reason: "heartbeat.daily_run_limit", message },
      entries: queue.entries.slice(0, 1).map(entry => ({ ...entry, canEdit: false, canDiscard: false })) } });
    expect([...container.querySelectorAll('p[role="status"]')].map(node => node.textContent)).toEqual([message]);
    expect(container.textContent).toContain("First queued message");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')?.disabled ?? true).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-1"]')?.disabled).toBe(true);
  });

  it("renders each queued message once as a compact one-line row", () => {
    render();
    const pane = container.querySelector(
      '[data-testid="task-chat-queued-messages"]',
    );
    expect(pane?.classList).toContain("mx-3");
    expect(pane?.classList).toContain("rounded-b-none");
    expect(pane?.classList).toContain("border-b-0");
    expect(pane?.classList).toContain("-mb-px");
    expect(
      container.querySelectorAll('[data-testid^="task-chat-queued-message-"]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain("Second queued message");
  });

  // org 10:19Z: a queued row offers only the controls that work in this build.
  it.each([390, 1440])("in this build a queued row offers only Delete and Interrupt: no grip, no Edit, no Steer at %ipx", async (width) => {
    const saved = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
      window.dispatchEvent(new Event("resize"));
      vi.useFakeTimers({ now: new Date("2026-11-07T12:00:00Z") });
      const props = render({ queue, onInterrupt: vi.fn().mockResolvedValue(undefined), autoSteerDelayMs: 5_000 });
      expectQueuedRowsOnlyDeleteAndInterrupt();
      expect(container.textContent).not.toContain("Sending in");
      // No automatic steer fires from the bar either.
      await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve(); });
      expect(props.onSteer).not.toHaveBeenCalled();
      expectQueuedRowsOnlyDeleteAndInterrupt();
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click(); });
      expect(props.onInterrupt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: saved });
    }
  });

  it("renders every later-wake message but disables its row controls with a reason", async () => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    const entries = [queue.entries[0],
      { ...queue.entries[1], queueId: "wake-2", queueRevision: "rev-2" },
      { ...queue.entries[1], comment: { ...queue.entries[1].comment, id: "comment-3", body: "Third queued message" },
        queueId: "wake-3", queueRevision: "rev-3", position: 2 }];
    const props = render({ queue: { ...queue, steeringDisposition: "unsupported", entries },
      onInterrupt: vi.fn().mockResolvedValue(undefined) });
    expect(container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')).toHaveLength(3);
    expect(container.textContent).toContain("Third queued message");
    for (const id of ["comment-2", "comment-3"]) {
      const row = container.querySelector(`[data-testid="task-chat-queued-message-${id}"]`)!;
      expect(row.textContent).toContain("Edit and delete are available when this message reaches the front.");
      const discard = row.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-discard-${id}"]`)!;
      expect(discard.disabled).toBe(true);
      flushSync(() => discard.click());
      expect(row.querySelector<HTMLButtonElement>('[title="Queued message actions"]')?.disabled).toBe(true);
      expect(row.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-interrupt-${id}"]`)?.disabled).toBe(true);
    }
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-1"]')?.disabled).toBe(false);
    expect([...container.querySelectorAll<HTMLButtonElement>('[aria-label^="Reorder queued message:"]')].every(button => button.disabled)).toBe(true);
  });

  it("does not offer a reorder across distinct chat wakes", () => {
    const entries = [queue.entries[0], { ...queue.entries[1], queueId: "wake-2", queueRevision: "rev-2" }];
    expect(reorderQueuedMessageEntries(entries, "comment-1", "comment-2")).toBeNull();
  });

  it("renders queued Markdown and screenshot thumbnails without showing image syntax", () => {
    const body = "Check **mobile** and *desktop* with `pnpm verify`.\n\n![mobile.png](/api/attachments/mobile/content)\n![desktop.png](/api/attachments/desktop/content)";
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')!;
    expect(row.querySelector("strong")?.textContent).toBe("mobile");
    expect(row.querySelector("em")?.textContent).toBe("desktop");
    expect(row.querySelector("code")?.textContent).toBe("pnpm verify");
    expect([...row.querySelectorAll("img")].map(img => [img.alt, img.getAttribute("src")])).toEqual([
      ["mobile.png", "/api/attachments/mobile/content"],
      ["desktop.png", "/api/attachments/desktop/content"],
    ]);
    expect(row.textContent).not.toContain("![");
    expect(row.textContent).not.toContain("/api/attachments");
  });

  it("shows a thumbnail for an image-only queued message", () => {
    const body = "![screen.png](/api/attachments/screen/content)";
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    expect(container.querySelector('img[alt="screen.png"]')?.getAttribute("src")).toBe("/api/attachments/screen/content");
    expect(container.textContent).not.toContain(body);
  });

  it("only loads local attachment images and counts the remaining screenshots", () => {
    const urls = [
      "/api/attachments/first/content", "/api/assets/second/content?download=0",
      "/api/attachments/third/content", "/api/attachments/fourth/content",
      "https://other.example/api/attachments/pixel/content", "//other.example/pixel.png",
      "javascript:alert", "data:image/png;base64,AAAA", "/other/pixel.png",
      "/api/attachments/first/content/extra", "/api/attachments/first/content#fragment",
    ];
    const body = urls.map((url, index) => `![screen-${index}](${url})`).join("\n");
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')!;
    expect([...row.querySelectorAll("img")].map(image => image.getAttribute("src"))).toEqual(urls.slice(0, 3));
    expect(row.querySelector('[aria-label="Queued images"]')?.textContent).toBe("+1");
  });

  it("omits inline images from the compact text without exposing their URLs", () => {
    const body = "Check ![inline](/api/attachments/inline/content) then **retry**.";
    render({ queue: { ...queue, entries: [{ ...queue.entries[0], comment: { ...queue.entries[0].comment, body } }] } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')!;
    expect(row.querySelector("strong")?.textContent).toBe("retry");
    expect(row.textContent).toContain("Check  then retry.");
    expect(row.textContent).not.toContain("/api/attachments");
    expect(row.querySelector("img")).toBeNull();
  });

  it.each(["legacy", "native", "native-plan"] as const)("shows a read-only response and sends it only on click for %s", async (runtime) => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    const entry = { ...queue.entries[0], canEdit: false, canDiscard: false,
      comment: { ...queue.entries[0].comment, body: 'Accepted: Build the app\n\n{"revision": "v1"}' },
      source: { kind: "interaction" as const, interactionId: "confirmation-1", interactionKind: "request_confirmation",
        requiresFreshSession: runtime === "native-plan" } };
    const props = render({ queue: { ...queue, entries: [entry],
      protocol: runtime === "legacy" ? "legacy" : "paperclip_runner_v1" },
      onInterrupt: vi.fn().mockResolvedValue(undefined) });
    expect(props.onSteer).not.toHaveBeenCalled();
    expect(props.onInterrupt).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Accepted: Build the app");
    expect(container.textContent).not.toContain('"revision"');
    expect(container.querySelector<HTMLButtonElement>('[aria-label^="Reorder"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid^="task-chat-queued-discard-"]')?.disabled).toBe(true);
    expect(reorderQueuedMessageEntries([entry, queue.entries[1]], "comment-1", "comment-2")).toBeNull();
    const action = runtime === "native" ? "steer" : "interrupt";
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-${action}-comment-1"]`)!.click(); });
    if (action === "steer") expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    else expect(props.onInterrupt).toHaveBeenCalledOnce();
  });

  it("shows a declined connection request as readable text, never its raw JSON receipt (BUG-08)", () => {
    const receipt = JSON.stringify({ interactionId: "slack-1", kind: "connection_intent", status: "rejected",
      payload: { serviceSlug: "slack", serviceName: "Slack" }, result: { outcome: "declined" } }, null, 2);
    const entry = { ...queue.entries[0], canEdit: false, canDiscard: false,
      comment: { ...queue.entries[0].comment, id: "slack-1", body: `Rejected: Connect Slack\n\n${receipt}` },
      source: { kind: "interaction" as const, interactionId: "slack-1", interactionKind: "connection_intent",
        summary: "Declined: Slack connection" } };
    render({ queue: { ...queue, entries: [entry], steeringDisposition: "temporarily_unavailable" } });
    const row = container.querySelector('[data-testid="task-chat-queued-message-slack-1"]')!;
    const hoverAndLabels = [...row.querySelectorAll("[title], [aria-label]")]
      .flatMap((element) => [element.getAttribute("title"), element.getAttribute("aria-label")])
      .filter((text): text is string => Boolean(text));
    expect(hoverAndLabels.length).toBeGreaterThan(0);
    for (const text of hoverAndLabels) {
      expect(text).not.toContain("{");
      expect(text).not.toContain("interactionId");
    }
    expect(row.textContent).toContain("Declined: Slack connection");
    expect(row.querySelector('[title="Declined: Slack connection"]')).not.toBeNull();
  });

  it("reorders the complete queue and rewrites contiguous positions", () => {
    const next = reorderQueuedMessageEntries(
      queue.entries,
      "comment-2",
      "comment-1",
    );

    expect(next?.map((entry) => entry.comment.id)).toEqual([
      "comment-2",
      "comment-1",
    ]);
    expect(next?.map((entry) => entry.position)).toEqual([0, 1]);
  });

  it("removes the selected steering row before the provider acknowledges it", async () => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    const acknowledgement = deferred<void>();
    const props = render({
      onSteer: vi.fn().mockReturnValue(acknowledgement.promise),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-steer-comment-1"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain("Steering queued message.");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-2"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      render({ ...props, queue: { ...queue, entries: [...queue.entries] } });
    });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });
  });

  it("clears the entire interrupt queue immediately and restores it inline on failure", async () => {
    let rejectInterrupt!: (error: Error) => void;
    const interrupted = new Promise<void>((_, reject) => { rejectInterrupt = reject; });
    const props = render({ queue: { ...queue, protocol: "legacy", steeringDisposition: "unsupported" },
      onInterrupt: vi.fn().mockReturnValue(interrupted) });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click();
    });
    expect(props.onInterrupt).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
    await act(async () => { rejectInterrupt(new Error("Connection lost")); await interrupted.catch(() => undefined); });
    expect(container.querySelectorAll('[data-testid^="task-chat-queued-message-"]')).toHaveLength(2);
    expect(container.textContent).toContain("Couldn’t interrupt. Message is still queued.");
  });

  it.each(["steer", "interrupt"] as const)("shows a delivery error even when the queue becomes empty while %s is pending", async action => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (action === "steer" && !QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    const delivery = deferred<void>();
    const props = render({ queue: { ...queue, protocol: action === "interrupt" ? "legacy" : "paperclip_runner_v1" },
      onSteer: vi.fn().mockReturnValue(delivery.promise), onInterrupt: vi.fn().mockReturnValue(delivery.promise) });
    await act(async () => { container.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-${action}-comment-1"]`)!.click(); });
    await act(async () => { render({ ...props, queue: { ...props.queue, revision: "empty-poll", entries: [] } }); });
    await act(async () => { delivery.reject(new Error("Connection lost")); await delivery.promise.catch(() => undefined); });
    const error = action === "steer" ? "Couldn’t steer." : "Couldn’t interrupt.";
    expect([...container.querySelectorAll('[role="status"]')].some(status => status.textContent?.includes(error))).toBe(true);
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
  });

  it("does not restore a message discarded elsewhere while steering was pending", async () => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    let rejectSteer!: (error: Error) => void;
    const delivery = new Promise<void>((_, reject) => { rejectSteer = reject; });
    const props = render({ onSteer: vi.fn().mockReturnValue(delivery) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')!.click(); });
    await act(async () => { render({ ...props, queue: { ...queue, revision: "rev-2", entries: [queue.entries[1]] } }); });
    await act(async () => { rejectSteer(new Error("Queue changed")); await delivery.catch(() => undefined); });
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-2"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn’t steer.");
  });

  it("keeps a row queued when steering fails and announces the retryable state", async () => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    render({
      onSteer: vi.fn().mockRejectedValue(new Error("steering_timeout")),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-steer-comment-1"]',
        )
        ?.click();
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Couldn’t steer. Message is still queued.",
    );
  });

  it("disables steering when the provider does not advertise it", async () => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    render({ queue: { ...queue, steeringDisposition: "unsupported" } });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="task-chat-queued-steer-comment-1"]',
      )?.disabled,
    ).toBe(true);
  });

  it.each(["temporarily_unavailable", "unsupported"] as const)(
    "offers an explicit interrupt fallback when native steering is %s",
    async (steeringDisposition) => {
      const props = render({
        queue: { ...queue, steeringDisposition },
        onInterrupt: vi.fn().mockResolvedValue(undefined),
      });
      const interrupt = container.querySelector<HTMLButtonElement>(
        '[data-testid="task-chat-queued-interrupt-comment-1"]',
      );
      expect(interrupt).not.toBeNull();
      expect(interrupt!.disabled).toBe(false);
      expect(interrupt!.textContent).toContain("Interrupt");
      await act(async () => { interrupt!.click(); });
      expect(props.onInterrupt).toHaveBeenCalledOnce();
      expect(props.onSteer).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
    },
  );

  it("keeps same-turn steering when the provider is available, even with an interrupt callback", async () => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    const props = render({ onInterrupt: vi.fn().mockResolvedValue(undefined) });
    expect(container.querySelector('[data-testid="task-chat-queued-interrupt-comment-1"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-steer-comment-1"]')!.click();
    });
    expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(props.onInterrupt).not.toHaveBeenCalled();
  });

  it("waits for authoritative discard acknowledgement before removing the row", async () => {
    const acknowledgement = deferred<void>();
    render({ onDiscard: vi.fn().mockReturnValue(acknowledgement.promise) });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-comment-1"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Queued message discarded.");

    await act(async () => {
      acknowledgement.resolve();
      await acknowledgement.promise;
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain("Queued message discarded.");
  });

  it.each(["wake-1", null])("keeps a too-late discard visible with an explicit error (queue=%s)", async (queueId) => {
    render({
      queue: { ...queue, queueId },
      onDiscard: vi.fn().mockRejectedValue({
        body: { details: { code: "queued_comment_already_dispatching" } },
      }),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-comment-1"]',
        )
        ?.click();
    });
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "Too late to discard: this message is already being sent.",
    );
  });

  it("shows stale revisions without announcing a discard", async () => {
    render({
      onDiscard: vi.fn().mockRejectedValue({
        body: { details: { code: "queued_comment_revision_conflict" } },
      }),
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-comment-1"]',
        )
        ?.click();
    });
    expect(container.textContent).toContain(
      "The queue changed in another session. Review it and try again.",
    );
    expect(container.textContent).not.toContain("Queued message discarded.");
  });

  it("can discard a saved message while queue acknowledgement is pending", async () => {
    // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
    if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild();
    const merged = mergePendingIssueQueuedComments({
      issueId: queue.issueId,
      authoritativeQueue: queue,
      pendingComments: [{
        comment: { ...queue.entries[0].comment, id: "optimistic-next" },
        targetRunId: queue.targetRunId,
      }],
      fallbackProtocol: queue.protocol,
    })!;
    expect(merged.queueId).toBeNull();
    const props = render({ queue: merged });
    const discard = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-discard-comment-1"]',
    );
    expect(discard?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-steer-comment-1"]',
    )?.disabled).toBe(true);
    await act(async () => { discard!.click(); });
    expect(props.onDiscard).toHaveBeenCalledWith("comment-1", "rev-1");
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
  });

  it("keeps another author's saved message protected while acknowledgement is pending", () => {
    const props = render({
      queue: {
        ...queue,
        queueId: null,
        entries: [{ ...queue.entries[0], canDiscard: false }],
      },
    });
    const discard = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-discard-comment-1"]',
    );
    expect(discard?.disabled).toBe(true);
    discard!.click();
    expect(props.onDiscard).not.toHaveBeenCalled();
  });

  it("can discard a local optimistic row before the queue id is acknowledged", async () => {
    const optimisticQueue = {
      ...queue,
      queueId: null,
      state: "deferred" as const,
      entries: [
        {
          ...queue.entries[0],
          comment: {
            ...queue.entries[0].comment,
            id: "optimistic-local-1",
          },
        },
      ],
    };
    const props = render({ queue: optimisticQueue });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-optimistic-local-1"]',
        )
        ?.click();
    });

    expect(props.onDiscard).toHaveBeenCalledWith("optimistic-local-1", "rev-1");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-optimistic-local-1"]',
      ),
    ).toBeNull();
  });

  it("delivers legacy queued messages to a live target", async () => {
    const targetRunId = "run-1";
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    render({
      queue: {
        ...queue,
        targetRunId,
        protocol: "legacy",
        steeringDisposition: "unsupported",
      },
      onInterrupt,
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-interrupt-comment-1"]',
        )
        ?.click();
    });

    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-steer-comment-1"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-comment-1"]',
      ),
    ).toBeNull();
  });
  // Stop means stop (org 11-17): after a person's Stop the waiting messages
  // stay listed with ONE line and ONE Send; Send sends them all, once.
  it("after a person's Stop lists the waiting messages with one line and one Send", async () => {
    const stopped: IssueQueuedCommentQueue = { ...queue, targetRunId: null, protocol: "legacy", steeringDisposition: "unsupported",
      executionWait: { reason: "stopped_by_person", message: "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it." } };
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    render({ queue: stopped, onInterrupt });
    const line = container.querySelector('[data-testid="task-chat-queued-stopped"]');
    expect(line?.querySelector('p[role="status"]')?.textContent).toBe("Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it.");
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain("Second queued message");
    // One Send, on the line; each row keeps its delete.
    expect([...container.querySelectorAll("button")].filter(button => button.textContent === "Send")).toHaveLength(1);
    expect(container.querySelector('[data-testid="task-chat-queued-interrupt-comment-1"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-discard-comment-2"]')?.disabled).toBe(false);
    expect(onInterrupt).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-stopped-send"]')!.click(); });
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="task-chat-queued-message-comment-1"]')).toBeNull();
    // Any other wait keeps the ordinary per-row Send and no Stop line.
    render({ queue: { ...stopped, executionWait: null }, onInterrupt });
    expect(container.querySelector('[data-testid="task-chat-queued-stopped"]')).toBeNull();
    expect(container.textContent).not.toContain("Stopped. These messages are waiting");
  });
  // STOP_TYPE (gate 3): after a person's Stop, a typed message is answered
  // first and the held batch then runs by itself, so the bar says so. The
  // queue body is planted verbatim from the real route: the JSON body of
  // GET /api/issues/:id/queued-comments in agent-conversations.test.ts's
  // "after a person's Stop nothing is sent ... (send)" row, read at head.
  it("after a person's Stop the held bar says a typed message goes first, once, with Send and Delete (390 and 1440)", () => {
    const realGet = JSON.parse(`{"issueId":"b8bbcfc4-c6b4-4261-8492-2ae7a1596df0","queueId":"d1de84f7-58a0-4f1f-87d4-0336814dd9a3","state":"deferred","targetRunId":null,"revision":"79e84f3ab9ae4fe0502dd9c7995b1cf5","protocol":"legacy","steeringDisposition":"unsupported","entries":[{"comment":{"id":"c8193316-38ad-4c00-b027-0b761bd921f2","companyId":"8da26771-e465-4d0a-b8e1-f74958dda5db","issueId":"b8bbcfc4-c6b4-4261-8492-2ae7a1596df0","authorAgentId":null,"authorUserId":"local-board","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"8dc969cb-2d62-4114-ba7e-1e4d659b9c5d","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"A","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T01:44:07.583Z","updatedAt":"2026-11-19T01:44:07.583Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"671bd64f-d7dc-4c08-bcbf-de2edeecfbb3","companyId":"8da26771-e465-4d0a-b8e1-f74958dda5db","issueId":"b8bbcfc4-c6b4-4261-8492-2ae7a1596df0","authorAgentId":null,"authorUserId":"local-board","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"08e20d19-f1c4-4158-96bd-dcae2d05b429","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"B","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T01:44:07.659Z","updatedAt":"2026-11-19T01:44:07.659Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"10193588-7d6b-431c-8a39-cff9397c5d0e","companyId":"8da26771-e465-4d0a-b8e1-f74958dda5db","issueId":"b8bbcfc4-c6b4-4261-8492-2ae7a1596df0","authorAgentId":null,"authorUserId":"local-board","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"eeca787b-547a-47de-8042-d0c8baa9ac61","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"C","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T01:44:07.722Z","updatedAt":"2026-11-19T01:44:07.722Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false}],"executionWait":{"reason":"stopped_by_person","message":"Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it."}}`) as IssueQueuedCommentQueue;
    const bar = "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it.";
    const width = window.innerWidth;
    try {
      for (const innerWidth of [390, 1440]) {
        Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: innerWidth });
        window.dispatchEvent(new Event("resize"));
        render({ queue: realGet, onInterrupt: vi.fn().mockResolvedValue(undefined) });
        expect(container.textContent!.split(bar)).toHaveLength(2);
        expect(container.querySelector('[data-testid="task-chat-queued-stopped"] p[role="status"]')?.textContent).toBe(bar);
        expect(container.textContent).not.toContain("delete any first");
        const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-stopped-send"]');
        expect(send?.textContent).toBe("Send");
        expect(send?.disabled).toBe(false);
        for (const entry of realGet.entries) {
          expect(container.querySelector(`[data-testid="task-chat-queued-message-${entry.comment.id}"]`)?.textContent).toContain(entry.comment.body);
          expect(container.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-discard-${entry.comment.id}"]`)?.disabled).toBe(false);
        }
      }
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    }
  });
  // heldbar-2c R1: after the real Stop, the Stop's own recovery path stores
  // an execution_recovery wait on the held wake. Both bodies are planted
  // verbatim from the real route: GET /api/issues/:id/queued-comments in
  // c3-optS-send-after-stop.test.ts's S10 row (real Stop route, real
  // heartbeat), read at head at +10 min (the stopped line wins) and at the
  // base 62fcab5b+69f9fba9 at +0 (the stored wait won: no bar, no bar Send).
  it("after a person's Stop the held bar stays, with Send, over the stored recovery wait (390 and 1440)", async () => {
    const headGet = JSON.parse(`{"issueId":"6c7d7400-dc98-42a4-9e87-ad91db5e97cd","queueId":"cca4581b-adb0-4ad9-b2e6-5bef40493fa4","state":"deferred","targetRunId":null,"revision":"8fa39885b8dfc7197cd00ddb4b348053","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","executionWait":{"reason":"stopped_by_person","message":"Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it."},"entries":[{"comment":{"id":"6f5ae773-bd39-440e-b54b-59dbd9daf865","companyId":"29c41c91-8bf1-4c44-8048-26775a123edd","issueId":"6c7d7400-dc98-42a4-9e87-ad91db5e97cd","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"0f61e147-8d15-42fc-b885-d7e0e4e80098","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M1 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:13:38.465Z","updatedAt":"2026-11-19T04:13:38.465Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"072974a2-9683-4e9c-b8c2-14d3bee97f3b","companyId":"29c41c91-8bf1-4c44-8048-26775a123edd","issueId":"6c7d7400-dc98-42a4-9e87-ad91db5e97cd","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"6884efbe-46bc-4bdd-b579-2a1a8ce13338","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M2 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:13:38.540Z","updatedAt":"2026-11-19T04:13:38.540Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"ac599d94-05cc-4eff-88be-8243a2e3553a","companyId":"29c41c91-8bf1-4c44-8048-26775a123edd","issueId":"6c7d7400-dc98-42a4-9e87-ad91db5e97cd","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"e49d9998-30db-4b61-84d7-84438d4362e3","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M3 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:13:38.609Z","updatedAt":"2026-11-19T04:13:38.609Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false}]}`) as IssueQueuedCommentQueue;
    const baseGet = JSON.parse(`{"issueId":"33e936d7-2326-49f8-8ad4-2825b5f9eee3","queueId":"f3fe04dc-e110-4663-bec9-ff53a1d5b8cf","state":"deferred","targetRunId":null,"revision":"93774103ff523ba9077c1c69b7137469","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","executionWait":{"reason":"execution_recovery","message":"Waiting for execution recovery. Your message is saved."},"entries":[{"comment":{"id":"8a705b40-23aa-4f88-87c7-df1ab5194762","companyId":"03aa0a18-07fd-477a-abba-c3fc671cd205","issueId":"33e936d7-2326-49f8-8ad4-2825b5f9eee3","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"3c08e7b6-67cd-489c-9a22-c2676604ef0a","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M1 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:13:55.254Z","updatedAt":"2026-11-19T04:13:55.254Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"fde29335-ecaa-43f5-b880-bd9430d129a5","companyId":"03aa0a18-07fd-477a-abba-c3fc671cd205","issueId":"33e936d7-2326-49f8-8ad4-2825b5f9eee3","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"e029988d-9eed-467f-bd1e-9593f52c8b1d","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M2 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:13:55.329Z","updatedAt":"2026-11-19T04:13:55.329Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"08c798fb-2cb3-4499-a9fd-bd97903c405c","companyId":"03aa0a18-07fd-477a-abba-c3fc671cd205","issueId":"33e936d7-2326-49f8-8ad4-2825b5f9eee3","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"c1a37182-90ed-40b0-ac8e-4af2302b1ab3","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M3 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:13:55.421Z","updatedAt":"2026-11-19T04:13:55.421Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false}]}`) as IssueQueuedCommentQueue;
    const bar = "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it.";
    const width = window.innerWidth;
    try {
      for (const innerWidth of [390, 1440]) {
        Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: innerWidth });
        window.dispatchEvent(new Event("resize"));
        render({ queue: headGet, onInterrupt: vi.fn().mockResolvedValue(undefined) });
        // SUPERSEDE-QUEUE-ROW-HIDE-1119 (harness only): with no row menu the list's
        // passive sync to the new queue is flushed here, not by the menu's mount.
        await act(async () => {});
        expect(container.textContent!.split(bar)).toHaveLength(2);
        expect(container.querySelector('[data-testid="task-chat-queued-stopped"] p[role="status"]')?.textContent).toBe(bar);
        const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-stopped-send"]');
        expect(send?.textContent).toBe("Send");
        expect(send?.disabled).toBe(false);
        expect(container.textContent).not.toContain("Waiting for execution recovery");
        for (const entry of headGet.entries) {
          expect(container.querySelector(`[data-testid="task-chat-queued-message-${entry.comment.id}"]`)?.textContent).toContain(entry.comment.body);
          expect(container.querySelector(`[data-testid="task-chat-queued-interrupt-${entry.comment.id}"]`)).toBeNull();
        }
        // The base's body: the stored wait won, so no held bar and no bar Send.
        render({ queue: baseGet, onInterrupt: vi.fn().mockResolvedValue(undefined) });
        expect(container.querySelector('[data-testid="task-chat-queued-stopped"]')).toBeNull();
        expect(container.querySelector('[data-testid="task-chat-queued-stopped-send"]')).toBeNull();
      }
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    }
  });
  // heldbar-r2 (B), org 11-19 04:36Z: after a person's own Stop the page
  // shows the stopped bar and NOT the pink "Couldn't finish this attempt"
  // banner with Retry. The bodies are planted verbatim from the real routes in
  // c3-optS-send-after-stop.test.ts (GET /api/issues/:id/queued-comments and
  // GET /api/issues/:id): S10 (the real Stop route, 3 held) at +10 s, +2 min
  // and +10 min, where the issue's interruption is a system "failed" attempt
  // with canRetry; and the control (a run cancelled without the person's Stop),
  // whose page keeps the banner and its Retry. The page composes the banner
  // as IssueDetail does: heldByPersonStop = queueHeldByPersonStop(queue).
  it("after a person's own Stop the page has the stopped bar and no failed-attempt banner or Retry; a run ended otherwise keeps them (390 and 1440)", () => {
    const real = JSON.parse(`{"stop":[["+10s",{"issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","queueId":"dbb7a13b-75a9-42e3-95bc-38cc6bbd0b26","state":"deferred","targetRunId":null,"revision":"065fe2fcae9adf78aac2debb030395ef","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","executionWait":{"reason":"stopped_by_person","message":"Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it."},"entries":[{"comment":{"id":"3b35957f-7b9b-4b34-a40a-4ce643b432bd","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"c2758b24-77f7-48d2-9ea8-17f2652aafa5","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M1 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:30.908Z","updatedAt":"2026-11-19T04:46:30.908Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"8b7e97bf-4071-46f7-b9d3-097a30da8efc","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"57e42acf-4a47-4e05-b7ba-dd7c55016ad2","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M2 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:30.986Z","updatedAt":"2026-11-19T04:46:30.986Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"ecc1166d-f46d-4772-bba7-5f288a9e4b08","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"350dc373-0912-4266-9cc0-116cfd1ca5d3","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M3 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:31.066Z","updatedAt":"2026-11-19T04:46:31.066Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false}]},{"intentId":"dbb7a13b-75a9-42e3-95bc-38cc6bbd0b26","responsibility":"system","state":"failed","nextRetryAt":null,"canRetry":true,"userAction":null,"sourceRunIds":["9abe9eee-a58a-4034-9219-c1beab4db6d5"],"observedRunId":"9abe9eee-a58a-4034-9219-c1beab4db6d5"}],["+2min",{"issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","queueId":"dbb7a13b-75a9-42e3-95bc-38cc6bbd0b26","state":"deferred","targetRunId":null,"revision":"065fe2fcae9adf78aac2debb030395ef","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","executionWait":{"reason":"stopped_by_person","message":"Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it."},"entries":[{"comment":{"id":"3b35957f-7b9b-4b34-a40a-4ce643b432bd","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"c2758b24-77f7-48d2-9ea8-17f2652aafa5","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M1 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:30.908Z","updatedAt":"2026-11-19T04:46:30.908Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"8b7e97bf-4071-46f7-b9d3-097a30da8efc","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"57e42acf-4a47-4e05-b7ba-dd7c55016ad2","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M2 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:30.986Z","updatedAt":"2026-11-19T04:46:30.986Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"ecc1166d-f46d-4772-bba7-5f288a9e4b08","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"350dc373-0912-4266-9cc0-116cfd1ca5d3","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M3 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:31.066Z","updatedAt":"2026-11-19T04:46:31.066Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false}]},{"intentId":"dbb7a13b-75a9-42e3-95bc-38cc6bbd0b26","responsibility":"system","state":"failed","nextRetryAt":null,"canRetry":true,"userAction":null,"sourceRunIds":["9abe9eee-a58a-4034-9219-c1beab4db6d5"],"observedRunId":"9abe9eee-a58a-4034-9219-c1beab4db6d5"}],["+10min",{"issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","queueId":"dbb7a13b-75a9-42e3-95bc-38cc6bbd0b26","state":"deferred","targetRunId":null,"revision":"065fe2fcae9adf78aac2debb030395ef","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","executionWait":{"reason":"stopped_by_person","message":"Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it."},"entries":[{"comment":{"id":"3b35957f-7b9b-4b34-a40a-4ce643b432bd","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"c2758b24-77f7-48d2-9ea8-17f2652aafa5","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M1 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:30.908Z","updatedAt":"2026-11-19T04:46:30.908Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"8b7e97bf-4071-46f7-b9d3-097a30da8efc","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"57e42acf-4a47-4e05-b7ba-dd7c55016ad2","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M2 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:30.986Z","updatedAt":"2026-11-19T04:46:30.986Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"ecc1166d-f46d-4772-bba7-5f288a9e4b08","companyId":"ff790f0b-6f32-45f9-b226-581c202b176c","issueId":"9b5a6a55-ec1e-42ef-a244-a21035072d85","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"350dc373-0912-4266-9cc0-116cfd1ca5d3","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M3 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:46:31.066Z","updatedAt":"2026-11-19T04:46:31.066Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false}]},{"intentId":"dbb7a13b-75a9-42e3-95bc-38cc6bbd0b26","responsibility":"system","state":"failed","nextRetryAt":null,"canRetry":true,"userAction":null,"sourceRunIds":["9abe9eee-a58a-4034-9219-c1beab4db6d5"],"observedRunId":"9abe9eee-a58a-4034-9219-c1beab4db6d5"}]],"control":[{"issueId":"5b54e56c-72a7-42fd-b76b-f7a7f6b39d95","queueId":"7bc1d9c6-781b-4d59-a755-802a08b6a773","state":"deferred","targetRunId":null,"revision":"b59b4e9ef61b96a5e0ee476525ccca01","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","executionWait":{"reason":"interrupt_handoff","message":"Sending your messages."},"entries":[{"comment":{"id":"fbe7e6b7-0969-4100-bbdc-d5a7bbf92514","companyId":"3639ff22-a6f9-4f33-b71e-76649b306702","issueId":"5b54e56c-72a7-42fd-b76b-f7a7f6b39d95","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"29df3f51-c9ca-4a06-bfb7-d15cbfa2be59","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M1 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:47:12.223Z","updatedAt":"2026-11-19T04:47:12.223Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"9cebcf4a-0f75-4ec7-add6-2b60acea9bec","companyId":"3639ff22-a6f9-4f33-b71e-76649b306702","issueId":"5b54e56c-72a7-42fd-b76b-f7a7f6b39d95","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"5a083f64-4f38-41a5-be9c-96d266ef013b","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M2 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:47:12.296Z","updatedAt":"2026-11-19T04:47:12.296Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false,"queueId":"3c59de70-2b13-4985-a298-52ec85ac2763","queueRevision":"6da82af6626d7de4f881627015f2fb99"},{"comment":{"id":"a0b90cae-d6a7-4081-a9eb-30b3aaeb4d9c","companyId":"3639ff22-a6f9-4f33-b71e-76649b306702","issueId":"5b54e56c-72a7-42fd-b76b-f7a7f6b39d95","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"4eb8e0ae-c60c-4ca2-a0b8-0161177f10c3","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M3 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T04:47:12.375Z","updatedAt":"2026-11-19T04:47:12.375Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false,"queueId":"7bcbb59d-d6f2-48e3-9ce3-e4b2236fbd70","queueRevision":"958a75fcf3fd30c66f43263d3d28f9d2"}]},{"intentId":"7bcbb59d-d6f2-48e3-9ce3-e4b2236fbd70","responsibility":"system","state":"failed","nextRetryAt":null,"canRetry":true,"userAction":null,"sourceRunIds":["f881c69a-3441-49f0-a9ba-6d64b7be4b89"],"observedRunId":"f881c69a-3441-49f0-a9ba-6d64b7be4b89"}]}`) as { stop: [string, IssueQueuedCommentQueue, TaskInterruptionPresentation][];
      control: [IssueQueuedCommentQueue, TaskInterruptionPresentation] };
    const bar = "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it.";
    const page = (get: IssueQueuedCommentQueue, interruption: TaskInterruptionPresentation) => flushSync(() => root.render(
      <MemoryRouter><ThemeProvider>
        <ExecutionBlockerNotice presentation={interruption} canRetry onRetry={vi.fn()} heldByPersonStop={queueHeldByPersonStop(get)} />
        <TaskChatQueuedMessages queue={get} onEdit={vi.fn()} onReorder={vi.fn().mockResolvedValue(undefined)}
          onSteer={vi.fn().mockResolvedValue(undefined)} onDiscard={vi.fn().mockResolvedValue(undefined)}
          onInterrupt={vi.fn().mockResolvedValue(undefined)} />
      </ThemeProvider></MemoryRouter>));
    expect(real.stop.map(([label]) => label)).toEqual(["+10s", "+2min", "+10min"]);
    const width = window.innerWidth;
    try {
      for (const innerWidth of [390, 1440]) {
        Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: innerWidth });
        window.dispatchEvent(new Event("resize"));
        for (const [label, get, interruption] of real.stop) {
          expect([label, interruption.state, interruption.canRetry]).toEqual([label, "failed", true]);
          page(get, interruption);
          expect([innerWidth, label, container.textContent!.split(bar).length]).toEqual([innerWidth, label, 2]);
          expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-stopped-send"]')?.disabled).toBe(false);
          expect([innerWidth, label, container.textContent!.includes("Couldn’t finish this attempt")]).toEqual([innerWidth, label, false]);
          expect(container.querySelector('[data-testid="task-execution-retry"]')).toBeNull();
        }
        // Control: no person-Stop on the queue, so the banner and Retry stay.
        const [get, interruption] = real.control;
        page(get, interruption);
        expect(container.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
        expect(container.querySelector('[data-testid="task-execution-retry"]')?.textContent).toBe("Retry");
        expect(container.querySelector('[data-testid="task-chat-queued-stopped"]')).toBeNull();
      }
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    }
  });
  // heldbar-sharp (RFL 04:47Z), the sharp control: the guards are keyed to
  // the STOPPED RUN, never to "this issue once had a person's own Stop". The
  // bodies are planted verbatim from ONE real issue in c3-optS S10 (real
  // routes): its GET /api/issues/:id/queued-comments + GET /api/issues/:id
  // 10 s after the person's own Stop (3 held), then, after the real Send
  // (POST .../queued-comments/interrupt), 10 s and 2 min after the SUCCESSOR
  // run really failed. Planted in S10: only the harness's provider edge
  // (executePaperclipNativeSession throws "successor_provider_turn_reached").
  // The page composes the banner as IssueDetail does.
  it("after the person's own Stop and a Send whose successor run fails, the banner and Retry come back and the stopped bar is gone (390 and 1440)", () => {
    const real = JSON.parse(`{"stopped":[{"issueId":"86e4f315-b7e5-4c2b-abc9-a9e753e08c63","queueId":"268a8a54-0265-491e-a388-8034de290927","state":"deferred","targetRunId":null,"revision":"c4ee9a535a98f1d80e4f8d1ee3864b04","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","executionWait":{"reason":"stopped_by_person","message":"Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it."},"entries":[{"comment":{"id":"d25b7c48-b70b-4b01-8731-37287b914e6a","companyId":"4f0c9be6-e8d9-4dd4-8720-21020e7ac311","issueId":"86e4f315-b7e5-4c2b-abc9-a9e753e08c63","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"251b6468-d314-4977-8252-5bc74ffcd7e6","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M1 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T05:21:42.099Z","updatedAt":"2026-11-19T05:21:42.099Z"},"position":0,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"b6afcc7b-7538-4195-9bfe-248b7c4a458b","companyId":"4f0c9be6-e8d9-4dd4-8720-21020e7ac311","issueId":"86e4f315-b7e5-4c2b-abc9-a9e753e08c63","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"6f378552-d663-4ec5-bf8a-e32575ee77f6","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M2 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T05:21:42.270Z","updatedAt":"2026-11-19T05:21:42.270Z"},"position":1,"canEdit":true,"canDiscard":true,"behindReset":false},{"comment":{"id":"669b4662-afd1-47de-ae23-e7ba2948ae1f","companyId":"4f0c9be6-e8d9-4dd4-8720-21020e7ac311","issueId":"86e4f315-b7e5-4c2b-abc9-a9e753e08c63","authorAgentId":null,"authorUserId":"responsible-user","onBehalfOfUserId":null,"authorType":"user","createdByRunId":null,"derivedAuthorAgentId":null,"derivedCreatedByRunId":null,"derivedAuthorSource":null,"clientRequestId":"8b82b6c4-0427-484b-a8ec-bf78ce8fb6d4","conversationSessionGeneration":null,"origin":"comment","fastResponseRequestId":null,"body":"M3 held","presentation":null,"metadata":null,"deletedAt":null,"deletedByType":null,"deletedByAgentId":null,"deletedByUserId":null,"deletedByRunId":null,"sourceTrust":null,"createdAt":"2026-11-19T05:21:42.455Z","updatedAt":"2026-11-19T05:21:42.455Z"},"position":2,"canEdit":true,"canDiscard":true,"behindReset":false}]},{"intentId":"268a8a54-0265-491e-a388-8034de290927","responsibility":"system","state":"failed","nextRetryAt":null,"canRetry":true,"userAction":null,"sourceRunIds":["ac591b3b-5ef2-4deb-bce7-494566494763"],"observedRunId":"ac591b3b-5ef2-4deb-bce7-494566494763"}],"failed":[["+10s",{"issueId":"86e4f315-b7e5-4c2b-abc9-a9e753e08c63","queueId":null,"state":null,"targetRunId":null,"revision":"5e99497165f934b249e2d2ffb7532e93","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","entries":[]},{"intentId":null,"responsibility":"system","state":"failed","nextRetryAt":null,"canRetry":true,"userAction":null,"sourceRunIds":["cb1a01d7-8fb4-45ad-8009-2f64f80a2492"],"observedRunId":"cb1a01d7-8fb4-45ad-8009-2f64f80a2492"}],["+2min",{"issueId":"86e4f315-b7e5-4c2b-abc9-a9e753e08c63","queueId":null,"state":null,"targetRunId":null,"revision":"5e99497165f934b249e2d2ffb7532e93","protocol":"paperclip_runner_v1","steeringDisposition":"unsupported","entries":[]},{"intentId":null,"responsibility":"system","state":"failed","nextRetryAt":null,"canRetry":true,"userAction":null,"sourceRunIds":["cb1a01d7-8fb4-45ad-8009-2f64f80a2492"],"observedRunId":"cb1a01d7-8fb4-45ad-8009-2f64f80a2492"}]]}`) as { stopped: [IssueQueuedCommentQueue, TaskInterruptionPresentation];
      failed: [string, IssueQueuedCommentQueue, TaskInterruptionPresentation][] };
    const bar = "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it.";
    const page = (get: IssueQueuedCommentQueue, interruption: TaskInterruptionPresentation) => flushSync(() => root.render(
      <MemoryRouter><ThemeProvider>
        <ExecutionBlockerNotice presentation={interruption} canRetry onRetry={vi.fn()} heldByPersonStop={queueHeldByPersonStop(get)} />
        <TaskChatQueuedMessages queue={get} onEdit={vi.fn()} onReorder={vi.fn().mockResolvedValue(undefined)}
          onSteer={vi.fn().mockResolvedValue(undefined)} onDiscard={vi.fn().mockResolvedValue(undefined)}
          onInterrupt={vi.fn().mockResolvedValue(undefined)} />
      </ThemeProvider></MemoryRouter>));
    // One issue throughout; the failure is the successor's, not the stopped run's.
    expect(real.failed.map(([label]) => label)).toEqual(["+10s", "+2min"]);
    const [stoppedGet, stoppedInterruption] = real.stopped;
    for (const [, get, interruption] of real.failed) {
      expect(get.issueId).toBe(stoppedGet.issueId);
      expect(interruption.observedRunId).not.toBe(stoppedInterruption.observedRunId);
    }
    const width = window.innerWidth;
    try {
      for (const innerWidth of [390, 1440]) {
        Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: innerWidth });
        window.dispatchEvent(new Event("resize"));
        // A fresh page at each width (the bar's entries are seeded on mount).
        flushSync(() => root.unmount());
        root = createRoot(container);
        // Before the Send: the person's own Stop holds; the bar is the one line.
        page(stoppedGet, stoppedInterruption);
        expect([innerWidth, container.textContent!.split(bar).length]).toEqual([innerWidth, 2]);
        expect(container.textContent).not.toContain("Couldn’t finish this attempt");
        // After the successor really failed: the banner and Retry show, the bar is gone.
        for (const [label, get, interruption] of real.failed) {
          expect([label, interruption.state, interruption.canRetry, get.executionWait ?? null, get.entries]).toEqual([label, "failed", true, null, []]);
          page(get, interruption);
          expect([innerWidth, label, container.textContent!.includes("Couldn’t finish this attempt. Your message is saved.")])
            .toEqual([innerWidth, label, true]);
          expect([innerWidth, label, container.querySelector('[data-testid="task-execution-retry"]')?.textContent]).toEqual([innerWidth, label, "Retry"]);
          expect(container.querySelector('[data-testid="task-chat-queued-stopped"]')).toBeNull();
          expect(container.querySelector('[data-testid="task-chat-queued-stopped-send"]')).toBeNull();
          expect(container.textContent).not.toContain(bar);
        }
      }
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    }
  });
  // rf-5 F1: Stop, then Pause. The real GET's wait is the Send route's own
  // paused code and line (agent-conversations.test.ts "(agent-paused)" row),
  // so the bar says it is paused and offers no Send that would be refused.
  it("after a person's Stop a paused agent's held bar says the paused line and offers no Send, only Delete (390 and 1440)", () => {
    const realGet = { ...queue, targetRunId: null, protocol: "legacy", steeringDisposition: "unsupported",
      executionWait: { reason: "queued_comment_chat_paused", message: "This agent is paused. Resume it to send these messages." } } as IssueQueuedCommentQueue;
    const bar = "This agent is paused. Resume it to send these messages.";
    const width = window.innerWidth;
    try {
      for (const innerWidth of [390, 1440]) {
        Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: innerWidth });
        window.dispatchEvent(new Event("resize"));
        render({ queue: realGet, onInterrupt: vi.fn().mockResolvedValue(undefined) });
        expect(container.textContent!.split(bar)).toHaveLength(2);
        expect(container.querySelector('[data-testid="task-chat-queued-paused"]')?.textContent).toBe(bar);
        expect(container.textContent).not.toContain("Send them now");
        expect(container.querySelector('[data-testid="task-chat-queued-stopped-send"]')).toBeNull();
        expect([...container.querySelectorAll("button")].filter(button => /Send|Steer|Interrupt/.test(button.textContent ?? ""))).toHaveLength(0);
        for (const entry of realGet.entries) {
          expect(container.querySelector(`[data-testid="task-chat-queued-interrupt-${entry.comment.id}"]`)).toBeNull();
          expect(container.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-discard-${entry.comment.id}"]`)?.disabled).toBe(false);
        }
      }
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    }
  });
  it("says why Send is refused while the chat is paused, and keeps the messages", async () => {
    const stopped: IssueQueuedCommentQueue = { ...queue, targetRunId: null, protocol: "legacy", steeringDisposition: "unsupported",
      executionWait: { reason: "stopped_by_person", message: "Stopped. These messages are waiting. Send them now, or delete any. If you type a new message first, they go right after it." } };
    const refusal = Object.assign(new Error("Conflict"), { status: 409, body: {
      error: "This agent is paused. Resume it to send these messages.", details: { code: "queued_comment_chat_paused" } } });
    render({ queue: stopped, onInterrupt: vi.fn().mockRejectedValue(refusal) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-stopped-send"]')!.click(); });
    expect(container.textContent).toContain("This agent is paused. Resume it to send these messages.");
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain("Second queued message");
  });
  it("keeps deferred sends visible and explains their current wait", async () => {
    const saved = { ...queue, targetRunId: null, executionWait: { reason: "decision_pending", message: "Resolve the pending approval before sending." } };
    const onInterrupt = vi.fn().mockResolvedValue(saved);
    render({ queue: saved, onInterrupt });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click(); });
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).toContain(saved.executionWait.message);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')?.disabled).toBe(false);
  });
  it("shows an Interrupt as sent while the stopped turn hands off, with no wait or error text", async () => {
    const handoff = { ...queue, targetRunId: null,
      executionWait: { reason: "interrupt_handoff", message: "Sending your messages." } };
    const onInterrupt = vi.fn().mockResolvedValue(handoff);
    render({ queue: { ...queue, steeringDisposition: "temporarily_unavailable" }, onInterrupt });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click(); });
    // A poll during the hand-off still lists the saved messages.
    render({ queue: handoff, onInterrupt });
    await act(async () => {});
    expect(container.textContent).not.toContain("First queued message");
    expect(container.textContent).not.toContain("Sending your messages.");
    expect(container.textContent).not.toContain("Couldn’t");
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
  });
  it("clears a deferred wait message when a refreshed queue finishes sending", async () => {
    const saved = { ...queue, targetRunId: null, executionWait: { reason: "decision_pending", message: "Resolve the pending approval before sending." } };
    render({ queue: saved, onInterrupt: vi.fn().mockResolvedValue(saved) });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]')!.click(); });
    expect(container.textContent).toContain(saved.executionWait.message);
    render({ queue: { ...saved, queueId: null, entries: [], state: null, executionWait: null } });
    await act(async () => {});
    expect(container.textContent).not.toContain(saved.executionWait.message);
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
  });
  it.each(["legacy", "paperclip_runner_v1"] as const)("sends a saved %s queue explicitly after Stop", async (protocol) => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    render({ queue: { ...queue, targetRunId: null, protocol, steeringDisposition: "temporarily_unavailable" }, onInterrupt });
    expect(onInterrupt).not.toHaveBeenCalled();
    const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-interrupt-comment-1"]');
    expect(send?.textContent).toBe("Send");
    expect(send?.getAttribute("aria-label")).toBe("Send queued messages");
    expect(send?.disabled).toBe(false);
    await act(async () => { send!.click(); });
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="task-chat-queued-steer-comment-1"]')).toBeNull();
  });


  describe("automatic steering", () => {
    const delay = 5_000;
    const fresh = (overrides: Partial<IssueQueuedCommentQueue> = {}): IssueQueuedCommentQueue => {
      const at = new Date(Date.now());
      return { ...queue, ...overrides, entries: queue.entries.slice(0, 1).map(entry => ({
        ...entry, comment: { ...entry.comment, createdAt: at, updatedAt: at } })) };
    };
    const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
    const countdown = () => container.querySelector('[data-testid="task-chat-queued-auto-steer-comment-1"]');

    beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-11-07T12:00:00Z") }); });
    afterEach(() => { vi.useRealTimers(); });

    it("shows a countdown with Edit and Cancel, then steers into the live turn", async () => {
      // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
      if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild(advance);
      const props = render({ queue: fresh(), autoSteerDelayMs: delay });
      expect(countdown()?.textContent).toContain("Sending in 5s");
      expect(container.querySelector('[data-testid="task-chat-queued-steer-comment-1"]')).toBeNull();
      await advance(2_100);
      expect(countdown()?.textContent).toContain("Sending in 3s");
      expect(props.onSteer).not.toHaveBeenCalled();
      await advance(3_000);
      expect(props.onSteer).toHaveBeenCalledOnce();
      expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-1");
    });

    it("gives a saved edit a full window while another row's countdown keeps the clock running", async () => {
      // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
      if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild(advance);
      const start = Date.now();
      const twoRows: IssueQueuedCommentQueue = { ...queue, entries: queue.entries.slice(0, 2).map((entry, index) => {
        const at = new Date(start + index * 4_000);
        return { ...entry, comment: { ...entry.comment, createdAt: at, updatedAt: at } };
      }) };
      // comment-1 counts down first; the person opens it for editing at 1 s.
      const props = render({ queue: twoRows, autoSteerDelayMs: delay });
      await advance(1_000);
      await act(async () => { render({ ...props, editingCommentId: "comment-1" }); });
      // comment-2 counts down to start + 9 s and keeps the clock ticking past
      // comment-1's old deadline.
      await advance(5_000);
      expect(props.onSteer).not.toHaveBeenCalled();
      const saved = { ...twoRows, revision: "rev-2", entries: twoRows.entries.map((entry, index) => index === 0
        ? { ...entry, comment: { ...entry.comment, body: "Edited", updatedAt: new Date(Date.now()) } } : entry) };
      await act(async () => { render({ ...props, queue: saved, editingCommentId: null }); });
      await advance(500);
      expect(props.onSteer).not.toHaveBeenCalledWith("comment-1", expect.anything());
      expect(countdown()?.textContent).toContain("Sending in");
      await advance(5_000);
      expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-2");
    });

    it("keeps a cancelled message in the queue with its explicit Steer button", async () => {
      // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
      if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild(advance);
      const props = render({ queue: fresh(), autoSteerDelayMs: delay });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-auto-steer-cancel-comment-1"]')?.click();
        await Promise.resolve();
      });
      await advance(10_000);
      expect(props.onSteer).not.toHaveBeenCalled();
      expect(countdown()).toBeNull();
      expect(container.querySelector('[data-testid="task-chat-queued-steer-comment-1"]')).not.toBeNull();
    });

    it("waits while the message is being edited and restarts from the saved revision", async () => {
      // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
      if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild(advance);
      const queued = fresh();
      const props = render({ queue: queued, autoSteerDelayMs: delay });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="task-chat-queued-auto-steer-edit-comment-1"]')?.click();
        await Promise.resolve();
      });
      expect(props.onEdit).toHaveBeenCalledWith("comment-1");
      render({ ...props, editingCommentId: "comment-1" });
      await advance(10_000);
      expect(props.onSteer).not.toHaveBeenCalled();
      // The save changes the comment; its countdown starts again from that change.
      const saved = { ...queued, revision: "rev-2", entries: queued.entries.map(entry => ({
        ...entry, comment: { ...entry.comment, body: "Edited", updatedAt: new Date(Date.now()) } })) };
      await act(async () => { render({ ...props, queue: saved, editingCommentId: null }); });
      expect(countdown()?.textContent).toContain("Sending in 5s");
      await advance(5_100);
      expect(props.onSteer).toHaveBeenCalledWith("comment-1", "rev-2");
    });

    it("keeps the ordinary queue while steering is unavailable or unsupported", async () => {
      for (const steeringDisposition of ["temporarily_unavailable", "unsupported"] as const) {
        const props = render({ queue: fresh({ steeringDisposition }), autoSteerDelayMs: delay });
        expect(countdown()).toBeNull();
        await advance(10_000);
        expect(props.onSteer).not.toHaveBeenCalled();
      }
    });

    it("tries each message revision once, then leaves it queued after a failure", async () => {
      // SUPERSEDE-QUEUE-ROW-HIDE-1119: hidden in this build.
      if (!QUEUE_ROW_REORDER_EDIT_STEER_ENABLED) return pinHiddenInThisBuild(advance);
      const props = render({ queue: fresh(), autoSteerDelayMs: delay, onSteer: vi.fn().mockRejectedValue(new Error("rejected")) });
      await advance(5_100);
      await advance(10_000);
      expect(props.onSteer).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Couldn’t steer. Message is still queued.");
      expect(countdown()).toBeNull();
    });

    it("never sends someone else’s message or a saved card response automatically", async () => {
      const notMine = fresh();
      notMine.entries = notMine.entries.map(entry => ({ ...entry, canEdit: false }));
      const card = fresh();
      card.entries = card.entries.map(entry => ({ ...entry, source: { kind: "interaction", summary: "Approved" } as never }));
      for (const candidate of [notMine, card]) {
        const props = render({ queue: candidate, autoSteerDelayMs: delay });
        await advance(10_000);
        expect(props.onSteer).not.toHaveBeenCalled();
      }
    });

    it("stays off unless the caller enables it", async () => {
      const props = render({ queue: fresh() });
      expect(countdown()).toBeNull();
      await advance(10_000);
      expect(props.onSteer).not.toHaveBeenCalled();
    });
  });

  describe("steering by default: the waiting list shows what the server answered (Paul 11-19)", () => {
    const sent = (extra: Record<string, unknown>) => ({ ...queue.entries[0]!.comment, id: "comment-new", body: "Check the deploy too", ...extra });

    it.each([390, 1440])("the server answers QUEUE to a Send while working: the message is in the waiting list, never shown as sent at %ipx", (width) => {
      window.innerWidth = width;
      const answer = sent({ deliveryOutcome: "queued" });
      const delivery = readCommentDelivery(answer);
      expect(delivery.kind).toBe("queued");
      const merged = mergePendingIssueQueuedComments({
        issueId: "issue-1",
        authoritativeQueue: { ...queue, entries: [] },
        pendingComments: delivery.kind === "queued" ? [{ comment: answer, targetRunId: "run-1" }] : [],
        fallbackProtocol: "paperclip_runner_v1",
      });
      render({ queue: merged! });
      const list = container.querySelector('[data-testid="task-chat-queued-list"]')!;
      expect(list).not.toBeNull();
      expect(list.textContent).toContain("Check the deploy too");
      const [item] = commentsToTaskChatItems([answer as never]);
      expect(item && "steeredIntoRunId" in item ? item.steeredIntoRunId : undefined).toBeUndefined();
      expect(container.querySelector('[data-testid="task-chat-steered-message"]')).toBeNull();
    });

    it.each([390, 1440])("the server answers STEER: the message is a sent thread item for that run, not a waiting row at %ipx", (width) => {
      window.innerWidth = width;
      const answer = sent({ steeredIntoRunId: "run-1", steeredAt: "2026-11-19T07:40:00.000Z" });
      expect(readCommentDelivery(answer)).toEqual({ kind: "steered", runId: "run-1", steeredAt: "2026-11-19T07:40:00.000Z" });
      const [item] = commentsToTaskChatItems([answer as never]);
      expect(item && "steeredIntoRunId" in item ? item.steeredIntoRunId : null).toBe("run-1");
      // Nothing waits: the list renders nothing for it.
      render({ queue: { ...queue, entries: [] } });
      expect(container.querySelector('[data-testid="task-chat-queued-list"]')).toBeNull();
    });

    it.each([390, 1440])("D5: a Send the server could not steer shows its reason in the waiting list at %ipx", (width) => {
      window.innerWidth = width;
      const answer = sent({ deliveryOutcome: "queued", steeringUnavailableReason: "This runner can't take messages mid-turn." });
      const delivery = readCommentDelivery(answer);
      expect(delivery).toEqual({ kind: "queued", steeringUnavailableReason: "This runner can't take messages mid-turn." });
      render({ steeringUnavailableReason: delivery.kind === "queued" ? delivery.steeringUnavailableReason : null });
      const line = container.querySelector('[data-testid="task-chat-queued-list"] [data-testid="task-chat-steering-unavailable"]')!;
      expect(line).not.toBeNull();
      expect(line.textContent).toBe("Steering paused: This runner can't take messages mid-turn. Will send after this turn.");
      expect(container.textContent).toContain("First queued message");
    });
  });
});
