import { createHash } from "node:crypto";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import type { DurablePrpControlPlane, NativeSession } from "../../vendor/paperclip-runner/index.js";

// One split, in encoded UTF-8 journal-command bytes (not prompt characters).
// Runner journal: floor((1 MiB - 4096) / 2). The known envelope/continuation
// and handoff share the remainder after queued input and late-data reserves.
// The 64 KiB late-data allocation is extra room, NOT an allowance for variable
// provider fields. Pre-seal admission measures stock constraints, attachments,
// skill invocations/descriptors and the complete command shell independently.
// Unknown composition claims queued input only under a positively installed
// final guard, which measures ALL actual payload fields before journal queueing.
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
export type NativePromptRefusalCause = { kind: "task_description" | "newest_message" | "unread_message" | "unread_messages" | "queued_input" | "human_response" | "protected_input" | "protected_inputs" | "command" | "unmeasured_composition"; bytes: number; count?: number };
export function nativePromptRefusalTitle(cause?: NativePromptRefusalCause): string {
  const titles: Record<NativePromptRefusalCause["kind"], string> = {
    task_description: "Task description is too large", newest_message: "Newest message is too large",
    unread_message: "Unread message is too large", unread_messages: "Unread messages are too large",
    queued_input: "Queued input is too large", human_response: "Answer is too large",
    protected_input: "Required task input is too large", protected_inputs: "Required task inputs are too large", command: "Turn is too large",
    unmeasured_composition: "Queued input cannot be measured for this turn",
  };
  return cause ? titles[cause.kind] : "Turn is too large";
}
export function nativePromptRefusalDetail(cause?: NativePromptRefusalCause): string {
  if (!cause) return NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND_MESSAGE;
  if (cause.kind === "unmeasured_composition") return "This session's command composition cannot be measured before claiming or replaying this queued input. No queued messages or answers were consumed; they remain saved. The session's input delivery needs to be repaired before retrying.";
  const size = Math.ceil(cause.bytes / 1024);
  if (cause.kind === "task_description") return `The task description is ${size} KB. Shorten it before continuing. Saved task history remains available.`;
  if (cause.kind === "newest_message") return `The newest message is ${size} KB. Split it into smaller messages. Saved task history remains available.`;
  if (cause.kind === "unread_message") return `An unread message is ${size} KB. Shorten or split it before continuing. Saved task history remains available.`;
  if (cause.kind === "queued_input") return `The queued input is ${size} KB when encoded for this turn. Split it into smaller messages. This refusal does not claim or consume queued messages or answers; the input remains saved.`;
  if (cause.kind === "human_response") return `A person's answer is ${size} KB and is too large to send. The whole answer remains saved. The task needs a person's decision about how to continue.`;
  if (cause.kind === "unread_messages") return `${cause.count ?? "Multiple"} unread messages total ${size} KB. Their combined size is too large for this turn. Split the request before continuing. Saved task history remains available.`;
  if (cause.kind === "protected_input") return `Required task input is ${size} KB. Reduce the required task context before continuing. Saved task history remains available.`;
  if (cause.kind === "protected_inputs") return `Required task inputs total ${size} KB. Their combined size is too large for this turn. The task needs a person's decision about how to reduce its context. Saved task history remains available.`;
  return `The complete encoded turn is ${size} KB and is too large to send. Reduce the request or task context. Saved task history remains available.`;
}
export function nativePromptRefusalCause(value: unknown): NativePromptRefusalCause | undefined {
  const v = record(value);
  return ["task_description", "newest_message", "unread_message", "unread_messages", "queued_input", "human_response", "protected_input", "protected_inputs", "command", "unmeasured_composition"].includes(String(v.kind)) && Number.isSafeInteger(v.bytes) && Number(v.bytes) >= 0
    && (v.count === undefined || Number.isSafeInteger(v.count) && Number(v.count) > 0)
    ? v as NativePromptRefusalCause : undefined;
}
export function nativePromptCauseFromError(error: unknown): NativePromptRefusalCause | undefined {
  const direct = nativePromptRefusalCause(record(error).promptCause);
  if (direct) return direct;
  const match = (error instanceof Error ? error.message : "").match(/native_prompt_cause=(task_description|newest_message|unread_message|unread_messages|queued_input|human_response|protected_input|protected_inputs|command|unmeasured_composition):(\d+)(?::count=(\d+))?/);
  return match ? nativePromptRefusalCause({ kind: match[1], bytes: Number(match[2]), ...(match[3] ? { count: Number(match[3]) } : {}) }) : undefined;
}
export class NativeTurnPromptExceedsCommandBoundError extends Error {
  readonly code = NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND;
  constructor(readonly promptCause?: NativePromptRefusalCause) {
    super(`${NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND}: ${nativePromptRefusalDetail(promptCause)}${promptCause ? ` [native_prompt_cause=${promptCause.kind}:${promptCause.bytes}${promptCause.count === undefined ? "" : `:count=${promptCause.count}`}]` : ""}`);
  }
}

