import { expect, it, vi } from "vitest";

// Unit test agreed: the task explicitly requests the env parsing/default contract.
it("keeps the remote runner poll default and accepts only bounded positive integer overrides", async () => {
  try {
    for (const [raw, expected] of [
      [undefined, 1_000], ["", 1_000], ["250", 250], ["5000", 5_000], ["60000", 60_000],
      ["0", 1_000], ["-1", 1_000], ["249", 1_000], ["60001", 1_000],
      ["250.5", 1_000], ["NaN", 1_000], ["Infinity", 1_000], ["1000ms", 1_000],
    ] as const) {
      vi.stubEnv("PAPERCLIP_REMOTE_RUNNER_PROCESS_POLL_MS", raw);
      vi.resetModules();
      const { REMOTE_RUNNER_PROCESS_POLL_MS } = await import("./native-session-executor.js");
      expect({ raw, interval: REMOTE_RUNNER_PROCESS_POLL_MS }).toEqual({ raw, interval: expected });
    }
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}, 60_000);
