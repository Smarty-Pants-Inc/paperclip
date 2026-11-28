// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/api/client";
import { useWakeIntent } from "./useWakeIntent";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState;
let noteTyping: () => void;
let sequence = 0;
let issueId: string;

function Probe({ id, enabled }: { id: string | null; enabled: boolean }) {
  ({ noteTyping } = useWakeIntent(id, { enabled }));
  return null;
}

function paint(id: string | null = issueId, enabled = true) {
  act(() => root.render(<StrictMode><Probe id={id} enabled={enabled} /></StrictMode>));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.spyOn(api, "post").mockResolvedValue(undefined);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  issueId = `wake-${++sequence}`;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useWakeIntent", () => {
  it("opens once under StrictMode and rerenders, and opens a changed or newly enabled task", () => {
    paint(null);
    paint(issueId, false);
    expect(api.post).not.toHaveBeenCalled();
    paint();
    paint();
    expect(api.post).toHaveBeenCalledExactlyOnceWith(`/issues/${issueId}/wake-intent`, { reason: "open" });
    paint(`${issueId}-next`);
    expect(api.post).toHaveBeenLastCalledWith(`/issues/${issueId}-next/wake-intent`, { reason: "open" });
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it("throttles typing to 60 seconds per issue, shared across components and remounts", () => {
    paint();
    vi.mocked(api.post).mockClear();
    noteTyping();
    noteTyping();
    vi.advanceTimersByTime(59_999);
    noteTyping();
    expect(api.post).toHaveBeenCalledExactlyOnceWith(`/issues/${issueId}/wake-intent`, { reason: "typing" });
    const otherContainer = document.createElement("div");
    const otherRoot = createRoot(otherContainer);
    try {
      act(() => otherRoot.render(<Probe id={issueId} enabled />));
      vi.mocked(api.post).mockClear();
      noteTyping();
      expect(api.post).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      noteTyping();
      expect(api.post).toHaveBeenCalledExactlyOnceWith(`/issues/${issueId}/wake-intent`, { reason: "typing" });
    } finally {
      act(() => otherRoot.unmount());
    }
    act(() => root.unmount());
    root = createRoot(container);
    paint();
    vi.mocked(api.post).mockClear();
    noteTyping();
    expect(api.post).not.toHaveBeenCalled();
    paint(`${issueId}-other`);
    noteTyping();
    expect(api.post).toHaveBeenLastCalledWith(`/issues/${issueId}-other/wake-intent`, { reason: "typing" });
  });

  it("never sends while hidden, opens on visibility, and does not consume the typing allowance", () => {
    visibility = "hidden";
    paint();
    noteTyping();
    expect(api.post).not.toHaveBeenCalled();
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    noteTyping();
    expect(api.post).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    vi.advanceTimersByTime(60_000);
    noteTyping();
    expect(api.post).toHaveBeenCalledTimes(2);
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    noteTyping();
    expect(api.post).toHaveBeenCalledTimes(3);
  });

  it("posts JSON to the wake-intent route without waiting for a response", () => {
    vi.mocked(api.post).mockRestore();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    paint();
    noteTyping();
    expect(fetch).toHaveBeenNthCalledWith(1, `/api/issues/${issueId}/wake-intent`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ reason: "open" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/issues/${issueId}/wake-intent`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ reason: "typing" }),
    }));
    const init = fetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("does not send typing when disabled", () => {
    paint(issueId, false);
    noteTyping();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([404, 405, 501, 500, "offline", "sync"])("swallows %s errors without surfacing them", async (failure) => {
    const error = typeof failure === "number" ? new ApiError("Unavailable", failure, {}) : new Error("Offline");
    if (failure === "sync") vi.mocked(api.post).mockImplementation(() => { throw error; });
    else vi.mocked(api.post).mockRejectedValue(error);
    expect(() => paint()).not.toThrow();
    expect(() => noteTyping()).not.toThrow();
    await act(async () => {});
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(console.debug).toHaveBeenCalledTimes(2);
  });
});