// Text is JSON-escaped in the envelope, then in command.payload.text.
export const commandTextBytes = (text: string) => Buffer.byteLength(JSON.stringify(JSON.stringify(text)), "utf8") - 6;
export const commandEnvelopeBytes = (envelope: object) => Buffer.byteLength(JSON.stringify(JSON.stringify(envelope)), "utf8") - 2;
export function nativeSessionHandoffMaxBytes(promptOrEnvelope: string | object): number {
  const room = NATIVE_TURN_KNOWN_MAX_BYTES - (typeof promptOrEnvelope === "string"
    ? commandTextBytes(promptOrEnvelope) : commandEnvelopeBytes(promptOrEnvelope));
  if (room < 0) throw new NativeTurnPromptExceedsCommandBoundError({ kind: "command", bytes: NATIVE_TURN_KNOWN_MAX_BYTES - room });
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
  refusalCause?: NativePromptRefusalCause | (() => NativePromptRefusalCause),
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
  throw new NativeTurnPromptExceedsCommandBoundError(typeof refusalCause === "function" ? refusalCause() : refusalCause);
}

const freshFallbacks = new Map<string, { original: string; bounded: string; staleEnvelope?: object; budgetedPrompt?: string }>();
export function registerNativeFreshFallback(runId: string, original: string, bounded: string, staleEnvelope?: object, budgetedEnvelope?: object): void {
  const prompt = record(record(budgetedEnvelope).task).prompt;
  freshFallbacks.set(runId, { original, bounded, staleEnvelope, ...(typeof prompt === "string" ? { budgetedPrompt: prompt } : {}) });
}
export function clearNativeFreshFallback(runId: string): void { freshFallbacks.delete(runId); }
export function nativeFreshFallbackPayload(runId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const fallback = freshFallbacks.get(runId);
  if (!fallback || typeof payload.text !== "string") return payload;
  // Stock Codex prepends explicit skill invocations outside the JSON envelope.
  // Preserve that exact provider-owned prefix while repairing the stale copy.
  const prefix = payload.text.match(/^\$[a-zA-Z0-9_-]+(?: \$[a-zA-Z0-9_-]+)*\n\n/)?.[0] ?? "";
  const anchorLength = Math.min(128, fallback.original.length);
  const looksLikeOriginal = (text: string) => text.length === fallback.original.length ||
    (anchorLength > 0 && (text.includes(fallback.original.slice(0, anchorLength)) ||
      text.includes(fallback.original.slice(-anchorLength))));
  const refuseStaleCopy = (text: string): never => { throw new NativeTurnPromptExceedsCommandBoundError({ kind: "protected_input", bytes: Buffer.byteLength(text) }); };
  let envelope: Record<string, unknown>;
  try { envelope = record(JSON.parse(payload.text.slice(prefix.length))); } catch {
    const text = payload.text.slice(prefix.length);
    if (looksLikeOriginal(text)) refuseStaleCopy(text);
    return payload;
  }
  const task = record(envelope.task);
  // The executor budgets its own object IN PLACE. Its pre-seal envelope is
  // already repaired; only the Runner's earlier parsed copy needs the swap.
  // Exact equality, not a substring of a potentially tiny bounded prompt.
  if (task.prompt === fallback.bounded || (fallback.budgetedPrompt !== undefined && task.prompt === fallback.budgetedPrompt)) return payload;
  // The fallback remains registered for this run, but later continuation,
  // disposition and compaction turns need not contain a bootstrap task.prompt.
  // Unrelated later turns go to the byte guard. A near-original stale copy
  // must not silently bypass the history cut or lose its protected-input cause.
  if (typeof task.prompt !== "string") return payload;
  if (!task.prompt.includes(fallback.original)) {
    if (looksLikeOriginal(task.prompt)) refuseStaleCopy(task.prompt);
    return payload;
  }
  // Runner parses/copies input before its continuity-break callback. Replace
  // that exact old bootstrap in the FINAL envelope, preserving late joiners.
  task.prompt = task.prompt.replace(fallback.original, () => fallback.bounded);
  return { ...payload, text: prefix + JSON.stringify(envelope) };
}
export function assertNativeTurnCommandBound(type: string, payload: Record<string, unknown>, commandId?: string, cause?: NativePromptRefusalCause): void {
  const command = { schema: "paperclip.prp.command.v1", commandId: commandId ?? "x".repeat(160),
    controllerSeq: Number.MAX_SAFE_INTEGER, type, issuedAt: new Date().toISOString(), payload, status: "pending", result: null };
  if (Buffer.byteLength(JSON.stringify(command), "utf8") > NATIVE_TURN_COMMAND_MAX_BYTES)
    throw new NativeTurnPromptExceedsCommandBoundError(cause ?? { kind: "command", bytes: Buffer.byteLength(JSON.stringify(payload), "utf8") });
}
// Stock nativeTaskConstraints: six entries, encoded bytes 55/63/609/405/629/275
// plus array/property punctuation = 2,084 journal bytes; ceil(2,084 * 1.10).
// Conversation stock is smaller (1,983). Dynamic paths/answer references and
// custom backends are measured separately, never assumed to fit this constant.
export const NATIVE_STOCK_CONSTRAINT_ALLOWANCE_BYTES = 2_293;
export type NativeQueuedTurnAdditions = {
  attachmentPrompt?: string; handoff?: string; constraints?: readonly string[];
  workingDirectory?: string | null; freshEnvelope?: object;
  /** Resolved stock descriptor paths, or conservative longest-path alternatives. */
  skillInputs?: readonly { type: "skill"; name: string; path: string }[];
  skillInvocation?: boolean;
  effort?: string;
  /** Unknown composition has no finite pre-seal proof; only a positively
   * installed final command guard can admit whole queued input without it. */
  unmeasuredPayload?: boolean;
};
/** Capability check for the stock composition contract, not turn admission. */
export function nativeQueuedTurnCompositionMeasured(provider: string, schema: string, additions?: NativeQueuedTurnAdditions): boolean {
  return Boolean(additions && !additions.unmeasuredPayload
    && ["pi_rpc", "codex", "opencode", "acpx"].includes(provider)
    && ["paperclip.native-execution-input.v5", "paperclip.native-execution-input.v7", "paperclip.native-execution-input.v9", "paperclip.native-execution-input.v10"].includes(schema));
}
const turnBudgetSnapshots = new WeakMap<object, { workingDirectory?: string | null }>();
/** Observe the snapshot already read by Runner, including a cached session
 * rebound to a new backend. One wrapper per session; no extra I/O or stacking.
 * Register note: this wraps session.snapshot on the NativeSession INSTANCE,
 * not its prototype or Runner source, and observes Runner's existing reads.
 */
