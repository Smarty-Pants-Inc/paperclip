import { describe, expect, it } from "vitest";
import { formatProjectBudget } from "./utils";

describe("formatProjectBudget", () => {
  it("renders a /mo suffix for monthly budgets", () => {
    expect(formatProjectBudget({ amountCents: 120_000, windowKind: "calendar_month_utc" })).toBe("—/mo");
  });

  it("renders the bare amount for lifetime budgets", () => {
    expect(formatProjectBudget({ amountCents: 50_000, windowKind: "lifetime" })).toBe("—");
  });

  it("hides sub-dollar amounts temporarily", () => {
    expect(formatProjectBudget({ amountCents: 150, windowKind: "lifetime" })).toBe("—");
  });
});
