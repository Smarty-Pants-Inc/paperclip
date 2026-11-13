import { expect, it } from "vitest";
import { parseStrictIsoInstant } from "./strict-iso-instant.js";

it("accepts exact ISO 8601 instants with an explicit zone", () => {
  expect(parseStrictIsoInstant("2026-11-13T10:00:00Z")).toBe(Date.UTC(2026, 10, 13, 10));
  expect(parseStrictIsoInstant("2026-11-13T10:00:00.123Z")).toBe(Date.UTC(2026, 10, 13, 10, 0, 0, 123));
  expect(parseStrictIsoInstant("2026-11-13T10:00:00.123456789Z")).toBe(Date.UTC(2026, 10, 13, 10, 0, 0, 123));
  expect(parseStrictIsoInstant("2026-11-13T12:00:00+02:00")).toBe(Date.UTC(2026, 10, 13, 10));
  expect(parseStrictIsoInstant("2024-02-29T00:00:00Z")).toBe(Date.UTC(2024, 1, 29));
});

it("rejects impossible calendar fields, a missing zone and garbage", () => {
  for (const value of ["2026-02-30T00:00:00.000Z", "2025-02-29T00:00:00Z", "2026-11-31T00:00:00Z", "2026-13-01T00:00:00Z",
    "2026-11-13T24:00:00Z", "2026-11-13T10:60:00Z", "2026-11-13T10:00:60Z", "2026-11-13T10:00:00", "2026-11-13",
    "2026-11-13T10:00:00+24:00", "2026-11-13T10:00:00+02:60", "garbage", "", 1_794_566_400_000, null, undefined]) {
    expect(parseStrictIsoInstant(value), String(value)).toBeNull();
  }
});
