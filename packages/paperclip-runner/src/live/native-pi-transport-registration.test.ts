import { expect, it } from "vitest";
import { PI_THINKING_LEVELS } from "../drivers/pi/qualified-profile.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

// Component boundary: construction itself previously applied ACPX's incompatible resolver.
it.each(PI_THINKING_LEVELS)("admits native %s at the real runnerd transport constructor", level => {
  expect(() => createCapabilityRunnerdCodexTransport({ provider: "pi_rpc", piRpcThinkingLevel: level })).not.toThrow();
});
it("keeps the legacy ACPX Pi policy unchanged", () => {
  expect(() => createCapabilityRunnerdCodexTransport({ provider: "acpx", acpxAgent: "pi", piThinkingLevel: "xhigh" })).toThrow("Invalid Pi thinking level");
});
