import type { RunLogChunk } from "../adapters";
import { chunkOffset, evictHead, rangePageBytes, getRunPaging, utf8ByteLength, withChunkOffset, withRunPaging, type PagedChunk } from "./run-log-paging";

/**
 * Chunk-merge / seq-dedupe primitives shared by the live run transcript view
 * (`useLiveRunTranscripts`) and the summary draft stream (`useSummaryDraftStream`).
 *
 * Both consumers ingest the same run-log records from two transports — the
 * persisted offset-read poller and the company events WebSocket — which
 * interleave and re-deliver records. This module centralizes the ordering and
 * de-duplication rules so the two hooks cannot drift apart.
 */

export type IncomingRunLogChunk = PagedChunk & { dedupeKey: string };

/**
 * Per-consumer merge state. `seenChunkKeys` is shared across every run tracked
 * by a single consumer (bounded + cleared past a cap); `trimmedSeqFloorByRun`
 * records, per run, the highest sequenced chunk that has been trimmed out of the
 * retained window so re-delivered older records are dropped rather than
 * re-inserted ahead of newer output.
 */
export interface ChunkMergeRefs {
  seenChunkKeys: Set<string>;
  trimmedSeqFloorByRun: Map<string, number>;
}

const SEEN_CHUNK_KEY_CAP = 12000;

/**
 * Retention budget for a run's kept chunk window. Full task views pass a byte
 * budget with `page: true`: older records leave memory only as recorded
 * saved-log ranges that "Show earlier output" reads back (see
 * `run-log-paging.ts`), so every line stays reachable. Compact consumers
 * (dashboard tickers, summary draft) keep the chunk-count cap by passing a bare
 * number; they are previews, never the place a person reads a full run.
 */
export interface ChunkRetentionBudget {
  /** Hard ceiling on retained chunk count (compact previews only). */
  maxChunks?: number;
  /** Ceiling on retained chunk payload size (UTF-16 code units). */
  maxBytes?: number;
  /** Page older records out to the saved log instead of discarding them. */
  page?: boolean;
}

function chunkRetainedSize(chunk: RunLogChunk): number {
  return chunk.chunk.length;
}

function normalizeRetentionBudget(budget: number | ChunkRetentionBudget): ChunkRetentionBudget {
  return typeof budget === "number" ? { maxChunks: budget } : budget;
}

/**
 * Trim a compact preview window to its budget, keeping the newest chunks.
 * Returns the highest sequenced chunk removed so callers can raise the
 * seq floor and drop re-delivered older records.
 */
export function applyRetentionBudget(
  chunks: RunLogChunk[],
  budget: ChunkRetentionBudget,
): { chunks: RunLogChunk[]; trimmedSeq: number | null } {
  const { maxChunks, maxBytes } = budget;
  let removeCount = 0;
  if (typeof maxChunks === "number" && chunks.length > maxChunks) {
    removeCount = chunks.length - maxChunks;
  }
  if (typeof maxBytes === "number") {
    let totalBytes = 0;
    for (const chunk of chunks) totalBytes += chunkRetainedSize(chunk);
    let byteRemove = 0;
    // Always keep the newest chunk even if it alone exceeds the byte budget.
    while (byteRemove < chunks.length - 1 && totalBytes > maxBytes) {
      totalBytes -= chunkRetainedSize(chunks[byteRemove]!);
      byteRemove += 1;
    }
    if (byteRemove > removeCount) removeCount = byteRemove;
  }
  if (removeCount <= 0) return { chunks, trimmedSeq: null };
  let trimmedSeq: number | null = null;
  for (const item of chunks.slice(0, removeCount)) {
    if (typeof item.seq === "number" && (trimmedSeq === null || item.seq > trimmedSeq)) trimmedSeq = item.seq;
  }
  return { chunks: chunks.slice(removeCount), trimmedSeq };
}

export function readChunkSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isStructuredStreamingTextDelta(chunk: string): boolean {
  return /"type"\s*:\s*"(?:acpx\.text_delta|text)"/.test(chunk);
}

/**
 * Parse a raw persisted-log slice into ordered chunks. `pendingByRun` carries a
 * partial trailing line across offset reads so a record split across a read
 * boundary is not dropped.
 */
