import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { createObjectRunLogStore, readObjectRunLogSpill, OBJECT_RUN_LOG_FINALIZE_ADMISSION_TIMEOUT_MS } from "./object-run-log-store.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7002475364 (rf-3)
// Keep reason: NEVER-OK trace custody. Admitted run-log bytes must survive a
// failed flush or close: stored in the object journal, or kept in a named
// local spill that is never deleted. These rows drive the PRODUCTION store and
// journal; the only fake is the storage provider, with a named injection.

type Put = Parameters<NonNullable<StorageProvider["putObjectConditional"]>>[0];
type Step = "first-flush" | "second-flush" | "close";
type Fault = "EIO" | "ECONNRESET";
const SECRET = "private-run-log-content";

async function readBody(body: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const bytes of body) chunks.push(Buffer.from(bytes));
  return Buffer.concat(chunks);
}

function memory() {
  const objects = new Map<string, Buffer>();
  const etag = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  // Named injection at the storage seam. A step is recognised from the PUT
  // stream alone: a payload PUT belongs to flush N+1 after N head publications
  // since arming; "close" is the head PUT that sets closed=true.
  const injection = { step: undefined as Step | undefined, fault: "EIO" as Fault, persistent: false,
    fired: 0, heads: 0, gate: undefined as Promise<void> | undefined, entered: false };
  const provider: StorageProvider = {
    id: "s3",
    async putObject() { throw Error("unconditional"); },
    async putObjectConditional(i: Put) {
      const body = Buffer.isBuffer(i.body) ? i.body : await readBody(i.body);
      const isHead = i.objectKey.endsWith("/head.json");
      if (!isHead && injection.gate && !injection.entered) { injection.entered = true; await injection.gate; }
      const closing = isHead && JSON.parse(body.toString()).closed === true;
      const at: Step | undefined = closing ? "close"
        : isHead ? undefined : injection.heads === 0 ? "first-flush" : injection.heads === 1 ? "second-flush" : undefined;
      if (injection.step && at === injection.step && (injection.persistent || injection.fired === 0)) {
        injection.fired++;
        throw Object.assign(new Error(`${injection.fault}: ${SECRET}`), { code: injection.fault, responseBody: SECRET });
      }
      const old = objects.get(i.objectKey);
      if (i.ifNoneMatch ? old : !old || etag(old) !== i.ifMatch)
        throw Object.assign(Error("conflict"), { name: "PreconditionFailed" });
      objects.set(i.objectKey, Buffer.from(body));
      if (isHead && injection.step) injection.heads++;
      return { etag: etag(body) };
    },
    async getObject(i) {
      const b = objects.get(i.objectKey);
      if (!b) throw Object.assign(Error("missing"), { name: "NoSuchKey" });
      return { stream: Readable.from([b]), etag: etag(b) };
    },
    async headObject(i) { return { exists: objects.has(i.objectKey) }; },
    async deleteObject(i) { objects.delete(i.objectKey); },
    async listObjects(i) { return { keys: [...objects.keys()].filter((k) => k.startsWith(i.prefix)) }; },
  };
  return { provider, objects, injection };
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const record = (attemptId: string | undefined, seq: number, chunk: string) => Buffer.from(
  `${JSON.stringify({ ts: "2026-11-19T00:00:00Z", attemptId, stream: "stdout", chunk, seq })}\n`);
const event = (seq: number, chunk: string) => ({ stream: "stdout" as const, chunk, ts: "2026-11-19T00:00:00Z", seq });

/** A cold reader: a NEW store over the same objects, with no writer state. */
async function coldRead(m: ReturnType<typeof memory>, logRef: string) {
  const reader = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", assertWriterAuthority: async () => undefined });
  const parts: Buffer[] = [];
  for (let offset = 0; ;) {
    const page = await reader.read({ store: "s3_segments", logRef }, { offset, limitBytes: 1024 * 1024 });
    parts.push(Buffer.from(page.content));
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  return Buffer.concat(parts);
}
const storedHead = (m: ReturnType<typeof memory>, logRef: string) =>
  JSON.parse(m.objects.get(`logs/segments-v1/${logRef}/head.json`)!.toString());

/**
 * One run through the production store with the named fault armed at `step`.
 * first-flush / close: one committed record, then one admitted record pending
 * when finalize starts. second-flush: a record admitted during finalize (it
 * waited on capacity behind the first flush), so it rides the second flush.
 */
async function run(step: Step, fault: Fault, persistent: boolean) {
  const m = memory(), spillDir = mkdtempSync(path.join(os.tmpdir(), "objlog-spill-"));
  const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000, spillDir,
    assertWriterAuthority: async () => undefined });
  const runId = `custody-${step}-${fault}-${persistent ? "persistent" : "once"}`;
  const handle = await store.begin({ companyId: "company", agentId: "agent", runId });
  const admitted: Buffer[] = [], receipts: Array<Promise<unknown>> = [];
  const enqueue = async (seq: number, chunk: string) => {
    const receipt = await store.enqueue!(handle, event(seq, chunk));
    admitted.push(record(handle.attemptId, seq, chunk));
    receipts.push(receipt.committed.catch((error: unknown) => error));
  };
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  vi.mocked(logger.warn).mockClear();
  let summary;
  try {
    if (step === "second-flush") {
      let release!: () => void;
      m.injection.gate = new Promise<void>(resolve => { release = resolve; });
      Object.assign(m.injection, { step, fault, persistent });
      await enqueue(1, "a".repeat(7 * 1024 * 1024));
      await vi.waitFor(() => expect(m.injection.entered).toBe(true));
      const waiting = enqueue(2, `${SECRET}-${"b".repeat(2 * 1024 * 1024)}`);
      const finalizing = store.finalize(handle);
      release();
      [summary] = await Promise.all([finalizing, waiting]);
    } else {
      await enqueue(1, `${SECRET}-1`);
      await store.flush!(handle);
      Object.assign(m.injection, { step, fault, persistent });
      await enqueue(2, `${SECRET}-2`);
      summary = await store.finalize(handle);
    }
    const all = Buffer.concat(admitted), stored = await coldRead(m, handle.logRef);
    const spill = await readObjectRunLogSpill(spillDir, handle.logRef);
    const diagnostics = vi.mocked(logger.warn).mock.calls;
    // Evidence for a reviewer: one JSON line per row, written only when asked for.
    if (process.env.OBJLOG_CUSTODY_EVIDENCE) appendFileSync(process.env.OBJLOG_CUSTODY_EVIDENCE, `${JSON.stringify({
      step, fault, persistent, admitted: all.length, stored: stored.length, spilled: spill.unrecovered.length,
      equal: Buffer.concat([stored, spill.unrecovered]).equals(all), summary, fired: m.injection.fired,
      closed: storedHead(m, handle.logRef).closed, incomplete: warning.mock.calls.length, diagnostics })}\n`);
    return { m, store, handle, spillDir, all, stored, spill, summary, diagnostics, receipts: await Promise.all(receipts),
      incomplete: warning.mock.calls.length, runId };
  } finally { warning.mockRestore(); }
}

