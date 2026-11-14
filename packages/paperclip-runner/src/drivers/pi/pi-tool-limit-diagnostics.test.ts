import { expect, it } from "vitest";
import { piToolLimitMessage } from "./pi-tool-limit-diagnostics.js";

// Keep reason: actionable failure guidance for the recorded late-payload catch.
it("formats the driver-measured dispatch count with one explicit next step", () => {
  expect(piToolLimitMessage(129)).toBe("Pi openai-completions total tool cap 128 exceeded in provider request: 129 tools. Request refused; no tools were silently trimmed. Reduce this agent's tools or ask the board.");
});
