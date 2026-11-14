import { describe, expect, it } from "vitest";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { adapterTestCleanupErrorResult, adapterTestErrorResult, adapterTestFailureDiagnostic, readAdapterTestFailure, recordAdapterTestFailure, redactAdapterTestResult } from "./adapter-test-failure.js";

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

  it("keeps the first teardown's code and redacts every cleanup check before persistence", () => {
    const credential = "cleanup secret/+?";
    const first = Object.assign(new Error(`Sync out failed: ${credential}; ${encodeURIComponent(credential)}; api_key=sk-cleanup-canary; ${"x".repeat(3_000)}`),
      { code: "fixture_sync_out_failed" });
    const second = Object.assign(new Error(`Authority release failed: ${credential}`), { details: { code: "fixture_release_failed" } });
    const result = adapterTestCleanupErrorResult("paperclip_runner", [first, second], { env: { CUSTOM: credential } });
    expect(result.checks.map(check => check.code)).toEqual(["fixture_sync_out_failed", "fixture_release_failed"]);
    const diagnostic = adapterTestFailureDiagnostic(result);
    expect(diagnostic).toMatchObject({ failureCode: "fixture_sync_out_failed", failureDetail: expect.stringContaining("Sync out failed") });
    expect(diagnostic.failureDetail.length).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain(encodeURIComponent(credential));
    expect(JSON.stringify(result)).not.toContain("sk-cleanup-canary");
  });

  it.each(["runner_remote_checkpoint_archive_unsafe_entry", "runner_remote_checkpoint_archive_unsafe_entry: forbidden link"])("recognizes the Runner's message-only cleanup code: %s", message => {
    expect(adapterTestFailureDiagnostic(adapterTestCleanupErrorResult("paperclip_runner", [new Error(message)])))
      .toEqual({ failureCode: "runner_remote_checkpoint_archive_unsafe_entry", failureDetail: message });
    // Message inference is deliberately restricted to teardown normalization.
    expect(adapterTestErrorResult("paperclip_runner", new Error(message)).checks[0]!.code).toBe("adapter_probe_failed");
  });

  it("does not replace explicit cleanup codes with message prefixes", () => {
    const reason = Object.assign(new Error("runner_remote_checkpoint_archive_unsafe_entry: evidence lost"), { code: "fixture_sync_out_failed" });
    expect(adapterTestCleanupErrorResult("paperclip_runner", [reason]).checks[0]!.code).toBe("fixture_sync_out_failed");
  });

  it.each([{ reasons: [] }, { reasons: [new Error("Cleanup proof unavailable")] }, { reasons: ["Cleanup proof unavailable"] }])("names uncoded or absent cleanup errors without inventing a provider code: $reasons", ({ reasons }) => {
    const diagnostic = adapterTestFailureDiagnostic(adapterTestCleanupErrorResult("paperclip_runner", reasons));
    expect(diagnostic.failureCode).toBe("native_probe_cleanup_failed");
    expect(diagnostic.failureDetail).toBeTruthy();
  });

  it("preserves cleanup and HTTP probe codes, and names a code-less thrown probe", () => {
    expect(adapterTestErrorResult("paperclip_runner", { code: "NATIVE_ENVIRONMENT_PROBE_CLEANUP_PENDING" }).checks[0]!.code)
      .toBe("NATIVE_ENVIRONMENT_PROBE_CLEANUP_PENDING");
    expect(adapterTestErrorResult("paperclip_runner", { details: { code: "native_probe_cleanup_pending" } }).checks[0]!.code)
      .toBe("native_probe_cleanup_pending");
    expect(adapterTestErrorResult("paperclip_runner", new Error("Probe failed")).checks[0]!.code).toBe("adapter_probe_failed");
    expect(adapterTestErrorResult("paperclip_runner", "Non-Error probe throw").checks[0]!.message).toBe("The adapter environment probe failed.");
  });
});
