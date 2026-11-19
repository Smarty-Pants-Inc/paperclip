import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { createObjectRunLogStore, readObjectRunLogSpill } from "./object-run-log-store.js";
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
      const body = Buffer.isBuffer(i.body) ? i.body : Buffer.concat(await Array.fromAsync(i.body as AsyncIterable<Buffer>));
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
    console.info("custody-row", JSON.stringify({ step, fault, persistent, admitted: all.length, stored: stored.length,
      spilled: spill.unrecovered.length, summary, fired: m.injection.fired, head: storedHead(m, handle.logRef).closed,
      incomplete: warning.mock.calls.length, diagnostics: diagnostics.map(([value, message]) => [value, message]) }));
    return { m, store, handle, spillDir, all, stored, spill, summary, diagnostics, receipts: await Promise.all(receipts),
      incomplete: warning.mock.calls.length, runId };
  } finally { warning.mockRestore(); }
}

describe("object run log custody across flush / close / finalize failures", () => {
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
});
