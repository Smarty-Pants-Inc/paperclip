import { describe, expect, it } from "vitest";
import { defaultSendMode, resolveSendIntent, sendModeShortcut, steerUnavailableReason } from "./send-mode";

const key = (mods: Partial<{ shift: boolean; alt: boolean; ctrl: boolean; meta: boolean; altGraph: boolean }> = {}) => ({
  key: "Enter", shiftKey: Boolean(mods.shift), altKey: Boolean(mods.alt), ctrlKey: Boolean(mods.ctrl),
  metaKey: Boolean(mods.meta), getModifierState: (name: string) => name === "AltGraph" && Boolean(mods.altGraph),
});

// Paul NOTE 6 key table (design revision 2).
describe("send keys while the agent works", () => {
  it("Enter sends (default): Enter = Send, Ctrl/⌘+Enter = Queue, Ctrl/⌘+Alt+Enter = Interrupt, Shift+Enter = new line", () => {
    expect(resolveSendIntent(key(), "enter")).toBe("default");
    expect(resolveSendIntent(key({ ctrl: true }), "enter")).toBe("queue");
    expect(resolveSendIntent(key({ meta: true }), "enter")).toBe("queue");
    expect(resolveSendIntent(key({ ctrl: true, alt: true }), "enter")).toBe("interrupt");
    expect(resolveSendIntent(key({ meta: true, alt: true }), "enter")).toBe("interrupt");
    expect(resolveSendIntent(key({ shift: true }), "enter")).toBeNull();
  });

  it("'Ctrl/⌘+Enter to submit' on: Ctrl/⌘+Enter = Send, Ctrl/⌘+Shift+Enter = Queue, Ctrl/⌘+Alt+Enter = Interrupt, Enter = new line", () => {
    expect(resolveSendIntent(key({ ctrl: true }), "mod-enter")).toBe("default");
    expect(resolveSendIntent(key({ ctrl: true, shift: true }), "mod-enter")).toBe("queue");
    expect(resolveSendIntent(key({ meta: true, shift: true }), "mod-enter")).toBe("queue");
    expect(resolveSendIntent(key({ ctrl: true, alt: true }), "mod-enter")).toBe("interrupt");
    expect(resolveSendIntent(key(), "mod-enter")).toBeNull();
  });

  it("D6: ignores Ctrl+Alt+Enter while AltGr is held (Windows international layouts)", () => {
    expect(resolveSendIntent(key({ ctrl: true, alt: true, altGraph: true }), "enter")).toBeNull();
    expect(resolveSendIntent(key({ ctrl: true, alt: true, altGraph: true }), "mod-enter")).toBeNull();
  });

  it("idle: every send chord just sends, as before, and Alt never sends", () => {
    expect(resolveSendIntent(key(), "enter", { working: false })).toBe("default");
    expect(resolveSendIntent(key({ ctrl: true }), "enter", { working: false })).toBe("default");
    expect(resolveSendIntent(key({ ctrl: true, alt: true }), "enter", { working: false })).toBeNull();
    expect(resolveSendIntent(key(), "mod-enter", { working: false })).toBeNull();
  });
});

describe("default mode", () => {
  it("is Steer while the runner takes it, Queue when it can't (with the reason), and always Queue for /new", () => {
    expect(defaultSendMode({ steeringDisposition: "available" })).toBe("steer");
    expect(defaultSendMode({ steeringDisposition: "unsupported" })).toBe("queue");
    expect(steerUnavailableReason({ steeringDisposition: "unsupported" })).toBe("Not available: this runner can't take messages mid-turn.");
    expect(steerUnavailableReason({ steeringDisposition: "temporarily_unavailable" })).toBe("Steering is temporarily unavailable.");
    expect(defaultSendMode({ steeringDisposition: "available", draftIsReset: true })).toBe("queue");
  });

  it("shows each mode's key in the menu, per preference", () => {
    const pc = { isMac: false, defaultMode: "steer" as const };
    expect(sendModeShortcut("steer", "enter", pc)).toBe("Enter");
    expect(sendModeShortcut("queue", "enter", pc)).toBe("Ctrl+Enter");
    expect(sendModeShortcut("interrupt", "enter", pc)).toBe("Ctrl+Alt+Enter");
    expect(sendModeShortcut("steer", "mod-enter", pc)).toBe("Ctrl+Enter");
    expect(sendModeShortcut("queue", "mod-enter", pc)).toBe("Ctrl+Shift+Enter");
    expect(sendModeShortcut("interrupt", "mod-enter", pc)).toBe("Ctrl+Alt+Enter");
    expect(sendModeShortcut("queue", "enter", { isMac: true, defaultMode: "steer" })).toBe("⌘↩");
  });
});
