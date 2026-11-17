import { expect, it } from "vitest";
import { formatCents, formatConfiguredCents } from "./utils";

it("temporarily hides rate-card cost figures", () => {
  expect(formatCents(1234)).toBe("—");
  expect(formatCents(0)).toBe("—");
});

it("keeps configured amounts visible with currency and cents precision", () => {
  expect(formatConfiguredCents(0)).toBe("$0.00");
  expect(formatConfiguredCents(1234)).toBe("$12.34");
  expect(formatConfiguredCents(1234, "EUR")).toBe("€12.34");
  expect(formatConfiguredCents(1234, "US!")).toBe("US! 12.34");
});
