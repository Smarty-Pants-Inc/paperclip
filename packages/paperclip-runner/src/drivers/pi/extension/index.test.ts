import { connect, createServer, type Server } from "node:net";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPiBindExtension, readPiBindInitial, announce, captureOrigin, authorizeCallback,
  registerParkReadyContributor, registerStopChildren, registerHomeAdmission, configurePiBindHooks,
  type PiBindApi, type PiBindContext, type PiBindInitial, type PiBindTool,
} from "./index.js";
import { bindContent, sendPiBindRequest, validateBindReceipt, validatePiBindCommand, type BindRequest, type PiBindCommand, type Origin } from "../pi-bind-protocol.js";
import { socketAnnounce } from "./subagents/seam.js";

const initial: PiBindInitial = { schema: 1, sessionId: "session", epoch: 1, runId: "run-1", turnId: "turn-1", model: "paperclip/m", thinkingLevel: "low", instructions: "first instructions", tools: [] };
const first: Origin = { epoch: 1, runId: "run-1", turnId: "turn-1" };
const next: Origin = { epoch: 2, runId: "run-2", turnId: "turn-2" };
const bind: BindRequest = {
  schema: 1, type: "bind", nonce: "bind-2", sessionId: "session", expectedPriorEpoch: 1,
  epoch: 2, runId: "run-2", model: "paperclip/m", thinkingLevel: "low", instructions: "second instructions", tools: [],
  provider: { name: "paperclip", api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "ROTATED_CANARY", models: [{ id: "m", reasoning: true }] },
};
const roots: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(overrides: { initial?: PiBindInitial; hooks?: Parameters<typeof installPiBindExtension>[1]["hooks"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-bind-extension-")); roots.push(root); await chmod(root, 0o700);
  const socketPath = join(root, "bind.sock");
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, PiBindTool>();
  let active: string[] = ["read"];
  let idle = true, pending = false;
  let thinkingLevel = (overrides.initial ?? initial).thinkingLevel;
  const ctx: PiBindContext = { sessionManager: { getSessionId: () => "native-pi-session-not-host-id" }, isIdle: () => idle, hasPendingMessages: () => pending, abort: vi.fn(() => {}), model: { provider: "paperclip", id: "m" }, modelRegistry: { find: (provider, id) => ({ provider, id }) } };
  const pi: PiBindApi = {
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); },
    appendEntry: vi.fn(),
    registerProvider: vi.fn(), unregisterProvider: vi.fn(),
    registerTool: tool => { tools.set(tool.name, tool); if (tool.exposure !== "hidden") active = [...new Set([...active, tool.name])]; },
    getActiveTools: () => active, setActiveTools: names => { active = names; },
    setModel: vi.fn(async model => { ctx.model = model; return true; }),
    getThinkingLevel: () => thinkingLevel, setThinkingLevel: level => { thinkingLevel = level; },
  };
  const control = installPiBindExtension(pi, { socketPath, initial: overrides.initial ?? initial, hooks: overrides.hooks, timeoutMs: 100 });
  cleanups.push(() => control.close());
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  await emit("session_start");
  return { root, socketPath, pi, tools, ctx, emit, control, busy: () => { idle = false; }, pending: () => { pending = true; }, active: () => active };
}
function command(type: "begin_turn" | "settle", origin: Origin): PiBindCommand {
  return { schema: 1, type, nonce: `${type}-${origin.epoch}`, sessionId: "session", ...origin };
}
async function raw(path: string, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); let buffer = ""; socket.setEncoding("utf8");
    socket.once("close", () => { if (!buffer.includes("\n")) reject(new Error("closed before response")); });
    socket.once("error", reject); socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0]!)); } });
  });
}

