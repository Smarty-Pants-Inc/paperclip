#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
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
import { HarnessStaleTurnError } from "../contracts/harness-driver.js";
import { parsePiUserInput } from "../drivers/pi/pi-user-input.js";
import { PiRpcDriver } from "../drivers/pi/pi-rpc-driver.js";
import { quarantineInvalidPiSessionFile } from "../drivers/pi/pi-session-file.js";
import { parseProviderPerformanceSpans, PROVIDER_PERFORMANCE_DIAGNOSTIC } from "../contracts/provider-performance.js";
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
  piRpcThinkingLevel?: PiThinkingLevel;
  deferInitialBinding?: boolean;
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
  compact?(input?: { customInstructions?: string }): Promise<Record<string, unknown>>;
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
  // A session open can wait up to the driver's process-startup bound; closing
  // the proxy must be able to cut that wait short.
  const openAbort = new AbortController();
  const output = createOpenCodeProxyOutput((frame, frameOptions) => stdoutFrames.write(frame, frameOptions));
  const send = output.send;
  const controller = createOpenCodeProxyControllerRequests(send);
  const requestController = controller.request;
  let session: PiRpcProxySession | null = null;
  let eventPump: Promise<void> | null = null;
  let pendingInput = Promise.resolve();
  let bootstrapFailure: Error | null = null;
  let missingResumeNeedsAttachment = false;
  let cwd = "";
  let activeModel = "";
  let piNativeAdmission: Record<string, unknown> | undefined;
  let recoveryNoticePending = false;
  let activeTurnId: string | null = null;
  // An idle-abort retirement replaces the process, not the conversation. Keep
  // its actual normalized ID even without the runner's usual environment grant.
  let idleTimeoutSessionId: string | undefined;
  let compactionOperation: Promise<void> | null = null;
  let compactionProgress: { runId: string; turnId: string; observed(): void } | null = null;
  let activeRunId = environment.PAPERCLIP_RUN_ID ?? "runnerd-run";
  let inputEnded = false;
  const announcedTurnIds = new Set<string>();
  const turnFailures = new Map<string, Record<string, unknown>>();
  // A successful finish may be the last model action, with no subsequent text.
  // Keep the accepted summary only until this captured run/turn settles; a
  // native final answer wins, and failed/cancelled turns never get a fallback.
  const turnAnswers = new Map<string, { summary?: string; nativeFinal?: boolean }>();
  const answerKey = (runId: string, turnId: string) => JSON.stringify([runId, turnId]);
  const usageTotals: Record<string, number> = {};
  const usageByTurn = new Map<string, {
    receipts: Map<string, string>;
    total: Record<string, number>;
    complete: boolean;
    accountingComplete: boolean;
  }>();

  const log = (message: string) => options.writeStderr?.(message);

  function threadResponse(id: string): Record<string, unknown> {
    return { thread: { id, sessionId: id, cwd }, model: activeModel, ...(piNativeAdmission ? { piNativeAdmission } : {}) };
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
    if (compactionOperation) throw new Error("Pi RPC session is compacting");
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
  }, payload: Record<string, unknown>, accountingOnly = false): void {
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
      const turn = usageByTurn.get(turnKey) ?? { receipts: new Map<string, string>(), total: {} as Record<string, number>, complete: true, accountingComplete: true };
      const wasComplete = turn.accountingComplete;
      const receiptId = text(payload.providerRequestId) || text(event.itemId);
      // Missing message measurements are permanent; a pending native child is
      // not. Its later receipt can complete accounting without recounting the
      // parent's tokens. An explicit missing receipt still fails closed.
      if (!accountingOnly) turn.complete &&= payload.runDeltaAvailable === true && !!event.turnId && !!receiptId;
      complete &&= turn.complete;
      usageByTurn.set(turnKey, turn);
      if (receiptId) {
        const fingerprint = JSON.stringify(Object.entries(delta).sort(([left], [right]) => left.localeCompare(right)));
        const previous = turn.receipts.get(receiptId);
        if (previous !== undefined) {
          if (previous !== fingerprint) throw new Error("pi_proxy_conflicting_usage_receipt");
          if (complete === wasComplete) return;
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
      turn.accountingComplete = complete;
    }
    send({
      method: "thread/tokenUsage/updated",
      params: {
        ...payload,
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
        event.eventType === "item.completed" ||
        event.eventType === "item.failed"
      ) {
        // Facade item notifications must be bound to a turn. Do not carry
        // OpenCode's provider-specific unbound-model filtering into Pi.
        if (typeof event.turnId !== "string" || !event.turnId) continue;
        if (event.eventType === "item.failed") {
          // Native Pi puts provider errors on failed message items; its final
          // settled turn may contain status alone. Retain only until settlement.
          turnFailures.set(event.turnId, { code: payload.code, message: payload.message });
        }
        // Unaccounted summarization/child work can invalidate a previously
        // complete turn even without another assistant usage receipt.
        if (payload.kind === "usage" && record(payload.usage).runDeltaComplete === false) {
          // This is a snapshot invalidation, not a missing message receipt.
          reportUsage(opened, { runId: event.runId, turnId: event.turnId }, { runDeltaAvailable: false, accountingComplete: false }, true);
        }
        if (event.eventType === "item.completed" && payload.kind === "agentMessage" &&
            payload.channel === "final" && text(payload.text).trim()) {
          const key = answerKey(event.runId, event.turnId);
          turnAnswers.set(key, { ...turnAnswers.get(key), nativeFinal: true });
        }
        send(openCodeProxyItemNotification({
          eventType: event.eventType,
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          // Preserve Pi's admitted assistant channel across the Codex facade;
          // otherwise the controller sees "unknown" and cannot verify a hello.
          payload: (payload.kind === "agentMessage" || payload.kind === "text") &&
            (payload.channel === "final" || payload.channel === "progress")
            ? { ...payload, item: { ...record(payload.item),
                phase: payload.channel === "final" ? "final_answer" : "commentary" } }
            : payload,
        }));
      } else if (event.eventType === "context.compacted") {
        // Use the existing Codex-facade compaction notification. Keep Pi's
        // typed measurements/identity: one Runner turn can compact repeatedly.
        // Manual compaction has no native turn; only its captured run may use
        // the administrative envelope and release the progress-before-terminal gate.
        const progress = compactionProgress?.runId === event.runId ? compactionProgress : null;
        const turnId = event.turnId ?? progress?.turnId;
        if (typeof turnId !== "string" || !turnId) continue;
        send({ method: "thread/compacted", params: {
          ...payload, threadId: opened.ids().driverSessionId,
          turnId, itemId: event.itemId,
        } });
        progress?.observed();
      } else if (event.eventType === "usage.reported") {
        reportUsage(opened, compactionOperation && !event.turnId && activeTurnId ? { ...event, turnId: activeTurnId } : event, payload);
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
        idleTimeoutSessionId = event.eventType === "turn.failed" && record(payload.error).code === "pi_turn_idle_timeout"
          ? event.normalizedSessionId : undefined;
        const key = typeof event.turnId === "string" ? answerKey(event.runId, event.turnId) : "";
        const answer = turnAnswers.get(key);
        turnAnswers.delete(key);
        if (event.eventType === "turn.completed" && answer?.summary && !answer.nativeFinal) {
          send(openCodeProxyItemNotification({
            eventType: "item.completed",
            threadId: opened.ids().driverSessionId,
            turnId: event.turnId,
            itemId: `${event.turnId}:pi-finish-answer`,
            payload: { kind: "agentMessage", channel: "final", text: answer.summary },
          }));
        }
        send(openCodeProxyTerminalNotification({
          eventType: event.eventType,
          threadId: opened.ids().driverSessionId,
          turnId: event.turnId,
          // Pi failures carry code/message at the top level, whereas the
          // facade helper expects error. Keep the real actionable diagnostic.
          payload: event.eventType === "turn.failed" && payload.error === undefined
            ? { ...payload, error: turnFailures.get(event.turnId ?? "") ?? { code: payload.code, message: payload.message } }
            : payload,
        }));
        if (event.turnId) turnFailures.delete(event.turnId);
        if (event.runId === activeRunId && event.turnId === activeTurnId) activeTurnId = null;
      } else if (event.eventType === "provider.notice.recorded") {
        send({ method: "warning", params: { threadId: opened.ids().driverSessionId,
          ...(event.turnId ?? activeTurnId ? { turnId: event.turnId ?? activeTurnId } : {}),
          message: payload.summary, severity: payload.severity, category: payload.category, noticeKey: payload.noticeId, details: payload.details } });
      } else if (event.eventType === "harness.diagnostic") {
        if (payload.code === PROVIDER_PERFORMANCE_DIAGNOSTIC) {
          const spans = parseProviderPerformanceSpans(payload, Date.now());
          if (spans.length) send({ method: "paperclip/providerPerformance", params: {
            threadId: opened.ids().driverSessionId, turnId: event.turnId, spans,
          } });
          continue;
        }
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
    const model = text(params.model);
    if (params.piThinkingLevel !== undefined) throw new Error("Native Pi requires piRpcThinkingLevel, not the ACPX field");
    if (!model) throw new Error("Pi RPC proxy requires a model");
    activeModel = model;
    const dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools.map(record) : [];
    const piRpcThinkingLevel = parsePiThinkingLevel(
      params.piRpcThinkingLevel ?? environment.PAPERCLIP_PI_THINKING_LEVEL,
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
      ...(piRpcThinkingLevel === undefined ? {} : { piRpcThinkingLevel }),
      systemInstructions: text(params.baseInstructions, "Complete only the supplied task."),
      runtimeContext,
      dynamicTools,
      durableToolRequests: true,
      // A restored process initially belongs to the previous run. Release its
      // unused bootstrap origin before the current run's explicit attachment.
      deferInitialBinding: resume || missingResumeNeedsAttachment,
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
        if (tool === "paperclip_finish" && record(response).success === true) {
          const summary = text(record(arguments_).summary).trim();
          if (summary) {
            const key = answerKey(runId, turnId);
            turnAnswers.set(key, { ...turnAnswers.get(key), summary });
          }
        }
        return response;
      },
      isolateProcessGroup: false,
    };
    const driver: HarnessDriver = options.createDriver?.(config)
      ?? new PiRpcDriver(config);
    let opened: PiRpcProxySession;
    let sessionRecovery: { reason: string; previousSessionId: string; normalizedSessionId: string; preservedFile: string } | undefined;
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
      // Missing history still follows runnerd's explicit thread/start path.
      // Only the typed invalid-file failure may quarantine this exact entry.
      let recovered: Awaited<ReturnType<NonNullable<HarnessDriver["recoverSession"]>>> | null = null;
      try {
        recovered = await driver.recoverSession(snapshot, { signal: openAbort.signal });
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "pi_session_file_invalid") throw error;
        const preservedFile = await quarantineInvalidPiSessionFile(config.runtimeDirectory, normalizedSessionId);
        sessionRecovery = { reason: "pi_session_file_invalid", previousSessionId: threadId, normalizedSessionId, preservedFile };
        log(`[paperclip-runner] owner alarm: pi_session_file_invalid; preserved ${preservedFile}; starting fresh under the same conversation id\n`);
      }
      if (recovered) {
        if (!recovered.recovered || !recovered.session) {
          throw new Error(recovered.reason ?? "Pi RPC session recovery failed");
        }
        opened = recovered.session;
      } else {
        opened = await driver.openSession({ runId: activeRunId, normalizedSessionId, workingDirectory: cwd, signal: openAbort.signal });
      }
    } else {
      opened = await driver.openSession({
        runId: activeRunId,
        normalizedSessionId: environment.PAPERCLIP_NORMALIZED_SESSION_ID ?? idleTimeoutSessionId ?? `runnerd-${Date.now()}`,
        workingDirectory: cwd,
        signal: openAbort.signal,
      });
    }
    // A new native thread starts a new session accounting scope. Warm
    // run.attach/turn.start must not reset its cumulative total.
    for (const key of Object.keys(usageTotals)) delete usageTotals[key];
    usageByTurn.clear();
    session = opened;
    missingResumeNeedsAttachment = false;
    piNativeAdmission = (opened as PiRpcProxySession & { piNativeAdmission?(): Record<string, unknown> }).piNativeAdmission?.();
    if (!options.createDriver && !piNativeAdmission) throw new Error("Native Pi omitted admitted model/thinking metadata");
    if (piNativeAdmission) activeModel = String(piNativeAdmission.model);
    if (sessionRecovery) {
      // deferInitialBinding already settled the restored run's unused origin.
      // Do not settle twice or bypass the ordinary next-run attachment.
      // Explicit evidence of a fresh native identity, never a fabricated resume
      // identity. The ordinary model/thinking readback remains mandatory.
      piNativeAdmission = { ...piNativeAdmission, sessionRecovery };
      recoveryNoticePending = true;
    }
    eventPump = pumpEvents(opened).finally(() => {
      // Stop/failure physically retires Pi. Never advertise that dead thread on
      // the next thread/start, and never clear a newer session's authority.
      if (session === opened) {
        session = null;
        activeTurnId = null;
        piNativeAdmission = undefined;
        announcedTurnIds.clear();
        for (const key of Object.keys(usageTotals)) delete usageTotals[key];
      }
    });
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
      case "thread/compact/start": {
        const opened = session;
        if (!opened) throw new Error("No active conversation to compact");
        if (params.threadId !== opened.ids().driverSessionId) throw new Error("Pi compaction thread does not match the active conversation");
        if (!opened.compact) throw new Error("Pi RPC compaction is unavailable");
        if (activeTurnId || compactionOperation) throw new Error("Pi RPC session already has an active turn or compaction");
        if (params.customInstructions !== undefined && typeof params.customInstructions !== "string") throw new Error("Pi compaction instructions must be a string");
        const turnId = `pi-compact-${randomUUID()}`;
        let resolveObserved!: () => void;
        let rejectObserved!: (error: Error) => void;
        const observed = new Promise<void>((resolve, reject) => { resolveObserved = resolve; rejectObserved = reject; });
        compactionProgress = { runId: activeRunId, turnId, observed: resolveObserved };
        activeTurnId = turnId;
        // Runner's existing compact protocol needs an administrative execution
        // envelope. Native compaction events remain progress, never prompt/turn events.
        announceTurnStarted(opened, turnId);
        compactionOperation = Promise.resolve().then(() => opened.compact!(params.customInstructions === undefined ? {} : { customInstructions: params.customInstructions as string }))
          .then(async receipt => {
            // Command completion and event delivery are independent. Do not let
            // the durable control terminal overtake its compaction notification.
            const timeout = setTimeout(() => rejectObserved(new Error("Pi compaction progress receipt missing")), 5000);
            try { await observed; } finally { clearTimeout(timeout); }
            send({ method: "turn/completed", params: { threadId: opened.ids().driverSessionId, turnId,
              turn: { id: turnId, status: "completed" }, compaction: { tokensBefore: receipt.tokensBefore,
                estimatedTokensAfter: receipt.estimatedTokensAfter, firstKeptEntryId: receipt.firstKeptEntryId } } });
          }).catch(error => {
            send({ method: "turn/failed", params: { threadId: opened.ids().driverSessionId, turnId,
              turn: { id: turnId, status: "failed", error: { message: error instanceof Error ? error.message : String(error) } } } });
          }).finally(() => { if (activeTurnId === turnId) activeTurnId = null; compactionProgress = null; compactionOperation = null; });
        result = { turn: { id: turnId, status: "inProgress" } };
        break;
      }
      case "turn/start": {
        if (!session) throw new Error("Pi RPC thread is not open");
        if (compactionOperation) throw new Error("Pi RPC session is compacting");
        assertPiCollaborationMode(params);
        const userMessage = parsePiUserInput(params.input);
        if (params.paperclipRunId !== undefined) await attachRun(params, params.paperclipRunId);
        if (params.piThinkingLevel !== undefined) throw new Error("Native Pi requires piRpcThinkingLevel, not the ACPX field");
        if (params.model !== undefined && params.model !== activeModel) throw new Error("Pi turn model differs from the admitted session");
        const piRpcThinkingLevel = parsePiThinkingLevel(
          params.effort ?? params.piRpcThinkingLevel ?? environment.PAPERCLIP_PI_THINKING_LEVEL,
        );
        const turnInput = {
          message: userMessage,
          model: activeModel,
          ...(piRpcThinkingLevel === undefined ? {} : { piRpcThinkingLevel }),
        } as Parameters<HarnessSession["startTurn"]>[0] & { piRpcThinkingLevel?: PiThinkingLevel };
        const turn = await session.startTurn(turnInput);
        activeTurnId = turn.turnId;
        if (recoveryNoticePending) {
          recoveryNoticePending = false;
          // Publish under the next active run, not the settled run whose idle
          // runner was restored. Runner's normal provider notice is durable.
          send({ method: "warning", params: { threadId: session.ids().driverSessionId, turnId: turn.turnId,
            message: "My earlier Pi conversation could not be restored (pi_session_file_invalid: the saved file is corrupt, foreign, or has a different identity). The original file was preserved. Starting fresh in this conversation." } });
        }
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
      case "turn/steer": {
        const turnId = text(params.expectedTurnId);
        if (!activeTurnId || turnId !== activeTurnId) throw new HarnessStaleTurnError(turnId);
        if (!session?.steer) throw new Error("Pi RPC steering is unavailable");
        if (params.mode !== undefined && params.mode !== "steer") throw new Error("Pi RPC follow-up is unavailable");
        await session.steer({ turnId, message: parsePiUserInput(params.input) });
        result = { accepted: true };
        break;
      }
      case "turn/interrupt": {
        if (!session) throw new Error("Pi RPC interruption is unavailable");
        const turnId = text(params.turnId, activeTurnId ?? "");
        const compacting = compactionOperation;
        if (compacting && turnId === activeTurnId) {
          // The administrative id is not a native Pi turn id. A physical close
          // cancels the summary instead of silently ignoring that unmatched id.
          await session.close({ reason: "compaction_interrupt", force: true });
          await compacting;
        } else {
          if (!session.interrupt) throw new Error("Pi RPC interruption is unavailable");
          await session.interrupt({ turnId });
        }
        result = true;
        break;
      }
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
          await compactionOperation;
          await eventPump?.catch(() => {});
          eventPump = null;
          activeTurnId = null;
          output.flush();
        }
        idleTimeoutSessionId = undefined;
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
    const code = (normalized as Error & { code?: unknown }).code;
    const missingResume = message.method === "thread/resume" && code === "pi_session_file_missing";
    if (missingResume) missingResumeNeedsAttachment = true;
    if (!missingResume && (message.method === "initialize" || message.method === "thread/start" || message.method === "thread/resume")) {
      bootstrapFailure ??= normalized;
    }
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
    openAbort.abort();
    if (!inputEnded) {
      inputEnded = true;
      controller.closeInput(new Error("Pi RPC controller input closed before its response"));
    }
    const closing = session;
    session = null;
    try { await closing?.close({ reason: "proxy_shutdown", force: true }); }
    finally {
      await compactionOperation;
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
