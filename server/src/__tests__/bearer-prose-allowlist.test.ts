// Task-authorized never-OK guard: a prose exception must not expose credentials.
import { describe, expect, it } from "vitest";
import { redactEventPayload, redactSensitiveText } from "../redaction.js";

const prose = [
  "pass the bearer token along",
  "the bearer bond matured.",
  "Bearer-friendly docs",
  "lantern bearer marks every room",
  "bearer A",
  "bearer Well-known",
  "bearer abcdefghijklmnopqrs",
  "bearer abcdefghi-jklmnopqr",
  ...[".", ",", ";", ":", "!", "?", ")", "]", ".!?)];:"].map(p => `bearer word${p}`),
];
const credentials = [
  "'Bearer abc'",
  '"Bearer abc"',
  "`Bearer abc`",
  "'Bearer abc",
  '"Bearer abc',
  "`Bearer abc",
  "Bearer secret!123456789012345",
  "Bearer token:1234567890123456",
  "Bearer café123456789012345678",
  "bearer abc123def456",
  "bearer AbCdEfGhIjKl",
  "bearer abcdefghijklmnopqrst",
  "bearer abcdefghi-jklmnopqrs",
  "bearer well-Known",
  "bearer abc_def",
  "bearer abc/def",
  "bearer abc.def",
  "bearer abc--def",
  "bearer café",
  "bearer word;123",
  "bearer word,123",
  "bearer word]123",
  'bearer word;"abc"',
  "bearer word'",
  'bearer "word"',
  "bearer 'word'",
  'Authorization: Bearer word',
  'Authorization: Bearer well-known',
  '{"Bearer": "word"}',
  '{"authorization": "Bearer word"}',
];

describe("standalone bearer prose allowlist", () => {
  it.each(prose)("preserves prose: %s", input => {
    expect(redactSensitiveText(input)).toBe(input);
    expect(redactEventPayload({ text: input })).toEqual({ text: input });
  });
  it.each(credentials)("keeps the credential masked: %s", input => {
    expect(redactSensitiveText(input)).toContain("REDACTED");
    expect(redactEventPayload({ text: input })?.text).toContain("REDACTED");
  });
  it.each([...prose, ...credentials])("is idempotent: %s", input => {
    const once = redactSensitiveText(input);
    expect(redactSensitiveText(once)).toBe(once);
    const event = redactEventPayload({ text: input });
    expect(redactEventPayload(event)).toEqual(event);
  });
});
