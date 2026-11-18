import { expect, it } from "vitest";
import { redactProviderDiagnostic } from "./diagnostic-redaction.js";

// Keep: Pi P0 bounded previews used to trigger a quadratic failed URL search.
it("preserves large ordinary output without scanning every suffix for a URL scheme", () => {
  const output = "x".repeat(300_000);
  expect(redactProviderDiagnostic(output)).toBe(output);
});
// Never-OK: terminal control sequences must not split a credential before scanning.
it.each([
  "Authorization: \u001b[31mBearer abcdefgh\u001b[0m",
  "Authorization:\u001b[31m Bearer abcdefgh\u001b[0m",
  "Authoriz\u001b[31mation: Bearer abcdefgh\u001b[0m",
  "Authorization: Bearer \u001b[31mabcdefgh\u001b[0m",
  "\u001b[31mAuthorization: Bearer abcdefgh\u001b[0m",
  "Authorization: Bearer abcd\u001b]0;terminal title\u0007efgh",
])("strips ANSI before scanning credentials: %s", input => {
  expect(redactProviderDiagnostic(input)).toBe("Authorization: Bearer [REDACTED]");
});
it("keeps answer-like bearer prose strict", () => {
  expect(redactProviderDiagnostic("the Bearer of bad news arrived")).toBe("the Bearer [REDACTED] bad news arrived");
});
it("still redacts URL credentials and all existing diagnostic credential forms", () => {
  expect(redactProviderDiagnostic("https://alice:secret@example.invalid/path")).toBe("https://[REDACTED]@example.invalid/path");
  expect(redactProviderDiagnostic("Bearer abc.def Basic dXNlcjpwYXNz")).toBe("Bearer [REDACTED] Basic [REDACTED]");
  expect(redactProviderDiagnostic("Basic API")).toBe("Basic API");
  expect(redactProviderDiagnostic("?token=secret&password=hidden")).toBe("?token=[REDACTED]");
  expect(redactProviderDiagnostic('{"api_key":"secret"}')).toBe('{"api_key":"[REDACTED]"}');
  expect(redactProviderDiagnostic("token=secret SERVICE_API_KEY=hidden")).toBe("token=[REDACTED] SERVICE_API_KEY=[REDACTED]");
});
