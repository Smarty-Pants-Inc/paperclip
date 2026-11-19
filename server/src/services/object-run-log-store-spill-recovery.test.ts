import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createObjectRunLogStore, listUnrecoveredObjectRunLogSpills, readObjectRunLogSpill,
  resolveObjectRunLogSpillDir } from "./object-run-log-store.js";
import { event, ids, newStore, readAll, record, sha, spilledRun } from "./object-run-log-spill.fixture.js";
import { recoverSpilledRunLog } from "./heartbeat/run-log-spill-recovery.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7002475364 (rf-3 conditions 1, 2, 4)
// Keep reason: NEVER-OK trace custody. A run log that object storage refused
// is kept in a local spill; it must become READABLE as the run's log once
// storage takes writes again, and the spill must sit inside the run-log data
// tree and never be deleted. Production store + journal; the only fake is the
// storage provider (payload PUTs fail with EIO while `down`).

describe("a spilled run log becomes readable once storage is restored", () => {
  it("persistent EIO -> spill; storage restored -> recovery -> the re-read log is ALL admitted bytes, size and sha set; the spill is kept", async () => {
    const r = await spilledRun("spill-recover");
    expect(r.summary).toEqual({ bytes: null, sha256: null, compressed: false });
    const before = await readObjectRunLogSpill(r.spillDir, r.logRef);
    expect(before.unrecovered.length).toBeGreaterThan(0);
    const spilledFile = readFileSync(before.path);
    // A new process (no writer state) while storage is STILL down: nothing is lost, nothing is closed.
    const down = newStore(r.m, r.spillDir);
    expect(await listUnrecoveredObjectRunLogSpills(r.spillDir)).toEqual([r.logRef]);
    await expect(down.recoverSpill!({ ...ids, runId: "spill-recover" })).rejects.toMatchObject({ code: "EIO" });
    expect(Buffer.concat([await readAll(down, r.logRef), (await readObjectRunLogSpill(r.spillDir, r.logRef)).unrecovered])
      .equals(r.admitted)).toBe(true);
    // Storage restored.
    r.m.state.down = false;
    const store = newStore(r.m, r.spillDir);
    expect(await store.recoverSpill!({ ...ids, runId: "spill-recover" }))
      .toEqual({ bytes: r.admitted.length, sha256: sha(r.admitted), compressed: false });
    expect((await readAll(store, r.logRef)).equals(r.admitted)).toBe(true);
    expect(JSON.parse(r.m.objects.get(`logs/segments-v1/${r.logRef}/head.json`)!.toString())).toMatchObject({
      closed: true, end: r.admitted.length, sequence: 3 });
    const after = await readObjectRunLogSpill(r.spillDir, r.logRef);
    expect(after.unrecovered.length).toBe(0);
    expect(await listUnrecoveredObjectRunLogSpills(r.spillDir)).toEqual([]);
    // Recovery never deletes or truncates the kept spill.
    expect(readFileSync(after.path).equals(spilledFile)).toBe(true);
    // Nothing left to do: a second recovery is a no-op.
    expect(await store.recoverSpill!({ ...ids, runId: "spill-recover" })).toBeNull();
  }, 30_000);

  it("a resumed attempt stores the spill first, so its own bytes follow the admitted ones in order", async () => {
    const r = await spilledRun("spill-resume");
    r.m.state.down = false;
    const store = newStore(r.m, r.spillDir);
    const handle = await store.begin({ ...ids, runId: "spill-resume" });
    expect(handle.initialBytes).toBe(r.admitted.length);
    expect(handle.initialSequence).toBe(3);
    await store.append(handle, event(4, "resumed"));
    const all = Buffer.concat([r.admitted, record(handle.attemptId, 4, "resumed")]);
    expect(await store.finalize(handle)).toEqual({ bytes: all.length, sha256: sha(all), compressed: false });
    expect((await readAll(store, r.logRef)).equals(all)).toBe(true);
  }, 30_000);

  it("the upload is idempotent at its journal offset: stored bytes whose record was lost are not appended twice", async () => {
    const r = await spilledRun("spill-idempotent");
    r.m.state.down = false;
    const first = newStore(r.m, r.spillDir);
    const handle = await first.begin({ ...ids, runId: "spill-idempotent" });   // stores the spill, then the process dies
    expect(handle.initialBytes).toBe(r.admitted.length);
    const spill = await readObjectRunLogSpill(r.spillDir, r.logRef);
    // The crash lost the "recovered" records: the index says the bytes are still only in the spill.
    writeFileSync(spill.indexPath, spill.records.filter(entry => entry.event === "spilled")
      .map(entry => `${JSON.stringify(entry)}\n`).join(""));
    expect((await readObjectRunLogSpill(r.spillDir, r.logRef)).unrecovered.length).toBeGreaterThan(0);
    const puts = r.m.state.payloadPuts;
    const store = newStore(r.m, r.spillDir);
    expect(await store.recoverSpill!({ ...ids, runId: "spill-idempotent" }))
      .toEqual({ bytes: r.admitted.length, sha256: sha(r.admitted), compressed: false });
    expect(r.m.state.payloadPuts).toBe(puts);
    expect((await readAll(store, r.logRef)).equals(r.admitted)).toBe(true);
    expect((await readObjectRunLogSpill(r.spillDir, r.logRef)).unrecovered.length).toBe(0);
  }, 30_000);

  it("a spill that no longer fits the journal end is kept, and the log is never closed as complete", async () => {
    const r = await spilledRun("spill-misplaced");
    r.m.state.down = false;
    // Bytes were appended past the gap by a writer that did not know the spill.
    const blind = createObjectRunLogStore({ provider: r.m.provider, keyPrefix: "logs", flushMs: 1000,
      spillDir: mkdtempSync(path.join(os.tmpdir(), "objlog-spill-other-")), assertWriterAuthority: async () => undefined });
    const other = await blind.begin({ ...ids, runId: "spill-misplaced" });
    await blind.append(other, event(9, "past-the-gap"));
    await blind.flush!(other);
    const spilledFile = readFileSync((await readObjectRunLogSpill(r.spillDir, r.logRef)).path);
    const store = newStore(r.m, r.spillDir);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      expect(await store.recoverSpill!({ ...ids, runId: "spill-misplaced" })).toEqual({ bytes: null, sha256: null, compressed: false });
    } finally { warning.mockRestore(); }
    const kept = await readObjectRunLogSpill(r.spillDir, r.logRef);
    expect(readFileSync(kept.path).equals(spilledFile)).toBe(true);
    expect(Buffer.concat([record(r.handle.attemptId, 1, "one"), kept.unrecovered]).equals(r.admitted)).toBe(true);
    expect(JSON.parse(r.m.objects.get(`logs/segments-v1/${r.logRef}/head.json`)!.toString()).closed).toBe(false);
  }, 30_000);

  it("settles the run's size and sha only while the run is still eligible, once for concurrent readers", async () => {
    const r = await spilledRun("spill-settle");
    r.m.state.down = false;
    const store = newStore(r.m, r.spillDir);
    const row = { logBytes: null as number | null, logSha256: null as string | null, status: "failed" };
    const settle = vi.fn(async (summary: { bytes: number; sha256: string | null }) => {
      Object.assign(row, { logBytes: summary.bytes, logSha256: summary.sha256 });
      return true;
    });
    const settlement = { eligible: async () => row.status !== "running" && row.logBytes === null, settle };
    row.status = "running";
    await expect(recoverSpilledRunLog(store, r.logRef, settlement)).rejects.toThrow("run_log_spill_recovery_authority_lost");
    expect((await readObjectRunLogSpill(r.spillDir, r.logRef)).unrecovered.length).toBeGreaterThan(0);
    row.status = "failed";
    await Promise.all([recoverSpilledRunLog(store, r.logRef, settlement), recoverSpilledRunLog(store, r.logRef, settlement)]);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ logBytes: r.admitted.length, logSha256: sha(r.admitted) });
    expect((await readAll(store, r.logRef)).equals(r.admitted)).toBe(true);
  }, 30_000);
});

