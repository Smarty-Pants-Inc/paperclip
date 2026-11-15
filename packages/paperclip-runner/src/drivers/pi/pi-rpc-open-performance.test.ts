import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcDriverOptions } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { bindContent, type PiBindResponse } from "./pi-bind-protocol.js";
import { parseProviderPerformanceSpans, type ProviderPerformanceSpan } from "../../contracts/provider-performance.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: the real 31.1 s cold-open incident had no sub-step evidence;
// failure before a returned session cannot be reached cheaply by a live flow.
class OpenTransport {
  closed = false;
  exited = false;
  pid = null;
  requests: string[] = [];
  wake?: () => void;
  readonly failure = new Error("open failure sentinel");
  constructor(readonly provider: string, readonly fail?: "spawn" | "admission" | "available_models") {}
  async request(type: string): Promise<PiRpcRecord> {
    this.requests.push(type);
    if ((this.fail === "spawn" && this.requests.length === 1)
      || (this.fail === "admission" && type === "set_model")
      || (this.fail === "available_models" && type === "get_available_models")) throw this.failure;
    const model = { provider: this.provider, id: "faux" };
    return { data: type === "get_state" ? { sessionId: "native-open", model, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model
      : type === "get_available_thinking_levels" ? { levels: ["off"] }
      : type === "get_available_models" ? { models: [model] } : undefined };
  }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) await new Promise<void>(resolve => { this.wake = resolve; });
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}

const directSteps = ["workspace", "native_mcp_config", "company_skills", "extension_resolve", "pi_spawn_to_get_state", "admission", "available_models", "total"];
// Nested intervals are emitted in completion order: models_json_write is
// inside provider_binding; total contains every step, including cleanup.
const managedSteps = ["workspace", "native_mcp_config", "company_skills", "extension_resolve", "models_snapshot", "model_catalog", "model_resolve", "compaction_config",
  "models_json_write", "provider_binding", "pi_spawn_to_get_state", "admission", "tool_inventory", "settle", "bind_receipt", "begin_turn", "admission", "available_models", "total"];
