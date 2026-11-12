import { createHash } from "node:crypto";
import { connect } from "node:net";

/** Private IPC only: never put these records on Pi stdin/stdout or in its journal. */
export const PI_BIND_MAX_FRAME_BYTES = 1024 * 1024;
export const PI_BIND_TIMEOUT_MS = 5000;
export const PI_BIND_ERROR = "Pi private request rejected";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface Origin { readonly epoch: number; readonly runId: string; readonly turnId: string }
export interface PiDynamicTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface PiBindingConfig {
  epoch: number;
  runId: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
  instructions: string;
  tools: PiDynamicTool[];
  /** Host-owned callback socket in the same private runtime directory. */
  toolSocketPath?: string;
  homeDigest?: string;
}
export type PiJsonValue = null | boolean | number | string | PiJsonValue[] | { [key: string]: PiJsonValue };
export type PiModelCompat = { [key: string]: PiJsonValue };

/** Lossless JSON metadata only: no prototypes, accessors, symbols, holes or cycles.
 * Shared references are fine (JSON duplicates them); only ancestor cycles fail.
 * Used before either config cloning or private-channel serialization.
 */
export function isPiModelCompat(value: unknown): value is PiModelCompat {
  const ancestors = new Set<object>();
  function visit(item: unknown): boolean {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    ancestors.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      if (array && keys.length !== item.length + 1) return false;
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string" || array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !visit(descriptor.value)) return false;
      }
      return true;
    } finally { ancestors.delete(item); }
  }
  try { return value !== null && typeof value === "object" && !Array.isArray(value) && visit(value); }
  catch { return false; }
}

export interface PiBindModel {
  id: string; name?: string; reasoning?: boolean; input?: Array<"text" | "image">;
  contextWindow?: number; maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
  compat?: PiModelCompat;
}
export interface PiBindProvider {
  name: string;
  api: "openai-completions" | "anthropic-messages" | "openai-responses";
  baseUrl: string;
  /** Revocable loopback capability ONLY, never the upstream credential. */
  apiKey: string;
  models: PiBindModel[];
}
interface Envelope { schema: 1; nonce: string; sessionId: string }
export interface BindRequest extends Envelope, PiBindingConfig {
  type: "bind";
  expectedPriorEpoch: number;
  provider: PiBindProvider;
}
export interface TurnRequest extends Envelope, Origin { type: "begin_turn" | "settle" }
export interface AnnounceRequest extends Envelope { type: "announce"; toolCallId: string; origin: Origin }
export interface ParkReadyRequest extends Envelope { type: "park_ready" }
export interface StopChildrenRequest extends Envelope { type: "stop_children" }
export type PiBindCommand = BindRequest | TurnRequest | AnnounceRequest | ParkReadyRequest | StopChildrenRequest;
export interface BindReceipt extends Envelope {
  type: "bind"; epoch: number; runId: string; provider: string; model: string; thinkingLevel: PiThinkingLevel;
  instructionHash: string; instructionLength: number; toolRevision: string; homeDigest?: string;
}
export interface TurnReceipt extends Envelope, Origin { type: "begin_turn" | "settle"; ack: true }
export interface AnnounceReceipt extends Envelope { type: "announce"; ack: true; toolCallId: string; origin: Origin }
export interface ParkReadyResult { ready: boolean; reasons: string[] }
export interface StopChildrenResult { settled: string[]; uncertain: string[] }
export interface ParkReadyReceipt extends Envelope, ParkReadyResult { type: "park_ready" }
export interface StopChildrenReceipt extends Envelope, StopChildrenResult { type: "stop_children" }
export type PiBindReceipt = BindReceipt | TurnReceipt | AnnounceReceipt | ParkReadyReceipt | StopChildrenReceipt;
export type PiBindResponse<C extends PiBindCommand> = C extends BindRequest ? BindReceipt
  : C extends AnnounceRequest ? AnnounceReceipt : C extends ParkReadyRequest ? ParkReadyReceipt
  : C extends StopChildrenRequest ? StopChildrenReceipt : TurnReceipt;
