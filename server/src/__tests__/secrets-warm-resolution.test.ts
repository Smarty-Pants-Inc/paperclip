import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companySecrets, companySecretBindings, companySecretVersions, environments, heartbeatRuns, issues, plugins, secretAccessEvents, createDb } from "@paperclipai/db";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.js";
import { flushSecretResolutionWrites } from "../services/secret-resolution-writes.js";
import { eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
async function recordEvidence(result: Record<string, unknown>) {
  console.info(JSON.stringify(result));
  if (process.env.WARM_RESOLUTION_EVIDENCE) await appendFile(process.env.WARM_RESOLUTION_EVIDENCE, `${JSON.stringify(result)}\n`);
}
suite("warm secret resolution (real PostgreSQL lock boundary)", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;
  const dir = path.join(os.tmpdir(), `warm-secret-${randomUUID()}`);
  const previous = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(dir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("warm-secret");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
  });
  afterAll(async () => {
    if (db) await flushSecretResolutionWrites(db);
    await cleanup?.();
    if (previous === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  });
  it("20 concurrent resolves finish while another transaction holds the secret row lock", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Warm resolve", issuePrefix: `W${companyId.slice(0, 6)}` });
    const service = secretService(db);
    const secret = await service.create(companyId, { name: "provider-key", provider: "local_encrypted", value: "synthetic-test-value" });
    let release!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const lockRelease = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`select id from company_secrets where id = ${secret.id} for update`);
      locked();
      await lockRelease;
    });
    await lockReady;
    const updates = vi.spyOn(db, "update");
    const started = performance.now();
    const resolves = Promise.all(Array.from({ length: 20 }, () => service.resolveSecretValue(companyId, secret.id, "latest")));
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([resolves, new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 800); })]);
      expect(result, "resolves must not wait for the held row lock").toEqual(Array(20).fill("synthetic-test-value"));
      await recordEvidence({ concurrentResolves: 20, elapsedMs: performance.now() - started, hotPathUpdates: updates.mock.calls.filter(([table]) => table === companySecrets).length });
      expect(updates.mock.calls.filter(([table]) => table === companySecrets)).toHaveLength(0);
    } finally {
      clearTimeout(timeout!);
      release();
      await holder;
      await resolves;
      await flushSecretResolutionWrites(db);
      updates.mockRestore();
    }
  });

  it("does not await audit INSERTs, then flushes all 20 events with only one debounced UPDATE", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Audit batch", issuePrefix: `A${companyId.slice(0, 6)}` });
    const service = secretService(db);
    const secret = await service.create(companyId, { name: "audit-key", provider: "local_encrypted", value: "synthetic-audit-value" });
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`lock table secret_access_events in access exclusive mode`);
      locked();
      await released;
    });
    await ready;
    const updates = vi.spyOn(db, "update");
    const resolve = () => service.resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: { consumerType: "system", consumerId: "provider-calls", actorType: "system" },
    });
    const resolves = Promise.all(Array.from({ length: 20 }, resolve));
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([resolves, new Promise<null>(done => { timeout = setTimeout(() => done(null), 800); })]);
      expect(result, "a locked audit table must not delay a resolve").toHaveLength(20);
    } finally {
      clearTimeout(timeout!);
      release();
      await holder;
      await resolves;
    }
    await flushSecretResolutionWrites(db);
    const recorded = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id));
    expect(recorded).toHaveLength(20);
    expect(new Set(recorded.map(row => row.id)).size).toBe(20);
    expect(updates.mock.calls.filter(([table]) => table === companySecrets)).toHaveLength(1);
    await service.resolveSecretValue(companyId, secret.id, "latest");
    await flushSecretResolutionWrites(db);
    expect(updates.mock.calls.filter(([table]) => table === companySecrets)).toHaveLength(1);
    const [metadata] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(metadata.updatedAt).toEqual(secret.updatedAt);
    await recordEvidence({ auditEvents: recorded.length, debouncedUpdates: 1, updatedAtUnchanged: true });
    updates.mockRestore();
  });

  it("keeps a caller-owned transaction's audit atomic instead of using its closed handle later", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Transaction audit", issuePrefix: `T${companyId.slice(0, 6)}` });
    const secret = await secretService(db).create(companyId, { name: "transaction-key", provider: "local_encrypted", value: "synthetic-transaction-value" });
    const [environment] = await db.insert(environments).values({ name: `Transaction ${randomUUID()}`, driver: "sandbox", config: { provider: "fake" } }).returning();
    await secretService(db).createBinding({ companyId, secretId: secret.id, targetType: "environment", targetId: environment.id, configPath: "apiKey" });
    await expect(db.transaction(async tx => {
      expect(await secretService(tx).resolveSecretValue(companyId, secret.id, "latest", {
        accessContext: { consumerType: "system", consumerId: "transaction", actorType: "system" },
      })).toBe("synthetic-transaction-value");
      expect(await secretService(tx).resolveSecretValueForEnvironmentRuntime(companyId, secret.id, {
        consumerType: "environment", consumerId: environment.id, configPath: "apiKey", actorType: "system",
      }, "transaction-revision")).toBe("synthetic-transaction-value");
      const events = await tx.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id));
      expect(events).toHaveLength(2);
      throw new Error("rollback-test");
    })).rejects.toThrow("rollback-test");
    await flushSecretResolutionWrites(db);
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.secretId, secret.id))).toHaveLength(0);
  });

  it("audits missing and cross-company identity failures without invalid foreign keys or leaked metadata", async () => {
    const companyId = randomUUID();
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Denied identity", issuePrefix: `D${companyId.slice(0, 6)}` },
      { id: foreignCompanyId, name: "Foreign identity", issuePrefix: `F${foreignCompanyId.slice(0, 6)}` },
    ]);
    const service = secretService(db);
    const foreignSecret = await service.create(foreignCompanyId, { name: "foreign-key", provider: "local_encrypted", value: "synthetic-foreign-value" });
    const context = { consumerType: "environment" as const, consumerId: randomUUID(), configPath: "apiKey", actorType: "user" as const, actorId: "audit-test-user" };
    await expect(service.resolveSecretValueForEnvironmentRuntime(companyId, randomUUID(), context, "missing")).rejects.toThrow("Secret not found");
    await expect(service.resolveSecretValueForEnvironmentRuntime(companyId, foreignSecret.id, context, "foreign")).rejects.toThrow("same company");
    await flushSecretResolutionWrites(db);
    const recorded = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId));
    expect(recorded).toHaveLength(2);
    expect(recorded.every(event => event.secretId === null && event.version === null && event.provider === "unknown" &&
      event.outcome === "failure" && event.consumerId === context.consumerId && event.configPath === "apiKey" &&
      event.actorType === "user" && event.actorId === "audit-test-user")).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(foreignSecret.id);
  });

  it("100 concurrent Boat-style config calls resolve once; rotation/config changes invalidate and revocation fails closed", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Provider cache", issuePrefix: `C${companyId.slice(0, 6)}` });
    const service = secretService(db);
    const secret = await service.create(companyId, { name: "boat-api-key", provider: "local_encrypted", value: "synthetic-boat-v1" });
    const pluginKey = `warm.provider.${randomUUID()}`;
    await db.insert(plugins).values({
      pluginKey, packageName: "@paperclipai/warm-provider-test", version: "1.0.0", status: "ready",
      manifestJson: {
        id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Warm provider", description: "Test", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "warm-boat", kind: "sandbox_provider", displayName: "Warm Boat", configSchema: {
          type: "object", properties: { apiKey: { type: "string", format: "secret-ref" }, image: { type: "string" } },
        } }],
      },
    });
    const [environment] = await db.insert(environments).values({
      name: `Warm Boat ${randomUUID()}`, driver: "sandbox", config: { provider: "warm-boat", apiKey: secret.id, image: "test:v1" },
    }).returning();
    await service.createBinding({ companyId, secretId: secret.id, targetType: "environment", targetId: environment.id, configPath: "apiKey" });
    const providerResolve = vi.spyOn(localEncryptedProvider, "resolveVersion");
    const [agent] = await db.insert(agents).values({ companyId, name: "Audit consumer" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Provider audit context" }).returning();
    const runs = await db.insert(heartbeatRuns).values(Array.from({ length: 100 }, () => ({ companyId, agentId: agent.id }))).returning();
    const call = (heartbeatRunId?: string) => resolveEnvironmentDriverConfigForRuntime(db, companyId, { ...environment, driver: "sandbox" }, {
      issueId: issue.id, heartbeatRunId: heartbeatRunId ?? runs[0].id,
    });
    const configs = await Promise.all(runs.map(run => call(run.id)));
    for (const config of configs) expect(config.config).toMatchObject({ apiKey: "synthetic-boat-v1" });
    expect(providerResolve).toHaveBeenCalledTimes(1);
    await flushSecretResolutionWrites(db);
    const events = await service.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(100);
    expect(new Set(events.map(event => event.heartbeatRunId))).toEqual(new Set(runs.map(run => run.id)));
    expect(events.every(event => event.consumerType === "environment" && event.consumerId === environment.id &&
      event.configPath === "apiKey" && event.issueId === issue.id && event.actorType === "system" && event.actorId === null &&
      event.outcome === "success" && event.version === 1 && event.provider === "local_encrypted")).toBe(true);
    // An already-filled cache hit also owns a fresh event, not the fill's run.
    await call(runs[99].id);
    expect(providerResolve).toHaveBeenCalledTimes(1);
    expect(await service.listAccessEvents(companyId, secret.id)).toHaveLength(101);
    await service.rotate(secret.id, { value: "synthetic-boat-v2" });
    expect((await call()).config).toMatchObject({ apiKey: "synthetic-boat-v2" });
    expect(providerResolve).toHaveBeenCalledTimes(2);
    environment.config = { ...environment.config, image: "test:v2" };
    expect((await call()).config).toMatchObject({ image: "test:v2", apiKey: "synthetic-boat-v2" });
    expect(providerResolve).toHaveBeenCalledTimes(3);
    await service.update(secret.id, { description: "metadata invalidation" });
    await call();
    expect(providerResolve).toHaveBeenCalledTimes(4);
    environment.config = { ...environment.config, image: "test:provider-failure" };
    providerResolve.mockRejectedValueOnce(new Error("synthetic-provider-failure-must-not-enter-audit"));
    await expect(call(runs[3].id)).rejects.toThrow("synthetic-provider-failure");
    expect(providerResolve).toHaveBeenCalledTimes(5);
    await db.update(companySecretVersions).set({ revokedAt: new Date() }).where(eq(companySecretVersions.secretId, secret.id));
    await expect(call(runs[1].id)).rejects.toThrow("Secret version is not active");
    await db.update(companySecretVersions).set({ revokedAt: null }).where(eq(companySecretVersions.secretId, secret.id));
    await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, secret.id));
    await expect(call(runs[2].id)).rejects.toThrow();
    expect(providerResolve).toHaveBeenCalledTimes(5);
    const allEvents = await service.listAccessEvents(companyId, secret.id);
    expect(allEvents).toHaveLength(107);
    expect(JSON.stringify(allEvents)).not.toContain("synthetic-provider-failure-must-not-enter-audit");
    const failures = allEvents.filter(event => event.outcome === "failure");
    expect(failures).toHaveLength(3);
    expect(new Set(failures.map(event => event.heartbeatRunId))).toEqual(new Set([runs[1].id, runs[2].id, runs[3].id]));
    expect(failures.every(event => event.consumerId === environment.id && event.configPath === "apiKey" && event.issueId === issue.id)).toBe(true);
    expect(failures.some(event => event.errorCode === "version_inactive")).toBe(true);
    await recordEvidence({ providerCalls: 100, initialSecretResolutions: 1, initialAuditEvents: events.length, distinctRunContexts: 100,
      rotationInvalidated: true, configInvalidated: true, metadataInvalidated: true, revokedVersionRejected: true,
      revokedBindingRejected: true, filledCacheHitAudited: true, providerFailureAudited: true, failureEvents: failures.length });
    providerResolve.mockRestore();
    await flushSecretResolutionWrites(db);
  });
});
