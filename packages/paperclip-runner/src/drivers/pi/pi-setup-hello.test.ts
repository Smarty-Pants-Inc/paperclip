import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import { probePiNativeEnvironment } from "./pi-environment-probe.js";
const wire: PiRpcRecord[] = readFileSync(new URL("../../../test-fixtures/pi-rpc/baseline-1.5.2.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
const recordedState = wire.find(r => r.command === "get_state")!.data as Record<string, unknown>;
const model = "paperclip/neutral/vendor-model-not-in-bundled-catalog";
const config = { provider: "pi_rpc" as const, model, piRpcThinkingLevel: "off" as const };
async function fixture(mode = "success", credentialMode?: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-setup-fixture-"));
  const commands: Array<{ type: string; [key: string]: unknown }> = [];
  const pending: PiRpcRecord[] = []; let wake: (() => void) | undefined; let closed = false; let spawn: PiRpcTransportOptions | undefined;
  const state = structuredClone(recordedState);
  const close = vi.fn(async () => { closed = true; wake?.(); if (mode === "close-failed") throw new Error("fixture close failed"); });
  const transport = {
    request: async (type: string, params = {}) => {
      commands.push({ type, ...params });
      const data = type === "get_state" ? state : type === "set_model" ? state.model : type === "get_available_thinking_levels" ? { levels: ["off"] }
        : type === "get_available_models" ? { models: [state.model] } : type === "prompt" ? { disposition: mode === "handled-but-empty" ? "handled" : "started" } : undefined;
      if (type === "prompt") {
        const turn = commands.filter(c => c.type === "prompt").length;
         // Replay only the captured first text turn, never later tool scenarios.
         // Fresh native identities model a distinct response for each prompt.
         const events = structuredClone(wire.slice(0, wire.findIndex(r => r.type === "agent_settled") + 1)
           .filter(r => !["response", "process_exit"].includes(r.type as string)));
         for (const event of events) {
           const messages = [event.message, ...(Array.isArray(event.messages) ? event.messages : [])];
           for (const message of messages) if (message && typeof message === "object") {
             const item = message as Record<string, unknown>;
             if (typeof item.timestamp === "number") item.timestamp += turn * 1000;
             if (typeof item.responseId === "string") item.responseId += `-${turn}`;
           }
         }
        if (mode === "EOF") { pending.push({ type: "process_exit", code: 0 }); }
        else if (mode === "tool-only") { pending.push({ type: "tool_execution_start", toolCallId: "tool", toolName: "read" }, { type: "agent_settled" }); }
        else if (mode !== "handled-but-empty") pending.push(...events);
        wake?.();
      }
      return { type: "response", command: type, success: true, data };
    },
    events: async function* () { while (!closed) { if (pending.length) yield pending.shift()!; else await new Promise<void>(r => { wake = r; }); } }, close,
  } as unknown as PiRpcTransport;
  const driver = new PiRpcDriver({ model, piRpcThinkingLevel: "off", runtimeDirectory: root,
    environment: credentialMode ? { PAPERCLIP_PI_RPC_CREDENTIAL_MODE: credentialMode } : {},
    transportFactory: options => { spawn = options; return transport; } });
  return { root, driver, commands, close, get spawn() { return spawn; } };
}
describe("setup hello uses the production Pi driver and recorded RPC fixture", () => {
  it("admits the exact nested model and off before hello, then re-admits on every turn", async () => {
    const f = await fixture();
    try {
      const session = await f.driver.openSession({ runId: "probe", normalizedSessionId: "probe-session", workingDirectory: f.root });
      const first = await session.events()[Symbol.asyncIterator]().next();
      expect(first.value).toMatchObject({ eventType: "session.started", payload: { context: { model, piRpcThinkingLevel: "off" } } });
      for (const prompt of ["hello", "second"]) {
        const events = session.events()[Symbol.asyncIterator]();
        const { turnId } = await session.startTurn({ message: { role: "user", text: prompt } });
        while (true) { const next = await events.next(); if (next.value?.eventType === "turn.completed" && next.value.turnId === turnId) break; }
      }
      const prompts = f.commands.flatMap((c, i) => c.type === "prompt" ? [i] : []);
      expect(prompts).toHaveLength(2);
      for (const i of prompts) expect(f.commands.slice(i - 5, i)).toEqual([{ type: "get_state" }, { type: "set_model", provider: "paperclip", modelId: "neutral/vendor-model-not-in-bundled-catalog" }, { type: "get_available_thinking_levels" }, { type: "set_thinking_level", level: "off" }, { type: "get_state" }]);
      await session.close();
    } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
  }, 5000);
  it("metadata admission makes no model prompt and reports only version/provider/auth shape", async () => {
    const f = await fixture();
    try {
      const session = await f.driver.openSession({ runId: "metadata", normalizedSessionId: "metadata-session", workingDirectory: f.root });
      const first = await session.events()[Symbol.asyncIterator]().next();
      expect(first.value?.payload.context).toMatchObject({ piMetadata: { version: "1.5.2", providers: ["paperclip"], credentialMode: "broker", promptSent: false } });
      expect(f.commands.some(c => c.type === "prompt")).toBe(false);
      expect(f.commands.some(c => c.type === "get_available_models")).toBe(true);
      await session.close();
    } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
  }, 5000);
  it.each(["success", "handled-but-empty", "tool-only", "EOF", "close-failed"])("qualifies only a nonempty retired hello (%s)", async mode => {
    const f = await fixture(mode);
    try {
      const operation = probePiNativeEnvironment({ driver: f.driver, config, runId: "probe", normalizedSessionId: "probe-session", workingDirectory: f.root, timeoutMs: 1000, cleanupTimeoutMs: 1000 });
      if (mode === "success") await expect(operation).resolves.toMatchObject({ effectiveModel: model, helloProbePassed: true });
      else await expect(operation).rejects.toThrow();
    } finally { await f.close().catch(() => undefined); await rm(f.root, { recursive: true, force: true }); }
  });
});
