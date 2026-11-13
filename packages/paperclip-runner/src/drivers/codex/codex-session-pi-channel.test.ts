import { describe, expect, it } from "vitest";
import { FakeCodexTransport, WORKSPACE, makeDriver, type PrpEvent } from "./codex-app-server-driver.test-support.js";
import { rehydrateRunnerdItemNotification } from "../../live/runnerd-codex-transport.js";

// Keep: the real 033be069 stress run lost the UI OUTER final channel when
// a streamed start was cached before its authoritative Pi completion arrived.
describe("Pi authoritative completion channel", () => {
  // Keep reason: fresh native identity must reach every live owner cache.
  it.each(["valid", "valid-partial", "wrong-partial-native", "wrong-provider", "wrong-conversation", "wrong-previous", "wrong-model", "wrong-thinking", "wrong-readback"]) (
    "adopts only a scoped, disclosed invalid-history replacement (%s)", async fault => {
      const partial = fault.includes("partial");
      const nativeId = fault === "valid-partial" ? "old-native" : "fresh-native";
      const recovery = { reason: partial ? "pi_session_file_partial" : "pi_session_file_invalid", ...(partial ? { historyLost: true } : {}), previousSessionId: "old-native", normalizedSessionId: "conversation",
        preservedFile: "conversation.jsonl.invalid-2026-11-13T00-00-00Z-00000000-0000-4000-8000-000000000000" };
      const receipt = { threadId: nativeId, providerSessionId: nativeId, piNativeAdmission: {
        provider: "pi_rpc", providerSessionId: nativeId, model: "gpt-test", piRpcThinkingLevel: "off", sessionRecovery: recovery,
      } };
      if (fault === "wrong-conversation") recovery.normalizedSessionId = "other-conversation";
      if (fault === "wrong-previous") recovery.previousSessionId = "someone-else";
      if (fault === "wrong-model") receipt.piNativeAdmission.model = "another-model";
      if (fault === "wrong-thinking") receipt.piNativeAdmission.piRpcThinkingLevel = "high";
      if (fault === "wrong-readback") receipt.piNativeAdmission.providerSessionId = "another-native";
      class RecoveryTransport extends FakeCodexTransport {
        async attachRun() { return receipt; }
        override async request(method: string, params: Record<string, unknown>) {
          const response = await super.request(method, params);
          return method === "thread/start" ? { ...response, piNativeAdmission: { piRpcThinkingLevel: "off" } } : response;
        }
      }
      const transport = new RecoveryTransport("old-native", "old-native");
      const session = await makeDriver([transport], fault === "wrong-provider" ? {} : { driverIdentity: { kind: "pi_rpc", displayName: "Pi RPC", version: "1.5.2" } }).openSession({
        runId: "old-run", normalizedSessionId: "conversation", workingDirectory: WORKSPACE,
      });
      try {
        if (fault !== "valid" && fault !== "valid-partial") {
          await expect(session.attachRun!({ runId: "new-run" })).rejects.toThrow("pi_session_recovery_identity_refused");
          expect(session.ids().driverSessionId).toBe("old-native");
        } else {
          await session.attachRun!({ runId: "new-run" });
          expect(session.ids()).toMatchObject({ driverSessionId: nativeId, providerSessionId: nativeId });
          await session.startTurn({ message: { role: "user", text: "Fresh input" } });
          transport.push("turn/started", { threadId: nativeId, turn: { id: "turn-1", status: "inProgress" } });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { await session.close({ reason: "test complete" }); }
      const events: PrpEvent[] = []; for await (const event of session.events()) events.push(event);
      if (fault === "valid" || fault === "valid-partial") {
        expect(events.find(event => event.eventType === "run.attached")?.payload.piSessionRecovery).toEqual(recovery);
        expect(events.some(event => event.eventType === "session.failed")).toBe(false);
      }
    });
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