export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
}
export interface PiToolCallRequest extends Envelope {
  type: "tool_call"; origin: Origin; toolCallId: string; tool: string; arguments: unknown;
}
export interface PiToolCallReceipt extends Envelope {
  type: "tool_result"; origin: Origin; toolCallId: string; result: PiToolResult;
}
export interface PiPrivateRequestOptions { timeoutMs?: number; signal?: AbortSignal }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 1024): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f]/u.test(value);
}
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
export function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function envelope(value: unknown): value is Record<string, unknown> & Envelope {
  return object(value) && value.schema === 1 && text(value.nonce, 256) && text(value.sessionId, 256);
}
export function validateOrigin(value: unknown): value is Origin {
  return object(value) && integer(value.epoch, 1) && text(value.runId, 256) && text(value.turnId, 256);
}
function sameOrigin(a: Origin, b: Origin): boolean { return a.epoch === b.epoch && a.runId === b.runId && a.turnId === b.turnId; }
export function validateBindingConfig(value: unknown): value is PiBindingConfig {
  if (!object(value) || !integer(value.epoch, 1) || !text(value.runId, 256) || !text(value.model, 512)
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel as string)
    || typeof value.instructions !== "string" || Buffer.byteLength(value.instructions) > 256 * 1024
    || !Array.isArray(value.tools) || value.tools.length > 128
    || (value.homeDigest !== undefined && !isDigest(value.homeDigest))
    || (value.toolSocketPath !== undefined && !validSocketPath(value.toolSocketPath))) return false;
  const names = new Set<string>();
  return value.tools.every(tool => {
    if (!object(tool) || !text(tool.name, 128) || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/u.test(tool.name)
      || !text(tool.description, 8192) || !object(tool.inputSchema) || tool.inputSchema.type !== "object" || names.has(tool.name)) return false;
    names.add(tool.name); return true;
  });
}
function validProvider(value: unknown, model: string): value is PiBindProvider {
  if (!object(value) || !text(value.name, 128) || !/^[a-zA-Z0-9_-]+$/u.test(value.name)
    || !["openai-completions", "anthropic-messages", "openai-responses"].includes(value.api as string)
    || !text(value.apiKey, 4096) || /[$!]/u.test(value.apiKey) || !text(value.baseUrl, 2048)
    || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > 64) return false;
  try {
    const url = new URL(value.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) return false;
  } catch { return false; }
  const allowed = new Set(["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap", "compat"]);
  const ids = new Set<string>();
  for (const entry of value.models) {
    if (!object(entry) || !text(entry.id, 512) || ids.has(entry.id) || Object.keys(entry).some(key => !allowed.has(key))
      || (entry.name !== undefined && !text(entry.name, 512))
      || (entry.reasoning !== undefined && typeof entry.reasoning !== "boolean")
      || (entry.input !== undefined && (!Array.isArray(entry.input) || !entry.input.length || entry.input.some(item => item !== "text" && item !== "image")))
      || (entry.contextWindow !== undefined && !integer(entry.contextWindow, 1)) || (entry.maxTokens !== undefined && !integer(entry.maxTokens, 1))) return false;
    if (Object.hasOwn(entry, "compat") && !isPiModelCompat(entry.compat)) return false;
    if (entry.cost !== undefined) {
      const cost = entry.cost;
      if (!object(cost) || ["input", "output", "cacheRead", "cacheWrite"].some(key => typeof cost[key] !== "number" || !Number.isFinite(cost[key]) || (cost[key] as number) < 0)) return false;
    }
    if (entry.thinkingLevelMap !== undefined && (!object(entry.thinkingLevelMap) || Object.entries(entry.thinkingLevelMap).some(([key, level]) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key) || (level !== null && !text(level, 128))))) return false;
    ids.add(entry.id);
  }
  return model.startsWith(`${value.name}/`) && ids.has(model.slice(value.name.length + 1));
}
export function validateBindRequest(value: unknown): value is BindRequest {
  return envelope(value) && value.type === "bind" && validateBindingConfig(value) && integer(value.expectedPriorEpoch)
    && value.epoch === value.expectedPriorEpoch + 1 && validProvider(value.provider, value.model);
}
export function validatePiBindCommand(value: unknown): value is PiBindCommand {
  if (!envelope(value)) return false;
  switch (value.type) {
    case "bind": return validateBindRequest(value);
    case "begin_turn": case "settle": return validateOrigin(value);
    case "announce": return validateOrigin(value.origin) && text(value.toolCallId, 1024);
    case "park_ready": case "stop_children": return true;
    default: return false;
  }
}
/** Hash only the exact managed instructions/tools, not the ephemeral provider capability. */
export function bindContent(config: Pick<PiBindingConfig, "instructions" | "tools">) {
  return { instructionHash: digest(config.instructions), instructionLength: Buffer.byteLength(config.instructions), toolRevision: digest(JSON.stringify(config.tools)) };
}
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function validateBindReceipt(value: unknown, request: PiBindCommand): value is PiBindReceipt {
  if (!envelope(value) || value.type !== request.type || value.nonce !== request.nonce || value.sessionId !== request.sessionId) return false;
  switch (request.type) {
    case "bind": {
      const content = bindContent(request);
      return value.epoch === request.epoch && value.runId === request.runId && value.provider === request.provider.name
        && value.model === request.model && value.thinkingLevel === request.thinkingLevel
        && value.instructionHash === content.instructionHash && value.instructionLength === content.instructionLength && value.toolRevision === content.toolRevision
        && (value.homeDigest === undefined || isDigest(value.homeDigest)) && (request.homeDigest === undefined || value.homeDigest === request.homeDigest);
    }
    case "begin_turn": case "settle": return value.ack === true && validateOrigin(value) && sameOrigin(value, request);
    case "announce": return value.ack === true && value.toolCallId === request.toolCallId && validateOrigin(value.origin) && sameOrigin(value.origin, request.origin);
    case "park_ready": return typeof value.ready === "boolean" && stringList(value.reasons) && (!value.ready || value.reasons.length === 0);
    case "stop_children": return stringList(value.settled) && stringList(value.uncertain);
  }
}
export function stringList(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 128 && value.every(item => text(item, 256)); }
export function validSocketPath(value: unknown): value is string { return typeof value === "string" && value.startsWith("/") && Buffer.byteLength(value) <= 103 && !value.includes("\0"); }
export function validatePiToolCallRequest(value: unknown): value is PiToolCallRequest {
  return envelope(value) && value.type === "tool_call" && validateOrigin(value.origin) && text(value.toolCallId, 1024) && text(value.tool, 128) && Object.hasOwn(value, "arguments");
}
export function validatePiToolResult(value: unknown): value is PiToolResult {
  return object(value) && Array.isArray(value.content) && value.content.length <= 128
    && value.content.every(block => object(block) && block.type === "text" && typeof block.text === "string")
    && Object.hasOwn(value, "details") && (value.isError === undefined || typeof value.isError === "boolean");
}
export function validatePiToolCallReceipt(value: unknown, request: PiToolCallRequest): value is PiToolCallReceipt {
  return envelope(value) && value.type === "tool_result" && value.nonce === request.nonce && value.sessionId === request.sessionId
    && value.toolCallId === request.toolCallId && validateOrigin(value.origin) && sameOrigin(value.origin, request.origin) && validatePiToolResult(value.result);
}

