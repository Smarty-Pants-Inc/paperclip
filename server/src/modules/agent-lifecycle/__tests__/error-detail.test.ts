import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLifecycleEffects, lifecycleErrorDetail } from "../../../services/agent-lifecycle.js";
import { logger } from "../../../middleware/logger.js";
import { HttpError } from "../../../errors.js";

afterEach(() => vi.restoreAllMocks());

describe("lifecycleErrorDetail", () => {
  it.each([
    ["native_portable_task_ownership_pending", "native_portable_task_ownership_pending"],
    ["runner_harness_state_mismatch: provider_identity_changed", "runner_harness_state_mismatch: provider_identity_changed"],
  ])("keeps bounded diagnostic codes", (message, expected) => {
    const detail = JSON.parse(lifecycleErrorDetail(new Error(message))) as Array<{ message: string }>;
    expect(detail[0]?.message).toBe(expected);
  });

  it.each([
    "auth_failed: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
    "auth_failed: sk-live-abc123",
    "deadbeefdeadbeefdeadbeefdeadbeef",
    "env LANGFUSE_SECRET_KEY=SENTINELsecret-9f8e7d6c5b4a3921 rejected",
  ])("withholds unsafe message %s", message => {
    const detail = JSON.parse(lifecycleErrorDetail(new Error(message))) as Array<{ message: string }>;
    expect(detail[0]?.message).toBe("withheld");
  });

  it("reports safe HttpError status and detail code without exposing its message", () => {
    const error = new Error("outer", { cause: new HttpError(422, "free text with secret sk-abcdefghijklmnopqrstuvwx", { code: "pi_probe_runner_exited" }) });
    const detail = JSON.parse(lifecycleErrorDetail(error)) as Array<{ status?: number; detailCode?: string; message: string }>;
    expect(detail[1]).toMatchObject({ status: 422, detailCode: "pi_probe_runner_exited", message: "withheld" });
    expect(JSON.stringify(detail)).not.toContain("sk-abcdefghijklmnopqrstuvwx");

    const secretCode = new HttpError(422, "unsafe", { code: "sk-abcdefghijklmnopqrstuvwx" });
    const secretDetail = JSON.parse(lifecycleErrorDetail(secretCode)) as Array<{ detailCode?: string }>;
    expect(secretDetail[0]?.detailCode).toBeUndefined();
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
    const effects = createAgentLifecycleEffects();
    effects.reportFailure({ stage: "host", phase: "verifying" }, error);
    for (const message of [
      "auth_failed: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
      "auth_failed: sk-live-abc123",
      "deadbeefdeadbeefdeadbeefdeadbeef",
      "env LANGFUSE_SECRET_KEY=SENTINELsecret-9f8e7d6c5b4a3921 rejected",
    ]) effects.reportFailure({ stage: "host", phase: "verifying" }, new Error(message));
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ["SENTINEL", "3f9a8b7c6d5e", "sk-live", "deadbeefdeadbeef"]) {
      expect(logged).not.toContain(secret);
    }
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorDetail: expect.any(String) }), "Agent lifecycle operation failed");
    const fields = warn.mock.calls[0]?.[0] as { errorDetail: string };
    expect(fields.errorDetail.length).toBeLessThanOrEqual(512);
  });
});
