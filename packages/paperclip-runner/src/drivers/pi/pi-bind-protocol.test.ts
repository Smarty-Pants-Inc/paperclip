import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunAuthority, bindContent, dispatchPiToolCall, guardCallback, sendPiBindRequest, sendPiToolRequest,
  validateBindReceipt, validateBindRequest, validatePiToolCallRequest,
  type BindRequest, type Origin, type PiToolCallRequest,
} from "./pi-bind-protocol.js";

const origin: Origin = { epoch: 1, runId: "run-1", turnId: "turn-1" };
const binding: BindRequest = {
  schema: 1, type: "bind", nonce: "bind-2", sessionId: "session", expectedPriorEpoch: 1,
  epoch: 2, runId: "run-2", model: "paperclip/m", thinkingLevel: "low",
  instructions: "new instructions \u2028 with unicode", tools: [],
  provider: { name: "paperclip", api: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "broker-only", models: [{ id: "m" }] },
};
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function peer(reply: (request: Record<string, unknown>) => string | null) {
  const root = await mkdtemp(join(tmpdir(), "pi-bind-client-")); roots.push(root);
  const path = join(root, "peer.sock");
  const server = createServer(socket => {
    socket.on("error", () => undefined);
    let buffer = ""; socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const response = reply(JSON.parse(buffer.split("\n")[0]!));
      if (response !== null) socket.end(response);
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(path, resolve));
  return path;
}
function receipt() {
  return { schema: 1, type: "bind", nonce: binding.nonce, sessionId: "session", epoch: 2, runId: "run-2", provider: "paperclip", model: "paperclip/m", thinkingLevel: "low", ...bindContent(binding) };
}

describe("resident Pi authority", () => {
  it("requires the originating run AND a turn-local announcement; freezes captured identity", () => {
    const authority = new RunAuthority(); authority.bind(origin);
    authority.beginTurn(origin);
    const captured = authority.capture()!;
    expect(Object.isFrozen(captured)).toBe(true);
    expect(authority.announce("call", { ...origin, runId: "old" })).toBe(false);
    expect(authority.accept(origin, "call")).toBe(false);
    expect(authority.announce("call", origin)).toBe(true);
    expect(authority.accept(origin, "call")).toBe(true);
    authority.settle(origin);
    expect(authority.accept(captured, "call")).toBe(false);
    authority.bind({ epoch: 2, runId: "run-2" });
    authority.beginTurn({ epoch: 2, runId: "run-2", turnId: "turn-2" });
    expect(authority.announce("late", captured)).toBe(false);
    expect(authority.accept(captured)).toBe(false);
    expect(authority.accept({ epoch: 2, runId: "run-2", turnId: "turn-2" }, "call")).toBe(false);
  });
  it("does not let stale settlement revoke a newer turn, or reuse old call ids", () => {
    const authority = new RunAuthority(); authority.bind(origin); authority.beginTurn(origin);
    authority.announce("old-call", origin); authority.settle(origin);
    authority.bind({ epoch: 2, runId: "run-1" });
    const next = { ...origin, epoch: 2, turnId: "turn-2" };
    authority.beginTurn(next);
    expect(authority.settle(origin)).toBe(false);
    expect(authority.accept(next)).toBe(true);
    expect(authority.announce("old-call", next)).toBe(false);
  });
  it("rejects unbounded or invalid authority capacity", () => {
    for (const capacity of [0, -1, Infinity, NaN, 1.5, 65537]) {
      expect(() => new RunAuthority(capacity)).toThrow();
    }
  });
  it("bounds announcement storage by fencing rather than evicting authority", () => {
    const authority = new RunAuthority(1); authority.bind(origin); authority.beginTurn(origin);
    expect(authority.announce("one", origin)).toBe(true);
    expect(authority.announce("two", origin)).toBe(false);
    expect(authority.accept(origin, "one")).toBe(false);
  });
  it("dispatches only once after announcement, never exempts built-ins, and aborts on settle", async () => {
    const authority = new RunAuthority(); authority.bind(origin); authority.beginTurn(origin);
    const call: PiToolCallRequest = { schema: 1, type: "tool_call", nonce: "call-nonce", sessionId: "session", origin, toolCallId: "call-read", tool: "read", arguments: {} };
    let effects = 0;
    const handler = async () => { ++effects; return { content: [{ type: "text" as const, text: "ok" }], details: {} }; };
    await expect(dispatchPiToolCall(authority, call, handler)).rejects.toThrow("refused");
    expect(effects).toBe(0);
    authority.announce(call.toolCallId, origin);
    await expect(dispatchPiToolCall(authority, call, handler)).resolves.toMatchObject({ content: [{ text: "ok" }] });
    await expect(dispatchPiToolCall(authority, call, handler)).rejects.toThrow("refused");
    expect(effects).toBe(1);
    authority.announce("pending", origin);
    let signal: AbortSignal | undefined;
    const waiting = dispatchPiToolCall(authority, { ...call, toolCallId: "pending" }, async (_call, capturedSignal) => { signal = capturedSignal; return new Promise(() => {}); });
    const rejection = expect(waiting).rejects.toThrow("refused");
    await new Promise<void>(resolve => setImmediate(resolve));
    authority.settle(origin);
    await rejection; expect(signal?.aborted).toBe(true);
  });
  it("captures the whole announced dispatch identity before asynchronous work", async () => {
    const authority = new RunAuthority(); authority.bind(origin); authority.beginTurn(origin); authority.announce("captured", origin);
    const args = { message: "original" };
    const call: PiToolCallRequest = { schema: 1, type: "tool_call", nonce: "n", sessionId: "session", origin, toolCallId: "captured", tool: "read", arguments: args };
    let observed: PiToolCallRequest | undefined;
    const pending = dispatchPiToolCall(authority, call, async request => { observed = request; return { content: [], details: {} }; });
    call.toolCallId = "replacement"; call.tool = "write"; args.message = "replacement";
    await expect(pending).resolves.toMatchObject({ content: [] });
    expect(observed).toMatchObject({ toolCallId: "captured", tool: "read", arguments: { message: "original" }, origin });
  });
  it("does not leak input through rejection diagnostics", () => {
    const diagnostics: string[] = [];
    expect(guardCallback(new RunAuthority(), origin, "SECRET", text => diagnostics.push(text))).toBe(false);
    expect(diagnostics).toEqual(["Pi callback refused: stale run or unannounced tool call"]);
  });
});

describe("private bind framing and receipt validation", () => {
  it("validates the finite supported slice and rejects credential commands and route overrides", () => {
    expect(validateBindRequest(binding)).toBe(true);
    for (const change of [
      { epoch: 1 }, { expectedPriorEpoch: -1 }, { sessionId: "" }, { thinkingLevel: "auto" },
      { provider: { ...binding.provider, apiKey: "!read-secret" } },
      { provider: { ...binding.provider, baseUrl: "https://outside.example/v1" } },
      { provider: { ...binding.provider, models: [{ id: "m", baseUrl: "https://outside.example" }] } },
      { tools: [{ name: "x", description: "x", inputSchema: null }] },
    ]) expect(validateBindRequest({ ...binding, ...change })).toBe(false);
  });
  it("correlates every receipt field, instruction bytes, tools, and optional admitted home digest", () => {
    expect(validateBindReceipt(receipt(), binding)).toBe(true);
    expect(validateBindReceipt({ ...receipt(), homeDigest: "a".repeat(64) }, binding)).toBe(true);
    for (const change of [{ nonce: "other" }, { sessionId: "other" }, { runId: "old" }, { epoch: 3 }, { model: "paperclip/other" }, { thinkingLevel: "high" }, { instructionHash: "b".repeat(64) }, { instructionLength: 0 }, { toolRevision: "c".repeat(64) }, { homeDigest: "bad" }]) {
      expect(validateBindReceipt({ ...receipt(), ...change }, binding)).toBe(false);
    }
  });
  it("waits for the ACK, validates it, and does not treat EOF as success", async () => {
    const good = await peer(() => `${JSON.stringify(receipt())}\n`);
    await expect(sendPiBindRequest(good, binding)).resolves.toMatchObject(receipt());
    const wrong = await peer(() => `${JSON.stringify({ ...receipt(), nonce: "wrong" })}\n`);
    await expect(sendPiBindRequest(wrong, binding)).rejects.toThrow("receipt");
    const eof = await peer(() => "");
    await expect(sendPiBindRequest(eof, binding)).rejects.toThrow("closed");
  });
  it("bounds a missing ACK, oversize frame, malformed response, and cancellation", async () => {
    const lost = await peer(() => null);
    await expect(sendPiBindRequest(lost, binding, { timeoutMs: 20 })).rejects.toThrow("timed out");
    const oversized = await peer(() => `${"x".repeat(1024 * 1024 + 1)}\n`);
    await expect(sendPiBindRequest(oversized, binding)).rejects.toThrow();
    const malformed = await peer(() => "not json\n");
    await expect(sendPiBindRequest(malformed, binding)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(sendPiBindRequest(lost, binding, { signal: controller.signal })).rejects.toThrow();
  });
  it("executes an actual private semantic exchange and rejects stale result receipts", async () => {
    const call: PiToolCallRequest = { schema: 1, type: "tool_call", nonce: "call-nonce", sessionId: "session", origin, toolCallId: "call-1", tool: "context", arguments: {} };
    expect(validatePiToolCallRequest(call)).toBe(true);
    const result = { schema: 1, type: "tool_result", nonce: call.nonce, sessionId: "session", origin, toolCallId: "call-1", result: { content: [{ type: "text", text: "accepted" }], details: {} } };
    const good = await peer(() => `${JSON.stringify(result)}\n`);
    await expect(sendPiToolRequest(good, call)).resolves.toEqual(result.result);
    const stale = await peer(() => `${JSON.stringify({ ...result, origin: { ...origin, epoch: 2 } })}\n`);
    await expect(sendPiToolRequest(stale, call)).rejects.toThrow("receipt");
  });
});
