// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { classifyError } from "@/api/errors";
import { ApiUnavailableError, readApiJson } from "@/api/response";
import { readTranscriptRequest, TRANSCRIPT_REQUEST_TIMEOUT_MS } from "./read-transcript-request";

describe("history retry feedback request budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ["network", () => new TypeError("Failed to fetch")],
    ["aborted transport", () => new DOMException("Aborted", "AbortError")],
    ["HTTP 429", () => new ApiError("Busy", 429, {})],
    ["HTTP 503", () => new ApiError("Unavailable", 503, {})],
  ] as const)("keeps a %s failure pending through one successful retry", async (_kind, error) => {
    const read = vi.fn().mockRejectedValueOnce(error()).mockResolvedValue("saved history");
    const settled = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).then(settled, settled);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith("saved history");
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exposes the second transient failure instead of retrying forever", async () => {
    const failure = new ApiError("Still unavailable", 503, {});
    const read = vi.fn().mockRejectedValue(failure);
    const rejected = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).catch(rejected);
    await vi.advanceTimersByTimeAsync(2_000);
    await result;
    expect(read).toHaveBeenCalledTimes(2);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404])("does not delay a real HTTP %s failure", async status => {
    const failure = new ApiError("History unavailable", status, {});
    const read = vi.fn().mockRejectedValue(failure);
    await expect(readTranscriptRequest(read, new AbortController().signal)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors Retry-After before the one retry", async () => {
    const read = vi.fn().mockRejectedValueOnce(new ApiError("Busy", 429, {}, { retryAfterMs: 5_000 })).mockResolvedValue("history");
    const settled = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).then(settled, settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith("history");
  });

  it("cancels a scheduled retry when the view is superseded", async () => {
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const rejected = vi.fn();
    const result = readTranscriptRequest(read, controller.signal).catch(rejected);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rejected).not.toHaveBeenCalled();
    controller.abort();
    await result;
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one total deadline across retry and response-body consumption", async () => {
    let finish!: (value: string) => void;
    const failure = new ApiError("Unavailable", 503, {});
    const read = vi.fn().mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    const settled = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).then(settled, settled);
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith(failure);
    expect(settled.mock.calls[0][0]).toBe(failure);
    expect(classifyError(settled.mock.calls[0][0])).toBe("transient");
    expect(read.mock.calls[1][0].aborted).toBe(true);
    finish("late history");
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a late first failure when the retry cannot finish before the deadline", async () => {
    const failure = new ApiError("Unavailable", 503, {});
    let fail!: (error: unknown) => void;
    let retrySignal!: AbortSignal;
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { fail = reject; }))
      .mockImplementationOnce(signal => {
        retrySignal = signal;
        return new Promise<string>(resolve => window.setTimeout(() => resolve("late history"), 1_000));
      });
    const rejected = vi.fn();
    const resolved = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).then(resolved, rejected);
    await vi.advanceTimersByTimeAsync(12_500);
    fail(failure);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(retrySignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(rejected.mock.calls[0][0]).toBe(failure);
    expect(classifyError(rejected.mock.calls[0][0])).toBe("transient");
    expect(retrySignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the generic timeout when the first read never answers", async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>(() => new Promise<string>(() => {}));
    const rejected = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).catch(rejected);
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_REQUEST_TIMEOUT_MS - 1);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("too long") }));
    expect(classifyError(rejected.mock.calls[0][0])).toBe("unknown");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately with a proxy 503 when Retry-After exceeds the budget", async () => {
    const failure = await readApiJson(new Response("<html>Unavailable</html>", {
      status: 503,
      headers: { "Content-Type": "text/html", "Retry-After": "20" },
    })).catch(error => error);
    expect(failure).toBeInstanceOf(ApiUnavailableError);
    expect(failure).not.toBeInstanceOf(ApiError);
    expect((failure as ApiUnavailableError).retryAfterMs).toBe(20_000);
    const read = vi.fn().mockRejectedValue(failure);
    const rejected = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).catch(rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(rejected.mock.calls[0][0]).toBe(failure);
    expect(classifyError(rejected.mock.calls[0][0])).toBe("transient");
    await result;
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([15_000, 20_000, 60_000])("rejects immediately with the original error when Retry-After is %s ms", async retryAfterMs => {
    const failure = new ApiError("Unavailable", 503, {}, { retryAfterMs });
    const read = vi.fn().mockRejectedValue(failure);
    const rejected = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).catch(rejected);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(classifyError(rejected.mock.calls[0][0])).toBe("transient");
    await result;
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([13_000, 14_000])("rejects immediately with the original error when the first failure arrives after %s ms", async elapsedMs => {
    const failure = new ApiError("Unavailable", 503, {});
    let fail!: (error: unknown) => void;
    const read = vi.fn(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
    const rejected = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).catch(rejected);
    await vi.advanceTimersByTimeAsync(elapsedMs);
    expect(rejected).not.toHaveBeenCalled();
    fail(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(classifyError(rejected.mock.calls[0][0])).toBe("transient");
    await result;
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still retries when the wait ends just before the deadline", async () => {
    let fail!: (error: unknown) => void;
    const read = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue("history");
    const settled = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).then(settled, settled);
    await vi.advanceTimersByTimeAsync(12_999);
    fail(new ApiError("Unavailable", 503, {}));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(read).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith("history");
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue a request for an already cancelled view", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();
    await expect(readTranscriptRequest(read, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
  });
});
