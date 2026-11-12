import type { HarnessDriver, HarnessSession } from "../../contracts/harness-driver.js";
import { isPiThinkingLevelAtMost, PiNativeAdmissionError, resolvePiNativeConfig, type PiNativeConfig, type PiNativeThinkingLevel } from "./pi-native-config.js";

export class PiEnvironmentProbeCleanupError extends Error {
  readonly code = "pi_probe_cleanup_unconfirmed";
  constructor(readonly retired: Promise<void>, readonly operationError: unknown, readonly cleanupError: unknown, readonly retryCleanup: () => Promise<void>) {
    super("Pi setup probe cleanup is unconfirmed; retain the original execution environment and join retired/retryCleanup.", { cause: operationError ?? cleanupError });
    this.name = "PiEnvironmentProbeCleanupError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

/**
 * Native setup Test, following runnerd-codex-transport.ts:9005-9242.
 * The caller supplies the SAME admitted/prepared driver used by a real run,
 * including its selected connection and execution target. No local fallback,
 * credential ping, metadata-only success, or alternate Pi launcher exists here.
 * `close` must prove physical retirement, as required by HarnessSession owners.
 */
export async function probePiNativeEnvironment(options: {
  driver: Pick<HarnessDriver, "openSession">;
  config: PiNativeConfig;
  runId: string;
  normalizedSessionId: string;
  workingDirectory: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
}): Promise<{ provider: "pi_rpc"; providerDriver: "pi_rpc"; effectiveModel: string; providerSessionId: string; piRpcThinkingLevel?: PiNativeThinkingLevel; helloProbePassed: true }> {
  const config = resolvePiNativeConfig(options.config);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("Pi hello probe timed out.")), Math.max(1, Math.min(options.timeoutMs ?? 45_000, 120_000)));
  let session: HarnessSession | undefined;
  let operationError: unknown;
  let passed = false;
  let providerSessionId = "";
  let piRpcThinkingLevel: PiNativeThinkingLevel | undefined;
  // Keep the original opening operation so cancellation cannot orphan a late
  // session; cleanup joins it before claiming that the environment is retired.
  const opening = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return options.driver.openSession({ runId: options.runId, normalizedSessionId: options.normalizedSessionId, workingDirectory: options.workingDirectory, signal });
  }).then(value => { session = value; return value; });
  try {
    await untilAbort(opening, signal);
    const active = session!;
    const ids = active.ids();
    if (!ids.driverSessionId || !ids.providerSessionId) throw new PiNativeAdmissionError("pi_probe_session_missing", "Pi hello probe returned no native session identity.");
    providerSessionId = ids.providerSessionId;
    const events = active.events()[Symbol.asyncIterator]();
    const first = await untilAbort(events.next(), signal);
    const event = first.value;
    const context = record(event?.payload.context);
    if (first.done || event.eventType !== "session.started" || event.runId !== options.runId || event.normalizedSessionId !== options.normalizedSessionId || context.model !== config.model) {
      throw new PiNativeAdmissionError("pi_probe_model_mismatch", "Pi hello probe returned a missing or mismatched admitted model/session.");
    }
    if (config.piRpcThinkingLevel !== undefined) {
      // The driver already validated availability against live Pi state. Do not
      // undo that admission by demanding the request instead of the effective cap.
      if (!isPiThinkingLevelAtMost(context.piRpcThinkingLevel, config.piRpcThinkingLevel)) throw new PiNativeAdmissionError("pi_probe_thinking_mismatch", "Pi hello probe reported missing, invalid, or higher than requested thinking.");
      piRpcThinkingLevel = context.piRpcThinkingLevel;
    }
    // Subscribe before startTurn: the native peer may complete synchronously.
    let next = events.next();
    void next.catch(() => undefined);
    const started = await untilAbort(active.startTurn({ message: { role: "user", text: "Respond only with hello. Do not use tools or inspect files." } }), signal);
    let responseObserved = false;
    while (true) {
      const received = await untilAbort(next, signal);
      if (received.done) throw new Error("Pi hello probe ended without a settled successful turn.");
      const current = received.value;
      if (current.runId !== options.runId || current.normalizedSessionId !== options.normalizedSessionId) throw new Error("Pi hello probe received a mismatched run/session.");
      if (current.eventType === "session.failed") throw new Error("Pi hello probe session failed.");
      if (current.turnId === started.turnId) {
        if (current.eventType.startsWith("tool.execution.") || (current.eventType.startsWith("item.") && ["tool", "commandExecution", "mcpToolCall"].includes(String(current.payload.kind)))) {
          throw new Error("Pi hello probe unexpectedly used a tool.");
        }
        if (current.eventType === "item.completed" && current.payload.kind === "agentMessage" && current.payload.channel === "final" && typeof current.payload.text === "string" && current.payload.text.trim()) responseObserved = true;
        if (["turn.failed", "turn.cancelled", "turn.interrupted", "item.failed"].includes(current.eventType)) throw new Error("Pi hello probe failed or was interrupted.");
        if (current.eventType === "turn.completed") {
          if (!responseObserved) throw new Error("Pi hello probe settled without an assistant response.");
          passed = true;
          break;
        }
      }
      next = events.next();
      void next.catch(() => undefined);
    }
  } catch (error) { operationError = error; }
  finally {
    clearTimeout(timer);
    controller.abort(operationError ?? new Error("Pi hello probe complete."));
    const cleanupController = new AbortController();
    const cleanupTimer = setTimeout(() => cleanupController.abort(new Error("Pi probe retirement timed out.")), Math.max(1, Math.min(options.cleanupTimeoutMs ?? 10_000, 10_000)));
    // Match the retained native cleanup contract (runnerd-codex-transport.ts:
    // 8973-9002): a wait deadline must not abandon the original late opener or
    // close. A retry joins an existing attempt; only a rejected attempt resets.
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => {
      if (!retirement) {
        retirement = opening.catch(() => undefined).then(async () => {
          if (session) await session.close({ reason: "environment probe complete" });
        }).catch(error => { retirement = undefined; throw error; });
        void retirement.catch(() => undefined);
      }
      return retirement;
    };
    const retired = retire();
    try { await untilAbort(retired, cleanupController.signal); }
    catch (error) { throw new PiEnvironmentProbeCleanupError(retired, operationError, error, retire); }
    finally { clearTimeout(cleanupTimer); }
  }
  if (operationError !== undefined) throw operationError;
  if (!passed) throw new Error("Pi hello probe did not complete.");
  return { provider: "pi_rpc", providerDriver: "pi_rpc", effectiveModel: config.model, providerSessionId, ...(piRpcThinkingLevel === undefined ? {} : { piRpcThinkingLevel }), helloProbePassed: true };
}
