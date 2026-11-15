import { expect, it } from "vitest";
import { formatCents } from "./utils";

it("temporarily hides rate-card cost figures", () => {
  expect(formatCents(1234)).toBe("—");
});
