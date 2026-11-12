#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  HarnessDriver,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestResolution,
  HarnessSession,
  PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import { PiRpcDriver } from "../drivers/pi/pi-rpc-driver.js";
import { parseNativeRuntimeContext } from "../contracts/runtime-context.js";
import {
  openCodeProxyItemNotification,
  openCodeProxyTerminalNotification,
  openCodeProxyToolNotification,
  shouldAnnounceOpenCodeProxyTurn,
} from "./opencode-proxy-events.js";
import { enqueueOpenCodeProxyInput } from "./opencode-proxy-input.js";
import {
  createBackpressuredFrameWriter,
  createOpenCodeProxyOutput,
} from "./opencode-proxy-output.js";
import { createOpenCodeProxyControllerRequests } from "./opencode-proxy-controller.js";
import { trustedPiLaunchBinding, withoutAmbientPiCommand } from "./pi-proxy-command.js";

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export interface PiRpcProxyFrameSink {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

export interface PiRpcDriverLaunchConfig {
  model: string;
  command: string;
  commandFd?: number;
  trustedProxyEntrypointUrl?: string;
  commandLifecycle?: {
    beforeSpawn(): void;
    afterSpawn(): void;
    afterExit(): void;
  };
  runtimeDirectory: string;
  environment: NodeJS.ProcessEnv;
  runnerInstanceId: string;
  piThinkingLevel?: PiThinkingLevel;
  systemInstructions: string;
  runtimeContext: ReturnType<typeof parseNativeRuntimeContext> | null;
  dynamicTools: Record<string, unknown>[];
  durableToolRequests: true;
  dynamicToolHandler(call: {
    readonly runId: string;
    readonly turnId: string;
    callId: string | number;
    tool: string;
    arguments: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
  isolateProcessGroup: false;
}

// Pi's resident-run refresh and admission remain local to its facade/driver;
// other HarnessSession implementations need not adopt provider-specific inputs.
type PiRpcRunAttachment = Parameters<NonNullable<HarnessSession["attachRun"]>>[0] & {
  baseInstructions?: string;
  dynamicTools?: Record<string, unknown>[];
  runtimeContext?: ReturnType<typeof parseNativeRuntimeContext> | null;
};
type PiRpcRuntimeResolution = Parameters<NonNullable<HarnessSession["resolveRuntimeRequest"]>>[0] & {
  runId: string;
  origin?: HarnessRuntimeRequest["origin"];
};
type PiRpcProxySession = Omit<HarnessSession, "attachRun" | "resolveRuntimeRequest"> & {
  attachRun?(input: PiRpcRunAttachment): Promise<void> | void;
  resolveRuntimeRequest?(input: PiRpcRuntimeResolution): Promise<void>;
  revalidateAfterClaim?(): Promise<void> | void;
  reconnect?(): Promise<void> | void;
  parkReady?(): Promise<{ ready: boolean; reasons: string[] }>;
};

export interface PiRpcAppServerProxyOptions {
  stdout: PiRpcProxyFrameSink;
  /** Injection point for protocol tests; production uses PiRpcDriver. */
  createDriver?(config: PiRpcDriverLaunchConfig): HarnessDriver;
  environment?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  writeStderr?(message: string): void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Display-only bound: at most 8K UTF-16 units (even JSON control escapes
 * remain under 64KiB). Native records, final receipts and spill files are untouched. */
function piPartialToolPayload(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (eventType !== "tool.execution.progressed" && !(eventType === "item.delta" && ["tool", "commandExecution"].includes(String(payload.kind)))) return payload;
  const bound = (value: unknown) => {
    if (typeof value !== "string" || value.length <= 8192) return value;
    let end = 8192;
    if (value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
    return `${value.slice(0, end)}\n[Pi tool output truncated for display]`;
  };
  const item = record(payload.item);
  return { ...payload, ...(payload.output === undefined ? {} : { output: bound(payload.output) }),
    ...(payload.text === undefined ? {} : { text: bound(payload.text) }),
    ...(payload.item === undefined ? {} : { item: { ...item,
      ...(item.output === undefined ? {} : { output: bound(item.output) }),
      ...(item.text === undefined ? {} : { text: bound(item.text) }),
    } }),
  };
}

function requestIdentity(value: unknown): string {
  // Native request ids may be numeric, including zero. Normalize once rather
  // than treating zero as absent or falling back to another request's id.
  return typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
}

const PI_TOOL_ALIAS_PREFIX = "pi_tool_";

// Lookup: take nativeToolCallId from Pi's kept session trace and recompute its SHA alias with the original run/native-session inputs.
function controllerToolCallId(callId: string | number, runId: string, nativeSessionId: string): string | number {
  // Preserve existing malformed/non-string refusal at its owning boundary.
  if (typeof callId !== "string" || !callId) return callId;
  // Reserve the entire alias namespace, including otherwise-valid native IDs,
  // so a native spelling cannot impersonate another call's generated alias.
  if (!callId.startsWith(PI_TOOL_ALIAS_PREFIX)
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/.test(callId)) return callId;
  if (typeof runId !== "string" || !runId || typeof nativeSessionId !== "string" || !nativeSessionId) {
    throw new Error("Pi tool alias requires captured run and admitted native session identity");
  }
  // Stable across reopened native sessions and independent of RPC count, turn,
  // epoch and arguments, preserving the controller's durable replay/conflicts.
  // Full SHA-256 is collision-resistant, not an injection over arbitrary IDs.
  return PI_TOOL_ALIAS_PREFIX + createHash("sha256")
    .update("paperclip.pi.tool-call-id\0")
    .update(JSON.stringify(["v1", runId, nativeSessionId, callId]))
    .digest("hex");
}

export function parsePiThinkingLevel(value: unknown): PiThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PI_THINKING_LEVELS.has(value as PiThinkingLevel)) {
    throw new Error("Pi thinking level must be off|minimal|low|medium|high|xhigh|max");
  }
  return value as PiThinkingLevel;
}

function assertPiCollaborationMode(params: Record<string, unknown>): void {
  const collaborationMode = record(params.collaborationMode);
  if (Object.keys(collaborationMode).length === 0 || collaborationMode.mode === "default") return;
  throw new Error(`Pi RPC collaboration mode is unavailable: ${String(collaborationMode.mode)}`);
}

function parseRpcMessage(line: string): RpcMessage | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as RpcMessage
      : null;
  } catch {
    return null;
  }
}

function runtimeDirectory(environment: NodeJS.ProcessEnv): string {
  const configured = environment.PAPERCLIP_PI_RUNTIME_DIR?.trim();
  if (!configured) throw new Error("PAPERCLIP_PI_RUNTIME_DIR is required");
  return resolve(configured);
}

/** A process-independent facade implementation, with the native driver behind HarnessDriver. */
export function createPiRpcAppServerProxy(options: PiRpcAppServerProxyOptions) {
  const environment = options.environment ?? process.env;
  const launchBinding = options.createDriver ? null : trustedPiLaunchBinding(options.argv ?? process.argv.slice(2));
  const stdoutFrames = createBackpressuredFrameWriter(options.stdout);
  const output = createOpenCodeProxyOutput((frame, frameOptions) => stdoutFrames.write(frame, frameOptions));
  const send = output.send;
  const controller = createOpenCodeProxyControllerRequests(send);
  const requestController = controller.request;
  let session: PiRpcProxySession | null = null;
  let eventPump: Promise<void> | null = null;
  let pendingInput = Promise.resolve();
  let bootstrapFailure: Error | null = null;
  let cwd = "";
  let activeModel = "";
  let activeTurnId: string | null = null;
  let activeRunId = environment.PAPERCLIP_RUN_ID ?? "runnerd-run";
  let inputEnded = false;
  const announcedTurnIds = new Set<string>();
  const usageTotals: Record<string, number> = {};
  const usageByTurn = new Map<string, {
    receipts: Map<string, string>;
    total: Record<string, number>;
    complete: boolean;
  }>();

  const log = (message: string) => options.writeStderr?.(message);

  function threadResponse(id: string): Record<string, unknown> {
    return { thread: { id, sessionId: id, cwd }, model: activeModel };
  }

  function announceTurnStarted(opened: HarnessSession, turnId: string): void {
    if (!shouldAnnounceOpenCodeProxyTurn(announcedTurnIds, turnId)) return;
    send({
      method: "turn/started",
      params: {
        threadId: opened.ids().driverSessionId,
        turnId,
        turn: { id: turnId, status: "inProgress" },
      },
    });
  }

  function assertCallbackAuthority(opened: PiRpcProxySession | null, runId: unknown, turnId: unknown): asserts opened is PiRpcProxySession {
    if (typeof runId !== "string" || !runId || typeof turnId !== "string" || !turnId) {
      throw new Error("Pi callback requires captured run and turn identity");
    }
    if (inputEnded || !opened || session !== opened || runId !== activeRunId) {
      throw new Error("Pi callback has stale run authority");
    }
  }

  async function attachRun(params: Record<string, unknown>, runId: unknown): Promise<void> {
    if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
      throw new Error("Invalid Paperclip run identity");
    }
    const opened = session;
    if (!opened?.attachRun) throw new Error("Pi RPC run attachment unavailable");
    const input: PiRpcRunAttachment = { runId };
    if (params.baseInstructions !== undefined) {
      if (typeof params.baseInstructions !== "string") throw new Error("Pi baseInstructions must be a string");
      input.baseInstructions = params.baseInstructions;
    }
    if (params.dynamicTools !== undefined) {
      if (!Array.isArray(params.dynamicTools)) throw new Error("Pi dynamicTools must be an array");
      input.dynamicTools = params.dynamicTools.map(record);
    }
    if (params.runtimeContext !== undefined) {
      input.runtimeContext = params.runtimeContext === null ? null : parseNativeRuntimeContext(params.runtimeContext);
    }
    // The driver admits/rebinds the native session before the facade publishes
    // the new run. A failed admission must leave the old identity in place.
    await opened.attachRun(input);
    if (inputEnded || session !== opened) throw new Error("Pi RPC session closed during run attachment");
    activeRunId = runId;
  }

  function reportUsage(opened: PiRpcProxySession, event: {
    runId: string; turnId?: string; itemId?: string;
  }, payload: Record<string, unknown>): void {
    const delta = record(payload.runDelta);
    const cumulative = record(payload.cumulative);
    let total = cumulative;
    let last = delta;
    let complete = payload.runDeltaAvailable === true && payload.accountingComplete !== false;
    if (Object.keys(cumulative).length === 0) {
      // Pi's final receipts are per MESSAGE, whereas Codex/Rust `last` is a
      // TURN snapshot. Keep one ledger keyed by captured run/turn and receipt,
      // including settled turns so late replay cannot charge a message twice.
      const turnKey = JSON.stringify([event.runId, event.turnId]);
      const turn = usageByTurn.get(turnKey) ?? { receipts: new Map<string, string>(), total: {} as Record<string, number>, complete: true };
      const wasComplete = turn.complete;
      const receiptId = text(payload.providerRequestId) || text(event.itemId);
      turn.complete &&= complete && !!event.turnId && !!receiptId;
      usageByTurn.set(turnKey, turn);
      if (receiptId) {
        const fingerprint = JSON.stringify(Object.entries(delta).sort(([left], [right]) => left.localeCompare(right)));
        const previous = turn.receipts.get(receiptId);
        if (previous !== undefined) {
          if (previous !== fingerprint) throw new Error("pi_proxy_conflicting_usage_receipt");
          if (turn.complete === wasComplete) return;
        } else {
          turn.receipts.set(receiptId, fingerprint);
          for (const [key, value] of Object.entries(delta)) {
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
            const turnSum = (turn.total[key] ?? 0) + value;
            const sessionSum = (usageTotals[key] ?? 0) + value;
            if (!Number.isFinite(sessionSum) || (key.endsWith("Tokens") && !Number.isSafeInteger(sessionSum))) throw new Error("pi_proxy_usage_overflow");
            turn.total[key] = turnSum;
            usageTotals[key] = sessionSum;
          }
        }
      } else if (!wasComplete && Object.keys(delta).length === 0) return;
      total = { ...usageTotals };
      last = { ...turn.total };
      complete = turn.complete;
    }
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: opened.ids().driverSessionId,
        ...(typeof event.turnId === "string" ? { turnId: event.turnId } : {}),
        // Rust derives runDeltaAvailable from last's presence. Never put a
        // partial measurement there, even if some known tokens are non-zero.
        tokenUsage: { total, ...(complete ? { last } : {}) },
        cumulative: total,
        runDelta: last,
        runDeltaAvailable: complete,
        ...(payload.context === undefined ? {} : { context: record(payload.context) }),
      },
    });
  }

  async function pumpEvents(opened: PiRpcProxySession): Promise<void> {
    for await (const event of opened.events()) {
      const payload = piPartialToolPayload(event.eventType, record(event.payload));
      const toolActivity = openCodeProxyToolNotification({
        eventType: event.eventType,
        threadId: opened.ids().driverSessionId,
        turnId: event.turnId,
        payload,
      });
      if (toolActivity) {
        send(toolActivity);
      } else if (event.eventType === "turn.started") {
        if (typeof event.turnId === "string") announceTurnStarted(opened, event.turnId);
      } else if (
        event.eventType === "item.started" ||
        event.eventType === "item.delta" ||
        event.eventType === "item.completed"
      ) {
        // Facade item notifications must be bound to a turn. Do not carry
        // OpenCode's provider-specific unbound-model filtering into Pi.
        if (typeof event.turnId !== "string" || !event.turnId) continue;
        // Unaccounted summarization/child work can invalidate a previously
        // complete turn even without another assistant usage receipt.
        if (payload.kind === "usage" && record(payload.usage).runDeltaComplete === false) {
          reportUsage(opened, { runId: event.runId, turnId: event.turnId }, { runDeltaAvailable: false, accountingComplete: false });
        }
        send(openCodeProxyItemNotification({
          eventType: event.eventType,
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          payload,
        }));
      } else if (event.eventType === "usage.reported") {
        reportUsage(opened, event, payload);
      } else if (event.eventType === "run.result.proposed") {
        send({
          method: "paperclip/runResult",
          params: {
            threadId: opened.ids().driverSessionId,
            turnId: event.turnId,
            itemId: event.itemId ?? "semantic-result",
            result: payload,
          },
        });
      } else if (event.eventType === "runtime_request.created") {
        // Capture the originating projector's identity, never mutable active
        // state. Clone the presentation/origin before yielding to the controller.
        const runId = event.runId;
        const turnId = text(event.turnId);
        void (async () => {
          assertCallbackAuthority(opened, runId, turnId);
          const request = structuredClone(record(payload.request));
          const requestId = requestIdentity(request.requestId);
          if (!requestId || !opened.resolveRuntimeRequest) throw new Error("Pi runtime request is not resolvable");
          if (request.turnId !== undefined && request.turnId !== turnId) {
            throw new Error("Pi runtime request has mismatched captured turn identity");
          }
          const origin = request.origin as HarnessRuntimeRequest["origin"];
          const controllerResponse = record(await requestController("paperclip/runtimeRequest", { request }));
          assertCallbackAuthority(opened, runId, turnId);
          await opened.resolveRuntimeRequest({
            runId,
            requestId,
            turnId,
            ...(origin === undefined ? {} : { origin }),
            resolution: record(controllerResponse.resolution) as HarnessRuntimeRequestResolution,
          });
        })().catch((error) => log(`[pi_rpc] runtime request failed: ${String(error)}\n`));
      } else if (event.eventType === "session.failed") {
        // Rust maps `error` to provider.notice.recorded, retaining error.message
        // even when there is no active turn. Keep captured IDs, never invent one.
        send({ method: "error", params: {
          threadId: opened.ids().driverSessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          message: payload.message ?? payload.code,
          error: { code: payload.code, message: payload.message ?? payload.code },
          willRetry: false,
        } });
      } else if (
        event.eventType === "turn.completed" || event.eventType === "turn.failed" ||
        event.eventType === "turn.interrupted" || event.eventType === "turn.cancelled"
      ) {
        send(openCodeProxyTerminalNotification({
          eventType: event.eventType,
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          payload,
        }));
        if (event.runId === activeRunId && event.turnId === activeTurnId) activeTurnId = null;
      } else if (event.eventType === "harness.diagnostic") {
        send({
          method: "warning",
          params: {
            threadId: opened.ids().driverSessionId,
            message: payload.message ?? payload.code,
          },
        });
      }
    }
  }

  async function open(params: Record<string, unknown>, resume: boolean): Promise<Record<string, unknown>> {
    if (session) return threadResponse(session.ids().providerSessionId ?? session.ids().driverSessionId);
    cwd = resolve(text(params.cwd, process.cwd()));
    const model = text(params.model).trim();
    if (!model) throw new Error("Pi RPC proxy requires a model");
    activeModel = model;
    const dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools.map(record) : [];
    const piThinkingLevel = parsePiThinkingLevel(
      params.piThinkingLevel ?? environment.PAPERCLIP_PI_THINKING_LEVEL,
    );
    const runtimeContextPath = environment.PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH?.trim();
    const runtimeContext = runtimeContextPath
      ? parseNativeRuntimeContext(JSON.parse(readFileSync(runtimeContextPath, "utf8")))
      : null;
    const config: PiRpcDriverLaunchConfig = {
      model,
      command: launchBinding?.command ?? "",
      ...(launchBinding?.commandFd === undefined ? {} : { commandFd: launchBinding.commandFd }),
      ...(launchBinding?.trustedProxyEntrypointUrl === undefined ? {} : { trustedProxyEntrypointUrl: launchBinding.trustedProxyEntrypointUrl }),
      ...(launchBinding?.commandLifecycle === undefined ? {} : { commandLifecycle: launchBinding.commandLifecycle }),
      runtimeDirectory: options.createDriver && !environment.PAPERCLIP_PI_RUNTIME_DIR?.trim()
        ? cwd
        : runtimeDirectory(environment),
      environment: withoutAmbientPiCommand(environment),
      runnerInstanceId: environment.PAPERCLIP_RUNNER_INSTANCE_ID ?? "paperclip-runnerd-pi-rpc",
      ...(piThinkingLevel === undefined ? {} : { piThinkingLevel }),
      systemInstructions: text(params.baseInstructions, "Complete only the supplied task."),
      runtimeContext,
      dynamicTools,
      durableToolRequests: true,
      dynamicToolHandler: async (call) => {
        const opened = session;
        const { runId, turnId, callId, tool, arguments: arguments_, signal } = call;
        assertCallbackAuthority(opened, runId, turnId);
        // ids() is the already-admitted native Pi identity, not the normalized
        // host bootstrap ID. Capture before dispatch; the native await closure
        // retains the exact original callId and needs no reverse alias map.
        const nativeSessionId = opened.ids().driverSessionId;
        const controllerCallId = controllerToolCallId(callId, runId, nativeSessionId);
        const response = await requestController("item/tool/call", {
          threadId: nativeSessionId,
          turnId,
          callId: controllerCallId,
          tool,
          arguments: arguments_,
        }, true, signal);
        // The controller may answer after another run has attached to this
        // resident Pi. Never deliver that old result into the current run.
        assertCallbackAuthority(opened, runId, turnId);
        return response;
      },
      isolateProcessGroup: false,
    };
    const driver: HarnessDriver = options.createDriver?.(config)
      ?? new PiRpcDriver(config);
    let opened: PiRpcProxySession;
    if (resume) {
      const threadId = text(params.threadId);
      if (!threadId) throw new Error("Pi RPC thread/resume requires the saved native session id");
      if (!driver.recoverSession) throw new Error("Pi RPC driver does not implement session recovery");
      // The conversation's file is named by the server-owned normalized id; a
      // thread id is Pi's own session id and never names the file.
      const normalizedSessionId = environment.PAPERCLIP_NORMALIZED_SESSION_ID;
      if (!normalizedSessionId) throw new Error("Pi RPC thread/resume requires PAPERCLIP_NORMALIZED_SESSION_ID");
      const snapshot: PersistedHarnessSession = {
        driverKind: "pi_rpc",
        workingDirectory: cwd,
        driverSessionId: threadId,
        providerSessionId: threadId,
        runId: activeRunId,
        normalizedSessionId,
        activeTurnId: null,
        lastSourceSequence: 0,
      };
      let recovered: Awaited<ReturnType<NonNullable<HarnessDriver["recoverSession"]>>> | null = null;
      try {
        recovered = await driver.recoverSession(snapshot, { signal: new AbortController().signal });
      } catch (error) {
        // The box was replaced and its transcript wasn't restored: continue in
        // a fresh Pi conversation under the SAME conversation id rather than
        // failing every later message. Say so in the run log. A file that
        // exists but is invalid (pi_session_file_invalid) is still refused.
        if ((error as { code?: unknown } | null)?.code !== "pi_session_file_missing") throw error;
        process.stderr.write("[paperclip-runner] pi_session_history_missing: the saved Pi conversation file is not on this box; starting a fresh Pi conversation for the same conversation id\n");
      }
      if (recovered) {
        if (!recovered.recovered || !recovered.session) {
          throw new Error(recovered.reason ?? "Pi RPC session recovery failed");
        }
        opened = recovered.session;
      } else {
        opened = await driver.openSession({ runId: activeRunId, normalizedSessionId, workingDirectory: cwd });
      }
    } else {
      opened = await driver.openSession({
        runId: activeRunId,
        normalizedSessionId: environment.PAPERCLIP_NORMALIZED_SESSION_ID ?? `runnerd-${Date.now()}`,
        workingDirectory: cwd,
      });
    }
    // A new native thread starts a new session accounting scope. Warm
    // run.attach/turn.start must not reset its cumulative total.
    for (const key of Object.keys(usageTotals)) delete usageTotals[key];
    usageByTurn.clear();
    session = opened;
    eventPump = pumpEvents(opened);
    void eventPump.catch((error) => {
      log(`[pi_rpc] fatal proxy event pump error: ${error instanceof Error ? error.message : String(error)}\n`);
      send({ method: "warning", params: { threadId: opened.ids().driverSessionId, message: error instanceof Error ? error.message : String(error) } });
    });
    return threadResponse(opened.ids().providerSessionId ?? opened.ids().driverSessionId);
  }

  async function handle(message: RpcMessage): Promise<void> {
    if (message.method === undefined && message.id !== undefined) {
      controller.respond({ id: message.id, result: message.result, error: message.error });
      return;
    }
    if (!message.method || message.id === undefined) return;
    const params = record(message.params);
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = {
          user: { sessionId: "pi_rpc" },
          serverInfo: { name: "pi_rpc", version: "1.0.0" },
        };
        break;
      case "thread/start":
        result = await open(params, false);
        break;
      case "thread/resume":
        result = await open(params, true);
        break;
      case "turn/start": {
        if (!session) throw new Error("Pi RPC thread is not open");
        assertPiCollaborationMode(params);
        if (params.paperclipRunId !== undefined) await attachRun(params, params.paperclipRunId);
        const inputItems = Array.isArray(params.input) ? params.input.map(record) : [];
        const messageText = inputItems.map((entry) => text(entry.text)).filter(Boolean).join("\n");
        const piThinkingLevel = parsePiThinkingLevel(
          params.piThinkingLevel ?? environment.PAPERCLIP_PI_THINKING_LEVEL,
        );
        const turnInput = {
          message: { role: "user" as const, text: messageText },
          ...(piThinkingLevel === undefined ? {} : { piThinkingLevel }),
        } as Parameters<HarnessSession["startTurn"]>[0] & { piThinkingLevel?: PiThinkingLevel };
        const turn = await session.startTurn(turnInput);
        activeTurnId = turn.turnId;
        queueMicrotask(() => {
          if (session) announceTurnStarted(session, turn.turnId);
        });
        result = { turn: { id: turn.turnId, status: "inProgress" } };
        break;
      }
      case "run.attach":
        if (params.runId !== undefined && params.paperclipRunId !== undefined && params.runId !== params.paperclipRunId) {
          throw new Error("Conflicting Paperclip run identity");
        }
        await attachRun(params, params.paperclipRunId !== undefined ? params.paperclipRunId : params.runId);
        result = true;
        break;
      case "session.revalidate":
        if (!session?.revalidateAfterClaim) throw new Error("Pi RPC post-claim revalidation is unavailable");
        // The newly admitted grant, not bootstrap environment, owns this run's base.
        if (params.baseInstructions !== undefined) await attachRun(params, activeRunId);
        await session.revalidateAfterClaim();
        result = true;
        break;
      case "session.reconnect":
        if (!session?.reconnect) throw new Error("Pi RPC reconnection is unavailable");
        await session.reconnect();
        result = true;
        break;
      case "paperclip/host_park_ready":
        if (Object.keys(params).length !== 0) throw new Error("Pi host park readiness takes no parameters");
        if (!session?.parkReady) throw new Error("Pi host park readiness unavailable");
        result = await session.parkReady();
        break;
      case "turn/interrupt":
        if (!session?.interrupt) throw new Error("Pi RPC interruption is unavailable");
        await session.interrupt({ turnId: text(params.turnId, activeTurnId ?? "") });
        result = true;
        break;
      case "thread/read":
        if (!session) throw new Error("Pi RPC thread is not open");
        result = {
          thread: {
            id: session.ids().driverSessionId,
            cwd,
            turns: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [],
          },
        };
        break;
      case "thread/close":
        if (session) {
          const closing = session;
          session = null;
          await closing.close({ reason: "thread_close" });
          await eventPump?.catch(() => {});
          eventPump = null;
          activeTurnId = null;
          output.flush();
        }
        result = true;
        break;
      case "collaborationMode/list":
        result = { data: [] };
        break;
      default:
        throw new Error(`Unsupported Pi RPC proxy method ${message.method}`);
    }
    send({ id: message.id, result });
  }

  function failRequest(message: RpcMessage, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (message.method === "initialize" || message.method === "thread/start" || message.method === "thread/resume") {
      bootstrapFailure ??= normalized;
    }
    const code = (normalized as Error & { code?: unknown }).code;
    send({ id: message.id, error: { code: -32000, message: normalized.message,
      ...(code === "pi_session_file_missing" || code === "pi_session_file_invalid" ? { data: { code } } : {}) } });
  }

  function acceptLine(line: string): void {
    if (inputEnded || !line.trim()) return;
    const message = parseRpcMessage(line);
    if (!message) {
      log("Invalid JSON-RPC input (malformed JSON)\n");
      return;
    }
    if (message.method === undefined && message.id !== undefined) {
      void handle(message).catch((error) => log(`[pi_rpc] controller response failed: ${String(error)}\n`));
      return;
    }
    pendingInput = enqueueOpenCodeProxyInput(
      pendingInput,
      async () => {
        if (bootstrapFailure) {
          throw new Error(`Pi RPC provider bootstrap failed before ${message.method ?? "the dependent command"}: ${bootstrapFailure.message}`);
        }
        await handle(message);
      },
      (error) => failRequest(message, error),
    );
  }

  async function close(): Promise<void> {
    if (!inputEnded) {
      inputEnded = true;
      controller.closeInput(new Error("Pi RPC controller input closed before its response"));
    }
    const closing = session;
    session = null;
    try { await closing?.close({ reason: "proxy_shutdown", force: true }); }
    finally {
      await eventPump?.catch(() => {});
      output.flush();
      stdoutFrames.drain();
    }
  }

  async function endInput(): Promise<void> {
    if (inputEnded) return;
    inputEnded = true;
    controller.closeInput(new Error("Pi RPC controller input closed before its response"));
    await pendingInput;
    await close();
  }

  return {
    acceptLine,
    close,
    endInput,
    get queuedOutputFrames() { return stdoutFrames.queuedFrames; },
  };
}

async function runCli(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const proxy = createPiRpcAppServerProxy({
    stdout: process.stdout,
    writeStderr: (message) => process.stderr.write(message),
  });
  let shutdownPromise: Promise<void> | null = null;
  const finish = (close: () => Promise<void>) => {
    shutdownPromise ??= close()
      .then(() => new Promise<void>((resolve) => process.stdout.write("", () => resolve())))
      .then(() => process.exit(0), () => { process.stderr.write("Pi cleanup uncertain\n"); process.exit(1); });
    return shutdownPromise;
  };
  input.on("line", (line) => proxy.acceptLine(line));
  input.on("close", () => { void finish(() => proxy.endInput()); });
  process.on("SIGTERM", () => { void finish(() => proxy.close()); });
  process.on("SIGINT", () => { void finish(() => proxy.close()); });
}

// The file is also imported by the protocol tests with an injected HarnessDriver.
if (process.argv[1]?.endsWith("pi-rpc-app-server-proxy.js")
  || process.argv.includes("--paperclip-trusted-pi-executable")) {
  void runCli();
}
