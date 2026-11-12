import type { HarnessDriverConfigValidation } from "../../contracts/harness-driver.js";

/** Integration replaces this local list with dev-lead's qualified profile. No ACPX aliases. */
export const PI_NATIVE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PI_RPC_THINKING_KEY = "piRpcThinkingLevel" as const;
export type PiNativeThinkingLevel = typeof PI_NATIVE_THINKING_LEVELS[number];
/** Pi owns capability/config lowering; the host only forbids an escalation. */
export function isPiThinkingLevelAtMost(effective: unknown, requested: PiNativeThinkingLevel): effective is PiNativeThinkingLevel {
  const index = PI_NATIVE_THINKING_LEVELS.indexOf(effective as PiNativeThinkingLevel);
  return index >= 0 && index <= PI_NATIVE_THINKING_LEVELS.indexOf(requested);
}
export interface PiThinkingLoweredDiagnostic {
  code: "pi_thinking_lowered_by_config";
  requested: PiNativeThinkingLevel;
  effective: PiNativeThinkingLevel;
}
export interface PiNativeConfig {
  provider: "pi_rpc";
  model: string;
  piRpcThinkingLevel?: PiNativeThinkingLevel;
}
export class PiNativeAdmissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "PiNativeAdmissionError"; }
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Preserve exact IDs: discovery is not an admission allowlist (playbook 6.1). */
export function resolvePiNativeConfig(value: unknown): PiNativeConfig {
  const config = record(value);
  if (config.provider !== "pi_rpc") throw new PiNativeAdmissionError("pi_provider_invalid", "Native Pi requires provider pi_rpc; legacy runtime choices are not converted implicitly.");
  const model = config.model;
  if (typeof model !== "string" || model.length > 1024 || !/^[^/\s\u0000-\u001f\u007f]+\/[^\s\u0000-\u001f\u007f]+$/u.test(model) || model.endsWith("/")) {
    throw new PiNativeAdmissionError("pi_model_required", "Pi requires an explicit exact provider/model ID; select a model before testing or assigning work.");
  }
  const level = config[PI_RPC_THINKING_KEY];
  if (level !== undefined && !PI_NATIVE_THINKING_LEVELS.includes(level as PiNativeThinkingLevel)) throw new PiNativeAdmissionError("pi_thinking_invalid", "Pi thinking must be off, minimal, low, medium, high, xhigh, or max.");
  if (config.piThinkingLevel !== undefined) throw new PiNativeAdmissionError("pi_thinking_invalid", "Native Pi uses piRpcThinkingLevel, not the legacy ACPX piThinkingLevel field.");
  return { provider: "pi_rpc", model, ...(level === undefined ? {} : { [PI_RPC_THINKING_KEY]: level as PiNativeThinkingLevel }) };
}
export function validatePiNativeConfig(value: unknown): HarnessDriverConfigValidation {
  try { return { ok: true, config: { ...record(value), ...resolvePiNativeConfig(value) }, issues: [] }; }
  catch (error) {
    if (!(error instanceof PiNativeAdmissionError)) throw error;
    return { ok: false, config: null, issues: [{ path: error.code === "pi_thinking_invalid" ? PI_RPC_THINKING_KEY : error.code === "pi_provider_invalid" ? "provider" : "model", code: error.code, message: error.message }] };
  }
}
/** Resolves correlated successful response.data, rejects failed/malformed responses. */
export interface PiRpcAdmissionPort {
  request(command: { type: string; [key: string]: unknown }, signal?: AbortSignal): Promise<unknown>;
}
export interface PiNativeAdmittedIdentity {
  model: string;
  providerSessionId: string;
  /** Authoritative effective effort, not the configured request. */
  piRpcThinkingLevel?: PiNativeThinkingLevel;
  /** At most one bounded diagnostic, emitted once by the session owner. */
  diagnostic?: PiThinkingLoweredDiagnostic;
}
/**
 * Invoke on create/load/reconnect AND run.attach AND after claim, before prompt.
 * Read live state first; apply supported live changes or refuse. Native Codex
 * attach precedent: provider_backend.rs:3436-3541. Pi rpc-commands.md:150-184,
 * 274-327: set success has no effective-level data; only get_state acknowledges.
 * Driver must serialize admission with input and fence unrequested agent_start.
 */
