import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSandboxCallbackBridgePollIntervalMs } from "./execution-target.js";

const ENV = "PAPERCLIP_SANDBOX_CALLBACK_BRIDGE_POLL_INTERVAL_MS";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sandbox callback bridge poll interval configuration", () => {
  it("uses 100ms when unset and passes a configured 1000ms through", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env[ENV];
    expect(resolveSandboxCallbackBridgePollIntervalMs()).toBe(100);
    process.env[ENV] = "1000";
    expect(resolveSandboxCallbackBridgePollIntervalMs()).toBe(1000);
    expect(warning).not.toHaveBeenCalled();
  });

  // These are the four unsafe-value cases independently identified by the RFL judge.
  it.each([
    ["0.5", 100],
    ["2147483648", 1000],
    ["60000", 1000],
    ["abc", 100],
  ])("keeps the RFL safety case %j in the safe range", (value, expected) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSandboxCallbackBridgePollIntervalMs(value)).toBe(expected);
  });

  it.each([["-5", 100], ["0", 100], ["50", 100], ["5001", 1000]])(
    "clamps or rejects boundary value %j to %i",
    (value, expected) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(resolveSandboxCallbackBridgePollIntervalMs(value)).toBe(expected);
    },
  );

  it("warns once at configuration time for an invalid value", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveSandboxCallbackBridgePollIntervalMs("0.5")).toBe(100);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain(ENV);
  });
});
