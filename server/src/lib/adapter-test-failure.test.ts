import { describe, expect, it } from "vitest";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { adapterTestErrorResult, adapterTestFailureDiagnostic, readAdapterTestFailure, recordAdapterTestFailure, redactAdapterTestResult } from "./adapter-test-failure.js";

// Keep: provider diagnostics cross a credential boundary into durable state and logs.
describe("adapter probe diagnostic boundary", () => {
  const failed = (message: string): AdapterEnvironmentTestResult => ({ adapterType: "paperclip_runner", status: "fail", testedAt: new Date(0).toISOString(),
    checks: [{ code: "account_metadata", level: "info", message: "Account selected" },
      { code: "pi_rpc_hello_probe_failed", level: "error", message, detail: "Provider error details", hint: "Retry after repair" }] });

  it("keeps the failed check rather than informational account prefixes", () => {
    const error = Object.assign(new Error("The harness test failed"), { code: "harness_test_failed" });
    recordAdapterTestFailure(error, failed("Model paperclip/claude-opus-5-5 not found"));
    expect(readAdapterTestFailure(error)).toEqual({ failureCode: "pi_rpc_hello_probe_failed",
      failureDetail: "Model paperclip/claude-opus-5-5 not found\nProvider error details\nRetry after repair" });
    expect(error.code).toBe("harness_test_failed");
    expect(readAdapterTestFailure({ code: "pi_rpc_hello_probe_failed", message: "untrusted" })).toBeUndefined();
    recordAdapterTestFailure(error, failed("Replacement diagnostic"));
    expect(readAdapterTestFailure(error)?.failureDetail).not.toContain("Replacement");
  });

  it("retains a non-Error throw as the cause for existing lifecycle classification", () => {
    const original = { code: "harness_auth_failed" };
    const error = recordAdapterTestFailure(original, failed("The account needs authentication"));
    expect(error.cause).toBe(original);
    expect(readAdapterTestFailure(error)?.failureCode).toBe("pi_rpc_hello_probe_failed");
  });

  it("redacts raw, encoded and nested credential echoes before bounding every diagnostic field", () => {
    const credential = "opaque value/+?";
    const nested = "nested-credential-canary";
    const message = `Model not found; ${credential}; ${encodeURIComponent(credential)}; ${nested}; api_key=sk-canary; ${"x".repeat(3_000)}`;
    const result = failed(message);
    result.checks[1]!.detail = message;
    result.checks[1]!.hint = message;
    const redacted = redactAdapterTestResult(result, { env: { CUSTOM: credential, PROVIDER_AUTH: JSON.stringify({ key: nested }) } });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain(encodeURIComponent(credential));
    expect(serialized).not.toContain(nested);
    expect(serialized).not.toContain("sk-canary");
    expect(redacted.checks[1]!.message).toContain("Model not found");
    for (const text of [redacted.checks[1]!.message, redacted.checks[1]!.detail!, redacted.checks[1]!.hint!, adapterTestFailureDiagnostic(redacted).failureDetail]) {
      expect(text.length).toBeLessThanOrEqual(2_000);
    }
  });

  it.each(["private code with spaces", "x".repeat(129), "api_key=sk-code-canary"])("does not persist malformed or unbounded diagnostic codes: %s", code => {
    const result = adapterTestErrorResult("paperclip_runner", Object.assign(new Error("Probe failed"), { code }));
    expect(result.checks[0]!.code).toBe("harness_test_failed");
    expect(JSON.stringify(result)).not.toContain("sk-code-canary");
  });

  it("preserves cleanup and HTTP probe codes, and names a code-less thrown probe", () => {
    expect(adapterTestErrorResult("paperclip_runner", { code: "NATIVE_ENVIRONMENT_PROBE_CLEANUP_PENDING" }).checks[0]!.code)
      .toBe("NATIVE_ENVIRONMENT_PROBE_CLEANUP_PENDING");
    expect(adapterTestErrorResult("paperclip_runner", { details: { code: "native_probe_cleanup_pending" } }).checks[0]!.code)
      .toBe("native_probe_cleanup_pending");
    expect(adapterTestErrorResult("paperclip_runner", new Error("Probe failed")).checks[0]!.code).toBe("adapter_probe_failed");
  });
});