export async function admitPiRpcSession(port: PiRpcAdmissionPort, input: PiNativeConfig, signal?: AbortSignal): Promise<PiNativeAdmittedIdentity> {
  const config = resolvePiNativeConfig(input);
  const request = async (command: { type: string; [key: string]: unknown }) => { signal?.throwIfAborted(); const result = await port.request(command, signal); signal?.throwIfAborted(); return result; };
  const idle = (state: Record<string, unknown>) => {
    if (typeof state.isStreaming !== "boolean" || typeof state.isCompacting !== "boolean" || typeof state.pendingMessageCount !== "number" || !Number.isSafeInteger(state.pendingMessageCount) || state.pendingMessageCount < 0) throw new PiNativeAdmissionError("pi_session_state_invalid", "Pi session did not report authoritative idle/queue state; refusing admission.");
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) throw new PiNativeAdmissionError("pi_session_busy", "Pi session is busy; refusing attach/claim without changing live work.");
  };
  const before = record(await request({ type: "get_state" })); idle(before);
  const slash = config.model.indexOf("/");
  const provider = config.model.slice(0, slash), modelId = config.model.slice(slash + 1);
  const matchingModel = (value: unknown) => record(value).provider === provider && record(value).id === modelId;
  if (!matchingModel(await request({ type: "set_model", provider, modelId }))) throw new PiNativeAdmissionError("pi_model_mismatch", "Pi did not acknowledge the exact selected model; no prompt was sent.");
  let available: PiNativeThinkingLevel[] | undefined;
  if (config.piRpcThinkingLevel !== undefined) {
    const levels = record(await request({ type: "get_available_thinking_levels" })).levels;
    if (!Array.isArray(levels) || !levels.length || levels.length > PI_NATIVE_THINKING_LEVELS.length || !levels.every(level => PI_NATIVE_THINKING_LEVELS.includes(level))) throw new PiNativeAdmissionError("pi_thinking_unsupported", "Pi selected model did not report valid available thinking levels; no prompt was sent.");
    available = levels;
    // A valid request need not itself be available: Pi applies its own config.
    await request({ type: "set_thinking_level", level: config.piRpcThinkingLevel });
  }
  const state = record(await request({ type: "get_state" })); idle(state);
  if (!matchingModel(state.model)) throw new PiNativeAdmissionError("pi_model_mismatch", "Pi effective model differs from the selection; no prompt was sent.");
  const effective = state.thinkingLevel;
  if (config.piRpcThinkingLevel !== undefined && (!isPiThinkingLevelAtMost(effective, config.piRpcThinkingLevel) || !available!.includes(effective))) throw new PiNativeAdmissionError("pi_thinking_mismatch", "Pi effective thinking level is missing, unavailable, or higher than requested; no prompt was sent.");
  if (typeof state.sessionId !== "string" || !state.sessionId.trim() || state.sessionId.length > 1024 || (before.sessionId !== undefined && before.sessionId !== state.sessionId)) throw new PiNativeAdmissionError("pi_session_identity_missing", "Pi native session identity is missing or changed during admission; no prompt was sent.");
  return { model: config.model, providerSessionId: state.sessionId, ...(config.piRpcThinkingLevel === undefined ? {} : {
    piRpcThinkingLevel: effective as PiNativeThinkingLevel,
    ...(effective === config.piRpcThinkingLevel ? {} : { diagnostic: { code: "pi_thinking_lowered_by_config" as const, requested: config.piRpcThinkingLevel, effective: effective as PiNativeThinkingLevel } }),
  }) };
}
