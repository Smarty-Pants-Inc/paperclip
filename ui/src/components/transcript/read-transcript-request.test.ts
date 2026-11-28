// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { classifyError } from "@/api/errors";
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
    const read = vi.fn().mockRejectedValueOnce(new ApiError("Unavailable", 503, {}))
      .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    const settled = vi.fn();
    const result = readTranscriptRequest(read, new AbortController().signal).then(settled, settled);
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("too long") }));
    expect(read.mock.calls[1][0].aborted).toBe(true);
    finish("late history");
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(1);
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
