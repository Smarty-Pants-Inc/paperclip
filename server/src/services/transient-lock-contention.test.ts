import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresErrorCode, retryTransientLockContention } from "./transient-lock-contention.js";

// Keep: data safety. Only a classified transaction failure may replay SQL;
// transport loss has an unknown commit outcome and must never be replayed here.
afterEach(() => vi.restoreAllMocks());

describe("retryTransientLockContention", () => {
  it("preserves the existing fixed-delay default for whole-operation callbacks", async () => {
    const error = { cause: { code: "40P01" } };
    const write = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValue("committed");
    const sleep = vi.spyOn(globalThis, "setTimeout").mockImplementation(callback => {
      callback(undefined); return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    expect(await retryTransientLockContention(write)).toBe("committed");
    expect(sleep.mock.calls.map(call => call[1])).toEqual([100, 200]);
  });

  it.each(["40P01", "40001", "55P03"])("bounds attempts and reports each actual retry for %s", async code => {
    const error = new Error("transaction aborted", { cause: { code } });
    const write = vi.fn().mockRejectedValue(error);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sleep = vi.spyOn(globalThis, "setTimeout").mockImplementation(callback => {
      callback(undefined); return undefined as unknown as ReturnType<typeof setTimeout>;
    });
    const retries: Array<{ error: unknown; attempt: number; delayMs: number }> = [];
    await expect(retryTransientLockContention(write, 3, {
      jitterMs: attempt => 500 * 2 ** (attempt - 1),
      onRetry: (error, attempt, delayMs) => retries.push({ error, attempt, delayMs }),
    })).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(3);
    expect(retries).toEqual([{ error, attempt: 1, delayMs: 350 }, { error, attempt: 2, delayMs: 700 }]);
    expect(sleep.mock.calls.map(call => call[1])).toEqual([350, 700]);
  });

  it.each(["23505", "42501", "CONNECTION_CLOSED"])("does not retry non-contention %s", async code => {
    const error = new Error("not retry-safe", { cause: { code } });
    const write = vi.fn().mockRejectedValue(error), onRetry = vi.fn();
    await expect(retryTransientLockContention(write, 20, { jitterMs: 500, onRetry })).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not classify arbitrary messages or cyclic causes as PostgreSQL contention", () => {
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
    expect(postgresErrorCode(cycle)).toBeNull();
    expect(postgresErrorCode(new Error("40P01"))).toBeNull();
  });
});
