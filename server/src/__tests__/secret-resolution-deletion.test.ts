import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companySecrets, createDb, heartbeatRuns, issues, plugins,
  secretAccessEvents, userSecretDefinitions,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { deleteCompany } from "../services/company-deletion.js";
import { issueService } from "../services/issues.js";
import { secretService } from "../services/secrets.js";
import {
  drainSecretResolutionWrites, enqueueSecretAccessEvent, flushSecretResolutionWrites,
} from "../services/secret-resolution-writes.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// Data safety: deferred handoff evidence must survive deletion of any nullable FK.
suite("deferred secret audit reference deletion (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;
  const dir = path.join(os.tmpdir(), `secret-delete-${randomUUID()}`);
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  beforeAll(async () => {
    await mkdir(dir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(dir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secret-audit-delete");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  });
  afterAll(async () => {
    try { if (db) await flushSecretResolutionWrites(db); }
    finally {
      await cleanup?.();
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a deleted company's queued handoff with a count-only warning and persists the other company's handoff", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const [deletedCompany] = await db.insert(companies).values({ id: companyA, name: "Deleted company", issuePrefix: `A${companyA.slice(0, 7)}` }).returning();
    await db.insert(companies).values({ id: companyB, name: "Healthy company", issuePrefix: `B${companyB.slice(0, 7)}` });
    const service = secretService(db);
    const context = { consumerType: "system" as const, consumerId: "company-handoff", actorType: "system" as const };
    const secretA = await service.create(companyA, { name: "deleted-company", provider: "local_encrypted", value: "synthetic-company-A-value" });
    const secretB = await service.create(companyB, { name: "healthy-company", provider: "local_encrypted", value: "synthetic-company-B-value" });
    const warning = vi.spyOn(logger, "warn");
    try {
      expect(await service.resolveSecretValue(companyA, secretA.id, "latest", { accessContext: context })).toBe("synthetic-company-A-value");
      expect(await service.resolveSecretValue(companyB, secretB.id, "latest", { accessContext: context })).toBe("synthetic-company-B-value");
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyB))).toHaveLength(0);
      expect(await deleteCompany(db, companyA)).toMatchObject({ id: companyA });
      expect(await db.select().from(companies).where(eq(companies.id, companyA))).toHaveLength(0);
      await flushSecretResolutionWrites(db);
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyA))).toHaveLength(0);
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyB))).toMatchObject([{ secretId: secretB.id }]);
      expect(warning).toHaveBeenCalledWith({ kind: "audit", droppedCount: 1 }, "Dropped secret audit events for deleted companies");
      await drainSecretResolutionWrites();
      await flushSecretResolutionWrites(db);
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyB))).toHaveLength(1);
      console.info(JSON.stringify({ target: "deleted-company", droppedEvents: 1, healthyPersisted: 1, drained: true }));
    } finally {
      warning.mockRestore();
      // Restore only a disposable tenant on RED so the old queue can drain.
      await db.insert(companies).values(deletedCompany).onConflictDoNothing();
      await flushSecretResolutionWrites(db);
    }
  });

  it("dead-letters the same batch after five failed flushes and persists a later healthy batch (real non-FK failure)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dead-letter isolation", issuePrefix: `L${companyId.slice(0, 7)}` });
    const event = { companyId, provider: "local_encrypted", actorType: "system", consumerType: "system", consumerId: "poison-dead-letter", outcome: "success" };
    await db.execute(sql`ALTER TABLE secret_access_events ADD CONSTRAINT secret_audit_dead_letter_test CHECK (consumer_id <> 'poison-dead-letter')`);
    const errors = vi.spyOn(logger, "error");
    const insert = vi.spyOn(db, "insert");
    try {
      const withUnexpectedValue = { ...event, value: "synthetic-dead-letter-plaintext", providerCredentials: "synthetic-dead-letter-credential" };
      await enqueueSecretAccessEvent(db, withUnexpectedValue);
      await expect(flushSecretResolutionWrites(db)).rejects.toThrow("audit write failed");
      // New arrivals must not change the failed batch or reset its budget.
      await enqueueSecretAccessEvent(db, { ...event, consumerId: "healthy-after-poison" });
      for (let failure = 2; failure <= 4; failure++) {
        await expect(flushSecretResolutionWrites(db)).rejects.toThrow("audit write failed");
        expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId))).toHaveLength(0);
      }
      await flushSecretResolutionWrites(db);
      const recorded = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId));
      expect(recorded).toMatchObject([{ consumerId: "healthy-after-poison" }]);
      expect(insert).toHaveBeenCalledTimes(11); // two attempts per failed flush, then one healthy INSERT
      const deadLetters = errors.mock.calls.filter(call => call[1] === "Secret audit batch dead-lettered after bounded retries");
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0][0]).toMatchObject({ kind: "audit", failedFlushes: 5, count: 1, eventIds: [expect.any(String)], records: [{ ...event, id: expect.any(String), createdAt: expect.any(Date) }] });
      const payload = deadLetters[0][0] as { eventIds: string[]; records: Array<{ id: string }> };
      expect(payload.eventIds).toEqual(payload.records.map(row => row.id));
      expect(payload.eventIds).not.toContain(recorded[0].id);
      expect(JSON.stringify(deadLetters)).not.toContain("synthetic-company-");
      expect(JSON.stringify(errors.mock.calls)).not.toContain("synthetic-dead-letter-plaintext");
      expect(JSON.stringify(errors.mock.calls)).not.toContain("synthetic-dead-letter-credential");
      await drainSecretResolutionWrites();
      await flushSecretResolutionWrites(db);
      expect(insert).toHaveBeenCalledTimes(11);
      console.info(JSON.stringify({ target: "persistent-non-FK", failedFlushes: 5, failedInsertAttempts: 10, deadLetterCount: 1, healthyPersisted: 1, drained: true }));
    } finally {
      errors.mockRestore();
      insert.mockRestore();
      await db.execute(sql`ALTER TABLE secret_access_events DROP CONSTRAINT secret_audit_dead_letter_test`);
      await flushSecretResolutionWrites(db);
    }
  });

  it.each(["issue", "run", "secret", "plugin", "definition", "all", "uncertain"] as const)(
    "persists both the deleted-%s handoff and an unrelated healthy handoff, then drains",
    async target => {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Deleted audit reference", issuePrefix: `D${companyId.slice(0, 7)}` });
      const service = secretService(db);
      const secret = await service.create(companyId, { name: "deleted-reference", provider: "local_encrypted", value: "synthetic-delete-secret-value" });
      const healthy = await service.create(companyId, { name: "healthy", provider: "local_encrypted", value: "synthetic-healthy-secret-value" });
      const [issue] = await db.insert(issues).values({ companyId, title: "Delete before audit flush" }).returning();
      const [agent] = await db.insert(agents).values({ companyId, name: "Audit agent" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id }).returning();
      const pluginKey = `audit.delete.${randomUUID()}`;
      const [plugin] = await db.insert(plugins).values({
        pluginKey, packageName: "@paperclipai/audit-delete-test", version: "1.0.0", status: "ready",
        manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Audit delete",
          description: "Audit deletion regression", author: "Paperclip", categories: ["automation"],
          capabilities: [], entrypoints: { worker: "dist/worker.js" } },
      }).returning();
      const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "audit-delete", name: "Audit delete" }).returning();
      const deletes = (kind: string) => target === kind || target === "all" || (target === "uncertain" && kind === "issue");
      const [secretRow] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
      const context = { consumerType: "system" as const, consumerId: "deleted-reference", actorType: "system" as const, issueId: issue.id, heartbeatRunId: run.id, pluginId: plugin.id };
      if (target === "definition" || target === "all") {
        // The queue accepts user-secret definition references as well as company secrets.
        // Exercise that persistence boundary without inventing a user identity/provider.
        await enqueueSecretAccessEvent(db, { companyId, secretId: secret.id, userSecretDefinitionId: definition.id,
          provider: "local_encrypted", version: 1, ...context, outcome: "success" });
      } else {
        expect(await service.resolveSecretValue(companyId, secret.id, "latest", { accessContext: context })).toBe("synthetic-delete-secret-value");
      }
      expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId))).toHaveLength(0);
      let restoreTransaction: (() => void) | undefined;
      try {
        if (deletes("issue")) await issueService(db).remove(issue.id);
        if (deletes("run")) await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        if (deletes("secret")) await db.delete(companySecrets).where(eq(companySecrets.id, secret.id));
        if (deletes("plugin")) await db.delete(plugins).where(eq(plugins.id, plugin.id));
        if (deletes("definition")) await db.delete(userSecretDefinitions).where(eq(userSecretDefinitions.id, definition.id));
        expect(await service.resolveSecretValue(companyId, healthy.id, "latest", { accessContext: { consumerType: "system", consumerId: "healthy", actorType: "system" } })).toBe("synthetic-healthy-secret-value");
        if (target === "uncertain") {
          const transaction = db.transaction.bind(db);
          const spy = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
            await transaction(callback, config);
            throw new Error("connection lost after recovery commit");
          });
          restoreTransaction = () => spy.mockRestore();
        }
        await flushSecretResolutionWrites(db);
        const recorded = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId));
        expect(recorded).toHaveLength(2);
        const deleted = recorded.find(row => row.consumerId === "deleted-reference")!;
        expect(deleted).toMatchObject({
          secretId: deletes("secret") ? null : secret.id,
          issueId: deletes("issue") ? null : issue.id,
          heartbeatRunId: deletes("run") ? null : run.id,
          pluginId: deletes("plugin") ? null : plugin.id,
          userSecretDefinitionId: null,
          provider: "local_encrypted", version: 1, outcome: "success",
        });
        expect(recorded.find(row => row.consumerId === "healthy")).toMatchObject({ secretId: healthy.id, issueId: null, heartbeatRunId: null });
        expect(new Set(recorded.map(row => row.id)).size).toBe(2);
        expect(JSON.stringify(recorded)).not.toContain("synthetic-delete-secret-value");
        expect(JSON.stringify(recorded)).not.toContain("synthetic-healthy-secret-value");
        await drainSecretResolutionWrites();
        await flushSecretResolutionWrites(db);
        expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, companyId))).toHaveLength(2);
        const evidence = JSON.stringify({ target, persistedEvents: recorded.length, uniqueEventIds: new Set(recorded.map(row => row.id)).size,
          deletedReferences: { secretId: deleted.secretId, issueId: deleted.issueId, heartbeatRunId: deleted.heartbeatRunId,
            pluginId: deleted.pluginId, userSecretDefinitionId: deleted.userSecretDefinitionId },
          healthyEventPersisted: true, drained: true, repeatedFlushCount: 2 });
        console.info(evidence);
        if (process.env.SECRET_DELETION_EVIDENCE) await appendFile(process.env.SECRET_DELETION_EVIDENCE, `${evidence}\n`);
      } finally {
        restoreTransaction?.();
        // On the unfixed base, restore only our disposable FK fixtures so the
        // deliberately poisoned queue can drain and the RED run exits cleanly.
        await db.insert(issues).values(issue).onConflictDoNothing();
        await db.insert(heartbeatRuns).values(run).onConflictDoNothing();
        await db.insert(companySecrets).values(secretRow).onConflictDoNothing();
        await db.insert(plugins).values(plugin).onConflictDoNothing();
        await db.insert(userSecretDefinitions).values(definition).onConflictDoNothing();
        await flushSecretResolutionWrites(db);
      }
    },
  );
});
