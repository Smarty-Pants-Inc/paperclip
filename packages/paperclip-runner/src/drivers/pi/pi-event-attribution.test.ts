import { describe, expect, it } from "vitest";
import { createPiEventProjector, type PiProjectedEvent } from "./pi-event-projector.js";

const original = { runId: "run-a", turnId: "turn-a" };
const usage = (input: number) => ({ input, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } });
const delta = (text: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
const receipt = (id: string, input: number) => ({
  type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", responseId: id,
    stopReason: "stop", content: [{ type: "text", text: id }], usage: usage(input) },
});
const toolStart = { type: "tool_execution_start", toolCallId: "reused-native-id", toolName: "bash", args: { command: "printf hello" } };
const toolResult = { type: "message_end", message: { role: "toolResult", toolCallId: "reused-native-id", toolName: "bash", content: [{ type: "text", text: "late output" }], usage: usage(3) } };

// Keep reason: data safety at the native-event -> PRP run attribution boundary.
// This is a controlled delayed-callback regression, not a live-driver claim.
describe.each([
  { runId: "run-a", turnId: "turn-b" },
  { runId: "run-b", turnId: "turn-b" },
])("settled Pi origin survives next admission $runId/$turnId", nextOrigin => {
  function startNext() {
    // Drivers can reuse a mutable current-origin holder. The projector must
    // snapshot it, and a delayed callback must keep its original projector.
    const driverOrigin = { ...original };
    const settled = createPiEventProjector(driverOrigin);
    settled.project(delta("old partial"));
    settled.project(toolStart);
    settled.project({ type: "agent_settled" });
    Object.assign(driverOrigin, nextOrigin);
    const next = createPiEventProjector(driverOrigin);
    next.project(delta("new partial"));
    next.project(toolStart);
    // A PRP envelope's current context must never replace explicit projected
    // origin. Before C3 these missing fields silently fall back to the new run.
    const envelope = (event: PiProjectedEvent) => ({ ...driverOrigin, ...event });
    return { settled, next, envelope };
  }

  it("keeps late text on its original settled turn, not the current turn/run", () => {
    const { settled, next, envelope } = startNext();
    const late = settled.project(delta("late old text"));
    expect(late.length).toBeGreaterThan(0);
    for (const event of late.map(envelope)) expect(event).toMatchObject(original);
    for (const event of next.project(delta("new text")).map(envelope)) expect(event).toMatchObject(nextOrigin);
  });

  it("keeps late tool result and nested usage on the original turn/run", () => {
    const { settled, next, envelope } = startNext();
    const late = settled.project(toolResult);
    expect(late.some(event => event.eventType === "tool.execution.completed")).toBe(true);
    expect(late.some(event => event.eventType === "usage.reported")).toBe(true);
    for (const event of late.map(envelope)) expect(event).toMatchObject(original);
    // Same native call ID in the next projector is independently completed.
    expect(next.project(toolResult).filter(event => event.eventType === "tool.execution.completed")).toHaveLength(1);
  });

  it("keeps late usage deltas and accumulated totals off the next run", () => {
    const { settled, next, envelope } = startNext();
    const late = settled.project(receipt("old-reply", 11));
    const lateUsage = late.filter(event => event.eventType === "usage.reported" || event.payload.kind === "usage");
    expect(lateUsage).toHaveLength(2);
    for (const event of lateUsage.map(envelope)) expect(event).toMatchObject(original);
    expect(lateUsage[0].payload.runDelta).toMatchObject({ inputTokens: 11, outputTokens: 2 });
    expect(lateUsage[1].payload.usage).toMatchObject({ total: { inputTokens: 11 } });
    const current = next.project(receipt("new-reply", 5));
    for (const event of current.map(envelope)) expect(event).toMatchObject(nextOrigin);
    expect(current.find(event => event.eventType === "usage.reported")?.payload.runDelta).toMatchObject({ inputTokens: 5 });
    expect(current.find(event => event.payload.kind === "usage")?.payload.usage).toMatchObject({ total: { inputTokens: 5 } });
    expect(settled.project(receipt("old-reply", 11))).toEqual([]);
  });
});
