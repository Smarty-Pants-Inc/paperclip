import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRuns } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { nativeWorkspaceSyncInternals as sync, prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { restoreRemoteWorkspaceArchive } from "../services/remote-workspace-snapshot-archive.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pending Stop export before warm fallback", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("native-warm-fallback-"); db = createDb(database.connectionString); }, 30_000);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(environmentLeases); await db.delete(heartbeatRuns); await db.delete(agents); await db.delete(companies);
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["corrupt-stamp", "missing-lease-stamp", "changed-host", "export-fails", "sha-mismatch"] as const)(
    "%s never replaces the only copy before server custody", async fault => {
      const root = await mkdtemp(path.join(os.tmpdir(), "native-warm-fallback-")); roots.push(root);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home")); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      const host = path.join(root, "host"), remote = path.join(root, "remote");
      await mkdir(host); await mkdir(remote); await writeFile(path.join(host, "baseline.txt"), "baseline\n");
      const companyId = randomUUID(), workspaceId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Fallback custody", issuePrefix: `F${companyId.slice(0, 6)}` });
      const [agent] = await db.insert(agents).values({ companyId, name: "Writer" }).returning();
      let armed = false, faultTriggered = false, stoppedRunId = "";
      const runner: CommandManagedRuntimeRunner = { execute: async input => {
        const script = (input.args ?? []).join(" ");
        if (armed && fault === "export-fails" && script.includes("dd if=")) {
          faultTriggered = true;
          return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "injected export refusal", pid: null, startedAt: null };
        }
        const result = await new Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>((resolve, reject) => {
          const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
            timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
            exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0,
            signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null,
          }));
          child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
          child.stdin?.end(input.stdin ?? "");
        });
        if (armed && fault === "sha-mismatch" && script.includes("base64 -d") && script.includes("workspace-sync-v1.json")) {
          const directory = path.dirname(sync.durableSeedPaths(stoppedRunId).workspaceArchivePath);
          for (const name of await readdir(directory)) if (/^snapshot\.[0-9a-f]{64}\.pcws$/.test(name)) {
            await appendFile(path.join(directory, name), "corrupt after publication"); faultTriggered = true;
          }
        }
        return result;
      } };
      let metadata: Record<string, unknown> = { remoteCwd: remote };
      const prepare = async (resumed: boolean) => {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent!.id, status: "running", runtimeMode: "native", processPid: process.pid });
        const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
          provider: "boat", providerLeaseId: "same-box", leasePolicy: "reuse_by_environment", status: "active", metadata }).returning();
        const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", remoteCwd: remote, runner,
          leaseId: lease!.id, sandboxLeaseAcquisition: { outcome: resumed ? "resumed" : "created", providerLeaseId: "same-box" } };
        const pending = prepareNativeWorkspaceSync({ db, companyId, workspaceId, runId, lease: lease!, target, workspaceLocalDir: host });
        return { runId, lease: lease!, pending };
      };
      const warm = await prepare(false); await (await warm.pending)!.restoreWorkspace();
      metadata = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, warm.lease.id)))[0]!.metadata ?? {};
      const stopped = await prepare(true); stoppedRunId = stopped.runId; await stopped.pending;
      const file = Buffer.from("only copy from the stopped turn: café 🌱\n");
      await writeFile(path.join(remote, "stopped-only.txt"), file);
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, stopped.runId));
      if (fault === "missing-lease-stamp") delete metadata.nativeWorkspaceSync;
      else if (fault === "changed-host") await writeFile(path.join(host, "concurrent.txt"), "keep host work\n");
      else await writeFile(path.join(remote, ".paperclip-runtime/paperclip-runner/workspace-sync-v1.json"), "{}\n");
      armed = true;
      const next = await prepare(true);
      if (fault === "export-fails" || fault === "sha-mismatch") {
        await expect(next.pending).rejects.toThrow();
        expect(faultTriggered, "the intended export/readback fault was reached").toBe(true);
        expect(await readFile(path.join(remote, "stopped-only.txt"))).toEqual(file);
        return;
      }
      const prepared = await next.pending;
      expect(prepared?.mode).toBe("host_current");
      expect(await readFile(path.join(remote, "stopped-only.txt"))).toEqual(file);
      expect(await readFile(path.join(host, "stopped-only.txt"))).toEqual(file);
      if (fault === "changed-host") expect(await readFile(path.join(remote, "concurrent.txt"), "utf8")).toBe("keep host work\n");
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stopped.runId));
      const saved = await sync.readDescriptor({ runId: stopped.runId, reference: sync.readReference(run!.runnerProfileJson?.nativeWorkspaceSync)! });
      const snapshot = saved.descriptor.finalSnapshot!;
      const archivePath = sync.finalSnapshotPath(stopped.runId, snapshot.sha256);
      expect(createHash("sha256").update(await readFile(archivePath)).digest("hex")).toBe(snapshot.sha256);
      const readback = path.join(root, "readback");
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir: readback, expectedManifestDigest: snapshot.manifestDigest });
      expect(await readFile(path.join(readback, "stopped-only.txt"))).toEqual(file);
      await prepared?.cleanup();
    }, 30_000,
  );
});
