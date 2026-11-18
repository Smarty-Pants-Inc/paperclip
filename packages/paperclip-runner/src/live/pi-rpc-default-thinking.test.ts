import { expect, it } from "vitest";
import { createCapabilityRunnerdProviderEnvironment } from "./runnerd-codex-transport.js";

// Keep reason: native runner -> facade environment/effort contract boundary.
it.each([[undefined, "max"], ["low", "low"]] as const)("defaults Pi transport thinking from the shared catalog (%s)", (configured, expected) => {
  const environment = createCapabilityRunnerdProviderEnvironment({
    provider: "pi_rpc", model: "paperclip/claude-opus-5-5", options: { provider: "pi_rpc", piRpcThinkingLevel: configured, environment: {} },
    identity: { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1", normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1" },
    codexHome: "/isolated/home", runtimeContextPath: "/isolated/context.json", hasRuntimeContext: false,
  });
  expect(environment.PAPERCLIP_PI_THINKING_LEVEL).toBe(expected);
});
