import { join } from "node:path";
import { PiRpcDriver } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-rpc-transport.js";
import { createPiRpcAppServerProxy } from "../../../../packages/paperclip-runner/src/cli/pi-rpc-app-server-proxy.js";
import { FakeCodexTransport, makeDriver } from "../../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.js";

/** A controlled Pi RPC peer, not an answer projector. It cannot consume a steer
 * until the test releases the current tool call. Both production drivers and
 * the production Pi app-server proxy handle every wire record. */
export async function openPiSteeringPeer(root: string, runId: string) {
  let wake: (() => void) | undefined;
  let closed = false;
  const records: PiRpcRecord[] = [];
  const commands: Array<{ type: string; input?: PiRpcRecord }> = [];
  const pending: string[] = [];
  const send = (record: PiRpcRecord) => { records.push(record); wake?.(); };
  const user = (text: string) => {
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    send({ type: "message_start", message }); send({ type: "message_end", message });
  };
  const peer = {
    pid: 44444,
    exited: false,
    async request(type: string, input?: PiRpcRecord) {
      commands.push({ type, input });
      if (type === "prompt") {
        send({ type: "agent_start" }); send({ type: "turn_start" }); user(String(input?.message));
        send({ type: "tool_execution_start", toolCallId: "held-tool", toolName: "bash", args: { command: "held" } });
      }
      if (type === "steer") pending.push(String(input?.message));
      return { data: type === "get_state"
        ? { sessionId: "boundary-peer-session", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: pending.length }
        : type === "set_model" ? { provider: "neutral", id: "model" }
        : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
        : type === "get_available_thinking_levels" ? { levels: ["high"] }
        : type === "prompt" ? { disposition: "started" }
        : type === "steer" ? { disposition: "queued" } : undefined };
    },
    async *events(): AsyncIterable<PiRpcRecord> {
      while (!closed) {
        const next = records.shift();
        if (next) { yield next; continue; }
        await new Promise<void>(resolve => { wake = resolve; });
      }
    },
    async close() { closed = true; peer.exited = true; wake?.(); },
  };
  const pi = await new PiRpcDriver({ model: "neutral/model", piRpcThinkingLevel: "high",
    runtimeDirectory: join(root, "pi-runtime"), environment: { PI_CODING_AGENT_DIR: join(root, "pi-agent") },
    transportFactory: () => peer as unknown as PiRpcTransport,
  }).openSession({ runId, normalizedSessionId: "boundary-peer-normalized", workingDirectory: root });
  const transport = new FakeCodexTransport();
  let nextRequest = 0;
  const waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const proxy = createPiRpcAppServerProxy({
    environment: { PAPERCLIP_RUN_ID: runId, PAPERCLIP_NORMALIZED_SESSION_ID: "boundary-peer-normalized" },
    stdout: { write(bytes) {
      const value = JSON.parse(bytes);
      if (typeof value.id === "number") {
        const request = waiting.get(value.id); waiting.delete(value.id);
        if (value.error) request?.reject(new Error(value.error.message)); else request?.resolve(value.result ?? {});
      } else if (value.method) transport.queue.push(value);
      return true;
    }, once() {} },
    createDriver: () => ({ async descriptor() { throw new Error("unused descriptor"); }, async openSession() { return pi; } }),
  });
  transport.request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextRequest; waiting.set(id, { resolve, reject });
    proxy.acceptLine(JSON.stringify({ id, method, params }));
  });
  transport.notify = (method, params) => { proxy.acceptLine(JSON.stringify({ method, params })); };
  transport.close = async () => { await proxy.close(); transport.queue.close(); };
  const session = await makeDriver([transport], { model: "neutral/model", conversationMode: "direct",
    includeCollaborationModeInstructions: false, capabilities: { steering: true },
    driverIdentity: { kind: "pi_rpc", displayName: "Pi RPC", version: "1.5.2" },
  }).openSession({ runId, normalizedSessionId: "boundary-peer-normalized", workingDirectory: root });
  return {
    session, commands,
    releaseBoundary(reply: boolean) {
      send({ type: "tool_execution_end", toolCallId: "held-tool", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false });
      const text = pending.shift(); if (text === undefined) throw new Error("No queued steer at boundary");
      user(text);
      if (!reply) {
        send({ type: "tool_execution_start", toolCallId: "next-tool", toolName: "bash", args: { command: "next" } });
        return;
      }
      const message = { role: "assistant", content: [{ type: "text", text: "Answered after reading the steer." }],
        model: "model", provider: "neutral", api: "openai-completions", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      send({ type: "message_start", message: { ...message, content: [] } });
      send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Answered after reading the steer." } });
      send({ type: "message_end", message });
    },
    endTurn() {
      send({ type: "turn_end" }); send({ type: "agent_end", messages: [] });
      // Pinned Pi's agent_end is a continuation boundary, NOT the run terminal.
      send({ type: "agent_settled" });
    },
    async close() { await session.close({ reason: "boundary peer cleanup" }); await pi.close({ reason: "boundary peer cleanup" }); },
  };
}
