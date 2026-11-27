import { afterEach, describe, expect, it, vi } from "vitest";
import { readLimitFromEnv } from "../services/env-limits.js";

// Pure parser: checks fallback and overrides without starting a server.
describe("readLimitFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "", " ", "abc", "0", "-1", "1.5", "Infinity", "500oops", "9007199254740992"])(
    "keeps the stock value for %s", value => {
      vi.stubEnv("PAPERCLIP_TEST_LIMIT", value);
      expect(readLimitFromEnv("PAPERCLIP_TEST_LIMIT", 25)).toBe(25);
    },
  );

  it("reads a positive integer per call", () => {
    vi.stubEnv("PAPERCLIP_TEST_LIMIT", "500");
    expect(readLimitFromEnv("PAPERCLIP_TEST_LIMIT", 25)).toBe(500);
    vi.stubEnv("PAPERCLIP_TEST_LIMIT", " 501 ");
    expect(readLimitFromEnv("PAPERCLIP_TEST_LIMIT", 25)).toBe(501);
    vi.stubEnv("PAPERCLIP_TEST_LIMIT", undefined);
    expect(readLimitFromEnv("PAPERCLIP_TEST_LIMIT", 25)).toBe(25);
  });
});
