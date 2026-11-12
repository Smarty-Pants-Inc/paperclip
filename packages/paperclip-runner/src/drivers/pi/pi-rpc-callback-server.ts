import { isUtf8 } from "node:buffer";
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, unlinkSync,
  type BigIntStats,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  PI_BIND_ERROR, PI_BIND_MAX_FRAME_BYTES, PI_BIND_TIMEOUT_MS, dispatchPiToolCall,
  validSocketPath, validatePiToolCallReceipt, validatePiToolCallRequest,
  type PiToolCallReceipt, type PiToolCallRequest, type PiToolResult, type RunAuthority,
} from "./pi-bind-protocol.js";

export interface PiCallbackServerOptions {
  /** Existing, canonical, host-owned 0700 directory; this server never deletes it. */
  socketPath: string;
  sessionId: string;
  authority: RunAuthority;
  /** Join the native stream's exact ID/origin/tool/arguments; never announce from IPC. */
  waitForAnnouncement: (call: PiToolCallRequest, signal: AbortSignal) => Promise<void>;
  /** Must honor cancellation before effects, as required by dispatchPiToolCall. */
  handleTool: (call: PiToolCallRequest, signal: AbortSignal) => Promise<PiToolResult>;
  /** One end-to-end deadline, including reading and waiting for the native stream. */
  timeoutMs?: number;
}
export interface PiCallbackServer {
  /** Open, bounded socket lifecycles, including incomplete requests and result writes. */
  pendingCount(): number;
  close(): Promise<void>;
}
const MAX_CLIENTS = 8;
const REFUSAL = `${JSON.stringify({ error: PI_BIND_ERROR })}\n`;
function refused(): Error { return new Error(PI_BIND_ERROR); }
function sameInode(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function owned(info: BigIntStats): boolean { return typeof process.getuid === "function" && info.uid === BigInt(process.getuid()); }
/** JSON.parse owns this entire acyclic graph. Iteration avoids recursive-freeze stack overflow. */
function freezeCall(call: PiToolCallRequest): PiToolCallRequest {
  const todo: object[] = [call];
  while (todo.length) {
    const value = todo.pop()!;
    for (const child of Object.values(value)) if (child !== null && typeof child === "object") todo.push(child);
    Object.freeze(value);
  }
  return call;
}
async function waitForStream(
  wait: PiCallbackServerOptions["waitForAnnouncement"], call: PiToolCallRequest, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(refused()); signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return wait(call, signal); }), cancelled]);
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", abort); }
}

/** Bounded host-side semantic IPC only, not a native-stream announcement source.
 * Uses the existing RunAuthority/dispatch boundary; there is no secondary call ledger.
 *
 * Node/libuv unlinks its bind pathname unconditionally on close, even if replaced.
 * Bind through a pinned directory FD alias instead. Close that FD synchronously just
 * before server.close(), making libuv's implicit unlink unresolvable; our own unlink
 * checks the socket's exact dev/inode through the still-pinned directory first.
 * This Linux Runner implementation fails closed if /proc/self/fd is unavailable.
 */
