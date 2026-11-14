import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSubagentLifecycle, registerSubagentBridge, type SubagentEventBus } from "./subagents/index.js";
import { installSubagentSeam, installUnboundChildParent } from "./subagents/seam.js";
import { piManagedModelRegistration } from "../pi-managed-model.js";
import { isPiThinkingLevelAtMost } from "../pi-native-config.js";
import { installPiPerformanceDiagnostics } from "../pi-performance-diagnostics.js";
import { PI_TOOL_LIMIT_ENTRY, piToolLimitMessage } from "../pi-tool-limit-diagnostics.js";
import {
  PI_BIND_ERROR, PI_BIND_MAX_FRAME_BYTES, PI_BIND_TIMEOUT_MS, PI_DYNAMIC_TOOL_LIMIT_BY_API, RunAuthority, bindContent, digest, dispatchPiToolCall,
  isDigest, sendPiToolRequest, stringList, validSocketPath, validateBindingConfig, validateOrigin,
  validatePiBindCommand, validatePiToolResult,
  type BindReceipt, type Origin, type ParkReadyResult, type PiBindCommand, type PiBindingConfig,
  type PiBindProvider, type PiBindReceipt, type PiDynamicTool, type PiThinkingLevel,
  type PiToolCallRequest, type PiToolResult, type StopChildrenResult,
} from "../pi-bind-protocol.js";
export type { Origin, ParkReadyResult, StopChildrenResult, PiToolCallRequest, PiToolResult } from "../pi-bind-protocol.js";

/** Structural subset of Pi 1.5.2's public extension API: no runtime SDK dependency.
 * Opaque foreign model handles are passed registry -> setModel without reconstruction.
 */
export interface PiBindContext {
  sessionManager: { getSessionId(): string };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  model?: { provider: string; id: string; api?: PiBindProvider["api"] };
  modelRegistry?: { find(provider: string, id: string): any };
}
export interface PiBindTool {
  name: string; label: string; description: string; parameters: Record<string, unknown>;
  exposure: "direct" | "hidden";
  execute(toolCallId: string, args: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiBindContext): Promise<PiToolResult>;
}
type LifecycleHandler = (event: any, ctx: PiBindContext) => any;
export interface PiBindApi {
  events?: SubagentEventBus;
  on(event: "session_start", handler: LifecycleHandler): () => void;
  on(event: "session_shutdown", handler: LifecycleHandler): () => void;
  on(event: "input", handler: LifecycleHandler): () => void;
  on(event: "before_agent_start", handler: LifecycleHandler): () => void;
  on(event: "before_provider_request", handler: LifecycleHandler): () => void;
  /** Present in Pi 1.5.2; optional for older structural host fixtures. */
  appendEntry?(customType: string, data: unknown): void;
  on(event: "cache_warming_decision", handler: LifecycleHandler): () => void;
  on(event: "tool_execution_start", handler: LifecycleHandler): () => void;
  on(event: "tool_execution_end", handler: LifecycleHandler): () => void;
  on(event: "ui_prompt_start", handler: LifecycleHandler): () => void;
  on(event: "ui_prompt_end", handler: LifecycleHandler): () => void;
  on(event: "agent_settled", handler: LifecycleHandler): () => void;
  registerTool(tool: PiBindTool): void;
  registerProvider(name: string, config: {
    api: PiBindProvider["api"]; baseUrl: string; apiKey: string; authHeader: boolean;
    models: Array<{ id: string; name: string; reasoning: boolean; input: Array<"text" | "image">; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number; thinkingLevelMap?: PiBindProvider["models"][number]["thinkingLevelMap"] }>;
  }): void;
  unregisterProvider(name: string): void;
  getActiveTools(): string[];
  getAllTools?(): Array<{ name: string }>;
  setActiveTools(names: string[]): void;
  setModel?(model: any): Promise<boolean>;
  setThinkingLevel?(level: PiThinkingLevel): void;
  getThinkingLevel?(): PiThinkingLevel;
}
export interface PiBindInitial extends PiBindingConfig { schema: 1; sessionId: string; turnId?: string }
export interface HomeAdmissionInput { sessionId: string; epoch: number; runId: string; signal: AbortSignal }
export type HomeAdmission = (input: HomeAdmissionInput) => { digest: string } | Promise<{ digest: string }>;
export type ParkReadyContributor = (signal: AbortSignal) => ParkReadyResult | Promise<ParkReadyResult>;
export type StopChildren = (signal: AbortSignal) => StopChildrenResult | Promise<StopChildrenResult>;
export interface PiBindHooks {
  admitHome?: (input: HomeAdmissionInput) => { homeDigest: string } | Promise<{ homeDigest: string }>;
  dispatchTool?: (request: PiToolCallRequest, signal: AbortSignal) => Promise<PiToolResult>;
}
export interface PiBindOptions { socketPath: string; initial: PiBindInitial; hooks?: PiBindHooks; timeoutMs?: number }

