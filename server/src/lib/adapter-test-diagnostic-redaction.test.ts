import { describe, expect, it } from "vitest";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import {
  adapterTestCleanupErrorResult,
  adapterTestErrorResult,
  readAdapterTestFailure,
  recordAdapterTestFailure,
  redactAdapterTestResult,
} from "./adapter-test-failure.js";

// Keep: RFL F1 exposed provider credentials in durable state, read APIs and WARN
// logs. Test the shared trust boundary, including unknown (not configured) values.
const canary = "diagnostic-canary-7Qx9";
const result = (text: string): AdapterEnvironmentTestResult => ({
  adapterType: "paperclip_runner", status: "fail", testedAt: new Date(0).toISOString(),
  checks: [{ code: "runner_remote_checkpoint_archive_unsafe_entry", level: "error",
    message: text, detail: text, hint: text, retryable: true }],
});

const credentials = [
  `Cookie: session=${canary}; preference=public`,
  `cOoKiE: preference=public; session=${canary}`,
  `Set-Cookie: session=${canary}; Path=/; HttpOnly`,
  `set-cookie: session="${canary}"; Secure`,
  `Authorization: Bearer ${canary}`,
  `Authorization: Basic ${canary}`,
  `Authorization: Digest username=public, response="${canary}"`,
  `Proxy-Authorization: Negotiate ${canary}`,
  `proxy-authorization: Basic ${canary}`,
  `Cookie session=public; other=${canary}`,
  `Set-Cookie session=${canary}; HttpOnly`,
  `Authorization Negotiate ${canary}`,
  `Proxy-Authorization Digest username=public, response="${canary}"`,
  `"Cookie": "session=${canary}; preference=public"`,
  `"Proxy-Authorization": "Digest response=${canary}"`,
  `https://runner.invalid/?_port_auth=${canary}&page=2`,
  `https://runner.invalid/?custom_auth=${canary}&page=2`,
  `https://runner.invalid/?token=${canary}&page=2`,
  `https://runner.invalid/?access_token=${canary}&page=2`,
  `https://runner.invalid/?sig=${canary}&page=2`,
  `https://runner.invalid/?signature=${canary}&page=2`,
  `https://runner.invalid/?X-Amz-Signature=${canary}&page=2`,
  `https://runner.invalid/?X-Amz-Credential=${canary}&page=2`,
  `https://runner.invalid/?x-amz-security-token=${canary}&page=2`,
  `https://runner.invalid/?X-Amz-Custom=${canary}&page=2`,
  `https://runner.invalid/?key=${canary}&page=2`,
  `https://runner.invalid/?api_key=${canary}&page=2`,
  `https://runner.invalid/?password=${canary}&page=2`,
  `https://runner.invalid/?%74oken=${canary}&page=2`,
  `https://runner.invalid/?safe=1&TOKEN=${canary}&token=${canary}#evidence`,
  `https://user:${canary}@runner.invalid/evidence?page=2`,
  `postgresql://user:${canary}@runner.invalid/database`,
  `https://${canary}@runner.invalid/evidence`,
  `//user:${canary}@runner.invalid/evidence`,
  ...["DB_PASSWORD", "proxyPassword", "db_passwd", "customSecretValue", "accessToken", "apiKey", "clientCookie", "providerCredential", "_port_auth", "AUTH", "password", "token", "key", "mixedAUTHField", "secretBucket"].flatMap(name =>
    [" ", "=", ":", " = ", " : ", "\t"].map(delimiter => `${name}${delimiter}${canary}`)),
  `proxyPassword="${canary} with spaces"`,
  `proxyPassword: '${canary} with spaces'`,
  `"proxyPassword": "${canary} with spaces"`,
  `DB_PASSWORD "${canary} with \\"escaped\\" quotes"`,
  `proxyPassword="${canary} with no closing quote`,
  `secretBucket="prefix \\"${canary}\\" with spaces"`,
  JSON.stringify({ secretBucket: `${canary} with spaces` }),
  JSON.stringify(JSON.stringify({ secretBucket: `${canary} with spaces` })),
];

describe("credential-shaped probe and cleanup prose (RFL F1)", () => {
  it.each(credentials)("redacts all diagnostic fields: %s", credential => {
    const input = result(`Checkpoint failed (EIO)\n${credential}\nRetry after repair`);
    const redacted = redactAdapterTestResult(input);
    for (const field of ["message", "detail", "hint"] as const) {
      expect(redacted.checks[0]![field]).not.toContain(canary);
      expect(redacted.checks[0]![field]).toContain("Checkpoint failed (EIO)");
      expect(redacted.checks[0]![field]).toContain("Retry after repair");
      expect(redacted.checks[0]![field]!.length).toBeLessThanOrEqual(2_000);
    }
    expect(redacted.checks[0]!.code).toBe(input.checks[0]!.code);
    expect(redacted.checks[0]!.retryable).toBe(true);
    expect(redactAdapterTestResult(redacted)).toEqual(redacted);
    expect(input.checks[0]!.message).toContain(canary);
  });

  it.each([
    "The 1Password plan requires an upgrade; retry checkpoint EIO after repair.",
    "1Password plan",
    "Upgrade 1Password: plan selection failed.",
    "The execution test did not pass and returned no diagnostic checks.",
    "Use bearer authentication and bearer tokens.",
    "runner_remote_checkpoint_archive_unsafe_entry: forbidden link",
    "GET https://runner.invalid/evidence?attempt=3&mode=archive#checkpoint returned EIO",
    "Model paperclip/claude-opus-5-5 not found; code=404; retryable=true",
  ])("preserves safe useful prose: %s", text => {
    expect(redactAdapterTestResult(result(text))).toEqual(result(text));
  });

  it("preserves non-credential URL context and sanitizes encoded query names", () => {
    const text = `GET https://runner.invalid/evidence?attempt=3&%58-Amz-Custom=${canary}&mode=archive#checkpoint returned EIO`;
    const clean = redactAdapterTestResult(result(text)).checks[0]!.message;
    expect(clean).not.toContain(canary);
    expect(clean).toContain("https://runner.invalid/evidence?attempt=3&%58-Amz-Custom=");
    expect(clean).toContain("&mode=archive#checkpoint returned EIO");
  });

  it("uses the same normalization for returned probes, thrown probes, cleanup causes and retained failures", () => {
    const text = `Checkpoint failed (EIO)\nCookie: session=${canary}\nDB_PASSWORD ${canary}\nRetry after repair`;
    const error = new Error(text);
    const returned = redactAdapterTestResult(result(text));
    const thrown = adapterTestErrorResult("paperclip_runner", error);
    const cleanup = adapterTestCleanupErrorResult("paperclip_runner", [error]);
    recordAdapterTestFailure(error, result(text));
    for (const surface of [returned, thrown, cleanup, readAdapterTestFailure(error)]) {
      expect(JSON.stringify(surface)).not.toContain(canary);
      expect(JSON.stringify(surface)).toContain("Checkpoint failed (EIO)");
      expect(JSON.stringify(surface)).toContain("Retry after repair");
    }
  });

  it("redacts before the existing 2,000-character bound", () => {
    const input = `${"x".repeat(1_985)}\nproxyPassword ${canary}`;
    const clean = redactAdapterTestResult(result(input)).checks[0]!.message;
    expect(clean.length).toBeLessThanOrEqual(2_000);
    expect(clean).not.toContain(canary.slice(0, 3));
  });
});
