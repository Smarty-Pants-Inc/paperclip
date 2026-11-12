import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPiRpcAppServerProxy, type PiRpcProxyFrameSink } from "../../cli/pi-rpc-app-server-proxy.js";
import type { HarnessDriver, HarnessSession } from "../../contracts/harness-driver.js";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";
import { projectPiRecording } from "../../../test-support/pi-rpc-golden.js";

const fixture = (name: string) => readFileSync(new URL(`../../../test-fixtures/pi-rpc/${name}`, import.meta.url), "utf8");
const wire = (name: string) => fixture(`${name}-1.5.2.jsonl`).trim().split("\n").map(line => JSON.parse(line));
const commands = (name: string) => fixture(`${name}-1.5.2.commands.jsonl`).trim().split("\n").map(line => JSON.parse(line));
const scenarios = ["baseline", "unsupported-thinking", "abort", "queue", "retry", "compaction", "extension", "subagent"];
const envelope = (event: Record<string, unknown>, index: number) => ({ schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `pi-${index}`, sourceSeq: index + 1, sourceInstanceId: "capture", sourceKind: "runner", runId: "pi-capture", normalizedSessionId: "pi-session", priority: 1, emittedAt: "2026-11-12T06:26:00.000Z", ...event } as PrpEvent);

describe("immutable real Pi 1.5.2 lifecycle recordings against the controlled peer", () => {
  it.each(scenarios)("replays %s into its normalized golden with valid PRP envelopes", name => {
    const actual = projectPiRecording(wire(name), name === "extension");
    expect(actual).toEqual(JSON.parse(fixture(`${name}-1.5.2.normalized.json`)));
    for (const [index, event] of actual.entries()) expect(validatePrpEvent(envelope(event, index)), JSON.stringify(event)).toMatchObject({ ok: true });
    const provenance = JSON.parse(fixture(`${name}-1.5.2.provenance.json`));
    expect(provenance).toMatchObject({ runtimeVersion: "1.5.2", childExitCode: 0, childSignal: null, noLiveProviderCalls: true });
  });
  it("observes successful unsupported set(high) clamping to off, not acknowledgment", () => {
    const raw = wire("unsupported-thinking");
    expect(commands("unsupported-thinking").at(-2)).toMatchObject({ type: "set_thinking_level", level: "high" });
    expect(raw.filter(event => event.command === "get_available_thinking_levels").at(-1)?.data).toEqual({ levels: ["off"] });
    expect(raw.filter(event => event.command === "set_thinking_level").at(-1)).toMatchObject({ success: true });
    expect(raw.filter(event => event.command === "set_thinking_level").at(-1)?.data).toBeUndefined();
    expect(raw.at(-1).data.thinkingLevel).toBe("off");
  });
  it("aborts an actually streaming turn and waits for agent_settled", () => {
    const raw = wire("abort");
    expect(raw.some(event => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")).toBe(true);
    expect(raw.some(event => event.type === "message_end" && event.message.stopReason === "aborted")).toBe(true);
    expect(raw.find(event => event.type === "agent_settled")).toMatchObject({ aborted: true });
    expect(commands("abort").slice(-2).map(command => command.type)).toEqual(["clear_queue", "abort"]);
  });
  it("queues then consumes steer and follow_up once, in order, within one native run", () => {
    const raw = wire("queue");
    for (const name of ["steer", "follow_up"]) expect(raw.find(event => event.command === name)?.data.disposition).toBe("queued");
    const users = raw.filter(event => event.type === "message_end" && event.message.role === "user").map(event => JSON.stringify(event.message.content));
    expect(users).toHaveLength(3); expect(users[1]).toContain("steering-marker"); expect(users[2]).toContain("followup-marker");
    expect(raw.filter(event => event.type === "agent_settled")).toHaveLength(1);
  });
  it("keeps one projector/Runner turn across a real HTTP-500 auto-retry", () => {
    const raw = wire("retry"), normalized = projectPiRecording(raw);
    expect(raw.filter(event => event.type === "agent_start")).toHaveLength(2);
    expect(raw).toContainEqual(expect.objectContaining({ type: "auto_retry_start", attempt: 1 }));
    expect(raw).toContainEqual(expect.objectContaining({ type: "auto_retry_end", success: true }));
    expect(new Set(normalized.map(event => event.turnId))).toEqual(new Set(["turn-1"]));
  });
  it("compacts before final settlement on the stub's small context model", () => {
    const raw = wire("compaction");
    const start = raw.findIndex(event => event.type === "compaction_start");
    expect(start).toBeGreaterThan(raw.findIndex(event => event.type === "agent_start"));
    expect(raw.slice(start + 1).some(event => event.type === "compaction_end" && event.result)).toBe(true);
    expect(raw.slice(start + 1).some(event => event.type === "agent_settled")).toBe(true);
    expect(raw.find(event => event.command === "set_model").data.contextWindow).toBe(4096);
  });
  it("fences an extension-started turn without ever sending prompt", () => {
    const raw = wire("extension");
    expect(commands("extension").map(command => command.type)).toEqual(["clear_queue", "abort"]);
    expect(raw.some(event => event.type === "agent_start")).toBe(true);
    expect(raw.find(event => event.type === "agent_settled")).toMatchObject({ aborted: true });
    expect(projectPiRecording(raw, true)).toEqual([{ runId: "pi-capture", turnId: "turn-0", eventType: "harness.diagnostic", payload: { code: "pi_unrequested_agent_start_fenced", providerMethod: "agent_start" } }]);
  });
  it("calls the installed subagent tool without launching a child, keeping usage unknown", () => {
    const raw = wire("subagent");
    const tool = raw.find(event => event.type === "tool_execution_end" && event.toolName === "subagent");
    expect(tool).toMatchObject({ isError: false }); expect(JSON.stringify(tool.result)).not.toContain("Tool subagent not found");
    expect(raw.find(event => event.type === "tool_execution_start" && event.toolName === "subagent").args).toMatchObject({ action: "list" });
    expect(projectPiRecording(raw)).toContainEqual(expect.objectContaining({ eventType: "usage.reported", payload: expect.objectContaining({ childUsage: "unknown", accountingComplete: false }) }));
  });
});

type ProjectedPiEvent = ReturnType<typeof projectPiRecording>[number];
type NativeFrame = Record<string, unknown>;

class JsonlSink implements PiRpcProxyFrameSink {
  readonly chunks: string[] = [];
  write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  once(_event: "drain", _listener: () => void): unknown { return this; }
}

class RecordingHarnessSession {
  readonly complete: Promise<void>;
  #resolveComplete!: () => void;

  constructor(readonly replay: PrpEvent[]) {
    this.complete = new Promise(resolve => { this.#resolveComplete = resolve; });
  }

  ids() { return { driverSessionId: "pi-session", providerSessionId: "pi-session" }; }

  async *events(): AsyncIterable<PrpEvent> {
    try {
      for (const event of this.replay) {
        yield event;
        // The production facade batches adjacent assistant deltas. Let its real
        // timer flush so each golden delta has an independently checked frame.
        if (event.eventType === "item.delta") await new Promise(resolve => setTimeout(resolve, 60));
      }
    } finally {
      this.#resolveComplete();
    }
  }

  async close(): Promise<void> {}
}

function settlementTerminals(name: string, raw: Record<string, unknown>[]): ProjectedPiEvent[] {
  // The projector owns content/usage/tool/diagnostic events. The native session
  // separately reports turn settlement from this recorded Pi boundary. The
  // extension scenario was fenced before an admitted prompt, so it has no turn.
  if (name === "extension") return [];
  let turn = 0;
  let active = false;
  const terminals: ProjectedPiEvent[] = [];
  for (const event of raw) {
    if (event.type === "agent_start" && !active) { turn += 1; active = true; }
    if (event.type === "agent_settled" && active) {
      const cancelled = event.aborted === true;
      terminals.push({
        runId: "pi-capture",
        turnId: `turn-${turn}`,
        eventType: cancelled ? "turn.cancelled" : "turn.completed",
        payload: { status: cancelled ? "cancelled" : "completed", piAgentSettled: true },
      });
      active = false;
    }
  }
  return terminals;
}

function replayWithSettlements(projected: ProjectedPiEvent[], terminals: ProjectedPiEvent[]): ProjectedPiEvent[] {
  const pending = new Map(terminals.map(event => [event.turnId, event]));
  const replay: ProjectedPiEvent[] = [];
  for (const [index, event] of projected.entries()) {
    replay.push(event);
    if (projected[index + 1]?.turnId !== event.turnId) {
      const terminal = pending.get(event.turnId);
      if (terminal) { replay.push(terminal); pending.delete(event.turnId); }
    }
  }
  replay.push(...pending.values());
  return replay;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for Pi proxy JSONL output");
}

describe("immutable Pi 1.5.2 recordings through the production Pi facade JSONL boundary", () => {
  it.each(scenarios)("replays %s with native facade mappings", async name => {
    const raw = wire(name);
    const projected = projectPiRecording(raw, name === "extension");
    const golden = JSON.parse(fixture(`${name}-1.5.2.normalized.json`));
    expect(projected).toEqual(golden);

    const projectedEnvelopes = projected.map((event, index) => envelope(event, index));
    for (const [index, event] of projected.entries()) {
      expect(validatePrpEvent(projectedEnvelopes[index]!, JSON.stringify(event))).toMatchObject({ ok: true });
      expect(event).toMatchObject({ runId: "pi-capture", turnId: expect.stringMatching(/^turn-/) });
    }
    const projectedWithTerminals = replayWithSettlements(projected, settlementTerminals(name, raw));
    const replay = projectedWithTerminals.map((event, index) => envelope(event, index));

    const session = new RecordingHarnessSession(replay);
    const driver = {
      async openSession() { return session as unknown as HarnessSession; },
    } as unknown as HarnessDriver;
    const sink = new JsonlSink();
    const proxy = createPiRpcAppServerProxy({
      stdout: sink,
      createDriver: () => driver,
      environment: { PAPERCLIP_RUN_ID: "pi-capture", PAPERCLIP_NORMALIZED_SESSION_ID: "pi-session" },
    });

    try {
      proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: process.cwd(), model: "neutral/recording" } }));
      await waitFor(() => sink.chunks.some(chunk => chunk.includes('"id":1')));
      await session.complete;
    } finally {
      await proxy.close();
    }

    // Decode exactly the production facade's newline-delimited UTF-8 output.
    const jsonl = Buffer.from(sink.chunks.join(""), "utf8").toString("utf8");
    const frames = jsonl.split("\n").filter(Boolean).map(line => JSON.parse(line) as NativeFrame);
    expect(frames.find(frame => frame.id === 1)).toMatchObject({ result: { thread: { id: "pi-session" } } });
    const notifications = frames.filter(frame => typeof frame.method === "string");
    let outputIndex = 0;
    for (const event of projectedWithTerminals) {
      expect(event.runId, `${name} ${event.eventType} captured run`).toBe("pi-capture");
      expect(event.turnId, `${name} ${event.eventType} captured turn`).toMatch(/^turn-/);
      const payload = event.payload;
      if (event.eventType === "context.compacted") {
        // This Runner-internal marker has no Pi RPC notification equivalent.
        continue;
      }
      const frame = notifications[outputIndex++];
      expect(frame, `${name} ${event.eventType} has its native facade frame`).toBeDefined();
      const params = frame!.params as Record<string, unknown>;

      if (event.eventType === "item.started" || event.eventType === "item.delta" || event.eventType === "item.completed" || event.eventType === "item.failed") {
        const assistantText = (payload.kind === "agentMessage" || payload.kind === "text") && typeof payload.text === "string"
          ? payload.text
          : null;
        const method = event.eventType === "item.delta" && assistantText !== null
          ? "item/agentMessage/delta"
          : event.eventType.replace(".", "/");
        const sourceItem = isRecord(payload.item)
          ? payload.item
          : { ...(event.itemId === undefined ? {} : { id: event.itemId }), ...(payload.kind === undefined ? {} : { type: payload.kind }), ...(payload.text === undefined ? {} : { text: payload.text }) };
        const nativeItem = assistantText === null
          ? sourceItem
          : { ...sourceItem, id: event.itemId, type: "agentMessage", text: assistantText };
        expect(frame).toMatchObject({
          method,
          params: {
            threadId: "pi-session", turnId: event.turnId,
            ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
            ...payload,
            item: nativeItem,
            ...(method === "item/agentMessage/delta" ? { delta: assistantText } : {}),
          },
        });
      } else if (event.eventType === "tool.execution.started" || event.eventType === "tool.execution.progressed" || event.eventType === "tool.execution.completed") {
        const phase = event.eventType === "tool.execution.started" ? "started"
          : event.eventType === "tool.execution.progressed" ? "updated" : "completed";
        const nativeToolType = payload.transport === "process" ? "commandExecution"
          : payload.transport === "dynamic" ? "dynamicToolCall"
            : payload.transport === "builtin" ? "builtinToolCall" : "mcpToolCall";
        expect(frame).toMatchObject({
          method: `item/${phase}`,
          params: {
            threadId: "pi-session", turnId: event.turnId, itemId: payload.executionId,
            item: {
              id: payload.executionId, type: nativeToolType, tool: payload.name,
              status: payload.status,
              output: typeof payload.output === "string" ? payload.output.slice(0, 16_384) : "",
            },
          },
        });
      } else if (event.eventType === "usage.reported") {
        expect(frame).toMatchObject({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "pi-session", turnId: event.turnId,
            cumulative: isRecord(payload.cumulative) ? payload.cumulative : {},
            runDelta: isRecord(payload.runDelta) ? payload.runDelta : {},
            runDeltaAvailable: payload.runDeltaAvailable === true,
            ...(payload.context === undefined ? {} : { context: isRecord(payload.context) ? payload.context : {} }),
          },
        });
      } else if (event.eventType === "harness.diagnostic") {
        expect(frame).toMatchObject({
          method: "warning",
          params: { threadId: "pi-session", message: payload.message ?? payload.code },
        });
      } else if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) {
        const status = event.eventType.slice("turn.".length);
        expect(frame).toMatchObject({
          method: event.eventType.replace(".", "/"),
          params: { threadId: "pi-session", turnId: event.turnId, turn: { id: event.turnId, status } },
        });
      } else {
        throw new Error(`No independent native Pi facade expectation for ${event.eventType}`);
      }
      if (event.eventType !== "harness.diagnostic") expect(params.turnId).toBe(event.turnId);
    }
    expect(outputIndex).toBe(notifications.length);
    if (name === "extension") {
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ method: "warning", params: { message: "pi_unrequested_agent_start_fenced" } });
    }
  });
});
