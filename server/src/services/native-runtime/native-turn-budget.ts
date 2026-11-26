import { createHash } from "node:crypto";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import type { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";

// One split, in encoded UTF-8 journal-command bytes (not prompt characters).
// Runner journal: floor((1 MiB - 4096) / 2). The known envelope/continuation
// and handoff share the remainder after queued input and late-data reserves.
// The 64 KiB reserve covers constraints, deferred attachments, skills, envelope
// joiners and the wrapper (the 128-attachment probe measured <53,000 B).
// It is an allocation, not an assumption: final admission below measures ALL
// actual payload fields and refuses oversized late additions before queueing.
export const NATIVE_HANDOFF_COMMAND_MAX_BYTES = 522_240;
// The journal allows 522,240 B; the largest observed box success was 515,161 B.
// Submitted 540–572 KB turns broke transport later (binding limit unconfirmed).
// Use one lower total cap, 500,000 B, as a MARGIN for either boundary, not proof
// of a transport limit or of successful provider dispatch.
export const NATIVE_TURN_COMMAND_MAX_BYTES = 500_000;
export const NATIVE_TURN_COMMAND_MARGIN_BYTES = NATIVE_HANDOFF_COMMAND_MAX_BYTES - NATIVE_TURN_COMMAND_MAX_BYTES;
export const NATIVE_HANDOFF_COMMAND_RESERVE_BYTES = 64 * 1024;
export const FIRST_TURN_QUEUED_INPUT_MAX_BYTES = 96 * 1024;
export const NATIVE_TURN_KNOWN_MAX_BYTES = NATIVE_TURN_COMMAND_MAX_BYTES
  - NATIVE_HANDOFF_COMMAND_RESERVE_BYTES - FIRST_TURN_QUEUED_INPUT_MAX_BYTES;
// Full-render budgeting leaves room for the handoff's minimal omission note.
// This stays WITHIN the known/handoff allocation, never on top of the total cap.
export const NATIVE_HANDOFF_CUT_NOTE_RESERVE_BYTES = 256;
export const NATIVE_HANDOFF_MAX_BYTES = 24_000;
export const NATIVE_WHOLE_HANDOFF_MAX_BYTES = 368_000;
export const NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND = "native_turn_prompt_exceeds_command_bound";
export const NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND_MESSAGE = "This turn is too large. Reduce the request or task context. Saved task history remains available.";
export type NativePromptRefusalCause = { kind: "task_description" | "newest_message" | "unread_message" | "queued_input" | "human_response" | "protected_input" | "command"; bytes: number };
export function nativePromptRefusalDetail(cause?: NativePromptRefusalCause): string {
  if (!cause) return NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND_MESSAGE;
  const size = Math.ceil(cause.bytes / 1024);
  if (cause.kind === "task_description") return `The task description is ${size} KB. Shorten it before continuing. Saved task history remains available.`;
  if (cause.kind === "newest_message") return `The newest message is ${size} KB. Split it into smaller messages. Saved task history remains available.`;
  if (cause.kind === "unread_message") return `An unread message is ${size} KB. Shorten or split it before continuing. Saved task history remains available.`;
  if (cause.kind === "queued_input") return `The queued input is ${size} KB when encoded for this turn. Split it into smaller messages. This refusal does not claim or consume queued messages or answers; the input remains saved.`;
  if (cause.kind === "human_response") return `A person's answer is ${size} KB. Shorten or split it before continuing. The whole answer remains saved.`;
  return NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND_MESSAGE;
}
export function nativePromptRefusalCause(value: unknown): NativePromptRefusalCause | undefined {
  const v = record(value);
  return ["task_description", "newest_message", "unread_message", "queued_input", "human_response", "protected_input", "command"].includes(String(v.kind)) && Number.isSafeInteger(v.bytes) && Number(v.bytes) >= 0
    ? v as NativePromptRefusalCause : undefined;
}
export function nativePromptCauseFromError(error: unknown): NativePromptRefusalCause | undefined {
  const direct = nativePromptRefusalCause(record(error).promptCause);
  if (direct) return direct;
  const match = (error instanceof Error ? error.message : "").match(/native_prompt_cause=(task_description|newest_message|unread_message|queued_input|human_response|protected_input|command):(\d+)/);
  return match ? nativePromptRefusalCause({ kind: match[1], bytes: Number(match[2]) }) : undefined;
}
export class NativeTurnPromptExceedsCommandBoundError extends Error {
  readonly code = NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND;
  constructor(readonly promptCause?: NativePromptRefusalCause) {
    super(`${NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND}: ${nativePromptRefusalDetail(promptCause)}${promptCause ? ` [native_prompt_cause=${promptCause.kind}:${promptCause.bytes}]` : ""}`);
  }
}

// Text is JSON-escaped in the envelope, then in command.payload.text.
export const commandTextBytes = (text: string) => Buffer.byteLength(JSON.stringify(JSON.stringify(text)), "utf8") - 6;
export const commandEnvelopeBytes = (envelope: object) => Buffer.byteLength(JSON.stringify(JSON.stringify(envelope)), "utf8") - 2;
export function nativeSessionHandoffMaxBytes(promptOrEnvelope: string | object): number {
  const room = NATIVE_TURN_KNOWN_MAX_BYTES - (typeof promptOrEnvelope === "string"
    ? commandTextBytes(promptOrEnvelope) : commandEnvelopeBytes(promptOrEnvelope));
  if (room < 0) throw new NativeTurnPromptExceedsCommandBoundError();
  return Math.min(NATIVE_WHOLE_HANDOFF_MAX_BYTES, room);
}

export type NativeContinuationReadState = { lastRunAt: string | null; readCommentIds: string[] };
export type NativeContinuationCoverage = ExecutionContinuationEnvelope["coverage"] & {
  omitted?: Array<{ id: string; updatedAt: string }>;
  nativeSessionId?: string;
  providerSessionId?: string;
};
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function nativeContinuationReadState(value: unknown): NativeContinuationReadState {
  const state = record(value);
  return { lastRunAt: typeof state.lastRunAt === "string" ? state.lastRunAt : null,
    readCommentIds: Array.isArray(state.readCommentIds) ? state.readCommentIds.filter((id): id is string => typeof id === "string") : [] };
}

/** Pure rendering budget: unknown read state protects everything, never guesses. */
export function boundNativeExecutionContinuation(
  original: ExecutionContinuationEnvelope,
  measure: (continuation: ExecutionContinuationEnvelope) => number,
  readState?: NativeContinuationReadState,
  isReadOperation: (operationId: string) => boolean = () => false,
  refusalCause?: NativePromptRefusalCause,
): ExecutionContinuationEnvelope {
  if (measure(original) <= NATIVE_TURN_KNOWN_MAX_BYTES) return original;
  const continuation = { ...original, messages: [...original.messages], completedActions: [...(original.completedActions ?? [])],
    coverage: { ...original.coverage, omitted: [...((original.coverage as NativeContinuationCoverage).omitted ?? [])] } };
  const coverage = continuation.coverage as typeof continuation.coverage & {
    truncated?: boolean; omittedMessages?: number; omittedCompletedActions?: number; shortenedCompletedActions?: number;
  };
  const mark = () => { coverage.truncated = true; coverage.omittedMessages ??= 0;
    coverage.omittedCompletedActions ??= 0; coverage.shortenedCompletedActions ??= 0; };
  // Caller uses runner-api-catalog's method/operation registry, not a verb guess.
  // Everything else (including unknown operation IDs) retains its STOCK result.
  for (let i = 0; i < continuation.completedActions.length; i++) {
    const receipt = continuation.completedActions[i]!;
    if (!isReadOperation(receipt.operationId)) continue;
    const result = record(receipt.result);
    if (result.resultOmittedForSize === true) continue;
    const shortened = { ...Object.fromEntries(["operationId", "ok", "status", "kind", "target"].filter(key => key in result).map(key => [key, result[key]])),
      resultOmittedForSize: true, note: "Result omitted for size; re-read if needed.",
      resultSha256: `sha256:${createHash("sha256").update(JSON.stringify(receipt.result) ?? "null").digest("hex")}` };
    if (commandTextBytes(JSON.stringify(shortened)) >= commandTextBytes(JSON.stringify(receipt.result) ?? "null")) continue;
    continuation.completedActions[i] = { ...receipt, result: shortened };
    mark(); coverage.shortenedCompletedActions! += 1;
    if (measure(continuation) <= NATIVE_TURN_KNOWN_MAX_BYTES) return continuation;
  }
  const read = new Set(readState?.readCommentIds ?? []);
  const lastRunAt = Date.parse(readState?.lastRunAt ?? "");
  const latestPerson = original.messages.findLast(message => message.authorType === "user" && !message.createdByRunId && !message.deleted);
  const protectedIds = new Set([...original.originCommentIds, original.objectiveSource?.id, latestPerson?.id]);
  for (const message of original.messages) {
    const createdAt = Date.parse(message.createdAt), updatedAt = Date.parse(message.updatedAt);
    if (protectedIds.has(message.id) || !read.has(message.id) || !Number.isFinite(lastRunAt)
      || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || createdAt >= lastRunAt || updatedAt >= lastRunAt) continue;
    continuation.messages = continuation.messages.filter(candidate => candidate.id !== message.id);
    continuation.coverage.omitted.push({ id: message.id, updatedAt: message.updatedAt });
    mark(); coverage.omittedMessages! += 1;
    if (measure(continuation) <= NATIVE_TURN_KNOWN_MAX_BYTES) return continuation;
  }
  throw new NativeTurnPromptExceedsCommandBoundError(refusalCause);
}

const freshFallbacks = new Map<string, { original: string; bounded: string }>();
export function registerNativeFreshFallback(runId: string, original: string, bounded: string): void {
  freshFallbacks.set(runId, { original, bounded });
}
export function clearNativeFreshFallback(runId: string): void { freshFallbacks.delete(runId); }
export function nativeFreshFallbackPayload(runId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const fallback = freshFallbacks.get(runId);
  if (!fallback || typeof payload.text !== "string") return payload;
  let envelope: Record<string, unknown>;
  try { envelope = record(JSON.parse(payload.text)); } catch { throw new NativeTurnPromptExceedsCommandBoundError(); }
  const task = record(envelope.task);
  if (typeof task.prompt !== "string" || !task.prompt.includes(fallback.original)) throw new NativeTurnPromptExceedsCommandBoundError();
  // Runner parses/copies input before its continuity-break callback. Replace
  // that exact old bootstrap in the FINAL envelope, preserving late joiners.
  task.prompt = task.prompt.replace(fallback.original, fallback.bounded);
  return { ...payload, text: JSON.stringify(envelope) };
}
export function assertNativeTurnCommandBound(type: string, payload: Record<string, unknown>, commandId?: string, cause?: NativePromptRefusalCause): void {
  const command = { schema: "paperclip.prp.command.v1", commandId: commandId ?? "x".repeat(160),
    controllerSeq: Number.MAX_SAFE_INTEGER, type, issuedAt: new Date().toISOString(), payload, status: "pending", result: null };
  if (Buffer.byteLength(JSON.stringify(command), "utf8") > NATIVE_TURN_COMMAND_MAX_BYTES)
    throw new NativeTurnPromptExceedsCommandBoundError(cause ?? { kind: "command", bytes: Buffer.byteLength(JSON.stringify(payload), "utf8") });
}
/** Exact late-composed text, plus the unused part of the existing late share.
 * Called inside the claim transaction, before any receipt can be written.
 * Do not reserve attachments/constraints twice: bytes beyond the entire known
 * allowance are already occupying the late share. Final admission still checks
 * every actual driver field, including any data exceeding that allocation.
 * Use the registered fallback too: Runner may still hold its parsed old copy.
 */
export function assertNativeQueuedTurnBound(runId: string, text: string, queuedInput: string | null, withoutQueuedText: string): void {
  const withoutQueued = nativeFreshFallbackPayload(runId, { text: withoutQueuedText });
  const occupiedLate = Math.max(0, Buffer.byteLength(JSON.stringify(withoutQueued.text), "utf8") - 2 - NATIVE_TURN_KNOWN_MAX_BYTES);
  const reserve = Math.max(0, NATIVE_HANDOFF_COMMAND_RESERVE_BYTES - occupiedLate);
  assertNativeTurnCommandBound("turn.start", nativeFreshFallbackPayload(runId, {
    text, lateDataReserve: "x".repeat(reserve),
  }), undefined, queuedInput ? { kind: "queued_input", bytes: commandTextBytes(queuedInput) } : undefined);
}
const guarded = new WeakSet<DurablePrpControlPlane>();
/** Existing server authority-registration seam; no new Runner protocol/hook.
 * Measure the FINAL payload, including skill prefixes/descriptors and every late
 * prompt addition, before DurablePrpControlPlane can persist or dispatch it.
 */
export function guardNativeTurnCommands(authority: DurablePrpControlPlane): void {
  if (guarded.has(authority)) return;
  const queue = authority.queueCommand.bind(authority);
  authority.queueCommand = (type, payload = {}, commandId, deliverImmediately) => {
    if (type === "turn.start") payload = nativeFreshFallbackPayload(authority.store.state.identity.runId, payload);
    // Every PRP command can carry text or nested instructions/tool payloads.
    // Guard the complete serialized shell, not a hand-maintained command list.
    assertNativeTurnCommandBound(type, payload, commandId);
    return queue(type, payload, commandId, deliverImmediately);
  };
  guarded.add(authority);
}