/** Exactly one request/receipt per connection. No retry: a lost ACK is not permission to prompt. */
export async function sendPiBindRequest<C extends PiBindCommand>(socketPath: string, request: C, options: PiPrivateRequestOptions = {}): Promise<PiBindResponse<C>> {
  if (!validatePiBindCommand(request)) throw new Error("Pi private request rejected");
  const response = await exchange(socketPath, request, options);
  if (!validateBindReceipt(response, request)) throw new Error("Pi private receipt mismatch");
  return response as PiBindResponse<C>;
}
export async function sendPiToolRequest(socketPath: string, request: PiToolCallRequest, options: PiPrivateRequestOptions = {}): Promise<PiToolResult> {
  if (!validatePiToolCallRequest(request)) throw new Error(PI_BIND_ERROR);
  const response = await exchange(socketPath, request, options);
  if (!validatePiToolCallReceipt(response, request)) throw new Error("Pi tool receipt mismatch");
  return response.result;
}
async function exchange(socketPath: string, request: unknown, options: PiPrivateRequestOptions): Promise<unknown> {
  if (!validSocketPath(socketPath)) throw new Error(PI_BIND_ERROR);
  const frame = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(frame) > PI_BIND_MAX_FRAME_BYTES) throw new Error("Pi private frame too large");
  const timeoutMs = options.timeoutMs ?? PI_BIND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Invalid Pi private deadline");
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let buffer = Buffer.alloc(0); let done = false;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error("Pi private request aborted"));
    const timer = setTimeout(() => finish(new Error("Pi private request timed out")), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () => finish(new Error("Pi private channel failed")));
    socket.once("close", () => finish(new Error("Pi private channel closed before receipt")));
    socket.on("data", (chunk: Buffer) => {
      if (buffer.length + chunk.length > PI_BIND_MAX_FRAME_BYTES) { finish(new Error("Pi private frame too large")); return; }
      buffer = Buffer.concat([buffer, chunk]); const newline = buffer.indexOf(10); if (newline < 0) return;
      try {
        if (newline !== buffer.length - 1) throw new Error();
        const value: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (object(value) && Object.hasOwn(value, "error")) { finish(new Error(PI_BIND_ERROR)); return; }
        finish(undefined, value);
      } catch { finish(new Error("Pi private receipt malformed")); }
    });
    socket.once("connect", () => socket.write(frame));
  });
}

