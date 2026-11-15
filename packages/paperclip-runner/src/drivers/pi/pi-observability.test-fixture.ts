import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { PiRpcDriver, type PiRpcDriverOptions } from "./pi-rpc-driver.js";
import { bindContent, type PiBindCommand } from "./pi-bind-protocol.js";
import type { PiRpcRecord, PiRpcTransport, PiRpcTransportOptions } from "./pi-rpc-transport.js";

// Only the RPC peer is scripted; admission, event attribution, projection and
// the driver's single sink are real. No synthetic exporter events enter Pi.
export class ScriptedPiTransport {
  closed = false;
  exited = false;
  pid = null;
  queue: PiRpcRecord[] = [];
  wake?: () => void;
  constructor(readonly model = { provider: "neutral", id: "model" }) {}
  async request(type: string) {
    return { data: type === "get_state" ? {
      sessionId: "native-pi-session", model: this.model,
      thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0,
    } : type === "set_model" ? this.model
      : type === "get_available_models" ? { models: [this.model] }
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
export function assistant(id: string, options: { text?: string; usage?: unknown; tool?: string; args?: unknown } = {}): PiRpcRecord[] {
  return [{ type: "message_start", message: { role: "assistant", responseId: id } }, { type: "message_end", message: {
    role: "assistant", provider: "neutral", model: "model", responseId: id, stopReason: "stop",
    content: [{ type: "text", text: options.text ?? "Fixture read" },
      ...(options.tool ? [{ type: "toolCall", id: `tool-${id}`, name: options.tool, arguments: options.args ?? { path: "fixture.txt" } }] : [])],
    usage: options.usage === null ? undefined : options.usage ?? { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.125, totalFromProvider: true } },
  } }];
}
export const tool = (id: string, name = "read", output = "fixture body", args: unknown = { path: "fixture.txt" }): PiRpcRecord[] => [
  { type: "tool_execution_start", toolCallId: `tool-${id}`, toolName: name, args },
  { type: "tool_execution_end", toolCallId: `tool-${id}`, toolName: name, isError: false, result: { content: [{ type: "text", text: output }] } },
];
export const terminal: PiRpcRecord[] = [{ type: "agent_end", messages: [] }, { type: "agent_settled" }];
export const attrs = (span: any): Record<string, any> => Object.fromEntries(span.attributes.map((a: any) =>
  [a.key, a.value.stringValue ?? a.value.doubleValue ?? a.value.boolValue]));
export const spans = (bodies: any[]): any[] => bodies.flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
// Each scope owns its capture closure and every open attempt, including one
// still awaiting admission when Vitest times out the test body.
export function createPiObservabilityTest() {
  const bodies: any[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}");
  });
  const opened: ReturnType<typeof openPi>[] = [];
  let closing = false;
  return {
    bodies, transport,
    openPi(...args: Parameters<typeof openPi>) {
      if (closing) throw new Error("Pi observability test is already closing");
      const opening = openPi(...args);
      opened.push(opening);
      return opening;
    },
    async close() {
      closing = true;
      // Start every close even if another fails. Session.close drains the real
      // observability export queue; fixture.close also awaits the receipt reader.
      const results = await Promise.allSettled(opened.map(async opening => {
        const pi = await opening;
        await pi.close();
      }));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Pi observability test cleanup failed");
    },
  };
}

export async function openPi(env = environment, options: Pick<PiRpcDriverOptions, "now" | "model"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-obs-"));
  const model = options.model ?? "neutral/model";
  const [provider, ...id] = model.split("/");
  const peer = new ScriptedPiTransport({ provider: provider!, id: id.join("/") });
  const bindings: PiBindCommand[] = [];
  const events: PrpEvent[] = [];
  let child!: PiRpcTransportOptions;
  const session = await new PiRpcDriver({
    runtimeDirectory: join(root, "runtime"), model, piRpcThinkingLevel: "high", now: options.now,
    environment: { ...env, PI_CODING_AGENT_DIR: join(root, "agent") },
    transportFactory: options => { child = options; return peer as unknown as PiRpcTransport; },
    bindRequest: (async (_path: string, command: PiBindCommand) => {
      bindings.push(command);
      return command.type === "bind"
        ? { schema: 1, type: "bind", nonce: command.nonce, sessionId: command.sessionId, epoch: command.epoch, runId: command.runId, provider: command.provider.name, model: command.model, thinkingLevel: command.thinkingLevel, ...bindContent(command) }
        : command.type === "tool_inventory" ? { ...command, nativeTools: [] }
          : command.type === "stop_children" ? { ...command, settled: [], uncertain: [] } : { ...command, ack: true };
    }) as never,
  }).openSession({ runId: "run", normalizedSessionId: "normalized", workingDirectory: root });
  const drained = (async () => { for await (const event of session.events()) events.push(event); })();
  let ordinal = 0;
  let closing: Promise<void> | undefined;
  return { root, peer, session, events, child, bindings,
    async start(prompt = "Read the fixture") {
      const turn = await session.startTurn({ message: { role: "user", text: prompt } });
      peer.send({ type: "agent_start" }, ...user(`user-${++ordinal}`, prompt));
      return turn;
    },
    async settled(count = 1) { await vi.waitFor(() => expect(events.filter(e => e.eventType === "turn.completed")).toHaveLength(count), { interval: 1 }); },
    close() {
      // A timed-out body's finally and afterEach must await the SAME cleanup,
      // rather than race receipt draining or directory removal.
      return closing ??= (async () => {
        await session.close({ reason: "test complete" });
        await drained;
        await rm(root, { recursive: true, force: true });
      })();
    },
  };
}
