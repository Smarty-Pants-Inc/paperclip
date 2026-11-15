import { expect, it } from "vitest";
import { agentHarnessType, DEFAULT_AGENT_OBSERVABILITY_CAPTURE } from "@paperclipai/shared";
import * as launch from "../services/agent-observability-launch.js";

it("R1: the production preparation gate maps paperclip_runner/pi_rpc to pi, not unsupported_harness", () => {
  const harness = agentHarnessType("paperclip_runner", { provider: "pi_rpc" });
  expect(harness).toBe("pi_rpc");
  expect(launch.agentObservabilityKind(harness, "paperclip_runner")).toBe("pi");
  expect(launch.agentObservabilityKind("pi_local", "pi_local")).toBeUndefined();
  expect(launch.agentObservabilityKind("opencode_local", "opencode_local")).toBeUndefined();
  expect(launch.agentObservabilityKind("opencode_local", "paperclip_runner")).toBe("opencode");
});
it("R3/R8: enabled and disabled company snapshots never share credentials", () => {
  const input = { kind: "pi" as const, companyId: "on", agentId: "agent", runId: "run", taskId: "task" };
  const enabled = launch.agentObservabilityLaunch({ state: "enabled", revision: "revision", compatibilityKey: "on-key", capture: DEFAULT_AGENT_OBSERVABILITY_CAPTURE,
    logsEndpoint: "https://collector.example/v1/logs", tracesEndpoint: "https://collector.example/v1/traces", headers: { authorization: "sentinel" } }, input);
  const disabled = launch.agentObservabilityLaunch({ state: "disabled", revision: "revision", compatibilityKey: "off-key" }, { ...input, companyId: "off" });
  expect(enabled.environment).toHaveProperty("PAPERCLIP_OBSERVABILITY_PI", "1");
  expect(enabled.environment.OTEL_RESOURCE_ATTRIBUTES).toContain("paperclip.task.id=task");
  expect(disabled.environment).toHaveProperty("PAPERCLIP_OBSERVABILITY_PI", "0");
  expect(JSON.stringify(disabled)).not.toContain("sentinel");
  expect(disabled.compatibilityKey).not.toBe(enabled.compatibilityKey);
});