describe("the spill path is inside the run-log data tree", () => {
  const saved = { spill: process.env.RUN_LOG_SPILL_PATH, base: process.env.RUN_LOG_BASE_PATH };
  afterEach(() => {
    for (const [key, value] of [["RUN_LOG_SPILL_PATH", saved.spill], ["RUN_LOG_BASE_PATH", saved.base]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  it("defaults to <instance>/data/run-logs/.spill, follows RUN_LOG_BASE_PATH, and keeps the RUN_LOG_SPILL_PATH override", () => {
    delete process.env.RUN_LOG_SPILL_PATH;
    delete process.env.RUN_LOG_BASE_PATH;
    const runLogs = path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
    expect(resolveObjectRunLogSpillDir()).toBe(path.join(runLogs, ".spill"));
    // Under the instance root AND under the tree a custody copy of data/run-logs takes.
    expect(path.relative(runLogs, resolveObjectRunLogSpillDir()).startsWith("..")).toBe(false);
    expect(path.relative(resolvePaperclipInstanceRoot(), resolveObjectRunLogSpillDir())).toBe(path.join("data", "run-logs", ".spill"));
    process.env.RUN_LOG_BASE_PATH = "/custody/run-logs";
    expect(resolveObjectRunLogSpillDir()).toBe("/custody/run-logs/.spill");
    process.env.RUN_LOG_SPILL_PATH = "/override/spill";
    expect(resolveObjectRunLogSpillDir()).toBe("/override/spill");
    expect(resolveObjectRunLogSpillDir("/explicit")).toBe("/explicit");
  });
});
