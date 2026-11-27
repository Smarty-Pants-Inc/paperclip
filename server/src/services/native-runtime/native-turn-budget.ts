import { createHash } from "node:crypto";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { continuationResultIdentityKeys } from "../execution-continuation-identity.js";
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
export const NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND_MESSAGE = "The task input could not be sent, but this run has no readable explanation. Give your instance admin this run and the task title to check the agent's runtime and Paperclip versions; if you are the instance admin, check those versions directly. After the cause is fixed, send a message to continue. Saved messages and answers are kept.";
const nativePromptMeasures = ["command", "command_upper_bound", "prompt", "envelope", "handoff_note"] as const;
const nativePromptRemedies = ["edit_task_description", "edit_message", "delete_own_message", "new_followup_task", "report_defect", "check_versions"] as const;
export type Remedy = typeof nativePromptRemedies[number];
/** The known kind list lives here; title coverage is checked against it.
 * For command refusals, bytes names the measured thing through measure:
 * command = the WHOLE serialized guard command (including its conservative
 * sequence/identity shell); command_upper_bound = pre-seal command plus reserves;
 * prompt/envelope/handoff_note = that part's command-encoded bytes, NOT a turn.
 * Missing measure is supported only for older saved causes; never label those
 * bytes as a complete command. stale_copy.bytes is raw UTF-8 prompt evidence,
 * not evidence that the turn exceeds its byte limit. protected_inputs uses
 * protected_parts for the raw sum of located parts, or envelope_with_reserve
 * for the encoded envelope plus its reserved room. Readers retain unknown
 * kind/measure labels across version skew without guessing their meaning. */
type NativePromptRefusalKind = "task_description" | "newest_message" | "unread_message" | "unread_messages" | "queued_input" | "human_response" | "protected_input" | "protected_inputs" | "command" | "unmeasured_composition" | "stale_copy";
export type NativePromptRefusalCause = {
  kind: NativePromptRefusalKind | (string & {});
  bytes: number;
  /** Supported routes, not permission grants. edit_message requires an editable
   * queued message written by the reader; delete_own_message is author-only.
   * For command, edit_task_description applies only if it contains the long text;
   * report_defect applies when the task inputs are already small. A defect report
   * includes this run and the task title. new_followup_task stays short and links
   * to the saved context; it does not split the same text into more messages. */
  remedies: Array<Remedy>;
  count?: number;
  measure?: typeof nativePromptMeasures[number] | "protected_parts" | "envelope_with_reserve" | (string & {});
};
const nativePromptRefusalTitles: Record<string, string> = {
  task_description: "Task description is too large", newest_message: "Newest message is too large",
  unread_message: "Unread message is too large", unread_messages: "Unread messages are too large",
  queued_input: "Queued input is too large", human_response: "Answer is too large",
  protected_input: "Required task input is too large", protected_inputs: "Required task inputs are too large", command: "Turn is too large",
  unmeasured_composition: "Queued input cannot be measured for this turn",
  stale_copy: "Session input contains stale history",
} satisfies Record<NativePromptRefusalKind, string>;
/** Server-owned routes mirror the detail text; callers still check permissions.
 * Return fresh arrays so one cause cannot mutate another cause's routes. */
