import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { bindAcpxAgentFiles } from "../acpx/agent-files-binding.js";
import { nodeCompileCacheEnvironment } from "../../node-compile-cache-environment.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPiProviderBinding, directPiProviderConfiguration, piManagedProviderApi, usesPiProviderLoopback } from "../acpx/pi-provider-loopback.js";
import { PI_BIND_MAX_FRAME_BYTES, RunAuthority, normalizePiDynamicTools, sendPiBindRequest, validateBindReceipt, validateBindRequest, validateBindingConfig, validateOrigin, validatePiToolResult, type Origin, type PiBindCommand, type PiBindResponse, type PiDynamicTool, type PiToolCallRequest, type PiToolResult } from "./pi-bind-protocol.js";
import { startPiCallbackServer } from "./pi-rpc-callback-server.js";
import { writePrivateFile } from "../private-file.js";
import { loadPiBuiltinModelCatalog, mergedPiModelsJson, readPiModelsSnapshot } from "./pi-models-merge.js";
import { buildPiManagedModel, originalPiModelsFile, type PiManagedModel } from "./pi-managed-model.js";
import { piCompanySkillsAgentHome, syncPiCompanySkills } from "./pi-company-skills.js";
import { configurePiNativeMcp } from "./pi-native-mcp.js";
import { configurePiManagedCompaction } from "./pi-managed-settings.js";
import { piHostInstructionSegment, verifiedPiChildBridgePath } from "./extension/index.js";
import { piRpcUserInput } from "./pi-user-input.js";
import { createPiEventProjector, type PiEventOrigin } from "./pi-event-projector.js";
import { piTurnImageInput } from "./pi-turn-images.js";
import { PiIdentityTombstones } from "./pi-identity-tombstones.js";
import { admitPiRpcSession, PiNativeAdmissionError, resolvePiNativeConfig, type PiNativeAdmittedIdentity, type PiNativeConfig, type PiNativeThinkingLevel, type PiRpcAdmissionPort } from "./pi-native-config.js";
import { PiRpcRequestTimeoutError, PiRpcTransport, type PiRpcRecord, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import { normalizePiRuntimeDialog, piRuntimeDialogReply, PI_RUNTIME_DIALOG_ORIGIN, type PiRuntimeDialog } from "./pi-runtime-dialog.js";
import { piSessionFileInvalid, verifyPiSessionFile } from "./pi-session-file.js";
import type {
  HarnessDriver,
  HarnessDriverDescriptor,
  HarnessSession,
  HarnessSessionRecoveryOptions,
  HarnessSessionRecoveryResult,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import { HarnessCapabilityUnavailableError, HarnessOperationAlreadyTerminalError, HarnessStaleTurnError } from "../../contracts/harness-driver.js";
import type { NativeSessionCapabilities } from "../../contracts/types.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

export interface PiRpcDriverOptions {
  /** Proxy/backend integration options currently forwarded by the native factory. */
  completionFeedback?: unknown;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: (call: { readonly tool: string; readonly callId: string; readonly threadId: string; readonly runId: string; readonly turnId: string; readonly arguments: unknown; readonly signal: AbortSignal }) => Promise<unknown>;
  systemInstructions?: string;
  runtimeContext?: unknown;
  /** Caller-supplied callback paths are refused; the host allocates its own. */
  toolSocketPath?: string;
  permissionMode?: string;
  taskEnvelope?: unknown;
  conversationMode?: string;
  isolateProcessGroup?: boolean;
  /** Exact native selection, separate from the legacy ACPX field. */
  piRpcThinkingLevel?: PiNativeThinkingLevel;
  commandFd?: number;
  /** Proxy resource URL admitted by the runner-owned descriptor binding. */
  trustedProxyEntrypointUrl?: string;
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
  /** Dynamic tools have their own end-to-end deadline (protocol maximum: 60 s). */
  dynamicToolTimeoutMs?: number;
  /** Prompt acceptance deadline, default 30s. Never retries an unknown input. */
  promptTimeoutMs?: number;
  /** No Pi events during an accepted turn, default 10 minutes. Native tools and host callbacks pause it. */
  turnIdleTimeoutMs?: number;
  /** Stop's queue/abort/native-settlement deadline; default 5s, then retire. */
  abortTimeoutMs?: number;
  now?: () => Date;
  transportFactory?: (options: PiRpcTransportOptions) => PiRpcTransport;
  /** Private-channel adapter; receipts are independently validated by the driver. */
  bindRequest?: typeof sendPiBindRequest;
}

// The runner's longest configured Pi tool deadline is 60_000 ms: see the
// callback protocol maximum in pi-bind-protocol.ts and extension/index.ts's
// sendPiToolRequest/dispatchPiToolCall. Pi 1.5.2 core/tools/bash.ts has NO default
// timeout (and we configure none); native execution pauses this deadline rather
// than assuming a finite bash limit. Keep a minute above configured tool waits.
const PI_TURN_IDLE_TIMEOUT_MS = Math.max(600_000, 60_000 + 60_000);
const PI_TURN_IDLE_ABORT_TIMEOUT_MS = 5000;

const PI_CAPABILITIES: NativeSessionCapabilities = {
  resume: true,
  typedEvents: true,
  providerTranscriptStreaming: true,
  steering: true,
  queuedFollowUp: false,
  interruption: true,
  structuredResult: false,
  read: false,
  reconciliation: false,
  usage: true,
  dynamicTools: true,
  runtimeRequestResolution: false,
  runtimeRequestHandoff: false,
  goals: false,
  threadLineage: false,
  unsupported: ["queuedFollowUp", "structuredResult", "runtimeRequests", "goals", "threadLineage"],
};

export class PiRpcDriver implements HarnessDriver {
  readonly #options: PiRpcDriverOptions;

  constructor(options: PiRpcDriverOptions) {
    if (options.turnIdleTimeoutMs !== undefined && (!Number.isSafeInteger(options.turnIdleTimeoutMs) || options.turnIdleTimeoutMs < 1 || options.turnIdleTimeoutMs > 2_147_483_647)) throw new Error("Pi turnIdleTimeoutMs must be a positive timer-safe integer");
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

  async recoverSession(snapshot: PersistedHarnessSession, options: HarnessSessionRecoveryOptions): Promise<HarnessSessionRecoveryResult> {
    options.signal.throwIfAborted();
    if (snapshot.driverKind !== "pi_rpc" || !snapshot.runId || !snapshot.normalizedSessionId
      || !snapshot.driverSessionId || !snapshot.workingDirectory
      || (snapshot.providerSessionId != null && snapshot.providerSessionId !== snapshot.driverSessionId)) throw piSessionFileInvalid();
    const cwd = await realpath(snapshot.workingDirectory).catch(() => { throw piSessionFileInvalid(); });
    const sessionFile = await verifyPiSessionFile({ snapshot, runtimeDirectory: this.#options.runtimeDirectory,
      filename: `${safeSessionName(snapshot.normalizedSessionId)}.jsonl`, workingDirectory: cwd, signal: options.signal });
    const session = await this.#open({ runId: snapshot.runId, normalizedSessionId: snapshot.normalizedSessionId,
      workingDirectory: cwd, signal: options.signal }, { snapshot, sessionFile });
    return { recovered: true, session };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    return this.#open(input);
  }

  async #open(input: OpenHarnessSessionInput, recovery?: { snapshot: PersistedHarnessSession; sessionFile: string }): Promise<HarnessSession> {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Pi RPC session startup aborted");
    if (this.#options.toolSocketPath !== undefined) throw new Error("Pi semantic callbacks require the live guarded host bridge");
    const cwd = await realpath(input.workingDirectory);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Pi RPC working directory is not a directory");
    const directory = await realpath(this.#options.runtimeDirectory).catch(async () => {
      await mkdir(this.#options.runtimeDirectory, { recursive: true, mode: 0o700 });
      return realpath(this.#options.runtimeDirectory);
    });
    await chmod(directory, 0o700);
    const filename = `${safeSessionName(input.normalizedSessionId)}.jsonl`;
    const sessionFile = recovery?.sessionFile ?? join(directory, filename);
    const args = ["--mode", "rpc", "--session", sessionFile, "--no-approve", "--no-themes"];
    if (this.#options.model) args.push("--model", this.#options.model);
    const environment = { ...(this.#options.environment ?? {}), ...nodeCompileCacheEnvironment(directory, { enableLocalCache: true }) };
    // Capture the runner's original Pi home before selecting the managed home.
    const originalModelsFile = originalPiModelsFile({ ...process.env, ...environment, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR });
    // Environment paths may still name a controller-side copy. Only the
    // authenticated runtime-context grant can select a provider-local home.
    delete environment.AGENT_HOME;
    delete environment.PAPERCLIP_PI_AGENT_HOME;
    const credentialMode = environment.PAPERCLIP_PI_RPC_CREDENTIAL_MODE ?? "broker";
    if (credentialMode !== "broker" && credentialMode !== "env") throw new Error("PAPERCLIP_PI_RPC_CREDENTIAL_MODE must be broker|env");
    delete environment.PAPERCLIP_PI_RPC_CREDENTIAL_MODE;
    const config = resolvePiNativeConfig({
      provider: "pi_rpc",
      model: this.#options.model,
      piRpcThinkingLevel: this.#options.piRpcThinkingLevel ?? environment.PAPERCLIP_PI_THINKING_LEVEL,
    });
    if (config.piRpcThinkingLevel === undefined) throw new PiNativeAdmissionError("pi_thinking_required", "Pi RPC requires an explicit thinking effort before admission.");
    const instructionFile = join(directory, `${safeSessionName(input.normalizedSessionId)}-${randomUUID()}.instructions.md`);
    const instructionBoundary = `paperclip-host-${randomUUID()}`;
    const initialContext = bindingContext(this.#options.systemInstructions ?? "", this.#options.dynamicTools ?? [], this.#options.runtimeContext);
    const agentHome = this.#options.model && usesPiProviderLoopback(this.#options.model, environment)
      ? environment.PI_CODING_AGENT_DIR ?? join(directory, "agent")
      : piCompanySkillsAgentHome(environment);
    environment.PI_CODING_AGENT_DIR = agentHome;
    await configurePiNativeMcp(agentHome, environment);
    await syncPiCompanySkills(agentHome, initialContext.runtimeContext);
    const runtimeContext = initialContext.runtimeContext as NativeRuntimeContextSnapshot | undefined;
    const agentFiles = runtimeContext?.instructions ? bindAcpxAgentFiles(runtimeContext,
      [directory, agentHome, ...(this.#options.command && isAbsolute(this.#options.command) ? [dirname(this.#options.command)] : [])]) : null;
    if (agentFiles) {
      agentFiles.assertHeld();
      environment.AGENT_HOME = agentFiles.root;
      environment.PAPERCLIP_PI_AGENT_HOME = agentFiles.root;
    }
    const extension = await resolveOwnedPiExtension(this.#options.trustedProxyEntrypointUrl ?? import.meta.url);
    const fatalSessionStartExtensionPaths = [extension, verifiedPiChildBridgePath(pathToFileURL(extension).href)];
    await writePrivateFile(instructionFile, piHostInstructionSegment(initialContext.instructions, instructionBoundary));
    args.push("--append-system-prompt", instructionFile, "--extension", extension);
    environment.PAPERCLIP_PI_INSTRUCTIONS_FILE = instructionFile;
    environment.PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY = instructionBoundary;
    let closeProvider: (() => Promise<void>) | undefined;
    let resident: PiResidentState | undefined;
    let callbacks: PiHostCallbacks | undefined;
    if (this.#options.model && usesPiProviderLoopback(this.#options.model, environment)) {
      await mkdir(agentHome, { recursive: true, mode: 0o700 });
      environment.PI_CODING_AGENT_DIR = agentHome;
      const modelsFile = join(agentHome, "models.json");
      // Resolution and the defensive snapshot reread share one startup warning.
      let diagnosed = false;
      const warn = (message: string) => {
        if (!diagnosed) { diagnosed = true; console.warn(`Pi managed model metadata: ${message}`); }
      };
      const modelConfiguration = await buildPiManagedModel({ snapshot: await readPiModelsSnapshot(modelsFile),
        id: this.#options.model.slice("paperclip/".length), api: piManagedProviderApi(environment),
        originalModelsFile: originalModelsFile === modelsFile ? undefined : originalModelsFile,
        catalog: await loadPiBuiltinModelCatalog(this.#options.command ?? "pi", environment), warn });
      await configurePiManagedCompaction({ agentHome, originalAgentHome: dirname(originalModelsFile),
        model: config.model, contextWindow: modelConfiguration.contextWindow });
      if (credentialMode === "broker") {
        // Broker/models.json is the FIRST bind. INITIAL contains no provider
        // capability and prepares exactly one preallocated host turn, without IPC.
        const provider = await createPiProviderBinding({ model: this.#options.model, environment, thinkingLevel: config.piRpcThinkingLevel, modelConfiguration });
        closeProvider = provider.close;
        let privateDirectory: string | undefined;
        try {
          privateDirectory = await realpath(await mkdtemp(join(tmpdir(), "pcpi-")));
          await chmod(privateDirectory, 0o700);
          const socketPath = join(privateDirectory, "bind.sock");
          if (Buffer.byteLength(socketPath) > 103 || Buffer.byteLength(join(privateDirectory, "tool.sock")) > 103) throw new Error("Pi private socket path exceeds Unix limit");
          const origin = { epoch: 1, runId: input.runId, turnId: `pi-turn-${randomUUID()}` };
          const context = bindingContext(this.#options.systemInstructions ?? "", this.#options.dynamicTools ?? [], this.#options.runtimeContext);
          callbacks = new PiHostCallbacks(input.normalizedSessionId, this.#options.dynamicToolHandler);
          const toolSocketPath = join(privateDirectory, "tool.sock");
          // Listen BEFORE spawning Pi. Socket arrival is not an announcement.
          await callbacks.listen(toolSocketPath, this.#options.dynamicToolTimeoutMs);
          const initial = { schema: 1, sessionId: input.normalizedSessionId, ...origin, model: this.#options.model, thinkingLevel: config.piRpcThinkingLevel, instructions: context.instructions, tools: context.tools, toolSocketPath };
          if (!validateBindingConfig(initial)) throw new Error("Pi initial binding configuration rejected");
          resident = { directory: privateDirectory, socketPath, environment: { ...environment }, modelConfiguration, epoch: 1, context,
            binding: { origin, close: provider.close, initial: true }, toolSocketPath };
          const { name, ...configuration } = provider.provider;
          const json = JSON.stringify({ providers: { [name]: configuration } });
          await writePrivateFile(join(agentHome, "models.json"), await mergedPiModelsJson(join(agentHome, "models.json"), json, warn));
          const initialJson = JSON.stringify(initial);
          if (Buffer.byteLength(initialJson) > PI_BIND_MAX_FRAME_BYTES) throw new Error("Pi initial binding exceeds its private frame limit");
          const initialFile = join(privateDirectory, "initial.json");
          await writeFile(initialFile, initialJson, { mode: 0o600, flag: "wx" });
          environment.PAPERCLIP_PI_BIND_SOCKET = socketPath;
          delete environment.PAPERCLIP_PI_BIND_INITIAL;
          environment.PAPERCLIP_PI_BIND_INITIAL_FILE = initialFile;
        } catch (error) {
          await callbacks?.close();
          await provider.close();
          if (privateDirectory) await cleanPiPrivateDirectory({ directory: privateDirectory, socketPath: join(privateDirectory, "bind.sock") });
          throw error;
        }
        for (const key of Object.keys(environment)) if (key.startsWith("PAPERCLIP_AI_PROVIDER_")) delete environment[key];
      } else {
        const provider = directPiProviderConfiguration({ model: this.#options.model, environment, thinkingLevel: config.piRpcThinkingLevel, modelConfiguration });
        await writePrivateFile(join(agentHome, "models.json"), await mergedPiModelsJson(join(agentHome, "models.json"), provider.json, warn));
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
      fatalSessionStartExtensionPaths,
      shutdownTimeoutMs: this.#options.shutdownTimeoutMs,
      killTimeoutMs: this.#options.killTimeoutMs,
    };
    let transport: PiRpcTransport | undefined;
    try {
      transport = this.#options.transportFactory?.(transportOptions) ?? new PiRpcTransport(transportOptions);
      // --session loads an existing file too: no saved selection bypasses live
      // admission. The broker/models.json bootstrap above remains first.
            const port = piAdmissionPort(transport, this.#options.startupTimeoutMs);
      if (recovery) {
        // Check native readback before model/config mutation, not just the argv.
        const live = record(await port.request({ type: "get_state" }, input.signal));
        if (live.sessionId !== recovery.snapshot.driverSessionId || live.sessionFile !== sessionFile) throw piSessionFileInvalid();
      }
      const identity = await admitPiRpcSession(port, config, input.signal);
      if (recovery && identity.providerSessionId !== recovery.snapshot.driverSessionId) throw piSessionFileInvalid();
      // Discovery is separate from inference. Keep catalog/auth contents private;
      // the receipt exposes only qualified version, provider names and auth shape.
      const discovery = await withAbort(withTimeout(transport.request("get_available_models"), this.#options.startupTimeoutMs ?? 10_000, "Pi metadata timed out"), input.signal);
      const models = record(discovery.data).models;
      if (!Array.isArray(models) || models.length > 100_000) throw new PiNativeAdmissionError("pi_metadata_invalid", "Pi omitted its model/provider metadata.");
      const providers = [...new Set(models.flatMap(value => typeof record(value).provider === "string" && /^[A-Za-z0-9._-]{1,80}$/u.test(record(value).provider as string) ? [record(value).provider as string] : []))].sort();
      const piMetadata = { version: "1.5.2", versionSource: "qualified-profile", providers, credentialMode, promptSent: false,
        authShape: { mode: credentialMode, source: usesPiProviderLoopback(config.model, this.#options.environment ?? {}) ? "managed-provider" : "configured-provider" } };
      return new PiRpcHarnessSession({
        transport,
        runId: input.runId,
        normalizedSessionId: input.normalizedSessionId,
        providerSessionId: identity.providerSessionId,
        sourceSequence: recovery?.snapshot.lastSourceSequence,
        identity,
        sessionFile,
        config,
        piMetadata,
        systemInstructions: this.#options.systemInstructions,
        initialContext,
        agentHome,
        instructionFile,
        instructionBoundary,
        admissionTimeoutMs: this.#options.startupTimeoutMs,
        promptTimeoutMs: this.#options.promptTimeoutMs,
        turnIdleTimeoutMs: this.#options.turnIdleTimeoutMs,
        abortTimeoutMs: this.#options.abortTimeoutMs,
        workingDirectory: cwd,
        runnerInstanceId: this.#options.runnerInstanceId ?? `paperclip-pi-${input.runId}`,
        now: this.#options.now ?? (() => new Date()),
        closeProvider: resident ? undefined : closeProvider,
        resident,
        callbacks,
        bindRequest: this.#options.bindRequest ?? sendPiBindRequest,
      });
    } catch (error) {
      await callbacks?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      await closeProvider?.().catch(() => undefined);
      if (resident) await cleanPiPrivateDirectory(resident).catch(() => undefined);
      await unlink(instructionFile).catch(() => undefined);
      throw error;
    }
  }
}

interface PiRunContext {
  baseInstructions: string;
  runtimeContext: unknown;
  instructions: string;
  tools: PiDynamicTool[];
  toolNames: Record<string, string>;
  diagnostics: Array<{ code: string; message: string }>;
}
interface PiResidentState {
  modelConfiguration: PiManagedModel;
  directory: string;
  socketPath: string;
  environment: NodeJS.ProcessEnv;
  epoch: number;
  context: PiRunContext;
  toolSocketPath?: string;
  binding: { origin: Origin; close(): Promise<void>; initial: boolean } | null;
}
interface PiSessionState {
  transport: PiRpcTransport;
  runId: string;
  normalizedSessionId: string;
  providerSessionId: string;
  sourceSequence?: number;
  sessionFile: string;
  workingDirectory: string;
  runnerInstanceId: string;
  now: () => Date;
  closeProvider?: () => Promise<void>;
  resident?: PiResidentState;
  callbacks?: PiHostCallbacks;
  config: PiNativeConfig;
  piMetadata: Record<string, unknown>;
  identity: PiNativeAdmittedIdentity;
  systemInstructions?: string;
  initialContext: PiRunContext;
  agentHome: string;
  instructionFile: string;
  instructionBoundary: string;
  bindRequest: typeof sendPiBindRequest;
  admissionTimeoutMs?: number;
  promptTimeoutMs?: number;
  turnIdleTimeoutMs?: number;
  abortTimeoutMs?: number;
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
  lastErrorMessage?: string;
  hasToolCalls: boolean;
  /** Low-level agent_end is a continuation boundary, not prompt settlement. */
  agentEnded: boolean;
  failed: boolean;
  /** Latest receipt only; native recovery can replace it before settlement. */
  lastAssistantStopReason?: string | null;
  settled: boolean;
  cancelRequested?: boolean;
}

/** Carries the projector's captured owner across the pump's async failure path. */
class PiProjectionFailure extends Error {
  constructor(readonly turn: PiTurnState, readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure), { cause: failure });
  }
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
  readonly #resident?: PiResidentState;
  readonly #callbacks?: PiHostCallbacks;
  readonly #dialogs = new Map<string, { id: string | number; dialog: PiRuntimeDialog; origin: Readonly<Origin>; turn: PiTurnState; diagnosticOrigin: Record<string, unknown>; expiresAt?: number; resolving: boolean }>();
  readonly #dialogIds = new Set<string>();
  // Park blockers outlive settlement, but need no retained projector/display.
  readonly #pendingNativeTools = new Map<string, { runId: string; turnId: string; toolName: string | undefined }>();
  #pendingInput = 0;
  // Prompt acceptance gates lifecycle ownership, not transport/error delivery.
  // A handled prompt retains a false gate while independent extension work drains.
  #promptAcceptance: Promise<boolean> | null = null;
  #cleanupFailure: Error | null = null;
  readonly #bindRequest: typeof sendPiBindRequest;
  #closing?: Promise<void>;
  #providerRevocation: Promise<void> = Promise.resolve();
  readonly #events = new EventQueue();
  #sourceSequence = 0;
  readonly #config: PiNativeConfig;
  readonly #piMetadata: Record<string, unknown>;
  #identity: PiNativeAdmittedIdentity;
  #thinkingLoweringReported = false;
  #initialContext: PiRunContext;
  readonly #agentHome: string;
  readonly #instructionFile: string;
  readonly #instructionBoundary: string;
  readonly #admissionTimeoutMs?: number;
  readonly #promptTimeoutMs?: number;
  readonly #turnIdleTimeoutMs: number;
  #turnIdleTimer: ReturnType<typeof setTimeout> | undefined;
  #turnIdleRecovery: { settle: (settled: boolean) => void } | undefined;
  readonly #abortTimeoutMs: number;
  #interrupting?: Promise<void>;
  #nativeAbortSettled?: { turn: PiTurnState; resolve(): void };
  // Only active identities retain a projector. Fixed-memory tombstones prevent
  // old/reused IDs from binding to a later turn, without a growing warm history.
  // Outstanding native tools separately retain only their original IDs/name.
  readonly #owners = new Map<string, PiTurnState | null>();
  readonly #retiredIdentities = new PiIdentityTombstones();
  #activeIdentityCount = 0;
  #identityLimited = false;
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
    this.#sourceSequence = state.sourceSequence ?? 0;
    this.#sessionFile = state.sessionFile;
    this.#workingDirectory = state.workingDirectory;
    this.#runnerInstanceId = state.runnerInstanceId;
    this.#now = state.now;
    this.#closeProvider = state.closeProvider;
    this.#resident = state.resident;
    this.#callbacks = state.callbacks;
    this.#callbacks?.setNativeSessionId(state.providerSessionId);
    this.#bindRequest = state.bindRequest;
    this.#config = state.config;
    this.#identity = state.identity;
    this.#initialContext = state.initialContext;
    this.#agentHome = state.agentHome;
    this.#instructionFile = state.instructionFile;
    this.#instructionBoundary = state.instructionBoundary;
    this.#admissionTimeoutMs = state.admissionTimeoutMs;
    this.#piMetadata = state.piMetadata;
    this.#promptTimeoutMs = state.promptTimeoutMs;
    this.#turnIdleTimeoutMs = state.turnIdleTimeoutMs ?? PI_TURN_IDLE_TIMEOUT_MS;
    this.#callbacks?.setActivityListener(() => this.#armTurnIdleTimer());
    this.#abortTimeoutMs = Number.isFinite(state.abortTimeoutMs) ? Math.max(1, Math.min(30_000, state.abortTimeoutMs!)) : 5000;
    this.#emit("session.started", { context: this.#effectiveContext() });
    this.#recordAdmission(state.identity);
    for (const diagnostic of state.initialContext.diagnostics) this.#emit("harness.diagnostic", diagnostic);
    void this.#pump();
  }

  piNativeAdmission(): Record<string, unknown> {
    return structuredClone({ ...this.#config, ...this.#effectiveContext(), providerSessionId: this.#providerSessionId });
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
      await this.#interrupting;
      if (!input.runId || input.runId.length > 240) throw new Error("Pi RPC attach requires a valid run id");
      if (this.#resident) {
        const previous = this.#resident.context;
        const context = bindingContext(input.baseInstructions !== undefined ? input.baseInstructions : previous.baseInstructions,
          input.dynamicTools,
          input.runtimeContext !== undefined ? input.runtimeContext : previous.runtimeContext, previous);
        // The proxy sends attach before every turn, including the bootstrap and
        // same-run post-claim admission. Do not consume INITIAL or rotate twice.
        if (this.#resident.binding) {
          if (input.runId !== this.#runId || JSON.stringify(context) !== JSON.stringify(previous)) throw new Error("Pi prepared binding context cannot change before its turn");
          await this.#admit(input.signal);
        } else await this.#prepareBinding(input.runId, context, input.signal);
      } else {
        // Direct env/native providers retain their existing behavior. They do
        // not gain a managed broker secrecy or dynamic-refresh guarantee.
        const previous = this.#initialContext;
        const context = bindingContext(input.baseInstructions !== undefined ? input.baseInstructions : previous.baseInstructions,
          input.dynamicTools,
          input.runtimeContext !== undefined ? input.runtimeContext : previous.runtimeContext, previous);
        if (JSON.stringify(context.tools) !== JSON.stringify(previous.tools)) throw new Error("Pi RPC tool refresh requires a provider bind receipt");
        await this.#admit(input.signal);
        await syncPiCompanySkills(this.#agentHome, context.runtimeContext);
        await writePrivateFile(this.#instructionFile, piHostInstructionSegment(context.instructions, this.#instructionBoundary));
        this.#initialContext = context;
      }
      this.#runId = input.runId;
      for (const diagnostic of (this.#resident?.context ?? this.#initialContext).diagnostics) this.#emit("harness.diagnostic", diagnostic);
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

  #effectiveContext(): Record<string, unknown> {
    return { model: this.#identity.model, piRpcThinkingLevel: this.#identity.piRpcThinkingLevel, piMetadata: this.#piMetadata };
  }

  #recordAdmission(identity: PiNativeAdmittedIdentity): void {
    this.#identity = identity;
    if (identity.diagnostic && !this.#thinkingLoweringReported) {
      this.#thinkingLoweringReported = true;
      const { requested, effective } = identity.diagnostic;
      this.#emit("harness.diagnostic", { ...identity.diagnostic, message: `pi_thinking_lowered_by_config ${JSON.stringify({ requested, effective })}` });
    }
  }

  async #admit(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error("Pi RPC session is closed");
    if (this.#activeTurn) throw new PiNativeAdmissionError("pi_session_busy", "Pi session already has an active turn; refusing admission.");
    this.#admitted = false;
    try {
      const identity = await admitPiRpcSession(piAdmissionPort(this.#transport, this.#admissionTimeoutMs), this.#config, signal);
      if (identity.providerSessionId !== this.#providerSessionId) throw new PiNativeAdmissionError("pi_session_identity_changed", "Pi session identity changed during re-admission.");
      if (this.#closed || this.#failure) throw this.#failure ?? new Error("Pi RPC session is closed");
      this.#recordAdmission(identity);
      this.#admitted = true;
    } catch (error) {
      if (this.#resident) await this.#fenceFailure(error);
      throw error;
    }
  }

  async #prepareBinding(runId: string, context: PiRunContext, signal?: AbortSignal): Promise<void> {
    const resident = this.#resident!;
    if (this.#closed || this.#failure) throw this.#failure ?? new Error("Pi RPC session is closed");
    if (this.#activeTurn) throw new Error("Pi RPC session already has an active turn");
    this.#admitted = false;
    try {
      await this.#revokeBinding();
      signal?.throwIfAborted();
      const broker = await createPiProviderBinding({ model: this.#config.model, environment: resident.environment, thinkingLevel: this.#config.piRpcThinkingLevel, modelConfiguration: resident.modelConfiguration });
      const origin = { epoch: resident.epoch + 1, runId, turnId: `pi-turn-${randomUUID()}` };
      resident.binding = { origin, close: broker.close, initial: false };
      const request = { schema: 1, type: "bind", nonce: randomUUID(), sessionId: this.#normalizedSessionId,
        expectedPriorEpoch: resident.epoch, epoch: origin.epoch, runId, provider: broker.provider,
        model: this.#config.model, thinkingLevel: this.#config.piRpcThinkingLevel!, instructions: context.instructions, tools: context.tools,
        ...(resident.toolSocketPath !== undefined ? { toolSocketPath: resident.toolSocketPath } : {}) };
      if (!validateBindRequest(request)) throw new Error("Pi binding configuration rejected");
      // sendPiBindRequest validates exact nonce/session/epoch/content receipts.
      // Never retry a lost ACK: its native state is uncertain, so retire it.
      await this.#sendBind(request, signal);
      resident.epoch = origin.epoch;
      await this.#admit(signal);
      await syncPiCompanySkills(this.#agentHome, context.runtimeContext);
      await writePrivateFile(this.#instructionFile, piHostInstructionSegment(context.instructions, this.#instructionBoundary));
      resident.context = context;
    } catch (error) {
      await this.#fenceFailure(error);
      throw error;
    }
  }

  async #sendBind<C extends PiBindCommand>(request: C, signal?: AbortSignal): Promise<PiBindResponse<C>> {
    const timeoutMs = this.#admissionTimeoutMs ?? 5000;
    const receipt = await withAbort(withTimeout(this.#bindRequest(this.#resident!.socketPath, request, { timeoutMs, signal }), timeoutMs, "Pi private receipt timed out"), signal);
    if (!validateBindReceipt(receipt, request)) throw new Error("Pi private receipt mismatch");
    return receipt;
  }

  async #revokeBinding(): Promise<void> {
    const binding = this.#resident?.binding;
    if (this.#resident) this.#resident.binding = null;
    if (binding) this.#providerRevocation = withTimeout(binding.close(), 5000, "Pi broker revocation timed out");
    await this.#providerRevocation;
  }

  async #fenceFailure(error: unknown): Promise<void> {
    this.#callbacks?.fence();
    this.#admitted = false;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    try { await this.close(); }
    catch (cleanup) { throw new AggregateError([this.#failure, cleanup], `${this.#failure.message}; Pi cleanup uncertain`); }
  }

  async startTurn(input: Parameters<HarnessSession["startTurn"]>[0]): Promise<{ turnId: string }> {
    piRpcUserInput(input.message);
    return this.#serialize(async () => {
      await this.#interrupting;
      if (this.#closed) throw new Error("Pi RPC session is closed");
      if (this.#failure) throw this.#failure;
      if (this.#activeTurn) throw new Error("Pi RPC session already has an active turn");
      if ((input as Record<string, unknown>).piThinkingLevel !== undefined) throw new PiNativeAdmissionError("pi_thinking_invalid", "Native Pi turns use piRpcThinkingLevel, not the ACPX alias.");
      const selected = resolvePiNativeConfig({ ...this.#config, ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.piRpcThinkingLevel === undefined ? {} : { piRpcThinkingLevel: input.piRpcThinkingLevel }) });
      if (selected.model !== this.#config.model || selected.piRpcThinkingLevel !== this.#config.piRpcThinkingLevel) throw new PiNativeAdmissionError("pi_turn_selection_mismatch", "Pi turn selection differs from the admitted session.");
      // Validate/resolve both image forms before changing admission or turn
      // authority. A bad staged file refuses only this request, not the session.
      this.#pendingInput++;
      let message: Awaited<ReturnType<typeof piTurnImageInput>>;
      try {
        message = await piTurnImageInput(input.message, this.#workingDirectory);
        if (this.#closed) throw new Error("Pi RPC session closed while preparing image input");
        if (this.#failure) throw this.#failure;
      } finally { this.#pendingInput--; }
      // Every prompt, including direct-env and first hello, re-proves selection.
      // A failed attach/claim must still be recovered by an explicit admission;
      // startTurn may not silently revive a cancelled or rejected authority.
      // The re-admission below also proves idle after handled input before
      // replacing its discard gate with a new prompt owner.
      if (this.#resident && !this.#resident.binding) await this.#prepareBinding(this.#runId, this.#resident.context);
      else {
        if (!this.#admitted) throw new Error("Pi RPC session requires fresh admission before input");
        await this.#admit();
      }
      const binding = this.#resident?.binding;
      const origin = binding?.origin ?? { runId: this.#runId, turnId: `pi-turn-${randomUUID()}` };
      if (binding && !binding.initial) {
        try {
          await this.#sendBind({ schema: 1, type: "begin_turn", nonce: randomUUID(), sessionId: this.#normalizedSessionId, ...binding.origin });
        } catch (error) { await this.#fenceFailure(error); throw error; }
      }
      const turn: PiTurnState = { ...origin, projector: createPiEventProjector(origin), lastText: "", hasToolCalls: false, agentEnded: false, failed: false, settled: false };
      this.#activeTurn = turn;
      this.#streamTurn = null;
      this.#emit("turn.started", { status: "inProgress", context: this.#effectiveContext() }, turn);
      let settleAcceptance!: (consume: boolean) => void;
      const acceptance = new Promise<boolean>(resolve => { settleAcceptance = resolve; });
      this.#promptAcceptance = acceptance;
      const releaseAcceptance = (consume: boolean, retain = false) => {
        settleAcceptance(consume);
        if (!retain && this.#promptAcceptance === acceptance) this.#promptAcceptance = null;
      };
      try {
        // Host authority is independent from extension authority and activated
        // only by this host prompt, never attach/bind or callback arrival.
        if (binding) this.#callbacks?.activate(binding.origin, this.#resident!.context.toolNames);
        this.#pendingInput++;
        const response = await this.#transport.request("prompt", message, { timeoutMs: this.#promptTimeoutMs }).finally(() => { this.#pendingInput--; });
        const disposition = stringValue(record(response.data).disposition);
        if (disposition === "handled") {
          // Valid consumption without a model run: there will be no owned
          // agent_settled, and extension-started work must not borrow this turn.
          try { await this.#finishTurn(turn, "completed", { outcome: "handled", modelOutput: false }); }
          catch (cleanup) { await this.#fenceFailure(cleanup); throw cleanup; }
          releaseAcceptance(false, true);
        } else if (disposition === "started" || disposition === "queued") {
          releaseAcceptance(true);
          this.#armTurnIdleTimer();
        } else throw new Error(`Pi RPC prompt returned an invalid disposition (${disposition ?? "missing"})`);
      } catch (error) {
        const unknown = error instanceof PiRpcRequestTimeoutError && error.command === "prompt";
        // On a lost ACK, let the captured lifecycle drain before inspecting Pi.
        // A genuine rejection/handled result never assigns those events a turn.
        releaseAcceptance(unknown);
        if (unknown) {
          // A lost ACK is not a rejection. Keep the sole input owner while
          // inspecting Pi; never submit the prompt a second time.
          if (await this.#reconcilePrompt(turn)) { this.#armTurnIdleTimer(); return { turnId: turn.turnId }; }
          this.#callbacks?.fence();
          this.#admitted = false;
          const failure = new Error(error.message, { cause: error });
          const detail = { code: "pi_prompt_deadline_exceeded", message: failure.message, acceptance: "unknown", recoverable: false };
          try { await this.#finishTurn(turn, "failed", { error: detail }); }
          finally { await this.#fenceFailure(failure); }
          throw failure;
        }
        try { await this.#finishTurn(turn, "failed", { error: { code: "pi_prompt_rejected", message: error instanceof Error ? error.message : String(error), recoverable: false } }); }
        catch (cleanup) { await this.#fenceFailure(cleanup); throw cleanup; }
        // A pre-acceptance prompt error belongs to this input, not the resident
        // session. Normal turn finalization revokes its capability for rebind.
        throw error;
      }
      return { turnId: turn.turnId };
    });
  }

  async steer(input: Parameters<NonNullable<HarnessSession["steer"]>>[0]): Promise<void> {
    // The Codex executor admits active-turn steering, not queued follow-ups.
    if (input.mode === "follow_up") throw new HarnessCapabilityUnavailableError("follow-up", "Pi RPC follow-up is not admitted by the executor");
    const turn = this.#activeTurn;
    if (this.#closed || !turn || turn.settled) throw new HarnessOperationAlreadyTerminalError("steering");
    if (input.turnId !== turn.turnId) throw new HarnessStaleTurnError(input.turnId);
    piRpcUserInput(input.message);
    this.#pendingInput++;
    let response: PiRpcRecord;
    try {
      const message = await piTurnImageInput(input.message, this.#workingDirectory);
      if (this.#closed || turn.settled || this.#activeTurn !== turn) throw new HarnessOperationAlreadyTerminalError("steering");
      response = await this.#transport.request("steer", message);
    } finally { this.#pendingInput--; }
    const disposition = stringValue(record(response.data).disposition);
    if (disposition !== "queued") {
      throw new Error(`Pi RPC steer did not queue input (disposition=${disposition ?? "missing"})`);
    }
    if (this.#closed || turn.settled || this.#activeTurn !== turn) throw new HarnessOperationAlreadyTerminalError("steering");
    // Acceptance is not consumption. The native user message is projected only
    // when Pi emits it; agent_settled remains the single turn-terminal authority.
  }

  async #reconcilePrompt(turn: PiTurnState): Promise<boolean> {
    // Fast completion can precede both the ACK and its deadline. The captured
    // terminal already proves this input was consumed, even if Pi is now idle.
    if (turn.settled) return !this.#closed && !this.#failure;
    try {
      const response = await this.#transport.request("get_state", {}, {
        timeoutMs: Math.min(this.#admissionTimeoutMs ?? 5000, this.#promptTimeoutMs ?? 30_000),
      });
      const state = record(response.data);
      if (this.#closed || this.#failure) return false;
      return turn.settled || (this.#activeTurn === turn && this.#agentTurn === turn
        && state.sessionId === this.#providerSessionId && state.isStreaming === true);
    } catch {
      return turn.settled && !this.#closed && !this.#failure;
    }
  }

  async interrupt(input: Parameters<NonNullable<HarnessSession["interrupt"]>>[0] = {}): Promise<void> {
    if (input.turnId && input.turnId !== this.#activeTurn?.turnId) return;
    if (this.#interrupting) return this.#interrupting;
    const turn = this.#activeTurn;
    if (this.#closed || !turn || turn.settled) return;
    // Fence synchronously, before the first IPC await. No callback (including
    // one already waiting for its native announcement) may borrow this turn.
    turn.cancelRequested = true;
    this.#callbacks?.fence();
    this.#admitted = false;
    const settled = new Promise<void>(resolve => { this.#nativeAbortSettled = { turn, resolve }; });
    const stopping = async () => {
      try {
        await withTimeout((async () => {
          // Pi 1.5.2: abort continues queued steering/follow-ups unless cleared
          // first. Never replay either queue or the interrupted input.
          await this.#transport.request("clear_queue", {}, { timeoutMs: this.#abortTimeoutMs });
          if (this.#resident) {
            const receipt = await this.#sendBind({ schema: 1, type: "stop_children", nonce: randomUUID(), sessionId: this.#normalizedSessionId });
            if (receipt.uncertain.length) throw new Error("Pi child cleanup uncertain");
          }
          // Native dialogs can hold the lifecycle open; cancel, never answer.
          for (const dialog of this.#dialogs.values()) if (dialog.turn === turn) {
            await this.#transport.sendExtensionUiResponse({ id: dialog.id, cancelled: true });
          }
          // abort ACK proves native idle, while agent_settled proves the pump
          // has consumed the final tool receipts and revoked the old binding.
          await this.#transport.request("abort", {}, { timeoutMs: this.#abortTimeoutMs });
          await settled;
          if (this.#closed || this.#failure) throw this.#failure ?? new Error("Pi closed during Stop");
          await this.#admit();
        })(), this.#abortTimeoutMs, "Pi abort did not settle within the Stop deadline");
      } catch (error) {
        this.#emit("harness.diagnostic", { code: "pi_abort_escalated", message: error instanceof Error ? error.message : String(error) }, turn);
        // Uncertain idle/child cleanup retires only this process generation.
        // Transport close owns the bounded process-group TERM/KILL ladder.
        await this.close();
      } finally {
        if (this.#nativeAbortSettled?.turn === turn) this.#nativeAbortSettled = undefined;
      }
    };
    this.#interrupting = stopping();
    try { await this.#interrupting; }
    finally { this.#interrupting = undefined; }
  }

  async parkReady(): Promise<{ ready: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const local = () => {
      if (this.#closed || this.#failure || this.#cleanupFailure) reasons.push("session unavailable");
      if (this.#activeTurn || this.#callbacks?.authority.capture()) reasons.push("active turn");
      if (this.#callbacks?.pendingCount() || this.#pendingNativeTools.size) reasons.push("pending tools");
      if (this.#dialogs.size) reasons.push("pending dialogs");
      if (this.#pendingInput) reasons.push("pending input");
    };
    local();
    const sequence = this.#sourceSequence;
    try {
      const response = await withTimeout(this.#transport.request("get_state"), this.#admissionTimeoutMs ?? 5000, "Pi idle inspection timed out");
      const state = record(response.data);
      if (state.sessionId !== this.#providerSessionId || state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0) reasons.push("native not idle or queued input");
    } catch { reasons.push("native idle state unavailable"); }
    if (this.#resident) {
      try {
        const result = await this.#sendBind({ schema: 1, type: "park_ready", nonce: randomUUID(), sessionId: this.#normalizedSessionId });
        if (!result.ready) reasons.push(...(result.reasons.length ? result.reasons : ["private contributors not ready"]));
      } catch { reasons.push("private park state unavailable"); }
    } else reasons.push("private park state unavailable");
    local();
    if (sequence !== this.#sourceSequence) reasons.push("state changed during park inspection");
    return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  async #captureUi(event: PiRpcRecord, keys: string[]): Promise<void> {
    if (!["select", "confirm", "input", "editor"].includes(String(event.method))) return;
    const id = event.id;
    if (!((typeof id === "string" && id.length > 0 && id.length <= 1024) || (typeof id === "number" && Number.isSafeInteger(id)))) return;
    const requestId = String(id);
    // Native ids are tombstoned across the resident lifetime. A repeated old
    // request must not cancel or overwrite a newer request with the same id.
    if (this.#dialogIds.has(requestId)) return;
    if (this.#dialogIds.size >= 4096) throw new Error("Pi UI identity limit exceeded");
    this.#dialogIds.add(requestId);
    let dialog: PiRuntimeDialog;
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/.test(requestId)) throw new Error("Invalid Pi UI identity");
      dialog = normalizePiRuntimeDialog(event);
    } catch {
      await this.#transport.sendExtensionUiResponse({ id, cancelled: true });
      this.#emit("harness.diagnostic", { code: "pi_runtime_dialog_refused" });
      return;
    }
    // No await precedes validation + capture of a valid frame. The sole pump
    // consumes native stdout FIFO: old UI precedes old agent_settled; settlement
    // fences and removes its dialogs before warm admission/new agent_start.
    const captured = this.#callbacks?.authority.capture();
    let turn: PiTurnState | null = null;
    let origin: Readonly<Origin> | null = null;
    if (Object.hasOwn(event, "origin")) {
      if (captured && validateOrigin(event.origin) && this.#callbacks?.authority.accept(event.origin)) {
        const active = this.#activeTurn;
        if (active?.runId === captured.runId && active.turnId === captured.turnId) { turn = active; origin = captured; }
      }
      // Explicit old/unknown attribution NEVER falls back to the current run.
    } else if (keys.length > 0 && keys.every(key => this.#owners.has(key))) {
      const owners = keys.map(key => this.#owners.get(key));
      if (owners[0] && owners.every(owner => owner === owners[0])) {
        if (captured && captured.runId === owners[0].runId && captured.turnId === owners[0].turnId) { turn = owners[0]; origin = captured; }
      }
    } else if (keys.length === 0) {
      // The unmodified SDK emits no origin/message/tool fields for ctx.ui.
      // Bind only inside the already admitted native agent lifecycle, using
      // the host's captured epoch, never provider-supplied controller IDs.
      const active = this.#agentTurn;
      if (this.#admitted && this.#providerSessionId && captured && active === this.#activeTurn && active?.runId === captured.runId && active.turnId === captured.turnId) { turn = active; origin = captured; }
    }
    if (turn && keys.length > 0 && !keys.every(key => this.#owners.get(key) === turn)) { turn = null; origin = null; }
    if (!turn || turn.settled || !origin) {
      // Idle, unknown and stale UI never borrows the current run. Cancellation
      // uses Pi's method-specific default, never an answer or capability.
      await this.#transport.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    const diagnosticOrigin = PI_RUNTIME_DIALOG_ORIGIN;
    this.#dialogs.set(requestId, { id, dialog, turn, origin, diagnosticOrigin, ...(dialog.timeout ? { expiresAt: this.#now().getTime() + dialog.timeout } : {}), resolving: false });
    this.#emit("runtime_request.created", { request: { schema: "paperclip.runtime_request.v2", requestId, requestKind: "runtime", type: "input", turnId: turn.turnId, itemId: `pi-ui-${createHash("sha256").update(requestId).digest("hex")}`, status: "pending", prompt: dialog.input.questions[0]!.prompt, input: dialog.input, origin: diagnosticOrigin } }, turn);
  }

  async resolveRuntimeRequest(input: Parameters<NonNullable<HarnessSession["resolveRuntimeRequest"]>>[0] & { runId?: string; origin?: unknown }): Promise<void> {
    const requestId = input.requestId, runId = input.runId, turnId = input.turnId;
    const origin: unknown = structuredClone(input.origin);
    const dialog = this.#dialogs.get(requestId);
    const valid = () => dialog && !this.#closed && !this.#failure && !dialog.turn.settled
      && runId === dialog.origin.runId && turnId === dialog.origin.turnId
      && sameJson(origin, dialog.diagnosticOrigin) && (dialog.expiresAt === undefined || this.#now().getTime() < dialog.expiresAt)
      && this.#callbacks?.authority.accept(dialog.origin);
    if (!dialog || dialog.resolving || !valid()) throw new Error("Pi UI resolution refused");
    const resolution = structuredClone(input.resolution);
    // Invalid answers remain pending and never consume a native Promise.
    const response = piRuntimeDialogReply(dialog.dialog, dialog.id, resolution);
    dialog.resolving = true;
    try {
      await Promise.resolve();
      if (!valid()) throw new Error("Pi UI resolution refused");
      await this.#transport.sendExtensionUiResponse(response);
      if (!valid()) throw new Error("Pi UI resolution refused");
      this.#dialogs.delete(requestId);
      this.#emit("runtime_request.resolved", { requestId, turnId: dialog.turn.turnId, action: resolution.action }, dialog.turn);
    } catch (error) {
      // Once a response may have reached stdin it is never retried.
      this.#dialogs.delete(requestId);
      throw error;
    }
  }

  processPid(): number | null {
    return this.#transport.pid;
  }

  processExited(): boolean {
    return this.#transport.exited;
  }

  async snapshot(): Promise<PersistedHarnessSession & { sessionFile: string; piRpcThinkingLevel?: PiNativeThinkingLevel; binding?: { epoch: number; socketPath: string; preparedTurnId: string | null } }> {
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
      piRpcThinkingLevel: this.#identity.piRpcThinkingLevel,
      ...(this.#resident ? { binding: { epoch: this.#resident.epoch, socketPath: this.#resident.socketPath, preparedTurnId: this.#resident.binding?.origin.turnId ?? null } } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#callbacks?.fence();
    this.#closed = true;
    this.#admitted = false;
    this.#clearTurnIdleTimer();
    this.#turnIdleRecovery?.settle(false);
    this.#dialogs.clear();
    this.#closing = (async () => {
      const failures: unknown[] = [];
      // Revoke the model capability immediately too, without waiting for child
      // hooks. Observe its outcome below so no cleanup failure is lost.
      const revocation = this.#revokeBinding().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      // Fence synchronously, then await child cleanup while private IPC still
      // exists. A lost/uncertain receipt must not turn into void success.
      if (this.#resident && !this.#transport.exited) {
        try {
          const receipt = await this.#sendBind({ schema: 1, type: "stop_children", nonce: randomUUID(), sessionId: this.#normalizedSessionId });
          if (receipt.uncertain.length) throw new Error("Pi child cleanup uncertain");
        } catch (error) { this.#cleanupFailure = new Error("Pi child cleanup uncertain"); failures.push(error); }
      }
      const revoked = await revocation;
      if (!revoked.ok) failures.push(revoked.error);
      for (const cleanup of [() => this.#callbacks?.close(), () => this.#transport.close(), () => this.#closeProvider?.(), () => this.#resident ? cleanPiPrivateDirectory(this.#resident) : undefined, () => unlink(this.#instructionFile)]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      const turn = this.#activeTurn;
      if (turn && !turn.settled) {
        turn.settled = true;
        this.#emit(failures.length ? "turn.failed" : "turn.cancelled", failures.length
          ? { status: "failed", error: { code: "pi_cleanup_uncertain", recoverable: false } }
          : { status: "cancelled", reason: "session_closed" }, turn);
      }
      this.#activeTurn = this.#agentTurn = this.#streamTurn = null;
      this.#owners.clear(); this.#pendingNativeTools.clear();
      this.#activeIdentityCount = 0;
      this.#events.close();
      if (failures.length) throw this.#cleanupFailure ?? new AggregateError(failures, "Pi cleanup failed");
    })();
    return this.#closing;
  }

  #clearTurnIdleTimer(): void {
    clearTimeout(this.#turnIdleTimer);
    this.#turnIdleTimer = undefined;
  }

  #armTurnIdleTimer(): void {
    this.#clearTurnIdleTimer();
    const turn = this.#activeTurn;
    // Prompt acceptance has its own deadline. Any unresolved native execution
    // (including nested IDs) or admitted host callback is activity even without
    // output. A socket/queued peer alone cannot keep Pi alive.
    if (this.#closed || this.#failure || !turn || turn.settled || this.#promptAcceptance || this.#turnIdleRecovery || this.#pendingNativeTools.size || this.#callbacks?.activeCount()) return;
    this.#turnIdleTimer = setTimeout(() => {
      this.#turnIdleTimer = undefined;
      // Keep next-turn admission behind abort settlement, while the independent
      // event pump remains free to consume agent_settled.
      void this.#serialize(() => this.#expireTurnIdle(turn)).catch(() => undefined);
    }, this.#turnIdleTimeoutMs);
    this.#turnIdleTimer.unref();
  }

  async #expireTurnIdle(turn: PiTurnState): Promise<void> {
    if (this.#closed || this.#failure || turn.settled || this.#activeTurn !== turn || this.#pendingNativeTools.size || this.#callbacks?.activeCount()) return;
    const detail = { code: "pi_turn_idle_timeout", message: `Pi emitted no events for ${this.#turnIdleTimeoutMs} ms during the active turn.`, recoverable: false };
    const settled = new Promise<boolean>(resolve => { this.#turnIdleRecovery = { settle: resolve }; });
    this.#callbacks?.fence();
    let nativeSettled = false;
    // An ACK is not settlement; conversely a lost ACK cannot invalidate an
    // observed agent_settled. Bound and observe both waits without resending.
    const abort = this.#transport.request("abort", {}, { timeoutMs: PI_TURN_IDLE_ABORT_TIMEOUT_MS }).catch(() => undefined);
    try {
      try { nativeSettled = await withTimeout(settled, PI_TURN_IDLE_ABORT_TIMEOUT_MS, "Pi idle abort did not settle"); }
      catch { /* Only an unresponsive abort requires physical retirement. */ }
      await abort;
      if (!this.#closed) await this.#finishTurn(turn, "failed", { error: detail });
    } catch {
      nativeSettled = false; // Uncertain capability cleanup also retires Pi.
      this.#emit("turn.failed", { status: "failed", error: detail }, turn);
    } finally {
      this.#turnIdleRecovery = undefined;
      // No session-level failure: a settled abort leaves this session usable.
      // Retirement never deletes #sessionFile; the next open resumes it using
      // the same normalizedSessionId and native provider conversation identity.
      if (!nativeSettled || this.#transport.exited) await this.close().catch(() => undefined);
    }
  }

  async #pump(): Promise<void> {
    try {
      for await (const record of this.#transport.events()) {
        if (this.#closed || this.#failure) break;
        // Activity is the native event, not its display projection: hidden
        // thinking, tool progress, retries and compaction all reset the deadline.
        // Reset before awaiting projection/IPC, then reconcile execution below.
        this.#armTurnIdleTimer();
        await this.#consume(record);
        // Inspect execution state AFTER the event: start pauses immediately;
        // the last matching end starts a fresh silence budget.
        this.#armTurnIdleTimer();
      }
    } catch (error) {
      if (this.#turnIdleRecovery) { this.#turnIdleRecovery.settle(false); return; }
      if (!this.#closed) {
        this.#callbacks?.fence();
        const turn = error instanceof PiProjectionFailure ? error.turn : this.#activeTurn;
        const failure = error instanceof PiProjectionFailure ? error.failure : error;
        this.#failure = failure instanceof Error ? failure : new Error(String(failure));
        this.#admitted = false;
        const detail = { code: "pi_rpc_transport_failed", message: this.#failure.message, recoverable: false };
        // Publish the original cause BEFORE any awaited revocation/close can
        // throw or drain the queue. A stale projector never borrows current IDs.
        this.#emit("session.failed", detail, turn ?? { runId: this.#runId });
        try {
          if (turn && !turn.settled) await this.#finishTurn(turn, "failed", { error: detail });
          else await this.#revokeBinding();
        } catch {
          // The original failure is already published; cleanup cannot mask it.
        } finally {
          this.#events.close(this.#failure);
          await this.close().catch(() => undefined);
        }
      }
    }
    // EOF during abort also requires retirement, without reclassifying the
    // expired input as a session failure or waiting the entire abort budget.
    this.#turnIdleRecovery?.settle(false);
  }

  async #consume(event: PiRpcRecord): Promise<void> {
    if (event.type === "extension_error" && event.event === "session_start") {
      // Startup diagnostics precede any turn. Publish at session scope instead
      // of losing them to the turn-origin gate below. Transport bounds count.
      this.#emit("harness.diagnostic", { code: "pi_extension_startup_failed", event: "session_start",
        extensionPath: typeof event.extensionPath === "string" ? event.extensionPath.slice(0, 1024) : "",
        message: typeof event.error === "string" ? event.error.slice(0, 2048) : "Extension startup failed" });
      return;
    }
    const acceptance = this.#promptAcceptance;
    // A known old receipt already has an owner; prompt disposition must not
    // discard it or make it borrow the pending input's origin.
    const knownOwner = acceptance && piRecordIdentityKeys(event).some(key => this.#owners.has(key) || this.#retiredIdentities.has(key));
    if (acceptance && !knownOwner && event.type !== "process_exit" && event.type !== "transport_error" && !(await acceptance)) return;
    if (this.#turnIdleRecovery) {
      // Abort-drain events still belong to the expired input, never a queued
      // next turn. Keep its timeout classification even if Pi exits instead
      // of settling; only native settlement permits warm-session reuse.
      if (event.type === "agent_settled") this.#turnIdleRecovery.settle(true);
      else if (event.type === "process_exit" || event.type === "transport_error") this.#turnIdleRecovery.settle(false);
      return;
    }
    if (event.type === "process_exit" || event.type === "transport_error") {
      const code = event.type === "process_exit" ? "pi_process_exited" : "pi_rpc_transport_failed";
      this.#callbacks?.fence();
      const message = typeof event.message === "string" ? event.message : event.type === "process_exit"
        ? `Pi RPC process exited (code=${event.code ?? "null"}, signal=${event.signal ?? "none"})` : code;
      this.#failure = new Error(message);
      this.#admitted = false;
      const turn = this.#activeTurn;
      const detail = { code, message, recoverable: false };
      this.#emit("session.failed", detail, turn ?? { runId: this.#runId });
      try {
        if (turn) await this.#finishTurn(turn, "failed", { error: detail });
        else await this.#revokeBinding();
      } finally { await this.close(); }
      return;
    }
    if (event.type === "agent_start") {
      // Pi 1.5.2 rpc.md/json.md: retries, overflow recovery and queued
      // continuations can start another low-level run before agent_settled.
      // Only an observed agent_end within this admitted prompt permits it.
      if ((!this.#admitted && !this.#activeTurn?.cancelRequested) || !this.#activeTurn || (this.#agentTurn && !this.#activeTurn.agentEnded)) {
        this.#callbacks?.fence();
        this.#failure = new Error("Pi started work without an admitted prompt");
        this.#admitted = false;
        if (this.#activeTurn) await this.#finishTurn(this.#activeTurn, "failed", { error: { code: "pi_unrequested_agent_start" } });
        else await this.#revokeBinding();
        this.#emit("session.failed", { code: "pi_unrequested_agent_start" });
        void this.close().catch(() => undefined);
      } else {
        this.#agentTurn = this.#activeTurn;
        this.#activeTurn.agentEnded = false;
      }
      return;
    }
    const keys = piRecordIdentityKeys(event);
    // A delayed terminal can clear its captured park blocker without reviving
    // a settled projector. Conflicting/unknown extra identities cannot clear
    // it: retain the same fail-closed provenance rule as event projection.
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      const pending = this.#pendingNativeTools.get(event.toolCallId);
      const toolKeys = piToolIdentityKeys(event.toolCallId);
      const unambiguous = pending && keys.every(key => {
        const owner = this.#owners.get(key);
        return toolKeys.includes(key) || (owner?.runId === pending.runId && owner.turnId === pending.turnId);
      });
      if (unambiguous && (event.toolName === undefined || pending.toolName === event.toolName)) {
        this.#pendingNativeTools.delete(event.toolCallId);
        if (pending.runId !== this.#activeTurn?.runId || pending.turnId !== this.#activeTurn?.turnId) {
          // Settlement released the original projector, not this outstanding
          // tool's captured attribution. Its exact final receipt is display
          // only: never remember IDs, announce execution, or revive authority.
          // A fresh projector preserves canonical item IDs without retaining
          // old arguments/text/usage. Only terminal outputs may cross this path.
          try {
            const projector = createPiEventProjector(pending);
            for (const mapped of projector.project({ ...event, toolName: pending.toolName, args: undefined })) {
              if (["item.completed", "item.failed", "tool.execution.completed"].includes(mapped.eventType)) this.#emit(mapped.eventType, mapped.payload, mapped, mapped.itemId);
            }
          } catch { /* A malformed stale display receipt cannot fail a new turn. */ }
          return;
        }
      }
    }
    let turn: PiTurnState | null = null;
    if (event.type === "extension_ui_request") {
      await this.#captureUi(event, keys);
      return;
    }
    let known = false;
    for (const key of keys) {
      if (!this.#owners.has(key)) {
        if (this.#retiredIdentities.has(key)) return;
        continue;
      }
      const owner = this.#owners.get(key)!;
      if (!owner || (turn && turn !== owner)) return; // ambiguous: never guess
      turn = owner;
      known = true;
    }
    if (event.type === "message_start" && ["assistant", "user"].includes(String(record(event.message).role))) {
      // A new native message may be announced only within the prompt's captured
      // agent lifecycle. Later callbacks use this binding, not active run state.
      turn ??= keys.length > 0 && !known ? this.#agentTurn : null;
      if (!turn || turn.settled) return;
      this.#remember(keys, turn);
      if (record(event.message).role === "assistant") this.#streamTurn = turn;
    } else if (!turn && event.type === "tool_execution_start" && keys.length > 0 && keys.every(key => key.startsWith("tool:")) && !known) {
      // Native execution_start is the announcement source. Initial tool IDs can
      // arrive without message IDs; retain that captured lifecycle owner.
      if (!Object.hasOwn(event, "origin") || (validateOrigin(event.origin) && this.#callbacks?.authority.accept(event.origin))) turn = this.#agentTurn;
    } else if (!turn && keys.length === 0) {
      // Pi's actual RPC deltas have no message ID. Their sole valid owner is
      // the message_start stream scope, cleared at message_end/settlement.
      if (event.type === "message_update") turn = this.#streamTurn;
      else if (!["tool_execution_start", "tool_execution_update", "tool_execution_end", "message_end"].includes(String(event.type))) turn = this.#agentTurn;
    }
    if (!turn) return;
    if (!this.#remember(keys, turn)) return;
    if (event.type === "tool_execution_start" && !turn.settled) {
      turn.hasToolCalls = true;
      if (typeof event.toolCallId === "string") {
        // These are genuine unresolved park blockers, not settled history. Do
        // not forget a blocker (or grow forever) if Pi never sends its receipt.
        if (!this.#pendingNativeTools.has(event.toolCallId) && this.#pendingNativeTools.size >= 65_536) throw new Error("Pi unresolved native tool limit exceeded");
        this.#pendingNativeTools.set(event.toolCallId, { runId: turn.runId, turnId: turn.turnId, toolName: typeof event.toolName === "string" ? event.toolName : undefined });
      }
      const captured = this.#callbacks?.authority.capture();
      if (captured && captured.runId === turn.runId && captured.turnId === turn.turnId) this.#callbacks?.announce(event, captured);
    }
    const update = record(event.assistantMessageEvent);
    if (event.type === "message_update" && update.type === "text_delta" && typeof update.delta === "string") turn.lastText += update.delta;
    const message = record(event.message);
    if (event.type === "message_end" && message.role === "assistant") {
      const text = assistantText(message.content);
      // The final receipt supersedes streamed/earlier text. Mandatory usage is
      // accounting only, never proof of an answer or accepted completion.
      turn.lastText = text;
      turn.lastAssistantStopReason = stringValue(message.stopReason);
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      if (failed) capturePiProviderFailure(turn, message);
      else if (text.trim() || (Array.isArray(message.content) && message.content.some(part => isRecord(part) && part.type === "toolCall")) || message.stopReason === "length") {
        // A real successful retry supersedes a transient failure. An empty
        // receipt is not proof of recovery and must not erase its diagnosis.
        turn.failed = false;
        turn.lastErrorMessage = undefined;
      }
      if (this.#streamTurn === turn) this.#streamTurn = null;
      // Bind full native tool IDs before execution callbacks can arrive.
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (isRecord(part) && part.type === "toolCall") {
          turn.hasToolCalls = true;
          this.#remember(piToolIdentityKeys(part.id), turn);
        }
      }
    }
    if (event.type === "message_update") {
      if (update.type === "toolcall_start") this.#remember(piToolIdentityKeys(update.id), turn);
      if (update.type === "toolcall_end") this.#remember(piToolIdentityKeys(record(update.toolCall).id), turn);
    }
    if (event.type === "message_update" && update.type === "error") {
      capturePiProviderFailure(turn, { ...record(update.error), stopReason: update.reason });
    }
    if (event.type === "error" || event.type === "auto_retry_start" || (event.type === "auto_retry_end" && event.success === false)) {
      capturePiProviderFailure(turn, { ...event, errorMessage: event.finalError ?? event.errorMessage ?? event.message });
    }
    if (event.type === "agent_end") {
      // Pi 1.5.2 can carry the failed assistant receipt here, with optional
      // errorMessage. Inspect only this low-level run's final assistant.
      const final = Array.isArray(event.messages) ? event.messages.findLast(message => isRecord(message) && message.role === "assistant") : undefined;
      if (isRecord(final) && (final.stopReason === "error" || final.stopReason === "aborted")) capturePiProviderFailure(turn, final);
      turn.agentEnded = true;
      if (this.#streamTurn === turn) this.#streamTurn = null;
    }
    try {
      for (const mapped of turn.projector.project(event)) this.#emit(mapped.eventType, mapped.payload, mapped, mapped.itemId);
    } catch (error) { throw new PiProjectionFailure(turn, error); }
    if (event.type === "agent_settled") {
      // A captured, still-pending dialog is an accepted wait, not an answer.
      // Tool-only semantic finish/block turns likewise need no fabricated text.
      const waiting = [...this.#dialogs.values()].some(dialog => dialog.turn === turn
        && (dialog.expiresAt === undefined || this.#now().getTime() < dialog.expiresAt));
      const empty = !turn.lastText.trim() && !turn.hasToolCalls && !waiting;
      // A length receipt is incomplete even with text/mandatory usage. Judge
      // only the final receipt, after Pi has exhausted native recovery.
      const truncated = turn.lastAssistantStopReason === "length";
      const status = event.aborted === true || turn.cancelRequested ? "cancelled" : turn.failed || truncated || empty ? "failed" : "completed";
      const error = truncated ? { code: "pi_output_truncated", message: "Pi's final assistant response reached its output limit.", recoverable: false }
        : turn.failed ? { code: "pi_provider_error", message: turn.lastErrorMessage ?? "Pi provider failed without an error message." }
        : empty ? { code: "opencode_empty_response", message: "Pi ended without a final answer or an accepted completion report.", recoverable: false } : undefined;
      await this.#finishTurn(turn, status, { piAgentSettled: true, ...(error && status === "failed" ? { error } : {}) });
      if (this.#nativeAbortSettled?.turn === turn) this.#nativeAbortSettled.resolve();
    }
  }

  #remember(keys: string[], turn: PiTurnState): boolean {
    for (const key of keys) {
      if (!this.#owners.has(key)) {
        if (this.#retiredIdentities.has(key)) return false;
        // This is a per-prompt display budget, NOT a warm-session fuse. All
        // provenance/session/effect gates remain unchanged. Budget exhaustion
        // drops only the unrouteable display record with an explicit marker.
        if (this.#activeIdentityCount >= 65_536) {
          if (!this.#identityLimited) this.#emit("harness.diagnostic", { code: "pi_native_identity_projection_limit", message: "[Pi projection truncated]: turn identity budget reached." }, turn);
          this.#identityLimited = true;
          return false;
        }
        this.#owners.set(key, turn);
        this.#activeIdentityCount++;
      } else if (this.#owners.get(key) !== turn) this.#owners.set(key, null);
    }
    return true;
  }

  async #finishTurn(turn: PiTurnState, status: "completed" | "failed" | "cancelled", extra: Record<string, unknown>): Promise<void> {
    if (turn.settled) return;
    turn.settled = true;
    if (this.#activeTurn === turn) this.#clearTurnIdleTimer();
    // Fence host authority synchronously; native extension fences on the same
    // agent_settled boundary. Do not publish a terminal until revocation finishes.
    const captured = this.#callbacks?.authority.capture();
    if (captured?.runId === turn.runId && captured.turnId === turn.turnId) this.#callbacks?.fence();
    for (const [id, dialog] of this.#dialogs) if (dialog.turn === turn) this.#dialogs.delete(id);
    for (const [key, owner] of this.#owners) if (owner === turn || owner === null) {
      this.#retiredIdentities.add(key);
      this.#owners.delete(key);
    }
    this.#activeIdentityCount = 0; this.#identityLimited = false;
    if (this.#resident) this.#admitted = false;
    if (this.#agentTurn === turn) this.#agentTurn = null;
    if (this.#streamTurn === turn) this.#streamTurn = null;
    if (this.#resident) await this.#revokeBinding();
    if (this.#activeTurn === turn) this.#activeTurn = null;
    const eventType = status === "completed" ? "turn.completed" : status === "cancelled" ? "turn.cancelled" : "turn.failed";
    this.#emit(eventType, { status, ...extra }, turn);
  }

  #emit(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, origin: { runId: string; turnId?: string; debug?: PrpEvent["debug"] } = { runId: this.#runId }, itemId?: string): void {
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
      ...(origin.debug === undefined ? {} : { debug: structuredClone(origin.debug) }),
    };
    if (!this.#events.push(event)) {
      this.#events.close(new Error("Pi RPC PRP event queue exceeded its limit"));
      void this.close().catch(() => undefined);
    }
  }
}

/** Exact module-relative layouts only: the unbundled driver and the verified
 * CLI bundle. No cwd, ambient extension path, or raw-CJS argv fallback. */
async function resolveOwnedPiExtension(moduleUrl: unknown): Promise<string> {
  if (typeof moduleUrl === "string" && moduleUrl.startsWith("file:")) {
    for (const relative of ["./extension/index.js", "./extension/index.ts", "../drivers/pi/extension/index.js", "../drivers/pi/extension/index.ts"]) {
      try {
        const path = await realpath(fileURLToPath(new URL(relative, moduleUrl)));
        if ((await stat(path)).isFile()) return path;
      } catch { /* Try only the next exact, module-relative owned layout. */ }
    }
  }
  throw new Error("Pi owned extension entrypoint unavailable; CJS requires the verified entrypoint URL");
}

/** Host-private semantic join. The callback server owns framing, bounded waits,
 * cancellation and dispatchPiToolCall's consume/post-await checks. This owner
 * supplies only real native announcements and exact execution payload matching. */
class PiHostCallbacks {
  readonly authority = new RunAuthority();
  readonly #sessionId: string;
  #nativeSessionId: string | null = null;
  readonly #handler?: PiRpcDriverOptions["dynamicToolHandler"];
  #server?: Awaited<ReturnType<typeof startPiCallbackServer>>;
  readonly #announcements = new Map<string, { origin: Readonly<Origin>; tool: string; arguments: unknown }>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #toolNames: Record<string, string> = Object.create(null);
  #activeCount = 0;
  #activityListener?: () => void;
  setActivityListener(listener: () => void): void { this.#activityListener = listener; }
  activeCount(): number { return this.#activeCount; }
  constructor(sessionId: string, handler: PiRpcDriverOptions["dynamicToolHandler"]) { this.#sessionId = sessionId; this.#handler = handler; }
  setNativeSessionId(id: string): void { if (this.#nativeSessionId !== null) throw new Error("Pi callback identity already assigned"); this.#nativeSessionId = id; }
  async listen(socketPath: string, timeoutMs = 60000): Promise<void> {
    this.#server = await startPiCallbackServer({ socketPath, sessionId: this.#sessionId, authority: this.authority, timeoutMs,
      waitForAnnouncement: (call, signal) => this.#wait(call, signal),
      handleTool: async (call, signal) => {
        if (!this.#handler || !this.#nativeSessionId || !this.#matches(call) || !this.authority.accept(call.origin, call.toolCallId)) throw new Error("Pi tool callback refused");
        const { runId, turnId } = call.origin;
        let active = true;
        const finished = () => { if (active) { active = false; --this.#activeCount; this.#activityListener?.(); } };
        ++this.#activeCount;
        this.#activityListener?.();
        signal.addEventListener("abort", finished, { once: true });
        try {
          signal.throwIfAborted();
          const result = await this.#handler({ runId, turnId, threadId: this.#nativeSessionId, tool: Object.hasOwn(this.#toolNames, call.tool) ? this.#toolNames[call.tool]! : call.tool, callId: call.toolCallId, arguments: structuredClone(call.arguments), signal });
          signal.throwIfAborted();
          if (!this.#matches(call) || !this.authority.accept(call.origin, call.toolCallId)) throw new Error("Pi tool callback refused");
          return normalizePiToolResult(result);
        } finally { signal.removeEventListener("abort", finished); finished(); }
      },
    });
  }
  activate(origin: Origin, toolNames: Record<string, string>): void { this.#toolNames = structuredClone(toolNames); this.authority.bind(origin); this.authority.beginTurn(origin); }
  fence(): void { this.authority.end(); this.#announcements.clear(); for (const set of this.#waiters.values()) for (const wake of set) wake(); }
  pendingCount(): number { return this.#server?.pendingCount() ?? 0; }
  async close(): Promise<void> { this.fence(); await this.#server?.close(); }
  announce(event: PiRpcRecord, origin: Origin): void {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string" || !Object.hasOwn(event, "args") || !this.authority.accept(origin)) return;
    const previous = this.#announcements.get(event.toolCallId);
    if (previous) {
      if (previous.tool !== event.toolName || !sameJson(previous.arguments, event.args)) this.fence();
      return;
    }
    if (!this.authority.announce(event.toolCallId, origin)) return;
    this.#announcements.set(event.toolCallId, { origin: Object.freeze({ ...origin }), tool: event.toolName, arguments: structuredClone(event.args) });
    for (const wake of this.#waiters.get(event.toolCallId) ?? []) wake();
  }
  #matches(call: PiToolCallRequest): boolean {
    const announced = this.#announcements.get(call.toolCallId);
    return !!announced && sameJson(announced.origin, call.origin) && announced.tool === call.tool && sameJson(announced.arguments, call.arguments);
  }
  async #wait(call: PiToolCallRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.authority.accept(call.origin)) throw new Error("Pi tool callback refused");
    if (!this.#announcements.has(call.toolCallId)) {
      await new Promise<void>((resolve, reject) => {
        const set = this.#waiters.get(call.toolCallId) ?? new Set<() => void>();
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new Error("Pi tool callback refused")); };
        const cleanup = () => { set.delete(wake); if (!set.size) this.#waiters.delete(call.toolCallId); signal.removeEventListener("abort", abort); };
        set.add(wake); this.#waiters.set(call.toolCallId, set); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    if (!this.authority.accept(call.origin, call.toolCallId) || !this.#matches(call)) throw new Error("Pi tool callback refused");
  }
}

function normalizePiToolResult(value: unknown): PiToolResult {
  // Snapshot plain JSON before trusting even a controller's result. No toJSON,
  // image coercion, arbitrary stringification, or success-by-default fallback.
  const captured: unknown = structuredClone(value);
  if (validatePiToolResult(captured)) return captured;
  if (!isRecord(captured) || !Array.isArray(captured.contentItems) || typeof captured.success !== "boolean" || captured.contentItems.length > 128) throw new Error("Pi tool result refused");
  const content = captured.contentItems.map(item => {
    if (!isRecord(item) || !["text", "inputText", "outputText"].includes(String(item.type)) || typeof item.text !== "string") throw new Error("Pi tool result refused");
    return { type: "text" as const, text: item.text };
  });
  return { content, details: {}, isError: !captured.success };
}
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  try { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); } catch { return false; }
}

function bindingContext(baseInstructions: string, tools: readonly Readonly<Record<string, unknown>>[] | readonly PiDynamicTool[] | undefined, runtimeContext: unknown, previous?: PiRunContext): PiRunContext {
  if (typeof baseInstructions !== "string" || (tools !== undefined && !Array.isArray(tools))) throw new Error("Pi binding context rejected");
  // Freeze serializable context NOW. Never hash one object then look it up again
  // from a mutable caller when the request is eventually admitted.
  const contextJson = runtimeContext === undefined ? undefined : JSON.stringify(runtimeContext);
  if (runtimeContext !== undefined && contextJson === undefined) throw new Error("Pi runtime context is not serializable");
  const frozenContext: unknown = contextJson === undefined ? undefined : JSON.parse(contextJson);
  const normalized = tools === undefined && previous
    ? { tools: previous.tools, toolNames: previous.toolNames, diagnostics: previous.diagnostics }
    : normalizePiDynamicTools(tools ?? []);
  return { baseInstructions, runtimeContext: frozenContext,
    instructions: contextJson === undefined ? baseInstructions : `${baseInstructions}\n\n<runtime_context>\n${contextJson}\n</runtime_context>`, ...normalized };
}

async function cleanPiPrivateDirectory(resident: Pick<PiResidentState, "socketPath" | "directory">): Promise<void> {
  // Only this allocation's private IPC endpoint/root; NEVER delete session JSONL.
  await unlink(resident.socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  await unlink(join(resident.directory, "initial.json")).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  await rmdir(resident.directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}

function capturePiProviderFailure(turn: PiTurnState, message: Record<string, unknown>): void {
  turn.failed = true;
  turn.lastErrorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage : turn.lastErrorMessage ?? `Pi provider ended with ${typeof message.stopReason === "string" ? message.stopReason : "an error"}.`;
}

function piNativeIdentity(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 4096) return `s:${createHash("sha256").update(value).digest("hex")}`;
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
    keys.push(`stamp:${createHash("sha256").update(JSON.stringify([message.role, message.provider, message.model, message.timestamp])).digest("hex")}`);
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