export function piHostInstructionSegment(instructions: string, boundary: string): string {
  return `<!-- ${boundary}:start -->\n${instructions}\n<!-- ${boundary}:end -->`;
}

/** Replace only the host-owned CLI append, keeping native AGENTS/home context. */
export function replacePiHostInstructions(prompt: string, instructions: string, boundary?: string): string {
  if (!boundary) return instructions ? `${prompt}\n\n${instructions}` : prompt;
  const start = `<!-- ${boundary}:start -->`, end = `<!-- ${boundary}:end -->`;
  const first = prompt.indexOf(start), last = prompt.lastIndexOf(end);
  if (first < 0 || last < first) throw new Error("Pi host instruction segment unavailable");
  return prompt.slice(0, first) + piHostInstructionSegment(instructions, boundary) + prompt.slice(last + end.length);
}

const homeAdmissions = new Set<HomeAdmission>();
const parkContributors = new Set<ParkReadyContributor>();
const stopChildrenHooks = new Set<StopChildren>();
const hookRegistrations = new Set<PiBindHooks>();
function register<T>(set: Set<T>, fn: T): () => void {
  if (set.size >= 32) throw new Error(PI_BIND_ERROR);
  set.add(fn); return () => { set.delete(fn); };
}
export function registerHomeAdmission(fn: HomeAdmission): () => void { return register(homeAdmissions, fn); }
export function registerParkReadyContributor(fn: ParkReadyContributor): () => void { return register(parkContributors, fn); }
export function registerStopChildren(fn: StopChildren): () => void { return register(stopChildrenHooks, fn); }
export function configurePiBindHooks(hooks: PiBindHooks): () => void { return register(hookRegistrations, hooks); }
let active: { authority: RunAuthority } | null = null;
/** Origin MUST be captured at the originating execution start, never at callback arrival. */
export function announce(toolCallId: string, origin: Readonly<Origin>): boolean {
  return validateOrigin(origin) && (active?.authority.announce(toolCallId, origin) ?? false);
}
export function captureOrigin(): Readonly<Origin> | null { return active?.authority.capture() ?? null; }
export function authorizeCallback(origin: Readonly<Origin>, toolCallId?: string): boolean {
  return validateOrigin(origin) && (active?.authority.accept(origin, toolCallId) ?? false);
}

/** The initial provider is deliberately NOT registered here: models.json + the first
 * broker already exist before Pi starts. INITIAL is nonsecret authority/config only.
 * Broker teardown/revocation on every settled turn is the driver's responsibility.
 */
