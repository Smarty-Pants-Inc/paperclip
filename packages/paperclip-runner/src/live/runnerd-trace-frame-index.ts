import { open, stat } from "node:fs/promises";

const READ_BUDGET_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;

type Frame = { frameId: number | null; record: number };

/** Incremental, best-effort index of the append-only native debug trace. */
export class RunnerdTraceFrameIndex {
  #identity = "";
  #offset = 0;
  #mtimeMs = 0;
  #complete = false;
  #record = 0;
  #settledAt = 0;
  #partial: Buffer[] = [];
  #partialBytes = 0;
  #discardUntilNewline = false;
  #frames = new Map<string, Frame>();
  #snapshotActive = false;
  #snapshot: { tracePath: string; ready: boolean } | null = null;
  #refreshes = new Map<string, Promise<void>>();

  withSnapshot<T>(work: () => T): T {
    if (this.#snapshotActive) return work();
    this.#snapshotActive = true;
    try {
      return work();
    } finally {
      this.#snapshotActive = false;
      this.#snapshot = null;
    }
  }

  locate(tracePath: string, sourceEventId: string) {
    let snapshot = this.#snapshotActive ? this.#snapshot : null;
    if (snapshot?.tracePath !== tracePath) {
      snapshot = { tracePath, ready: this.#complete && this.#identity !== "" };
      this.#requestRefresh(tracePath);
      if (this.#snapshotActive) this.#snapshot = snapshot;
    }
    if (!snapshot.ready) return { frameId: null, nativeChannelSettled: false };
    const frame = this.#frames.get(sourceEventId);
    return {
      frameId: frame?.frameId ?? null,
      nativeChannelSettled: this.#settledAt > (frame?.record ?? 0),
    };
  }

  async refresh(tracePath: string, drain = false): Promise<void> {
    const inFlight = this.#refreshes.get(tracePath);
    if (inFlight) await inFlight;
    this.#requestRefresh(tracePath);
    await this.#refreshes.get(tracePath);
    while (drain) {
      const current = await stat(tracePath).catch(() => null);
      if (!current || current.size <= this.#offset) return;
      this.#requestRefresh(tracePath);
      await this.#refreshes.get(tracePath);
    }
  }

  #requestRefresh(tracePath: string): void {
    if (this.#refreshes.has(tracePath)) return;
    const refresh = this.#refresh(tracePath)
      .catch(() => undefined)
      .finally(() => this.#refreshes.delete(tracePath));
    this.#refreshes.set(tracePath, refresh);
  }

  async #refresh(tracePath: string): Promise<void> {
    const current = await stat(tracePath);
    const identity = `${current.dev}:${current.ino}`;
    if (
      identity !== this.#identity || current.size < this.#offset ||
      (current.size === this.#offset && current.mtimeMs !== this.#mtimeMs)
    ) {
      this.clear();
      this.#identity = identity;
    }
    this.#mtimeMs = current.mtimeMs;
    if (current.size > this.#offset) {
      const file = await open(tracePath, "r");
      try {
        const opened = await file.stat();
        if (`${opened.dev}:${opened.ino}` !== identity) return;
        const buffer = Buffer.allocUnsafe(Math.min(READ_BUDGET_BYTES, current.size - this.#offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.#offset);
        this.#offset += bytesRead;
        let start = 0;
        for (let end = buffer.indexOf(10); end !== -1 && end < bytesRead; end = buffer.indexOf(10, start)) {
          this.#consume(buffer.subarray(start, end), true);
          start = end + 1;
        }
        if (start < bytesRead) this.#consume(buffer.subarray(start, bytesRead), false);
      } finally {
        await file.close();
      }
    }
    this.#complete = this.#offset >= current.size && this.#partialBytes === 0 && !this.#discardUntilNewline;
  }

  clear() {
    this.#snapshot = null;
    this.#identity = "";
    this.#offset = 0;
    this.#mtimeMs = 0;
    this.#complete = false;
    this.#record = 0;
    this.#settledAt = 0;
    this.#partial = [];
    this.#partialBytes = 0;
    this.#discardUntilNewline = false;
    this.#frames.clear();
  }

  #consume(part: Buffer, terminated: boolean) {
    if (this.#discardUntilNewline || this.#partialBytes + part.length > MAX_RECORD_BYTES) {
      this.#partial = [];
      this.#partialBytes = 0;
      this.#discardUntilNewline = !terminated;
      return;
    }
    if (!terminated) {
      this.#partial.push(Buffer.from(part));
      this.#partialBytes += part.length;
      return;
    }
    const line = this.#partialBytes > 0
      ? Buffer.concat([...this.#partial, part]).toString("utf8")
      : part.toString("utf8");
    this.#partial = [];
    this.#partialBytes = 0;
    this.#indexLine(line);
  }

  #indexLine(line: string) {
    if (!line.trim()) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!entry || typeof entry !== "object") return;
    this.#record += 1;
    if (entry.kind === "trace_status" && entry.debugChannel === "rust_native") this.#settledAt = this.#record;
    if (entry.kind !== "interpretation" || !Array.isArray(entry.emittedEventIds)) return;
    const frameId = typeof entry.frameId === "number" ? entry.frameId : null;
    for (const eventId of entry.emittedEventIds) {
      if (typeof eventId === "string") this.#frames.set(eventId, { frameId, record: this.#record });
    }
  }
}
