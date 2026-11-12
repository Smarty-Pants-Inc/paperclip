import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRunnerdProviderEnvironment } from "../../live/runnerd-codex-transport.js";
import { mapPiRpcRecord, PiRpcDriver } from "./pi-rpc-driver.js";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { createPiRpcAppServerProxy } from "../../cli/pi-rpc-app-server-proxy.js";
import * as piTurnImages from "./pi-turn-images.js";

// Keep reason: recorded large-output incident439 and failure attribution across
// resident runs. Drive the real session pump rather than a projector surrogate.
class FailureTransport {
  closed = false;
  exited = false;
  pid = null;
  wake?: () => void;
  queue: PiRpcRecord[] = [];
  failure?: Error;
  async request(type: string) {
    return { data: type === "get_state" ? { sessionId: "native-session", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
      : type === "get_available_thinking_levels" ? { levels: ["high"] }
      : type === "prompt" ? { disposition: "started" } : undefined };
  }
  send(value: PiRpcRecord) { this.queue.push(value); this.wake?.(); }
  fail(error: Error) { this.failure = error; this.wake?.(); }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const value = this.queue.shift();
      if (value) { yield value; continue; }
      if (this.failure) throw this.failure;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}
const flushFailure = () => new Promise<void>(resolve => setImmediate(resolve));
async function failureFixture(capture = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-failure-"));
  const transport = new FailureTransport();
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "runtime"), model: "neutral/model", piRpcThinkingLevel: "high", environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport })
    .openSession({ runId: "run-old", normalizedSessionId: "normalized", workingDirectory: root });
  const events: PrpEvent[] = [];
  const drained = capture ? (async () => { try { for await (const event of session.events()) events.push(event); } catch { /* terminal message must precede iterator rejection */ } })() : Promise.resolve();
  return { session, transport, events, async close() { await session.close(); await drained; await rm(root, { recursive: true, force: true }); } };
}

