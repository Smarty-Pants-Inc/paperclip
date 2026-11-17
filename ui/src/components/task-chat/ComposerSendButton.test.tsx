// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerSendButton, type ComposerSendButtonProps } from "./ComposerSendButton";

describe("ComposerSendButton (Paul NOTE 6)", () => {
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
    document.body.innerHTML = "";
  });
  function render(overrides: Partial<ComposerSendButtonProps> = {}) {
    const props: ComposerSendButtonProps = {
      working: true, mode: "steer", defaultMode: "steer", steerUnavailableReason: null, submitKey: "enter",
      disabled: false, busy: false, title: "Send (Enter)", onSend: vi.fn(), onPick: vi.fn(), ...overrides,
    };
    flushSync(() => root.render(<ComposerSendButton {...props} />));
    return props;
  }
  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send-menu"]')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("is a text 'Send' button with a ▾ while the agent works; idle has no ▾", () => {
    render();
    expect(container.querySelector('[data-testid="task-chat-composer-send"]')?.textContent).toBe("Send");
    expect(container.querySelector('[data-testid="task-chat-composer-send-menu"]')).not.toBeNull();
    flushSync(() => root.render(<ComposerSendButton working={false} mode="steer" defaultMode="steer" steerUnavailableReason={null}
      submitKey="enter" disabled={false} busy={false} title="Send" onSend={() => {}} onPick={() => {}} />));
    expect(container.querySelector('[data-testid="task-chat-composer-send-menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-composer-send"]')?.textContent).toBe("Send");
  });

  it("lists Steer, Queue and Interrupt with their keys", async () => {
    render();
    await openMenu();
    const text = (mode: string) => document.querySelector(`[data-testid="task-chat-send-mode-${mode}"]`)?.textContent ?? "";
    expect(text("steer")).toContain("Steer");
    expect(document.querySelector('[data-testid="task-chat-send-mode-key-steer"]')?.textContent).toBe("Enter");
    expect(document.querySelector('[data-testid="task-chat-send-mode-key-queue"]')?.textContent).toBe("Ctrl+Enter");
    expect(document.querySelector('[data-testid="task-chat-send-mode-key-interrupt"]')?.textContent).toBe("Ctrl+Alt+Enter");
  });

  it("when steering is unavailable the button reads Queue and Steer is grey with the reason", async () => {
    render({ mode: "queue", defaultMode: "queue", steerUnavailableReason: "Not available: this runner can't take messages mid-turn." });
    expect(container.querySelector('[data-testid="task-chat-composer-send"]')?.textContent).toBe("Queue");
    await openMenu();
    const steer = document.querySelector<HTMLElement>('[data-testid="task-chat-send-mode-steer"]')!;
    expect(steer.getAttribute("aria-disabled") ?? steer.getAttribute("data-disabled")).not.toBeNull();
    expect(steer.textContent).toContain("Not available: this runner can't take messages mid-turn.");
    expect(document.querySelector('[data-testid="task-chat-send-mode-key-steer"]')).toBeNull();
  });

  it("a pick names what the click does (Interrupt)", () => {
    render({ mode: "interrupt" });
    expect(container.querySelector('[data-testid="task-chat-composer-send"]')?.textContent).toBe("Interrupt");
  });
});
