import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
import { probeManagedNativePiRunner } from "./pi-runner-probe.js";

describe("probeManagedNativePiRunner failure reporting", () => {
  afterEach(() => vi.restoreAllMocks());

  // hq-test (9c305db1): the config test showed only "No hello prompt was sent";
  // the original failure was dropped. The check keeps its safe text, but the
  // operator log must carry the cause.
  it("keeps the safe check message and logs the original cause", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const result = await probeManagedNativePiRunner({
      companyId: "company-probe", adapterType: "paperclip_runner",
      config: { provider: "pi_rpc", model: "paperclip/faux" },
      executionTarget: { kind: "local" },
    } as never);
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({ code: "pi_rpc_metadata_failed",
      message: "The selected factory could not complete native Pi metadata admission. No hello prompt was sent." })]);
    expect(JSON.stringify(result)).not.toContain("remote command factory");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-probe", stage: "metadata",
      cause: expect.stringContaining("Native Pi setup requires a remote command factory") }), "Native Pi setup probe failed");
  });
});
