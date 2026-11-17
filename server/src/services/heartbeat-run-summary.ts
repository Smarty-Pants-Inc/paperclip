import { createHash } from "node:crypto";
import type {
  RunPresentationDecision,
  RunPresentationSource,
} from "@paperclipai/shared";

export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

/** Operator diagnostics are untrusted provider data, not model handoff prose. */
export function summarizeRunErrorForModel(error: string | null, terminalFailureCategory?: unknown): string | null {
  if (terminalFailureCategory == null) return error;
  const category = typeof terminalFailureCategory === "string"
    && ["connection", "access", "limit", "service", "request", "unknown"].includes(terminalFailureCategory)
    ? terminalFailureCategory
    : "unknown";
  return `ACP agent reported a terminal ${category} failure. Provider diagnostics are available in the run record.`;
}

function truncateSummaryText(
  value: unknown,
  maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS,
) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? (record[key] ?? null) : undefined;
}

/**
 * Splits a message around one `<proposed_plan>` block. The tags must sit on
 * their own lines outside fenced code, so quoting or documenting the tag never
 * creates a proposal.
 */
function splitProposedPlanBlock(value: string): { plan: string | null; rest: string; unclosedStart: number | null } {
  const lines = value.split("\n");
  let fence: string | null = null;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    // Fences are tracked inside the block too, so a fenced example tag in
    // the plan never opens or closes it.
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker) {
      fence = fence === null ? marker[0]! : (trimmed.startsWith(fence) ? null : fence);
      continue;
    }
    if (fence !== null) continue;
    if (start < 0 && /^<proposed_plan>$/i.test(trimmed)) start = index;
    else if (start >= 0 && /^<\/proposed_plan>$/i.test(trimmed)) {
      return {
        plan: lines.slice(start + 1, index).join("\n").trim(),
        rest: [...lines.slice(0, start), ...lines.slice(index + 1)].join("\n").trim(),
        unclosedStart: null,
      };
    }
  }
  // An opening tag outside fences that never closes: a cut-off preview.
  return {
    plan: null,
    rest: value,
    unclosedStart: start < 0 ? null : lines.slice(0, start).join("\n").length,
  };
}

/**
 * Marker the runner appends when it cuts provider text to a run-log display
 * preview. Text ending with it is an incomplete copy, never a final reply.
 */
export const RUN_EVENT_TEXT_BOUND_MARKER = "…[truncated]";

export function isBoundedRunEventText(value: unknown): boolean {
  return typeof value === "string" && value.endsWith(RUN_EVENT_TEXT_BOUND_MARKER);
}

/**
 * The posted reply leaves a proposal to its Plan document. A stored message
 * preview can be cut inside the block; its cut-off remainder is hidden too.
 */
