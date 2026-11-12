import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { PiRpcTransport, type PiRpcRecord, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessSession,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import type { NativeSessionCapabilities } from "../../contracts/types.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

export interface PiRpcDriverOptions {
  /** Proxy/backend integration options currently forwarded by the native factory. */
  completionFeedback?: unknown;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: (call: { tool: string; callId: string; threadId: string; turnId: string; arguments: unknown }) => Promise<unknown>;
  systemInstructions?: string;
  runtimeContext?: unknown;
  permissionMode?: string;
  taskEnvelope?: unknown;
  conversationMode?: string;
  isolateProcessGroup?: boolean;
  piThinkingLevel?: string;
  commandFd?: number;
  commandLifecycle?: { beforeSpawn(): void; afterSpawn(): void; afterExit(): void };
  /** Pi executable, defaulting to `pi`. */
  command?: string;
  /** Optional model in Pi's provider/model form. */
  model?: string;
  /** Root for provider session JSONL files. */
  runtimeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  runnerInstanceId?: string;
  shutdownTimeoutMs?: number;
  killTimeoutMs?: number;
  startupTimeoutMs?: number;
  now?: () => Date;
  transportFactory?: (options: PiRpcTransportOptions) => PiRpcTransport;
}

const PI_CAPABILITIES: NativeSessionCapabilities = {
  resume: false,
  typedEvents: true,
  providerTranscriptStreaming: true,
  steering: false,
  queuedFollowUp: false,
  interruption: true,
  structuredResult: false,
  read: false,
  reconciliation: false,
  usage: true,
  dynamicTools: false,
  runtimeRequestResolution: false,
  runtimeRequestHandoff: false,
  goals: false,
  threadLineage: false,
  unsupported: ["resume", "steering", "queuedFollowUp", "structuredResult", "runtimeRequests", "dynamicTools", "goals", "threadLineage"],
};

export class PiRpcDriver implements HarnessDriver {
  readonly #options: PiRpcDriverOptions;

  constructor(options: PiRpcDriverOptions) {
    this.#options = options;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: "pi_rpc",
      displayName: "Pi RPC",
      version: "1.5.2",
      protocolVersion: "pi-rpc-jsonl/v1",
      runtimeContextCapabilities: { instructions: "unsupported", skills: "unsupported", mcp: "unsupported" },
      capabilities: structuredClone(PI_CAPABILITIES),
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Pi RPC session startup aborted");
    const cwd = await realpath(input.workingDirectory);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Pi RPC working directory is not a directory");
    const directory = await realpath(this.#options.runtimeDirectory).catch(async () => {
      await mkdir(this.#options.runtimeDirectory, { recursive: true, mode: 0o700 });
      return realpath(this.#options.runtimeDirectory);
    });
    const filename = `${safeSessionName(input.normalizedSessionId)}.jsonl`;
    const sessionFile = join(directory, filename);
    const args = ["--mode", "rpc", "--session", sessionFile, "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
    if (this.#options.model) args.push("--model", this.#options.model);
    const transportOptions: PiRpcTransportOptions = {
      command: this.#options.command ?? "pi",
      args,
      cwd,
      env: piProcessEnvironment(this.#options.environment),
      commandFd: this.#options.commandFd,
      commandLifecycle: this.#options.commandLifecycle,
      shutdownTimeoutMs: this.#options.shutdownTimeoutMs,
      killTimeoutMs: this.#options.killTimeoutMs,
    };
    const transport = this.#options.transportFactory?.(transportOptions) ?? new PiRpcTransport(transportOptions);
    try {
      const response = await withAbort(
        withTimeout(transport.request("get_state"), this.#options.startupTimeoutMs ?? 10_000, "Pi RPC startup timed out"),
        input.signal,
      );
      const state = record(response.data);
      const providerSessionId = stringValue(state.sessionId);
      const actualSessionFile = stringValue(state.sessionFile) ?? sessionFile;
      if (!providerSessionId) throw new Error("Pi RPC get_state omitted the session id");
      return new PiRpcHarnessSession({
        transport,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        providerSessionId,
        sessionFile: actualSessionFile,
        workingDirectory: cwd,
        runnerInstanceId: this.#options.runnerInstanceId ?? `paperclip-pi-${input.runId}`,
        now: this.#options.now ?? (() => new Date()),
      });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
}

interface PiSessionState {
  transport: PiRpcTransport;
  runId: string;
  normalizedSessionId: string;
  providerSessionId: string;
  sessionFile: string;
  workingDirectory: string;
  runnerInstanceId: string;
  now: () => Date;
}

class EventQueue implements AsyncIterable<PrpEvent> {
  #events: PrpEvent[] = [];
  #waiters: Array<{ resolve: (result: IteratorResult<PrpEvent>) => void; reject: (error: Error) => void }> = [];
  #closed = false;
  #error: Error | null = null;

  push(event: PrpEvent): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else if (this.#events.length < 4096) this.#events.push(event);
    else return false;
    return true;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<PrpEvent> {
    return {
      next: () => {
        const event = this.#events.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

export class PiRpcHarnessSession implements HarnessSession {
  readonly #transport: PiRpcTransport;
  readonly #runId: string;
  readonly #normalizedSessionId: string;
  readonly #providerSessionId: string;
  readonly #sessionFile: string;
  readonly #workingDirectory: string;
  readonly #runnerInstanceId: string;
  readonly #now: () => Date;
  readonly #events = new EventQueue();
  #sourceSequence = 0;
  #activeTurnId: string | null = null;
  #lastText = "";
  #lastUsage: Record<string, unknown> | null = null;
  #usageEmitted = false;
  #closed = false;
  #turnSettled = false;

  constructor(state: PiSessionState) {
    this.#transport = state.transport;
    this.#runId = state.runId;
    this.#normalizedSessionId = state.normalizedSessionId;
    this.#providerSessionId = state.providerSessionId;
    this.#sessionFile = state.sessionFile;
    this.#workingDirectory = state.workingDirectory;
    this.#runnerInstanceId = state.runnerInstanceId;
    this.#now = state.now;
    void this.#pump();
  }

  ids(): ReturnType<HarnessSession["ids"]> {
    return { driverSessionId: this.#providerSessionId, providerSessionId: this.#providerSessionId, displayId: this.#providerSessionId };
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  async startTurn(input: Parameters<HarnessSession["startTurn"]>[0]): Promise<{ turnId: string }> {
    if (this.#closed) throw new Error("Pi RPC session is closed");
    if (this.#activeTurnId) throw new Error("Pi RPC session already has an active turn");
    const turnId = `pi-turn-${randomUUID()}`;
    this.#activeTurnId = turnId;
    this.#lastText = "";
    this.#lastUsage = null;
    this.#usageEmitted = false;
    this.#turnSettled = false;
    this.#emit("turn.started", { status: "inProgress" }, turnId);
    try {
      const response = await this.#transport.request("prompt", { message: input.message.text });
      const disposition = stringValue(record(response.data).disposition);
      if (disposition !== "started") {
        throw new Error(`Pi RPC prompt did not start an agent run (disposition=${disposition ?? "missing"})`);
      }
    } catch (error) {
      if (this.#activeTurnId === turnId) {
        this.#emit("turn.failed", { status: "failed", error: { code: "pi_prompt_rejected", message: error instanceof Error ? error.message : String(error), recoverable: false } }, turnId);
        this.#activeTurnId = null;
      }
      throw error;
    }
    return { turnId };
  }

  async interrupt(input: Parameters<NonNullable<HarnessSession["interrupt"]>>[0] = {}): Promise<void> {
    if (input.turnId && input.turnId !== this.#activeTurnId) return;
    if (!this.#activeTurnId) return;
    await this.#transport.request("abort");
  }

  processPid(): number | null {
    return this.#transport.pid;
  }

  processExited(): boolean {
    return this.#transport.exited;
  }

  async snapshot(): Promise<PersistedHarnessSession & { sessionFile: string }> {
    return {
      driverKind: "pi_rpc",
      driverSessionId: this.#providerSessionId,
      providerSessionId: this.#providerSessionId,
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      lastSourceSequence: this.#sourceSequence,
      workingDirectory: this.#workingDirectory,
      sessionFile: this.#sessionFile,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#transport.close();
    } finally {
      this.#events.close();
    }
  }

  async #pump(): Promise<void> {
    try {
      for await (const record of this.#transport.events()) {
        if (this.#closed) break;
        this.#consume(record);
      }
    } catch (error) {
      if (!this.#closed) {
        this.#emit("session.failed", { code: "pi_rpc_transport_failed", message: error instanceof Error ? error.message : String(error) });
        if (this.#activeTurnId) this.#finishTurn("failed", { error: { code: "pi_rpc_transport_failed" } });
        this.#events.close(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #consume(record: PiRpcRecord): void {
    if (record.type === "process_exit") {
      if (this.#activeTurnId) this.#finishTurn("failed", { error: { code: "pi_process_exited", codeValue: record.code, signal: record.signal } });
      else this.#emit("session.failed", { code: "pi_process_exited", exitCode: record.code, signal: record.signal });
      this.#events.close();
      return;
    }
    if (record.type === "transport_error") {
      this.#emit("session.failed", { code: "pi_rpc_transport_failed", message: record.message });
      if (this.#activeTurnId) this.#finishTurn("failed", { error: { code: "pi_rpc_transport_failed" } });
      this.#events.close();
      return;
    }
    const turnId = this.#activeTurnId;
    if (!turnId) return;
    switch (record.type) {
      case "agent_start":
      case "turn_start":
        // The turn is announced synchronously before prompt is sent, so a fast
        // provider event cannot race past an event subscriber.
        break;
      case "message_update": {
        const update = record.assistantMessageEvent;
        if (isRecord(update)) {
          if (update.type === "text_delta" && typeof update.delta === "string") this.#lastText += update.delta;
          for (const mapped of mapPiRpcRecord(record, turnId)) this.#emit(mapped.eventType, mapped.payload, mapped.turnId, mapped.itemId);
          if (isRecord(record.usage)) this.#lastUsage = record.usage;
        }
        break;
      }
      case "message_end": {
        const message = record.message;
        if (isRecord(message) && message.role === "assistant") {
          const text = assistantText(message.content);
          if (text) this.#lastText = text;
          if (isRecord(message.usage)) this.#lastUsage = message.usage;
        }
        break;
      }
      case "tool_execution_start":
      case "tool_execution_end":
        for (const mapped of mapPiRpcRecord(record, turnId)) this.#emit(mapped.eventType, mapped.payload, mapped.turnId, mapped.itemId);
        break;
      case "turn_end": {
        const message = isRecord(record.message) ? record.message : {};
        if (message.role === "assistant") {
          const text = assistantText(message.content);
          if (text) this.#lastText = text;
          if (isRecord(message.usage)) this.#lastUsage = message.usage;
        }
        for (const mapped of mapPiRpcRecord({ ...record, message }, turnId)) {
          this.#emit(mapped.eventType, mapped.payload, mapped.turnId, mapped.itemId);
          if (mapped.payload.kind === "usage") this.#usageEmitted = true;
        }
        break;
      }
      case "agent_settled":
        if (record.aborted === true) this.#finishTurn("cancelled", { piAgentSettled: true });
        else if (this.#lastUsage || this.#lastText) this.#finishTurn("completed", { piAgentSettled: true, ...(this.#lastUsage ? { usage: this.#lastUsage } : {}) });
        else this.#finishTurn("failed", { piAgentSettled: true, error: { code: "pi_empty_turn", message: "Pi settled without an assistant response." } });
        break;
      case "extension_error":
        this.#emit("harness.diagnostic", { code: "pi_extension_error", message: stringValue(record.error) ?? "Pi extension error" }, turnId);
        break;
      default:
        break;
    }
  }

  #finishTurn(status: "completed" | "failed" | "cancelled", extra: Record<string, unknown>): void {
    const turnId = this.#activeTurnId;
    if (!turnId || this.#turnSettled) return;
    this.#turnSettled = true;
    if (this.#lastUsage && !this.#usageEmitted) {
      this.#emit("item.completed", { kind: "usage", usage: { runDelta: usageDelta(this.#lastUsage), runDeltaComplete: true } }, turnId, "usage");
      this.#usageEmitted = true;
    }
    const eventType = status === "completed" ? "turn.completed" : status === "cancelled" ? "turn.cancelled" : "turn.failed";
    this.#emit(eventType, { status, ...extra }, turnId);
    this.#activeTurnId = null;
  }

  #emit(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, turnId?: string, itemId?: string): void {
    const sourceSeq = ++this.#sourceSequence;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "turn.failed" || eventType === "turn.cancelled" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    };
    if (!this.#events.push(event)) {
      this.#events.close(new Error("Pi RPC PRP event queue exceeded its limit"));
      void this.#transport.close().catch(() => undefined);
    }
  }
}

export function mapPiRpcRecord(record: PiRpcRecord, turnId: string): Array<{ eventType: PrpEvent["eventType"]; payload: Record<string, unknown>; turnId: string; itemId?: string }> {
  if (record.type === "message_update" && isRecord(record.assistantMessageEvent)) {
    const update = record.assistantMessageEvent;
    if (update.type === "text_delta" && typeof update.delta === "string") return [{ eventType: "item.delta", payload: { kind: "agentMessage", text: update.delta }, turnId, itemId: `text-${String(update.contentIndex ?? 0)}` }];
    if (update.type === "thinking_delta" && typeof update.delta === "string") return [{ eventType: "item.delta", payload: { kind: "reasoning", text: update.delta }, turnId, itemId: `thinking-${String(update.contentIndex ?? 0)}` }];
  }
  if ((record.type === "tool_execution_start" || record.type === "tool_execution_end") && typeof record.toolCallId === "string" && typeof record.toolName === "string") {
    const executionId = safePrpId(record.toolCallId);
    const started = record.type === "tool_execution_start";
    const output = started ? "" : toolResultText(record.result);
    const outputBytes = Buffer.byteLength(output);
    const boundedOutput = Buffer.from(output).subarray(Math.max(0, outputBytes - 65_536)).toString("utf8");
    const payload = {
      schema: "paperclip.tool.execution.v1",
      executionId,
      transport: record.toolName.startsWith("mcp__") ? "mcp" : "builtin",
      operation: toolOperation(record.toolName),
      name: record.toolName.slice(0, 4000),
      target: null,
      namespace: null,
      readOnly: /^(read|search|grep|find|list|glob)/iu.test(record.toolName),
      status: started ? "running" : record.isError === true ? "failed" : "completed",
      durationMs: started ? null : nonNegativeInteger(record.durationMs),
      exitCode: null,
      progress: null,
      subject: started ? boundedString(safeJson(record.args ?? {}), 4000) : null,
      output: started ? null : boundedOutput,
      outputBytes: started ? 0 : outputBytes,
      outputTruncated: !started && outputBytes > 65_536,
      outputDigest: started ? null : `sha256:${createHash("sha256").update(output).digest("hex")}`,
    };
    return [{ eventType: started ? "tool.execution.started" : "tool.execution.completed", payload, turnId, itemId: executionId }];
  }
  if (record.type === "turn_end") {
    const message = record.message;
    if (!isRecord(message) || message.role !== "assistant") return [];
    const mapped: Array<{ eventType: PrpEvent["eventType"]; payload: Record<string, unknown>; turnId: string; itemId?: string }> = [];
    const text = assistantText(message.content);
    if (text) mapped.push({ eventType: "item.completed", payload: { kind: "agentMessage", channel: "final", text }, turnId, itemId: "final" });
    if (isRecord(message.usage)) mapped.push({ eventType: "item.completed", payload: { kind: "usage", usage: { runDelta: usageDelta(message.usage), runDeltaComplete: true } }, turnId, itemId: "usage" });
    return mapped;
  }
  if (record.type === "agent_settled") return [{ eventType: record.aborted === true ? "turn.cancelled" : "turn.completed", payload: { status: record.aborted === true ? "cancelled" : "completed", piAgentSettled: true }, turnId }];
  return [];
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; }
  catch { return "[unserializable]"; }
}

function boundedString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function toolResultText(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
    if (text) return text;
  }
  if (typeof result === "string") return result;
  try { return result === undefined ? "" : JSON.stringify(result); }
  catch { return "[tool result could not be serialized]"; }
}

function safePrpId(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) ? value : `pi-call-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function toolOperation(name: string): "read" | "search" | "list" | "execute" | "edit" | "unknown" {
  const first = name.toLowerCase().split(/[._-]/u, 1)[0] ?? "";
  if (["read", "get", "fetch", "open"].includes(first)) return "read";
  if (["search", "grep", "find"].includes(first)) return "search";
  if (["list", "glob", "ls"].includes(first)) return "list";
  if (["edit", "write", "patch", "replace"].includes(first)) return "edit";
  return name ? "execute" : "unknown";
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageDelta(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    inputTokens: numberValue(usage.input),
    outputTokens: numberValue(usage.output),
    cacheReadTokens: numberValue(usage.cacheRead),
    cacheWriteTokens: numberValue(usage.cacheWrite),
    totalTokens: numberValue(usage.totalTokens),
    ...(isRecord(usage.cost) ? { cost: usage.cost } : {}),
  };
}

const SAFE_PI_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SystemRoot", "WINDIR", "PATHEXT"] as const;

function piProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PI_ENV_KEYS) if (process.env[key] !== undefined) environment[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) environment[key] = value;
  return environment;
}

function safeSessionName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "").slice(0, 160);
  return cleaned || "pi-session";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("Pi RPC session startup aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Pi RPC session startup aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