export async function startPiCallbackServer(options: PiCallbackServerOptions): Promise<PiCallbackServer> {
  const { socketPath, sessionId, authority, waitForAnnouncement, handleTool } = options;
  const timeoutMs = options.timeoutMs ?? PI_BIND_TIMEOUT_MS;
  if (!validSocketPath(socketPath) || resolve(socketPath) !== socketPath
    || typeof sessionId !== "string" || !sessionId.length || Buffer.byteLength(sessionId) > 256 || /[\u0000-\u001f]/u.test(sessionId)
    || typeof waitForAnnouncement !== "function" || typeof handleTool !== "function"
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw refused();

  let directoryFd: number | undefined;
  let socketInfo: BigIntStats | undefined;
  let bindPath = "";
  let ready = false, closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Map<Socket, AbortController>();
  const server = createServer(socket => {
    socket.on("error", () => {});
    if (!ready || closed || pending.size >= MAX_CLIENTS) { socket.destroy(); return; }
    const controller = new AbortController(); pending.set(socket, controller);
    const deadline = performance.now() + timeoutMs;
    // At most one 1 MiB backing buffer per client, even for one-byte input chunks.
    let buffer: Buffer | undefined, bytes = 0, handled = false, replied = false;
    const reply = (frame: string, reject = false) => {
      if (replied || socket.destroyed) return;
      replied = true; buffer = undefined;
      if (reject) controller.abort();
      socket.end(frame, () => socket.destroy());
    };
    const reject = () => reply(REFUSAL, true);
    const timer = setTimeout(() => { if (replied) socket.destroy(); else reject(); }, timeoutMs);
    socket.once("close", () => { clearTimeout(timer); pending.delete(socket); controller.abort(); buffer = undefined; });
    socket.once("end", () => { if (!replied) reject(); });

    async function dispatch(call: PiToolCallRequest) {
      let signal: AbortSignal | undefined;
      try {
        // This captured call, including all extra fields, was frozen before any await.
        if (call.sessionId !== sessionId || !authority.accept(call.origin)) throw refused();
        const turnSignal = authority.signalFor(call.origin);
        if (!turnSignal) throw refused();
        signal = AbortSignal.any([controller.signal, turnSignal]);
        signal.addEventListener("abort", reject, { once: true });
        signal.throwIfAborted();
        await waitForStream(waitForAnnouncement, call, signal);
        signal.throwIfAborted();
        if (!authority.accept(call.origin)) throw refused();
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw refused();
        // Keep the identical deeply immutable snapshot at both consumer boundaries.
        // The helper still performs atomic once-only consume, cancellation and result gates.
        const result = await dispatchPiToolCall(authority, call, (_captured, toolSignal) => {
          toolSignal.throwIfAborted();
          if (performance.now() >= deadline) throw refused();
          return handleTool(call, toolSignal);
        }, { signal, timeoutMs: remaining });
        const receipt: PiToolCallReceipt = {
          schema: 1, type: "tool_result", nonce: call.nonce, sessionId: call.sessionId,
          origin: call.origin, toolCallId: call.toolCallId, result,
        };
        const frame = `${JSON.stringify(receipt)}\n`;
        // Validate the emitted bytes too: details/toJSON must not change the wire shape.
        if (Buffer.byteLength(frame) > PI_BIND_MAX_FRAME_BYTES || !validatePiToolCallReceipt(JSON.parse(frame), call)) throw refused();
        signal.throwIfAborted();
        if (closed || !authority.accept(call.origin, call.toolCallId) || performance.now() >= deadline) throw refused();
        reply(frame);
      } catch { reject(); }
      finally { signal?.removeEventListener("abort", reject); }
    }
    socket.on("data", (chunk: Buffer) => {
      if (replied) return;
      if (handled) { reject(); return; }
      bytes += chunk.length;
      if (bytes > PI_BIND_MAX_FRAME_BYTES) { reject(); return; }
      const newline = chunk.indexOf(10);
      if (newline >= 0 && newline !== chunk.length - 1) { reject(); return; }
      buffer ??= Buffer.allocUnsafe(PI_BIND_MAX_FRAME_BYTES);
      chunk.copy(buffer, bytes - chunk.length);
      if (newline < 0) return;
      handled = true;
      try {
        const frame = buffer.subarray(0, bytes); buffer = undefined;
        if (!isUtf8(frame)) throw refused();
        const request: unknown = JSON.parse(frame.subarray(0, frame.length - 1).toString("utf8"));
        if (!validatePiToolCallRequest(request)) throw refused();
        const captured = freezeCall(request);
        void dispatch(captured);
      } catch { reject(); }
    });
  });

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; ready = false;
    // Publish the idempotent close promise before aborting consumers (which can reenter).
    let resolveClose!: () => void, rejectClose!: (error: Error) => void;
    closing = new Promise<void>((resolvePromise, rejectPromise) => { resolveClose = resolvePromise; rejectClose = rejectPromise; });
    const drained = Promise.all([...pending].map(([socket, controller]) => new Promise<void>(resolveSocket => {
      socket.once("close", resolveSocket); controller.abort(); socket.destroy();
    })));
    let failed = false;
    if (socketInfo && directoryFd !== undefined) {
      try {
        const current = lstatSync(bindPath, { bigint: true });
        if (current.isSocket() && owned(current) && sameInode(current, socketInfo)) unlinkSync(bindPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
    }
    // No await or consumer callback between FD invalidation and libuv close.
    if (directoryFd !== undefined) {
      const fd = directoryFd; directoryFd = undefined;
      try { closeSync(fd); } catch { failed = true; }
    }
    server.close(() => { void drained.then(() => { if (failed) rejectClose(refused()); else resolveClose(); }); });
    return closing;
  }
  server.on("error", () => { if (ready) void close().catch(() => {}); });
  try {
    const directory = dirname(socketPath);
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(directoryFd, { bigint: true });
    if (!info.isDirectory() || !owned(info) || (info.mode & 0o777n) !== 0o700n
      || realpathSync(directory) !== directory || !sameInode(lstatSync(directory, { bigint: true }), info)) throw refused();
    bindPath = `/proc/self/fd/${directoryFd}/${basename(socketPath)}`;
    if (!validSocketPath(bindPath) || realpathSync(dirname(bindPath)) !== directory) throw refused();
    await new Promise<void>((resolveListen, rejectListen) => {
      const error = () => rejectListen(refused());
      server.once("error", error);
      server.listen(bindPath, () => { server.removeListener("error", error); resolveListen(); });
    });
    socketInfo = lstatSync(bindPath, { bigint: true });
    if (!socketInfo.isSocket() || !owned(socketInfo)) throw refused();
    chmodSync(bindPath, 0o600);
    if (!sameInode(lstatSync(directory, { bigint: true }), info)
      || (lstatSync(bindPath, { bigint: true }).mode & 0o777n) !== 0o600n) throw refused();
    ready = true;
    return { pendingCount: () => pending.size, close };
  } catch {
    await close().catch(() => {});
    throw refused();
  }
}
