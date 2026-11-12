import { connect, createServer } from "node:net";
import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PI_BIND_ERROR, PI_BIND_MAX_FRAME_BYTES, RunAuthority, sendPiToolRequest,
  type Origin, type PiToolCallRequest, type PiToolResult,
} from "./pi-bind-protocol.js";
import { startPiCallbackServer, type PiCallbackServerOptions } from "./pi-rpc-callback-server.js";

// Keep reason: real Unix IPC trust boundary, cancellation, and owned-inode data safety.
const origin: Origin = { epoch: 1, runId: "run-1", turnId: "turn-1" };
const next: Origin = { epoch: 2, runId: "run-2", turnId: "turn-2" };
const result: PiToolResult = { content: [{ type: "text", text: "accepted" }], details: {} };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function call(change: Partial<PiToolCallRequest> = {}): PiToolCallRequest {
  return { schema: 1, type: "tool_call", nonce: "nonce", sessionId: "session", origin: { ...origin }, toolCallId: "call", tool: "read", arguments: {}, ...change };
}
async function root() {
  const path = await mkdtemp(join(tmpdir(), "pi-callback-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  await chmod(path, 0o700);
  return path;
}
async function fixture(options: Partial<PiCallbackServerOptions> = {}) {
  const directory = await root(); const socketPath = join(directory, "tool.sock");
  const authority = new RunAuthority(); authority.bind(origin); authority.beginTurn(origin);
  const server = await startPiCallbackServer({
    socketPath, sessionId: "session", authority, waitForAnnouncement: async () => {},
    handleTool: async () => result, timeoutMs: 1000, ...options,
  });
  cleanups.push(() => server.close());
  return { directory, socketPath, authority, server };
}
async function client(socketPath: string) {
  const socket = connect(socketPath); socket.on("error", () => {});
  cleanups.push(async () => { socket.destroy(); });
  const closed = new Promise<string>(resolve => {
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(chunk));
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, closed };
}
async function raw(socketPath: string, frame: string | Buffer) {
  const peer = await client(socketPath); peer.socket.write(frame); return peer.closed;
}
const refused = `${JSON.stringify({ error: PI_BIND_ERROR })}\n`;

describe("Pi host semantic callback server (real Unix socket)", () => {
  it("serves the announced current call via sendPiToolRequest and preserves empty arguments", async () => {
    const seen: PiToolCallRequest[] = [];
    const f = await fixture({ handleTool: async request => { seen.push(request); return result; } });
    f.authority.announce("call", origin);
    await expect(sendPiToolRequest(f.socketPath, call())).resolves.toEqual(result);
    expect(seen).toHaveLength(1); expect(seen[0]!.arguments).toEqual({});
    expect((await lstat(f.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o600);
    await f.server.close(); expect(f.server.pendingCount()).toBe(0);
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for the real stream announcement and freezes the complete call before the hook", async () => {
    const entered = deferred<PiToolCallRequest>(); const announced = deferred<void>();
    let effects = 0; let hookCall: PiToolCallRequest | undefined; let handlerCall: PiToolCallRequest | undefined;
    const f = await fixture({
      waitForAnnouncement: async request => {
        hookCall = request; entered.resolve(request);
        expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.origin)).toBe(true);
        expect(Object.isFrozen(request.arguments)).toBe(true);
        expect(() => { (request.arguments as { nested: { text: string } }).nested.text = "changed"; }).toThrow();
        expect(() => { request.tool = "write"; }).toThrow();
        await announced.promise;
      },
      handleTool: async request => { ++effects; handlerCall = request; return result; },
    });
    const request = { ...call(), arguments: { nested: { text: "native text" } }, nativeExtra: { keep: true } };
    const pending = sendPiToolRequest(f.socketPath, request);
    await entered.promise;
    expect(f.authority.accept(origin, "call")).toBe(false); expect(effects).toBe(0);
    expect(f.server.pendingCount()).toBe(1);
    f.authority.announce("call", origin); announced.resolve();
    await expect(pending).resolves.toEqual(result);
    expect(effects).toBe(1); expect(handlerCall).toBe(hookCall);
    expect(handlerCall).toEqual(request);
  });

  it.each(["read", "bash", "context", "write"])("never self-announces or exempts %s", async tool => {
    let effects = 0; const f = await fixture({ handleTool: async () => { ++effects; return result; } });
    await expect(sendPiToolRequest(f.socketPath, call({ tool }))).rejects.toThrow(PI_BIND_ERROR);
    expect(effects).toBe(0); expect(f.authority.accept(origin, "call")).toBe(false);
  });

  it.each([
    { sessionId: "another-session" }, { origin: { ...origin, runId: "old-run" } },
    { origin: { ...origin, turnId: "old-turn" } }, { origin: { ...origin, epoch: 2 } },
  ])("rejects wrong routing before either hook: %j", async change => {
    let hooks = 0; const f = await fixture({ waitForAnnouncement: async () => { ++hooks; }, handleTool: async () => { ++hooks; return result; } });
    f.authority.announce("call", origin);
    await expect(sendPiToolRequest(f.socketPath, call(change))).rejects.toThrow(PI_BIND_ERROR);
    expect(hooks).toBe(0);
    await expect(sendPiToolRequest(f.socketPath, call())).resolves.toEqual(result);
  });

  it.each([
    { tool: "write", arguments: { path: "native" } },
    { tool: "read", arguments: { path: "substituted" } },
  ])("respects exact native tool/arguments refusal even for an announced ID: %j", async change => {
    let effects = 0;
    const f = await fixture({
      waitForAnnouncement: async request => {
        if (request.tool !== "read" || JSON.stringify(request.arguments) !== JSON.stringify({ path: "native" })) throw new Error("SECRET stream mismatch");
      },
      handleTool: async () => { ++effects; return result; },
    });
    f.authority.announce("call", origin);
    await expect(sendPiToolRequest(f.socketPath, call(change))).rejects.toThrow(PI_BIND_ERROR);
    expect(effects).toBe(0);
    await expect(sendPiToolRequest(f.socketPath, call({ arguments: { path: "native" } }))).resolves.toEqual(result);
    expect(effects).toBe(1);
  });

  it("bounds unannounced wait even if the hook ignores cancellation", async () => {
    const entered = deferred<AbortSignal>(); let effects = 0;
    const f = await fixture({ timeoutMs: 50, waitForAnnouncement: async (_request, signal) => { entered.resolve(signal); return new Promise(() => {}); }, handleTool: async () => { ++effects; return result; } });
    const pending = sendPiToolRequest(f.socketPath, call());
    const rejected = expect(pending).rejects.toThrow(PI_BIND_ERROR);
    const signal = await entered.promise;
    await rejected; expect(signal.aborted).toBe(true); expect(effects).toBe(0);
    await f.server.close(); expect(f.server.pendingCount()).toBe(0);
  });

  it("rejects an old-run replay while run 2 is active without consuming run 2", async () => {
    let effects = 0; const f = await fixture({ handleTool: async () => { ++effects; return result; } });
    f.authority.announce("old", origin); f.authority.settle(origin); f.authority.bind(next); f.authority.beginTurn(next);
    f.authority.announce("new", next);
    await expect(sendPiToolRequest(f.socketPath, call({ toolCallId: "old" }))).rejects.toThrow(PI_BIND_ERROR);
    await expect(sendPiToolRequest(f.socketPath, call({ toolCallId: "new", origin: next }))).resolves.toEqual(result);
    expect(effects).toBe(1);
  });

  it("rechecks authority after announcement wait and aborts on settlement", async () => {
    const entered = deferred<AbortSignal>(); const release = deferred<void>(); let effects = 0;
    const f = await fixture({ waitForAnnouncement: async (_call, signal) => { entered.resolve(signal); await release.promise; }, handleTool: async () => { ++effects; return result; } });
    const pending = sendPiToolRequest(f.socketPath, call()); const rejected = expect(pending).rejects.toThrow(PI_BIND_ERROR);
    const signal = await entered.promise;
    f.authority.settle(origin); f.authority.bind(next); f.authority.beginTurn(next); f.authority.announce("call", next);
    release.resolve(); await rejected;
    expect(signal.aborted).toBe(true); expect(effects).toBe(0);
  });

  it("settlement/rebind during awaited result rejects it and cancels the handler", async () => {
    const entered = deferred<AbortSignal>(); const returned = deferred<PiToolResult>();
    const f = await fixture({ handleTool: async (_call, signal) => { entered.resolve(signal); return returned.promise; } });
    f.authority.announce("call", origin);
    const pending = sendPiToolRequest(f.socketPath, call()); const rejected = expect(pending).rejects.toThrow(PI_BIND_ERROR);
    const signal = await entered.promise;
    f.authority.settle(origin); f.authority.bind(next); f.authority.beginTurn(next);
    returned.resolve(result); await rejected; expect(signal.aborted).toBe(true);
  });

  it("rejects even a result that settles authority just before returning", async () => {
    const f = await fixture({ handleTool: async () => { f.authority.settle(origin); return result; } });
    f.authority.announce("call", origin);
    await expect(sendPiToolRequest(f.socketPath, call())).rejects.toThrow(PI_BIND_ERROR);
  });

  it("uses the shared once-only dispatch for concurrent duplicates", async () => {
    let effects = 0; const entered = deferred<void>(); const release = deferred<PiToolResult>();
    const f = await fixture({ handleTool: async () => { ++effects; entered.resolve(); return release.promise; } });
    f.authority.announce("call", origin);
    const first = sendPiToolRequest(f.socketPath, call()); await entered.promise;
    await expect(sendPiToolRequest(f.socketPath, call({ nonce: "duplicate" }))).rejects.toThrow(PI_BIND_ERROR);
    release.resolve(result); await expect(first).resolves.toEqual(result); expect(effects).toBe(1);
  });

  it.each([7, null, ""])("refuses invalid call ID %j without widening the protocol", async toolCallId => {
    let effects = 0; const f = await fixture({ handleTool: async () => { ++effects; return result; } });
    expect(await raw(f.socketPath, `${JSON.stringify({ ...call(), toolCallId })}\n`)).toBe(refused);
    expect(effects).toBe(0);
  });

  it.each(["not json\n", `${JSON.stringify(call())}\n{}\n`, `${JSON.stringify({ ...call(), arguments: undefined })}\n`])("refuses malformed/multiple/missing-argument frames", async frame => {
    let effects = 0; const f = await fixture({ handleTool: async () => { ++effects; return result; } });
    f.authority.announce("call", origin);
    expect(await raw(f.socketPath, frame)).toBe(refused); expect(effects).toBe(0);
  });

  it("frames LF bytes, preserves split multibyte arguments and validates correlated receipts", async () => {
    const f = await fixture(); f.authority.announce("call", origin);
    const request = call({ arguments: { text: "🍋" } }); const frame = Buffer.from(`${JSON.stringify(request)}\n`);
    const split = frame.indexOf(Buffer.from("🍋")) + 1;
    const peer = await client(f.socketPath); peer.socket.write(frame.subarray(0, split));
    await new Promise<void>(resolve => setImmediate(resolve)); peer.socket.write(frame.subarray(split));
    expect(JSON.parse(await peer.closed)).toEqual({ schema: 1, type: "tool_result", nonce: request.nonce, sessionId: request.sessionId, origin, toolCallId: request.toolCallId, result });
  });

  it("bounds frame bytes, incomplete read deadlines, and malformed UTF-8", async () => {
    const f = await fixture({ timeoutMs: 60 });
    expect(await raw(f.socketPath, Buffer.alloc(PI_BIND_MAX_FRAME_BYTES + 1, 120))).toBe(refused);
    expect(await raw(f.socketPath, "{\"secret\":")).toBe(refused);
    expect(await raw(f.socketPath, Buffer.from([0x22, 0xff, 0x22, 0x0a]))).toBe(refused);
  });

  it("holds at most eight clients and close aborts all waiters without waiting on hooks", async () => {
    const signals: AbortSignal[] = []; const entered = deferred<void>();
    const f = await fixture({ waitForAnnouncement: async (_request, signal) => { signals.push(signal); if (signals.length === 8) entered.resolve(); return new Promise(() => {}); } });
    const clients: Awaited<ReturnType<typeof client>>[] = [];
    for (let i = 0; i < 8; i++) { const peer = await client(f.socketPath); clients.push(peer); peer.socket.write(`${JSON.stringify(call({ toolCallId: `call-${i}` }))}\n`); }
    await entered.promise; expect(f.server.pendingCount()).toBe(8);
    const ninth = await client(f.socketPath); expect(await ninth.closed).toBe("");
    expect(f.server.pendingCount()).toBe(8);
    await Promise.all([f.server.close(), f.server.close()]);
    await Promise.all(clients.map(peer => peer.closed));
    expect(signals.every(signal => signal.aborted)).toBe(true); expect(f.server.pendingCount()).toBe(0);
  });

  it("client cancellation aborts the active handler", async () => {
    const entered = deferred<AbortSignal>(); const aborted = deferred<void>();
    const f = await fixture({ handleTool: async (_request, signal) => { entered.resolve(signal); signal.addEventListener("abort", () => aborted.resolve(), { once: true }); return new Promise(() => {}); } });
    f.authority.announce("call", origin); const controller = new AbortController();
    const pending = sendPiToolRequest(f.socketPath, call(), { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("aborted"); const signal = await entered.promise;
    controller.abort(); await rejected; await aborted.promise; expect(signal.aborted).toBe(true);
  });

  it.each([
    async () => { throw new Error("SECRET thrown error"); },
    async () => ({ content: [{ type: "image", text: "SECRET invalid" }], details: {} }),
    async () => ({ content: [], details: {}, toJSON: () => ({ content: "SECRET serialized invalid", details: {} }) }),
    async () => ({ content: [{ type: "text", text: "x".repeat(PI_BIND_MAX_FRAME_BYTES) }], details: {} }),
  ])("returns only a fixed refusal for thrown, invalid, serialization-invalid or oversized results", async handler => {
    const f = await fixture({ handleTool: handler as PiCallbackServerOptions["handleTool"] }); f.authority.announce("call", origin);
    expect(await raw(f.socketPath, `${JSON.stringify(call())}\n`)).toBe(refused);
  });

  it("never unlinks a replacement file, trace, or root during close", async () => {
    const f = await fixture(); const trace = join(f.directory, "trace.jsonl"); await writeFile(trace, "trace kept");
    await unlink(f.socketPath); await writeFile(f.socketPath, "replacement kept");
    await f.server.close();
    expect(await readFile(f.socketPath, "utf8")).toBe("replacement kept");
    expect(await readFile(trace, "utf8")).toBe("trace kept"); expect((await lstat(f.directory)).isDirectory()).toBe(true);
  });

  it("does not unlink a different live socket inode at the same pathname", async () => {
    const f = await fixture(); await unlink(f.socketPath);
    const replacement = createServer(socket => { socket.on("error", () => {}); socket.end("replacement\\n"); });
    cleanups.push(() => new Promise<void>(resolve => replacement.close(() => resolve())));
    await new Promise<void>((resolve, reject) => { replacement.once("error", reject); replacement.listen(f.socketPath, resolve); });
    const replacementInfo = await lstat(f.socketPath, { bigint: true });
    await f.server.close();
    expect((await lstat(f.socketPath, { bigint: true })).ino).toBe(replacementInfo.ino);
    const peer = await client(f.socketPath); expect(await peer.closed).toBe("replacement\\n");
  });

  it("does not traverse a replacement symlink or remove a relocated socket", async () => {
    const f = await fixture(); const moved = join(f.directory, "owned.sock"); await rename(f.socketPath, moved);
    const target = join(f.directory, "trace.jsonl"); await writeFile(target, "kept"); await symlink(target, f.socketPath);
    await f.server.close(); expect((await lstat(f.socketPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("kept"); expect((await lstat(moved)).isSocket()).toBe(true);
  });

  it("pins the owned directory rather than cleaning a replacement root", async () => {
    const f = await fixture(); const moved = `${f.directory}-moved`;
    cleanups.push(() => rm(moved, { recursive: true, force: true }));
    await rename(f.directory, moved);
    // Place a different canonical directory at the original path.
    const replacementRoot = await root(); await rename(replacementRoot, f.directory);
    await writeFile(f.socketPath, "replacement root kept"); await writeFile(join(moved, "trace.jsonl"), "trace kept");
    await f.server.close();
    expect(await readFile(f.socketPath, "utf8")).toBe("replacement root kept");
    expect(await readFile(join(moved, "trace.jsonl"), "utf8")).toBe("trace kept");
    await expect(lstat(join(moved, "tool.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses public or symlinked directories and never replaces an existing pathname", async () => {
    const f = await fixture(); const options = { socketPath: f.socketPath, sessionId: "session", authority: f.authority, waitForAnnouncement: async () => {}, handleTool: async () => result };
    await expect(startPiCallbackServer(options)).rejects.toThrow(PI_BIND_ERROR);
    await chmod(f.directory, 0o755);
    await expect(startPiCallbackServer({ ...options, socketPath: join(f.directory, "public.sock") })).rejects.toThrow(PI_BIND_ERROR);
    await chmod(f.directory, 0o700);
    const linkRoot = await root(); const link = join(linkRoot, "alias"); await symlink(f.directory, link);
    await expect(startPiCallbackServer({ ...options, socketPath: join(link, "alias.sock") })).rejects.toThrow(PI_BIND_ERROR);
    const file = join(f.directory, "existing"); await writeFile(file, "preserved");
    await expect(startPiCallbackServer({ ...options, socketPath: file })).rejects.toThrow(PI_BIND_ERROR);
    expect(await readFile(file, "utf8")).toBe("preserved");
    f.authority.announce("call", origin); await expect(sendPiToolRequest(f.socketPath, call())).resolves.toEqual(result);
  });

  it.each([0, -1, NaN, Infinity, 60001])("refuses invalid deadlines %j", async timeoutMs => {
    const directory = await root(); const authority = new RunAuthority();
    await expect(startPiCallbackServer({ socketPath: join(directory, "s"), sessionId: "session", authority, timeoutMs, waitForAnnouncement: async () => {}, handleTool: async () => result })).rejects.toThrow(PI_BIND_ERROR);
  });
});
