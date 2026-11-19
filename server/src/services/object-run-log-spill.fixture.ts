import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { parse as parseEnv } from "dotenv";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { createObjectRunLogStore, readObjectRunLogSpill } from "./object-run-log-store.js";

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
  mode: "guest" | "drift" | "unreadable" | "recovered") {
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
    const handle = await store.begin({ companyId: "build", agentId: "node_modules", runId: "content-custody" });
    m.state.down = true;
    const receipt = await store.enqueue!(handle, event(1, "source-less bytes: the spill is the ONLY copy"));
    const settled = receipt.committed.catch(() => undefined);
    await store.finalize(handle);
    await settled;
    const root = mode === "guest" ? path.join(guestHome, "instances/guest/data/run-logs/.spill") : oldRoot;
    if (mode === "recovered") {
      m.state.down = false;
      await store.recoverSpill!({ companyId: "build", agentId: "node_modules", runId: "content-custody" });
    }
    const spill = await readObjectRunLogSpill(root, handle.logRef);
    const bytes = await fs.readFile(spill.path), index = await fs.readFile(spill.indexPath);
    if (mode !== "guest") await fs.writeFile(envPath, `PAPERCLIP_HOME=${JSON.stringify(path.join(workspacePath, "different-home"))}\n`);
    if (mode === "unreadable") await fs.chmod(spill.indexPath, 0);
    return { ...spill, bytes, index };
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

