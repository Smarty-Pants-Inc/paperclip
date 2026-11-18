// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatSystemNotice } from "./TaskChatSystemNotice";
import type { TaskChatMessageItem } from "./task-chat-model";

// Positive component control, not an import-adapter or browser acceptance test.
describe("imported GitHub sender system notice", () => {
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

  it("keeps the preserved body and GitHub sender details when expanded as SYSTEM", () => {
    const body = "Synthetic imported GitHub message: review the example change.";
    const item: TaskChatMessageItem = {
      id: "synthetic-imported-github-comment",
      kind: "message", author: "system", authorUserId: null,
      text: body, createdAtIso: "2026-01-01T12:00:00.000Z",
      metadata: {
        version: 1, sourceChannel: "github",
        sections: [{ title: "GitHub sender", rows: [
          { type: "key_value", label: "Username", value: "example-bot" },
          { type: "key_value", label: "Provider ID", value: "synthetic-github-user-42" },
        ] }],
      },
    };
    flushSync(() => root!.render(
      <ThemeProvider><TaskChatSystemNotice item={item} /></ThemeProvider>,
    ));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-system-notice"] button[aria-expanded]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="task-chat-system-notice-details"]')).toBeNull();
    expect(container.textContent).not.toContain("example-bot");

    flushSync(() => toggle!.click());
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    const details = container.querySelector('[data-testid="task-chat-system-notice-details"]');
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain(body);
    expect(details!.textContent).toContain("GitHub sender");
    expect(details!.textContent).toContain("Username");
    expect(details!.textContent).toContain("example-bot");
    expect(details!.textContent).toContain("Provider ID");
    expect(details!.textContent).toContain("synthetic-github-user-42");
    expect(item.author).toBe("system");
    expect(item.authorUserId).toBeNull();
  });
});
