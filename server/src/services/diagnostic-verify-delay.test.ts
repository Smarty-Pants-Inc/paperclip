import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { diagnosticVerifyDelay } from "./diagnostic-verify-delay.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("diagnostic verification delay", () => {
  it("does not sleep by default and sleeps/logs the configured delay", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.stubEnv("PAPERCLIP_DIAG_VERIFY_DELAY_MS", undefined);
    await diagnosticVerifyDelay("lease-1");
    expect(vi.getTimerCount()).toBe(0);
    vi.stubEnv("PAPERCLIP_DIAG_VERIFY_DELAY_MS", "125");
    const waiting = diagnosticVerifyDelay("lease-1");
    expect(log).toHaveBeenCalledWith("[paperclip] diag verify delay 125 ms on box lease-1");
    await vi.advanceTimersByTimeAsync(124);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(settled).toBe(true);
  });
});
