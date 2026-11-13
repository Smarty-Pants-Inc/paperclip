import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { RunnerdTraceFrameIndex } from "./runnerd-trace-frame-index.js";

it("prints base versus fix synchronous pump maxima for 50 pending rehydrations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trace-pump-bench-"));
  const path = join(directory, "trace.ndjson");
  const index = new RunnerdTraceFrameIndex();
  try {
    writeFileSync(path, Buffer.alloc(10 * 1024 * 1024, 0x78));
    const pending = Array.from({ length: 50 }, (_, n) => `pending-${n}`);
    const basePump = () => {
      // Base behavior: the first pending lookup in a pump synchronously stats and
      // reads at most one MiB; the remaining 49 lookups share that snapshot.
      const info = statSync(path);
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, info.size));
        readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        closeSync(fd);
      }
      for (const _eventId of pending) { /* pending lookup work */ }
    };
    const fixPump = () => index.withSnapshot(() => {
      for (const eventId of pending) index.locate(path, eventId);
    });
    const maxima = async (pump: () => void) => {
      const samples: number[] = [];
      for (let n = 0; n < 12; n++) {
        const start = performance.now();
        pump();
        samples.push(performance.now() - start);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return Math.max(...samples);
    };
    const baseMaxMs = await maxima(basePump);
    const fixMaxMs = await maxima(fixPump);
    console.log(JSON.stringify({ pendingRehydrations: 50, traceBytes: 10 * 1024 * 1024, pumps: 12, baseMaxSynchronousPumpMs: baseMaxMs, fixMaxSynchronousPumpMs: fixMaxMs }));
    expect(baseMaxMs).toBeGreaterThan(0);
    expect(fixMaxMs).toBeGreaterThan(0);
  } finally {
    index.clear();
    rmSync(directory, { recursive: true, force: true });
  }
}, 2_000);
