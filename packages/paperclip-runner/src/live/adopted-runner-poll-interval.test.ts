import { expect, it, vi } from "vitest";

// Unit test agreed: the task explicitly requests the env parsing/default contract.
it("keeps the adopted runner poll default and accepts only bounded positive integer overrides", async () => {
  try {
    for (const [raw, expected] of [
      [undefined, 250], ["", 250], ["250", 250], ["5000", 5_000], ["60000", 60_000],
      ["0", 250], ["-1", 250], ["249", 250], ["60001", 250],
      ["250.5", 250], ["NaN", 250], ["Infinity", 250], ["1000ms", 250],
    ] as const) {
      vi.stubEnv("PAPERCLIP_ADOPTED_RUNNER_POLL_MS", raw);
      vi.resetModules();
      const { ADOPTED_RUNNER_POLL_MS } = await import("./runnerd-codex-transport.js");
      expect({ raw, interval: ADOPTED_RUNNER_POLL_MS }).toEqual({ raw, interval: expected });
    }
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