export function parsePersistedLogContent(
  runId: string,
  content: string,
  pendingByRun: Map<string, string>,
  /**
   * Saved-log byte range `[start, end)` this content was read from. When given,
   * records carry their saved-log offset so they can page out of memory.
   */
  contentRange?: { start: number; end: number },
): IncomingRunLogChunk[] {
  if (!content) return [];

  const pendingKey = `${runId}:records`;
  const pending = pendingByRun.get(pendingKey) ?? "";
  const combined = `${pending}${content}`;
  const split = combined.split("\n");
  const trailing = split.pop() ?? "";
  pendingByRun.set(pendingKey, trailing);

  // A read can start or stop inside a multi-byte character, which the server
  // decodes as U+FFFD; anchor offsets on whichever page edge decoded cleanly.
  const offsets = contentRange ? recordOffsets(split, pending, content, trailing, contentRange) : null;

  const parsed: IncomingRunLogChunk[] = [];
  split.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown; seq?: unknown };
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
      if (!chunk) return;
      const offset = offsets?.[index];
      parsed.push({
        ts,
        stream,
        chunk,
        seq: readChunkSeq(raw.seq),
        dedupeKey: `log:${runId}:${ts}:${stream}:${chunk}`,
        ...(offset !== undefined ? { offset } : {}),
      });
    } catch {
      // Ignore malformed log rows.
    }
  });

  return parsed;
}

export function recordOffsets(
  lines: readonly string[],
  pending: string,
  content: string,
  trailing: string,
  range: { start: number; end: number },
): Array<number | undefined> {
  const offsets: Array<number | undefined> = new Array(lines.length).fill(undefined);
  if (lines.length === 0) return offsets;
  const firstNewline = content.indexOf("\n");
  const trustStart = !content.slice(0, firstNewline + 1).includes("\uFFFD") && (pending === "" || !pending.includes("\uFFFD"));
  const trustEnd = !trailing.includes("\uFFFD");
  if (trustStart) {
    // Line 0 starts inside the previous page unless nothing was pending.
    let cursor = range.start + utf8ByteLength(lines[0]!) + 1 - utf8ByteLength(pending);
    if (pending === "") offsets[0] = range.start;
    for (let index = 1; index < lines.length; index += 1) {
      offsets[index] = cursor;
      cursor += utf8ByteLength(lines[index]!) + 1;
    }
  } else if (trustEnd) {
    let cursor = range.end - utf8ByteLength(trailing);
    for (let index = lines.length - 1; index >= 1; index -= 1) {
      cursor -= utf8ByteLength(lines[index]!) + 1;
      offsets[index] = cursor;
    }
  }
  return offsets;
}

/**
 * Merge incoming chunks into a run's retained window, preserving emit order and
 * de-duplicating across the two delivery transports. Returns the same array
 * reference when nothing changed so callers can bail out of React state updates.
 *
 * Ordering rules (unchanged from the original `useLiveRunTranscripts`
 * implementation):
 * - Sequenced chunks dedupe/order by the server-assigned monotonic `seq`. When
 *   the same `seq` arrives from both transports the longer payload wins (the
 *   websocket copy may be tail-truncated). Records at or below the trimmed
 *   floor are dropped.
 * - Unsequenced chunks dedupe by content key (skipping structured streaming
 *   text deltas, which legitimately repeat) and act as an ordering barrier for
 *   subsequent sequenced inserts.
 */
