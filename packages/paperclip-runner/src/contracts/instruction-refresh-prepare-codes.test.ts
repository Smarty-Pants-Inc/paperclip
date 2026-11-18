import { expect, it } from "vitest";
import { INSTRUCTION_REFRESH_PREPARE_CODES, RUNNER_PREPARE_REFUSAL_CODES,
  isInstructionRefreshPrepareCode } from "./harness-driver.js";

it("instruction refresh codes are all Runner prepare refusal codes", () => {
  expect(INSTRUCTION_REFRESH_PREPARE_CODES.length).toBeGreaterThan(0);
  for (const code of INSTRUCTION_REFRESH_PREPARE_CODES) {
    expect(RUNNER_PREPARE_REFUSAL_CODES).toContain(code);
    expect(isInstructionRefreshPrepareCode(code)).toBe(true);
  }
  expect(INSTRUCTION_REFRESH_PREPARE_CODES).toEqual(
    RUNNER_PREPARE_REFUSAL_CODES.filter(isInstructionRefreshPrepareCode),
  );
});
