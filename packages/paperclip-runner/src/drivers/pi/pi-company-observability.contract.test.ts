import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { createOpenCodeCompanyObservability } from "../opencode/company-observability.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";

// RED prerequisite for the native-observability brief, R1. Do not synthesize
// turn.submitted or rewrite usage receipts to make this contract look compatible.
// Only the native RPC peer is scripted; admission, projection and #emit are real.
class ScriptedPiTransport {
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
          : type === "prompt" ? { disposition: "started" } : undefined };
  }
  send(event: PiRpcRecord) { this.queue.push(event); this.wake?.(); }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const event = this.queue.shift();
      if (event) { yield event; continue; }
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}

const environment = {
  // Intentionally use the existing exporter's admitted flag, independently of
  // the not-yet-implemented Pi flag/gate: this isolates the event-contract gap.
  PAPERCLIP_OBSERVABILITY_OPENCODE: "1",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example/v1/traces",
  OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent",
  OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_ASSISTANT_RESPONSES: "1",
  OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_TOOL_CONTENT: "1",
};
const events: PrpEvent[] = [];
const bodies: unknown[] = [];
const transport = vi.fn<typeof fetch>(async (_url, init) => {
  bodies.push(JSON.parse(String(init?.body)));
  return new Response("{}");
});

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-observability-contract-"));
  const peer = new ScriptedPiTransport();
  const observer = createOpenCodeCompanyObservability({ environment, model: "neutral/model", sensitiveValues: [], fetch: transport })!;
  const session = await new PiRpcDriver({
    runtimeDirectory: join(root, "runtime"), model: "neutral/model", piRpcThinkingLevel: "high",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent") },
    transportFactory: () => peer as unknown as PiRpcTransport,
  }).openSession({ runId: "run", normalizedSessionId: "normalized", workingDirectory: root });
  const drained = (async () => {
    for await (const event of session.events()) {
      events.push(event);
      observer.observe(event); // exact event from Pi's single sink, unchanged
    }
  })();
  try {
    await session.startTurn({ message: { role: "user", text: "Read the fixture" } });
    for (const event of [
      { type: "agent_start" },
      { type: "message_start", message: { role: "user", id: "user-1", content: [{ type: "text", text: "Read the fixture" }] } },
      { type: "message_end", message: { role: "user", id: "user-1", content: [{ type: "text", text: "Read the fixture" }] } },
      { type: "message_start", message: { role: "assistant", responseId: "call-1" } },
      { type: "message_end", message: {
        role: "assistant", provider: "neutral", model: "model", responseId: "call-1", stopReason: "stop",
        content: [{ type: "text", text: "Fixture read" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "fixture.txt" } }],
        usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.125, totalFromProvider: true } },
      } },
      { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "fixture.txt" } },
      { type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "fixture body" }] } },
      { type: "agent_end", messages: [] },
      { type: "agent_settled" },
    ]) peer.send(event);
    await vi.waitFor(() => expect(events.some(event => event.eventType === "turn.completed")).toBe(true));
  } finally {
    await session.close();
    await drained;
    await observer.close();
    if (process.env.TASK_OUT) {
      await writeFile(join(process.env.TASK_OUT, "R1-pi-sink-events.json"), `${JSON.stringify(events, null, 2)}\n`);
      await writeFile(join(process.env.TASK_OUT, "R1-otlp-bodies.json"), `${JSON.stringify(bodies, null, 2)}\n`);
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("R1 native Pi / shared observability prerequisites", () => {
  it("control: the actual driver sink has terminal, tool, assistant and usage receipts", () => {
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "turn.completed" }),
      expect.objectContaining({ eventType: "tool.execution.completed" }),
      expect.objectContaining({ eventType: "item.completed", payload: expect.objectContaining({ kind: "agentMessage" }) }),
      expect.objectContaining({ eventType: "usage.reported", payload: expect.objectContaining({ runDelta: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, providerCostUsd: 0.125 } }) }),
    ]));
  });
  it("emits the turn.submitted event required to open the shared exporter's trace", () => {
    expect(events.map(event => event.eventType)).toContain("turn.submitted");
  });
  it("emits the keyed per-message usage contract consumed by the shared exporter", () => {
    const receipt = events.find(event => event.eventType === "item.completed" && event.payload.kind === "usage");
    expect(receipt?.payload).toMatchObject({
      usageMessageId: expect.any(String), usage: { input: 10, output: 2, cache: { read: 3, write: 4 }, costUsd: 0.125 },
    });
  });
  it("exports one root/tool/usage request from the unmodified Pi sink sequence", () => {
    expect(transport).toHaveBeenCalledOnce();
    expect(bodies[0]).toMatchObject({ resourceSpans: [{ scopeSpans: [{ spans: [
      expect.objectContaining({ name: "paperclip.opencode.turn" }),
      expect.objectContaining({ name: "tool read" }),
      expect.objectContaining({ name: "opencode.model.usage" }),
    ] }] }] });
  });
  it("control: disabled export creates no observer or requests", () => {
    const disabledTransport = vi.fn<typeof fetch>();
    const disabled = createOpenCodeCompanyObservability({ environment: { ...environment, PAPERCLIP_OBSERVABILITY_OPENCODE: "0" }, model: "neutral/model", sensitiveValues: [], fetch: disabledTransport });
    for (const event of events) disabled?.observe(event);
    expect(disabled).toBeUndefined();
    expect(disabledTransport).not.toHaveBeenCalled();
  });
});
