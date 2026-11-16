import { describe, expect, it, vi } from "vitest";

const { shape } = vi.hoisted(() => ({ shape: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", () => ({ redactSecretShapes: shape }));
import { redactRunnerApiPayloads } from "./runner-api-log-redaction.js";

// Keep reason: persistence trust-boundary failure path. Never retry an unsafe
// regexp on the identical field after JSON.parse/redaction has thrown.
describe("shape scanner failure at persistence", () => {
  it.each(['{"ordinary":"output"}', '[unterminated output', 'plain output'])("masks the whole field on scanner failure: %s", input => {
    shape.mockReset().mockImplementation((value: string) => {
      if (value === input) throw new RangeError("Maximum call stack size exceeded");
      return value;
    });
    expect(redactRunnerApiPayloads(input)).toBe("[REDACTED:unscannable]");
    // Nested parsed fields can be masked independently. No field is retried.
    expect(shape.mock.calls.filter(([value]) => value === input)).toHaveLength(1);
  });
});
