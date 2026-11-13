import { describe, expect, it } from "vitest";
import { stopJournalLeftUndeliveredTool } from "./native-user-stop-settlement.js";

// Data-safety boundary: a cancelled run has no result to vouch for an answer.
// Keep the reviewed check6 identical for retirement and retained read binding.
describe("user Stop journal settlement", () => {
  it.each(["semantic_tool.input", "mcp_app.tool_input"])("requires a delivered answer for %s", eventType => {
    const event = { eventType, sourceEventId: "tool-input" };
    const answer = { type: "semantic_tool.result", status: "completed", payload: { sourceEventId: "tool-input" } };
    const bytes = (commands: unknown[]) => JSON.stringify({ commands, committedEvents: [event] });
    expect(stopJournalLeftUndeliveredTool(bytes([]))).toBe(true);
    expect(stopJournalLeftUndeliveredTool(bytes([{ ...answer, status: "pending" }]))).toBe(true);
    expect(stopJournalLeftUndeliveredTool(bytes([{ ...answer, payload: { sourceEventId: "other-input" } }]))).toBe(true);
    expect(stopJournalLeftUndeliveredTool(bytes([answer]))).toBe(false);
  });
  it("refuses an outstanding answer even when the input is no longer in the retained events", () => {
    expect(stopJournalLeftUndeliveredTool(JSON.stringify({ commands: [{ type: "semantic_tool.result", status: "pending" }],
      committedEvents: [] }))).toBe(true);
  });
  it("accepts a tool-free settled journal and refuses unreadable bytes", () => {
    expect(stopJournalLeftUndeliveredTool(JSON.stringify({ commands: [{ type: "turn.interrupt", status: "completed" }],
      committedEvents: [{ eventType: "turn.cancelled" }] }))).toBe(false);
    expect(stopJournalLeftUndeliveredTool("not JSON")).toBe(true);
  });
});
