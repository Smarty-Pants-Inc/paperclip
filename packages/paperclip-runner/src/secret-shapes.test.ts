import { describe, expect, it } from "vitest";
import { redactSecretShapes } from "./secret-shapes.js";
import { shapeAssignments, shapeNegatives, shapePems, shapeTokens } from "./drivers/pi/pi-shape-redaction.test-fixture.js";

// Keep reason: data-safety trust boundary; these check exact kinds and the pure
// pass independently of the Pi projector's older, generic diagnostic masking.
describe("redactSecretShapes", () => {
  it.for([...shapeTokens, ...shapePems])("replaces the whole $kind value ($label)", ({ kind, value }) => {
    expect(redactSecretShapes(value)).toBe(`[REDACTED:${kind}]`);
    expect(redactSecretShapes(redactSecretShapes(value))).toBe(`[REDACTED:${kind}]`);
  });
  it.for(shapeAssignments)("retains the name and quotes for $value", ({ value, secret }) => {
    const expected = value.replace(secret, "[REDACTED:assignment]");
    expect(redactSecretShapes(value)).toBe(expected);
    expect(redactSecretShapes(expected)).toBe(expected);
  });
  it.for(shapeNegatives)("leaves ordinary text unchanged: %s", value => {
    expect(redactSecretShapes(value)).toBe(value);
  });
  it.for(["[REDACTED]", "[REDACTED:pem]", "***REDACTED***"])("keeps existing assignment marks: %s", value => {
    for (const key of ["KEY", "apiKey", "PASSWORD", "SECRET", "PRIVATE", "CREDENTIAL", "TOKEN"]) {
      for (const text of [`${key}=${value}`, `${key}='${value}'`, `"${key}": "${value}"`]) expect(redactSecretShapes(text)).toBe(text);
    }
  });
  it("preserves a large non-PEM base64-looking dump, including after an orphan END", () => {
    const dump = `${"A".repeat(76)}\n`.repeat(10_000);
    expect(redactSecretShapes(dump)).toBe(dump);
    expect(redactSecretShapes(`-----END RSA PRIVATE KEY-----\n${dump}`)).toBe(`[REDACTED:pem]\n${dump}`);
  });
  it("redacts escaped quotes, multiline assignment values, and several matches", () => {
    expect(redactSecretShapes('"MY_KEY": "one\\\"two", PASSWORD="three\nfour"')).toBe('"MY_KEY": "[REDACTED:assignment]", PASSWORD="[REDACTED:assignment]"');
    expect(redactSecretShapes(`${shapeTokens[0]!.value} safe ${shapeTokens[1]!.value}`)).toBe("[REDACTED:github] safe [REDACTED:github]");
  });
  it.for(["\n", "\r\n", "\\n", "\\\\n", "\\r\\n", " "])("redacts adjacent orphan PEM body lines with separator %j", separator => {
    const lines = ["A".repeat(64), "B".repeat(64), "C".repeat(8)];
    expect(redactSecretShapes(["-----BEGIN RSA PRIVATE KEY-----", ...lines].join(separator))).toBe("[REDACTED:pem]");
    expect(redactSecretShapes([...lines, "-----END RSA PRIVATE KEY-----"].join(separator))).toBe("[REDACTED:pem]");
  });
});
