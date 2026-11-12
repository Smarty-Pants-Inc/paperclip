import { describe, expect, it } from "vitest";
import { FakeCodexTransport, WORKSPACE, makeDriver, type PrpEvent } from "./codex-app-server-driver.test-support.js";
import { rehydrateRunnerdItemNotification } from "../../live/runnerd-codex-transport.js";

// Keep: the real 033be069 stress run lost the UI OUTER final channel when
// a streamed start was cached before its authoritative Pi completion arrived.
describe("Pi authoritative completion channel", () => {
  it.each([true, false])("uses the terminal channel with prior start=%s", async started => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport], { driverIdentity: { kind: "pi_rpc", displayName: "Pi RPC", version: "1.5.2" } }).openSession({
      runId: "pi-channel", normalizedSessionId: "pi-channel", workingDirectory: WORKSPACE,
    });
    try {
      const { turnId } = await session.startTurn({ message: { role: "user", text: "Answer" } });
      const frame = (id: string, channel: string, text: string) => rehydrateRunnerdItemNotification({
        kind: "agentMessage", channel, itemId: id, text,
      }, "thread-1", turnId);
      if (started) transport.push("item/started", frame("answer", "progress", ""));
      transport.push("item/completed", frame("working", "progress", "Still working"));
      transport.push("item/completed", frame("answer", "final", "The final answer"));
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally { await session.close({ reason: "test complete" }); }
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    const messages = events.filter(e => e.eventType === "item.completed" && e.payload.kind === "agentMessage");
    expect(messages.map(e => ({ text: e.payload.text, channel: e.payload.channel }))).toEqual([
      { text: "Still working", channel: "progress" },
      { text: "The final answer", channel: "final" },
    ]);
  });

  it.each(["codex_app_server", "opencode_server", "acpx_runtime"])("does not change %s cached classification", async kind => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport], { driverIdentity: { kind, displayName: kind, version: "test" } }).openSession({
      runId: "other-channel", normalizedSessionId: "other-channel", workingDirectory: WORKSPACE,
    });
    try {
      const { turnId } = await session.startTurn({ message: { role: "user", text: "Answer" } });
      transport.push("item/started", { threadId: "thread-1", turnId, item: { id: "m", type: "agentMessage", phase: "commentary", text: "" } });
      transport.push("item/completed", { threadId: "thread-1", turnId, item: { id: "m", type: "agentMessage", phase: "final_answer", text: "Answer" } });
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally { await session.close({ reason: "test complete" }); }
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events.find(e => e.eventType === "item.completed" && e.payload.kind === "agentMessage")?.payload.channel).toBe("progress");
  });
});
