import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";

export type PiRpcRecord = Record<string, unknown>;

export interface PiRpcExtensionUiResponseInput {
  id: string | number;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}

export interface PiRpcTransportOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  commandFd?: number;
  commandLifecycle?: { beforeSpawn(): void; afterSpawn(): void; afterExit(): void };
  /** Canonical owned host/child paths already resolved and verified by the driver. */
  fatalSessionStartExtensionPaths?: readonly string[];
  maxRecordBytes?: number;
  shutdownTimeoutMs?: number;
  killTimeoutMs?: number;
}

export class PiRpcCommandError extends Error {
  readonly command: string;
  readonly response: PiRpcRecord;

  constructor(command: string, response: PiRpcRecord) {
    super(typeof response.error === "string" ? response.error : `Pi RPC command failed: ${command}`);
    this.name = "PiRpcCommandError";
    this.command = command;
    this.response = response;
  }
}

class AsyncRecordQueue implements AsyncIterable<PiRpcRecord> {
  #records: PiRpcRecord[] = [];
  #pendingUpdates = new Map<string, PiRpcRecord>();
  #waiters: Array<{ resolve: (result: IteratorResult<PiRpcRecord>) => void; reject: (error: Error) => void }> = [];
  #closed = false;
  #failure: Error | null = null;

