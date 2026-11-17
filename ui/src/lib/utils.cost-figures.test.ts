import { expect, it } from "vitest";
import { formatCents, formatConfiguredCents, formatSpendPercent } from "./utils";

it("temporarily hides rate-card cost figures", () => {
  expect(formatCents(1234)).toBe("—");
  expect(formatCents(0)).toBe("—");
});

it("masks spend-derived percentages including zero and over-budget amounts", () => {
  for (const percent of [0, 16, 79.2, 114.46, 1200]) expect(formatSpendPercent(percent)).toBe("—");
});

it("keeps configured amounts visible with currency and cents precision", () => {
  expect(formatConfiguredCents(0)).toBe("$0.00");
  expect(formatConfiguredCents(1234)).toBe("$12.34");
  expect(formatConfiguredCents(1234, "EUR")).toBe("€12.34");
  expect(formatConfiguredCents(1234, "US!")).toBe("US! 12.34");
});