export function observeNativeTurnBudgetSession(session: Pick<NativeSession, "snapshot">): Readonly<{ workingDirectory?: string | null }> {
  const prior = turnBudgetSnapshots.get(session);
  if (prior) return prior;
  const observation: { workingDirectory?: string | null } = {};
  const snapshot = session.snapshot.bind(session);
  session.snapshot = async (...args) => {
    const value = await snapshot(...args);
    observation.workingDirectory = value.workingDirectory ?? null;
    return value;
  };
  turnBudgetSnapshots.set(session, observation);
  return observation;
}
/** Server-only upper bound, in the journal's JSON-escaped UTF-8 bytes.
 * Runner appends attachment reference text and whole queued text with two
 * newlines, and prepends handoff text with the same joiner. File contents are
 * not in that prompt: each staged descriptor already contains its byteSize.
 * A continuation may omit constraints/handoff; counting them is conservative.
 * No Runner preview callback, protocol change, or provider I/O is required.
 */
export function nativeQueuedTurnUpperBound(runId: string, envelope: object, queuedInput: string | null, additions: NativeQueuedTurnAdditions = {}): number {
  if (additions.unmeasuredPayload) return Number.POSITIVE_INFINITY;
  const fallback = freshFallbacks.get(runId);
  const selected = fallback && additions.freshEnvelope ? additions.freshEnvelope : envelope;
  const bounded = nativeFreshFallbackPayload(runId, { text: JSON.stringify(selected) });
  // The Runner's parsed copy can retain completion source references while the
  // server deletes its binding after a cut. Count BOTH, not the smaller copy.
  const stale = fallback?.staleEnvelope && nativeFreshFallbackPayload(runId, { text: JSON.stringify(fallback.staleEnvelope) });
  const selectedSkills = record(selected).requestedSkills;
  const requested = Array.isArray(selectedSkills) ? selectedSkills.filter((name): name is string => typeof name === "string") : [];
  // A cached Codex session retains its earlier skillInputs across attachRun;
  // a full (non-continuation) turn can invoke them even if today's description
  // selects none. The warm compatibility digest fences the assigned context,
  // not the task description: cover ALL available descriptor alternatives.
  const invokesSkills = additions.skillInvocation !== false && record(selected).schema !== "paperclip.native-continuation.v1";
  const validSkillName = (name: string) => /^[a-zA-Z0-9_-]+$/.test(name);
  if (invokesSkills && (requested.length > 64 || new Set(requested).size !== requested.length || requested.some(name => !validSkillName(name)))) return Number.POSITIVE_INFINITY;
  // Assigned availability may exceed 64; counting its whole superset remains
  // conservative for any legal <=64 selection retained by the driver.
  const names = invokesSkills ? [...new Set([...requested, ...(additions.skillInputs?.map(skill => skill.name).filter(validSkillName) ?? [])])] : [];
  const skills = names.map(name => additions.skillInputs?.find(skill => skill.name === name));
  // A skill's mapped provider path is variable, not fixed slack. Missing
  // metadata fails closed instead of consuming a pretend 64 KiB allowance.
  if (skills.some(skill => !skill)) return Number.POSITIVE_INFINITY;
  const skillPrefix = names.length ? `${names.map(name => `$${name}`).join(" ")}\n\n` : "";
  const constraints = additions.constraints;
  const constraintBytes = constraints?.length
    ? commandEnvelopeBytes({ constraints }) - commandEnvelopeBytes({}) + 1 : 0;
  const supplements = [additions.handoff, additions.attachmentPrompt].filter((text): text is string => Boolean(text));
  const known = Math.max(Buffer.byteLength(JSON.stringify(bounded.text), "utf8") - 2,
    stale ? Buffer.byteLength(JSON.stringify(stale.text), "utf8") - 2 : 0)
    + (additions.workingDirectory ? commandTextBytes(additions.workingDirectory) : 0);
  const constraintAllowance = NATIVE_STOCK_CONSTRAINT_ALLOWANCE_BYTES + Math.max(0, constraintBytes - 2_084);
  const withoutQueued = known + constraintAllowance
    + supplements.reduce((bytes, text) => bytes + commandTextBytes(`\n\n${text}`), 0);
  // Every stock facade (Pi/Codex/OpenCode/ACPX) uses runnerd's turn.start
  // builder. These are ALL non-compaction fields at that boundary. Optional
  // bounded booleans/enums are counted at their largest encoding; variable
  // effort and resolved skill paths are measured, never funded by the reserve.
  const shell = { schema: "paperclip.prp.command.v1", commandId: "x".repeat(160), controllerSeq: Number.MAX_SAFE_INTEGER,
    type: "turn.start", issuedAt: new Date().toISOString(), payload: { text: skillPrefix,
      turnId: `turn_lab_${"x".repeat(32)}`, providerStartedTurns: true, performance: true, reasoningMode: "disabled",
      ...(additions.effort === undefined ? {} : { effort: additions.effort }), ...(skills.length ? { skills } : {}),
    }, status: "pending", result: null };
  const shellBytes = Buffer.byteLength(JSON.stringify(shell), "utf8");
  // Keep the allocation only as extra room. Measured driver fields and the
  // complete shell are NON-SPENDABLE even when late attachments exhaust it.
  const reserve = Math.max(0, NATIVE_HANDOFF_COMMAND_RESERVE_BYTES - Math.max(0, withoutQueued + shellBytes - NATIVE_TURN_KNOWN_MAX_BYTES));
  return shellBytes + withoutQueued + reserve + (queuedInput ? commandTextBytes(`\n\n${queuedInput}`) : 0);
}
/** Called inside the queued-input transaction, before any receipt is written.
 * False declines the claim, not the turn. With no queued input there is nothing
 * to pre-seal. Guarded backends measure the actual command before queueing;
 * callers must not infer that guarantee for an unknown backend.
 */
export function assertNativeQueuedTurnBound(runId: string, envelope: object, queuedInput: string | null, additions?: NativeQueuedTurnAdditions): void | false {
  if (queuedInput === null) return;
  const bytes = nativeQueuedTurnUpperBound(runId, envelope, queuedInput, additions);
  if (!Number.isFinite(bytes)) return false;
  if (bytes > NATIVE_TURN_COMMAND_MAX_BYTES) {
    const queuedAlone = queuedInput && nativeQueuedTurnUpperBound(runId, envelope, null, additions) <= NATIVE_TURN_COMMAND_MAX_BYTES;
    throw new NativeTurnPromptExceedsCommandBoundError({ kind: queuedAlone ? "queued_input" : "command",
      bytes: queuedAlone ? commandTextBytes(queuedInput!) : bytes });
  }
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
