import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "../drivers/pi/pi-event-projector.js";
import { openCodeProxyToolNotification } from "./opencode-proxy-events.js";

// ROW-4096 (pack-n5), TypeScript half: what Pi returned to the model for a
// builtin tool (its own <=50 KB page plus Pi's "Full output: PATH" footer)
// crosses the proxy facade to runnerd whole, not silently sliced to 16,384.
describe("Pi tool output crosses the proxy facade whole", () => {
  it("forwards a ~57 KB Pi bash result byte-equal, with no cut marker", () => {
    let output = Array.from({ length: 800 }, (_, index) => `out ${index} ${"z".repeat(60)} é🦀\n`).join("");
    output += "\n[Showing lines 1201-2000 of 2000. Full output: /tmp/pi-bash-0123.log]";
    expect(output.length).toBeGreaterThan(50_000);
    const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
    projector.project({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "seq 2000" } });
    const events = projector.project({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: output }] } });
    const completed = events.find(event => event.eventType === "tool.execution.completed");
    expect(completed?.payload.output).toBe(output);
    const notification = openCodeProxyToolNotification({ eventType: "tool.execution.completed", threadId: "thread", turnId: "turn", payload: completed!.payload as Record<string, unknown> });
    const forwarded = String((notification!.params.item as Record<string, unknown>).output);
    expect(forwarded).not.toMatch(/truncated/i);
    expect(Buffer.from(forwarded).equals(Buffer.from(output))).toBe(true);
  });
});
