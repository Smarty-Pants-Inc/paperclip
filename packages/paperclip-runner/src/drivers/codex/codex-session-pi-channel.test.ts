import { describe, expect, it } from "vitest";
import { FakeCodexTransport, WORKSPACE, makeDriver, type PrpEvent } from "./codex-app-server-driver.test-support.js";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rehydrateRunnerdItemNotification } from "../../live/runnerd-codex-transport.js";
import { createPiEventProjector } from "../pi/pi-event-projector.js";

// Keep: the real 033be069 stress run lost the UI OUTER final channel when
// a streamed start was cached before its authoritative Pi completion arrived.
describe("Pi authoritative completion channel", () => {
  // Keep reason: fresh native identity must reach every live owner cache.
  it.each(["valid", "wrong-provider", "wrong-conversation", "wrong-previous", "wrong-model", "wrong-thinking", "wrong-readback"]) (
    "adopts only a scoped, disclosed invalid-history replacement (%s)", async fault => {
      const recovery = { reason: "pi_session_file_invalid", previousSessionId: "old-native", normalizedSessionId: "conversation",
        preservedFile: "conversation.jsonl.invalid-2026-11-13T00-00-00Z-00000000-0000-4000-8000-000000000000" };
      const receipt = { threadId: "fresh-native", providerSessionId: "fresh-native", piNativeAdmission: {
        provider: "pi_rpc", providerSessionId: "fresh-native", model: "gpt-test", piRpcThinkingLevel: "off", sessionRecovery: recovery,
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
        if (fault !== "valid") {
          await expect(session.attachRun!({ runId: "new-run" })).rejects.toThrow("pi_session_recovery_identity_refused");
          expect(session.ids().driverSessionId).toBe("old-native");
        } else {
          await session.attachRun!({ runId: "new-run" });
          expect(session.ids()).toMatchObject({ driverSessionId: "fresh-native", providerSessionId: "fresh-native" });
          await session.startTurn({ message: { role: "user", text: "Fresh input" } });
          transport.push("turn/started", { threadId: "fresh-native", turn: { id: "turn-1", status: "inProgress" } });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { await session.close({ reason: "test complete" }); }
      const events: PrpEvent[] = []; for await (const event of session.events()) events.push(event);
      if (fault === "valid") {
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

// dl-n5-66k (Paul NOTE 5, H5; run 5184ca23): a Pi final answer of 66,220 bytes
// reached the server as {truncated: true, byteSize} with NO text, so the
// 238-character result summary was posted instead. The real Pi projector
// output passes the real runnerd rehydration and the real Codex-facade driver.
describe("dl-n5-66k Pi final answer reaches the PRP record whole", () => {
  const answerOf = (bytes: number) => {
    const unit = "Line \"quoted\" 🦀 naïve\n";
    let answer = unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)));
    while (Buffer.byteLength(answer) > bytes) answer = answer.slice(0, -1);
    return answer.padEnd(answer.length + (bytes - Buffer.byteLength(answer)), "x");
  };
  const project = (answer: string, spillDirectory?: string) => {
    const projected = createPiEventProjector({ runId: "run", turnId: "turn", ...(spillDirectory ? { spillDirectory } : {}) }).project({
      type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", timestamp: 1,
        responseId: "reply-1", stopReason: "stop", content: [{ type: "text", text: answer }] } });
    const completed = projected.find(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage")!;
    expect(completed.payload.channel).toBe("final");
    return completed;
  };
  const drive = async (frames: (turnId: string) => Array<[string, Record<string, unknown>]>) => {
    const transport = new FakeCodexTransport();
    const session = await makeDriver([transport], { driverIdentity: { kind: "pi_rpc", displayName: "Pi RPC", version: "1.5.2" } }).openSession({
      runId: "pi-66k", normalizedSessionId: "pi-66k", workingDirectory: WORKSPACE,
    });
    try {
      const { turnId } = await session.startTurn({ message: { role: "user", text: "Answer" } });
      for (const [method, params] of frames(turnId)) transport.push(method, params);
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally { await session.close({ reason: "test complete" }); }
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    return events;
  };

  it.each([66_220, 100_000])("a %i-byte final answer is stored whole, exactly once", async bytes => {
    const answer = answerOf(bytes);
    expect(Buffer.byteLength(answer)).toBe(bytes);
    const completed = project(answer);
    expect(completed.payload.text).toBe(answer);
    const events = await drive(turnId => [["item/completed", rehydrateRunnerdItemNotification({
      provider: "pi_rpc", kind: "agentMessage", channel: "final", itemId: completed.itemId, text: completed.payload.text,
    }, "thread-1", turnId)]]);
    const finals = events.filter(e => e.eventType === "item.completed" && e.payload.channel === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.payload).not.toHaveProperty("truncated");
    expect(finals[0]!.payload.kind).toBe("agentMessage");
    expect(finals[0]!.payload.text).toBe(answer);
    // The text is carried once, not again inside the item copy.
    expect(Buffer.byteLength(JSON.stringify(finals[0]!.payload))).toBeLessThan(bytes * 1.5 + 4096);
  });

  it("a 300 KiB final answer gets n5e's plain line and a labelled excerpt, with its full-text reference kept", async () => {
    const answer = answerOf(300 * 1024);
    const spill = mkdtempSync(join(tmpdir(), "dl-n5-66k-"));
    const completed = project(answer, spill);
    const events = await drive(turnId => [["item/completed", rehydrateRunnerdItemNotification({
      provider: "pi_rpc", kind: "agentMessage", channel: "final", itemId: completed.itemId, text: completed.payload.text,
      fullText: completed.payload.fullText,
    }, "thread-1", turnId)]]);
    const finals = events.filter(e => e.eventType === "item.completed" && e.payload.channel === "final");
    expect(finals).toHaveLength(1);
    const text = String(finals[0]!.payload.text);
    expect(text).toMatch(/^This answer is longer than one message \(308 KB\)\. The full text is kept; ask me to show any part\.\n\nExcerpt \(the start of the answer, not the whole answer\):\n\n/u);
    expect(answer.startsWith(text.slice(text.indexOf(":\n\n") + 3))).toBe(true);
    expect(text).not.toMatch(/truncated/iu);
    const fullText = finals[0]!.payload.fullText as { path: string; sha256: string; bytes: number };
    expect(fullText.bytes).toBe(300 * 1024);
    expect(readFileSync(fullText.path, "utf8")).toBe(answer);
  });

  it("NEGATIVE: a tool's output keeps its retention bound", async () => {
    const output = "o".repeat(100_000);
    const events = await drive(turnId => [["item/completed", { threadId: "thread-1", turnId,
      item: { id: "tool-1", type: "commandExecution", command: "cat big", status: "completed", aggregatedOutput: output } }]]);
    const tool = events.find(e => e.eventType === "item.completed" && e.itemId === "tool-1");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool!.payload)).not.toContain(output);
    expect(Buffer.byteLength(JSON.stringify(tool!.payload))).toBeLessThanOrEqual(64 * 1024);
  });
});
