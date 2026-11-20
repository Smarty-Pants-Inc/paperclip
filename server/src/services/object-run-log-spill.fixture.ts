import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { parse as parseEnv } from "dotenv";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { createObjectRunLogStore, readObjectRunLogSpill, type ObjectRunLogSpillRecord } from "./object-run-log-store.js";

// Fixture for the run-log spill rows: the PRODUCTION object store and journal
// over an in-memory provider whose payload PUTs fail with EIO while `down`.

type Put = Parameters<NonNullable<StorageProvider["putObjectConditional"]>>[0];
export function spillMemory() {
  const objects = new Map<string, Buffer>();
  const etag = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const state = { down: false, payloadPuts: 0,
    /** Payload PUTs larger than this fail with EIO (a store that takes only part of a recovery). */
    maxPayloadBytes: Infinity,
    /** While set, the next payload PUT waits here first; `held` says it has arrived. */
    hold: undefined as Promise<void> | undefined, held: false };
  const provider: StorageProvider = {
    id: "s3",
    async putObject() { throw Error("unconditional"); },
    async putObjectConditional(i: Put) {
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(i.body)) chunks.push(i.body);
      else for await (const bytes of i.body) chunks.push(Buffer.from(bytes));
      const body = Buffer.concat(chunks), isHead = i.objectKey.endsWith("/head.json");
      if (!isHead && state.hold) { state.held = true; await state.hold; }
      if (!isHead && (state.down || body.length > state.maxPayloadBytes)) throw Object.assign(new Error("EIO"), { code: "EIO" });
      const old = objects.get(i.objectKey);
      if (i.ifNoneMatch ? old : !old || etag(old) !== i.ifMatch)
        throw Object.assign(Error("conflict"), { name: "PreconditionFailed" });
      objects.set(i.objectKey, body);
      if (!isHead) state.payloadPuts++;
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
  return { provider, objects, state };
}
export const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const record = (attemptId: string | undefined, seq: number, chunk: string) => Buffer.from(
  `${JSON.stringify({ ts: "2026-11-19T00:00:00Z", attemptId, stream: "stdout", chunk, seq })}\n`);
export const event = (seq: number, chunk: string) => ({ stream: "stdout" as const, chunk, ts: "2026-11-19T00:00:00Z", seq });
export const ids = { companyId: "company", agentId: "agent" };

// Real writer, with the same process env a guest loads from its worktree .env.
// The cleanup server then sees its original env, not the guest's old root.
export async function contentSpill(workspacePath: string, candidate: string,
  mode: "guest" | "drift" | "unreadable" | "recovered", recover = mode === "recovered") {
  const envPath = path.join(workspacePath, ".env");
  const guestHome = path.join(candidate, "guest-home");
  const oldRoot = path.join(candidate, ...Array.from({ length: 16 }, (_, i) => `depth-${i}`), "old-root");
  await fs.writeFile(envPath, mode === "guest"
    ? `PAPERCLIP_HOME=${JSON.stringify(guestHome)}\nPAPERCLIP_INSTANCE_ID=guest\n`
    : `RUN_LOG_SPILL_PATH=${JSON.stringify(oldRoot)}\n`);
  const keys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "RUN_LOG_SPILL_PATH", "RUN_LOG_BASE_PATH"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const env = parseEnv(await fs.readFile(envPath, "utf8"));
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    const m = spillMemory();
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000,
      assertWriterAuthority: async () => undefined });
    // A run of its own: no other store of this process holds a log under this name.
    const run = { companyId: "build", agentId: "node_modules", runId: `content-custody-${randomUUID()}` };
    const handle = await store.begin(run);
    m.state.down = true;
    const receipt = await store.enqueue!(handle, event(1, "source-less bytes: the spill is the ONLY copy"));
    const settled = receipt.committed.catch(() => undefined);
    await store.finalize(handle);
    await settled;
    const root = mode === "guest" ? path.join(guestHome, "instances/guest/data/run-logs/.spill") : oldRoot;
    if (recover) {
      m.state.down = false;
      await store.recoverSpill!(run);
    }
    const spill = await readObjectRunLogSpill(root, handle.logRef);
    const bytes = await fs.readFile(spill.path), index = await fs.readFile(spill.indexPath);
    if (mode !== "guest") await fs.writeFile(envPath, `PAPERCLIP_HOME=${JSON.stringify(path.join(workspacePath, "different-home"))}\n`);
    if (mode === "unreadable") await fs.chmod(spill.indexPath, 0);
    return { ...spill, bytes, index, m, logRef: handle.logRef };
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
// OBJLOG_MUTATION=recovery-off is the mutation row: the spill upload is turned off and these rows go red.
const recoverSpill = process.env.OBJLOG_MUTATION === "recovery-off" ? false : undefined;
export const newStore = (m: ReturnType<typeof spillMemory>, spillDir: string) => createObjectRunLogStore({
  provider: m.provider, keyPrefix: "logs", flushMs: 1000, spillDir, recoverSpill,
  // As getRunLogStore wires it: the caller's own authority check decides.
  assertWriterAuthority: async input => { await input.assertWriterAuthority?.(); } });
