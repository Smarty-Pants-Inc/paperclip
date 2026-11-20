import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeRunHistoricalSpan } from "./native-runtime/native-run-trace.js";

// Historical run-log spans, like the S1 preparation timings. No I/O is added to
// admission, and neither errors nor the value of the measured operation change.
// This is best-effort process-local attribution, not durable delivery authority:
// another API process or a restart may have no detail for an otherwise valid run.
type IngressSpan = Omit<NativeRunHistoricalSpan, "endedAtMs"> & { endedAtMs?: number };
type Recording = { spans: IngressSpan[]; commentId?: string; commentAtMs?: number; insertedAtMs?: number };
type Scope = { recording: Recording; parentName: string };
const scope = new AsyncLocalStorage<Scope>();
const comments = new Map<string, Recording>();
const MAX_COMMENTS = 256;
const MAX_SPANS = 512;

export function withCommentIngressTiming<T>(work: () => Promise<T>): Promise<T> {
  return scope.run({ recording: { spans: [] }, parentName: "comment.to_run_inserted" }, work);
}

/** Bind only the server-created comment, never a client-supplied trace marker. */
export function bindCommentIngressTiming(comment: { id: string; createdAt: Date | string }): void {
  const current = scope.getStore();
  if (!current || comments.has(comment.id)) return;
  if (comments.size >= MAX_COMMENTS) comments.delete(comments.keys().next().value!);
  current.recording.commentId = comment.id;
  current.recording.commentAtMs = new Date(comment.createdAt).getTime();
  comments.set(comment.id, current.recording);
}

export async function measureCommentIngress<T>(name: string, work: () => T | PromiseLike<T>): Promise<T> {
  const current = scope.getStore();
  if (!current || current.recording.insertedAtMs !== undefined || current.recording.spans.length >= MAX_SPANS) return work();
  const span: IngressSpan = { name, parentName: current.parentName, startedAtMs: Date.now() };
  current.recording.spans.push(span);
  let outcome: "ok" | "failed" = "failed";
  try {
    const value = await scope.run({ recording: current.recording, parentName: name }, work);
    outcome = "ok";
    return value;
  } finally {
    span.endedAtMs = Date.now();
    span.outcome = outcome;
  }
}

/** PostgreSQL defaultNow() is the transaction start, not the INSERT completion. */
export function markCommentIngressRunInserted(commentId: string | null): void {
  const current = scope.getStore();
  // An outbox pass can first deliver older input. That INSERT does not end
  // the current POST's latency, and must not steal its instrumentation.
  if (current && commentId === current.recording.commentId) current.recording.insertedAtMs ??= Date.now();
}

/** Consume only this run's accepted input IDs. Never charge ingress to prepare. */
export function drainCommentIngressTimings(commentIds: readonly string[]): NativeRunHistoricalSpan[] {
  return commentIds.flatMap(id => {
    const recording = comments.get(id);
    comments.delete(id);
    if (!recording || recording.insertedAtMs === undefined) return [];
    const floor = recording.commentAtMs ?? 0;
    const ceiling = recording.insertedAtMs;
    const spans: NativeRunHistoricalSpan[] = recording.spans.filter(span => (span.endedAtMs ?? ceiling) >= floor && span.startedAtMs <= ceiling).map(span => ({
      ...span, startedAtMs: Math.max(floor, span.startedAtMs),
      endedAtMs: Math.max(floor, Math.min(ceiling, span.endedAtMs ?? ceiling)),
      outcome: span.outcome ?? "ok",
    }));
    spans.unshift({ name: "comment.to_run_inserted", parentName: "task.provider_session",
      startedAtMs: floor, endedAtMs: Math.max(floor, ceiling) });
    return spans;
  }).sort((a, b) => a.startedAtMs - b.startedAtMs || b.endedAtMs - a.endedAtMs);
}
