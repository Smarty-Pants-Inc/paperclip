import type { RunLogChunk } from "../adapters";

/**
 * Memory paging for live run transcripts (NOTE 5 follow-up).
 *
 * "Never cut" means the person can always reach every line, not that the tab
 * holds a three-hour run in memory. A run's retained chunk WINDOW is bounded;
 * when older records leave the window we record the exact byte range they
 * occupy in the saved run log, and "Show earlier output" (or scrolling to the
 * top) re-reads exactly that range and puts it back in place. When the person
 * pages far back, the newest records leave the window instead and come back
 * from the saved log on "Show later output" / scrolling to the bottom.
 *
 * A chunk can only be a window boundary when its byte offset in the saved log
 * is known (it arrived through, or was confirmed by, a persisted log read).
 * Synthetic chunks that are not in the saved log (run event and status lines)
 * travel with the range they were evicted in, so nothing becomes unreachable.
 */

/**
 * Retained transcript payload per run, in UTF-16 code units (~8 MB of string
 * data). Large enough that one record of a little over 2 M units (NOTE 5)
 * stays in memory beside its neighbours; anything older pages out.
 */
export const TRANSCRIPT_WINDOW_UTF16_UNITS = 4_000_000;
/** Largest saved-log range re-read in one request. */
export const RANGE_PAGE_BYTES = 256_000;

/**
 * Page size for a window bound. A saved-log record's payload never has more
 * UTF-16 units than its UTF-8 bytes, so a page of at most half the bound always
 * fits next to the records the person was reading when it is restored.
 */
export function rangePageBytes(maxUnits: number): number {
  if (!Number.isFinite(maxUnits)) return RANGE_PAGE_BYTES;
  return Math.max(1, Math.min(RANGE_PAGE_BYTES, Math.floor(maxUnits / 2)));
}

export type PagedChunk = RunLogChunk & { offset?: number };

export interface EvictedRange {
  /** First byte (record aligned) of the evicted range in the saved run log. */
  start: number;
  /** First byte after the range: the offset of the record that stayed in memory. */
  end: number;
  /** Chunks that are not in the saved log and were evicted with this range. */
  extras: readonly RunLogChunk[];
}

export interface RunPaging {
  /** Byte offset in the saved log where the retained window starts. */
  windowStart: number;
  /** Earlier ranges that left memory; the last one is adjacent to the window. */
  earlier: readonly EvictedRange[];
  /** When the newest records left memory, the byte offset they start at. */
  laterFrom: number | null;
  /** Synthetic chunks evicted from (or received during) the later range. */
  laterExtras: readonly RunLogChunk[];
}

export const EMPTY_RUN_PAGING: RunPaging = Object.freeze({ windowStart: 0, earlier: [], laterFrom: null, laterExtras: [] });

const pagingByWindow = new WeakMap<readonly RunLogChunk[], RunPaging>();

export function getRunPaging(chunks: readonly RunLogChunk[]): RunPaging {
  return pagingByWindow.get(chunks) ?? EMPTY_RUN_PAGING;
}

export function withRunPaging<T extends readonly RunLogChunk[]>(chunks: T, paging: RunPaging): T {
  if (paging !== EMPTY_RUN_PAGING) pagingByWindow.set(chunks, paging);
  return chunks;
}

const offsetByChunk = new WeakMap<RunLogChunk, number>();

