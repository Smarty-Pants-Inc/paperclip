import { TASK_RECOVERY_STATEMENT } from "../../lib/task-recovery-notice";
import type { TaskChatItem, TaskChatMarkerItem, TaskChatMessageItem } from "./task-chat-model";

const LEGACY_RECOVERY_STATEMENT = /^Paperclip (?:automatically )?retried (?:dispatch|continuation|this issue's run)\b[^\r\n]*\bit still has no live execution path\b/i;
const RECOVERY_TITLES = new Set(["task could not continue", "no live execution path"]);

const OWED_MESSAGE_PREFIX = "unanswered_message:";

/** The person message an "unanswered message" card is owed for (one card per message). */
export function owedMessageId(
  item: Pick<TaskChatMessageItem, "author" | "metadata">,
): string | null {
  if (item.author !== "system") return null;
  const reason = item.metadata?.authorizationReason;
  if (typeof reason !== "string" || !reason.startsWith(OWED_MESSAGE_PREFIX)) return null;
  return reason.slice(OWED_MESSAGE_PREFIX.length).trim() || null;
}

/** Pending-state key of one Retry: the failed run, narrowed to one owed message when the card names it. */
export function retryFailedRunKey(runId: string, messageId?: string | null): string {
  return messageId ? `${runId}:${messageId}` : runId;
}

export function isNoLiveExecutionPathNotice(item: TaskChatMessageItem): boolean {
  if (item.author !== "system") return false;
  // An owed-message card is a recovery surface: its Retry re-sends its message.
  if (owedMessageId(item)) return true;
  const text = item.text.trim();
  const recoveryStatement = TASK_RECOVERY_STATEMENT.test(text) || LEGACY_RECOVERY_STATEMENT.test(text);
  if (item.presentation) {
    if (RECOVERY_TITLES.has(item.presentation.title?.trim().toLowerCase() ?? "")) return true;
    // The stranded-recovery producer can replace the family title with
    // "Automatic recovery blocked" or a classified source-run failure.
    // Require both its recovery statement and saved action metadata so an
    // unrelated notice quoting that statement remains a group boundary.
    return recoveryStatement && !!item.metadata?.sections.some((section) =>
      section.title === "Recovery" && section.rows.some((row) =>
        row.type === "key_value" && row.label === "Recovery action" && row.value.trim().length > 0,
      ),
    );
  }
  // Older recovery comments lack presentation metadata. Recognize their own
  // recovery statement rather than any mention of the error phrase.
  return recoveryStatement;
}

function errorKind(item: TaskChatItem): "run" | "recovery" | null {
  if (item.kind === "marker" && item.variant === "interrupted"
    && item.tone !== "neutral" && !item.credentialAccess) return "run";
  if (item.kind === "message" && isNoLiveExecutionPathNotice(item)) return "recovery";
  return null;
}

/** Keep the last row when adjacent run and recovery errors describe a stop.
 * The caller supplies conversation order; saved comments and run history stay intact.
 * Messages, inputs, session boundaries and actionable credential denials break a group.
 */
export function compactAdjacentErrors(items: readonly TaskChatItem[]): {
  items: TaskChatItem[];
  retryMarkers: Map<string, TaskChatMarkerItem>;
} {
  const result: TaskChatItem[] = [];
  const retryMarkers = new Map<string, TaskChatMarkerItem>();
  for (let start = 0; start < items.length;) {
    const kind = errorKind(items[start]);
    if (!kind) {
      result.push(items[start++]);
      continue;
    }
    let end = start + 1;
    let mixed = false;
    while (end < items.length) {
      const next = errorKind(items[end]);
      if (!next) break;
      if (next !== kind) mixed = true;
      end++;
    }
    const latest = items[end - 1];
    if (mixed && errorKind(latest) === "recovery") {
      const marker = items.slice(start, end).reverse().find(
        (item): item is TaskChatMarkerItem => item.kind === "marker" && isRetryableFailureMarker(item),
      );
      // Preserve the retry target separately from the surviving error's text.
      // The renderer still applies the parent's permission and pending state.
      // One card per owed message: every owed card of the group survives (in
      // order) with its own Retry target; only the run marker collapses.
      const owed = items.slice(start, end).filter(
        (item) => item.kind === "message" && owedMessageId(item) !== null,
      );
      const survivors = owed.length > 0
        ? (owed.includes(latest) ? owed : [...owed, latest])
        : [latest];
      if (marker) for (const survivor of survivors) retryMarkers.set(survivor.id, marker);
      result.push(...survivors);
      start = end;
      continue;
    }
    result.push(...(mixed ? [latest] : items.slice(start, end)));
    start = end;
  }
  return { items: result, retryMarkers };
}

const RETRYABLE_FAILURE_LABELS = new Set(["Run failed", "Usage limit reached", "Model unavailable"]);

export function isRetryableFailureMarker(marker: Pick<TaskChatMarkerItem, "variant" | "label">) {
  return marker.variant === "interrupted" && RETRYABLE_FAILURE_LABELS.has(marker.label);
}