export function installPiBindExtension(pi: PiBindApi, options: PiBindOptions) {
  if (!validSocketPath(options.socketPath) || !options.initial || options.initial.schema !== 1
    || !validatePiBindCommand({ schema: 1, type: "park_ready", nonce: "bootstrap", sessionId: options.initial.sessionId })
    || Object.hasOwn(options.initial, "provider") || Object.hasOwn(options.initial, "apiKey") || !validateBindingConfig(options.initial)
    || (options.initial.turnId !== undefined && !validateOrigin(options.initial))) throw new Error(PI_BIND_ERROR);
  const timeoutMs = options.timeoutMs ?? PI_BIND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error(PI_BIND_ERROR);
  const authority = new RunAuthority();
  const publicState = { authority };
  let ctx: PiBindContext | undefined, sessionId = "", server: Server | undefined;
  let socketInode: number | undefined, starting: Promise<void> | undefined, closing: Promise<void> | undefined;
  let config: PiBindingConfig = structuredClone(options.initial);
  let prepared: Readonly<Origin> | null = null, admitted: Readonly<Origin> | null = null, running: Readonly<Origin> | null = null;
  let commandBusy = false, closed = false, failed = false, fenceVersion = 0;
  let offUnboundParent: (() => void) | undefined;
  let pendingDialogs = 0;
  let registeredProvider: string | undefined;
  let providerApi: PiBindProvider["api"] | undefined;
  const registeredTools = new Map<string, PiDynamicTool>();
  const pendingTools = new Set<string>();
  const sockets = new Set<Socket>();
  const aborters = new Map<AbortController, boolean>();
  // Only the latest lifecycle transaction is retryable. Queries/announcements never evict it.
  let lastTransaction: { nonce: string; fingerprint: string; receipt: PiBindReceipt } | undefined;
  function hooks(): PiBindHooks[] { return [...hookRegistrations, ...(options.hooks ? [options.hooks] : [])]; }
  function fence() {
    ++fenceVersion;
    authority.end(); prepared = admitted = running = null;
    lastTransaction = undefined;
    for (const [aborter, fenceBound] of aborters) if (fenceBound) aborter.abort();
    if (registeredProvider) {
      const provider = registeredProvider; registeredProvider = undefined;
      try { pi.unregisterProvider(provider); } catch { failed = true; }
    }
  }
  function mustIdle() { if (!ctx || !ctx.isIdle() || ctx.hasPendingMessages() || pendingTools.size || pendingDialogs || running || admitted) throw new Error(PI_BIND_ERROR); }
  async function deadline<T>(operation: (signal: AbortSignal) => Promise<T> | T, external?: AbortSignal, ms = timeoutMs, fenceBound = true): Promise<T> {
    const controller = new AbortController(); aborters.set(controller, fenceBound);
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }),
        new Promise<never>((_, reject) => {
          cancel = () => reject(new Error(PI_BIND_ERROR));
          signal.addEventListener("abort", cancel, { once: true });
          timer = setTimeout(() => { controller.abort(); reject(new Error(PI_BIND_ERROR)); }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) signal.removeEventListener("abort", cancel);
      aborters.delete(controller);
    }
  }
  async function admitHome(candidate: PiBindingConfig): Promise<string | undefined> {
    const homeHooks = [...homeAdmissions];
    const configured = hooks().flatMap(hook => hook.admitHome ? [hook.admitHome] : []);
    if (candidate.homeDigest && !homeHooks.length && !configured.length) throw new Error(PI_BIND_ERROR);
    const results: string[] = [];
    const until = Date.now() + timeoutMs;
    for (const home of homeHooks) {
      const result = await deadline(signal => home({ sessionId, epoch: candidate.epoch, runId: candidate.runId, signal }), undefined, Math.max(1, until - Date.now()));
      if (!result || !isDigest(result.digest)) throw new Error(PI_BIND_ERROR); results.push(result.digest);
    }
    for (const home of configured) {
      if (Date.now() >= until) throw new Error(PI_BIND_ERROR);
      const result = await deadline(signal => home({ sessionId, epoch: candidate.epoch, runId: candidate.runId, signal }), undefined, Math.max(1, until - Date.now()));
      if (!result || !isDigest(result.homeDigest)) throw new Error(PI_BIND_ERROR); results.push(result.homeDigest);
    }
    if (results.some(value => value !== results[0]) || (candidate.homeDigest && results[0] !== candidate.homeDigest)) throw new Error(PI_BIND_ERROR);
    return results[0];
  }
  function nativeTools(): string[] { return pi.getActiveTools().filter(name => !registeredTools.has(name)); }
  function updateTools(candidate: PiBindingConfig, api?: PiBindProvider["api"]) {
    const wanted = new Map(candidate.tools.map(tool => [tool.name, tool]));
    const allNames = new Set([...registeredTools.keys(), ...wanted.keys()]);
    // No external 256-name registration limit: Pi 1.5.2 docs/extensions.md
    // (pi.registerTool) supports dynamic registration; loader.js stores tools in
    // a Map. This was our own undocumented count guard (acb1858cef), not an API
    // constraint. Keep the existing bounded private frames, not a guessed cap.
    const native = nativeTools().filter(name => !wanted.has(name));
    const cap = api === undefined ? undefined : PI_DYNAMIC_TOOL_LIMIT_BY_API[api];
    if (cap !== undefined && native.length + wanted.size > cap) throw new Error(`Pi ${api} total tool cap ${cap} exceeded: ${native.length} active native/extension + ${wanted.size} dynamic tools`);
    for (const name of allNames) {
      const definition = wanted.get(name) ?? registeredTools.get(name)!;
      const capturedBinding = Object.freeze({ epoch: candidate.epoch, runId: candidate.runId });
      pi.registerTool({
        name, label: name, description: definition.description, parameters: definition.inputSchema,
        exposure: wanted.has(name) ? "direct" : "hidden",
        async execute(toolCallId, args, signal) {
          // The execution-start snapshot is immutable and belongs to THIS closure's binding.
          const origin = running;
          if (!origin || origin.epoch !== capturedBinding.epoch || origin.runId !== capturedBinding.runId
            || !wanted.has(name) || !authority.accept(origin, toolCallId)) throw new Error("Pi tool callback refused");
          const call: PiToolCallRequest = { schema: 1, type: "tool_call", nonce: randomUUID(), sessionId, origin, toolCallId, tool: name, arguments: args };
          const dispatch = hooks().map(hook => hook.dispatchTool).filter(Boolean).at(-1);
          try {
            const result = await dispatchPiToolCall(authority, call, (captured, innerSignal) => dispatch ? dispatch(captured, innerSignal)
              : candidate.toolSocketPath ? sendPiToolRequest(candidate.toolSocketPath, captured, { signal: innerSignal, timeoutMs: 60000 })
                : Promise.reject(new Error(PI_BIND_ERROR)), { signal, timeoutMs: 60000 });
            if (!authority.accept(origin, toolCallId) || !validatePiToolResult(result) || Buffer.byteLength(JSON.stringify(result)) > PI_BIND_MAX_FRAME_BYTES / 2) throw new Error(PI_BIND_ERROR);
            return result;
          } catch { throw new Error("Pi tool callback refused"); }
        },
      });
      registeredTools.set(name, definition);
    }
    pi.setActiveTools([...native, ...wanted.keys()]);
  }
  async function registerProvider(candidate: Extract<PiBindCommand, { type: "bind" }>) {
    const provider = candidate.provider;
    if (registeredProvider) pi.unregisterProvider(registeredProvider);
    pi.registerProvider(provider.name, {
      api: provider.api, apiKey: provider.apiKey, baseUrl: provider.baseUrl, authHeader: true,
      models: provider.models.map(piManagedModelRegistration),
    });
    registeredProvider = provider.name;
    const id = candidate.model.slice(provider.name.length + 1);
    if (pi.setModel && ctx?.modelRegistry) {
      const model = ctx.modelRegistry.find(provider.name, id);
      if (!model || !await deadline(() => pi.setModel!(model))) throw new Error(PI_BIND_ERROR);
    } else if (ctx?.model?.provider !== provider.name || ctx.model.id !== id) throw new Error(PI_BIND_ERROR);
    pi.setThinkingLevel?.(candidate.thinkingLevel);
    if (pi.getThinkingLevel && !isPiThinkingLevelAtMost(pi.getThinkingLevel(), candidate.thinkingLevel)) throw new Error(PI_BIND_ERROR);
  }
  async function parkReady(): Promise<ParkReadyResult> {
    const reasons: string[] = [];
    if (failed || closed) reasons.push("binding unavailable");
    if (authority.capture() || running || admitted || prepared || !ctx?.isIdle()) reasons.push("driver not settled");
    if (pendingTools.size) reasons.push("pending tools");
    if (pendingDialogs) reasons.push("pending dialogs");
    if (ctx?.hasPendingMessages()) reasons.push("queued input");
    const until = Date.now() + timeoutMs;
    for (const contributor of parkContributors) {
      try {
        if (Date.now() >= until) throw new Error();
        const result = await deadline(contributor, undefined, Math.max(1, until - Date.now()));
        if (!result || typeof result.ready !== "boolean" || !stringList(result.reasons) || (result.ready && result.reasons.length)) throw new Error();
        if (!result.ready) reasons.push(...(result.reasons.length ? result.reasons : ["park contributor not ready"]));
      } catch { reasons.push("park contributor unavailable"); }
    }
    return { ready: reasons.length === 0, reasons: [...new Set(reasons)].slice(0, 128) };
  }
  async function stopChildren(): Promise<StopChildrenResult> {
    const settled: string[] = [], uncertain: string[] = [];
    const until = Date.now() + timeoutMs;
    for (const stop of stopChildrenHooks) {
      try {
        if (Date.now() >= until) throw new Error();
        // Parent settlement revokes turn authority, but must not cancel the Stop
        // barrier that is waiting for precisely that settlement and its children.
        const result = await deadline(stop, undefined, Math.max(1, until - Date.now()), false);
        if (!result || !stringList(result.settled) || !stringList(result.uncertain)) throw new Error();
        settled.push(...result.settled); uncertain.push(...result.uncertain);
      } catch { uncertain.push("stop hook unavailable"); }
    }
    if (settled.length > 128 || uncertain.length > 128) return { settled: [], uncertain: ["stop receipt overflow"] };
    const uncertainSet = new Set(uncertain);
    return { settled: [...new Set(settled)].filter(id => !uncertainSet.has(id)), uncertain: [...uncertainSet] };
  }
  async function dispatch(request: unknown): Promise<PiBindReceipt> {
    if (closed || !validatePiBindCommand(request) || request.sessionId !== sessionId) throw new Error(PI_BIND_ERROR);
    const envelope = { schema: 1 as const, type: request.type, nonce: request.nonce, sessionId };
    if (request.type === "announce") {
      if (!authority.announce(request.toolCallId, request.origin)) throw new Error(PI_BIND_ERROR);
      return { ...envelope, type: "announce", ack: true, toolCallId: request.toolCallId, origin: request.origin };
    }
    if (request.type === "tool_inventory") return { ...envelope, type: "tool_inventory", nativeTools: nativeTools() };
    if (request.type === "park_ready") return { ...envelope, type: "park_ready", ...await parkReady() };
    if (request.type === "stop_children") return { ...envelope, type: "stop_children", ...await stopChildren() };
    if (commandBusy) throw new Error(PI_BIND_ERROR);
    const fingerprint = digest(JSON.stringify(request));
    if (lastTransaction?.nonce === request.nonce) {
      if (lastTransaction.fingerprint !== fingerprint) throw new Error(PI_BIND_ERROR);
      return lastTransaction.receipt;
    }
    commandBusy = true;
    try {
      let receipt: PiBindReceipt;
      if (request.type === "bind") {
        mustIdle();
        if (authority.capture() || request.expectedPriorEpoch !== authority.epoch) throw new Error(PI_BIND_ERROR);
        // Never store the provider key in the persistent binding config or receipt.
        const candidate: PiBindingConfig = { epoch: request.epoch, runId: request.runId, model: request.model, thinkingLevel: request.thinkingLevel, instructions: request.instructions, tools: request.tools,
          ...(request.toolSocketPath ? { toolSocketPath: request.toolSocketPath } : {}), ...(request.homeDigest ? { homeDigest: request.homeDigest } : {}) };
        let homeDigest: string | undefined;
        const version = fenceVersion;
        try {
          homeDigest = await admitHome(candidate);
          if (closed || version !== fenceVersion) throw new Error(PI_BIND_ERROR);
          await registerProvider(request); updateTools(candidate, request.provider.api);
          providerApi = request.provider.api;
          if (closed || version !== fenceVersion) throw new Error(PI_BIND_ERROR);
          authority.bind(candidate); config = candidate; failed = false;
        } catch { fence(); failed = true; throw new Error(PI_BIND_ERROR); }
        receipt = { ...envelope, type: "bind", epoch: candidate.epoch, runId: candidate.runId, provider: request.provider.name,
          model: candidate.model, thinkingLevel: candidate.thinkingLevel, ...bindContent(candidate), ...(homeDigest ? { homeDigest } : {}) } satisfies BindReceipt;
      } else if (request.type === "begin_turn") {
        mustIdle(); if (failed) throw new Error(PI_BIND_ERROR);
        prepared = authority.beginTurn(request); admitted = running = null;
        receipt = { ...envelope, type: "begin_turn", ack: true, epoch: request.epoch, runId: request.runId, turnId: request.turnId };
      } else {
        if (!authority.settle(request)) throw new Error(PI_BIND_ERROR);
        fence();
        receipt = { ...envelope, type: "settle", ack: true, epoch: request.epoch, runId: request.runId, turnId: request.turnId };
      }
      lastTransaction = { nonce: request.nonce, fingerprint, receipt }; return receipt;
    } finally { commandBusy = false; }
  }
  async function start(context: PiBindContext) {
    if (closed || ctx) throw new Error(PI_BIND_ERROR);
    ctx = context; sessionId = options.initial.sessionId;
    if (!sessionId) throw new Error(PI_BIND_ERROR);
    const directory = dirname(options.socketPath);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && info.uid !== process.getuid()) || await realpath(directory) !== resolve(directory)) throw new Error(PI_BIND_ERROR);
    const version = fenceVersion;
    await admitHome(config);
    if (closed || version !== fenceVersion) throw new Error(PI_BIND_ERROR);
    updateTools(config); authority.bind(config);
    if (options.initial.turnId) prepared = authority.beginTurn({ epoch: config.epoch, runId: config.runId, turnId: options.initial.turnId });
    active = publicState;
    offUnboundParent = installUnboundChildParent({ capture: () => authority.capture(), accept: origin => !closed && authority.accept(origin) });
    server = createServer(socket => {
      socket.on("error", () => undefined);
      if (sockets.size >= 8 || closed) { socket.destroy(); return; }
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      let buffer = Buffer.alloc(0), handled = false;
      const timer = setTimeout(() => socket.destroy(), timeoutMs);
      socket.once("close", () => clearTimeout(timer));
      socket.on("data", (chunk: Buffer) => {
        if (handled) { socket.destroy(); return; }
        if (buffer.length + chunk.length > PI_BIND_MAX_FRAME_BYTES) { handled = true; socket.end(`${JSON.stringify({ error: PI_BIND_ERROR })}\n`); return; }
        buffer = Buffer.concat([buffer, chunk]); const newline = buffer.indexOf(10); if (newline < 0) return;
        handled = true; clearTimeout(timer);
        let request: unknown;
        try { if (newline !== buffer.length - 1) throw new Error(); request = JSON.parse(buffer.subarray(0, newline).toString("utf8")); }
        catch { socket.end(`${JSON.stringify({ error: PI_BIND_ERROR })}\n`); return; }
        void dispatch(request).then(response => socket.end(`${JSON.stringify(response)}\n`), () => socket.end(`${JSON.stringify({ error: PI_BIND_ERROR })}\n`));
      });
    });
    server.on("error", () => { failed = true; fence(); });
    await new Promise<void>((resolveListen, reject) => { server!.once("error", reject); server!.listen(options.socketPath, () => { server!.removeListener("error", reject); resolveListen(); }); });
    socketInode = (await lstat(options.socketPath)).ino;
    await chmod(options.socketPath, 0o600);
  }
  async function close() {
    if (closing) return closing;
    closed = true; fence();
    offUnboundParent?.();
    for (const aborter of aborters.keys()) aborter.abort();
    closing = (async () => {
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
      if (socketInode !== undefined) {
        try { if ((await lstat(options.socketPath)).ino === socketInode) await unlink(options.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (active === publicState) active = null;
    })();
    return closing;
  }
  pi.on("session_start", async (_event, context) => {
    starting = start(context);
    try { await starting; } catch { failed = true; await close(); throw new Error(PI_BIND_ERROR); }
  });
  pi.on("session_shutdown", close);
  pi.on("input", (event, context) => {
    if (event.source !== "rpc" || closed || failed) return { action: "handled" };
    // Native steer/follow_up input is already inside this admitted turn. Never
    // consume a prepared future origin or mint a new authority for queued input.
    if (running) return { action: authority.accept(running) ? "continue" : "handled" };
    if (!prepared || admitted || !authority.accept(prepared) || context.hasPendingMessages()) return { action: "handled" };
    admitted = prepared; prepared = null; return { action: "continue" };
  });
  pi.on("before_agent_start", (event, context) => {
    // Do NOT acquire current authority here. Consume only the immutable input-admitted snapshot.
    if (!admitted || !authority.accept(admitted) || running || closed || failed
      || `${context.model?.provider}/${context.model?.id}` !== config.model
      || (pi.getThinkingLevel && !isPiThinkingLevelAtMost(pi.getThinkingLevel(), config.thinkingLevel))) {
      fence(); context.abort(); throw new Error("Pi turn authority refused");
    }
    running = admitted; admitted = null;
    return { systemPrompt: replacePiHostInstructions(event.systemPrompt, config.instructions, process.env.PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY) };
  });
  // Recheck the actual serialized request too: another extension may have added
  // tools after startup inventory. Never trim here or silently lose authority.
  pi.on("before_provider_request", (event, context) => {
    const api = context.model?.api ?? providerApi;
    const cap = api === undefined ? undefined : PI_DYNAMIC_TOOL_LIMIT_BY_API[api];
    if (cap === undefined) return;
    const tools = event.payload?.tools;
    if (Array.isArray(tools) && tools.length > cap) {
      // Pi catches before_provider_request throws as extension_error and an
      // abort alone looks like user cancellation. Publish the owned bounded
      // cause on its supported custom-entry seam BEFORE revoking/aborting.
      try { pi.appendEntry?.(PI_TOOL_LIMIT_ENTRY, { origin: running, api, cap, toolCount: tools.length }); }
      finally { fence(); context.abort(); }
      throw new Error(piToolLimitMessage(tools.length));
    }
  });
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("tool_execution_start", event => {
    if (!running || !authority.announce(event.toolCallId, running)) return;
    pendingTools.add(event.toolCallId);
  });
  pi.on("tool_execution_end", event => { pendingTools.delete(event.toolCallId); });
  pi.on("ui_prompt_start", () => { pendingDialogs = Math.min(pendingDialogs + 1, 8192); });
  pi.on("ui_prompt_end", () => { pendingDialogs = Math.max(0, pendingDialogs - 1); });
  pi.on("agent_settled", () => { fence(); pendingTools.clear(); });
  return { authority, close, dispatch, ready: () => starting };
}

/** The driver admits the pack manifest; this realm rechecks the independently
 * loaded child factory before registering it. Never register a missing/tampered
 * sibling merely because it existed at build time. Source-mode tests have no pack.
 */
function verifyPiChildBridge(childBridgePath: string, hostExtensionUrl = import.meta.url): void {
  try {
    if (!lstatSync(childBridgePath).isFile()) throw new Error("not a regular file");
    if (hostExtensionUrl.endsWith(".ts")) return;
    const packRoot = resolve(dirname(fileURLToPath(hostExtensionUrl)), "../../../..");
    const manifest = JSON.parse(readFileSync(resolve(packRoot, "provider-pack.json"), "utf8"));
    const artifact = manifest?.payload?.artifacts?.piChildBridge;
    if (!artifact || typeof artifact.path !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)
      || resolve(packRoot, artifact.path) !== realpathSync(childBridgePath)) throw new Error("manifest entry mismatch");
    const actual = `sha256:${createHash("sha256").update(readFileSync(childBridgePath)).digest("hex")}`;
    if (actual !== artifact.sha256) throw new Error("sha256 mismatch");
  } catch (error) {
    throw new Error(`Pi child bridge integrity check failed: ${error instanceof Error ? error.message : "unavailable"}`);
  }
}

/** One exact owned layout, shared with the driver's startup-error attribution.
 * This is the same child artifact verified before composition, not home discovery. */
export function verifiedPiChildBridgePath(hostExtensionUrl = import.meta.url): string {
  const path = fileURLToPath(new URL(hostExtensionUrl.endsWith(".ts") ? "./subagents/child-bridge.ts" : "./child-bridge.js", hostExtensionUrl));
  verifyPiChildBridge(path, hostExtensionUrl);
  return realpathSync(path);
}

/** The CLI host extension loads before settings packages. Register this handler
 * before pi-subagents' session_start so its liveness provider is observable.
 * Both bundled registry copies use pi-subagents' process-global Symbol.for key.
 */
export function installPiSubagentComposition(
  pi: PiBindApi,
  childBridgePath = verifiedPiChildBridgePath(),
) {
  if (!pi.events) throw new Error("Pi subagent event bus unavailable");
  verifyPiChildBridge(childBridgePath);
  const events = pi.events;
  const offSeam = installSubagentSeam({ announce, registerParkReadyContributor, registerStopChildren });
  let lifecycle: ReturnType<typeof createSubagentLifecycle> | undefined;
  let bridge: ReturnType<typeof registerSubagentBridge> | undefined;
  let disposed = false;
  const settled = new Set<(error?: Error) => void>();
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifecycle?.dispose(); bridge?.dispose(); offSeam();
    for (const finish of [...settled]) finish(new Error("Pi subagent lifecycle disposed"));
  }
  pi.on("agent_settled", () => { for (const finish of [...settled]) finish(); });
  pi.on("session_start", (_event, context) => {
    try {
      if (disposed || lifecycle) throw new Error("Pi subagent lifecycle already started");
      // Recheck at registration too: files may change after the factory loaded.
      verifyPiChildBridge(childBridgePath);
      const sessionId = context.sessionManager.getSessionId();
      const hasSubagentTool = pi.getAllTools ? () => pi.getAllTools!().some(tool => tool.name === "subagent") : undefined;
      lifecycle = createSubagentLifecycle({ sessionId, events, hasSubagentTool, abortParent: async signal => {
        // ctx.abort() is a public void API. Observe agent_settled rather than
        // mistaking that fire-and-forget call for completed parent settlement.
        signal.throwIfAborted();
        let finish!: (error?: Error) => void;
        const completion = new Promise<void>((resolveDone, reject) => {
          finish = error => { settled.delete(finish); error ? reject(error) : resolveDone(); };
        });
        const canceled = () => finish(new Error("Pi parent abort not settled"));
        settled.add(finish); signal.addEventListener("abort", canceled, { once: true });
        try {
          context.abort();
          if (context.isIdle()) finish();
          await completion;
        } finally { settled.delete(finish); signal.removeEventListener("abort", canceled); }
      } });
      bridge = registerSubagentBridge({ sessionId, childBridgePath });
    } catch (error) { dispose(); context.abort(); throw error; }
  });
  pi.on("session_shutdown", dispose); // also emitted for Pi extension reload
  return { dispose };
}

