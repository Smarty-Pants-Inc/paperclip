import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "./pi-event-projector.js";

// C4 (pack-n5), TypeScript half: a 40,000-character Pi final answer read from a
// raw Pi RPC JSONL record is projected whole (byte-equal), with no marker.
describe("C4 Pi final answer is projected whole", () => {
  it("projects a 40,000-character final answer byte-equal to the raw JSONL text", () => {
    const unit = "Line \"quoted\" 🦀 naïve\n";
    const answer = Array.from(unit.repeat(Math.ceil(40_000 / Array.from(unit).length))).slice(0, 40_000).join("");
    expect(Array.from(answer)).toHaveLength(40_000);
    const rawJsonl = JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", timestamp: 1,
      responseId: "reply-1", stopReason: "stop", content: [{ type: "text", text: answer }] } });
    const raw = JSON.parse(rawJsonl);
    const events = createPiEventProjector({ runId: "run", turnId: "turn" }).project(raw);
    const completed = events.find(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage");
    expect(completed?.payload.channel).toBe("final");
    const text = String(completed?.payload.text);
    expect(Buffer.from(text, "utf8").equals(Buffer.from(raw.message.content[0].text, "utf8"))).toBe(true);
    expect(text).not.toMatch(/truncated/i);
  });
});
