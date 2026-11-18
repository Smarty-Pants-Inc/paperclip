import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { agentIdentityKeys, agents, applyPendingMigrations, companies, createDb, heartbeatRunEvents, heartbeatRuns, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentIdentityService, AgentIdentityRevokedError } from "../services/agent-identity.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { createHeartbeatRunOutput } from "../services/heartbeat/run-output.js";
import { createDurableRunLogStore } from "../services/run-log-store.js";
import { createObjectRunLogStore } from "../services/object-run-log-store.js";
import { recoverSettledNativeRunLog } from "../services/native-runtime/native-run-log-recovery.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import type { PrpEvent } from "../vendor/paperclip-runner/index.js";
import type { StorageProvider } from "../storage/types.js";

// Data safety / recorded real catch: #20832 F1. No identity/lifecycle/log-path
// mocks: exercise terminated keys through the actual output and recovery owners.
describe("revoked identity log recovery and historical backfill", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  let companyId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paperclip-identity-recovery-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-identity-recovery-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Identity recovery", issuePrefix: "IRC", defaultResponsibleUserId: "identity-recovery-owner" }).returning();
    companyId = company.id;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function fixture() {
    const [agent] = await db.insert(agents).values({ companyId, name: randomUUID(), role: "engineer", adapterType: "process", status: "idle", lifecycleState: "ready" }).returning();
    const identity = await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running", startedAt: new Date() }).returning();
    return { agent, identity, run };
  }

  it("stores late PEM and a raw private-body line after termination, without throwing", async () => {
    const { agent, identity, run } = await fixture();
    await createAgentLifecycle(db).terminateAgent(agent.id);
    const redactor = await agentIdentityService(db).createExistingLogRedactor(companyId, agent.id);
    const store = createDurableRunLogStore({ basePath: join(directory, "late-logs") });
    const output = createHeartbeatRunOutput(db, {
      run, runId: run.id, issueId: null, runLogStore: store,
      identityRedactor: redactor, secretKeys: new Set(),
      appendRunEvent: async () => undefined,
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
    });
    const callbacks = await output.begin(run);
    const body = identity.privateKeyPem.split("\n")[1]!;
    await expect(callbacks.onLog("stdout", `late output\n${identity.privateKeyPem}body: ${body}\nfinished\n`)).resolves.toBeUndefined();
    await callbacks.appendIdentityRedactedLog("stdout", redactor.finish("stdout"));
    await output.flushOutputProgress({ force: true });
    await store.finalize(output.handle!);
    const { content } = await store.read(output.handle!);
    const stored = content.trim().split("\n").map(line => JSON.parse(line).chunk).join("");
    expect(stored).toContain("late output\n");
    expect(stored).toContain("finished\n");
    expect(stored.match(/\*\*\*REDACTED\*\*\*/g)).toHaveLength(2);
    expect(stored).not.toContain(identity.privateKeyPem);
    expect(stored).not.toContain(body);
    expect(output.stdoutExcerpt).not.toContain(body);
    // Redaction must not restore signing authority for this very same agent.
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toBeInstanceOf(AgentIdentityRevokedError);
  });

  it("recovers retained native output for a terminated agent through the real redactor caller", async () => {
    const { agent, identity, run } = await fixture();
    await createAgentLifecycle(db).terminateAgent(agent.id);
    const body = identity.privateKeyPem.split("\n")[1]!;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", schemaVersion: 1,
      runId: run.id, normalizedSessionId: randomUUID(),
      sourceInstanceId: "late-source", sourceEventId: "late-source:1", sourceSeq: 1,
      sourceKind: "runner", eventType: "item.delta", priority: 2,
      emittedAt: new Date().toISOString(),
      payload: { text: `recovered output\n${identity.privateKeyPem}body: ${body}\nfinished\n` },
    };
    await db.insert(heartbeatRunEvents).values({
      companyId, agentId: agent.id, runId: run.id, seq: 1,
      eventType: event.eventType, payload: { prpEvent: event },
      sourceInstanceId: event.sourceInstanceId, sourceEventId: event.sourceEventId,
      sourceSeq: event.sourceSeq, sourcePayloadSha256: nativeSha256(event), protocolSchemaVersion: 1,
    });
    const logRef = `${companyId}/${agent.id}/${run.id}`;
    await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "cancelled", logStore: "s3_segments", logRef, logBytes: null }).where(eq(heartbeatRuns.id, run.id));
    const store = createObjectRunLogStore({
      provider: memoryProvider(), keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async input => { await input.assertWriterAuthority?.(); },
    });
    await expect(recoverSettledNativeRunLog(db, store, logRef, async () => ({ enabled: false }))).resolves.toBeUndefined();
    const { content } = await store.read({ store: "s3_segments", logRef });
    const entries = content.trim().split("\n").map(line => JSON.parse(JSON.parse(line).chunk).event);
    expect(entries).toHaveLength(1);
    expect(entries[0].payload.text).toBe("recovered output\n***REDACTED***body: ***REDACTED***\nfinished\n");
    expect(content).not.toContain(body);
    const [recovered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(recovered.logBytes).toBeGreaterThan(0);
  });

  it("still refuses ensure for terminated keys, including a revoked key whose agent status was restored", async () => {
    const { agent } = await fixture();
    await createAgentLifecycle(db).terminateAgent(agent.id);
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toBeInstanceOf(AgentIdentityRevokedError);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toMatchObject({ name: "AgentIdentityRevokedError", message: "Agent identity key is revoked" });
  });

  it("migrates already-terminated keys, leaves active keys NULL and preserves revocations on replay", async () => {
    // As in existing migration replay tests, make only the new data migration
    // pending in the fully migrated disposable DB before seeding legacy rows.
    // At d9df4789 it does not exist: the real migrator does nothing and the
    // revokedAt assertion below fails on the actual missing backfill behavior.
    const migrations = new URL("../../../packages/db/src/migrations/", import.meta.url);
    const journal = JSON.parse(await readFile(new URL("meta/_journal.json", migrations), "utf8"));
    const entry = journal.entries.find((value: { idx: number }) => value.idx === 490);
    const content = entry ? await readFile(new URL(`${entry.tag}.sql`, migrations), "utf8") : null;
    if (content) {
      const hash = createHash("sha256").update(content).digest("hex");
      await db.execute(sql`delete from drizzle.__drizzle_migrations where hash = ${hash}`);
    }
    const terminated = await fixture();
    const active = await fixture();
    const alreadyRevoked = await fixture();
    await createAgentLifecycle(db).terminateAgent(alreadyRevoked.agent.id);
    const retainedBefore = await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, alreadyRevoked.agent.id));
    // Deliberately model pre-release termination without calling new revoke code.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminated.agent.id));
    const [legacyBefore] = await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, terminated.agent.id));
    expect(legacyBefore.revokedAt).toBeNull();
    await applyPendingMigrations(database.connectionString);
    const [legacyAfter] = await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, terminated.agent.id));
    expect(legacyAfter.revokedAt).toBeInstanceOf(Date);
    expect(legacyAfter).toEqual({ ...legacyBefore, revokedAt: expect.any(Date) });
    const [activeAfter] = await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, active.agent.id));
    expect(activeAfter.revokedAt).toBeNull();
    expect(await agentIdentityService(db).ensureAgentIdentity(companyId, active.agent.id)).toEqual(active.identity);
    if (content) {
      for (const statement of content.split("--> statement-breakpoint").filter(value => value.trim())) {
        await db.execute(sql.raw(statement));
        await db.execute(sql.raw(statement));
      }
    }
    await applyPendingMigrations(database.connectionString);
    expect(await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, terminated.agent.id))).toEqual([legacyAfter]);
    expect(await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, alreadyRevoked.agent.id))).toEqual(retainedBefore);
    const [stillActive] = await db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, active.agent.id));
    expect(stillActive.revokedAt).toBeNull();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});

// Same conditional-write semantics as native-run-log-watermark.test.ts; only
// the object transport is in-memory, not the exporter, DB, redactor or store.
function memoryProvider(): StorageProvider {
  const objects = new Map<string, Buffer>();
  const etag = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return {
    id: "s3",
    async putObject() { throw new Error("unconditional object write"); },
    async putObjectConditional(input) {
      const old = objects.get(input.objectKey);
      if (input.ifNoneMatch ? old : !old || etag(old) !== input.ifMatch)
        throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
      const chunks: Buffer[] = [];
      for await (const chunk of Readable.from(input.body)) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      objects.set(input.objectKey, bytes);
      return { etag: etag(bytes) };
    },
    async getObject(input) {
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { stream: Readable.from([bytes]), etag: etag(bytes) };
    },
    async headObject(input) { return { exists: objects.has(input.objectKey) }; },
    async deleteObject(input) { objects.delete(input.objectKey); },
    async listObjects(input) { return { keys: [...objects.keys()].filter(key => key.startsWith(input.prefix)) }; },
  };
}