describe("owned Pi bind extension", () => {
  // Keep: d4260467's second finish attempt hid the callback trust-boundary failure.
  it.each(["binding_missing", "call_identity_unannounced", "call_identity_reused", "result_invalid", "dispatch_exception", "aborted"])("records %s internally while the model sees only the unchanged refusal", async reason => {
    const dispatch = vi.fn(async () => {
      if (reason === "dispatch_exception") throw new Error("SECRET_HANDLER_ARGUMENTS");
      if (reason === "result_invalid") return { content: "SECRET_RESULT" } as never;
      return { content: [{ type: "text" as const, text: "accepted" }], details: {} };
    });
    const f = await fixture({ initial: { ...initial, tools: [{ name: "paperclip_finish", description: "finish", inputSchema: { type: "object" } }] }, hooks: { dispatchTool: dispatch } });
    if (reason !== "binding_missing") {
      await f.emit("input", { source: "rpc" }); await f.emit("before_agent_start", { systemPrompt: "native" });
      if (reason !== "call_identity_unannounced") await f.emit("tool_execution_start", { toolCallId: "finish-call", toolName: "paperclip_finish" });
    }
    const tool = f.tools.get("paperclip_finish")!;
    if (reason === "call_identity_reused") {
      await tool.execute("finish-call", {}, undefined, undefined, f.ctx);
      expect(f.pi.appendEntry).not.toHaveBeenCalled();
    }
    const controller = new AbortController();
    if (reason === "aborted") controller.abort(new Error("SECRET_ABORT"));
    await expect(tool.execute("finish-call", { secret: "SECRET_ARGUMENTS" }, controller.signal, undefined, f.ctx))
      .rejects.toMatchObject({ message: "Pi tool callback refused" });
    expect(f.pi.appendEntry).toHaveBeenCalledExactlyOnceWith("paperclip.pi-tool-refusal.v1", {
      code: "pi_tool_callback_refused", reason, toolCallId: "finish-call",
    });
    expect(JSON.stringify(vi.mocked(f.pi.appendEntry!).mock.calls)).not.toContain("SECRET");
    expect(dispatch).toHaveBeenCalledTimes(["binding_missing", "call_identity_unannounced", "aborted"].includes(reason) ? 0 : 1);
  });
  it.each(["binding_stale", "tool_not_admitted"])("diagnoses the %s guard on warm rebinding without dispatching", async reason => {
    const dispatch = vi.fn(async () => ({ content: [], details: {} }));
    const f = await fixture({ initial: { ...initial, tools: [{ name: "removed", description: "removed", inputSchema: { type: "object" } }] }, hooks: { dispatchTool: dispatch } });
    const old = f.tools.get("removed")!;
    await f.emit("agent_settled");
    await sendPiBindRequest(f.socketPath, bind);
    await sendPiBindRequest(f.socketPath, command("begin_turn", next));
    await f.emit("input", { source: "rpc" }); await f.emit("before_agent_start", { systemPrompt: "native" });
    const tool = reason === "binding_stale" ? old : f.tools.get("removed")!;
    await expect(tool.execute("removed-call", {}, undefined, undefined, f.ctx)).rejects.toMatchObject({ message: "Pi tool callback refused" });
    expect(f.pi.appendEntry).toHaveBeenCalledExactlyOnceWith("paperclip.pi-tool-refusal.v1", {
      code: "pi_tool_callback_refused", reason, toolCallId: "removed-call",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("keeps a refusal generic even if the diagnostic writer fails", async () => {
    const f = await fixture({ initial: { ...initial, tools: [{ name: "finish", description: "finish", inputSchema: { type: "object" } }] } });
    vi.mocked(f.pi.appendEntry!).mockImplementation(() => { throw new Error("SECRET_DIAGNOSTIC"); });
    await expect(f.tools.get("finish")!.execute("call", {}, undefined, undefined, f.ctx)).rejects.toMatchObject({ message: "Pi tool callback refused" });
    expect(f.pi.appendEntry).toHaveBeenCalledTimes(1);
  });
  it("records no refusal for an accepted completion callback", async () => {
    const f = await fixture({ initial: { ...initial, tools: [{ name: "paperclip_finish", description: "finish", inputSchema: { type: "object" } }] }, hooks: { dispatchTool: async () => ({ content: [], details: {} }) } });
    await f.emit("input", { source: "rpc" }); await f.emit("before_agent_start", { systemPrompt: "native" });
    await f.emit("tool_execution_start", { toolCallId: "accepted-finish", toolName: "paperclip_finish" });
    await expect(f.tools.get("paperclip_finish")!.execute("accepted-finish", {}, undefined, undefined, f.ctx)).resolves.toEqual({ content: [], details: {} });
    expect(f.pi.appendEntry).not.toHaveBeenCalled();
  });
  it("reads legacy inline INITIAL, preferring the selected private file without fallback on file errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-initial-")); roots.push(root);
    const path = join(root, "initial.json");
    const fileInitial = { ...initial, instructions: "x".repeat(200 * 1024) };
    await writeFile(path, JSON.stringify(fileInitial), { mode: 0o600 });
    const inline = JSON.stringify(initial);
    expect(readPiBindInitial({ PAPERCLIP_PI_BIND_INITIAL: inline })).toEqual(initial);
    expect(readPiBindInitial({ PAPERCLIP_PI_BIND_INITIAL: inline, PAPERCLIP_PI_BIND_INITIAL_FILE: path })).toEqual(fileInitial);
    await rm(path);
    expect(() => readPiBindInitial({ PAPERCLIP_PI_BIND_INITIAL: inline, PAPERCLIP_PI_BIND_INITIAL_FILE: path })).toThrow("rejected");
  });
  it("bootstraps immutable first authority without any socket roundtrip or provider registration", async () => {
    const f = await fixture();
    expect(f.pi.registerProvider).not.toHaveBeenCalled();
    expect(captureOrigin()).toEqual(first);
    expect(Object.isFrozen(captureOrigin())).toBe(true);
    expect(await f.emit("input", { source: "rpc" })).toEqual({ action: "continue" });
    expect(await f.emit("before_agent_start", { systemPrompt: "native" })).toMatchObject({ systemPrompt: "native\n\nfirst instructions" });
    expect(announce("call", first)).toBe(true);
    expect(authorizeCallback(first, "call")).toBe(true);
    await f.emit("agent_settled");
    expect(authorizeCallback(first, "call")).toBe(false);
    expect(await f.emit("input", { source: "extension" })).toEqual({ action: "handled" });
    expect(await f.emit("cache_warming_decision")).toEqual({ action: "stop" });
  });
  it("admits queued RPC input only under the immutable running origin, never as a new prompt", async () => {
    const f = await fixture();
    await f.emit("input", { source: "rpc" });
    expect(await f.emit("input", { source: "rpc" })).toEqual({ action: "handled" });
    await f.emit("before_agent_start", { systemPrompt: "native" });
    const origin = captureOrigin(); f.busy(); f.pending();
    expect(await f.emit("input", { source: "rpc" })).toEqual({ action: "continue" });
    expect(await f.emit("input", { source: "extension" })).toEqual({ action: "handled" });
    expect(captureOrigin()).toBe(origin);
    expect(origin).toEqual(first);
    f.control.authority.end();
    expect(await f.emit("input", { source: "rpc" })).toEqual({ action: "handled" });
    await f.emit("agent_settled");
    expect(await f.emit("input", { source: "rpc" })).toEqual({ action: "handled" });
  });
  it("rejects cross-session commands and never acquires future state in before_agent_start", async () => {
    const f = await fixture();
    expect(await raw(f.socketPath, { schema: 1, type: "announce", nonce: "x", sessionId: "other-session", toolCallId: "call", origin: first })).toEqual({ error: "Pi private request rejected" });
    expect(await f.emit("input", { source: "extension" })).toEqual({ action: "handled" });
    expect(() => f.emit("before_agent_start", { systemPrompt: "native" })).toThrow("authority refused");
    expect(f.ctx.abort).toHaveBeenCalled();
    expect(captureOrigin()).toBeNull();
  });
  it("requires a nonsecret initial configuration and normalized host session identity", async () => {
    await expect(fixture({ initial: { ...initial, sessionId: "" } })).rejects.toThrow("rejected");
    await expect(fixture({ initial: { ...initial, provider: bind.provider } as PiBindInitial })).rejects.toThrow("rejected");
  });
  it("creates a private socket only at session_start and cleans it on shutdown", async () => {
    const f = await fixture();
    expect((await stat(f.socketPath)).mode & 0o777).toBe(0o600);
    await f.emit("session_shutdown");
    await expect(stat(f.socketPath)).rejects.toThrow();
  });
  it("binds instructions and native dynamic tools, begins only explicitly, and rejects stale origins", async () => {
    const dispatch = vi.fn(async () => ({ content: [{ type: "text" as const, text: "accepted" }], details: {} }));
    const f = await fixture({ hooks: { dispatchTool: dispatch } });
    await f.emit("agent_settled");
    const request = { ...bind, tools: [{ name: "semantic", description: "semantic tool", inputSchema: { type: "object", properties: {} } }] };
    const receipt = await sendPiBindRequest(f.socketPath, request);
    expect(receipt).toMatchObject({ ...bindContent(request), epoch: 2, runId: "run-2" });
    expect(captureOrigin()).toBeNull();
    await sendPiBindRequest(f.socketPath, command("begin_turn", next));
    await f.emit("input", { source: "rpc" });
    expect(await f.emit("before_agent_start", { systemPrompt: "native" })).toMatchObject({ systemPrompt: "native\n\nsecond instructions" });
    await f.emit("tool_execution_start", { toolCallId: "semantic-call", toolName: "semantic" });
    const tool = f.tools.get("semantic")!;
    await expect(tool.execute("semantic-call", {}, undefined, undefined, f.ctx)).resolves.toMatchObject({ content: [{ text: "accepted" }] });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ origin: next, toolCallId: "semantic-call" }), expect.any(AbortSignal));
    expect(announce("stale", first)).toBe(false);
    await expect(tool.execute("unannounced", {}, undefined, undefined, f.ctx)).rejects.toThrow("refused");
    await f.emit("agent_settled");
    await expect(tool.execute("semantic-call", {}, undefined, undefined, f.ctx)).rejects.toThrow("refused");
  });
  it("sends native semantic tools over a real socket and waits for a correlated result", async () => {
    const f = await fixture();
    const toolSocket = join(f.root, "tools.sock");
    let received: any;
    const server: Server = createServer(socket => {
      socket.setEncoding("utf8"); let buffer = "";
      socket.on("data", chunk => { buffer += chunk; if (!buffer.includes("\n")) return;
        received = JSON.parse(buffer.split("\n")[0]!);
        socket.end(`${JSON.stringify({ schema: 1, type: "tool_result", nonce: received.nonce, sessionId: received.sessionId, origin: received.origin, toolCallId: received.toolCallId, result: { content: [{ type: "text", text: "host accepted" }], details: {} } })}\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(toolSocket, resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    await f.emit("agent_settled");
    await sendPiBindRequest(f.socketPath, { ...bind, toolSocketPath: toolSocket, tools: [{ name: "context", description: "context", inputSchema: { type: "object" } }] });
    await sendPiBindRequest(f.socketPath, command("begin_turn", next));
    await f.emit("input", { source: "rpc" }); await f.emit("before_agent_start", { systemPrompt: "native" });
    await f.emit("tool_execution_start", { toolCallId: "call-native", toolName: "context" });
    await expect(f.tools.get("context")!.execute("call-native", {}, undefined, undefined, f.ctx)).resolves.toMatchObject({ content: [{ text: "host accepted" }] });
    expect(received).toMatchObject({ type: "tool_call", origin: next, tool: "context", arguments: {} });
  });
  it("does not upgrade an old tool closure after rebinding and ignores late results", async () => {
    let resolve!: (value: any) => void;
    const dispatch = vi.fn(() => new Promise<any>(done => { resolve = done; }));
    const f = await fixture({ initial: { ...initial, tools: [{ name: "old", description: "old", inputSchema: { type: "object" } }] }, hooks: { dispatchTool: dispatch } });
    await f.emit("input", { source: "rpc" }); await f.emit("before_agent_start", { systemPrompt: "native" });
    await f.emit("tool_execution_start", { toolCallId: "old-call", toolName: "old" });
    const old = f.tools.get("old")!;
    const promise = old.execute("old-call", {}, undefined, undefined, f.ctx);
    await new Promise<void>(done => setImmediate(done));
    await f.emit("agent_settled");
    resolve({ content: [{ type: "text", text: "late" }], details: {} });
    await expect(promise).rejects.toThrow("refused");
    await sendPiBindRequest(f.socketPath, bind); await sendPiBindRequest(f.socketPath, command("begin_turn", next));
    expect(f.tools.get("old")!.exposure).toBe("hidden");
    await expect(old.execute("old-call", {}, undefined, undefined, f.ctx)).rejects.toThrow("refused");
  });
  it("fails closed on home admission error and reports only validated optional home digests", async () => {
    const hook = vi.fn().mockResolvedValueOnce({ homeDigest: "a".repeat(64) }).mockRejectedValueOnce(new Error("SECRET_HOME_FAILURE"));
    const f = await fixture({ hooks: { admitHome: hook } }); await f.emit("agent_settled");
    const response = await raw(f.socketPath, bind);
    expect(response).toEqual({ error: "Pi private request rejected" });
    expect(captureOrigin()).toBeNull();
    expect(f.pi.registerProvider).not.toHaveBeenCalled();
    hook.mockResolvedValue({ homeDigest: "b".repeat(64) });
    await expect(sendPiBindRequest(f.socketPath, bind)).resolves.toMatchObject({ homeDigest: "b".repeat(64) });
  });
  it("rejects busy/queued binds, replay changes, and duplicate prompt admission", async () => {
    const f = await fixture(); f.busy();
    await expect(sendPiBindRequest(f.socketPath, bind)).rejects.toThrow("rejected");
    await f.emit("input", { source: "rpc" });
    expect(await f.emit("input", { source: "extension" })).toEqual({ action: "handled" });
    expect(await f.emit("before_agent_start", { systemPrompt: "native" })).toBeDefined();
    const f2 = await fixture(); await f2.emit("agent_settled");
    await sendPiBindRequest(f2.socketPath, bind);
    await expect(sendPiBindRequest(f2.socketPath, bind)).resolves.toMatchObject({ epoch: 2 });
    await expect(sendPiBindRequest(f2.socketPath, { ...bind, instructions: "changed same nonce" })).rejects.toThrow("rejected");
    f2.pending();
    await expect(sendPiBindRequest(f2.socketPath, command("begin_turn", next))).rejects.toThrow("rejected");
  });
  it("rotates broker capability generations even for another turn in the same Runner run", async () => {
    const f = await fixture(); await f.emit("agent_settled");
    await expect(sendPiBindRequest(f.socketPath, command("begin_turn", { ...first, turnId: "second" }))).rejects.toThrow("rejected");
    const sameRun = { ...next, runId: first.runId };
    await sendPiBindRequest(f.socketPath, { ...bind, runId: first.runId });
    await sendPiBindRequest(f.socketPath, command("begin_turn", sameRun));
    expect(captureOrigin()).toEqual(sameRun);
    await sendPiBindRequest(f.socketPath, command("settle", sameRun));
    expect(captureOrigin()).toBeNull();
    expect(f.pi.unregisterProvider).toHaveBeenCalledWith("paperclip");
  });
  it("routes announce through the same authority as its exported function", async () => {
    const f = await fixture();
    const announceCommand = { schema: 1, type: "announce", nonce: "announce", sessionId: "session", toolCallId: "child", origin: first };
    expect(await raw(f.socketPath, announceCommand)).toMatchObject({ ack: true });
    expect(authorizeCallback(first, "child")).toBe(true);
    expect(await raw(f.socketPath, { ...announceCommand, nonce: "stale", origin: { ...first, runId: "old" } })).toEqual({ error: "Pi private request rejected" });
  });
  it("accepts announce, park_ready and stop_children on the actual host bind listener with correlated receipts", async () => {
    const f = await fixture();
    const request: PiBindCommand = { schema: 1, type: "announce", nonce: "real-host-announce", sessionId: "session", toolCallId: "raw-child", origin: first };
    expect(validatePiBindCommand(request)).toBe(true);
    const receipt = await raw(f.socketPath, request);
    expect(validateBindReceipt(receipt, request)).toBe(true);
    expect(authorizeCallback(first, "raw-child")).toBe(true);
    // The production child sender, not a fixture copy of its envelope.
    expect(await socketAnnounce({ socketPath: f.socketPath, sessionId: "session", toolCallId: "seam-child", origin: first })).toBe(true);
    expect(authorizeCallback(first, "seam-child")).toBe(true);
    await f.emit("agent_settled");
    cleanups.push(registerParkReadyContributor(() => ({ ready: true, reasons: [] })));
    cleanups.push(registerStopChildren(() => ({ settled: ["real-child"], uncertain: [] })));
    for (const type of ["park_ready", "stop_children"] as const) {
      const command: PiBindCommand = { schema: 1, type, nonce: `real-host-${type}`, sessionId: "session" };
      expect(validatePiBindCommand(command)).toBe(true);
      const reply = await raw(f.socketPath, command);
      expect(validateBindReceipt(reply, command)).toBe(true);
      expect(reply).toMatchObject(type === "park_ready" ? { ready: true, reasons: [] } : { settled: ["real-child"], uncertain: [] });
    }
  });
  it("aggregates park blockers and stop-child receipts with bounded failures", async () => {
    const f = await fixture();
    const park = { schema: 1, type: "park_ready", nonce: "park", sessionId: "session" };
    expect(await raw(f.socketPath, park)).toMatchObject({ ready: false });
    await f.emit("agent_settled");
    cleanups.push(registerParkReadyContributor(() => ({ ready: false, reasons: ["attached child"] })));
    expect(await raw(f.socketPath, park)).toMatchObject({ ready: false, reasons: ["attached child"] });
    const stop = { schema: 1, type: "stop_children", nonce: "stop", sessionId: "session" };
    expect(await raw(f.socketPath, stop)).toMatchObject({ settled: [], uncertain: [] });
    cleanups.push(registerStopChildren(() => ({ settled: ["child-1"], uncertain: ["child-2"] })));
    expect(await raw(f.socketPath, stop)).toMatchObject({ settled: ["child-1"], uncertain: ["child-2"] });
    cleanups.push(registerParkReadyContributor(() => { throw new Error("SECRET"); }));
    expect(JSON.stringify(await raw(f.socketPath, park))).not.toContain("SECRET");
    expect(await raw(f.socketPath, { ...park, type: "unknown", payload: "SECRET" })).toEqual({ error: "Pi private request rejected" });
  });
  it("accepts Pi's config-lowered effort on initial and warm turns without changing the requested bind receipt", async () => {
    const f = await fixture({ initial: { ...initial, thinkingLevel: "max" } });
    f.pi.setThinkingLevel!("xhigh");
    f.pi.setThinkingLevel = () => {}; // Pi config keeps the effective cap.
    await f.emit("input", { source: "rpc" });
    expect(await f.emit("before_agent_start", { systemPrompt: "native" })).toBeDefined();
    await f.emit("agent_settled");
    await expect(sendPiBindRequest(f.socketPath, { ...bind, thinkingLevel: "max" })).resolves.toMatchObject({ thinkingLevel: "max" });
    await sendPiBindRequest(f.socketPath, command("begin_turn", next));
    await f.emit("input", { source: "rpc" });
    expect(await f.emit("before_agent_start", { systemPrompt: "native" })).toBeDefined();
    expect(f.ctx.abort).not.toHaveBeenCalled();
  });
  it.each([undefined, "ultra", "max"])("refuses missing/invalid/escalated effective effort before bind ACK (%s)", async effective => {
    const f = await fixture(); await f.emit("agent_settled");
    f.pi.setThinkingLevel = () => {};
    f.pi.getThinkingLevel = () => effective as never;
    await expect(sendPiBindRequest(f.socketPath, { ...bind, thinkingLevel: "high" })).rejects.toThrow("rejected");
    expect(f.pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "paperclip", id: "m" }));
    expect(captureOrigin()).toBeNull();
  });
  it("bounds failed home/child hooks and never leaks their rejection details", async () => {
    const f = await fixture(); await f.emit("agent_settled");
    cleanups.push(registerHomeAdmission(() => new Promise(() => {})));
    await expect(sendPiBindRequest(f.socketPath, bind, { timeoutMs: 1000 })).rejects.toThrow("rejected");
    cleanups.push(registerParkReadyContributor(() => new Promise(() => {})));
    expect(await raw(f.socketPath, { schema: 1, type: "park_ready", sessionId: "session", nonce: "park" })).toMatchObject({ ready: false, reasons: expect.arrayContaining(["park contributor unavailable"]) });
    cleanups.push(registerStopChildren(() => { throw new Error("SECRET"); }));
    expect(await raw(f.socketPath, { schema: 1, type: "stop_children", sessionId: "session", nonce: "stop" })).toMatchObject({ settled: [], uncertain: ["stop hook unavailable"] });
  });
  it("reports dialog and queued-input park blockers and does not recycle a settled begin ACK", async () => {
    const f = await fixture(); await f.emit("agent_settled");
    await sendPiBindRequest(f.socketPath, bind);
    await sendPiBindRequest(f.socketPath, command("begin_turn", next));
    await f.emit("agent_settled");
    await expect(sendPiBindRequest(f.socketPath, command("begin_turn", next))).rejects.toThrow("rejected");
    await f.emit("ui_prompt_start"); f.pending();
    expect(await raw(f.socketPath, { schema: 1, type: "park_ready", sessionId: "session", nonce: "park" })).toMatchObject({ ready: false, reasons: expect.arrayContaining(["pending dialogs", "queued input"]) });
  });
  it("supports exact registerHomeAdmission digest mapping and fails closed on invalid digests", async () => {
    const home = vi.fn().mockResolvedValue({ digest: "d".repeat(64) });
    cleanups.push(registerHomeAdmission(home));
    const f = await fixture(); await f.emit("agent_settled");
    expect(home).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session", epoch: 1, runId: "run-1" }));
    await expect(sendPiBindRequest(f.socketPath, bind)).resolves.toMatchObject({ homeDigest: "d".repeat(64) });
    home.mockResolvedValue({ digest: "invalid" });
    await expect(sendPiBindRequest(f.socketPath, { ...bind, nonce: "bind-3", epoch: 3, expectedPriorEpoch: 2 })).rejects.toThrow("rejected");
    expect(captureOrigin()).toBeNull();
  });
  it("supports the exported home hook registration seam", async () => {
    const unregister = configurePiBindHooks({ admitHome: () => ({ homeDigest: "c".repeat(64) }) }); cleanups.push(unregister);
    const f = await fixture(); await f.emit("agent_settled");
    await expect(sendPiBindRequest(f.socketPath, bind)).resolves.toMatchObject({ homeDigest: "c".repeat(64) });
  });
});
