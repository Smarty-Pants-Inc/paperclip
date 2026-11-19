import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { candidateHoldsUnrecoveredRunLogSpill, listUnrecoveredObjectRunLogSpills,
  readObjectRunLogSpill } from "./object-run-log-store.js";
import { event, ids, newStore, plantSpillCustodyFault, readAll, record, sha, SPILL_CUSTODY_FAULTS, SPILL_CUSTODY_ROW,
  spillCustodyFaults, spilledRun, spillMemory } from "./object-run-log-spill.fixture.js";

// catch: rf-7 OBJLOG9 F1 (11-19): an index corrupted to zero bytes, `{}` or `[]`
// beside real unrecovered bytes read as "recovered", and cleanup, the reaper and
// the scheduled sweep deleted the ONLY copy of source-less chunks.
// Keep reason: NEVER-OK trace custody. The listing and the content guard are the
// two doors every deleting path goes through; both must keep a spill unless its
// record positively names it recovered AND the recovered copy, read back from
// the object log, hashes equal to the spill file. Production writer, store and
// journal; the only fake is the storage provider. Every fault is planted and named.
describe("a kept spill is released only on positive, read-back proof", () => {
  afterEach(() => vi.restoreAllMocks());

  async function spill(runId: string, recovered: boolean) {
    const r = await spilledRun(runId);
    if (recovered) {
      r.m.state.down = false;
      expect((await newStore(r.m, r.spillDir).recoverSpill!({ ...ids, runId }))?.bytes).toBe(r.admitted.length);
    }
    return { ...r, ...await readObjectRunLogSpill(r.spillDir, r.logRef) };
  }
  // The two doors, and the custody rows they logged.
  async function decide(spillDir: string) {
    const warn = vi.spyOn(logger, "warn");
    const decision = { listed: await listUnrecoveredObjectRunLogSpills(spillDir),
      guarded: await candidateHoldsUnrecoveredRunLogSpill(spillDir) };
    const rows = warn.mock.calls.filter(call => call[1] === SPILL_CUSTODY_ROW).map(call => call[0] as Record<string, unknown>);
    warn.mockRestore();
    return { ...decision, rows };
  }
  const log = (s: Awaited<ReturnType<typeof spill>>) => newStore(s.m, s.spillDir).read({ store: "s3_segments", logRef: s.logRef });

  it.each(spillCustodyFaults)("%s: kept by the listing and the content guard, bytes identical, custody row", async fault => {
    const s = await spill(`custody-${fault}`, SPILL_CUSTODY_FAULTS[fault].recovered);
    const before = await log(s);
    const planted = await plantSpillCustodyFault(s, fault);
    const row = expect.objectContaining({ spill: s.path, index: s.indexPath, reason: planted.reason });
    expect(await decide(s.spillDir)).toEqual({ listed: [s.logRef], guarded: true, rows: [row, row] });
    expect(sha(await fs.readFile(s.path))).toBe(sha(planted.bytes));
    expect(await fs.readFile(s.indexPath).catch(() => null)).toEqual(planted.index);
    if (fault.startsWith("index-")) {
      // The log read still reports the kept bytes as missing from the object log.
      await fs.writeFile(s.indexPath, s.records.map(entry => `${JSON.stringify(entry)}\n`).join(""));
      expect(before.incomplete?.bytes).toBe(s.unrecovered.length);
      expect((await log(s)).incomplete).toEqual(before.incomplete);
    }
  }, 30_000);

  it("copy-mismatch names both hashes; copy-short names the journal end the record claims", async () => {
    const mismatch = await spill("custody-mismatch-row", false), short = await spill("custody-short-row", false);
    await plantSpillCustodyFault(mismatch, "copy-mismatch");
    await plantSpillCustodyFault(short, "copy-short");
    const range = mismatch.records[0]!;
    expect((await decide(mismatch.spillDir)).rows[0]).toMatchObject({ logRef: mismatch.logRef, journalStart: range.journalEnd,
      bytes: range.bytes, spillSha256: sha(await fs.readFile(mismatch.path)), journalSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await decide(short.spillDir)).rows[0]).toMatchObject({ logRef: short.logRef,
      journalEnd: short.records[0]!.journalEnd, recordedJournalEnd: short.records[0]!.journalEnd + short.records[0]!.bytes });
  }, 30_000);

  it("reads the recovered copy back from object storage, not from this process's read cache", async () => {
    const s = await spill("custody-read-cache", true);
    // This process has read the whole log: every object of it is in the journal read cache.
    expect((await readAll(newStore(s.m, s.spillDir), s.logRef)).equals(s.admitted)).toBe(true);
    expect(await decide(s.spillDir)).toEqual({ listed: [], guarded: false, rows: [] });
    for (const key of [...s.m.objects.keys()]) if (key.includes(`${s.logRef}/objects/`)) s.m.objects.delete(key);
    const row = expect.objectContaining({ spill: s.path, reason: "recovered_copy_unreadable",
      error: expect.objectContaining({ name: "NoSuchKey" }) });
    expect(await decide(s.spillDir)).toEqual({ listed: [s.logRef], guarded: true, rows: [row, row] });
  }, 30_000);

  it("control: a truly recovered spill whose read-back hashes equal is released", async () => {
    const s = await spill("custody-recovered", true);
    expect(await decide(s.spillDir)).toEqual({ listed: [], guarded: false, rows: [] });
  }, 30_000);

  it("control: two ranges spilled at one journal end are read back at their own offsets and released", async () => {
    const m = spillMemory(), spillDir = await fs.mkdtemp(path.join(os.tmpdir(), "objlog-spill-"));
    const store = newStore(m, spillDir);
    const handle = await store.begin({ ...ids, runId: "custody-two-ranges" });
    await store.append(handle, event(1, "stored"));
    m.state.down = true;
    const first = (await store.enqueue!(handle, event(2, "first refused batch"))).committed.catch(() => undefined);
    const flushing = store.flush!(handle).catch(() => undefined);
    // Admitted behind the failing flush (it is between retries): kept as its own batch, at the same journal end.
    await delay(20);
    const second = (await store.enqueue!(handle, event(3, "second refused batch"))).committed.catch(() => undefined);
    await flushing;
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    await store.finalize(handle);
    await Promise.all([first, second]);
    warning.mockRestore();
    const kept = await readObjectRunLogSpill(spillDir, handle.logRef);
    expect(kept.records.map(entry => [entry.event, entry.journalEnd])).toEqual([
      ["spilled", kept.records[0]!.journalEnd], ["spilled", kept.records[0]!.journalEnd]]);
    expect(await decide(spillDir)).toEqual({ listed: [handle.logRef], guarded: true, rows: [] });
    m.state.down = false;
    await newStore(m, spillDir).recoverSpill!({ ...ids, runId: "custody-two-ranges" });
    expect(await decide(spillDir)).toEqual({ listed: [], guarded: false, rows: [] });
  }, 30_000);

  it.each([
    ["an empty data file", ""],
    ["another tool's *.ndjson, holding no run-log record", `${JSON.stringify({ id: 1, stream: "orders", chunk: 7 })}\n`.repeat(3)],
  ])("control: %s with no record is not a spill", async (_case, contents) => {
    const spillDir = await fs.mkdtemp(path.join(os.tmpdir(), "objlog-spill-"));
    await fs.mkdir(path.join(spillDir, "company", "agent"), { recursive: true });
    await fs.writeFile(path.join(spillDir, "company", "agent", "run.ndjson"), contents);
    expect(await decide(spillDir)).toEqual({ listed: [], guarded: false, rows: [] });
  });

  it("run-log bytes with no record are kept even when their first write was torn", async () => {
    const spillDir = await fs.mkdtemp(path.join(os.tmpdir(), "objlog-spill-"));
    const file = path.join(spillDir, "company", "agent", "run.ndjson");
    await fs.mkdir(path.dirname(file), { recursive: true });
    // A torn first append, then the retried record: the writer never truncates.
    await fs.writeFile(file, Buffer.concat([record("attempt", 1, "torn").subarray(0, 20), record("attempt", 1, "the only copy")]));
    const row = expect.objectContaining({ spill: file, reason: "index_missing" });
    expect(await decide(spillDir)).toEqual({ listed: ["company/agent/run"], guarded: true, rows: [row, row] });
  });
});
