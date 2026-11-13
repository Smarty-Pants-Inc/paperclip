import { describe, expect, it } from "vitest";
import { nativeSessionFailureSourceCode, nativeSessionFailureDisposition } from "./native-runtime/native-session-executor.js";
import { transientProviderStartFailure, transientStartRetryAt } from "./transient-start-wait.js";

const failure = { schema: "paperclip.provider-failure.v1", provider: "codex", phase: "startup",
  category: "overloaded", message: "Provider busy", httpStatus: 503, retryability: "transient" };

describe("closed transient START policy", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])("admits typed transient startup HTTP %s", httpStatus => {
    expect(transientProviderStartFailure({ ...failure, httpStatus })).toBe(true);
  });
  it.each([
    { httpStatus: 401 }, { httpStatus: 403 }, { httpStatus: 404 }, { httpStatus: 501 },
    { phase: "turn" }, { retryability: "requires_action" }, { retryability: "unknown" },
    { category: "authentication" }, { category: "permission" }, { category: "invalid_request" },
    { category: "model_unavailable" }, { category: "unknown" }, { category: "quota_exhausted" },
  ])("does not widen the allowlist for %j", changed => {
    expect(transientProviderStartFailure({ ...failure, ...changed })).toBe(false);
  });
  it("does not infer a transient refusal from prose", () => {
    expect(transientProviderStartFailure({ message: "Boat 429 sandbox starts unavailable" })).toBe(false);
    expect(nativeSessionFailureSourceCode(new Error("unknown transport closed"))).toBe("native_session_interrupted");
    for (const text of ["runner_state_identity_mismatch", "runner_retained_live_owner", "runner_task_admission_rejected: account_binding_mismatch"]) {
      const code = nativeSessionFailureSourceCode(new Error(text));
      expect(code).not.toMatch(/^provider_startup_/);
    }
  });
  it("names exact startup transport and typed session.open refusal, never provider turn failures", () => {
    expect(nativeSessionFailureSourceCode(new Error("runnerd transport closed during provider startup")))
      .toBe("provider_startup_transport_closed");
    const error = Object.assign(new Error("PRP command session.open failed: provider unavailable"), { providerFailure: failure });
    expect(nativeSessionFailureSourceCode(error)).toBe("provider_startup_unavailable");
    expect(nativeSessionFailureSourceCode(Object.assign(new Error("unknown failure"), { providerFailure: failure })))
      .toBe("native_session_interrupted");
    expect(nativeSessionFailureDisposition(64, new Date(), "provider_startup_transport_closed", true).phase).toBe("retryable_failure");
    expect(nativeSessionFailureDisposition(64, new Date(), "provider_startup_transport_closed").phase).toBe("terminal_failure");
    expect(nativeSessionFailureDisposition(64, new Date(), "runner_task_admission_rejected", true).phase).toBe("terminal_failure");
  });
  it("never retries a paid start sooner than five minutes, including arbitrarily late attempts, and honors retryAt", () => {
    const now = new Date("2026-11-13T20:00:00Z");
    expect(transientStartRetryAt(now, failure)).toEqual(new Date("2026-11-13T20:05:00Z"));
    expect(transientStartRetryAt(now, { ...failure, retryAt: "2026-11-13T20:01:00Z" })).toEqual(new Date("2026-11-13T20:05:00Z"));
    expect(transientStartRetryAt(now, { ...failure, retryAt: "2026-11-13T21:00:00Z" })).toEqual(new Date("2026-11-13T21:00:00Z"));
  });
});