export function nativePromptRefusalRemedies(kind: NativePromptRefusalCause["kind"], measure?: NativePromptRefusalCause["measure"]): Array<Remedy> {
  const remedies = {
    task_description: ["edit_task_description", "new_followup_task"],
    newest_message: ["edit_message", "delete_own_message", "new_followup_task"],
    unread_message: ["edit_message", "delete_own_message", "new_followup_task"],
    unread_messages: ["edit_message", "delete_own_message", "new_followup_task"],
    queued_input: ["edit_message", "new_followup_task"],
    human_response: ["new_followup_task"],
    protected_input: ["new_followup_task"],
    protected_inputs: ["new_followup_task"],
    command: ["edit_task_description", "new_followup_task", "report_defect"],
    unmeasured_composition: ["report_defect"],
    stale_copy: ["report_defect"],
  } satisfies Record<NativePromptRefusalKind, readonly Remedy[]>;
  if (!Object.hasOwn(remedies, kind)) return ["check_versions"];
  if (measure && !["command", "protected_inputs", "unmeasured_composition", "stale_copy"].includes(kind)) return ["new_followup_task"];
  return [...remedies[kind as NativePromptRefusalKind]];
}
export function nativePromptRefusalTitle(cause?: NativePromptRefusalCause): string {
  return cause && Object.hasOwn(nativePromptRefusalTitles, cause.kind) ? nativePromptRefusalTitles[cause.kind]! : "Task input could not be sent";
}
export function nativePromptRefusalDetail(cause?: NativePromptRefusalCause): string {
  if (!cause) return NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND_MESSAGE;
  const followUp = "Create and assign a new short follow-up task linking to the long text or this task's saved context, rather than copying the long text into its description or messages. Send a short message there to start the work; this task stays stopped. Saved messages and answers are kept.";
  const defectReport = "This is a defect in the agent's runtime or Paperclip, not an admin setting you can repair. Report this run and the task title to the developers maintaining the agent's runtime or Paperclip. Your instance admin can pass on the report; if that is you, report it directly. After the fix is installed, send a message to continue. Saved messages and answers are kept.";
  if (!Object.hasOwn(nativePromptRefusalTitles, cause.kind)) return `This Paperclip version does not recognize the saved input-refusal reason. The saved diagnostic byte count is ${cause.bytes} bytes; its meaning is not known here. Give your instance admin this run and the task title to check the agent's runtime and Paperclip versions; if you are the instance admin, check those versions directly. After the cause is fixed, send a message to continue. Saved messages and answers are kept.`;
  if (cause.kind === "unmeasured_composition") return `Paperclip could not check the complete turn's size before taking the queued input. No queued messages or answers were consumed; they remain saved. ${defectReport}`;
  if (cause.kind === "stale_copy") return `The agent's input still includes an old copy of task history that Paperclip left out to make room. ${defectReport}`;
  const size = Math.ceil(cause.bytes / 1024);
  // Do not reinterpret a future measurement label as today's raw input bytes.
  if (cause.measure && cause.kind !== "command" && cause.kind !== "protected_inputs") return `The saved byte count (${cause.bytes} bytes) has no recognized measurement label for this input. ${followUp}`;
  if (cause.kind === "task_description") return `The task description is ${size} KB. Edit the description on the task page to shorten it to a brief request with links to the long text. Then send a message to continue. Or ${followUp.charAt(0).toLowerCase() + followUp.slice(1)}`;
  if (cause.kind === "newest_message" || cause.kind === "unread_message") return `${cause.kind === "newest_message" ? "The newest message" : "An unread message"} is ${size} KB. If you wrote it and it is still editable, edit it in the task's message queue to a short request with a link to the long text. If it is no longer editable, you can save its text elsewhere and delete your own oversized message. After either change, send a short message to continue. Otherwise, ${followUp.charAt(0).toLowerCase() + followUp.slice(1)}`;
  if (cause.kind === "queued_input") return `The queued input is ${size} KB when encoded for this turn. If it is a message you wrote and it is still editable, edit it in the task's message queue to a short request with a link to the long text, then send a short message to continue. Sending the same text as several messages can exceed the same combined limit. Otherwise, ${followUp.charAt(0).toLowerCase() + followUp.slice(1)} This refusal does not claim or consume queued messages or answers.`;
  if (cause.kind === "human_response") return `A person's answer is ${size} KB and is too large to send. The whole answer remains saved; a submitted answer cannot be edited here. ${followUp}`;
  if (cause.kind === "unread_messages") return `${cause.count ?? "Multiple"} unread messages total ${size} KB. Their combined size is too large for this turn; sending the same text as several smaller messages does not reduce it. If you wrote the messages and they are still editable, shorten them in the task's message queue to brief requests with links to the long text, then send a short message to continue. You can instead save your own oversized messages elsewhere and delete them, then send a short message to continue. Otherwise, ${followUp.charAt(0).toLowerCase() + followUp.slice(1)}`;
  if (cause.kind === "protected_input") return `Required task input is ${size} KB: task instructions other than the description, or a saved message that this turn must keep. ${followUp}`;
  if (cause.kind === "protected_inputs") {
    const measurement = cause.measure === "protected_parts" ? `The located required inputs total ${size} KB before command encoding.`
      : cause.measure === "envelope_with_reserve" ? `The encoded task envelope, including reserved room, is ${size} KB.`
      : "The required inputs exceed this turn's budget; the saved byte count has no recognized measurement label.";
    return `${measurement} ${followUp}`;
  }
  const measured: Record<string, string> = {
    command: `The serialized command measured by the guard is ${size} KB and exceeds the turn's byte budget.`,
    command_upper_bound: `The command upper bound, including reserved room, is ${size} KB and exceeds the turn's byte budget.`,
    prompt: `The encoded prompt is ${size} KB and leaves no room for history within the turn's byte budget.`,
    envelope: `The encoded envelope is ${size} KB and leaves no room for history within the turn's byte budget.`,
    handoff_note: `Even the encoded history-omission note (${size} KB) does not fit in the room left for history.`,
  };
  return `${cause.measure && Object.hasOwn(measured, cause.measure) ? measured[cause.measure] : "The turn exceeds its byte budget; the saved byte count has no recognized measurement label."} If the description contains the long text, edit the description on the task page to shorten it, then send a message to continue. Otherwise, ${followUp.charAt(0).toLowerCase() + followUp.slice(1)} If the task inputs are already small, ${defectReport.charAt(0).toLowerCase() + defectReport.slice(1)}`;
}
export function nativePromptRefusalCause(value: unknown): NativePromptRefusalCause | undefined {
  const v = record(value);
  // A newer writer may know a kind or measure this reader does not. Preserve
  // the readable evidence; only the unknown label's presentation falls back.
  return typeof v.kind === "string" && /^[^\s:\[\]]+$/.test(v.kind) && Number.isSafeInteger(v.bytes) && Number(v.bytes) >= 0
    && (v.count === undefined || Number.isSafeInteger(v.count) && Number(v.count) > 0)
    && (v.measure === undefined || typeof v.measure === "string" && /^[^\s:\[\]]+$/.test(v.measure))
    && (v.remedies === undefined || Array.isArray(v.remedies)
      && v.remedies.every(remedy => typeof remedy === "string" && /^[a-z_]+$/.test(remedy)))
    // A future route must not erase the readable kind/bytes. Do not advertise
    // an unsupported action; legacy causes keep an empty, non-inferred list.
    ? { ...v, remedies: (v.remedies as string[] | undefined ?? []).filter(remedy => nativePromptRemedies.some(known => known === remedy)) } as NativePromptRefusalCause : undefined;
}
export function nativePromptCauseFromError(error: unknown): NativePromptRefusalCause | undefined {
  const direct = nativePromptRefusalCause(record(error).promptCause);
  if (direct) return direct;
  // Read unfamiliar labels too; presentation, not parsing, owns known labels.
  const match = (error instanceof Error ? error.message : "").match(/native_prompt_cause=([^\s:\[\]]+):(\d+)(?::count=(\d+))?(?::measure=([^\s:\[\]]+))?(?::remedies=([a-z_,]*))?(?=\]|$|\s)/);
  return match ? nativePromptRefusalCause({ kind: match[1], bytes: Number(match[2]), ...(match[3] ? { count: Number(match[3]) } : {}), ...(match[4] ? { measure: match[4] } : {}), ...(match[5] === undefined ? {} : { remedies: match[5] ? match[5].split(",") : [] }) }) : undefined;
}
export type NativeInputRevision = {
  descriptionRevision: string;
  messages: Array<{ id: string; revision: string; deleted: boolean }>;
  fingerprint: string;
};
/** Source revisions, not wake kind or rendered task wrappers. No message text is saved. */
export function nativeInputRevision(issue: { title: string; description: string | null },
  messages: Array<{ id: string; authorType: string; createdByRunId?: string | null; updatedAt: string; deleted: boolean }>): NativeInputRevision {
  const revision = {
    descriptionRevision: createHash("sha256").update(JSON.stringify([issue.title, issue.description])).digest("hex"),
    messages: messages.filter(message => message.authorType === "user" && !message.createdByRunId)
      .map(message => ({ id: message.id, revision: message.updatedAt, deleted: message.deleted }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { ...revision, fingerprint: createHash("sha256").update(JSON.stringify(revision)).digest("hex") };
}
export class NativeTurnPromptExceedsCommandBoundError extends Error {
  inputRevision?: NativeInputRevision;
  readonly code = NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND;
  constructor(readonly promptCause?: NativePromptRefusalCause) {
    super(`${NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND}: ${nativePromptRefusalDetail(promptCause)}${promptCause ? ` [native_prompt_cause=${promptCause.kind}:${promptCause.bytes}${promptCause.count === undefined ? "" : `:count=${promptCause.count}`}${promptCause.measure === undefined ? "" : `:measure=${promptCause.measure}`}:remedies=${promptCause.remedies.join(",")}]` : ""}`);
  }
}

// Text is JSON-escaped in the envelope, then in command.payload.text.
export const commandTextBytes = (text: string) => Buffer.byteLength(JSON.stringify(JSON.stringify(text)), "utf8") - 6;
export const commandEnvelopeBytes = (envelope: object) => Buffer.byteLength(JSON.stringify(JSON.stringify(envelope)), "utf8") - 2;
export function nativeSessionHandoffMaxBytes(promptOrEnvelope: string | object): number {
  const room = NATIVE_TURN_KNOWN_MAX_BYTES - (typeof promptOrEnvelope === "string"
    ? commandTextBytes(promptOrEnvelope) : commandEnvelopeBytes(promptOrEnvelope));
  if (room < 0) throw new NativeTurnPromptExceedsCommandBoundError({ kind: "command", remedies: nativePromptRefusalRemedies("command"), bytes: NATIVE_TURN_KNOWN_MAX_BYTES - room,
    measure: typeof promptOrEnvelope === "string" ? "prompt" : "envelope" });
  return Math.min(NATIVE_WHOLE_HANDOFF_MAX_BYTES, room);
}

export type NativeContinuationReadState = {
  lastRunAt: string | null;
  readCommentIds: string[];
  nativeSessionId?: string | null;
  providerSessionId?: string | null;
};
export type NativeContinuationCoverage = ExecutionContinuationEnvelope["coverage"] & {
  omitted?: Array<{ id: string; updatedAt: string }>;
  nativeSessionId?: string;
  providerSessionId?: string;
};
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function nativeContinuationReadState(value: unknown, target?: {
  nativeSessionId: string | null; providerSessionId: string | null;
} | null): NativeContinuationReadState {
  const state = record(value);
  const nativeSessionId = typeof state.nativeSessionId === "string" ? state.nativeSessionId : null;
  const providerSessionId = typeof state.providerSessionId === "string" ? state.providerSessionId : null;
  // null is an explicitly fresh generation. Missing/legacy provenance never
  // authorizes cuts in a selected session; parsing alone preserves old state.
  const sameGeneration = target === undefined || !!(target && nativeSessionId && providerSessionId
    && nativeSessionId === target.nativeSessionId && providerSessionId === target.providerSessionId);
  return { lastRunAt: typeof state.lastRunAt === "string" ? state.lastRunAt : null,
    nativeSessionId, providerSessionId,
    readCommentIds: sameGeneration && Array.isArray(state.readCommentIds)
      ? state.readCommentIds.filter((id): id is string => typeof id === "string") : [] };
}

/** Resolve the previous provider from the saving run's own evidence, never
 * from a read projection stamped with the currently selected provider. */
export function nativeContinuationProviderSessionId(
  savingRun: { nativeSessionId: string | null; runnerProfileJson: unknown; contextSnapshot?: unknown } | null | undefined,
  normalizedSessionId: string,
  savingEventProviderId?: string | null,
): string | null {
  const checkpoint = record(record(savingRun?.runnerProfileJson).sessionCheckpoint);
  if ((savingRun?.nativeSessionId ?? checkpoint.sessionId) !== normalizedSessionId) return null;
  if (typeof checkpoint.providerSessionId === "string" && checkpoint.providerSessionId) return checkpoint.providerSessionId;
  if (typeof savingEventProviderId === "string" && savingEventProviderId) return savingEventProviderId;
  const context = record(savingRun?.contextSnapshot);
  const state = nativeContinuationReadState(context.nativeContinuationReadState);
  return state.nativeSessionId === normalizedSessionId ? state.providerSessionId ?? null : null;
}

/** Pure rendering budget: unknown read state protects everything, never guesses. */
export function boundNativeExecutionContinuation(
  original: ExecutionContinuationEnvelope,
  measure: (continuation: ExecutionContinuationEnvelope) => number,
  readState?: NativeContinuationReadState,
  isReadOperation: (operationId: string) => boolean = () => false,
  refusalCause?: NativePromptRefusalCause | (() => NativePromptRefusalCause),
  isWriteOperation: (operationId: string) => boolean = () => false,
): ExecutionContinuationEnvelope {
  if (measure(original) <= NATIVE_TURN_KNOWN_MAX_BYTES) return original;
  const continuation = { ...original, messages: [...original.messages], completedActions: [...(original.completedActions ?? [])],
    coverage: { ...original.coverage, omitted: [...((original.coverage as NativeContinuationCoverage).omitted ?? [])] } };
  const coverage = continuation.coverage as typeof continuation.coverage & {
    truncated?: boolean; omittedMessages?: number; omittedCompletedActions?: number; shortenedCompletedActions?: number;
  };
  const mark = () => { coverage.truncated = true; coverage.omittedMessages ??= 0;
    coverage.omittedCompletedActions ??= 0; coverage.shortenedCompletedActions ??= 0; };
  // Callers classify through runner-api-catalog, not a verb guess. Reads go
  // first, then writes, before any message omission. Unknown operations stay
  // stock; receipts never disappear or move, even when the largest body goes first.
  const receipts = continuation.completedActions.map((receipt, index) => ({ receipt, index,
    serialized: JSON.stringify(receipt.result) ?? "null" }))
    .map(value => ({ ...value, bytes: commandTextBytes(value.serialized) }))
    .sort((a, b) => b.bytes - a.bytes);
  const pick = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
  const identity = (value: unknown) => pick(record(value), continuationResultIdentityKeys);
  const locator = (value: unknown) => typeof value === "string" && value.trim().length > 0
    || typeof value === "number" && Number.isSafeInteger(value);
  const findable = (value: Record<string, unknown>) => locator(value.id) || locator(value.key)
    || locator(value.identifier) || locator(value.number);
  // Keep the wrapper shape and each child's identity, never its response body.
  const resourceIdentity = (value: unknown) => {
    const resource = record(value);
    return { ...identity(resource), ...Object.fromEntries(Object.entries(resource)
      .filter(([, child]) => findable(record(child))).map(([key, child]) => [key, identity(child)])) };
  };
  for (const write of [false, true]) for (const { receipt, index, serialized, bytes } of receipts) {
    if (write ? isReadOperation(receipt.operationId) || !isWriteOperation(receipt.operationId) : !isReadOperation(receipt.operationId)) continue;
    const result = record(receipt.result);
    if (result.resultOmittedForSize === true) continue;
    // Failed/unknown writes are evidence, not successful save receipts. Keep
    // their errors, outcome and retry guidance whole, even under size pressure.
    if (write && (result.ok !== true || result.status !== undefined
      && !(typeof result.status === "number" && result.status >= 200 && result.status < 300)
      || result.outcome === "unknown" || result.error)) continue;
    if (write && Array.isArray(result.data) && (result.data.length > 20 || result.data.length === 0)) continue;
    const topIdentity = write ? identity(result) : {};
    const dataIdentity = write ? (Array.isArray(result.data) ? result.data.map(resourceIdentity) : resourceIdentity(result.data)) : {};
    const hasResourceIdentity = (value: Record<string, unknown>) => findable(value) || Object.values(value).some(child => findable(record(child)));
    // Every bulk target must remain findable. In particular, never hide the
    // targets after the 20-element cap behind a misleading re-read note.
    if (write && Array.isArray(dataIdentity) && !dataIdentity.every(hasResourceIdentity)) continue;
    const artifact = record(result.artifact);
    if (write && !findable(topIdentity) && !(Array.isArray(dataIdentity)
      ? dataIdentity.length > 0 : hasResourceIdentity(dataIdentity))
      && !locator(artifact.artifactId) && !locator(artifact.url)) continue;
    const shortened = { ...pick(result, ["operationId", "ok", "status", "kind", "target"]), ...topIdentity,
      ...(Object.keys(dataIdentity).length ? { data: dataIdentity } : {}),
      ...(write && result.artifact !== undefined ? { artifact: result.artifact } : {}),
      resultOmittedForSize: true, note: write
        ? "Result omitted for size; the write succeeded. Re-read the target by its id if needed."
        : "Result omitted for size; re-read if needed.",
      resultSha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}` };
    if (commandTextBytes(JSON.stringify(shortened)) >= bytes) continue;
    continuation.completedActions[index] = { ...receipt, result: shortened };
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

const freshFallbacks = new Map<string, { original: string; bounded: string; removedMiddle: string; staleEnvelope?: object; budgetedPrompt?: string }>();
export function registerNativeFreshFallback(runId: string, original: string, bounded: string, staleEnvelope?: object, budgetedEnvelope?: object): void {
  const prompt = record(record(budgetedEnvelope).task).prompt;
  // Anchor only in the original's differing middle, never the shared wake
  // preamble/footer or prompt length. Retained content alone is not evidence
  // of a stale copy; the matcher below verifies the WHOLE differing slice.
  let start = 0, end = original.length, boundedEnd = bounded.length;
  while (start < end && start < boundedEnd && original[start] === bounded[start]) start++;
  while (end > start && boundedEnd > start && original[end - 1] === bounded[boundedEnd - 1]) { end--; boundedEnd--; }
  const removedMiddle = original.slice(start, end);
  freshFallbacks.set(runId, { original, bounded, removedMiddle, staleEnvelope, ...(typeof prompt === "string" ? { budgetedPrompt: prompt } : {}) });
}
export function clearNativeFreshFallback(runId: string): void { freshFallbacks.delete(runId); }
function withinOneEdit(original: string, candidate: string): boolean {
  if (Math.abs(original.length - candidate.length) > 1) return false;
  let first = 0;
  while (first < original.length && first < candidate.length && original[first] === candidate[first]) first++;
  if (first === original.length && first === candidate.length) return true;
  return original.slice(first + (original.length >= candidate.length ? 1 : 0))
    === candidate.slice(first + (candidate.length >= original.length ? 1 : 0));
}
function containsRemovedMiddle(text: string, original: string): boolean {
  if (text.includes(original)) return true;
  // One edit leaves at least one of two disjoint halves intact. Use those
  // content anchors to locate candidates, then verify the complete removed
  // slice (one substitution/insertion/deletion allowed). A retained half by
  // itself must NOT refuse the bounded prompt plus a late joiner.
  const split = Math.ceil(original.length / 2);
  for (const [anchor, offset] of [[original.slice(0, split), 0], [original.slice(split), split]] as const) {
    if (!anchor) continue;
    // Bound work even for repetitive history; inspect both ends of the prompt,
    // accommodating ordinary handoff/attachment wrappers without a quadratic
    // scan of every occurrence of a repeated history fragment.
    for (const found of new Set([text.indexOf(anchor), text.lastIndexOf(anchor)])) {
      if (found < 0) continue;
      for (const shift of [-1, 0, 1]) {
        const start = found - offset + shift;
        if (start < 0) continue;
        for (const length of [original.length - 1, original.length, original.length + 1]) {
          if (start + length <= text.length && withinOneEdit(original, text.slice(start, start + length))) return true;
        }
      }
    }
  }
  return false;
}
export function nativeFreshFallbackPayload(runId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const fallback = freshFallbacks.get(runId);
  if (!fallback || typeof payload.text !== "string") return payload;
  // Stock Codex prepends explicit skill invocations outside the JSON envelope.
  // Preserve that exact provider-owned prefix while repairing the stale copy.
  const prefix = payload.text.match(/^\$[a-zA-Z0-9_-]+(?: \$[a-zA-Z0-9_-]+)*\n\n/)?.[0] ?? "";
  const looksLikeOriginal = (text: string) => fallback.removedMiddle.length > 0
    && !fallback.bounded.includes(fallback.removedMiddle) && containsRemovedMiddle(text, fallback.removedMiddle);
  const refuseStaleCopy = (text: string): never => { throw new NativeTurnPromptExceedsCommandBoundError({ kind: "stale_copy", bytes: Buffer.byteLength(text), remedies: nativePromptRefusalRemedies("stale_copy") }); };
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
  // Unrelated later turns go to the byte guard. Only an exact copy (repaired
  // below) or a ONE-edit copy whose removed-history anchors are unique in the
  // prompt is caught and refused as stale_copy (not as an oversized input). Other stale copies under
  // the final byte bound (two or more edits, or a removed region repeated
  // elsewhere) go out with their history uncut; the final guard still bounds
  // their bytes. No current producer of such copies is known.
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
  const bytes = Buffer.byteLength(JSON.stringify(command), "utf8");
  if (bytes > NATIVE_TURN_COMMAND_MAX_BYTES)
    throw new NativeTurnPromptExceedsCommandBoundError(cause ?? { kind: "command", bytes, measure: "command", remedies: nativePromptRefusalRemedies("command") });
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
    throw new NativeTurnPromptExceedsCommandBoundError(queuedAlone
      ? { kind: "queued_input", bytes: commandTextBytes(queuedInput!), remedies: nativePromptRefusalRemedies("queued_input") }
      : { kind: "command", bytes, measure: "command_upper_bound", remedies: nativePromptRefusalRemedies("command") });
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
