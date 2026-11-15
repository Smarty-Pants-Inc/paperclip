import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport, PiRpcTransportOptions } from "./pi-rpc-transport.js";

// Only the RPC peer is scripted; admission, event attribution, projection and
// the driver's single sink are real. No synthetic exporter events enter Pi.
export class ScriptedPiTransport {
  closed = false;
  exited = false;
  pid = null;
  queue: PiRpcRecord[] = [];
  wake?: () => void;
  async request(type: string) {
    return { data: type === "get_state" ? {
      sessionId: "native-pi-session", model: { provider: "neutral", id: "model" },
      thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0,
    } : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
        : type === "get_available_thinking_levels" ? { levels: ["high"] }
          : type === "prompt" ? { disposition: "started" }
            : type === "steer" ? { disposition: "queued" } : undefined };
  }
  send(...events: PiRpcRecord[]) { this.queue.push(...events); this.wake?.(); }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const event = this.queue.shift();
      if (event) { yield event; continue; }
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}
export const sentinel = "native-observability-secret-canary";
export const environment: NodeJS.ProcessEnv = {
  PAPERCLIP_OBSERVABILITY_PI: "1",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: `authorization=Bearer%20${sentinel}`,
  OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,paperclip.run.id=run,paperclip.task.id=task",
  OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_ASSISTANT_RESPONSES: "1",
  OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_TOOL_CONTENT: "1",
};
export const user = (id: string, text: string): PiRpcRecord[] => ["message_start", "message_end"].map(type =>
  ({ type, message: { role: "user", id, content: [{ type: "text", text }] } }));
export function assistant(id: string, options: { text?: string; usage?: unknown; tool?: string } = {}): PiRpcRecord[] {
  return [{ type: "message_start", message: { role: "assistant", responseId: id } }, { type: "message_end", message: {
    role: "assistant", provider: "neutral", model: "model", responseId: id, stopReason: "stop",
    content: [{ type: "text", text: options.text ?? "Fixture read" },
      ...(options.tool ? [{ type: "toolCall", id: `tool-${id}`, name: options.tool, arguments: { path: "fixture.txt" } }] : [])],
    usage: options.usage === null ? undefined : options.usage ?? { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.125, totalFromProvider: true } },
  } }];
}
export const tool = (id: string, name = "read", output = "fixture body"): PiRpcRecord[] => [
  { type: "tool_execution_start", toolCallId: `tool-${id}`, toolName: name, args: { path: "fixture.txt" } },
  { type: "tool_execution_end", toolCallId: `tool-${id}`, toolName: name, isError: false, result: { content: [{ type: "text", text: output }] } },
];
export const terminal: PiRpcRecord[] = [{ type: "agent_end", messages: [] }, { type: "agent_settled" }];
export const attrs = (span: any): Record<string, any> => Object.fromEntries(span.attributes.map((a: any) =>
  [a.key, a.value.stringValue ?? a.value.doubleValue ?? a.value.boolValue]));
export const spans = (bodies: any[]): any[] => bodies.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
export async function openPi(env = environment) {
  const root = await mkdtemp(join(tmpdir(), "pi-obs-"));
  const peer = new ScriptedPiTransport();
  const events: PrpEvent[] = [];
  let child!: PiRpcTransportOptions;
  const session = await new PiRpcDriver({
    runtimeDirectory: join(root, "runtime"), model: "neutral/model", piRpcThinkingLevel: "high",
    environment: { ...env, PI_CODING_AGENT_DIR: join(root, "agent") },
    transportFactory: options => { child = options; return peer as unknown as PiRpcTransport; },
  }).openSession({ runId: "run", normalizedSessionId: "normalized", workingDirectory: root });
  const drained = (async () => { for await (const event of session.events()) events.push(event); })();
  let ordinal = 0;
  return { root, peer, session, events, child,
    async start(prompt = "Read the fixture") {
      const turn = await session.startTurn({ message: { role: "user", text: prompt } });
      peer.send({ type: "agent_start" }, ...user(`user-${++ordinal}`, prompt));
      return turn;
    },
    async settled(count = 1) { await vi.waitFor(() => expect(events.filter(e => e.eventType === "turn.completed")).toHaveLength(count), { interval: 1 }); },
    async close() { await session.close({ reason: "test complete" }); await drained; await rm(root, { recursive: true, force: true }); },
  };
}