export function chunkOffset(chunk: RunLogChunk): number | undefined {
  const value = (chunk as PagedChunk).offset ?? offsetByChunk.get(chunk);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Remember a retained chunk's saved-log offset without changing its shape. */
export function withChunkOffset<T extends RunLogChunk>(chunk: T, offset: number | undefined): T {
  if (offset !== undefined) offsetByChunk.set(chunk, offset);
  return chunk;
}

function isSynthetic(chunk: RunLogChunk): boolean {
  return typeof chunk.seq !== "number" && chunkOffset(chunk) === undefined;
}

export function retainedUnits(chunks: readonly RunLogChunk[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.chunk.length;
  return total;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Parse saved-log records whose first byte is at `baseOffset`. Only complete
 * lines are consumed; `consumedBytes` stops before a trailing partial record.
 */
export function parseLogRecords(content: string, baseOffset: number): { rows: PagedChunk[]; consumedBytes: number; consumedChars: number } {
  const rows: PagedChunk[] = [];
  let position = 0;
  let cursor = baseOffset;
  for (;;) {
    const newline = content.indexOf("\n", position);
    if (newline === -1) break;
    const line = content.slice(position, newline);
    const recordOffset = cursor;
    cursor += utf8ByteLength(line) + 1;
    position = newline + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown; seq?: unknown };
      const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
      if (!chunk) continue;
      const stream = raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
      const ts = typeof raw.ts === "string" ? raw.ts : new Date(0).toISOString();
      const row: PagedChunk = { ts, stream, chunk, offset: recordOffset };
      if (typeof raw.seq === "number" && Number.isFinite(raw.seq)) row.seq = raw.seq;
      rows.push(row);
    } catch {
      // Ignore malformed log rows, as the live reader does.
    }
  }
  return { rows, consumedBytes: cursor - baseOffset, consumedChars: position };
}

function highestSeq(chunks: readonly RunLogChunk[]): number | null {
  let highest: number | null = null;
  for (const chunk of chunks) if (typeof chunk.seq === "number" && (highest === null || chunk.seq > highest)) highest = chunk.seq;
  return highest;
}

/**
 * Move the oldest records out of memory until the window fits `maxUnits`.
 * The new first chunk must have a known saved-log offset; when none does yet,
 * nothing is evicted and `needsOffsets` asks the caller to read the saved log.
 */
export function evictHead(
  chunks: readonly PagedChunk[],
  maxUnits: number,
  paging: RunPaging = getRunPaging(chunks),
  pageBytes = rangePageBytes(maxUnits),
  maxChunks = Number.POSITIVE_INFINITY,
): { chunks: PagedChunk[]; needsOffsets: boolean; evictedSeq: number | null } {
  const total = retainedUnits(chunks);
  if ((total <= maxUnits && chunks.length <= maxChunks) || chunks.length < 2) {
    return { chunks: withRunPaging([...chunks], paging), needsOffsets: false, evictedSeq: null };
  }
  let remaining = total;
  let minRemove = 0;
  while (minRemove < chunks.length - 1 && (remaining > maxUnits || chunks.length - minRemove > maxChunks)) {
    remaining -= chunks[minRemove]!.chunk.length;
    minRemove += 1;
  }
  let boundary = -1;
  for (let index = minRemove; index < chunks.length; index += 1) {
    if (chunkOffset(chunks[index]!) !== undefined) { boundary = index; break; }
  }
  if (boundary === -1) {
    for (let index = minRemove - 1; index > 0; index -= 1) {
      if (chunkOffset(chunks[index]!) !== undefined) { boundary = index; break; }
    }
  }
  if (boundary <= 0) return { chunks: withRunPaging([...chunks], paging), needsOffsets: true, evictedSeq: null };
  const end = chunkOffset(chunks[boundary]!)!;
  const evicted = chunks.slice(0, boundary);
  const kept = chunks.slice(boundary);
  const stillOver = (retainedUnits(kept) > maxUnits || kept.length > maxChunks) && boundary < minRemove;
  return {
    chunks: withRunPaging(kept, { ...paging, windowStart: end, earlier: pushEvictedRanges(paging.earlier, paging.windowStart, evicted, end, pageBytes) }),
    needsOffsets: stillOver,
    evictedSeq: highestSeq(evicted),
  };
}

/**
 * Record the evicted records as record-aligned ranges of at most `pageBytes`
 * (unless one record is larger), so each range re-reads in one request and a
 * page never splits a record or its UTF-8 text. Adjacent small ranges merge,
 * so a run that streams one record at a time still keeps one entry per page.
 */
function pushEvictedRanges(
  earlier: readonly EvictedRange[],
  start: number,
  evicted: readonly PagedChunk[],
  end: number,
  pageBytes: number,
): EvictedRange[] {
  const ranges = [...earlier];
  const push = (range: EvictedRange) => {
    const top = ranges.at(-1);
    if (top && top.end === range.start && range.end - top.start <= pageBytes) {
      ranges[ranges.length - 1] = { start: top.start, end: range.end, extras: [...top.extras, ...range.extras] };
    } else if (range.end > range.start || range.extras.length > 0) ranges.push(range);
  };
  let rangeStart = start;
  let lastBoundary = start;
  let extrasBefore: RunLogChunk[] = [];
  let extrasSince: RunLogChunk[] = [];
  const cutBefore = (offset: number) => {
    if (offset - rangeStart > pageBytes && lastBoundary > rangeStart) {
      push({ start: rangeStart, end: lastBoundary, extras: extrasBefore });
      rangeStart = lastBoundary;
      extrasBefore = extrasSince;
    } else extrasBefore = [...extrasBefore, ...extrasSince];
    extrasSince = [];
  };
  for (const chunk of evicted) {
    const offset = chunkOffset(chunk);
    if (offset === undefined) { if (isSynthetic(chunk)) extrasSince.push(chunk); continue; }
    cutBefore(offset);
    lastBoundary = offset;
  }
  cutBefore(end);
  push({ start: rangeStart, end, extras: extrasBefore });
  return ranges;
}

/** Move the newest records out of memory (they stay in the saved log). */
export function evictTail(
  chunks: readonly PagedChunk[],
  maxUnits: number,
  paging: RunPaging = getRunPaging(chunks),
  maxChunks = Number.POSITIVE_INFINITY,
): PagedChunk[] {
  if ((retainedUnits(chunks) <= maxUnits && chunks.length <= maxChunks) || chunks.length < 2) return withRunPaging([...chunks], paging);
  let kept = 0;
  let size = 0;
  while (kept < chunks.length && kept < maxChunks && size + chunks[kept]!.chunk.length <= maxUnits) {
    size += chunks[kept]!.chunk.length;
    kept += 1;
  }
  let boundary = -1;
  for (let index = Math.max(1, kept); index > 0; index -= 1) {
    if (index < chunks.length && chunkOffset(chunks[index]!) !== undefined) { boundary = index; break; }
  }
  if (boundary <= 0) return withRunPaging([...chunks], paging);
  const evicted = chunks.slice(boundary);
  return withRunPaging(chunks.slice(0, boundary), {
    ...paging,
    laterFrom: chunkOffset(chunks[boundary]!)!,
    laterExtras: [...evicted.filter(isSynthetic), ...(paging.laterFrom === null ? [] : paging.laterExtras)],
  });
}

/** Put the most recently evicted earlier range back in front of the window. */
export function restoreEarlier(
  chunks: readonly PagedChunk[],
  rows: readonly PagedChunk[],
  maxUnits: number,
  maxChunks = Number.POSITIVE_INFINITY,
): PagedChunk[] {
  const paging = getRunPaging(chunks);
  const range = paging.earlier.at(-1);
  if (!range) return [...chunks];
  const merged = mergeExtras(rows, range.extras);
  const restored = [...merged, ...chunks];
  return evictTail(restored, maxUnits, { ...paging, windowStart: range.start, earlier: paging.earlier.slice(0, -1) }, maxChunks);
}

/**
 * Append a page read from `laterFrom`. `nextFrom` is where the next unread
 * record starts, or null when the page reached the end of the saved log.
 */
export function restoreLater(
  chunks: readonly PagedChunk[],
  rows: readonly PagedChunk[],
  nextFrom: number | null,
  maxUnits: number,
  maxChunks = Number.POSITIVE_INFINITY,
): { chunks: PagedChunk[]; evictedSeq: number | null } {
  const paging = getRunPaging(chunks);
  if (paging.laterFrom === null) return { chunks: [...chunks], evictedSeq: null };
  const appended = nextFrom === null ? [...chunks, ...mergeExtras(rows, paging.laterExtras)] : [...chunks, ...rows];
  const nextPaging: RunPaging = nextFrom === null
    ? { ...paging, laterFrom: null, laterExtras: [] }
    : { ...paging, laterFrom: nextFrom };
  const { chunks: windowed, evictedSeq } = evictHead(appended, maxUnits, nextPaging, rangePageBytes(maxUnits), maxChunks);
  return { chunks: windowed, evictedSeq };
}

function mergeExtras(rows: readonly PagedChunk[], extras: readonly RunLogChunk[]): PagedChunk[] {
  if (extras.length === 0) return [...rows];
  const merged: PagedChunk[] = [...rows];
  for (const extra of extras) {
    let at = merged.length;
    while (at > 0 && merged[at - 1]!.ts > extra.ts) at -= 1;
    merged.splice(at, 0, extra);
  }
  return merged;
}

export type ReadLogPage = (offset: number, limitBytes: number) => Promise<{ content: string; nextOffset?: number }>;

/** Read exactly `[start, end)` of the saved log, page by page, in order. */
export async function readLogRange(read: ReadLogPage, start: number, end: number, pageBytes: number): Promise<PagedChunk[]> {
  const rows: PagedChunk[] = [];
  let offset = start;
  let carry = "";
  let carryOffset = start;
  while (offset < end) {
    const result = await read(offset, Math.min(pageBytes, end - offset));
    const next = result.nextOffset ?? offset + utf8ByteLength(result.content);
    if (next <= offset || result.content.length === 0) throw new Error("Saved run log ended before the requested range");
    const combined = `${carry}${result.content}`;
    const { rows: pageRows, consumedBytes, consumedChars } = parseLogRecords(combined, carryOffset);
    rows.push(...pageRows);
    carry = combined.slice(consumedChars);
    carryOffset += consumedBytes;
    offset = next;
  }
  if (carry.trim()) rows.push(...parseLogRecords(`${carry}\n`, carryOffset).rows);
  return rows;
}