const names = (steps: string[]) => steps.map(step => `runner.pi.open.${step}`);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(managed = false, fail?: "spawn" | "admission" | "available_models") {
  const root = await mkdtemp(join(tmpdir(), "pi-open-performance-"));
  const transport = new OpenTransport(managed ? "paperclip" : "neutral", fail);
  const options: PiRpcDriverOptions = {
    runtimeDirectory: join(root, "sessions"), model: `${transport.provider}/faux`, piRpcThinkingLevel: "off",
    systemInstructions: "PRIVATE_INSTRUCTIONS_CANARY",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1",
      ...(managed ? { PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" } : {}) },
    ...(managed ? { dynamicTools: [{ name: "read_one", description: "Read one", inputSchema: { type: "object", properties: {} } }] } : {}),
    transportFactory: () => transport as unknown as PiRpcTransport,
    bindRequest: async (_path, request) => {
      const receipt = request.type === "tool_inventory" ? { ...request, nativeTools: ["read"] }
        : request.type === "bind" ? { schema: 1, type: "bind", nonce: request.nonce, sessionId: request.sessionId,
          epoch: request.epoch, runId: request.runId, provider: request.provider.name, model: request.model, thinkingLevel: request.thinkingLevel, ...bindContent(request) }
        : request.type === "stop_children" ? { ...request, settled: [], uncertain: [] }
        : { ...request, ack: true };
      return receipt as PiBindResponse<typeof request>;
    },
  };
  const driver = new PiRpcDriver(options);
  const input = { runId: "run-open", normalizedSessionId: "host-open", workingDirectory: root };
  return { transport, driver, input };
}

function assertDurations(spans: ProviderPerformanceSpan[]) {
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    expect(Number.isFinite(span.startedAtMs)).toBe(true);
    expect(Number.isFinite(span.endedAtMs)).toBe(true);
    expect(span.endedAtMs - span.startedAtMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(span).sort()).toEqual(["endedAtMs", "name", "outcome", "startedAtMs"]);
  }
  const total = spans.at(-1)!;
  expect(total.name).toBe("runner.pi.open.total");
  for (const span of spans) {
    expect(span.startedAtMs).toBeGreaterThanOrEqual(total.startedAtMs);
    expect(span.endedAtMs).toBeLessThanOrEqual(total.endedAtMs);
  }
}

describe("Pi open performance evidence", () => {
  it.each([false, true])("flushes ordered numeric spans before the first turn (managed=%s)", async managed => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture(managed);
    const session = await f.driver.openSession(f.input);
    const events: PrpEvent[] = [];
    const drained = (async () => { for await (const event of session.events()) events.push(event); })();
    try {
      await tick();
      const diagnostics = events.filter(event => event.eventType === "harness.diagnostic" && event.payload.code === "provider_performance_spans");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ runId: "run-open" });
      expect(diagnostics[0]!.turnId).toBeUndefined();
      const spans = parseProviderPerformanceSpans(diagnostics[0]!.payload, Date.now());
      expect(spans.map(span => span.name)).toEqual(names(managed ? managedSteps : directSteps));
      expect(spans.every(span => span.outcome === "ok")).toBe(true);
      assertDurations(spans);
      expect(events.some(event => event.eventType === "turn.started")).toBe(false);
      expect(f.transport.requests).not.toContain("prompt");
      const lines = log.mock.calls.map(([line]) => line).filter(line => typeof line === "string" && line.startsWith("pi.open "));
      expect(lines).toEqual(spans.map(span => `pi.open ${span.name.slice("runner.pi.open.".length)} ${span.endedAtMs - span.startedAtMs}ms`));
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_INSTRUCTIONS_CANARY");
    } finally { await session.close(); await drained; log.mockRestore(); }
  });

  it.each(["spawn", "admission", "available_models"] as const)("emits the completed prefix and failed %s/total spans even with no returned session", async fail => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture(false, fail);
    try {
      await expect(f.driver.openSession(f.input)).rejects.toBe(f.transport.failure);
      const diagnostic = log.mock.calls.map(([line]) => line).filter(line => typeof line === "string" && line.startsWith("{"))
        .map(line => JSON.parse(line as string)).find(value => value.payload?.code === "provider_performance_spans");
      expect(diagnostic).toMatchObject({ eventType: "harness.diagnostic", runId: "run-open" });
      const spans = parseProviderPerformanceSpans(diagnostic.payload, Date.now());
      const failedStep = fail === "spawn" ? "pi_spawn_to_get_state" : fail;
      expect(spans.map(span => span.name)).toEqual(names([...directSteps.slice(0, directSteps.indexOf(failedStep) + 1), "total"]));
      expect(spans.slice(-2).map(span => span.outcome)).toEqual(["failed", "failed"]);
      expect(spans.slice(0, -2).every(span => span.outcome === "ok")).toBe(true);
      assertDurations(spans);
      expect(f.transport.closed).toBe(true);
      const lines = log.mock.calls.map(([line]) => line).filter(line => typeof line === "string" && line.startsWith("pi.open "));
      expect(lines).toEqual(spans.map(span => `pi.open ${span.name.slice("runner.pi.open.".length)} ${span.endedAtMs - span.startedAtMs}ms`));
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_INSTRUCTIONS_CANARY");
    } finally { await f.transport.close(); log.mockRestore(); }
  });

  it("retains early workspace failure evidence and does not replace the error if logging throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("logging unavailable"); });
    const f = await fixture();
    const controller = new AbortController();
    const failure = new Error("already cancelled"); controller.abort(failure);
    try {
      await expect(f.driver.openSession({ ...f.input, signal: controller.signal })).rejects.toBe(failure);
      expect(log.mock.calls.map(([line]) => String(line).split(" ").slice(0, 2).join(" ")).slice(0, 2)).toEqual(["pi.open workspace", "pi.open total"]);
      expect(f.transport.requests).toEqual([]);
    } finally { await f.transport.close(); log.mockRestore(); }
  });
});
