import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, pluginDatabaseNamespaces, pluginMigrations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { startRealPluginLoader } from "../../__tests__/helpers/plugin-real-loader.js";

// Keep reason: trust boundary (real package -> child worker -> host RPC -> SQL).
// A ready registry row alone is not evidence that a child worker started.
it.each(["directory", "tgz"] as const)("installs ref/blocker-relay from %s and observes a live production-loader worker", async format => {
  const database = await startEmbeddedPostgresTestDatabase("guardian-loader-smoke-");
  const db = createDb(database.connectionString);
  let runtime: Awaited<ReturnType<typeof startRealPluginLoader>> | undefined;
  const scratch = await mkdtemp(path.join(tmpdir(), "guardian-smoke-package-"));
  try {
    runtime = await startRealPluginLoader(db);
    const blockerPath = process.env.BLOCKER_RELAY_PLUGIN_PATH
      || fileURLToPath(new URL("../../../../../ref/blocker-relay/", import.meta.url));
    const tarball = path.join(scratch, "blocker-relay.tgz");
    if (format === "tgz") {
      await mkdir(path.join(scratch, "package"));
      await cp(path.join(blockerPath, "package.json"), path.join(scratch, "package/package.json"));
      await cp(path.join(blockerPath, "dist"), path.join(scratch, "package/dist"), { recursive: true });
      await promisify(execFile)("tar", ["-czf", tarball, "-C", scratch, "package"]);
    }
    const blocker = await runtime.install(format === "tgz" ? tarball : blockerPath);
    expect(blocker.pluginKey).toBe("smarty-pants.paperclip-plugin-blocker-relay");
    expect((await runtime.dashboard(blocker.id)).worker).toMatchObject({ status: "running", pid: expect.any(Number) });
    const guardian = await runtime.install();
    const namespace = await db.select().from(pluginDatabaseNamespaces).where(eq(pluginDatabaseNamespaces.pluginId, guardian.id));
    const migrations = await db.select().from(pluginMigrations).where(eq(pluginMigrations.pluginId, guardian.id));
    expect(namespace).toHaveLength(1);
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.every(row => row.status === "applied")).toBe(true);
    await runtime.runJob(guardian.id);
    await runtime.restartWorker(guardian.id);
    expect((await db.select().from(pluginDatabaseNamespaces).where(eq(pluginDatabaseNamespaces.pluginId, guardian.id)))[0].namespaceName)
      .toBe(namespace[0].namespaceName);
    expect(await db.select().from(pluginMigrations).where(eq(pluginMigrations.pluginId, guardian.id))).toEqual(migrations);
    await runtime.runJob(guardian.id);
  } finally {
    try { await runtime?.close(); }
    finally { await db.$client.end(); await database.cleanup(); await rm(scratch, { recursive: true, force: true }); }
  }
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS * 2);
