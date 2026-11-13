import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerdTraceFrameIndex } from "./runnerd-trace-frame-index.js";

const interpretation = (frameId: number, ...emittedEventIds: string[]) =>
  `${JSON.stringify({ kind: "interpretation", frameId, emittedEventIds })}\n`;
const settled = `${JSON.stringify({ kind: "trace_status", debugChannel: "rust_native", status: "complete" })}\n`;

describe("runnerd trace frame index", () => {
  let directory: string;
  let path: string;
  let index: RunnerdTraceFrameIndex;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "runnerd-trace-index-"));
    path = join(directory, "trace.ndjson");
    index = new RunnerdTraceFrameIndex();
  });
  afterEach(() => {
    index.clear();
    rmSync(directory, { recursive: true, force: true });
  });

  it("indexes appended records once across repeated pending lookups and both stages", async () => {
    const first = interpretation(1, "event-1", "event-2");
    writeFileSync(path, first);
    await index.refresh(path);
    expect(index.locate(path, "event-2")).toEqual({ frameId: 1, nativeChannelSettled: false });
    for (let i = 0; i < 4096; i++) {
      expect(index.locate(path, `pending-${i}`)).toEqual({ frameId: null, nativeChannelSettled: false });
      expect(index.locate(path, "event-1").frameId).toBe(1);
    }
    appendFileSync(path, interpretation(2, "pending-1") + settled);
    await index.refresh(path);
    expect(index.locate(path, "pending-1")).toEqual({ frameId: 2, nativeChannelSettled: true });
    expect(index.locate(path, "missing")).toEqual({ frameId: null, nativeChannelSettled: true });
  });

  it("shares stat and index work across all retry lookups in a pump snapshot", async () => {
    writeFileSync(path, interpretation(1, "first"));
    for (let pump = 0; pump < 12; pump++) {
      await index.refresh(path);
      index.withSnapshot(() => {
        for (let pending = 0; pending < 4096; pending++) {
          expect(index.locate(path, `pending-${pending}`).frameId).toBeNull();
        }
        expect(index.locate(path, "first").frameId).toBe(1);
      });
    }
    appendFileSync(path, interpretation(2, "pending-1"));
    await index.refresh(path);
    index.withSnapshot(() => {
      expect(index.locate(path, "pending-1").frameId).toBe(2);
      expect(index.locate(path, "first").frameId).toBe(1);
    });
  });

  it("caches missing-file failures only for the current snapshot", async () => {
    await index.refresh(path);
    index.withSnapshot(() => {
      for (let pending = 0; pending < 512; pending++) {
        expect(index.locate(path, `pending-${pending}`)).toEqual({ frameId: null, nativeChannelSettled: false });
      }
    });
    writeFileSync(path, interpretation(9, "late"));
    await index.refresh(path);
    expect(index.withSnapshot(() => index.locate(path, "late").frameId)).toBe(9);
  });

  it("bounds reads per snapshot, not per pending entry, and keeps late suffix correlations", async () => {
    writeFileSync(path, interpretation(1, "same") + settled +
      JSON.stringify({ kind: "frame", rawBase64: "x".repeat(2 * 1024 * 1024) }) + "\n" + interpretation(2, "same"));
    for (let pass = 0; pass < 3; pass++) {
      await index.refresh(path);
      index.withSnapshot(() => {
        for (let pending = 0; pending < 512; pending++) {
          expect(index.locate(path, "same").frameId).toBe(pass >= 1 ? 2 : null);
        }
      });
    }
  });

  it("releases a snapshot after an exception and shares nested passes", async () => {
    writeFileSync(path, interpretation(1, "first"));
    await index.refresh(path);
    expect(() => index.withSnapshot(() => {
      index.locate(path, "first");
      index.withSnapshot(() => index.locate(path, "first"));
      throw new Error("stop pass");
    })).toThrow("stop pass");
    appendFileSync(path, interpretation(2, "second"));
    await index.refresh(path);
    expect(index.locate(path, "second").frameId).toBe(2);
  });

  it("retains partial lines and split UTF-8 until the append is complete", async () => {
    const line = Buffer.from(interpretation(9, "event-🔎"));
    const split = line.indexOf(Buffer.from("🔎")) + 2;
    writeFileSync(path, line.subarray(0, split));
    await index.refresh(path);
    expect(index.locate(path, "event-🔎").frameId).toBeNull();
    appendFileSync(path, line.subarray(split, line.length - 1));
    await index.refresh(path);
    expect(index.locate(path, "event-🔎").frameId).toBeNull();
    appendFileSync(path, "\n");
    await index.refresh(path);
    expect(index.locate(path, "event-🔎").frameId).toBe(9);
  });

  it("matches the latest interpretation and only settlement records after it", async () => {
    writeFileSync(path, interpretation(1, "same") + settled + interpretation(2, "same"));
    await index.refresh(path);
    expect(index.locate(path, "same")).toEqual({ frameId: 2, nativeChannelSettled: false });
    expect(index.locate(path, "missing").nativeChannelSettled).toBe(true);
    appendFileSync(path, settled);
    await index.refresh(path);
    expect(index.locate(path, "same")).toEqual({ frameId: 2, nativeChannelSettled: true });
  });

  it("recovers from a damaged line without discarding valid correlations", async () => {
    writeFileSync(path, 'null\n{broken}\n' + interpretation(3, "event"));
    await index.refresh(path);
    expect(index.locate(path, "event").frameId).toBe(3);
  });

  it("invalidates old correlations when the trace is truncated or replaced", async () => {
    writeFileSync(path, interpretation(12345, "old-long-event") + settled);
    await index.refresh(path);
    expect(index.locate(path, "old-long-event").frameId).toBe(12345);
    writeFileSync(path, interpretation(2, "new"));
    await index.refresh(path);
    expect(index.locate(path, "old-long-event")).toEqual({ frameId: null, nativeChannelSettled: false });
    expect(index.locate(path, "new").frameId).toBe(2);
    writeFileSync(join(directory, "replacement"), interpretation(4, "replacement-event"));
    renameSync(join(directory, "replacement"), path);
    await index.refresh(path);
    expect(index.locate(path, "new").frameId).toBeNull();
    expect(index.locate(path, "replacement-event").frameId).toBe(4);
  });

  it("bounds each read while making forward progress through a large trace", async () => {
    const content = JSON.stringify({ kind: "frame", rawBase64: "x".repeat(3 * 1024 * 1024) }) + "\n" + interpretation(4, "last");
    writeFileSync(path, content);
    await index.refresh(path);
    expect(index.locate(path, "last").frameId).toBeNull();
    let frameId: number | null = null;
    for (let pass = 0; pass < 8 && frameId === null; pass++) {
      await index.refresh(path);
      frameId = index.locate(path, "last").frameId;
    }
    expect(frameId).toBe(4);
    expect(index.locate(path, "missing")).toEqual({ frameId: null, nativeChannelSettled: false });
  });

  it("drains every bounded async read before final close correlation lookup", async () => {
    writeFileSync(path, JSON.stringify({ kind: "frame", rawBase64: "x".repeat(2 * 1024 * 1024) }) + "\n" + interpretation(4, "last"));
    await index.refresh(path, true);
    expect(index.locate(path, "last").frameId).toBe(4);
  });

  it("retries missing files and clears retained indexes on close", async () => {
    await index.refresh(path);
    expect(index.locate(path, "event")).toEqual({ frameId: null, nativeChannelSettled: false });
    writeFileSync(path, interpretation(1, "event"));
    await index.refresh(path);
    expect(index.locate(path, "event").frameId).toBe(1);
    index.clear();
    await index.refresh(path);
    expect(index.locate(path, "event").frameId).toBe(1);
  });

  it("does not resolve from an incomplete prefix of a large trace", async () => {
    writeFileSync(path, interpretation(1, "same") + settled +
      JSON.stringify({ kind: "frame", rawBase64: "x".repeat(1024 * 1024) }) + "\n" +
      interpretation(2, "same"));
    await index.refresh(path);
    expect(index.locate(path, "same")).toEqual({ frameId: null, nativeChannelSettled: false });
    await index.refresh(path);
    expect(index.locate(path, "same")).toEqual({ frameId: 2, nativeChannelSettled: false });
  });

  it("keeps progress for more than 16 interleaved active transports", async () => {
    const raw = JSON.stringify({ kind: "frame", rawBase64: "x".repeat(2 * 1024 * 1024) }) + "\n";
    const traces = Array.from({ length: 24 }, (_, i) => {
      const tracePath = join(directory, `trace-${i}.ndjson`);
      writeFileSync(tracePath, raw + interpretation(i, "last"));
      return { tracePath, index: new RunnerdTraceFrameIndex() };
    });
    for (let round = 0; round < 3; round++) {
      for (const [i, trace] of traces.entries()) {
        await trace.index.refresh(trace.tracePath);
        expect(trace.index.locate(trace.tracePath, "last").frameId).toBe(round >= 1 ? i : null);
      }
    }
  });

  it("skips oversized records across appends without decoding or parsing them", async () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      writeFileSync(path, '{"kind":"frame","rawBase64":"');
      const chunk = "x".repeat(32 * 1024);
      for (let i = 0; i < 256; i++) {
        appendFileSync(path, chunk);
        await index.refresh(path);
        expect(index.locate(path, "after").frameId).toBeNull();
      }
      expect(parse).not.toHaveBeenCalled();
      appendFileSync(path, '"}\n' + interpretation(7, "after"));
      await index.refresh(path);
      expect(index.locate(path, "after").frameId).toBe(7);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(Buffer.byteLength(parse.mock.calls[0]![0])).toBeLessThan(64 * 1024);
    } finally {
      parse.mockRestore();
    }
  });

  it("waits for a partial later interpretation before returning an older match", async () => {
    const next = interpretation(2, "same");
    writeFileSync(path, interpretation(1, "same") + next.slice(0, -1));
    await index.refresh(path);
    expect(index.locate(path, "same").frameId).toBeNull();
    appendFileSync(path, "\n");
    await index.refresh(path);
    expect(index.locate(path, "same").frameId).toBe(2);
  });
});
