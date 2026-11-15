import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLifecycleEffects, lifecycleErrorDetail } from "../../../services/agent-lifecycle.js";
import { logger } from "../../../middleware/logger.js";

afterEach(() => vi.restoreAllMocks());

describe("lifecycleErrorDetail", () => {
  it.each([
    ["native_portable_task_ownership_pending", "native_portable_task_ownership_pending"],
    ["runner_harness_state_mismatch: provider_identity_changed", "runner_harness_state_mismatch: provider_identity_changed"],
  ])("keeps bounded diagnostic codes", (message, expected) => {
    expect(lifecycleErrorDetail(new Error(message))).toMatchObject({ message: expected });
  });

  it.each([
    "auth_failed: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
    "auth_failed: sk-live-abc123",
    "deadbeefdeadbeefdeadbeefdeadbeef",
    "env LANGFUSE_SECRET_KEY=SENTINELsecret-9f8e7d6c5b4a3921 rejected",
  ])("withholds unsafe message %s", message => {
    expect(lifecycleErrorDetail(new Error(message))).toMatchObject({ message: "withheld" });
  });

  it("limits cause depth, reports cause code, and bounds serialized detail", () => {
    const error = new Error("x", { cause: Object.assign(new Error("t"), { code: "PLUGIN_RPC_TIMEOUT" }) });
    const detail = lifecycleErrorDetail(error);
    expect(detail).toContain("PLUGIN_RPC_TIMEOUT");
    expect(detail.length).toBeLessThanOrEqual(512);
  });

  it("does not leak unsafe errors or their causes to the warning", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const error = new Error("safe outer");
    error.cause = new Error("env LANGFUSE_SECRET_KEY=SENTINELsecret-9f8e7d6c5b4a3921 rejected");
    createAgentLifecycleEffects().reportFailure({ stage: "host", phase: "verifying" }, error);
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ["SENTINEL", "3f9a8b7c6d5e", "sk-live", "deadbeefdeadbeef"]) {
      expect(logged).not.toContain(secret);
    }
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorDetail: expect.any(String) }), "Agent lifecycle operation failed");
    const fields = warn.mock.calls[0]?.[0] as { errorDetail: string };
    expect(fields.errorDetail.length).toBeLessThanOrEqual(512);
  });
});
