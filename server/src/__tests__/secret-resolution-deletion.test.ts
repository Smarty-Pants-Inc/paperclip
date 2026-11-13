import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companySecrets, createDb, heartbeatRuns, issues, plugins,
  secretAccessEvents, userSecretDefinitions,
} from "@paperclipai/db";
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
