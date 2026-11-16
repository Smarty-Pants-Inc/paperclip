import { describe, expect, it, vi } from "vitest";
import { redactSecretShapes } from "./secret-shapes.js";
import { leakedPemWindows, secretShapePemVectors } from "./secret-shapes-pem.test-fixture.js";
import { identityMarkPrecisionInputs } from "./secret-shapes-identity.test-fixture.js";
import { shapeAssignments, shapeNegatives, shapePems, shapeTokens } from "./drivers/pi/pi-shape-redaction.test-fixture.js";

// Keep reason: data-safety trust boundary; these check exact kinds and the pure
// pass independently of the Pi projector's older, generic diagnostic masking.
describe("redactSecretShapes", () => {
  it("fails closed on any scanner exception, never returning raw text", () => {
    const replace = vi.spyOn(String.prototype, "replace").mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    try {
      expect(redactSecretShapes(`ghp_${"FakeToken9".repeat(4)}`)).toBe("[REDACTED:unscannable]");
    } finally { replace.mockRestore(); }
  });
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
  it.for(secretShapePemVectors().filter(vector => vector.supported))(
    "hides $keyType $name after an identity redactor erases PEM framing", ({ text, body }) => {
      // efe82e8f masks markers and >=40-character context runs. It can leave
      // short rewrapped/escaped runs untouched, even with no configured key.
      const identityProjected = text.replace(/-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/g, "***REDACTED***")
        .replace(/[A-Za-z0-9+/=]{40,}/g, "***REDACTED***");
      for (const input of [text, identityProjected]) {
        const output = redactSecretShapes(input);
        expect(leakedPemWindows(output, body)).toBe(0);
        expect(output).not.toMatch(/-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/);
        expect(redactSecretShapes(output)).toBe(output);
      }
    },
  );
  it.for(["***REDACTED***", "***REDACTED*** safe prose.", "safe prose. ***REDACTED***"])(
    "preserves identity marks without an adjacent PEM-sized body run: %s", text => {
      expect(redactSecretShapes(text)).toBe(text);
    },
  );
  it.for(identityMarkPrecisionInputs)("O1: preserves $name after an identity mark", ({ text }) => {
    expect(redactSecretShapes(text)).toBe(text);
    expect(redactSecretShapes(redactSecretShapes(text))).toBe(text);
  });
  it.each(["/SomeMixedCase/Repository/SourceTree/Runtime", "CamelCaseIdentifierWithThirtyTwoCharactersAndMore"])(
    "retains the documented conservative PEM interpretation of %s", ambiguous => {
      const input = `***REDACTED***\n${ambiguous}\nls\nPASS\n`;
      const output = "***REDACTED***\n[REDACTED:pem]\n[REDACTED:pem]\n[REDACTED:pem]\n";
      expect(redactSecretShapes(input)).toBe(output);
      expect(redactSecretShapes(output)).toBe(output);
    },
  );
  it("still hides a contiguous PEM body immediately following an identity mark", () => {
    const body = "AbCdEf01+/".repeat(16);
    const output = redactSecretShapes(`***REDACTED***${body}`);
    expect(output).not.toContain(body);
    expect(output).toContain("***REDACTED***");
    expect(redactSecretShapes(output)).toBe(output);
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
