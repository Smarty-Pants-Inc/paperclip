import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { and, eq } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRunEvents, heartbeatRuns,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { createDurableRunLogStore, type RunLogStore, type RunLogStoreType } from "../run-log-store.js";
import { formatNativeRunLogEvent } from "../native-runtime/native-run-log-export.js";
import { canonicalNativeRunLogRedactionForms } from "./run-log.js";
import { createHeartbeatRunOutput } from "./run-output.js";

// Keep reason: never-OK trace custody. A legacy CLI image has no required raw
// source outside its run log. Exercise the real writer, stores and PostgreSQL.
// No provider/model or uploaded-attachment path is involved at this boundary.
const smallPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
function imageBytes(metadataBytes: number) {
  if (!metadataBytes) return smallPng;
  const payload = Buffer.from(`Comment\0${"image trace metadata ".repeat(Math.ceil(metadataBytes / 21))}`.slice(0, metadataBytes));
  const body = Buffer.concat([Buffer.from("tEXt"), payload]);
  const size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([smallPng.subarray(0, -12), size, body, crc, smallPng.subarray(-12)]);
}
const imageChunk = (bytes: Buffer) => `${JSON.stringify({ type: "user", message: { content: [
  { type: "image", source: { type: "base64", data: bytes.toString("base64"), media_type: "image/png" } },
] } })}\n`;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("legacy CLI image custody at the persisted run-log boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-runlog-image-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runlog-images-"));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  async function fixture(backend: "local" | "mirrored" | "failed mirror" = "local") {
    const id = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Image custody", issuePrefix: id }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Legacy CLI", adapterType: "claude_local" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id,
      status: "running", runtimeMode: "legacy" }).returning();
    const basePath = path.join(directory, id);
    const objectsPath = path.join(basePath, "objects");
    if (backend === "failed mirror") {
      await fs.mkdir(basePath, { recursive: true });
      // A real filesystem fault, not a fake provider: an ordinary file cannot
      // be the parent directory of a mirror object (ENOTDIR / EEXIST).
      await fs.writeFile(objectsPath, "not a directory");
    }
    const provider = createLocalDiskStorageProvider(objectsPath);
    const store: RunLogStore = createDurableRunLogStore({ basePath: path.join(basePath, "logs"),
      ...(backend !== "local" ? { s3: { provider } } : {}) });
    const output = createHeartbeatRunOutput(db, { run: run!, runId: run!.id, issueId: null, runLogStore: store,
      identityRedactor: createAgentIdentityRedactor(), secretKeys: new Set(),
      appendRunEvent: async (row, event) => { await appendHeartbeatRunEvent(db, { companyId: row.companyId,
        runId: row.id, agentId: row.agentId, ...event }); },
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    const handlers = await output.begin(run!);
    const finish = async () => {
      await output.flushOutputProgress({ force: true });
      const summary = await store.finalize(output.handle!);
      await db.update(heartbeatRuns).set({ logBytes: summary.bytes, logSha256: summary.sha256 })
        .where(eq(heartbeatRuns.id, run!.id));
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(saved!.lastOutputSeq).toBeGreaterThan(0);
      expect(saved!.logBytes).toBeGreaterThan(0);
      // Read through the handle persisted in PostgreSQL, not the input chunk.
      // Losing the local file must still recover the exact mirrored bytes.
      if (backend === "mirrored") await fs.unlink(path.join(basePath, "logs", saved!.logRef!));
      const read = await store.read({ store: saved!.logStore as RunLogStoreType, logRef: saved!.logRef! },
        { limitBytes: 1024 * 1024 });
      return read.content.trim().split("\n").map(line => JSON.parse(line).chunk as string);
    };
    return { run: run!, store, output, handlers, finish, provider };
  }

  it.each(["local", "mirrored"] as const)("keeps stdout and stderr images byte-for-byte in the real %s store", async backend => {
    const f = await fixture(backend), bytes = imageBytes(2048), chunk = imageChunk(bytes);
    expect(bytes.toString("base64").length).toBeGreaterThanOrEqual(1024);
    await f.handlers.onLog("stdout", chunk);
    await f.handlers.onLog("stderr", chunk);
    const chunks = await f.finish();
    expect(chunks).toHaveLength(2);
    // Legacy stdout has no canonical source row or required provider trace.
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.run.id))).toHaveLength(0);
    for (const stored of chunks) {
      const data = JSON.parse(stored).message.content[0].source.data;
      expect(data).not.toContain("[omitted");
      const recovered = Buffer.from(data, "base64");
      expect(sha256(recovered)).toBe(sha256(bytes));
      expect(recovered).toEqual(bytes);
    }
  });

  it.each([undefined, "128"])("keeps an image above the chunk limit inline (limit %s)", async limit => {
    vi.stubEnv("PAPERCLIP_RUN_LOG_MAX_CHUNK_CHARS", limit);
    const f = await fixture(), bytes = imageBytes(72 * 1024), chunk = imageChunk(bytes);
    await f.handlers.onLog("stdout", chunk);
    expect(await f.finish()).toEqual([chunk]);
  });

  it("keeps inline bytes when the optional durable mirror write fails", async () => {
    const f = await fixture("failed mirror"), bytes = imageBytes(2048), chunk = imageChunk(bytes);
    await f.handlers.onLog("stdout", chunk);
    // finalize performs the real failed mirror PUT but retains the primary log.
    expect(await f.finish()).toEqual([chunk]);
    await expect(f.provider.headObject({ objectKey: f.output.handle!.logRef })).resolves.toEqual({ exists: false });
  });

  it("leaves a small (<1024 base64 chars) image unchanged", async () => {
    const f = await fixture(), chunk = imageChunk(smallPng);
    expect(smallPng.toString("base64").length).toBeLessThan(1024);
    await f.handlers.onLog("stdout", chunk);
    expect(await f.finish()).toEqual([chunk]);
  });

  it("leaves canonical omission unchanged after committing the raw source in PostgreSQL", async () => {
    const f = await fixture(), bytes = imageBytes(2048), sourceInstanceId = randomUUID();
    const event = { schema: "paperclip.prp.event.v1" as const, schemaVersion: 1 as const,
      runId: f.run.id, sourceInstanceId, sourceEventId: `${sourceInstanceId}:1`, sourceSeq: 1,
      sourceKind: "runner" as const, normalizedSessionId: randomUUID(), eventType: "item.delta" as const,
      priority: 2 as const, emittedAt: new Date().toISOString(),
      payload: { image: { type: "image", source: { type: "base64", data: bytes.toString("base64") } } } };
    const receipt = await appendHeartbeatRunEvent(db, { companyId: f.run.companyId, runId: f.run.id,
      agentId: f.run.agentId, eventType: event.eventType, payload: { prpEvent: event },
      nativeSource: { sourceInstanceId, sourceEventId: event.sourceEventId, sourceSeq: 1,
        protocolSchemaVersion: 1, canonicalPayload: event } });
    await f.handlers.appendIdentityRedactedLog("stdout", formatNativeRunLogEvent(event), true,
      { kind: "canonical_native", sourceCursor: receipt.row.seq });
    const chunks = await f.finish();
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0]!).event.payload.image.source.data)
      .toBe(`[omitted base64 image data: ${bytes.toString("base64").length} chars]`);
    const [raw] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id),
      eq(heartbeatRunEvents.sourceEventId, event.sourceEventId)));
    const kept = (raw!.payload as { prpEvent: typeof event }).prpEvent.payload.image.source.data;
    expect(Buffer.from(kept, "base64")).toEqual(bytes);
  });

  it("still offers the historical compacted canonical image form for archive verification", () => {
    const data = imageBytes(2048).toString("base64");
    const chunk = JSON.stringify({ type: "paperclip.prp.event", event: {
      payload: { type: "image", source: { type: "base64", data } },
    } });
    const old = chunk.replace(data, `[omitted base64 image data: ${data.length} chars]`);
    const forms = [...canonicalNativeRunLogRedactionForms(chunk, {
      redactIdentity: <T>(value: T) => value, currentUser: { enabled: false },
    })];
    expect(forms).toContain(old);
  });
});