/** Session-scoped gate. Retain call-ID tombstones; exhaustion fences rather than evicts. */
export class RunAuthority {
  #binding: Readonly<{ epoch: number; runId: string }> | null = null;
  #active: Readonly<Origin> | null = null;
  #announced = new Set<string>();
  #seen = new Set<string>();
  #consumed = new Set<string>();
  #turnAbort: AbortController | null = null;
  #used = false;
  #epoch = 0;
  readonly #maximumCalls: number;
  constructor(maximumCalls = 8192) {
    if (!Number.isSafeInteger(maximumCalls) || maximumCalls < 1 || maximumCalls > 65536) throw new Error(PI_BIND_ERROR);
    this.#maximumCalls = maximumCalls;
  }
  get epoch(): number { return this.#epoch; }
  bind(origin: { epoch: number; runId: string }): void {
    if (!integer(origin.epoch, 1) || origin.epoch <= this.#epoch || !text(origin.runId, 256) || this.#active) throw new Error(PI_BIND_ERROR);
    this.#epoch = origin.epoch; this.#binding = Object.freeze({ epoch: origin.epoch, runId: origin.runId }); this.#used = false;
  }
  beginTurn(origin: Origin): Readonly<Origin> {
    if (!validateOrigin(origin) || !this.#binding || this.#active || this.#used || origin.epoch !== this.#binding.epoch || origin.runId !== this.#binding.runId) throw new Error(PI_BIND_ERROR);
    this.#used = true; this.#active = Object.freeze({ epoch: origin.epoch, runId: origin.runId, turnId: origin.turnId }); this.#turnAbort = new AbortController(); this.#announced.clear(); return this.#active;
  }
  capture(): Readonly<Origin> | null { return this.#active; }
  announce(toolCallId: string, origin: Origin): boolean {
    if (!text(toolCallId, 1024) || !this.accept(origin)) return false;
    if (this.#announced.has(toolCallId)) return true;
    if (this.#seen.has(toolCallId)) return false;
    if (this.#seen.size >= this.#maximumCalls) { this.end(); return false; }
    this.#seen.add(toolCallId); this.#announced.add(toolCallId); return true;
  }
  accept(origin: Origin, toolCallId?: string): boolean {
    return !!this.#active && sameOrigin(this.#active, origin) && (toolCallId === undefined || this.#announced.has(toolCallId));
  }
  consume(origin: Origin, toolCallId: string): boolean {
    if (!this.accept(origin, toolCallId) || this.#consumed.has(toolCallId)) return false;
    this.#consumed.add(toolCallId); return true;
  }
  signalFor(origin: Origin): AbortSignal | null { return this.accept(origin) ? this.#turnAbort?.signal ?? null : null; }
  settle(origin: Origin): boolean { if (!this.accept(origin)) return false; this.end(); return true; }
  end(): void { this.#active = null; this.#binding = null; this.#announced.clear(); this.#turnAbort?.abort(); this.#turnAbort = null; }
}
/** Shared actual semantic dispatch boundary, for both the extension and host callback server.
 * No tool-name bypasses (including built-ins): effects require an announced, unused ID.
 * Handlers must honor signal before performing an effect; settlement aborts it.
 */
export async function dispatchPiToolCall(
  authority: RunAuthority,
  request: PiToolCallRequest,
  handler: (request: PiToolCallRequest, signal: AbortSignal) => Promise<PiToolResult>,
  options: PiPrivateRequestOptions = {},
): Promise<PiToolResult> {
  if (!validatePiToolCallRequest(request) || !authority.consume(request.origin, request.toolCallId)) throw new Error("Pi tool callback refused");
  const origin = Object.freeze({ ...request.origin });
  let captured: PiToolCallRequest;
  try { captured = Object.freeze({ ...request, origin, arguments: structuredClone(request.arguments) }); }
  catch { throw new Error("Pi tool callback refused"); }
  const originSignal = authority.signalFor(origin);
  if (!originSignal) throw new Error("Pi tool callback refused");
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Pi tool callback refused");
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, originSignal, ...(options.signal ? [options.signal] : [])]);
  let rejectAbort: (() => void) | undefined;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal.throwIfAborted();
    const result = await Promise.race([
      Promise.resolve().then(() => { signal.throwIfAborted(); return handler(captured, signal); }),
      new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("Pi tool callback refused")); signal.addEventListener("abort", rejectAbort, { once: true }); }),
    ]);
    signal.throwIfAborted();
    if (!authority.accept(origin, captured.toolCallId) || !validatePiToolResult(result) || Buffer.byteLength(JSON.stringify(result)) > PI_BIND_MAX_FRAME_BYTES / 2) throw new Error();
    return result;
  } catch { throw new Error("Pi tool callback refused"); }
  finally { clearTimeout(timer); if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
}
export function guardCallback(authority: RunAuthority, capturedOrigin: Origin, toolCallId: string | undefined, diagnose: (message: string) => void): boolean {
  if (authority.accept(capturedOrigin, toolCallId)) return true;
  diagnose("Pi callback refused: stale run or unannounced tool call"); return false;
}
