import { describe, expect, it, vi } from "vitest";
import { RunnerdTraceRehydrationQueue } from "./runnerd-trace-rehydration-queue.js";

describe("bounded trace rehydration work", () => {
  it("deduplicates frame keys within a file without losing distinct files or records", () => {
    const queue = new RunnerdTraceRehydrationQueue<string>();
    expect(queue.enqueue("trace-a", "event", "first")).toBe(true);
    expect(queue.enqueue("trace-a", "event", "duplicate")).toBe(true);
    expect(queue.enqueue("trace-b", "event", "other file")).toBe(true);
    expect(queue.enqueue("trace-a", "event:other-method", "other record")).toBe(true);
    expect(queue.length).toBe(3);
    const append = vi.fn(() => "written" as const);
    expect(queue.flush(append)).toBe(0);
    expect(append.mock.calls).toEqual([
      ["trace-a", "first"], ["trace-b", "other file"], ["trace-a", "other record"],
    ]);
    expect(queue.length).toBe(0);
  });

  it("caps pending entries, admits duplicates at capacity, and drains every resolvable entry on close", () => {
    const queue = new RunnerdTraceRehydrationQueue<number>();
    for (let i = 0; i < 4096; i++) expect(queue.enqueue("trace", `frame-${i}`, i)).toBe(true);
    expect(queue.enqueue("trace", "frame-0", 0)).toBe(true);
    expect(queue.enqueue("trace", "overflow", 4096)).toBe(false);
    expect(queue.length).toBe(4096);
    const written: number[] = [];
    expect(queue.flush((_path, value) => { written.push(value); return "written"; }, true)).toBe(0);
    expect(written).toEqual(Array.from({ length: 4096 }, (_, i) => i));
    expect(queue.length).toBe(0);
  });

  it("does constant retry work per pass and gives later frames a turn", () => {
    const queue = new RunnerdTraceRehydrationQueue<number>();
    for (let i = 0; i < 512; i++) queue.enqueue("trace", `frame-${i}`, i);
    const visited: number[] = [];
    for (let pump = 0; pump < 4; pump++) {
      const before = visited.length;
      expect(queue.flush((_path, value) => { visited.push(value); return "retry"; })).toBe(0);
      expect(visited.length - before).toBe(128);
    }
    expect(visited).toEqual(Array.from({ length: 512 }, (_, i) => i));
    expect(queue.length).toBe(512);
    const written: number[] = [];
    for (let pump = 0; pump < 4; pump++) queue.flush((_path, value) => { written.push(value); return "written"; });
    expect(written).toEqual(visited);
    expect(queue.length).toBe(0);
  });

  it("expires unresolved entries after a finite retry count without refreshing duplicates", () => {
    const queue = new RunnerdTraceRehydrationQueue<string>();
    queue.enqueue("trace", "missing", "missing");
    for (let retry = 0; retry < 4095; retry++) {
      expect(queue.flush(() => "retry")).toBe(0);
      queue.enqueue("trace", "missing", "duplicate");
    }
    expect(queue.flush(() => "retry")).toBe(1);
    expect(queue.length).toBe(0);
    const append = vi.fn(() => "retry" as const);
    expect(queue.flush(append)).toBe(0);
    expect(append).not.toHaveBeenCalled();
  });

  it("removes settled non-applicable frames and clears work when the session ends", () => {
    const queue = new RunnerdTraceRehydrationQueue<string>();
    queue.enqueue("trace", "settled", "settled");
    queue.enqueue("trace", "retry", "retry");
    expect(queue.flush((_path, value) => value === "settled" ? "not_applicable" : "retry")).toBe(0);
    expect(queue.length).toBe(1);
    queue.clear();
    const append = vi.fn(() => "retry" as const);
    queue.flush(append);
    expect(append).not.toHaveBeenCalled();
  });
});
