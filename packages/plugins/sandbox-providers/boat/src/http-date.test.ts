// Keep: provider-clock trust boundary; permissive dates can falsely age a stop.
import { describe, expect, it } from "vitest";
import { parseHttpDate } from "./http-date.js";
const now = Date.UTC(2026, 10, 13, 12);
describe("strict provider HTTP clock", () => {
  it.each([
    ["Sun, 06 Nov 1994 08:49:37 GMT", "1994-11-06T08:49:37.000Z"],
    ["Sunday, 06-Nov-94 08:49:37 GMT", "1994-11-06T08:49:37.000Z"],
    ["Sun Nov  6 08:49:37 1994", "1994-11-06T08:49:37.000Z"],
    ["Thu, 29 Feb 2024 23:59:59 GMT", "2024-02-29T23:59:59.000Z"],
    ["Thu, 01 Jan 1970 00:00:00 GMT", "1970-01-01T00:00:00.000Z"],
    ["Sat, 14 Nov 2026 12:00:00 GMT", "2026-11-14T12:00:00.000Z"],
  ])("accepts %s", (date, expected) => expect(parseHttpDate(date, now)).toBe(expected));
  it.each([
    null, "", "0", "1", "1970", "9999", "2026-11-13T12:00:00Z",
    "Fri, 31 Feb 2026 12:00:00 GMT", "Wed, 29 Feb 2023 12:00:00 GMT",
    "Thu, 29 Feb 2024 24:00:00 GMT", "Thu, 29 Feb 2024 12:60:00 GMT",
    "Thu, 29 Feb 2024 12:00:60 GMT", "Thu, 00 Feb 2024 12:00:00 GMT",
    "Fri, 29 Feb 2024 12:00:00 GMT", "Thu, 29 Feb 2024 12:00:00 UTC",
    "Thu, 29 Feb 2024 12:00:00 +0000", "thu, 29 Feb 2024 12:00:00 GMT",
    "Thu, 9 Feb 2024 12:00:00 GMT", "Thu Feb 09 12:00:00 2024",
    "Thu, 29 Feb 2024 12:00:00 GMT ", " Thu, 29 Feb 2024 12:00:00 GMT",
    "Thu, 01 Jan 2076 00:00:00 GMT", "Fri, 31 Dec 9999 23:59:59 GMT",
    "Wed, 31 Dec 1969 23:59:59 GMT", "Sat, 14 Nov 2026 12:00:01 GMT",
    "Friday, 31-Feb-26 12:00:00 GMT", "Fri Feb 31 12:00:00 2026",
  ])("rejects %j", date => expect(parseHttpDate(date, now)).toBeNull());
});
