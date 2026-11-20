import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcDriverOptions } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";
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

const directSteps = ["workspace", "native_mcp_config", "company_skills", "extension_resolve", "pi_spawn", "get_state", "pi_spawn_to_get_state", "admission", "available_models", "total"];
// Nested intervals are emitted in completion order: models_json_write is
// inside provider_binding; total contains every step, including cleanup.
const managedSteps = ["workspace", "native_mcp_config", "company_skills", "extension_resolve", "models_snapshot", "model_catalog", "model_resolve", "compaction_config",
  "models_json_write", "provider_binding", "pi_spawn", "get_state", "pi_spawn_to_get_state", "admission", "tool_inventory", "settle", "bind_receipt", "begin_turn", "admission", "available_models", "total"];
const names = (steps: string[]) => steps.map(step => `runner.pi.open.${step}`);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(managed = false, fail?: "spawn" | "admission" | "available_models") {
  const root = await mkdtemp(join(tmpdir(), "pi-open-performance-"));
  const transport = new OpenTransport(managed ? "paperclip" : "neutral", fail);
  let observeOpenSpan: ((span: ProviderPerformanceSpan) => void) | undefined;
  const options: PiRpcDriverOptions = {
    runtimeDirectory: join(root, "sessions"), model: `${transport.provider}/faux`, piRpcThinkingLevel: "off",
    systemInstructions: "PRIVATE_INSTRUCTIONS_CANARY",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1",
      ...(managed ? { PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" } : {}) },
    ...(managed ? { dynamicTools: [{ name: "read_one", description: "Read one", inputSchema: { type: "object", properties: {} } }] } : {}),
    transportFactory: options => { observeOpenSpan = options.onOpenPerformanceSpan; return transport as unknown as PiRpcTransport; },
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
  return { transport, driver, input, observeOpenSpan: (span: ProviderPerformanceSpan) => observeOpenSpan?.(span) };
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
  const duration = (span: ProviderPerformanceSpan) => span.endedAtMs - span.startedAtMs;
  const startup = spans.find(span => span.name === "runner.pi.open.pi_spawn_to_get_state");
  if (startup) expect(spans.filter(span => ["runner.pi.open.pi_spawn", "runner.pi.open.get_state"].includes(span.name))
    .reduce((sum, span) => sum + duration(span), 0)).toBeLessThanOrEqual(duration(startup));
  // Sum siblings only, not nested intervals (models_json_write is nested in
  // broker provider_binding; pi_spawn/get_state are nested in startup).
  const nested = new Set(["runner.pi.open.pi_spawn", "runner.pi.open.get_state", "runner.pi.open.total"]);
  if (spans.some(span => span.name === "runner.pi.open.provider_binding")) nested.add("runner.pi.open.models_json_write");
  expect(spans.filter(span => !nested.has(span.name)).reduce((sum, span) => sum + duration(span), 0))
    .toBeLessThanOrEqual(duration(total));
}

describe("Pi open performance evidence", () => {
  it.each([false, true])("carries real Pi 1.5.2 factory/startup spans before any prompt (managed=%s)", async managed => {
    const runtime = fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
    expect(JSON.parse(await readFile(join(runtime, "package.json"), "utf8")).version).toBe("1.5.2");
    const root = await mkdtemp(join(tmpdir(), "pi-open-native-performance-"));
    const home = join(root, "home"), workspace = join(root, "workspace");
    await mkdir(home); await mkdir(workspace);
    await writeFile(join(home, "settings.json"), JSON.stringify({ packages: [], cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: "never" }));
    if (!managed) await writeFile(join(home, "models.json"), JSON.stringify({ providers: { neutral: {
      api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "unused-local-proof", models: [{ id: "faux" }],
    } } }));
    const commands: string[] = [], events: PrpEvent[] = [];
    let transport: PiRpcTransport | undefined;
    let session: Awaited<ReturnType<PiRpcDriver["openSession"]>> | undefined;
    let drained: Promise<void> | undefined;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = new PiRpcDriver({ command: process.execPath, model: `${managed ? "paperclip" : "neutral"}/faux`, piRpcThinkingLevel: "off",
      runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 10000,
      environment: { HOME: root, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", OTEL_SDK_DISABLED: "true",
        ...(managed ? { PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:9/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" } : {}) },
      transportFactory(options) {
        transport = new PiRpcTransport({ ...options, args: [join(runtime, "dist/bundle/cli.js"), ...options.args!] });
        const request = transport.request.bind(transport);
        transport.request = (type, ...rest) => { commands.push(type); return request(type, ...rest); };
        return transport;
      },
    });
    try {
      session = await driver.openSession({ runId: "native-open-timing", normalizedSessionId: "native-open-timing", workingDirectory: workspace });
      drained = (async () => { for await (const event of session!.events()) events.push(event); })();
      expect(commands).toEqual(["get_state", "get_state", "set_model", "get_available_thinking_levels", "set_thinking_level", "get_state", "get_available_models"]);
      await session.close(); await drained;
      const spans = events.filter(event => event.eventType === "harness.diagnostic").flatMap(event => parseProviderPerformanceSpans(event.payload, Date.now()));
      const owned = spans.filter(span => span.name.startsWith("runner.pi.open.extension_") && span.name !== "runner.pi.open.extension_resolve");
      expect(owned.map(span => span.name)).toEqual(names(["extension_initial_read", "extension_composition", "extension_factory", "extension_subagents_start",
        ...(managed ? ["extension_directory", "extension_home_admission", "extension_tools", "extension_socket_listen", "extension_session_start"] : [])]));
      const duration = (span: ProviderPerformanceSpan) => span.endedAtMs - span.startedAtMs;
      const byName = (step: string) => spans.find(span => span.name === `runner.pi.open.${step}`)!;
      for (const span of owned) {
        expect(duration(span)).toBeGreaterThanOrEqual(0);
        expect(span.startedAtMs).toBeGreaterThanOrEqual(byName("pi_spawn_to_get_state").startedAtMs);
        expect(span.endedAtMs).toBeLessThanOrEqual(byName("pi_spawn_to_get_state").endedAtMs);
      }
      expect(duration(byName("extension_initial_read")) + duration(byName("extension_composition"))).toBeLessThanOrEqual(duration(byName("extension_factory")));
      expect(["pre_extension_factory", "extension_factory", "extension_subagents_start", ...(managed ? ["extension_session_start"] : [])]
        .reduce((sum, step) => sum + duration(byName(step)), 0)).toBeLessThanOrEqual(duration(byName("pi_spawn_to_get_state")));
      if (managed) expect(["extension_directory", "extension_home_admission", "extension_tools", "extension_socket_listen"]
        .reduce((sum, step) => sum + duration(byName(step)), 0)).toBeLessThanOrEqual(duration(byName("extension_session_start")));
      expect(events.some(event => event.eventType === "turn.started")).toBe(false);
      expect(existsSync(`/proc/${transport!.pid}`)).toBe(false);
      if (process.env.PI_OPEN_TIMING_EVIDENCE_DIR) await writeFile(join(process.env.PI_OPEN_TIMING_EVIDENCE_DIR, `native-open-${managed ? "managed" : "direct"}.json`),
        JSON.stringify({ piVersion: "1.5.2", managed, commands, spans, timingLine: log.mock.calls.map(([line]) => line).filter(line => String(line).startsWith("pi.open timing ")),
          pid: transport!.pid, processAbsentAfterClose: !existsSync(`/proc/${transport!.pid}`), promptSent: false }, null, 2) + "\n");
    } finally { await session?.close(); await transport?.close(); await drained; log.mockRestore(); await rm(root, { recursive: true, force: true }); }
  }, 25000);
  it("keeps late startup stderr but rejects duplicate and later-session timings without extra RPC", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    const session = await f.driver.openSession(f.input);
    const events: PrpEvent[] = [];
    const drained = (async () => { for await (const event of session.events()) events.push(event); })();
    try {
      await tick();
      const spans = events.flatMap(event => parseProviderPerformanceSpans(event.payload, Date.now()));
      const startup = spans.find(span => span.name === "runner.pi.open.pi_spawn_to_get_state")!;
      const commands = [...f.transport.requests];
      const late: ProviderPerformanceSpan = { name: "runner.pi.open.extension_subagents_start", startedAtMs: startup.startedAtMs, endedAtMs: startup.endedAtMs, outcome: "ok" };
      f.observeOpenSpan(late); f.observeOpenSpan(late);
      f.observeOpenSpan({ ...late, name: "runner.pi.open.extension_factory", startedAtMs: startup.endedAtMs + 1, endedAtMs: startup.endedAtMs + 2 });
      await tick();
      expect(events.flatMap(event => parseProviderPerformanceSpans(event.payload, Date.now())).filter(span => span.name.startsWith("runner.pi.open.extension_") && span.name !== "runner.pi.open.extension_resolve"))
        .toEqual([late]);
      expect(f.transport.requests).toEqual(commands);
    } finally { await session.close(); await drained; log.mockRestore(); }
  });

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
      expect(log.mock.calls.map(([line]) => line).filter(line => String(line).startsWith("pi.open timing ")))
        .toEqual([`pi.open timing ${spans.map(span => `${span.name.slice("runner.pi.open.".length)}=${span.endedAtMs - span.startedAtMs}ms`).join(" ")}`]);
      const lines = log.mock.calls.map(([line]) => line).filter(line => typeof line === "string" && line.startsWith("pi.open ") && !line.startsWith("pi.open timing "));
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
      const failedNames = names(fail === "spawn" ? ["get_state", "pi_spawn_to_get_state", "total"] : [fail, "total"]);
      expect(spans.filter(span => span.outcome === "failed").map(span => span.name)).toEqual(failedNames);
      assertDurations(spans);
      expect(f.transport.closed).toBe(true);
      const lines = log.mock.calls.map(([line]) => line).filter(line => typeof line === "string" && line.startsWith("pi.open ") && !line.startsWith("pi.open timing "));
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
