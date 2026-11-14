import { describe, expect, it } from "vitest";
import { newerSettledNativeJournal } from "./native-settled-journal.js";

const identity = { runId: "prior-run", normalizedSessionId: "session", runnerInstanceId: "runner", environmentLeaseId: "lease", turnId: "turn", itemId: "item" };
function journals() {
  const saved = { schema: "paperclip.runner.durable.control-plane.v1", identity, ackedSourceSeq: 1,
    commands: [{ commandId: "drain", type: "runner.drain", controllerSeq: 1, payload: {}, issuedAt: "2026-01-01T00:00:00Z", status: "pending", result: null }],
    committedEvents: [{ sourceSeq: 1, sourceEventId: "terminal", eventType: "run.terminal", envelope: identity }],
    warmTransition: null, stagedRunAttachment: null };
  const local = structuredClone(saved);
  Object.assign(local.commands[0]!, { status: "completed", result: { status: "completed" } });
  return { local, saved };
}
const newer = (local: unknown, saved: unknown) => newerSettledNativeJournal(JSON.stringify(local), JSON.stringify(saved));

describe("monotonic same-authority settled checkpoint restore", () => {
  it("orders an ACK at the same controllerSeq after the pending checkpoint", () => {
    const { local, saved } = journals();
    expect(newer(local, saved)).toBe(true);
    expect(newer(saved, local)).toBe(false);
    expect(newer(local, local)).toBe(false);
  });
  it.each(["identity", "command intent", "event identity", "terminal result", "active work", "tool input", "warm transition"])(
    "does not use a superficially settled local journal with different %s", mode => {
      const { local, saved } = journals();
      if (mode === "identity") local.identity = { ...identity, runnerInstanceId: "other-runner" };
      if (mode === "command intent") local.commands[0]!.issuedAt = "2026-01-02T00:00:00Z";
      if (mode === "event identity") local.committedEvents[0]!.sourceEventId = "other-terminal";
      if (mode === "terminal result") Object.assign(saved.commands[0]!, { status: "completed", result: { status: "failed" } });
      if (mode === "active work") local.committedEvents.push({ sourceSeq: 2, sourceEventId: "new-work", eventType: "turn.started", envelope: identity });
      if (mode === "tool input") local.committedEvents.unshift({ sourceSeq: 0, sourceEventId: "unanswered", eventType: "semantic_tool.input", envelope: identity });
      if (mode === "warm transition") Object.assign(local, { warmTransition: { phase: "staged" } });
      expect(newer(local, saved)).toBe(false);
    },
  );
  it("never treats malformed bytes as newer evidence", () => {
    expect(newerSettledNativeJournal("{", "{}")).toBe(false);
    expect(newerSettledNativeJournal("{}", "{}")).toBe(false);
  });
});