export async function readAll(store: ReturnType<typeof newStore>, logRef: string) {
  const parts: Buffer[] = [];
  for (let offset = 0; ;) {
    const page = await store.read({ store: "s3_segments", logRef }, { offset, limitBytes: 64 });
    parts.push(Buffer.from(page.content));
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  return Buffer.concat(parts);
}
/** One settled run: record 1 stored, storage then refuses record 2 and 3 for good; finalize spills them. */
export async function spilledRun(runId: string, binding: { companyId: string; agentId: string } = ids) {
  const ids = binding;
  const m = spillMemory(), spillDir = mkdtempSync(path.join(os.tmpdir(), "objlog-spill-"));
  const store = newStore(m, spillDir);
  const handle = await store.begin({ ...ids, runId });
  await store.append(handle, event(1, "one"));
  m.state.down = true;
  const refused = [2, 3].map(async seq => (await store.enqueue!(handle, event(seq, `refused-${seq}`))).committed.catch(() => undefined));
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  let summary;
  try { summary = await store.finalize(handle); } finally { warning.mockRestore(); }
  await Promise.all(refused);
  const admitted = Buffer.concat([record(handle.attemptId, 1, "one"),
    record(handle.attemptId, 2, "refused-2"), record(handle.attemptId, 3, "refused-3")]);
  return { m, spillDir, handle, summary, admitted, logRef: handle.logRef };
}


// Custody rows (rf-7 OBJLOG9 F1; RFL bar 11-19): every fault is PLANTED and NAMED
// here, on a REAL writer's spill. `recovered: false` faults sit beside bytes no
// store ever took; `recovered: true` faults sit beside a real recovery. `reason`
// is what the custody row must name.
export const SPILL_CUSTODY_FAULTS = {
  "index-empty": { recovered: false, reason: "index_empty" },
  "index-object": { recovered: false, reason: "index_invalid_record" },
  "index-array": { recovered: false, reason: "index_invalid_record" },
  "index-absent": { recovered: false, reason: "index_missing" },
  "data-no-entry": { recovered: true, reason: "data_without_index_entry" },
  "copy-mismatch": { recovered: false, reason: "recovered_copy_mismatch" },
  "copy-short": { recovered: false, reason: "recovered_copy_short" },
  "copy-missing": { recovered: true, reason: "recovered_copy_missing" },
  "copy-unreadable": { recovered: true, reason: "recovered_copy_unreadable" },
} as const;
export type SpillCustodyFault = keyof typeof SPILL_CUSTODY_FAULTS;
export const spillCustodyFaults = Object.keys(SPILL_CUSTODY_FAULTS) as SpillCustodyFault[];
export const SPILL_CUSTODY_ROW = "kept: run-log spill custody unknown";

/** Plant one named fault. Returns the planted files' bytes: exactly what custody must keep. */
export async function plantSpillCustodyFault(spill: { path: string; indexPath: string;
  records: ObjectRunLogSpillRecord[]; logRef: string; m: ReturnType<typeof spillMemory> }, fault: SpillCustodyFault) {
  const { m } = spill, journal = `logs/segments-v1/${spill.logRef}/`;
  // A `recovered` record in the writer's exact shape, for a recovery no store performed.
  const claimRecovered = () => fs.appendFile(spill.indexPath, spill.records.filter(entry => entry.event === "spilled")
    .map(({ sequence: _sequence, sourceCursor: _sourceCursor, cause: _cause, ...entry }) =>
      `${JSON.stringify({ ...entry, event: "recovered", journalEnd: entry.journalEnd + entry.bytes })}\n`).join(""));
  if (fault === "index-empty") await fs.writeFile(spill.indexPath, "");
  if (fault === "index-object") await fs.writeFile(spill.indexPath, "{}\n");
  if (fault === "index-array") await fs.writeFile(spill.indexPath, "[]\n");
  if (fault === "index-absent") await fs.unlink(spill.indexPath);
  // A torn record append: admitted bytes on disk that no index record points at.
  if (fault === "data-no-entry") await fs.appendFile(spill.path, record(undefined, 99, "admitted, never indexed"));
  // The record claims a journal end the object log never reached.
  if (fault === "copy-short") await claimRecovered();
  if (fault === "copy-mismatch") {
    // A later attempt that did not adopt the spill stored OTHER bytes at its journal range.
    m.state.down = false;
    const other = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", recoverSpill: false,
      assertWriterAuthority: async () => undefined });
    const [companyId, agentId, runId] = spill.logRef.split("/") as [string, string, string];
    const handle = await other.begin({ companyId, agentId, runId });
    await other.append(handle, event(1, `other bytes at the spill's journal range ${"x".repeat(1024)}`));
    await other.finalize(handle);
    await claimRecovered();
  }
  // Object storage lost the whole log after the recovery was recorded.
  if (fault === "copy-missing") for (const key of [...m.objects.keys()]) if (key.startsWith(journal)) m.objects.delete(key);
  if (fault === "copy-unreadable") {
    const getObject = m.provider.getObject;
    m.provider.getObject = async input => {
      if (input.objectKey.startsWith(`${journal}objects/`)) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return getObject(input);
    };
  }
  return { reason: SPILL_CUSTODY_FAULTS[fault].reason, bytes: await fs.readFile(spill.path),
    index: await fs.readFile(spill.indexPath).catch(() => null) };
}
/** contentSpill (a root only the content guard finds) with one named custody fault planted on it. */
export async function custodySpill(workspacePath: string, candidate: string, fault: SpillCustodyFault) {
  const spill = await contentSpill(workspacePath, candidate, "drift", SPILL_CUSTODY_FAULTS[fault].recovered);
  return { ...spill, ...await plantSpillCustodyFault(spill, fault) };
}

