import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainSecretResolutionWrites, enqueueSecretAccessEvent, enqueueSecretLastResolvedAt, flushSecretResolutionWrites } from "../services/secret-resolution-writes.js";

const event = { companyId: "company", secretId: "secret", provider: "local_encrypted", actorType: "system", consumerType: "environment", consumerId: "boat", outcome: "success" };
function fakeDb(write: (rows: Array<Record<string, unknown>>) => Promise<unknown>) {
  const insert = vi.fn(() => ({ values: (rows: Array<Record<string, unknown>>) => ({ onConflictDoNothing: () => write(rows) }) }));
  const update = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
  return { db: { insert, update } as unknown as Db, insert, update };
}
describe("deferred secret resolution writes (audit data safety)", () => {
  afterEach(() => vi.useRealTimers());
  it("flush waits for the active INSERT and preserves events arriving during it", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const recorded: Array<Record<string, unknown>> = [];
    let first = true;
    const { db } = fakeDb(async rows => {
      if (first) { first = false; entered(); await blocked; }
      recorded.push(...rows);
    });
    for (let i = 0; i < 20; i++) enqueueSecretAccessEvent(db, event);
    let flushed = false;
    const flush = flushSecretResolutionWrites(db).then(() => { flushed = true; });
    await started;
    enqueueSecretAccessEvent(db, event);
    expect(flushed).toBe(false);
    release();
    await flush;
    expect(recorded).toHaveLength(21);
    expect(new Set(recorded.map(row => row.id)).size).toBe(21);
    expect(recorded.every(row => row.createdAt instanceof Date)).toBe(true);
  });
  it("retries an uncertain committed INSERT once using the same IDs (no duplicate audit records)", async () => {
    const recorded = new Map<unknown, Record<string, unknown>>();
    let calls = 0;
    const { db } = fakeDb(async rows => {
      for (const row of rows) recorded.set(row.id, row);
      if (++calls === 1) throw new Error("connection lost after commit");
    });
    for (let i = 0; i < 20; i++) enqueueSecretAccessEvent(db, event);
    await flushSecretResolutionWrites(db);
    expect(calls).toBe(2);
    expect(recorded.size).toBe(20);
  });
  it("retains the exact count after both attempts fail, then recovers without dropping a record", async () => {
    let fail = true;
    const recorded: Array<Record<string, unknown>> = [];
    const { db, insert } = fakeDb(async rows => { if (fail) throw new Error("offline"); recorded.push(...rows); });
    for (let i = 0; i < 20; i++) enqueueSecretAccessEvent(db, event);
    await expect(flushSecretResolutionWrites(db)).rejects.toThrow("audit write failed");
    expect(insert).toHaveBeenCalledTimes(2);
    fail = false;
    await flushSecretResolutionWrites(db);
    expect(recorded).toHaveLength(20);
  });
  it.each(["stalled", "failing"])("backpressures at 10,000 pending records while INSERTs are %s, then delivers every event", async mode => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let recovered = false;
    const recorded: Array<Record<string, unknown>> = [];
    const { db } = fakeDb(async rows => {
      if (!recovered) {
        if (mode === "failing") throw new Error("offline");
        await blocked;
      }
      recorded.push(...rows);
    });
    let admitted = 0;
    const producers = Array.from({ length: 10_050 }, (_, i) =>
      Promise.resolve(enqueueSecretAccessEvent(db, { ...event, consumerId: `call-${i}` })).then(() => { admitted++; }));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(admitted, "full queue must hold producers instead of growing or dropping events").toBe(10_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(admitted).toBe(10_000);
      expect(recorded).toHaveLength(0);
    } finally {
      recovered = true;
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(producers);
      await flushSecretResolutionWrites(db);
    }
    expect(admitted).toBe(10_050);
    expect(recorded).toHaveLength(10_050);
    expect(new Set(recorded.map(row => row.id)).size).toBe(10_050);
    expect(new Set(recorded.map(row => row.consumerId)).size).toBe(10_050);
  });
  it("bounds usage touches and audit rows together without dropping either obligation", async () => {
    vi.useFakeTimers();
    let recovered = false;
    const recorded: Array<Record<string, unknown>> = [];
    const { db, update } = fakeDb(async rows => { recorded.push(...rows); });
    const touched = new Set<string>();
    update.mockImplementation(() => ({ set: () => ({ where: async () => {
      if (!recovered) throw new Error("offline");
      touched.add(String(update.mock.calls.length));
    } }) }));
    let admitted = 0;
    const producers = Array.from({ length: 10_000 }, (_, i) =>
      Promise.resolve(enqueueSecretLastResolvedAt(db, { id: `secret-${i}`, lastResolvedAt: null })).then(() => { admitted++; }));
    producers.push(Promise.resolve(enqueueSecretAccessEvent(db, event)).then(() => { admitted++; }));
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(admitted).toBe(10_000);
      expect(recorded).toHaveLength(0);
    } finally {
      recovered = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(producers);
      await flushSecretResolutionWrites(db);
    }
    expect(recorded).toHaveLength(1);
    expect(touched.size).toBe(10_000);
    expect(admitted).toBe(10_001);
  });
  it("shutdown drain remains pending after both INSERT attempts fail, then awaits the scheduled recovery", async () => {
    vi.useFakeTimers();
    let fail = true;
    const recorded: Array<Record<string, unknown>> = [];
    const { db, insert } = fakeDb(async rows => { if (fail) throw new Error("offline"); recorded.push(...rows); });
    enqueueSecretAccessEvent(db, event);
    let drained = false;
    const drain = drainSecretResolutionWrites().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(drained).toBe(false);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    await drain;
    expect(recorded).toHaveLength(1);
    expect(drained).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(insert).toHaveBeenCalledTimes(3);
  });
  it("shutdown dead-letters a permanently failed batch on its fifth deadline, then persists later arrivals and goes quiet", async () => {
    vi.useFakeTimers();
    const recorded: Array<Record<string, unknown>> = [];
    const failedIds: unknown[] = [];
    const { db, insert } = fakeDb(async rows => {
      if (rows.some(row => row.consumerId === "poison")) {
        failedIds.push(...rows.map(row => row.id));
        throw new Error("persistent non-FK failure with synthetic-private-error");
      }
      recorded.push(...rows);
    });
    await enqueueSecretAccessEvent(db, { ...event, consumerId: "poison" });
    let drained = false;
    const drain = drainSecretResolutionWrites().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(insert).toHaveBeenCalledTimes(2);
    await enqueueSecretAccessEvent(db, { ...event, consumerId: "healthy" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(drained).toBe(false);
    expect(insert).toHaveBeenCalledTimes(8);
    expect(recorded).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await drain;
    expect(drained).toBe(true);
    expect(insert).toHaveBeenCalledTimes(11);
    expect(failedIds).toHaveLength(10);
    expect(new Set(failedIds).size).toBe(1);
    expect(recorded).toMatchObject([{ consumerId: "healthy" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(insert).toHaveBeenCalledTimes(11);
  });
  it("uses the one-second/N-event deadline, goes quiet, and reactivates on the next producer", async () => {
    vi.useFakeTimers();
    const recorded: Array<Record<string, unknown>> = [];
    const { db, insert, update } = fakeDb(async rows => { recorded.push(...rows); });
    enqueueSecretAccessEvent(db, event);
    enqueueSecretLastResolvedAt(db, { id: "secret", lastResolvedAt: null });
    await vi.advanceTimersByTimeAsync(999);
    expect(insert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushSecretResolutionWrites(db);
    expect(recorded).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) enqueueSecretAccessEvent(db, event);
    await vi.advanceTimersByTimeAsync(0);
    await flushSecretResolutionWrites(db);
    expect(recorded).toHaveLength(101);
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