function withoutProposedPlanBlock(value: string): string {
  const { plan, rest, unclosedStart } = splitProposedPlanBlock(value);
  if (plan !== null) return rest;
  if (!isBoundedRunEventText(value) || unclosedStart === null) return value;
  return value.slice(0, unclosedStart).trim();
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (
    !resultJson ||
    typeof resultJson !== "object" ||
    Array.isArray(resultJson)
  ) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = [
    "total_cost_usd",
    "cost_usd",
    "costUsd",
  ] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

// An untyped adapter summary can be raw inter-tool narration (assistantTexts
// concatenated by the adapter), which must never be published verbatim to the
// board — see BRO-1507 / BRO-1516. Typed final messages and accepted PRP results
// are semantic output, so they intentionally bypass this legacy safety check.
// Apostrophes are matched as a character class so both the straight (') and
// curly (’) forms count — agents emit either. Openers are narration phrases a
// declarative status summary would not begin with ("Fixed X", "13/13 pass").
const NARRATION_OPENERS =
  /^(let me\b|i['’]ll\b|i['’]m going\b|i need to\b|i can see\b|now i['’]ll\b|next,? i['’]ll\b|looking at\b|fetching\b|checking\b|first,)/i;

export const LEGACY_WITHHELD_RUN_COMMENT =
  "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).";

export const RUN_PRESENTATION_RESOLVER_VERSION = "2";
export const CHAT_RUN_PRESENTATION_AUTHORIZATION_REASON =
  "allow_chat_run_presentation";

export type RunPresentationCommentAction = "reuse" | "create" | "none";

/**
 * A native conversation turn whose live presentation ran before its own
 * finalization committed (the finalization lease was busy) cannot know the
 * committed answered rule yet. Its `none` is provisional: the publication stays
 * pending and committed-response recovery resolves it from committed state.
 */
export const NATIVE_PRESENTATION_PENDING_COMMIT = "native_presentation_pending_commit";

export function isPendingCommitPresentation(decision: unknown): boolean {
  if (!decision || typeof decision !== "object") return false;
  const value = decision as { commentAction?: unknown; commentId?: unknown; reasonCodes?: unknown };
  return value.commentAction === "none" && typeof value.commentId !== "string" &&
    Array.isArray(value.reasonCodes) && value.reasonCodes.includes(NATIVE_PRESENTATION_PENDING_COMMIT);
}
export type { RunPresentationDecision } from "@paperclipai/shared";

export interface ResolvedHeartbeatRunResponse {
  text: string | null;
  decision: RunPresentationDecision;
}

export interface CompletedFinalAgentMessageCandidate {
  seq: number;
  text: string;
  sourceEventId: string | null;
  channel: "final" | "unknown";
  /** The run log kept only a display preview of this message. */
  bounded?: boolean;
  /**
   * dl-n5-cont2 C1: built from a completed final stored truncated. Its text
   * (the rebuilt answer, or the plain undeliverable line) always outranks a
   * semantic summary.
   */
  truncatedFinal?: boolean;
  /** dl-n5-cont5: the answer item's id ('<turn>:pi-message:N:block:M' for Pi). */
  itemId?: string | null;
}

/** The assistant agent-message kinds, both spellings (PRP v1 `assistant_message`, current `agentMessage`). */
export function isAgentMessageKind(kind: unknown): boolean {
  return kind === "agentMessage" || kind === "assistant_message";
}

/**
 * dl-n5-cont5: Pi gives every text block its own item, '<turn>:pi-message:N:block:M'.
 * The message is '<turn>:pi-message:N'; an id of another shape is its own message.
 */
function answerItemPosition(itemId: string | null | undefined): { message: string; n: number; block: number } | null {
  if (!itemId) return null;
  const match = /^(.*:pi-message:(\d+)):block:(\d+)$/u.exec(itemId);
  return match ? { message: match[1]!, n: Number(match[2]), block: Number(match[3]) } : null;
}

/**
 * dl-n5-cont5 (RFL ruling 17:47Z): THE ANSWER of a turn is ALL text blocks of
 * its LAST assistant message (the highest N; the message of the latest block),
 * in block order (M), completed or streamed, the cut tail included. Earlier
 * assistant messages (commentary before a tool step) are not the reply; they
 * stay in the transcript. The ONE function both the completed selector and
 * the failed-turn assembly use. `seq` orders blocks whose ids are not Pi's.
 */
export function lastAssistantMessageAnswer<T extends { itemId?: string | null; seq: number; text: string }>(
  blocks: readonly T[],
): { blocks: T[]; pieces: string[]; text: string } | null {
  const withText = blocks.filter((block) => block.text.trim().length > 0);
  if (withText.length === 0) return null;
  const latest = withText.reduce((last, block) => (block.seq > last.seq ? block : last));
  const position = answerItemPosition(latest.itemId);
  const message = position
    ? withText.filter((block) => answerItemPosition(block.itemId)?.message === position.message)
    : [latest];
  const ordered = [...message].sort((a, b) =>
    (answerItemPosition(a.itemId)?.block ?? 0) - (answerItemPosition(b.itemId)?.block ?? 0) || a.seq - b.seq);
  const pieces = ordered.map((block) => block.text);
  return { blocks: ordered, pieces, text: joinAnswerPieces(pieces) };
}

/**
 * A bounded native retry can exist solely because a completed provider turn
 * omitted its semantic result. In that case the retry is a disposition-only
 * recovery turn: prose it emits must not displace the real final response
 * already produced by the completed work turn. The boundary is protocol
 * state, not a length heuristic or narration regex.
 */
export function selectHeartbeatRunFinalAgentMessage(input: {
  candidates: CompletedFinalAgentMessageCandidate[];
  semanticResultRecoveryAfterSeq?: number | null;
}): (CompletedFinalAgentMessageCandidate & { reasonCode: string }) | null {
  const candidates = [...input.candidates].sort((a, b) => b.seq - a.seq);
  if (candidates.length === 0) return null;
  const boundary = input.semanticResultRecoveryAfterSeq;
  const preRecovery =
    typeof boundary === "number"
      ? candidates.filter((candidate) => candidate.seq < boundary)
      : [];
  const eligible = preRecovery.length > 0 ? preRecovery : candidates;
  const latest =
    eligible.find((candidate) => candidate.channel === "final") ??
    eligible.find((candidate) => candidate.channel === "unknown");
  if (!latest) return null;
  const beforeRecovery = preRecovery.includes(latest);
  // dl-n5-cont5: the answer is every text block of the latest block's message.
  const answer = lastAssistantMessageAnswer(eligible.filter((candidate) => candidate.channel === latest.channel
    && candidate.seq <= latest.seq));
  const blocks = answer?.blocks ?? [latest];
  const undeliverable = blocks.length > 1 && blocks.some((block) => block.text === TRUNCATED_FINAL_UNDELIVERABLE_TEXT);
  const selected: CompletedFinalAgentMessageCandidate = blocks.length > 1 ? {
    ...latest,
    text: undeliverable ? TRUNCATED_FINAL_UNDELIVERABLE_TEXT : answer!.text,
    ...(blocks.some((block) => block.bounded) ? { bounded: true } : {}),
    ...(blocks.some((block) => block.truncatedFinal) ? { truncatedFinal: true } : {}),
  } : latest;
  return {
    ...selected,
    reasonCode:
      selected.channel === "final"
        ? beforeRecovery
          ? "pre_semantic_result_recovery_final_agent_message"
          : "latest_non_empty_completed_final_agent_message"
        : beforeRecovery
          ? "pre_semantic_result_recovery_terminal_assistant_message"
          : "latest_non_empty_completed_terminal_assistant_message",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiresChatOriginProof(source: string): boolean {
  return source === "tool_action_review" || source === "issue.monitor" || source === "native_status_decision" ||
    source.startsWith("issue.comment") || source.startsWith("issue.interaction.") ||
    source === "external_chat.interaction.resolve" || source === "connection_intent.resolved" || source === "issue.update";
}

export function isExternalChatPresentationContext(
  contextSnapshot: unknown,
  verifiedToolReviewChatOrigin = false,
): boolean {
  const context = record(contextSnapshot);
  const wake = record(context.paperclipWake);
  const source =
    typeof context.source === "string" ? context.source.trim() : "";
  // Approvals and Board comments also resume ordinary internal tasks. Only
  // durable source-run or mirrored-comment proof authorizes an external reply.
  if (requiresChatOriginProof(source))
    return verifiedToolReviewChatOrigin;
  return (
    source.startsWith("chat:") ||
    context.externalChatContinuation === true ||
    wake.externalInteractionContinuation === true
  );
}

export function isChatOriginPublicationCandidate(contextSnapshot: unknown): boolean {
  const context = record(contextSnapshot);
  const source = typeof context.source === "string" ? context.source.trim() : "";
  return requiresChatOriginProof(source) || isExternalChatPresentationContext(contextSnapshot);
}

/**
 * Read only completed assistant prose that can participate in final-response
 * presentation. A canonical `final` is authoritative; `unknown` is retained
 * solely for the compatibility fallback selected by the resolver. Other
 * channels and item kinds remain activity, never durable reply candidates.
 */
/**
 * Item ids whose `<proposed_plan>` block became a completed `plan.proposed`
 * event. Only those replies leave the plan to its Plan document.
 */
export function completedPlanProposalIds(rows: readonly { payload: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const payload = record(record(record(row.payload).prpEvent).payload);
    if (payload.status === "completed" && typeof payload.proposalId === "string") {
      ids.add(payload.proposalId);
    }
  }
  return ids;
}

/** Pi keeps a bounded display preview beside the identity of the WHOLE text. */
function projectedFullTextReference(payload: Record<string, unknown>): { bytes: number; sha256: string } | null {
  const fullText = record(payload.fullText);
  return typeof fullText.bytes === "number" && Number.isSafeInteger(fullText.bytes) && fullText.bytes > 0
    && typeof fullText.sha256 === "string" && /^[a-f0-9]{64}$/u.test(fullText.sha256)
    ? { bytes: fullText.bytes, sha256: fullText.sha256 } : null;
}

export function readCompletedAssistantMessageCandidate(input: {
  seq: number;
  prpEvent: unknown;
  /** Item ids with a recorded proposal; other replies keep their plan text. */
  proposedItemIds?: ReadonlySet<string>;
}): CompletedFinalAgentMessageCandidate | null {
  const prpEvent = record(input.prpEvent);
  const payload = record(prpEvent.payload);
  // `assistant_message` is the shipped PRP v1 spelling used by older replay
  // fixtures and persisted native runs. New providers emit `agentMessage`,
  // but both represent the same canonical assistant item at this boundary.
  if (payload.kind !== "agentMessage" && payload.kind !== "assistant_message") {
    return null;
  }
  if (payload.channel !== "final" && payload.channel !== "unknown") {
    return null;
  }
  // A harness's `<proposed_plan>` block that became a recorded proposal is the
  // task's Plan document and approval card; that reply keeps only the
  // surrounding prose. Without a recorded proposal the reply keeps the plan.
  const itemId = typeof prpEvent.itemId === "string" ? prpEvent.itemId
    : typeof payload.itemId === "string" ? payload.itemId : null;
  const proposed = itemId !== null && input.proposedItemIds?.has(itemId) === true;
  // A projector preview is not the answer, even though it has a text field.
  // The completed-or-truncated reader rebuilds and verifies its stored deltas.
  if (projectedFullTextReference(payload)) return null;
  const text = readCommentText(
    typeof payload.text === "string" && proposed ? withoutProposedPlanBlock(payload.text) : payload.text,
  );
  if (!text) return null;
  return {
    seq: input.seq,
    text,
    sourceEventId: readCommentText(prpEvent.sourceEventId),
    channel: payload.channel,
    ...(itemId !== null ? { itemId } : {}),
    ...(isBoundedRunEventText(payload.text) ? { bounded: true } : {}),
  };
}

/** Maximum UTF-8 bytes per completion comment, including its label and fence repairs. */
export const FINAL_ANSWER_COMMENT_MAX_BYTES = 250 * 1024;

/**
 * One splitter for completed finals and failed-turn prefixes. Answer content is
 * never trimmed or excerpted. Prefer complete lines outside code fences; when a
 * fence itself spans parts, close/reopen it for independent Markdown rendering.
 * Only those synthetic fence wrappers and the part labels are added.
 */
export function splitFinalAnswerComments(text: string): string[] {
  return splitFinalAnswerParts(text).map(part => part.body);
}

/** H5 round 2: one part of a multipart answer, with exactly what was added around its content. */
export type FinalAnswerPart = { body: string; label: string; prefix: string; suffix: string };

/**
 * The splitter with its additions recorded: `body` is `label + prefix +
 * content + suffix`, where `prefix`/`suffix` are the synthetic fence wrappers.
 * A single part (under the limit) is the text itself with nothing added.
 */
export function splitFinalAnswerParts(text: string): FinalAnswerPart[] {
  if (Buffer.byteLength(text) <= FINAL_ANSWER_COMMENT_MAX_BYTES) return [{ body: text, label: "", prefix: "", suffix: "" }];
  type Fence = { marker: string; opening: string };
  const breaks: { end: number; fence: Fence | null }[] = [];
  let fence: Fence | null = null;
  const lines = /[^\n]*\n|[^\n]+$/gu;
  for (const match of text.matchAll(lines)) {
    const line = match[0].replace(/\r?\n$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      if (!fence && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
        fence = { marker: marker[1]!, opening: line };
      } else if (fence && marker[1]![0] === fence.marker[0] && marker[1]!.length >= fence.marker.length && !marker[2]!.trim()) {
        fence = null;
      }
    }
    breaks.push({ end: match.index + match[0].length, fence });
  }
  // Reserve enough for even the largest possible part numbers in a JS string.
  const labelBudget = Buffer.byteLength(`part ${text.length} of ${text.length}\n`);
  const fenceBudget = breaks.reduce((max, entry) => Math.max(max, entry.fence ? Buffer.byteLength(entry.fence.marker) + 1 : 0), 0);
  const parts: { prefix: string; content: string; suffix: string }[] = [];
  let start = 0, breakIndex = 0;
  let startFence: Fence | null = null;
  while (start < text.length) {
    const prefix = startFence ? `${startFence.opening}\n` : "";
    // A fence opened in this part may need a closing wrapper. Reserve the
    // longest marker so that choosing a line boundary never exceeds the cap.
    const budget = FINAL_ANSWER_COMMENT_MAX_BYTES - labelBudget - Buffer.byteLength(prefix) - fenceBudget;
    if (budget < 4) throw new Error("Code fence delimiter or opening line exceeds the completion comment limit");
    let low = start, high = Math.min(text.length, start + budget);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(text.slice(start, middle)) <= budget) low = middle;
      else high = middle - 1;
    }
    if (low < text.length && /[\uD800-\uDBFF]/u.test(text[low - 1]!)) low--;
    let end = low;
    let endFence: Fence | null = startFence;
    let lastLine: (typeof breaks)[number] | undefined;
    let lastOutside: (typeof breaks)[number] | undefined;
    let cursor = breakIndex;
    while (cursor < breaks.length && breaks[cursor]!.end <= low) {
      lastLine = breaks[cursor++]!;
      if (!lastLine.fence) lastOutside = lastLine;
    }
    const preferred = low === text.length ? null : (lastOutside ?? lastLine);
    if (preferred && preferred.end > start) end = preferred.end;
    while (breakIndex < breaks.length && breaks[breakIndex]!.end <= end) endFence = breaks[breakIndex++]!.fence;
    const suffix = end < text.length && endFence ? `\n${endFence.marker}` : "";
    parts.push({ prefix, content: text.slice(start, end), suffix });
    start = end;
    startFence = endFence;
  }
  return parts.map((part, index) => {
    const label = `part ${index + 1} of ${parts.length}\n`;
    return { body: `${label}${part.prefix}${part.content}${part.suffix}`, label, prefix: part.prefix, suffix: part.suffix };
  });
}

/** H5 round 2: the part metadata addComment records on every part of one logical answer. */
export type AnswerPartMetadata = { answerId: string; index: number; count: number; label: string; prefix: string; suffix: string };

export function readAnswerPartMetadata(metadata: unknown): AnswerPartMetadata | null {
  const part = record(record(metadata).answerPart);
  return typeof part.answerId === "string" && Number.isInteger(part.index) && Number.isInteger(part.count)
    && typeof part.label === "string" && typeof part.prefix === "string" && typeof part.suffix === "string"
    ? part as AnswerPartMetadata : null;
}

/** One part's content: its body without the recorded label and fence wrappers (null when they do not match). */
export function answerPartContent(body: string, part: AnswerPartMetadata): string | null {
  const head = `${part.label}${part.prefix}`;
  if (!body.startsWith(head) || !body.endsWith(part.suffix) || body.length < head.length + part.suffix.length) return null;
  return body.slice(head.length, body.length - part.suffix.length);
}

/**
 * H5 round 2: the WHOLE logical answer `anchor` belongs to, assembled from all
 * its parts in `comments` in part order (label-stripped, fence-unwrapped), so
 * it is byte-equal to the source. Part identity/order come from metadata, not
 * the display label. If additions cannot be identified safely, retain ALL part
 * bodies whole instead. Null when `anchor` is not a part or a part is missing.
 */
export function assembleAnswerParts<T extends { id: string; body?: string | null; metadata?: unknown }>(
  anchor: T, comments: readonly T[]): { text: string; partIds: string[]; first: T } | null {
  const anchorPart = readAnswerPartMetadata(anchor.metadata);
  if (!anchorPart) return null;
  const byIndex = new Map<number, { comment: T; content: string | null; body: string }>();
  for (const comment of comments) {
    const part = readAnswerPartMetadata(comment.metadata);
    if (!part || part.answerId !== anchorPart.answerId || part.count !== anchorPart.count) continue;
    if (typeof comment.body !== "string") return null;
    let content = answerPartContent(comment.body, part);
    if (content === null) {
      // Labels are editable display text. Recognise a damaged label line, but
      // use only metadata for identity/order and validate the stored wrappers.
      const label = /^part [1-9]\d* of [1-9]\d*\r?\n/iu.exec(comment.body)?.[0];
      if (label) content = answerPartContent(comment.body, { ...part, label });
    }
    byIndex.set(part.index, { comment, content, body: comment.body });
  }
  const ordered = [];
  for (let index = 1; index <= anchorPart.count; index++) {
    const entry = byIndex.get(index);
    if (!entry) return null;
    ordered.push(entry);
  }
  const unwrapped = ordered.every(entry => entry.content !== null);
  return { text: ordered.map(entry => unwrapped ? entry.content : entry.body).join(""),
    partIds: ordered.map(entry => entry.comment.id), first: ordered[0]!.comment };
}

/**
 * H5 round 2: posted comment bodies (in posting order) as logical responses:
 * every multipart answer becomes ONE whole body, other comments are unchanged.
 */
export function logicalCommentBodies(comments: readonly { id: string; body: string; metadata?: unknown }[]): string[] {
  const bodies: string[] = [];
  const seen = new Set<string>();
  for (const comment of comments) {
    const part = readAnswerPartMetadata(comment.metadata);
    if (!part) { bodies.push(comment.body); continue; }
    if (seen.has(part.answerId)) continue;
    seen.add(part.answerId);
    const whole = assembleAnswerParts(comment, comments);
    if (whole) { bodies.push(whole.text); continue; }
    // Incomplete: what each posted part really showed, without its additions.
    for (const other of comments) {
      const otherPart = readAnswerPartMetadata(other.metadata);
      if (otherPart?.answerId === part.answerId) bodies.push(answerPartContent(other.body, otherPart) ?? other.body);
    }
  }
  return bodies;
}

/**
 * A completed agent message whose stored payload lost its text to a generic
 * retention bound (`{truncated: true, byteSize}`, dl-n5-66k run 5184ca23).
 * Its identity survives on the PRP envelope; its text survives in the stored
 * live deltas of the same item.
 */
export function readTruncatedCompletedAgentMessageItemId(prpEvent: unknown): string | null {
  const event = record(prpEvent);
  const payload = record(event.payload);
  if (!projectedFullTextReference(payload) && (payload.truncated !== true || typeof payload.text === "string")) return null;
  if (payload.kind !== undefined && payload.kind !== "agentMessage" && payload.kind !== "assistant_message") return null;
  if (payload.channel !== undefined && payload.channel !== "final") return null;
  return typeof event.itemId === "string" && event.itemId.length > 0 ? event.itemId : null;
}

/**
 * The whole text of one agent message rebuilt from its stored live deltas, in
 * order. Null when any delta of the item is itself cut or not text: a partial
 * rebuild is never presented as the answer.
 */
export function reassembleAgentMessageFromDeltas(
  rows: readonly { seq: number; payload: unknown }[],
  itemId: string,
): string | null {
  const parts: { seq: number; text: string }[] = [];
  for (const row of rows) {
    const event = record(record(row.payload).prpEvent);
    if (event.eventType !== "item.delta" || event.itemId !== itemId) continue;
    const payload = record(event.payload);
    if (payload.truncated === true || !isAgentMessageKind(payload.kind) || typeof payload.text !== "string"
      || isBoundedRunEventText(payload.text)) return null;
    parts.push({ seq: row.seq, text: payload.text });
  }
  if (parts.length === 0) return null;
  const text = parts.sort((a, b) => a.seq - b.seq).map((part) => part.text).join("");
  return text.trim() ? text : null;
}

/**
 * A final answer whose completed event was stored without text, rebuilt from
 * its deltas, so the semantic summary never wins over it (dl-n5-66k).
 */
export function readTruncatedCompletedAssistantMessageCandidate(input: {
  seq: number;
  prpEvent: unknown;
  deltaRows: readonly { seq: number; payload: unknown }[];
}): CompletedFinalAgentMessageCandidate | null {
  const itemId = readTruncatedCompletedAgentMessageItemId(input.prpEvent);
  if (!itemId) return null;
  const rebuilt = reassembleAgentMessageFromDeltas(input.deltaRows, itemId);
  const reference = projectedFullTextReference(record(record(input.prpEvent).payload));
  // A projected preview includes the whole text's receipt. Missing deltas must
  // not turn a successful partial rebuild into an apparently complete answer.
  const whole = rebuilt !== null && (!reference || (Buffer.byteLength(rebuilt) === reference.bytes
    && createHash("sha256").update(rebuilt).digest("hex") === reference.sha256)) ? rebuilt : null;
  // dl-n5-cont2 C1: a truncated final exists but cannot be rebuilt whole (a
  // stored delta is itself cut). The summary never stands in for it: the
  // person gets ONE plain, true line.
  return {
    seq: input.seq,
    text: whole ?? TRUNCATED_FINAL_UNDELIVERABLE_TEXT,
    sourceEventId: readCommentText(record(input.prpEvent).sourceEventId),
    channel: "final",
    truncatedFinal: true,
    itemId,
  };
}

/** dl-n5-cont2 C1: the one line posted when a truncated final cannot be rebuilt whole. */
export const TRUNCATED_FINAL_UNDELIVERABLE_TEXT =
  "The answer couldn't be delivered whole here; it's kept in the conversation; ask me to show it.";

/**
 * dl-n5-cont2 C2: the final-answer candidate for one completed agent message
 * event, intact or stored truncated. A truncated one is rebuilt from its
 * stored deltas (loaded only then), else the plain undeliverable line.
 */
export async function readCompletedOrTruncatedFinalCandidate(input: {
  seq: number;
  prpEvent: unknown;
  proposedItemIds?: ReadonlySet<string>;
  loadDeltaRows: (itemId: string) => Promise<readonly { seq: number; payload: unknown }[]>;
}): Promise<CompletedFinalAgentMessageCandidate | null> {
  const intact = readCompletedAssistantMessageCandidate(input);
  if (intact) return intact;
  const itemId = readTruncatedCompletedAgentMessageItemId(input.prpEvent);
  if (!itemId) return null;
  return readTruncatedCompletedAssistantMessageCandidate({ seq: input.seq, prpEvent: input.prpEvent,
    deltaRows: await input.loadDeltaRows(itemId) });
}

/** Why a turn stopped after streaming answer text (dl-n5-cont). */
export type CutAnswerCause = "output_limit" | "stream_ended" | "failed";

function cutAnswerCause(code: unknown): CutAnswerCause {
  if (code === "pi_output_truncated" || code === "max_tokens" || code === "length") return "output_limit";
  if (code === "pi_provider_error" || code === "pi_rpc_transport_failed" || code === "pi_turn_idle_timeout") return "stream_ended";
  return "failed";
}

const CUT_ANSWER_NOTE: Record<CutAnswerCause, string> = {
  output_limit: "The answer stopped here because it hit the model's output limit. Paperclip is continuing it from exactly this point in the next reply.",
  stream_ended: "The answer stopped here because the connection to the model ended mid-answer. Paperclip is continuing it from exactly this point in the next reply.",
  failed: "The answer stopped here because the run failed mid-answer. Paperclip is continuing it from exactly this point in the next reply.",
};

/** The answer items of one turn as one reply, in order, separated by a blank line (dl-n5-cont3 F3). */
export function joinAnswerPieces(pieces: readonly string[]): string {
  return pieces.reduce((joined, piece) => !joined ? piece
    : `${joined}${joined.endsWith("\n\n") ? "" : joined.endsWith("\n") ? "\n" : "\n\n"}${piece}`, "");
}

/**
 * dl-n5-cont4: how much of a cut answer the person was REALLY shown, read
 * from the bodies the run posted (in order). The leading answer items found
 * whole, in order, in the posted text; `whole` when every item was shown.
 */
export function shownCutAnswer(cut: { pieces: readonly string[]; text: string; candidate: { text: string } },
  postedBodies: readonly string[]): { text: string; whole: boolean } | null {
  // dl-n5-cont5 (c): an ending that differs only by trailing whitespace (a
  // trailing newline) was shown; compare with trailing whitespace normalised.
  const bodies = postedBodies.map((body) => body.trimEnd());
  if (bodies.includes(cut.candidate.text.trimEnd())) return { text: cut.text, whole: true };
  const posted = bodies.join("\n");
  let from = 0;
  const shown: string[] = [];
  for (const piece of cut.pieces) {
    const needle = piece.trimEnd();
    const at = posted.indexOf(needle, from);
    if (at < 0) break;
    shown.push(piece);
    from = at + needle.length;
  }
  if (shown.length === 0) return null;
  return { text: joinAnswerPieces(shown), whole: shown.length === cut.pieces.length };
}

/**
 * dl-n5-cont (Paul NOTE 5): a turn that streamed answer text as item.delta
 * events and then FAILED (pi_output_truncated at the output cap, a provider
 * EOF) has no completed answer, yet the person must get what was streamed,
 * first and once. Returns the streamed prefix of ALL the failed turn's agent
 * message items in order (dl-n5-cont3 F3), each rebuilt with
 * `reassembleAgentMessageFromDeltas`, and the candidate to post: the WHOLE
 * prefix (dl-n5-cont3 F1: never an excerpt) and ONE true note. dl-n5-cont5:
 * the items are THE ANSWER's, the text blocks of the turn's last assistant
 * message (`lastAssistantMessageAnswer`), completed or streamed. Null when the
 * last turn did not fail or when no answer text was streamed.
 */
export function readFailedTurnStreamedAnswer(rows: readonly { seq: number; payload: unknown }[]): {
  itemId: string;
  itemIds: string[];
  /** dl-n5-cont4: each answer item's whole text, in order (the pieces `text` joins). */
  pieces: string[];
  /** dl-n5-cont4: the seq of the failed turn's first answer event. */
  startSeq: number;
  text: string;
  cause: CutAnswerCause;
  candidate: CompletedFinalAgentMessageCandidate & { reasonCode: string };
} | null {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const eventOf = (row: { payload: unknown }) => record(record(row.payload).prpEvent);
  let lastTerminal: { seq: number; event: Record<string, unknown> } | null = null;
  let previousTerminalSeq = 0;
  for (const row of ordered) {
    const event = eventOf(row);
    if (typeof event.eventType === "string" && /^turn\.(completed|failed|cancelled|interrupted)$/u.test(event.eventType)) {
      if (lastTerminal) previousTerminalSeq = lastTerminal.seq;
      lastTerminal = { seq: row.seq, event };
    }
  }
  if (!lastTerminal || lastTerminal.event.eventType !== "turn.failed") return null;
  const failedTurnId = typeof lastTerminal.event.turnId === "string" ? lastTerminal.event.turnId : null;
  // dl-n5-cont3 F3: EVERY agentMessage item the failed turn streamed, in the
  // order its first delta arrived; never only the last one. dl-n5-cont4: an
  // item that COMPLETED is one of the turn's answer items too (even with no
  // stored delta), in the order it first appeared.
  const firstSeq = new Map<string, number>();
  for (const row of ordered) {
    if (row.seq > lastTerminal.seq) break;
    const event = eventOf(row);
    if ((event.eventType !== "item.delta" && event.eventType !== "item.completed") || typeof event.itemId !== "string") continue;
    if (failedTurnId && typeof event.turnId === "string" ? event.turnId !== failedTurnId : row.seq <= previousTerminalSeq) continue;
    const payload = record(event.payload);
    if (!isAgentMessageKind(payload.kind)) continue;
    if (event.eventType === "item.completed" && !(typeof payload.text === "string" && payload.text.trim())) continue;
    if (!firstSeq.has(event.itemId)) firstSeq.set(event.itemId, row.seq);
  }
  if (firstSeq.size === 0) return null;
  const completedText = (id: string) => {
    for (const row of ordered) {
      const event = eventOf(row);
      const payload = record(event.payload);
      if (event.eventType === "item.completed" && event.itemId === id && typeof payload.text === "string"
        && payload.text.trim().length > 0) return payload.text;
    }
    return null;
  };
  // dl-n5-cont5 (RFL ruling): the reply is THE ANSWER, every text block of
  // the turn's LAST assistant message (completed or streamed, the cut tail
  // included), through the same function as the completed selector. Earlier
  // messages stay in the transcript and are not posted. A failed turn whose
  // last message completed still posts it here, whole, with the one note.
  const upToTerminal = ordered.filter((row) => row.seq <= lastTerminal!.seq);
  const blocks: { itemId: string; seq: number; text: string }[] = [];
  for (const [id, seq] of firstSeq) {
    const text = completedText(id) ?? reassembleAgentMessageFromDeltas(upToTerminal, id);
    // A partial rebuild is never presented as the answer.
    blocks.push({ itemId: id, seq, text: text ?? UNREBUILT_BLOCK });
  }
  const answer = lastAssistantMessageAnswer(blocks);
  if (!answer || answer.pieces.includes(UNREBUILT_BLOCK)) return null;
  const { pieces, text } = answer;
  const itemIds = answer.blocks.map((block) => block.itemId);
  // The failed turn's first answer event (any message): a completed item of
  // this turn, even an earlier message's, never outranks the turn's answer.
  const startSeq = Math.min(...firstSeq.values());
  const itemId = itemIds[itemIds.length - 1]!;
  const cause = cutAnswerCause(record(record(lastTerminal.event.payload).error).code);
  return {
    itemId,
    itemIds,
    pieces,
    startSeq,
    text,
    cause,
    candidate: {
      seq: lastTerminal.seq,
      // dl-n5-cont3 F1: the rebuilt prefix is posted WHOLE, never an excerpt
      // (comments have no 250 KiB cap), so the ending the continuation quotes
      // is text the person was really shown.
      text: `${text}${text.endsWith("\n") ? "" : "\n"}\n— ${CUT_ANSWER_NOTE[cause]}`,
      sourceEventId: readCommentText(lastTerminal.event.sourceEventId),
      channel: "final",
      reasonCode: "failed_turn_streamed_answer_prefix",
    },
  };
}

/** Marks a block of the failed turn whose stored deltas cannot be rebuilt whole. */
const UNREBUILT_BLOCK = "\u0000unrebuilt";

/** dl-n5-cont2 item 3: the one note when a turn spent its whole output budget thinking. */
export const THINKING_CAP_STOP_NOTE = "The model used its whole output budget thinking; continuing with the answer.";
/** dl-n5-cont2 item 3: the one note when the single automatic continuation also stopped at the cap. */
export const THINKING_CAP_STOP_AGAIN_NOTE =
  "The model ran out of output budget again before answering. Press Retry to try once more.";
/** dl-n5-cont2 item 3: the continuation's opening instruction after a thinking-only cap stop. */
export const THINKING_CAP_STOP_CONTINUATION_INSTRUCTION =
  "Write the answer now; keep further thinking short. The person has not seen any answer yet.";

/**
 * dl-n5-cont2 item 3: the run's last turn failed at the output cap
 * (`pi_output_truncated`) and streamed no answer text at all: the model used
 * its whole output budget thinking. Null otherwise (a turn with streamed text
 * is `readFailedTurnStreamedAnswer`'s).
 */
export function readThinkingOnlyCapStop(rows: readonly { seq: number; payload: unknown }[]): {
  seq: number;
  sourceEventId: string | null;
} | null {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const eventOf = (row: { payload: unknown }) => record(record(row.payload).prpEvent);
  let last: { seq: number; event: Record<string, unknown> } | null = null;
  for (const row of ordered) {
    const event = eventOf(row);
    if (typeof event.eventType === "string" && /^turn\.(completed|failed|cancelled|interrupted)$/u.test(event.eventType)) {
      last = { seq: row.seq, event };
    }
  }
  if (!last || last.event.eventType !== "turn.failed") return null;
  if (record(record(last.event.payload).error).code !== "pi_output_truncated") return null;
  const turnId = typeof last.event.turnId === "string" ? last.event.turnId : null;
  const answered = ordered.some((row) => {
    if (row.seq > last!.seq) return false;
    const event = eventOf(row);
    if (turnId && typeof event.turnId === "string" && event.turnId !== turnId) return false;
    if (event.eventType !== "item.delta" && event.eventType !== "item.completed") return false;
    const payload = record(event.payload);
    return (payload.kind === "agentMessage" || payload.kind === "assistant_message")
      && ((typeof payload.text === "string" && payload.text.trim().length > 0) || payload.truncated === true);
  });
  if (answered) return null;
  return { seq: last.seq, sourceEventId: readCommentText(last.event.sourceEventId) };
}

const CUT_ANSWER_TAIL_CHARS = 600;

/**
 * What the continuation of a cut answer is told (dl-n5-cont rule 3). When the
 * streamed prefix was posted, it continues from exactly its end and never
 * repeats it or points at text the person did not see. When it was not
 * posted, it restarts the whole answer and says so plainly.
 */
export function cutAnswerContinuationInstruction(input: { text: string; cause: CutAnswerCause | string; posted: boolean;
  /** dl-n5-cont4: only the leading part of what was written (`text`) was posted. */
  partial?: boolean }): string {
  const why = input.cause === "output_limit" ? "it hit the model's output limit"
    : input.cause === "stream_ended" ? "the connection to the model ended mid-answer" : "the run failed mid-answer";
  if (!input.posted) {
    return `Your previous answer to the person stopped before it finished because ${why}, and none of it was shown to them. `
      + "Write the whole answer now, starting the answer again from the beginning, and say plainly in one line at the top that you are "
      + "starting the answer again from the beginning. Do not refer to any earlier reply.";
  }
  const tail = input.text.slice(-CUT_ANSWER_TAIL_CHARS);
  // dl-n5-cont3 F1: the prefix is always posted whole, so its ending was shown.
  // dl-n5-cont4: when only its leading items were posted, it says so; `text` is what was shown.
  const shown = input.partial
    ? "Only the first part of what you had written was posted to the person as your reply, exactly as written; the rest was not shown to them. "
    : "The part you had written was posted to the person as your reply, exactly as written. ";
  return `Your previous answer to the person stopped before it finished because ${why}. ${shown}`
    + `It ends with exactly this text:\n\n<<<END OF POSTED TEXT\n${tail}\nEND OF POSTED TEXT>>>\n\n`
    + "Continue exactly where it stopped: begin with the next words after that ending, as one answer. Do not repeat or summarize "
    + "any of the posted text and do not restart the answer. Never say that any part is in an earlier reply unless it is in the posted text above. "
    + "If the rest is long, write it as compactly as the content allows.";
}

function readAcceptedSemanticSummary(resultJson: Record<string, unknown>) {
  const candidates = semanticResultCandidates(resultJson);
  for (const candidate of candidates) {
    if (candidate.schema !== "paperclip.run_result.v1") continue;
    // A yielded result is a control-plane liveness fact, not a final assistant
    // response. Its summary belongs in diagnostics/system state while the
    // durable interaction card remains the user-facing surface.
    if (candidate.reportedWorkDisposition === "yielded") continue;
    const summary = readCommentText(candidate.summary);
    if (summary) return summary;
  }
  return null;
}

function semanticResultCandidates(resultJson: Record<string, unknown>) {
  return [
    record(resultJson.nativeResult),
    record(resultJson.acceptedResult),
    record(record(resultJson.semanticResult).result),
  ];
}

export function hasAcceptedSemanticResult(
  resultJson: Record<string, unknown> | null | undefined,
) {
  return semanticResultCandidates(record(resultJson)).some(
    (candidate) => candidate.schema === "paperclip.run_result.v1",
  );
}

function hasYieldedSemanticResult(resultJson: Record<string, unknown>) {
  return semanticResultCandidates(resultJson).some(
    (candidate) =>
      candidate.schema === "paperclip.run_result.v1" &&
      candidate.reportedWorkDisposition === "yielded",
  );
}

export function readAcceptedTaskContinuationSummary(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  const result = record(resultJson);
  if (result.finalizationPhase !== "committed") return null;
  const kind = result.finalizationReasonCode === "live_continuation_registered" ? "same_agent"
    : ["scheduled_monitor_waiting", "scheduled_monitor_dispatched", "scheduled_monitor_preserved"].includes(String(result.finalizationReasonCode)) ? "monitor" : null;
  if (!kind) return null;
  for (const candidate of semanticResultCandidates(result)) {
    const continuation = record(candidate.continuation);
    if (candidate.schema === "paperclip.run_result.v1" && candidate.reportedWorkDisposition === "yielded" &&
        continuation.kind === kind && readCommentText(continuation.idempotencyKey)) {
      return readCommentText(candidate.summary);
    }
  }
  return null;
}

function readAcceptedExternalChatResponseWakeSummary(
  resultJson: Record<string, unknown>,
  reviewPresentationAuthorized = false,
  committedResponseAuthorized = false,
) {
  const nativeResult = record(resultJson.nativeResult);
  const continuation = record(nativeResult.continuation);
  if (
    resultJson.finalizationPhase !== "committed" ||
    (!committedResponseAuthorized &&
      resultJson.finalizationReasonCode !== "external_chat_response_waiting" &&
      !(
        reviewPresentationAuthorized &&
        resultJson.finalizationReasonCode === "governed_response_waiting"
      )) ||
    nativeResult.schema !== "paperclip.run_result.v1" ||
    nativeResult.reportedWorkDisposition !== "yielded" ||
    continuation.kind !== "response_wake" ||
    !readCommentText(continuation.summary) ||
    !readCommentText(continuation.idempotencyKey)
  ) {
    return null;
  }
  return readCommentText(nativeResult.summary);
}

export function projectHistoricalHeartbeatRunComment(
  body: string,
  resultJson: Record<string, unknown> | null | undefined,
) {
  if (body !== LEGACY_WITHHELD_RUN_COMMENT) return body;
  return readAcceptedSemanticSummary(record(resultJson)) ?? body;
}

function readMarkedAdapterFinalResponse(resultJson: Record<string, unknown>) {
  const structured = record(resultJson.finalResponse);
  if (structured.disposition === "final" || structured.final === true) {
    return (
      readCommentText(structured.text) ?? readCommentText(structured.message)
    );
  }
  if (resultJson.finalResponseDisposition === "final") {
    return (
      readCommentText(resultJson.finalResponseText) ??
      readCommentText(resultJson.finalResponse)
    );
  }
  return null;
}

function isStructuredSemanticResultText(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).schema === "paperclip.run_result.v1",
    );
  } catch {
    return false;
  }
}