  push(record: PiRpcRecord): boolean {
    if (this.#closed) return false;
    const updateId = record.type === "tool_execution_update"
      && typeof record.toolCallId === "string" && record.toolCallId.length > 0 ? record.toolCallId : null;
    // Only pending partial snapshots are replaceable. Every other record is an
    // ordering barrier, including tool completion, turn boundaries and errors.
    if (updateId === null) this.#pendingUpdates.clear();
    else {
      const previous = this.#pendingUpdates.get(updateId);
      if (previous) {
        this.#records[this.#records.indexOf(previous)] = record;
        this.#pendingUpdates.set(updateId, record);
        return true;
      }
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: record, done: false });
    else if (this.#records.length < 4096) {
      this.#records.push(record);
      if (updateId !== null) this.#pendingUpdates.set(updateId, record);
    } else return false;
    return true;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingUpdates.clear();
    this.#failure = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<PiRpcRecord> {
    return {
      next: () => {
        const record = this.#records.shift();
        if (record) {
          if (typeof record.toolCallId === "string" && this.#pendingUpdates.get(record.toolCallId) === record) {
            this.#pendingUpdates.delete(record.toolCallId);
          }
          return Promise.resolve({ value: record, done: false });
        }
        if (this.#failure) return Promise.reject(this.#failure);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

/** A strict LF-framed JSONL client for Pi's resident RPC process. */
export class PiRpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #records = new AsyncRecordQueue();
  readonly #pending = new Map<string, { command: string; resolve: (value: PiRpcRecord) => void; reject: (error: Error) => void }>();
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly #maxRecordBytes: number;
  readonly #shutdownTimeoutMs: number;
  readonly #killTimeoutMs: number;
  readonly #fatalSessionStartExtensionPaths: ReadonlySet<string>;
  #reportedStartupExtensionError = false;
  #buffer = Buffer.alloc(0);
  #nextId = 0;
  #closed = false;
  #exited = false;
  #streamsClosed = false;
  #exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  #stderr = "";
  #failure: Error | null = null;

  constructor(options: PiRpcTransportOptions) {
    this.#maxRecordBytes = options.maxRecordBytes ?? 64 * 1024 * 1024;
    this.#fatalSessionStartExtensionPaths = new Set(options.fatalSessionStartExtensionPaths);
    this.#shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, 1500);
    this.#killTimeoutMs = boundedTimeout(options.killTimeoutMs, 750);
    const stdio: Array<"pipe" | "ignore" | number> = ["pipe", "pipe", "pipe"];
    if (options.commandFd !== undefined) {
      if (!Number.isInteger(options.commandFd) || options.commandFd < 3 || options.commandFd > 255) {
        throw new Error("Pi executable descriptor is outside the allowed range");
      }
      while (stdio.length <= options.commandFd) stdio.push("ignore");
      stdio[options.commandFd] = options.commandFd;
    }
    options.commandLifecycle?.beforeSpawn();
    this.#child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    options.commandLifecycle?.afterSpawn();
    let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    this.#exit = new Promise((resolve) => { resolveExit = resolve; });
    this.#child.once("exit", (code, signal) => {
      this.#exited = true;
      this.#exitInfo = { code, signal };
    });
    this.#child.once("close", (code, signal) => {
      options.commandLifecycle?.afterExit();
      this.#streamsClosed = true;
      const info = this.#exitInfo ?? { code, signal };
      const terminal: PiRpcRecord = { type: "process_exit", ...info };
      if (this.#stderr) terminal.stderr = this.#stderr.slice(-8192);
      this.#records.push(terminal);
      this.#records.close();
      const failure = new Error(`Pi RPC process exited (code=${info.code ?? "null"}, signal=${info.signal ?? "none"})`);
      for (const pending of this.#pending.values()) pending.reject(failure);
      this.#pending.clear();
      resolveExit(info);
    });
    this.#child.once("error", (error) => {
      const failure = new Error(`Pi RPC process could not start: ${error.message}`, { cause: error });
      for (const pending of this.#pending.values()) pending.reject(failure);
      this.#pending.clear();
      this.#records.push({ type: "transport_error", message: failure.message });
      this.#records.close(failure);
      if (!this.#exited) {
        this.#exited = true;
        resolveExit({ code: null, signal: null });
      }
    });
    this.#child.stdin.on("error", (error) => {
      if (!this.#closed && !this.#exited) this.#fail(new Error(`Pi RPC stdin failed: ${error.message}`, { cause: error }));
    });
    this.#child.stdout.on("data", (chunk: Buffer | string) => this.#read(chunk));
    this.#child.stdout.on("error", (error) => this.#fail(new Error(`Pi RPC stdout failed: ${error.message}`, { cause: error })));
    this.#child.stdout.on("end", () => {
      if (this.#buffer.length > 0) this.#fail(new Error("Pi RPC stdout ended with an unterminated JSONL record"));
    });
    this.#child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-8192);
    });
  }

  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  get exited(): boolean {
    return this.#exited;
  }

  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.#exitInfo;
  }

  events(): AsyncIterable<PiRpcRecord> {
    return this.#records;
  }

  async request(command: string, params: PiRpcRecord = {}): Promise<PiRpcRecord> {
    if (this.#failure) throw this.#failure;
    if (this.#closed || this.#exited) throw new Error("Pi RPC transport is closed");
    const id = `paperclip-pi-${++this.#nextId}`;
    const response = new Promise<PiRpcRecord>((resolve, reject) => {
      this.#pending.set(id, { command, resolve, reject });
    });
    try {
      const line = `${JSON.stringify({ ...params, id, type: command })}\n`;
      if (!this.#child.stdin.write(line)) {
        await new Promise<void>((resolve, reject) => {
          this.#child.stdin.once("drain", resolve);
          this.#child.stdin.once("error", reject);
        });
      }
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  async sendExtensionUiResponse(input: PiRpcExtensionUiResponseInput): Promise<void> {
    if (this.#closed || this.#exited) throw new Error("Pi RPC transport is closed");
    const line = `${JSON.stringify(extensionUiResponseRecord(input))}\n`;
    if (this.#child.stdin.write(line)) return;

    await new Promise<void>((resolve, reject) => {
      const stdin = this.#child.stdin;
      const cleanup = () => {
        stdin.removeListener("drain", onDrain);
        stdin.removeListener("error", onError);
        stdin.removeListener("close", onClose);
        this.#child.removeListener("exit", onExit);
      };
      const succeed = () => { cleanup(); resolve(); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const onDrain = () => succeed();
      const onError = (error: Error) => fail(error);
      const onClose = () => fail(new Error("Pi RPC stdin closed before extension UI response drained"));
      const onExit = () => fail(new Error("Pi RPC process exited before extension UI response drained"));

      if (this.#closed || this.#exited || stdin.destroyed || stdin.writableEnded) {
        onClose();
        return;
      }
      stdin.once("drain", onDrain);
      stdin.once("error", onError);
      stdin.once("close", onClose);
      this.#child.once("exit", onExit);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return this.#exit.then(() => undefined);
    this.#closed = true;
    if (this.#exited) return this.#exit.then(() => undefined);
    this.#child.stdin.end();
    if (await settledWithin(this.#exit, this.#shutdownTimeoutMs)) return;
    this.#child.kill("SIGTERM");
    if (await settledWithin(this.#exit, this.#killTimeoutMs)) return;
    this.#child.kill("SIGKILL");
    if (!(await settledWithin(this.#exit, this.#killTimeoutMs))) {
      throw new Error("Pi RPC process did not exit after bounded shutdown escalation");
    }
  }

  #read(chunk: Buffer | string): void {
    if (this.#streamsClosed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < incoming.length) {
      const newline = incoming.indexOf(0x0a, offset);
      const end = newline < 0 ? incoming.length : newline;
      const part = incoming.subarray(offset, end);
      if (this.#buffer.length + part.length > this.#maxRecordBytes) {
        this.#fail(new Error(`Pi RPC record exceeded ${this.#maxRecordBytes} bytes`));
        return;
      }
      if (part.length) this.#buffer = Buffer.concat([this.#buffer, part]);
      if (newline < 0) return;
      let line = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      offset = newline + 1;
      if (!line.length) continue;
      let record: unknown;
      try {
        record = JSON.parse(line.toString("utf8"));
      } catch (error) {
        this.#fail(new Error("Pi RPC emitted invalid JSONL", { cause: error }));
        return;
      }
      if (!isRecord(record)) {
        this.#fail(new Error("Pi RPC emitted a non-object JSON record"));
        return;
      }
      // Pi 1.5.2 RPC includes ExtensionError.extensionPath (a required string).
      // Home packages may fail without breaking our startup authority. Attribute
      // only by exact canonical path, never package names, suffixes, or messages.
      if (record.type === "extension_error" && record.event === "session_start") {
        let path: string | undefined;
        try { if (typeof record.extensionPath === "string") path = realpathSync(record.extensionPath); }
        catch { /* An unavailable/foreign path cannot identify an owned extension. */ }
        const diagnostic = { type: "extension_error", event: "session_start",
          extensionPath: typeof record.extensionPath === "string" ? record.extensionPath.slice(0, 1024) : "",
          error: typeof record.error === "string" ? record.error.slice(0, 2048) : "Extension startup failed" };
        if (path && this.#fatalSessionStartExtensionPaths.has(path)) {
          this.#records.push(diagnostic);
          this.#fail(new Error("Pi RPC extension session_start failed"));
          return;
        }
        // Bound both diagnostic size and count for a noisy third-party package.
        if (!this.#reportedStartupExtensionError) {
          this.#reportedStartupExtensionError = true;
          if (!this.#records.push(diagnostic)) {
            this.#fail(new Error("Pi RPC event queue exceeded its limit"));
            return;
          }
        }
        continue;
      }
      if (record.type === "response" && typeof record.id === "string") {
        const pending = this.#pending.get(record.id);
        if (pending) {
          this.#pending.delete(record.id);
          if (record.success === true) pending.resolve(record);
          else pending.reject(new PiRpcCommandError(pending.command, record));
          continue;
        }
      }
      if (!this.#records.push(record)) {
        this.#fail(new Error("Pi RPC event queue exceeded its limit"));
        return;
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#records.push({ type: "transport_error", message: error.message });
    this.#records.close(error);
    this.#child.kill("SIGTERM");
  }
}

function isRecord(value: unknown): value is PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionUiResponseRecord(input: PiRpcExtensionUiResponseInput): PiRpcRecord {
  if (!isRecord(input)) throw new Error("Pi RPC extension UI response must be an object");
  const id = input.id;
  if ((typeof id === "string" && (id.length === 0 || id.length > 1024))
    || (typeof id === "number" && !Number.isSafeInteger(id))
    || (typeof id !== "string" && typeof id !== "number")) {
    throw new Error("Pi RPC extension UI response has an invalid id");
  }

  const hasValue = input.value !== undefined;
  const hasConfirmed = input.confirmed !== undefined;
  const hasCancelled = input.cancelled !== undefined;
  if (Number(hasValue) + Number(hasConfirmed) + Number(hasCancelled) !== 1
    || (hasValue && typeof input.value !== "string")
    || (hasConfirmed && typeof input.confirmed !== "boolean")
    || (hasCancelled && input.cancelled !== true)) {
    throw new Error("Pi RPC extension UI response must contain exactly one valid response value");
  }

  return {
    type: "extension_ui_response",
    id,
    ...(hasValue ? { value: input.value } : {}),
    ...(hasConfirmed ? { confirmed: input.confirmed } : {}),
    ...(hasCancelled ? { cancelled: true } : {}),
  };
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? Math.min(30_000, Math.max(1, Math.floor(value))) : fallback;
}

async function settledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
