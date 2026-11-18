import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPiEventProjector, type PiProjectedEvent } from "./pi-event-projector.js";

// C1-C3 (pack-n5, Paul NOTE 5): a large Pi tool output is fully available,
// inline or spilled to a readable file whose path is given; no cut marker
// reaches the person's view; every projected record stays under the 256 KiB
// frame bound (spill or page, never cut, never a raised bound).
const CUT_MARKERS = ["[Pi tool output truncated]", "[Pi projection truncated]", "...for display", "for display]", "…[truncated]"];
const FRAME = 256 * 1024;
function project(output: string) {
  const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
  const events: PiProjectedEvent[] = [];
  events.push(...projector.project({ type: "tool_execution_start", toolCallId: "t1", toolName: "paperclip_issue_read", args: {} }));
  events.push(...projector.project({ type: "tool_execution_end", toolCallId: "t1", toolName: "paperclip_issue_read", result: { content: [{ type: "text", text: output }] } }));
  return events;
}
function whole(shown: string): string {
  const spill = /\[Full output: (\/[^\s\]]+)/u.exec(shown)?.[1];
  return spill ? readFileSync(spill, "utf8") : shown;
}

describe("C1-C3 a 100 KiB Pi tool output is fully available, no marker", () => {
  it("projects a 100 KiB dynamic-tool result whole or as a readable spill", () => {
    const rows = Array.from({ length: 1600 }, (_, index) => `row ${index} ${"q".repeat(60)}`);
    rows[800] = "SENTINEL-MIDDLE-7f3a9 the agent must be able to quote this line";
    const output = rows.join("\n");
    expect(Buffer.byteLength(output)).toBeGreaterThan(100 * 1024);
    const events = project(output);
    for (const event of events) {
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(FRAME);
      for (const marker of CUT_MARKERS) expect(JSON.stringify(event)).not.toContain(marker);
    }
    const completed = events.find(event => event.eventType === "tool.execution.completed");
    const item = events.find(event => event.eventType === "item.completed");
    for (const shown of [String(completed?.payload.output ?? ""), String(item?.payload.output ?? ""), String(item?.payload.text ?? "")]) {
      expect(whole(shown)).toBe(output);
      expect(whole(shown)).toContain("SENTINEL-MIDDLE-7f3a9");
    }
    expect(completed?.payload).toMatchObject({ outputTruncated: false, outputBytes: Buffer.byteLength(output) });
  });

  it("spills a 600 KiB multi-byte tool result whole (byte-equal) and keeps each record under 256 KiB", () => {
    const unit = "Zeile \"ü\" 🦀 漢字\\\n";
    const output = unit.repeat(Math.ceil(600 * 1024 / Buffer.byteLength(unit))) + "END-SENTINEL";
    const events = project(output);
    for (const event of events) {
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(FRAME);
      for (const marker of CUT_MARKERS) expect(JSON.stringify(event)).not.toContain(marker);
    }
    const completed = events.find(event => event.eventType === "tool.execution.completed");
    const shown = String(completed?.payload.output);
    expect(shown).toMatch(/\[Full output: \//u);
    expect(Buffer.from(whole(shown), "utf8").equals(Buffer.from(output, "utf8"))).toBe(true);
    // outputTruncated marks the output FIELD as an excerpt; the whole output is in the spill file.
    expect(completed?.payload).toMatchObject({ outputTruncated: true, outputBytes: Buffer.byteLength(output), outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}` });
  });
});