function decision(
  chosenSource: RunPresentationSource,
  input: {
    sourceEventId?: string | null;
    commentAction: RunPresentationCommentAction;
    commentId?: string | null;
    reasonCodes: string[];
  },
): RunPresentationDecision {
  return {
    schema: "paperclip.run_presentation_decision.v1",
    resolverVersion: RUN_PRESENTATION_RESOLVER_VERSION,
    chosenSource,
    sourceEventId: input.sourceEventId ?? null,
    commentAction: input.commentAction,
    commentId: input.commentId ?? null,
    activityDisposition: "collapse",
    reasonCodes: input.reasonCodes,
  };
}

/**
 * Resolve durable user-facing prose independently from the semantic run status.
 * The returned text is never truncated. Callers may persist only the bounded
 * decision record and materialize the exact text as an issue comment.
 */
export function resolveHeartbeatRunResponse(input: {
  resultJson: Record<string, unknown> | null | undefined;
  /** Server-owned conversation finalization, after normal governance checks. */
  conversationTurnFinished?: boolean;
  existingComment?: { id: string; body?: string | null } | null;
  interactionOwnsResponse?: boolean;
  preferFinalResponseOverExistingComment?: boolean;
  nativeConversationFinalResponse?: boolean;
  externalChatResponseWakeSummaryAuthorized?: boolean;
  /** Server-only proof of the exact accepted response after durable status
   * finalization. Never read this capability from provider/context JSON. */
  externalChatCommittedResponseWakeSummaryAuthorized?: boolean;
  externalChatReviewResponseSummaryAuthorized?: boolean;
  finalAgentMessage?: {
    text: string;
    sourceEventId: string | null;
    channel: "final" | "unknown";
    reasonCode?: string;
    bounded?: boolean;
    truncatedFinal?: boolean;
  } | null;
}): ResolvedHeartbeatRunResponse {
  const resultJson = record(input.resultJson);
  const continuationSummary = readAcceptedTaskContinuationSummary(resultJson);
  if (continuationSummary) {
    if (input.interactionOwnsResponse) return {
      text: null,
      decision: decision("none", { commentAction: "none", reasonCodes: ["interaction_owns_response"] }),
    };
    const existing = input.existingComment;
    const reuse = existing?.body === continuationSummary;
    return {
      text: continuationSummary,
      decision: decision("semantic_result_summary", {
        commentAction: reuse ? "reuse" : "create",
        ...(reuse ? { commentId: existing.id } : {}),
        reasonCodes: [resultJson.finalizationReasonCode === "live_continuation_registered"
          ? "accepted_task_continuation_summary" : "accepted_scheduled_monitor_summary"],
      }),
    };
  }
  const rawFinalAgentText = readCommentText(input.finalAgentMessage?.text);
  // The result summary is a schema-capped preview (12,000 characters). When it
  // is the leading part of the run's complete final answer, the person gets the
  // whole answer, never the cut preview (pack-n5 (i), Paul NOTE 5).
  const wholeAnswer = (summary: string): string => {
    // dl-n5-cont2 C1/C2: a truncated completed final exists; its rebuilt text
    // or its plain undeliverable line is the reply, never the summary.
    if (input.finalAgentMessage?.truncatedFinal === true && rawFinalAgentText) return rawFinalAgentText;
    const whole = input.finalAgentMessage?.channel === "final" && input.finalAgentMessage.bounded !== true
      && rawFinalAgentText && !isBoundedRunEventText(rawFinalAgentText) ? rawFinalAgentText : null;
    return whole && whole.length > summary.length && whole.startsWith(summary) ? whole : summary;
  };
  // A run-log preview is an incomplete copy of the agent's message. It never
  // outranks a complete source; it is posted only when no complete text exists.
  const boundedFinalAgentText =
    rawFinalAgentText &&
    (input.finalAgentMessage?.bounded === true || isBoundedRunEventText(rawFinalAgentText))
      ? rawFinalAgentText
      : null;
  const finalAgentText = boundedFinalAgentText ? null : rawFinalAgentText;
  const explicitProviderFinal = input.finalAgentMessage?.channel === "final";
  const compatibleTerminalAssistant =
    input.finalAgentMessage?.channel === "unknown";
  const resolveCompletedUpstreamResponse = (allowCompatibility = true) => {
    if (
      explicitProviderFinal &&
      finalAgentText &&
      !isStructuredSemanticResultText(finalAgentText)
    ) {
      return {
        text: finalAgentText,
        decision: decision("final_agent_message", {
          sourceEventId: input.finalAgentMessage?.sourceEventId,
          commentAction: "create",
          reasonCodes: [
            input.finalAgentMessage?.reasonCode ??
              "latest_non_empty_completed_final_agent_message",
          ],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    const adapterFinal = readMarkedAdapterFinalResponse(resultJson);
    if (allowCompatibility && adapterFinal) {
      return {
        text: adapterFinal,
        decision: decision("adapter_final_response", {
          commentAction: "create",
          reasonCodes: ["adapter_output_marked_final"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    if (
      allowCompatibility && compatibleTerminalAssistant &&
      finalAgentText &&
      !isStructuredSemanticResultText(finalAgentText)
    ) {
      return {
        text: finalAgentText,
        decision: decision("final_agent_message", {
          sourceEventId: input.finalAgentMessage?.sourceEventId,
          commentAction: "create",
          reasonCodes: [
            input.finalAgentMessage?.reasonCode ??
              "latest_non_empty_completed_terminal_assistant_message",
          ],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    const semanticSummary = readAcceptedSemanticSummary(resultJson);
    if (semanticSummary) {
      return {
        text: wholeAnswer(semanticSummary),
        decision: decision("semantic_result_summary", {
          commentAction: "create",
          reasonCodes: boundedFinalAgentText
            ? ["bounded_final_agent_message_replaced_by_semantic_summary"]
            : ["accepted_semantic_result_summary"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    if (boundedFinalAgentText && !isStructuredSemanticResultText(boundedFinalAgentText)) {
      // No complete source exists. The visible marker says the text was cut.
      return {
        text: boundedFinalAgentText,
        decision: decision("final_agent_message", {
          sourceEventId: input.finalAgentMessage?.sourceEventId,
          commentAction: "create",
          reasonCodes: ["bounded_final_agent_message_without_complete_source"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }

    const legacyText =
      readCommentText(resultJson.summary) ??
      readCommentText(resultJson.result) ??
      readCommentText(resultJson.message);
    if (allowCompatibility && legacyText && !NARRATION_OPENERS.test(legacyText.trimStart())) {
      return {
        text: legacyText,
        decision: decision("adapter_final_response", {
          commentAction: "create",
          reasonCodes: ["legacy_adapter_summary_compatibility"],
        }),
      } satisfies ResolvedHeartbeatRunResponse;
    }
    return null;
  };

  if (input.preferFinalResponseOverExistingComment === true) {
    if (hasYieldedSemanticResult(resultJson)) {
      const responseWakeSummary =
        input.externalChatResponseWakeSummaryAuthorized === true
          ? readAcceptedExternalChatResponseWakeSummary(
              resultJson,
              input.externalChatReviewResponseSummaryAuthorized === true,
              input.externalChatCommittedResponseWakeSummaryAuthorized === true,
            )
          : null;
      if (responseWakeSummary) {
        return {
          text: wholeAnswer(responseWakeSummary),
          decision: decision("semantic_result_summary", {
            commentAction: "create",
            reasonCodes: [
              "accepted_external_chat_response_wake_summary",
              "external_chat_final_precedence",
            ],
          }),
        };
      }
      return {
        text: null,
        decision: decision("none", {
          commentAction: "none",
          reasonCodes: ["yielded_control_plane_wait"],
        }),
      };
    }
    const upstream = resolveCompletedUpstreamResponse();
    if (upstream) {
      return {
        ...upstream,
        decision: {
          ...upstream.decision,
          reasonCodes: [
            ...upstream.decision.reasonCodes,
            "external_chat_final_precedence",
          ],
        },
      };
    }
    return {
      text: null,
      decision: decision("none", {
        commentAction: "none",
        reasonCodes: ["external_chat_final_response_unavailable"],
      }),
    };
  }

  const existingText = readCommentText(input.existingComment?.body);
  if (input.nativeConversationFinalResponse) {
    if (input.interactionOwnsResponse || (hasYieldedSemanticResult(resultJson) && !input.conversationTurnFinished)) return {
      text: null,
      decision: decision("none", { commentAction: "none", reasonCodes: ["interaction_owns_conversation_response"] }),
    };
    const final = resolveCompletedUpstreamResponse(false)
      ?? (input.conversationTurnFinished && compatibleTerminalAssistant && finalAgentText
        && !isStructuredSemanticResultText(finalAgentText) ? {
          text: finalAgentText,
          decision: decision("final_agent_message", { sourceEventId: input.finalAgentMessage?.sourceEventId,
            commentAction: "create", reasonCodes: ["server_finished_conversation_terminal_message"] }),
        } : null);
    if (final) {
      const reuse = !!input.existingComment && final.text === existingText;
      return { ...final, decision: { ...final.decision,
        commentAction: reuse ? "reuse" : "create",
        commentId: reuse ? input.existingComment!.id : null,
        reasonCodes: [...final.decision.reasonCodes, "native_conversation_final_precedence"],
      } };
    }
    if (!existingText) return {
      text: null,
      decision: decision("none", { commentAction: "none", reasonCodes: ["native_conversation_final_response_unavailable"] }),
    };
  }
  if (input.existingComment && existingText) {
    return {
      text: existingText,
      decision: decision("existing_issue_comment", {
        commentAction: "reuse",
        commentId: input.existingComment.id,
        reasonCodes: ["explicit_non_progress_comment_precedence"],
      }),
    };
  }

  // A governed wait is not a completed assistant turn. Provider adapters may
  // still emit terminal-looking prose while the control plane is yielding for
  // an interaction; keep that prose in activity and let the durable
  // interaction own the visible waiting state.
  if (hasYieldedSemanticResult(resultJson) && !input.conversationTurnFinished) {
    return {
      text: null,
      decision: decision("none", {
        commentAction: "none",
        reasonCodes: ["yielded_control_plane_wait"],
      }),
    };
  }

  const upstream = resolveCompletedUpstreamResponse();
  if (upstream) return upstream;

  const legacyText =
    readCommentText(resultJson.summary) ??
    readCommentText(resultJson.result) ??
    readCommentText(resultJson.message);

  return {
    text: null,
    decision: decision("none", {
      commentAction: "none",
      reasonCodes: legacyText
        ? ["legacy_adapter_summary_ambiguous"]
        : ["no_user_facing_response"],
    }),
  };
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  return resolveHeartbeatRunResponse({ resultJson }).text;
}

/**
 * The run's completion comment as ONE logical response (H5 round 2): when the
 * latest answer was posted in ordered parts, ALL its parts are assembled in
 * order into the whole answer (byte-equal to the source), identified by its
 * first part (the acknowledged reply) with every part id in order.
 */
export function findHeartbeatRunCompletionComment<T extends { id: string; presentation?: unknown; body?: string | null; metadata?: unknown }>(
  comments: T[],
  resultJson: Record<string, unknown> | null | undefined,
): (T & { answerPartCommentIds?: string[] }) | null {
  const found = findHeartbeatRunCompletionCommentRow(comments, resultJson);
  if (!found) return null;
  const whole = assembleAnswerParts(found, comments);
  if (whole) return { ...whole.first, body: whole.text, answerPartCommentIds: whole.partIds };
  // A missing or damaged part makes the logical answer unavailable, not a
  // single physical part the answer. Use the same C1 line as other finals
  // that cannot be delivered whole, including when part metadata is invalid.
  return "answerPart" in record(found.metadata)
    ? { ...found, body: TRUNCATED_FINAL_UNDELIVERABLE_TEXT }
    : found;
}

function findHeartbeatRunCompletionCommentRow<T extends { id: string; presentation?: unknown }>(
  comments: T[],
  resultJson: Record<string, unknown> | null | undefined,
): T | null {
  const completionComments = comments.filter(comment => record(comment.presentation).kind !== "system_notice");
  const receipts = resultJson?.semanticToolReceipts;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) {
    return completionComments[0] ?? null;
  }

  const generatedCommentIds = new Set<string>();
  for (const receipt of Object.values(receipts)) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      continue;
    const receiptRecord = receipt as Record<string, unknown>;
    const result = receiptRecord.result;
    if (!result || typeof result !== "object" || Array.isArray(result))
      continue;
    const receiptResult = result as Record<string, unknown>;
    if (receiptRecord.operationId === "report_progress") {
      const commentId = receiptResult.commentId;
      if (typeof commentId === "string" && commentId.length > 0) {
        generatedCommentIds.add(commentId);
      }
    } else if (
      receiptRecord.operationId === "register_deliverable" &&
      typeof receiptResult.attachmentId === "string" &&
      receiptResult.commandId === `deliverable-prepared:${receiptResult.attachmentId}` &&
      ["applied", "duplicate"].includes(String(receiptResult.disposition)) &&
      Array.isArray(receiptResult.entityRefs)
    ) {
      // File preparation binds an attachment to a generated comment. That
      // receipt is not the agent's final answer. Use the server-issued entity
      // references, never the comment's wording, to exclude its comment from
      // final-response deduplication. The attachment and binding stay intact.
      for (const ref of receiptResult.entityRefs) {
        if (typeof ref === "string") generatedCommentIds.add(ref);
      }
    }
  }

  return (
    completionComments.find((comment) => !generatedCommentIds.has(comment.id)) ?? null
  );
}