export function mergeRunLogChunks(
  runId: string,
  prevChunks: RunLogChunk[],
  incoming: IncomingRunLogChunk[],
  refs: ChunkMergeRefs,
  budget: number | ChunkRetentionBudget,
): { chunks: RunLogChunk[]; changed: boolean; needsOffsets?: boolean } {
  if (incoming.length === 0) return { chunks: prevChunks, changed: false };

  const normalizedBudget = normalizeRetentionBudget(budget);
  const paging = getRunPaging(prevChunks);
  if (normalizedBudget.page && paging.laterFrom !== null) {
    // The newest records are paged out to the saved log while the person reads
    // earlier output; "Show later output" reads them back from there. Only
    // lines that are not in the saved log are kept for that return trip.
    const synthetic = incoming.filter((chunk) => typeof chunk.seq !== "number" && chunkOffset(chunk) === undefined
      && (isStructuredStreamingTextDelta(chunk.chunk) || !refs.seenChunkKeys.has(chunk.dedupeKey)));
    if (synthetic.length === 0) return { chunks: prevChunks, changed: false };
    for (const chunk of synthetic) refs.seenChunkKeys.add(chunk.dedupeKey);
    const next = withRunPaging([...prevChunks], {
      ...paging,
      laterExtras: [...paging.laterExtras, ...synthetic.map(({ ts, stream, chunk }) => ({ ts, stream, chunk }))],
    });
    return { chunks: next, changed: true };
  }

  const existing: PagedChunk[] = [...prevChunks];
  let changed = false;

  for (const chunk of incoming) {
    const offset = chunkOffset(chunk);
    if (normalizedBudget.page && offset !== undefined && offset < paging.windowStart) continue;
    if (typeof chunk.seq === "number") {
      const seqFloor = refs.trimmedSeqFloorByRun.get(runId) ?? 0;
      if (chunk.seq <= seqFloor) continue;
      const duplicateAt = existing.findLastIndex((item) => item.seq === chunk.seq);
      if (duplicateAt !== -1) {
        // Same record arrived via the other delivery path. Prefer the longer
        // payload: websocket chunks may be tail-truncated while the persisted
        // row is complete. The persisted copy also brings its saved-log offset.
        const prior = existing[duplicateAt]!;
        const longer = chunk.chunk.length > prior.chunk.length;
        const addsOffset = offset !== undefined && chunkOffset(prior) === undefined;
        if (longer || addsOffset) {
          existing[duplicateAt] = withChunkOffset({
            ts: longer ? chunk.ts : prior.ts,
            stream: longer ? chunk.stream : prior.stream,
            chunk: longer ? chunk.chunk : prior.chunk,
            seq: chunk.seq,
          }, offset ?? chunkOffset(prior));
          changed = true;
        }
        continue;
      }
      // Insert in seq order relative to the trailing sequenced chunks so
      // late-arriving records from the slower delivery path land where they
      // were emitted. Unsequenced chunks act as an ordering barrier.
      let insertAt = existing.length;
      while (insertAt > 0) {
        const prior = existing[insertAt - 1]!;
        if (typeof prior.seq !== "number" || prior.seq < chunk.seq) break;
        insertAt -= 1;
      }
      existing.splice(insertAt, 0, withChunkOffset({ ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk, seq: chunk.seq }, offset));
      changed = true;
      continue;
    }

    if (!isStructuredStreamingTextDelta(chunk.chunk)) {
      if (refs.seenChunkKeys.has(chunk.dedupeKey)) continue;
      refs.seenChunkKeys.add(chunk.dedupeKey);
    }
    existing.push(withChunkOffset({ ts: chunk.ts, stream: chunk.stream, chunk: chunk.chunk }, offset));
    changed = true;
  }

  if (!changed) return { chunks: prevChunks, changed: false };
  if (refs.seenChunkKeys.size > SEEN_CHUNK_KEY_CAP) {
    refs.seenChunkKeys.clear();
  }

  const raiseFloor = (seq: number | null) => {
    if (seq === null) return;
    const seqFloor = refs.trimmedSeqFloorByRun.get(runId) ?? 0;
    if (seq > seqFloor) refs.trimmedSeqFloorByRun.set(runId, seq);
  };
  if (normalizedBudget.page) {
    const maxUnits = normalizedBudget.maxBytes ?? Number.POSITIVE_INFINITY;
    const { chunks: windowed, needsOffsets, evictedSeq } = evictHead(
      existing, maxUnits, paging, rangePageBytes(maxUnits), normalizedBudget.maxChunks ?? Number.POSITIVE_INFINITY,
    );
    raiseFloor(evictedSeq);
    return { chunks: windowed, changed: true, needsOffsets };
  }
  const { chunks: retained, trimmedSeq } = applyRetentionBudget(existing, normalizedBudget);
  raiseFloor(trimmedSeq);
  return { chunks: retained, changed: true };
}