describe("object run log custody across flush / close / finalize failures", () => {
  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7003907357
  // NEVER-OK: the deadline releases the run, NOT its admitted log bytes.
  it("bounds finalize admission with 8 peers holding memory after object AND spill writes fail", async () => {
    const boundMs = OBJECT_RUN_LOG_FINALIZE_ADMISSION_TIMEOUT_MS;
    const m = memory(), spillDir = mkdtempSync(path.join(os.tmpdir(), "objlog-finalize-bound-"));
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", spillDir,
      assertWriterAuthority: async () => undefined });
    const peers = [], expected: Buffer[] = [], receipts: Array<Promise<unknown>> = [];
    const targetAbort = new AbortController();
    for (let n = 0; n < 8; n++)
      peers.push(await store.begin({ companyId: "company", agentId: "agent", runId: `capacity-peer-${n}` }));
    const target = await store.begin({ companyId: "company", agentId: "agent", runId: "capacity-target", signal: targetAbort.signal });
    const open = fs.open.bind(fs);
    // Named spill-writer injection: no bytes or index record can reach the local disk.
    const spillWriteENOSPC = vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).startsWith(spillDir) && args[1] === "a")
        return Promise.reject(Object.assign(new Error(SECRET), { code: "ENOSPC" }));
      return open(...args);
    });
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let waiting: Promise<unknown> | undefined, finalizing: ReturnType<typeof store.finalize> | undefined;
    let observed: { summary?: Awaited<ReturnType<typeof store.finalize>>; settled: boolean } = { settled: false };
    let diagnostics: unknown[] = [], errors: unknown[] = [], waitingResult: unknown;
    try {
      // Named storage-provider injection: every immutable payload PUT fails EIO.
      Object.assign(m.injection, { step: "first-flush", fault: "EIO", persistent: true });
      for (const peer of peers) {
        const chunk = "x".repeat(8 * 1024 * 1024 - 512);
        expected.push(record(peer.attemptId, 1, chunk));
        receipts.push((await store.enqueue!(peer, event(1, chunk))).committed.catch(error => error));
      }
      await store.flushInflightMirrors!().catch(error => error);
      expect((await Promise.all(receipts)).every(value => value instanceof Error)).toBe(true);
      expect(spillWriteENOSPC).toHaveBeenCalled();
      vi.mocked(logger.warn).mockClear();
      vi.mocked(logger.error).mockClear();
      // Only the admission timer is virtual: the production journal and real
      // spill writer above have finished failing before the clock advances.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let admitted = false, admissionSettled = false;
      waiting = store.enqueue!(target, event(1, "y".repeat(8192)))
        .then(receipt => { admitted = true; return receipt.committed; })
        .catch(error => error).then(value => { admissionSettled = true; return value; });
      finalizing = store.finalize(target).then(summary => { observed = { summary, settled: true }; return summary; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(admitted).toBe(false);
      expect(observed.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(boundMs - 1);
      expect(observed.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // The deadline has fired; source-less refusal now performs real disk I/O
      // before acknowledging custody. Let that I/O finish without advancing the
      // admission deadline (the -1 ms assertion above still protects the bound).
      vi.useRealTimers();
      await vi.waitFor(() => expect(observed.settled).toBe(true), { timeout: 2000 });
      const settledAtBound = observed.settled;
      diagnostics = [...vi.mocked(logger.warn).mock.calls];
      errors = [...vi.mocked(logger.error).mock.calls];
      const snapshot = { ...observed };
      if (admissionSettled) waitingResult = await waiting;
      if (process.env.OBJLOG_CUSTODY_EVIDENCE) appendFileSync(process.env.OBJLOG_CUSTODY_EVIDENCE,
        `${JSON.stringify({ row: "finalize-admission-bound", peers: peers.length, boundMs, elapsedMs: boundMs,
          heldBytes: expected.reduce((sum, bytes) => sum + bytes.length, 0), settledAtBound, ...snapshot, admissionSettled,
          admitted, diagnostics, errors })}\n`);
      // No-bound mutation: the bounded wait above cannot finish. No bytes may be discarded.
      expect(snapshot.settled).toBe(true);
      expect(settledAtBound).toBe(true);
      expect(snapshot.summary).toEqual({ bytes: null, sha256: null, compressed: false });
      expect(admissionSettled).toBe(true);
      expect(waitingResult).toMatchObject({ code: "object_run_log_finalize_admission_timeout" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("persistence is incomplete"));
      const refusedBytes = record(target.attemptId, 1, "y".repeat(8192));
      const readWhileHeld = await store.read({ store: target.store, logRef: target.logRef });
      expect(readWhileHeld).toMatchObject({ content: "", incomplete: { bytes: refusedBytes.length,
        causes: [{ code: "object_run_log_finalize_admission_timeout" }] } });
      expect(diagnostics).toEqual(expect.arrayContaining([
        [expect.objectContaining({ runId: "capacity-target", step: "admissions",
          err: expect.objectContaining({ code: "object_run_log_finalize_admission_timeout" }),
          capacity: { location: "memory", stored: false, spilled: false,
            bytes: expected.reduce((sum, bytes) => sum + bytes.length, 0) + record(target.attemptId, 1, "y".repeat(8192)).length,
            writers: [...peers.map(peer => ({ runId: peer.logRef.split("/")[2], bytes: expected[0]!.length,
              storageError: expect.objectContaining({ code: "EIO" }), spillError: expect.objectContaining({ code: "ENOSPC" }) })),
              { runId: "capacity-target", bytes: record(target.attemptId, 1, "y".repeat(8192)).length,
                storageError: expect.objectContaining({ code: "object_run_log_finalize_admission_timeout" }),
                spillError: expect.objectContaining({ code: "ENOSPC" }) }], },
        }), "Object run log finalization failed"],
      ]));
      expect(JSON.stringify([diagnostics, errors])).not.toContain(SECRET);
    } finally {
      // Release ONLY this row's target admission; the peers' admitted bytes are
      // kept. Healing storage then proves all 8 complete streams survived.
      if (!observed.settled) targetAbort.abort(new Error("row cleanup"));
      if (waiting) await waiting;
      if (finalizing) await finalizing;
      vi.useRealTimers();
      spillWriteENOSPC.mockRestore();
      m.injection.step = undefined;
      try {
        await store.flushInflightMirrors!();
        expect((await coldRead(m, target.logRef)).equals(record(target.attemptId, 1, "y".repeat(8192)))).toBe(true);
        for (let n = 0; n < peers.length; n++)
          expect((await coldRead(m, peers[n]!.logRef)).equals(expected[n]!)).toBe(true);
        await Promise.all(peers.map(peer => store.finalize(peer)));
      } finally { warning.mockRestore(); }
    }
  }, 30_000);

  it("finalizes normally with one healthy peer holding capacity", async () => {
    const m = memory(), spillDir = mkdtempSync(path.join(os.tmpdir(), "objlog-finalize-control-"));
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", spillDir,
      assertWriterAuthority: async () => undefined });
    const peer = await store.begin({ companyId: "company", agentId: "agent", runId: "healthy-peer" });
    const target = await store.begin({ companyId: "company", agentId: "agent", runId: "healthy-target" });
    const peerChunk = "x".repeat(8 * 1024 * 1024 - 512);
    const peerReceipt = (await store.enqueue!(peer, event(1, peerChunk))).committed;
    const receipt = (await store.enqueue!(target, event(1, "healthy"))).committed;
    const result = await store.finalize(target);
    const bytes = record(target.attemptId, 1, "healthy");
    expect(result).toEqual({ bytes: bytes.length, sha256: sha(bytes), compressed: false });
    expect(await receipt).toBe(bytes.length);
    await peerReceipt;
    await store.finalize(peer);
    expect((await coldRead(m, target.logRef)).equals(bytes)).toBe(true);
  }, 30_000);

  it.each(["first-flush", "second-flush", "close"] as const)("EIO once at %s: the re-read log is the admitted bytes, size and sha set", async step => {
    const r = await run(step, "EIO", false);
    expect(r.m.injection.fired).toBe(1);
    expect(r.stored.equals(r.all)).toBe(true);
    expect(r.summary).toEqual({ bytes: r.all.length, sha256: sha(r.all), compressed: false });
    expect(storedHead(r.m, r.handle.logRef).closed).toBe(true);
    expect(r.spill.unrecovered.length).toBe(0);
    expect(r.incomplete).toBe(0);
    // Every admitted record was acknowledged as committed, none rejected.
    expect(r.receipts.every(value => typeof value === "number")).toBe(true);
    // The retried failure is visible, with its cause, and content-free.
    expect(r.diagnostics).toEqual(expect.arrayContaining([[expect.objectContaining({ runId: r.runId,
      step: step === "close" ? "close" : "flush", attempt: 1, maxAttempts: 3,
      err: expect.objectContaining({ code: "EIO" }) }), expect.any(String)]]));
    expect(JSON.stringify(r.diagnostics)).not.toContain(SECRET);
  }, 30_000);

  it.each(["first-flush", "second-flush"] as const)("EIO persistent at %s: stored object + kept spill == admitted, failure and cause recorded", async step => {
    const r = await run(step, "EIO", true);
    expect(r.m.injection.fired).toBeGreaterThanOrEqual(3);
    // NOTHING lost: the object store holds a prefix, the kept spill the rest.
    expect(r.spill.unrecovered.length).toBeGreaterThan(0);
    expect(Buffer.concat([r.stored, r.spill.unrecovered]).equals(r.all)).toBe(true);
    // The spill is a named, kept file next to the run, with a record of which bytes it holds.
    expect(r.spill.path).toBe(path.join(r.spillDir, `${r.handle.logRef}.ndjson`));
    expect(existsSync(r.spill.path)).toBe(true);
    expect(readFileSync(r.spill.path).subarray(-r.spill.unrecovered.length).equals(r.spill.unrecovered)).toBe(true);
    const spilled = r.spill.records.filter(entry => entry.event === "spilled");
    expect(spilled.length).toBeGreaterThan(0);
    expect(spilled[0]).toMatchObject({ v: 1, logRef: r.handle.logRef, journalEnd: r.stored.length, spillStart: 0,
      cause: expect.objectContaining({ code: "EIO" }) });
    expect(spilled.reduce((sum, entry) => sum + entry.bytes, 0)).toBe(r.spill.unrecovered.length);
    expect(JSON.stringify(r.spill.records)).not.toContain(SECRET);
    // The failure is visible: unknown final size, the head left open, the cause and the spill logged.
    expect(r.summary).toEqual({ bytes: null, sha256: null, compressed: false });
    expect(storedHead(r.m, r.handle.logRef).closed).toBe(false);
    expect(r.incomplete).toBe(1);
    expect(r.receipts.at(-1)).toBeInstanceOf(Error);
    expect(r.diagnostics).toEqual(expect.arrayContaining([
      [expect.objectContaining({ runId: r.runId, step: "flush", err: expect.objectContaining({ code: "EIO" }),
        spill: expect.objectContaining({ path: r.spill.path, bytes: r.spill.unrecovered.length }) }),
        "Object run log finalization failed"],
    ]));
    expect(JSON.stringify(r.diagnostics)).not.toContain(SECRET);
    // No payload or index object was deleted by the failure path.
    expect([...r.m.objects.keys()].some(key => key.includes("/objects/"))).toBe(true);
  }, 30_000);

  it("EIO persistent at close: every byte stays stored, the head stays open, the cause is recorded", async () => {
    const r = await run("close", "EIO", true);
    expect(r.m.injection.fired).toBe(3);
    expect(r.stored.equals(r.all)).toBe(true);
    expect(r.spill.unrecovered.length).toBe(0);
    expect(r.summary).toEqual({ bytes: null, sha256: null, compressed: false });
    expect(storedHead(r.m, r.handle.logRef)).toMatchObject({ closed: false, end: r.all.length });
    expect(r.incomplete).toBe(1);
    expect(r.diagnostics.at(-1)).toEqual([expect.objectContaining({ runId: r.runId, step: "close", attempt: 3,
      maxAttempts: 3, err: expect.objectContaining({ code: "EIO" }) }), "Object run log finalization failed"]);
    expect(JSON.stringify(r.diagnostics)).not.toContain(SECRET);
  }, 30_000);

  it.each(["first-flush", "second-flush", "close"] as const)("ECONNRESET once at %s still recovers through the journal's own retries", async step => {
    const r = await run(step, "ECONNRESET", false);
    expect(r.m.injection.fired).toBe(1);
    expect(r.stored.equals(r.all)).toBe(true);
    expect(r.summary).toEqual({ bytes: r.all.length, sha256: sha(r.all), compressed: false });
    expect(r.spill.unrecovered.length).toBe(0);
    expect(existsSync(r.spill.path)).toBe(false);
    expect(r.diagnostics).toEqual([]);
  }, 30_000);

  it("a later flush retries the kept batch first, then finalize is complete; the spill is kept and marked recovered", async () => {
    const m = memory(), spillDir = mkdtempSync(path.join(os.tmpdir(), "objlog-spill-"));
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000, spillDir,
      assertWriterAuthority: async () => undefined });
    const handle = await store.begin({ companyId: "company", agentId: "agent", runId: "custody-later-flush" });
    await store.append(handle, event(1, "one"));
    Object.assign(m.injection, { step: "first-flush", fault: "EIO", persistent: true });
    const second = (await store.enqueue!(handle, event(2, "two"))).committed.catch((error: unknown) => error);
    await expect(store.flush!(handle)).rejects.toMatchObject({ code: "EIO" });
    expect(await second).toBeInstanceOf(Error);
    const all = Buffer.concat([record(handle.attemptId, 1, "one"), record(handle.attemptId, 2, "two")]);
    const kept = await readObjectRunLogSpill(spillDir, handle.logRef);
    expect(Buffer.concat([await coldRead(m, handle.logRef), kept.unrecovered]).equals(all)).toBe(true);
    const spilledFile = readFileSync(kept.path);
    // The store heals. The kept batch goes first, so order is preserved.
    m.injection.step = undefined;
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      expect(await store.finalize(handle)).toEqual({ bytes: all.length, sha256: sha(all), compressed: false });
      expect(warning).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
    expect((await coldRead(m, handle.logRef)).equals(all)).toBe(true);
    const after = await readObjectRunLogSpill(spillDir, handle.logRef);
    expect(after.unrecovered.length).toBe(0);
    expect(after.records.map(entry => entry.event)).toEqual(["spilled", "recovered"]);
    // Recovery never deletes or truncates the kept spill.
    expect(readFileSync(kept.path).equals(spilledFile)).toBe(true);
  }, 30_000);
  it("keeps the bytes with the writer when the local spill is refused too, and stores them at the next flush", async () => {
    const m = memory(), blocked = path.join(mkdtempSync(path.join(os.tmpdir(), "objlog-spill-")), "not-a-directory");
    writeFileSync(blocked, "");
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000, spillDir: blocked,
      assertWriterAuthority: async () => undefined });
    const handle = await store.begin({ companyId: "company", agentId: "agent", runId: "custody-no-spill" });
    await store.append(handle, event(1, "one"));
    Object.assign(m.injection, { step: "first-flush", fault: "EIO", persistent: true });
    // Two records: the second is admitted behind the failing batch's flush.
    const receipts = [(await store.enqueue!(handle, event(2, "two"))).committed.catch((error: unknown) => error)];
    const flushing = store.flush!(handle).catch((error: unknown) => error);
    receipts.push((await store.enqueue!(handle, event(3, "three"))).committed.catch((error: unknown) => error));
    expect(await flushing).toMatchObject({ code: "EIO" });
    const all = Buffer.concat([1, 2, 3].map(seq => record(handle.attemptId, seq, ["one", "two", "three"][seq - 1]!)));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
    try {
      expect(await store.finalize(handle)).toEqual({ bytes: null, sha256: null, compressed: false });
      expect((await Promise.all(receipts)).every(value => value instanceof Error)).toBe(true);
      // Neither store took the bytes: that is said out loud, and the writer is not released.
      expect(vi.mocked(logger.warn).mock.calls.at(-1)).toEqual([expect.objectContaining({ step: "flush",
        unspilledBytes: all.length - (await coldRead(m, handle.logRef)).length }), "Object run log finalization failed"]);
      expect(vi.mocked(logger.error).mock.calls.some(([value]) => (value as { step?: string }).step === "spill")).toBe(true);
      // Object storage heals. The shutdown flush stores the held bytes, in admitted order.
      m.injection.step = undefined;
      await store.flushInflightMirrors!();
      expect((await coldRead(m, handle.logRef)).equals(all)).toBe(true);
      await expect(store.flush!(handle)).rejects.toThrow("writer not found");
    } finally { warning.mockRestore(); }
  }, 30_000);
});
