import { describe, expect, it } from "vitest";
import { isInterruptedPiJson, piTailMayHaveVisibleContent } from "./pi-session-file.js";

// Keep reason: data safety; malformed JSON must never authorize prefix repair.
describe("Pi interrupted JSON classification", () => {
  it.each(['{"type":!!!}', '{"a":01', '{"a":true,}', '[1,,', '{"a":"bad\\q', '{"a":"bad\n', '{"a":"\\uZZ',
    '{"a":truX', '{"a":undefined', '{foo', '[NaN', '[+1', '[.1', '{}{}', '{"a":1}garbage'])
  ("rejects a tail that no appended suffix can repair: %s", text => {
    expect(isInterruptedPiJson(text)).toBe(false);
  });
  it.each([{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "line\n🐘\"\\" }] } },
    { type: "custom", values: [null, true, false, -1.23e-17, [], {}], unicode: "\u0001" }])
  ("accepts every interrupted serialization prefix %#", value => {
    const text = JSON.stringify(value);
    for (let end = 1; end < text.length; end++) {
      const prefix = text.slice(0, end);
      expect(isInterruptedPiJson(prefix), JSON.stringify(prefix)).toBe(true);
    }
    expect(isInterruptedPiJson(text)).toBe(false);
  });
  it.each(['{"a":1e', '{"a":1e+', '{"a":0.', '{"a":-', '{"a":"\\u00', '{"a":"\\', '{"a"'])
  ("keeps valid incomplete numbers, escapes and structure: %s", text => expect(isInterruptedPiJson(text)).toBe(true));
  it("treats unknown/message prefixes conservatively, not metadata as visible loss", () => {
    expect(piTailMayHaveVisibleContent('{"type":"message","message":{"role":"toolResult"')).toBe(true);
    expect(piTailMayHaveVisibleContent('{"ty')).toBe(true);
    expect(piTailMayHaveVisibleContent('{"type":"thinking_level_change","thinkingLevel":"hi')).toBe(false);
  });
});
