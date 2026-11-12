import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { directPiProviderConfiguration, startPiProviderLoopback, usesPiProviderLoopback } from "../acpx/pi-provider-loopback.js";
import { writePrivateFile } from "../private-file.js";
import { mergedPiModelsJson } from "./pi-models-merge.js";
import { createPiEventProjector, type PiEventOrigin } from "./pi-event-projector.js";
import { admitPiRpcSession, PiNativeAdmissionError, resolvePiNativeConfig, type PiNativeConfig, type PiNativeThinkingLevel, type PiRpcAdmissionPort } from "./pi-native-config.js";
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
  dynamicToolHandler?: (call: { tool: string; callId: string; threadId: string; runId: string; turnId: string; arguments: unknown }) => Promise<unknown>;
  systemInstructions?: string;
  runtimeContext?: unknown;
  permissionMode?: string;
  taskEnvelope?: unknown;
  conversationMode?: string;
  isolateProcessGroup?: boolean;
  /** Native selection. The existing proxy's piThinkingLevel is normalized here only. */
  piRpcThinkingLevel?: PiNativeThinkingLevel;
  piThinkingLevel?: string;
  commandFd?: number;
  commandLifecycle?: { beforeSpawn(): void; afterSpawn(): void; afterExit(): void };
  /** Pi executable, defaulting to `pi`. */
  command?: string;
  /** Explicit exact provider/model, required when opening a session. */
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
    const environment = { ...(this.#options.environment ?? {}) };
    const credentialMode = environment.PAPERCLIP_PI_RPC_CREDENTIAL_MODE ?? "broker";
    if (credentialMode !== "broker" && credentialMode !== "env") throw new Error("PAPERCLIP_PI_RPC_CREDENTIAL_MODE must be broker|env");
    delete environment.PAPERCLIP_PI_RPC_CREDENTIAL_MODE;
    const config = resolvePiNativeConfig({
      provider: "pi_rpc",
      model: this.#options.model,
      piRpcThinkingLevel: this.#options.piRpcThinkingLevel ?? this.#options.piThinkingLevel ?? environment.PAPERCLIP_PI_THINKING_LEVEL,
    });
    if (config.piRpcThinkingLevel === undefined) throw new PiNativeAdmissionError("pi_thinking_required", "Pi RPC requires an explicit thinking effort before admission.");
    let closeProvider: (() => Promise<void>) | undefined;
    if (this.#options.model && usesPiProviderLoopback(this.#options.model, environment)) {
      const agentHome = environment.PI_CODING_AGENT_DIR ?? join(directory, "agent");
      await mkdir(agentHome, { recursive: true, mode: 0o700 });
      environment.PI_CODING_AGENT_DIR = agentHome;
      if (credentialMode === "broker") {
        const provider = await startPiProviderLoopback({ model: this.#options.model, environment });
        closeProvider = provider.close;
        try {
          await writePrivateFile(join(agentHome, "models.json"), await mergedPiModelsJson(join(agentHome, "models.json"), provider.json));
        } catch (error) {
          await provider.close();
          throw error;
        }
        for (const key of Object.keys(environment)) if (key.startsWith("PAPERCLIP_AI_PROVIDER_")) delete environment[key];
      } else {
        const provider = directPiProviderConfiguration({ model: this.#options.model, environment });
        await writePrivateFile(join(agentHome, "models.json"), await mergedPiModelsJson(join(agentHome, "models.json"), provider.json));
        for (const key of Object.keys(environment)) if (key.startsWith("PAPERCLIP_AI_PROVIDER_")) delete environment[key];
        environment.PAPERCLIP_AI_PROVIDER_KEY = provider.key;
      }
    }
    const transportOptions: PiRpcTransportOptions = {
      command: this.#options.command ?? "pi",
      args,
      cwd,
      env: piProcessEnvironment(environment),
      commandFd: this.#options.commandFd,
      commandLifecycle: this.#options.commandLifecycle,
      shutdownTimeoutMs: this.#options.shutdownTimeoutMs,
      killTimeoutMs: this.#options.killTimeoutMs,
    };
    let transport: PiRpcTransport | undefined;
    try {
      transport = this.#options.transportFactory?.(transportOptions) ?? new PiRpcTransport(transportOptions);
      // --session loads an existing file too: no saved selection bypasses live
      // admission. The broker/models.json bootstrap above remains first.
      const identity = await admitPiRpcSession(piAdmissionPort(transport, this.#options.startupTimeoutMs), config, input.signal);
      return new PiRpcHarnessSession({
        transport,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        providerSessionId: identity.providerSessionId,
        sessionFile,
        config,
        systemInstructions: this.#options.systemInstructions,
        admissionTimeoutMs: this.#options.startupTimeoutMs,
        workingDirectory: cwd,
        runnerInstanceId: this.#options.runnerInstanceId ?? `paperclip-pi-${input.runId}`,
        now: this.#options.now ?? (() => new Date()),
        closeProvider,
      });
    } catch (error) {
      await transport?.close().catch(() => undefined);
      await closeProvider?.().catch(() => undefined);
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
  closeProvider?: () => Promise<void>;
  config: PiNativeConfig;
  systemInstructions?: string;
  admissionTimeoutMs?: number;
}

function piAdmissionPort(transport: PiRpcTransport, timeoutMs = 10_000): PiRpcAdmissionPort {
  return { request: async ({ type, ...params }, signal) => {
    const response = await withAbort(withTimeout(transport.request(type, params), timeoutMs, "Pi RPC admission timed out"), signal);
    return response.data;
  } };
}

interface PiTurnState extends PiEventOrigin {
  projector: ReturnType<typeof createPiEventProjector>;
  lastText: string;
  hasAssistantReceipt: boolean;
  failed: boolean;
  settled: boolean;
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
  #runId: string;
  readonly #normalizedSessionId: string;
  readonly #providerSessionId: string;
  readonly #sessionFile: string;
  readonly #workingDirectory: string;
  readonly #runnerInstanceId: string;
  readonly #now: () => Date;
  readonly #closeProvider?: () => Promise<void>;
  readonly #events = new EventQueue();
  #sourceSequence = 0;
  readonly #config: PiNativeConfig;
  readonly #configInstructions?: string;
  readonly #admissionTimeoutMs?: number;
  // Values retain the originating turn/projector after settlement and attach.
  // Ambiguous reused native identities are tombstoned, never rebound.
  readonly #owners = new Map<string, PiTurnState | null>();
  #operation: Promise<void> = Promise.resolve();
  #activeTurn: PiTurnState | null = null;
  #agentTurn: PiTurnState | null = null;
  #streamTurn: PiTurnState | null = null;
  #admitted = true;
  #failure: Error | null = null;
  #closed = false;

  constructor(state: PiSessionState) {
    this.#transport = state.transport;
    this.#runId = state.runId;
    this.#normalizedSessionId = state.normalizedSessionId;
    this.#providerSessionId = state.providerSessionId;
    this.#sessionFile = state.sessionFile;
    this.#workingDirectory = state.workingDirectory;
    this.#runnerInstanceId = state.runnerInstanceId;
    this.#now = state.now;
    this.#closeProvider = state.closeProvider;
    this.#config = state.config;
    this.#configInstructions = state.systemInstructions;
    this.#admissionTimeoutMs = state.admissionTimeoutMs;
    void this.#pump();
  }

  ids(): ReturnType<HarnessSession["ids"]> {
    return { driverSessionId: this.#providerSessionId, providerSessionId: this.#providerSessionId, displayId: this.#providerSessionId };
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  async attachRun(input: Parameters<NonNullable<HarnessSession["attachRun"]>>[0] & {
    signal?: AbortSignal;
    baseInstructions?: string;
    dynamicTools?: readonly Readonly<Record<string, unknown>>[];
    runtimeContext?: unknown;
  }): Promise<void> {
    return this.#serialize(async () => {
      if (!input.runId || input.runId.length > 240) throw new Error("Pi RPC attach requires a valid run id");
      // Per-run instruction/tool binding is a separate, receipt-gated layer.
      // Do not claim that this admission-only slice applied a changed context.
      if ((input.baseInstructions !== undefined && input.baseInstructions !== this.#configInstructions)
        || input.dynamicTools !== undefined || input.runtimeContext !== undefined) {
        throw new Error("Pi RPC run context refresh requires a provider bind receipt");
      }
      await this.#admit(input.signal);
      this.#runId = input.runId;
    });
  }

  /** Runner's post-claim hook; shared HarnessSession has no claim contract. */
  async revalidateAfterClaim(input: { signal?: AbortSignal } = {}): Promise<void> {
    return this.#serialize(() => this.#admit(input.signal));
  }

  /** Reconnected authority cannot spend a previous native acknowledgment. */
  async reconnect(input: { signal?: AbortSignal } = {}): Promise<void> {
    return this.#serialize(() => this.#admit(input.signal));
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #admit(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error("Pi RPC session is closed");
    if (this.#activeTurn) throw new PiNativeAdmissionError("pi_session_busy", "Pi session already has an active turn; refusing admission.");
    this.#admitted = false;
    const identity = await admitPiRpcSession(piAdmissionPort(this.#transport, this.#admissionTimeoutMs), this.#config, signal);
    if (identity.providerSessionId !== this.#providerSessionId) throw new PiNativeAdmissionError("pi_session_identity_changed", "Pi session identity changed during re-admission.");
    if (this.#closed || this.#failure) throw this.#failure ?? new Error("Pi RPC session is closed");
    this.#admitted = true;
  }

  async startTurn(input: Parameters<HarnessSession["startTurn"]>[0]): Promise<{ turnId: string }> {
    return this.#serialize(async () => {
      if (this.#closed) throw new Error("Pi RPC session is closed");
      if (this.#failure) throw this.#failure;
      if (!this.#admitted) throw new Error("Pi RPC session requires fresh admission before input");
      if (this.#activeTurn) throw new Error("Pi RPC session already has an active turn");
      const origin = { runId: this.#runId, turnId: `pi-turn-${randomUUID()}` };
      const turn: PiTurnState = { ...origin, projector: createPiEventProjector(origin), lastText: "", hasAssistantReceipt: false, failed: false, settled: false };
      this.#activeTurn = turn;
      this.#streamTurn = null;
      this.#emit("turn.started", { status: "inProgress" }, turn);
      try {
        const response = await this.#transport.request("prompt", { message: input.message.text });
        const disposition = stringValue(record(response.data).disposition);
        if (disposition !== "started") throw new Error(`Pi RPC prompt did not start an agent run (disposition=${disposition ?? "missing"})`);
      } catch (error) {
        this.#finishTurn(turn, "failed", { error: { code: "pi_prompt_rejected", message: error instanceof Error ? error.message : String(error), recoverable: false } });
        throw error;
      }
      return { turnId: turn.turnId };
    });
  }

  async interrupt(input: Parameters<NonNullable<HarnessSession["interrupt"]>>[0] = {}): Promise<void> {
    if (input.turnId && input.turnId !== this.#activeTurn?.turnId) return;
    if (!this.#activeTurn) return;
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
      activeTurnId: this.#activeTurn?.turnId ?? null,
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
      try { await this.#closeProvider?.(); }
      finally { this.#events.close(); }
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
        this.#failure = error instanceof Error ? error : new Error(String(error));
        this.#admitted = false;
        if (this.#activeTurn) this.#finishTurn(this.#activeTurn, "failed", { error: { code: "pi_rpc_transport_failed" } });
        this.#events.close(error instanceof Error ? error : new Error(String(error)));
        await this.close().catch(() => undefined);
      }
    }
  }

  #consume(event: PiRpcRecord): void {
    if (event.type === "process_exit" || event.type === "transport_error") {
      const code = event.type === "process_exit" ? "pi_process_exited" : "pi_rpc_transport_failed";
      this.#failure = new Error(code);
      this.#admitted = false;
      if (this.#activeTurn) this.#finishTurn(this.#activeTurn, "failed", { error: { code } });
      else this.#emit("session.failed", { code });
      this.#events.close();
      return;
    }
    if (event.type === "agent_start") {
      if (!this.#admitted || !this.#activeTurn || this.#agentTurn) {
        this.#failure = new Error("Pi started work without an admitted prompt");
        this.#admitted = false;
        this.#emit("session.failed", { code: "pi_unrequested_agent_start" });
        if (this.#activeTurn) this.#finishTurn(this.#activeTurn, "failed", { error: { code: "pi_unrequested_agent_start" } });
        void this.close().catch(() => undefined);
      } else this.#agentTurn = this.#activeTurn;
      return;
    }
    const keys = piRecordIdentityKeys(event);
    let turn: PiTurnState | null = null;
    let known = false;
    for (const key of keys) {
      if (!this.#owners.has(key)) continue;
      const owner = this.#owners.get(key)!;
      if (!owner || (turn && turn !== owner)) return; // ambiguous: never guess
      turn = owner;
      known = true;
    }
    if (event.type === "message_start" && record(event.message).role === "assistant") {
      // A new native message may be announced only within the prompt's captured
      // agent lifecycle. Later callbacks use this binding, not active run state.
      turn ??= keys.length > 0 && !known ? this.#agentTurn : null;
      if (!turn || turn.settled) return;
      this.#remember(keys, turn);
      this.#streamTurn = turn;
    } else if (!turn && keys.length === 0) {
      // Pi's actual RPC deltas have no message ID. Their sole valid owner is
      // the message_start stream scope, cleared at message_end/settlement.
      if (event.type === "message_update") turn = this.#streamTurn;
      else if (!["tool_execution_start", "tool_execution_update", "tool_execution_end", "message_end"].includes(String(event.type))) turn = this.#agentTurn;
    }
    if (!turn) return;
    this.#remember(keys, turn);
    const update = record(event.assistantMessageEvent);
    if (event.type === "message_update" && update.type === "text_delta" && typeof update.delta === "string") turn.lastText += update.delta;
    const message = record(event.message);
    if (event.type === "message_end" && message.role === "assistant") {
      const text = assistantText(message.content);
      if (text) turn.lastText = text;
      turn.hasAssistantReceipt ||= Boolean(text) || isRecord(message.usage);
      if (message.stopReason === "error" || message.stopReason === "aborted") turn.failed = true;
      if (this.#streamTurn === turn) this.#streamTurn = null;
      // Bind full native tool IDs before execution callbacks can arrive.
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (isRecord(part) && part.type === "toolCall") this.#remember(piToolIdentityKeys(part.id), turn);
      }
    }
    if (event.type === "message_update") {
      if (update.type === "toolcall_start") this.#remember(piToolIdentityKeys(update.id), turn);
      if (update.type === "toolcall_end") this.#remember(piToolIdentityKeys(record(update.toolCall).id), turn);
    }
    for (const mapped of turn.projector.project(event)) this.#emit(mapped.eventType, mapped.payload, mapped, mapped.itemId);
    if (event.type === "agent_settled") {
      const empty = !turn.lastText && !turn.hasAssistantReceipt;
      const status = event.aborted === true ? "cancelled" : turn.failed || empty ? "failed" : "completed";
      this.#finishTurn(turn, status, { piAgentSettled: true, ...(empty && status === "failed" ? { error: { code: "pi_empty_turn", message: "Pi settled without an assistant response." } } : {}) });
    }
  }

  #remember(keys: string[], turn: PiTurnState): void {
    for (const key of keys) {
      if (!this.#owners.has(key)) {
        if (this.#owners.size >= 4096) throw new Error("Pi RPC native identity limit exceeded");
        this.#owners.set(key, turn);
      } else if (this.#owners.get(key) !== turn) this.#owners.set(key, null);
    }
  }

  #finishTurn(turn: PiTurnState, status: "completed" | "failed" | "cancelled", extra: Record<string, unknown>): void {
    if (turn.settled) return;
    turn.settled = true;
    const eventType = status === "completed" ? "turn.completed" : status === "cancelled" ? "turn.cancelled" : "turn.failed";
    this.#emit(eventType, { status, ...extra }, turn);
    if (this.#activeTurn === turn) this.#activeTurn = null;
    if (this.#agentTurn === turn) this.#agentTurn = null;
    if (this.#streamTurn === turn) this.#streamTurn = null;
  }

  #emit(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, origin: { runId: string; turnId?: string } = { runId: this.#runId }, itemId?: string): void {
    const sourceSeq = ++this.#sourceSequence;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${origin.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: origin.runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(origin.turnId ? { turnId: origin.turnId } : {}),
      ...(itemId ? { itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "turn.failed" || eventType === "turn.cancelled" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    };
    if (!this.#events.push(event)) {
      this.#events.close(new Error("Pi RPC PRP event queue exceeded its limit"));
      void this.close().catch(() => undefined);
    }
  }
}

function piNativeIdentity(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 4096) return `s:${value}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `n:${value}`;
  return null;
}

function piToolIdentityKeys(value: unknown): string[] {
  const key = piNativeIdentity(value);
  return key === null ? [] : [`tool:${key}`];
}

function piRecordIdentityKeys(event: PiRpcRecord): string[] {
  const message = record(event.message);
  const keys: string[] = [];
  for (const value of [event.messageId, event.responseId, message.id, message.responseId]) {
    const key = piNativeIdentity(value);
    if (key !== null) keys.push(`message:${key}`);
  }
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    keys.push(`stamp:${JSON.stringify([message.role, message.provider, message.model, message.timestamp])}`);
  }
  keys.push(...piToolIdentityKeys(event.toolCallId ?? message.toolCallId));
  return [...new Set(keys)];
}

/** Legacy test oracle only. Production uses the retained L4 event projector. */
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
