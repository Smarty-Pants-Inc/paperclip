import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { nativeHarnessBackupOwner, persistNativeHarnessBackup, restoreDurableNativeHarnessBackup,
  deleteRetiredNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { nativeHarnessBackupExpirationService } from "./native-harness-backup-expiration.js";

describeEmbeddedPostgres("permanent Pi conversation object retention", () => {
  const environment = nativeRestartFixture();
  afterEach(() => vi.unstubAllEnvs());

  // Own database: a ten-year retention clock must not age unrelated fixtures.
  // Data safety / tenant boundary: real encryption, storage and expiry, no mocks.
  it.each(["current", "superseded", "pending", "retired", "legacy_unknown"])(
    "never prunes the last encrypted Pi conversation copy (%s)", async status => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
      const f = await environment.seedRun(randomUUID());
      const { companyId, runtimeRoot, successor } = environment.current;
      await f.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId, controllerGeneration: 1,
        leaseOwner: "backup-writer", leaseExpiresAt: new Date(Date.now() + 120_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
      const owner = await nativeHarnessBackupOwner(f.db, { companyId, issueId: f.issueId, runId: f.runId, bootId: successor.bootId });
      const root = join(runtimeRoot, randomUUID());
      await mkdir(join(root, "pi"), { recursive: true });
      await writeFile(join(root, "pi", "only.jsonl.invalid-foreign"), "foreign original bytes\n");
      await writeFile(join(root, "pi", "only.jsonl"), "missing-file-era history\n");
      await writeFile(join(root, "manifest.json"), JSON.stringify({ schema: "paperclip.native-harness-backup.v1",
        providerKind: "pi_rpc", normalizedSessionId: f.native.normalizedSessionId }));
      const scopeDigest = createHash("sha256").update(JSON.stringify([companyId, f.runId, f.native.normalizedSessionId])).digest("hex");
      const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "durable-objects")));
      const input = { db: f.db, storage, owner, root, companyId, scopeDigest };
      await persistNativeHarnessBackup(input);
      const [backup] = await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.scopeDigest, scopeDigest));
      const readObject = async () => {
        const object = await storage.getObject(companyId, backup.reference.objectKey as string);
        const chunks: Buffer[] = [];
        for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      };
      const encrypted = await readObject();
      // This is an upload scratch source, not a managed scoped runtime. The
      // verified encrypted object is now the ONLY copy of these conversations.
      await rm(root, { recursive: true });
      const old = new Date(Date.now() - 10 * 86_400_000);
      await f.db.update(heartbeatRuns).set({ status: "failed", finishedAt: old }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null })
        .where(eq(nativeRunFinalizations.runId, f.runId));
      await f.db.update(issues).set({ status: "done", executionRunId: null, completedAt: old }).where(eq(issues.id, f.issueId));
      const reference = { ...backup.reference };
      if (status === "legacy_unknown") delete reference.piConversationEvidence;
      await f.db.update(nativeHarnessBackups).set({ status: status === "legacy_unknown" ? "retired" : status,
        reference, createdAt: old, updatedAt: old }).where(eq(nativeHarnessBackups.id, backup.id));
      expect(await nativeHarnessBackupExpirationService(f.db, { storage }).tickCheckpoints()).toMatchObject({ expired: 0, failed: 0 });
      expect(await f.db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, backup.id))).toHaveLength(1);
      expect(await readObject()).toEqual(encrypted);
      await f.db.update(nativeHarnessBackups).set({ status: "retired" }).where(eq(nativeHarnessBackups.id, backup.id));
      expect(await deleteRetiredNativeHarnessBackup(f.db, storage, backup.id)).toBe(false);
      expect(await nativeHarnessBackupExpirationService(f.db, { storage,
        now: new Date(Date.now() + 3650 * 86_400_000) }).tickCheckpoints()).toMatchObject({ expired: 0, failed: 0 });
      expect(await readObject()).toEqual(encrypted);
      expect(await restoreDurableNativeHarnessBackup({ ...input, companyId: randomUUID(), backupRoot: root })).toBe(false);
      // Prove recoverability, not just a still-present ciphertext: status is
      // deliberately readmitted only inside this test's own database.
      await f.db.update(nativeHarnessBackups).set({ status: "current" }).where(eq(nativeHarnessBackups.id, backup.id));
      expect(await restoreDurableNativeHarnessBackup({ ...input, backupRoot: root })).toBe(true);
      expect(await readFile(join(root, "current/pi/only.jsonl.invalid-foreign"), "utf8")).toBe("foreign original bytes\n");
      expect(await readFile(join(root, "current/pi/only.jsonl"), "utf8")).toBe("missing-file-era history\n");
    },
  );
});
