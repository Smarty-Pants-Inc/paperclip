import { describe, expect, it } from "vitest";
import {
  evictHead,
  getRunPaging,
  parseLogRecords,
  readLogRange,
  restoreEarlier,
  restoreLater,
  retainedUnits,
  utf8ByteLength,
  type PagedChunk,
} from "./run-log-paging";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function savedLog(count: number, text: (seq: number) => string) {
  const lines = Array.from({ length: count }, (_, index) =>
    `${JSON.stringify({ ts: `2026-11-17T00:00:${String(index).padStart(6, "0")}Z`, stream: "stdout", chunk: text(index + 1), seq: index + 1 })}\n`);
  const bytes = encoder.encode(lines.join(""));
  const read = async (offset: number, limitBytes: number) => {
    const end = Math.min(bytes.length, offset + limitBytes);
    return { content: decoder.decode(bytes.slice(offset, end)), nextOffset: end };
  };
  return { lines, bytes, read };
}

describe("run log paging: memory is bounded by paging, never by cutting", () => {
  it("parses record offsets that match the saved log byte-for-byte, including multi-byte text", () => {
    const log = savedLog(5, seq => `řádek ${seq} 🚀 ${"x".repeat(seq)}`);
    const { rows, consumedBytes } = parseLogRecords(decoder.decode(log.bytes), 0);
    expect(consumedBytes).toBe(log.bytes.length);
    let offset = 0;
    rows.forEach((row, index) => {
      expect(row.offset).toBe(offset);
      offset += utf8ByteLength(log.lines[index]!);
    });
  });

  it("(a) keeps at most the window in memory and records the evicted byte range", () => {
    const log = savedLog(100, seq => `${seq}`.padEnd(100, "."));
    const { rows } = parseLogRecords(decoder.decode(log.bytes), 0);
    const { chunks } = evictHead(rows, 1_000);
    expect(retainedUnits(chunks)).toBeLessThanOrEqual(1_000);
    const paging = getRunPaging(chunks);
    expect(paging.windowStart).toBe((chunks[0] as PagedChunk).offset);
    // Contiguous record-aligned ranges from byte 0 to the window, each one page.
    let expectedStart = 0;
    const recordStarts = new Set(rows.map(row => row.offset));
    for (const range of paging.earlier) {
      expect(range.start).toBe(expectedStart);
      expect(recordStarts.has(range.end)).toBe(true);
      expect(range.end - range.start).toBeLessThanOrEqual(500);
      expectedStart = range.end;
    }
    expect(expectedStart).toBe(paging.windowStart);
  });

  it("does not evict when no retained record has a saved-log offset yet, and asks for one", () => {
    const live: PagedChunk[] = Array.from({ length: 20 }, (_, index) => ({ ts: "t", stream: "stdout", chunk: "y".repeat(100), seq: index + 1 }));
    const result = evictHead(live, 500);
    expect(result.needsOffsets).toBe(true);
    expect(result.chunks).toHaveLength(20);
  });

  it("(b) re-reads exactly the evicted range across page splits, byte-equal, in order and without duplicates", async () => {
    const log = savedLog(400, seq => `zápis ${seq} ✓ ${"é".repeat(seq % 37)}`);
    const { rows } = parseLogRecords(decoder.decode(log.bytes), 0);
    let window = evictHead(rows, 2_000, undefined, 1_000).chunks;
    expect(getRunPaging(window).earlier.length).toBeGreaterThan(5);
    const ranges: Array<[number, number]> = [];
    const read = async (offset: number, limit: number) => { ranges.push([offset, offset + limit]); return log.read(offset, limit); };
    const seen: string[] = window.map(chunk => chunk.chunk);
    while (getRunPaging(window).earlier.length > 0) {
      const range = getRunPaging(window).earlier.at(-1)!;
      ranges.length = 0;
      const restored = await readLogRange(read, range.start, range.end, 256_000);
      expect(ranges).toHaveLength(1);
      expect(ranges[0]![0]).toBe(range.start);
      expect(ranges.at(-1)![1]).toBe(range.end);
      expect(decoder.decode(log.bytes.slice(range.start, range.end))).toBe(restored.map((_, i) => log.lines[restored[i]!.seq! - 1]).join(""));
      const before = window[0]!.seq!;
      window = restoreEarlier(window, restored, Number.POSITIVE_INFINITY);
      expect(restored.at(-1)!.seq).toBe(before - 1);
      seen.unshift(...restored.map(chunk => chunk.chunk));
    }
    expect(seen).toEqual(rows.map(row => row.chunk));
  });

  it("(c) paging up and back down keeps the bound and returns to the same newest output", async () => {
    const log = savedLog(300, seq => `${seq}`.padEnd(80, "-"));
    const { rows } = parseLogRecords(decoder.decode(log.bytes), 0);
    const bound = 1_600;
    let window = evictHead(rows, bound).chunks;
    const newest = window.map(chunk => chunk.seq);
    for (let round = 0; round < 2; round += 1) {
      while (getRunPaging(window).earlier.length > 0) {
        const range = getRunPaging(window).earlier.at(-1)!;
        window = restoreEarlier(window, await readLogRange(log.read, range.start, range.end, 256_000), bound);
        expect(retainedUnits(window)).toBeLessThanOrEqual(bound);
      }
      expect(window[0]!.seq).toBe(1);
      while (getRunPaging(window).laterFrom !== null) {
        const from = getRunPaging(window).laterFrom!;
        const page = await log.read(from, 3_000);
        const { rows: pageRows, consumedBytes } = parseLogRecords(page.content, from);
        const next = from + consumedBytes;
        window = restoreLater(window, pageRows, next >= log.bytes.length ? null : next, bound).chunks;
        expect(retainedUnits(window)).toBeLessThanOrEqual(bound);
        const seqs = window.map(chunk => chunk.seq!);
        expect(new Set(seqs).size).toBe(seqs.length);
        seqs.forEach((seq, index) => index > 0 && expect(seq).toBe(seqs[index - 1]! + 1));
      }
      expect(window.map(chunk => chunk.seq)).toEqual(newest);
    }
  });

  it("re-reads a range larger than one request page in order", async () => {
    const log = savedLog(60, seq => `${seq}`.padEnd(70, "+"));
    const rows = await readLogRange(log.read, 0, log.bytes.length, 97);
    expect(rows.map(row => row.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(rows.map(row => row.offset)).toEqual(parseLogRecords(decoder.decode(log.bytes), 0).rows.map(row => row.offset));
  });

  it("keeps event lines that are not in the saved log reachable with the range they left with", async () => {
    const log = savedLog(50, seq => `${seq}`.padEnd(100, "."));
    const { rows } = parseLogRecords(decoder.decode(log.bytes), 0);
    const statusLine: PagedChunk = { ts: rows[3]!.ts + "a", stream: "system", chunk: "run running" };
    const withEvent = [...rows.slice(0, 4), statusLine, ...rows.slice(4)];
    const window = evictHead(withEvent, 1_000).chunks;
    expect(window).not.toContain(statusLine);
    let restored = window;
    while (getRunPaging(restored).earlier.length > 0) {
      const range = getRunPaging(restored).earlier.at(-1)!;
      restored = restoreEarlier(restored, await readLogRange(log.read, range.start, range.end, 256_000), Number.POSITIVE_INFINITY);
    }
    expect(restored.map(chunk => chunk.chunk)).toEqual(withEvent.map(chunk => chunk.chunk));
  });
});