// Guard-pass rows (RFL rulings 11-20). `count` settled runs of ONE store at
// `spillDir`, each spilled by the real writer while storage refused its bytes
// and then genuinely recovered: every record names its bytes recovered and the
// object log holds them. One store only, so one journal reads each copy back.
export async function recoveredSpills(spillDir: string, count: number) {
  const m = spillMemory(), store = newStore(m, spillDir);
  // Each row owns distinct log references; stores from earlier rows cannot prove or contradict its bytes.
  const batch = randomUUID();
  const runs = Array.from({ length: count }, (_, n) => ({ ...ids, runId: `recovered-${batch}-${String(n).padStart(2, "0")}` }));
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  try {
    const handles = await Promise.all(runs.map(run => store.begin(run)));
    await Promise.all(handles.map(handle => store.append(handle, event(1, "stored before the outage"))));
    m.state.down = true;
    const refused = await Promise.all(handles.map(async (handle, n) =>
      (await store.enqueue!(handle, event(2, `refused ${n}: for a while the spill was the only copy`))).committed.catch(() => undefined)));
    await Promise.all(handles.map(handle => store.finalize(handle)));
    await Promise.all(refused);
    m.state.down = false;
    for (const run of runs) await store.recoverSpill!(run);
    const spills = await Promise.all(handles.map(async handle => {
      const spill = await readObjectRunLogSpill(spillDir, handle.logRef);
      return { logRef: handle.logRef, path: spill.path, indexPath: spill.indexPath, unrecoveredBytes: spill.unrecovered.length,
        bytes: await fs.readFile(spill.path), index: await fs.readFile(spill.indexPath), log: await readAll(store, handle.logRef) };
    }));
    return { m, store, spills };
  } finally { warning.mockRestore(); }
}
/**
 * PLANTED store fault "store-hung": from now on no GET of this object store
 * answers. Each ends only when its caller gives up: at the journal's own read
 * deadline (15 s), or when the guard pass's read-back budget ends. `heal`
 * makes the store answer again, the GETs still waiting included.
 */
export function plantHungStore(m: ReturnType<typeof spillMemory>) {
  const getObject = m.provider.getObject, waiting = new Set<() => void>();
  // The store's own clock: when the first GET went unanswered, and when a caller last gave up on one.
  const state = { hung: true, unansweredGets: 0, firstGetAt: 0, lastGiveUpAt: 0 };
  m.provider.getObject = async input => {
    if (state.hung) {
      state.unansweredGets++;
      state.firstGetAt ||= Date.now();
      await new Promise<void>((resolve, reject) => {
        waiting.add(resolve);
        input.signal?.addEventListener("abort", () => {
          waiting.delete(resolve);
          state.lastGiveUpAt = Date.now();
          reject(input.signal!.reason);
        }, { once: true });
      });
    }
    return getObject(input);
  };
  return { state, heal: () => {
    state.hung = false;
    for (const answer of waiting) answer();
    waiting.clear();
  } };
}
/** The custody rows a guard pass logged: one per spill it kept without proof. */
export const custodyRows = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls
  .filter(call => call[1] === SPILL_CUSTODY_ROW).map(call => call[0] as { spill: string; reason: string } & Record<string, unknown>);
