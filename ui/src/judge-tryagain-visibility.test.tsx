// @vitest-environment jsdom
// Independent requirement probes. This is the existing IssueDetail recovery
// onError toast payload, rendered through the real ToastProvider/ToastViewport.
// Not a live Boat/browser/whole-IssueDetail acceptance claim.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions, type ToastInput } from "./context/ToastContext";
import { ToastViewport } from "./components/ToastViewport";
import { apiErrorFromResponse } from "./api/api-error";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const refusal = "The failed run changed before Try again was accepted. The recovery card remains unresolved; refresh the task and try again.";
const error = apiErrorFromResponse(new Response(null, { status: 409 }), {
  error: refusal, details: { code: "task_retry_source_changed" },
});
const payload: ToastInput = { title: "Recovery resolution failed", body: error.message, tone: "error" };

describe("Judge: native-continuation recovery refusal remains visible", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pushToast: (input: ToastInput) => string | null;
  function Actions() { pushToast = useToastActions().pushToast; return null; }
  function mount() {
    root = createRoot(container);
    act(() => root.render(<ToastProvider><Actions /><ToastViewport /></ToastProvider>));
  }
  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    mount();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  it("the existing error contract displays the concrete refusal immediately", () => {
    act(() => { pushToast(payload); vi.advanceTimersByTime(30); });
    expect(container.textContent).toContain(refusal);
    expect(container.querySelector('aside[aria-live="polite"]')).not.toBeNull();
  });
  it("the only refusal explanation must not disappear after ten seconds", () => {
    act(() => { pushToast(payload); });
    expect(container.textContent).toContain(refusal);
    act(() => { vi.advanceTimersByTime(10_001); });
    console.info("JUDGE refusal after TTL", { text: container.textContent, elapsedMs: 10_001 });
    expect(container.textContent, "person returning later needs the unresolved Try again refusal").toContain(refusal);
  });
  it("the refusal explanation must survive a new page/provider mount", () => {
    act(() => { pushToast(payload); });
    expect(container.textContent).toContain(refusal);
    act(() => root.unmount());
    mount();
    console.info("JUDGE refusal after remount", { text: container.textContent });
    expect(container.textContent, "reload must not erase the only explanation of the refused Retry").toContain(refusal);
  });
});