/** File bootstrap avoids the OS per-environment-string limit. The legacy inline
 * value remains readable for older hosts; a selected file never falls back. */
export function readPiBindInitial(environment: NodeJS.ProcessEnv): PiBindInitial | undefined {
  const path = environment.PAPERCLIP_PI_BIND_INITIAL_FILE;
  let json: string | undefined;
  try { json = path ? readFileSync(path, "utf8") : environment.PAPERCLIP_PI_BIND_INITIAL; }
  catch { throw new Error(PI_BIND_ERROR); }
  if (json === undefined) return undefined;
  if (Buffer.byteLength(json) > PI_BIND_MAX_FRAME_BYTES) throw new Error(PI_BIND_ERROR);
  try { return JSON.parse(json) as PiBindInitial; } catch { throw new Error(PI_BIND_ERROR); }
}

export default function paperclipPiBindExtension(pi: PiBindApi): void {
  installPiPerformanceDiagnostics(pi);
  const socketPath = process.env.PAPERCLIP_PI_BIND_SOCKET;
  const initial = readPiBindInitial(process.env);
  if (!socketPath && initial === undefined) {
    // Native/custom providers still load the host prompt refresher independently
    // of broker routing. This does not grant managed callback/broker authority.
    const path = process.env.PAPERCLIP_PI_INSTRUCTIONS_FILE;
    const boundary = process.env.PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY;
    if (!path || !boundary) throw new Error(PI_BIND_ERROR);
    installPiSubagentComposition(pi);
    pi.on("before_agent_start", event => {
      const segment = readFileSync(path, "utf8");
      const start = `<!-- ${boundary}:start -->\n`, end = `\n<!-- ${boundary}:end -->`;
      if (!segment.startsWith(start) || !segment.endsWith(end)) throw new Error(PI_BIND_ERROR);
      return { systemPrompt: replacePiHostInstructions(event.systemPrompt, segment.slice(start.length, -end.length), boundary) };
    });
    return;
  }
  if (!socketPath || !initial) throw new Error(PI_BIND_ERROR);
  const composition = installPiSubagentComposition(pi);
  try { installPiBindExtension(pi, { socketPath, initial }); }
  catch (error) { composition.dispose(); throw error; }
}
