import { expect, it } from "vitest";
import { redactProviderDiagnostic } from "./diagnostic-redaction.js";

// Keep: Pi P0 bounded previews used to trigger a quadratic failed URL search.
it("preserves large ordinary output without scanning every suffix for a URL scheme", () => {
  const output = "x".repeat(300_000);
  expect(redactProviderDiagnostic(output)).toBe(output);
});
it("still redacts URL credentials and all existing diagnostic credential forms", () => {
  expect(redactProviderDiagnostic("https://alice:secret@example.invalid/path")).toBe("https://[REDACTED]@example.invalid/path");
  expect(redactProviderDiagnostic("Bearer abc.def Basic dXNlcjpwYXNz")).toBe("Bearer [REDACTED] Basic [REDACTED]");
  expect(redactProviderDiagnostic("Basic API")).toBe("Basic API");
  expect(redactProviderDiagnostic("?token=secret&password=hidden")).toBe("?token=[REDACTED]");
  expect(redactProviderDiagnostic('{"api_key":"secret"}')).toBe('{"api_key":"[REDACTED]"}');
  expect(redactProviderDiagnostic("token=secret SERVICE_API_KEY=hidden")).toBe("token=[REDACTED] SERVICE_API_KEY=[REDACTED]");
});