describe("PiRpcDriver", () => {
  it("does not send a late prompt when image preparation outlives close", async () => {
    const fixture = await failureFixture();
    let release!: (message: { message: string }) => void;
    let began!: () => void;
    const reading = new Promise<void>(resolve => { began = resolve; });
    const held = new Promise<{ message: string }>(resolve => { release = resolve; });
    const imageRead = vi.spyOn(piTurnImages, "piTurnImageInput").mockImplementationOnce(() => { began(); return held; });
    const requests = vi.spyOn(fixture.transport, "request");
    const started = fixture.session.startTurn({ message: { role: "user", text: "Inspect staged PNG", localImagePaths: ["/runner/image.png"] } })
      .then(() => null, error => error);
    try {
      await reading;
      await fixture.session.close();
      release({ message: "Inspect staged PNG" });
      expect(await started).toBeInstanceOf(Error);
      expect(requests.mock.calls.some(([type]) => type === "prompt")).toBe(false);
    } finally {
      release({ message: "Inspect staged PNG" });
      await started;
      imageRead.mockRestore();
      requests.mockRestore();
      await fixture.close();
    }
  });

  it("does not inherit ambient AGENT_HOME when server omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-home-ambient-"));
    vi.stubEnv("AGENT_HOME", root);
    let launched: NodeJS.ProcessEnv | undefined;
    const environment = createCapabilityRunnerdProviderEnvironment({ provider: "pi_rpc", options: {},
      identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "home", normalizedSessionId: "home", turnId: "turn", itemId: "item" },
      codexHome: root, runtimeContextPath: join(root, "context.json"), hasRuntimeContext: false });
    const transport = new FailureTransport();
    try {
      const session = await new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
        environment: { ...environment, PI_CODING_AGENT_DIR: join(root, "agent") },
        transportFactory: options => { launched = options.env; return transport as unknown as PiRpcTransport; },
      }).openSession({ runId: "home", normalizedSessionId: "home", workingDirectory: root });
      try { expect(launched?.AGENT_HOME).toBeUndefined(); } finally { await session.close(); }
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it("opens a partial runtime context without granting an agent-files home", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-home-partial-"));
    const transport = new FailureTransport();
    let launched: NodeJS.ProcessEnv | undefined;
    try {
      const session = await new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
        runtimeContext: { skills: [] },
        environment: { PI_CODING_AGENT_DIR: join(root, "agent"), AGENT_HOME: "/controller/stale-copy", PAPERCLIP_PI_AGENT_HOME: "/caller/forged-copy" },
        transportFactory: options => { launched = options.env; return transport as unknown as PiRpcTransport; },
      }).openSession({ runId: "partial", normalizedSessionId: "partial", workingDirectory: root });
      try {
        expect(launched).toBeDefined();
        expect(launched?.AGENT_HOME).toBeUndefined();
        expect(launched?.PAPERCLIP_PI_AGENT_HOME).toBeUndefined();
      } finally { await session.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["registered", "controller-path", "unregistered", "legacy", "symlink", "overlap"] as const)("binds AGENT_HOME from the authenticated runtime context, never env (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-home-"));
    const home = join(root, "instruction-copy"); await mkdir(home);
    const runtime = join(root, "sessions"); await mkdir(runtime);
    const link = join(root, "linked-copy"); if (mode === "symlink") await symlink(home, link);
    const rootPath = mode === "overlap" ? runtime : mode === "symlink" ? link : home;
    let launched: NodeJS.ProcessEnv | undefined;
    const transport = new FailureTransport();
    const opening = new PiRpcDriver({ runtimeDirectory: runtime, model: "neutral/model", piRpcThinkingLevel: "high",
      environment: { PI_CODING_AGENT_DIR: join(root, "agent"), ...(mode === "registered" ? {} : { AGENT_HOME: "/controller/stale-copy", PAPERCLIP_PI_AGENT_HOME: "/caller/forged-copy" }) },
      ...(mode === "unregistered" ? {} : { runtimeContext: { instructions: { workingCopy: { ...(mode === "legacy" ? {} : { kind: "agent_files" }), rootPath, entryPath: "AGENTS.md" } }, skills: [] } }),
      transportFactory: options => { launched = options.env; return transport as unknown as PiRpcTransport; },
    }).openSession({ runId: "home", normalizedSessionId: "home", workingDirectory: root });
    try {
      if (mode === "symlink" || mode === "overlap") {
        await expect(opening).rejects.toThrow(mode === "symlink" ? "real directory" : "overlaps");
        expect(launched).toBeUndefined();
      } else {
        const session = await opening;
        try {
          const expected = mode === "registered" || mode === "controller-path" ? home : undefined;
          expect(launched?.AGENT_HOME).toBe(expected);
          expect(launched?.PAPERCLIP_PI_AGENT_HOME).toBe(expected);
        } finally { await session.close(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("replays >4096 updates, >4MiB cumulative output and a >256KiB terminal through driver/projector/proxy without mutating native final", async () => {
    const f = await failureFixture(false);
    const frames: string[] = [];
    const proxy = createPiRpcAppServerProxy({ stdout: { write(frame) { frames.push(frame); return true; }, once() {} }, environment: { PAPERCLIP_RUN_ID: "run-old" }, createDriver: () => ({ async descriptor() { throw new Error("unused"); }, async openSession() { return f.session; } }) });
    try {
      proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { model: "neutral/model" } }));
      await flushFailure();
      proxy.acceptLine(JSON.stringify({ id: 2, method: "turn/start", params: { input: [{ text: "find and cat" }] } }));
      await flushFailure();
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "bulk", toolName: "bash", args: { command: "find . -type f -exec cat {} +" } });
      for (let i = 0; i < 4100; i++) {
        f.transport.send({ type: "tool_execution_update", toolCallId: "bulk", toolName: "bash", partialResult: { content: [{ type: "text", text: `${i}:` + "x".repeat(1100) }] } });
        if (i % 100 === 0) await flushFailure();
      }
      const finalText = "NATIVE_FINAL_" + "f".repeat(49_750);
      const nativeFinal = { content: [{ type: "text", text: finalText }], details: { fullOutputPath: "/native/spill", structuredContent: { output: "raw".repeat(400_000) } } };
      const original = JSON.stringify(nativeFinal);
      f.transport.send({ type: "tool_execution_end", toolCallId: "bulk", toolName: "bash", result: nativeFinal });
      await flushFailure();
      const decoded = frames.map(frame => JSON.parse(frame));
      expect(decoded.some(frame => frame.method === "turn/failed" || frame.method === "error")).toBe(false);
      expect(decoded.some(frame => frame.method === "item/completed" && frame.params.output === finalText)).toBe(true);
      expect(JSON.stringify(nativeFinal)).toBe(original);
      for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThan(16 * 1024 * 1024);
    } finally { await proxy.close(); await f.close(); }
  // Real-sized 4100-update replay and digest/redaction work exceeds Vitest's 5s default on shared hosts.
  }, 20_000);

  it.each([true, false])("publishes the underlying iterator failure before drain (active=%s)", async active => {
    const f = await failureFixture();
    try {
      const turn = active ? await f.session.startTurn({ message: { role: "user", text: "work" } }) : undefined;
      f.transport.fail(new Error("connect ECONNREFUSED 127.0.0.1:49999"));
      await flushFailure();
      const failure = f.events.find(event => event.eventType === (active ? "turn.failed" : "session.failed"));
      expect(failure).toMatchObject({ runId: "run-old", normalizedSessionId: "normalized", ...(turn ?? {}), payload: active ? { error: { code: "pi_rpc_transport_failed", message: "connect ECONNREFUSED 127.0.0.1:49999" } } : { code: "pi_rpc_transport_failed", message: "connect ECONNREFUSED 127.0.0.1:49999" } });
    } finally { await f.close(); }
  });

  it.each([true, false])("keeps a projector failure's captured origin (old continuation fails=%s)", async oldFails => {
    const f = await failureFixture();
    try {
      const old = await f.session.startTurn({ message: { role: "user", text: "old" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "old-tool", toolName: "bash", args: { command: "old" } });
      f.transport.send({ type: "message_start", message: { role: "assistant", id: "old-message" } });
      f.transport.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "old" } });
      f.transport.send({ type: "agent_settled", aborted: false });
      await flushFailure();
      await f.session.attachRun!({ runId: "run-new" });
      const current = await f.session.startTurn({ message: { role: "user", text: "new" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "current-tool", toolName: "bash", args: { command: "new" } });
      if (!oldFails) f.transport.send({ type: "tool_execution_update", toolCallId: "old-tool", toolName: "bash", partialResult: { content: [{ type: "text", text: "late old" }] } });
      f.transport.send({ type: "tool_execution_end", toolCallId: oldFails ? "old-tool" : "current-tool", toolName: "read", result: { content: [{ type: "text", text: "conflicting native tool name" }] } });
      await flushFailure();
      const failure = f.events.find(event => event.eventType === "session.failed");
      expect(failure).toMatchObject({ runId: oldFails ? "run-old" : "run-new", turnId: oldFails ? old.turnId : current.turnId, payload: { code: "pi_rpc_transport_failed", message: "pi_projection_tool_name_changed" } });
      if (oldFails) expect(f.events.some(event => event.eventType === "turn.failed" && event.turnId === current.turnId)).toBe(false);
    } finally { await f.close(); }
  });

  it("retains transport_error.message on the normalized terminal", async () => {
    const f = await failureFixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "transport_error", message: "Pi RPC record exceeded 4194304 bytes" });
      await flushFailure();
      expect(f.events.find(event => event.eventType === "turn.failed")?.payload).toMatchObject({ error: { code: "pi_rpc_transport_failed", message: "Pi RPC record exceeded 4194304 bytes" } });
    } finally { await f.close(); }
  });

  it.each(["normal", "\\u0000\\u0001\\n\\\"\\\\", "😀漢字"])("bounds only large projected partial text (%s), retaining raw and final receipts", async alphabet => {
    const f = await failureFixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "find . -type f -exec cat {} +" } });
      const body = alphabet.repeat(Math.ceil(3 * 1024 * 1024 / alphabet.length));
      const partial = { type: "tool_execution_update", toolCallId: "tool", toolName: "bash", partialResult: { content: [{ type: "text", text: body }] } };
      f.transport.send(partial);
      await flushFailure();
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      const projected = f.events.find(event => event.eventType === "item.delta" && typeof event.payload.output === "string");
      expect(projected?.payload.output).toContain("[Pi tool output truncated");
      expect(projected?.debug).toMatchObject({ piProjection: { truncated: true, recordBytes: Buffer.byteLength(JSON.stringify(partial)), recordSha256: createHash("sha256").update(JSON.stringify(partial)).digest("hex") } });
      expect(validatePrpEvent(projected).ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(1024 * 1024);
      expect(partial.partialResult.content[0]?.text).toBe(body);
      const final = "FINAL_NATIVE_SPILL_RECEIPT_" + "z".repeat(49_750);
      f.transport.send({ type: "tool_execution_end", toolCallId: "tool", toolName: "bash", result: { content: [{ type: "text", text: final }], details: { fullOutputPath: "/native/spill.txt" } } });
      await flushFailure();
      expect(f.events.find(event => event.eventType === "item.completed" && event.payload.output === final)?.payload.output).toBe(final);
    } finally { await f.close(); }
  // The >4MiB digest replay also crosses the 5s default on shared gate hosts.
  }, 20_000);

  it("declares the pi_rpc native driver and conservative capabilities", async () => {
    const descriptor = await new PiRpcDriver({ runtimeDirectory: "/tmp/pi-test" }).descriptor();
    expect(descriptor).toMatchObject({ kind: "pi_rpc", displayName: "Pi RPC", version: "1.5.2" });
    expect(descriptor.capabilities).toMatchObject({ interruption: true, resume: false, steering: true, queuedFollowUp: false, structuredResult: false, dynamicTools: true });
    expect(descriptor.capabilities.unsupported).not.toContain("steering");
    expect(descriptor.capabilities.unsupported).not.toContain("dynamicTools");
  });

  it("fails closed on an unknown managed credential mode before spawning Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-mode-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const driver = new PiRpcDriver({
      runtimeDirectory: join(root, "runtime"),
      environment: { PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "unknown" },
      transportFactory: () => { throw new Error("Pi must not spawn for an unknown mode"); },
    });
    try {
      await expect(driver.openSession({ runId: "mode-test", normalizedSessionId: "mode-test", workingDirectory: workspace }))
        .rejects.toThrow("PAPERCLIP_PI_RPC_CREDENTIAL_MODE must be broker|env");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps Pi deltas, tool lifecycle, and agent settlement into bound PRP events", () => {
    const turnId = "turn-test";
    expect(mapPiRpcRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } }, turnId)).toEqual([
      { eventType: "item.delta", payload: { kind: "agentMessage", text: "hello" }, turnId, itemId: "text-0" },
    ]);
    expect(mapPiRpcRecord({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } }, turnId)[0]).toMatchObject({
      eventType: "tool.execution.started", turnId, itemId: "call-1", payload: { schema: "paperclip.tool.execution.v1", executionId: "call-1", operation: "read", name: "read", status: "running", subject: "{\"path\":\"README.md\"}", output: null, outputBytes: 0, outputTruncated: false, outputDigest: null },
    });
    const toolResult = mapPiRpcRecord({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false }, turnId)[0]!;
    expect(toolResult).toMatchObject({
      eventType: "tool.execution.completed", turnId, itemId: "call-1", payload: { schema: "paperclip.tool.execution.v1", executionId: "call-1", operation: "read", name: "read", status: "completed", output: "ok", outputBytes: 2, outputTruncated: false },
    });
    expect(validatePrpEvent({ schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: "test:run:1", sourceSeq: 1, sourceInstanceId: "test", sourceKind: "runner", runId: "run", normalizedSessionId: "session", turnId, itemId: toolResult.itemId, eventType: toolResult.eventType, priority: 1, emittedAt: "2026-11-12T00:00:00.000Z", payload: toolResult.payload }).ok).toBe(true);
    expect(mapPiRpcRecord({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 12, output: 3, totalTokens: 15 } } }, turnId)).toEqual([
      { eventType: "item.completed", payload: { kind: "agentMessage", channel: "final", text: "done" }, turnId, itemId: "final" },
      { eventType: "item.completed", payload: { kind: "usage", usage: { runDelta: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }, runDeltaComplete: true } }, turnId, itemId: "usage" },
    ]);
    expect(mapPiRpcRecord({ type: "agent_settled", aborted: false }, turnId)).toEqual([
      { eventType: "turn.completed", payload: { status: "completed", piAgentSettled: true }, turnId },
    ]);
  });
});
