import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "./pi-event-projector.js";

// C1-C3 (pack-n5) RED, no fix: a 100 KiB Pi tool result must be fully
// available to a person (inline, or spilled to a readable file whose path is
// given), and what a person sees carries no "[... truncated]" marker.
// Superseding this needs a judge: existing tests pin the 64 KiB projector cut
// and its marker (see result.md).
describe("C1-C3 a 100 KiB Pi tool output is fully available, no marker", () => {
  // it.fails: RED today (the projector emits "[Pi tool output truncated] ..."). Flip to
  // it(...) when the judge-approved C1-C3 fix lands.
  it.fails("projects a 100 KiB dynamic-tool result whole or as a readable spill", () => {
    const output = Array.from({ length: 1600 }, (_, index) => `row ${index} ${"q".repeat(60)}`).join("\n");
    expect(Buffer.byteLength(output)).toBeGreaterThan(100 * 1024);
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    projector.project({ type: "tool_execution_start", toolCallId: "t1", toolName: "paperclip_issue_read", args: {} });
    const events = projector.project({ type: "tool_execution_end", toolCallId: "t1", toolName: "paperclip_issue_read", result: { content: [{ type: "text", text: output }] } });
    const completed = events.find(event => event.eventType === "tool.execution.completed");
    const shown = String(completed?.payload.output ?? "");
    expect(shown).not.toMatch(/truncated/i);
    const spill = /Full output: (\/[^\s\]]+)/u.exec(shown)?.[1];
    if (spill) expect(readFileSync(spill, "utf8")).toBe(output);
    else expect(shown).toBe(output);
  });
});
