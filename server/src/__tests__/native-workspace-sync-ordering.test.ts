import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRuns } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cleanupNativeWorkspaceSync, nativeWorkspaceSyncInternals as sync, prepareNativeWorkspaceSync, resumeNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { restoreRemoteWorkspaceArchive } from "../services/remote-workspace-snapshot-archive.js";

const support = await getEmbeddedPostgresTestSupport();
const runner: CommandManagedRuntimeRunner = {
  execute: input => new Promise((resolve, reject) => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0,
      signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null,
    }));
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin?.end(input.stdin ?? "");
  }),
};

// A real DB, transfer, merge, archive and shell stamp publisher. The opt-in
// turnstop row separately crosses real HTTP/executor/Runner/Pi with these same
// functions. No mocked policy, stamp return value, or duplicate ordering model.
(support.supported ? describe : describe.skip)("native workspace ordered export custody", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-export-order-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["prepared", "replayed", "legacy-stamp", "legacy-descriptor-cleaned", "concurrent", "stale-transfer", "git-prepared"] as const)(
    "keeps the newer head and both file snapshots when the old export is %s", async mode => {
      const root = await mkdtemp(path.join(os.tmpdir(), "native-export-order-")); roots.push(root);
      vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "test");
      const host = path.join(root, "host"), remote = path.join(root, "remote");
      await mkdir(host); await mkdir(remote);
      await writeFile(path.join(host, "value.txt"), "initial\n");
      if (mode === "git-prepared") {
        for (const args of [["init", "-b", "work"], ["config", "user.name", "Writer"], ["config", "user.email", "writer@example.invalid"], ["add", "."], ["commit", "-m", "baseline"]]) {
          expect((await runner.execute({ command: "git", args: ["-C", host, ...args], cwd: host })).exitCode).toBe(0);
        }
      }
      const companyId = randomUUID(), workspaceId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Ordered custody", issuePrefix: `O${companyId.slice(0, 6)}` });
      const [agent] = await db.insert(agents).values({ companyId, name: "Writer" }).returning();
      let metadata: Record<string, unknown> = { remoteCwd: remote };
      const prepare = async (resumed: boolean) => {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent!.id, status: "running" });
        const [lease] = await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
          provider: "boat", providerLeaseId: "same-box", leasePolicy: "reuse_by_environment", status: "active", metadata }).returning();
        const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", remoteCwd: remote, runner,
          leaseId: lease!.id, sandboxLeaseAcquisition: { outcome: resumed ? "resumed" : "created", providerLeaseId: "same-box" } };
        const prepared = (await prepareNativeWorkspaceSync({ db, companyId, workspaceId, runId, lease: lease!, target, workspaceLocalDir: host }))!;
        return { runId, target, prepared, lease: lease! };
      };
      const refresh = async (leaseId: string) => {
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
        metadata = lease!.metadata ?? {};
      };
      const warm = await prepare(false); await warm.prepared.restoreWorkspace(); await refresh(warm.lease.id);
      const stopped = await prepare(true); expect(stopped.prepared.mode).toBe("adopt_remote");
      await writeFile(path.join(remote, "stopped-only.txt"), "completed before Stop\n");
      await writeFile(path.join(remote, "value.txt"), "stopped\n");
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, stopped.runId));
      const next = await prepare(true); expect(next.prepared.mode).toBe("adopt_remote");
      let releaseOldTransfer: (() => void) | undefined;
      let oldExport: Promise<boolean> | undefined;
      if (mode === "stale-transfer") {
        let captured!: () => void;
        const oldCaptured = new Promise<void>(resolve => { captured = resolve; });
        const released = new Promise<void>(resolve => { releaseOldTransfer = resolve; });
        const oldRunner: CommandManagedRuntimeRunner = { execute: async command => {
          const result = await runner.execute(command);
          if (command.args?.some(arg => arg.includes("dd if="))) { captured(); await released; }
          return result;
        } };
        oldExport = resumeNativeWorkspaceSync({ db, runId: stopped.runId, target: { ...stopped.target, runner: oldRunner } });
        await oldCaptured;
      }
      await writeFile(path.join(remote, "value.txt"), "successor wins\n");
      await writeFile(path.join(remote, "successor-only.txt"), "newer work\n");
      if (mode === "stale-transfer") {
        let successorFinished = false;
        const successorExport = next.prepared.restoreWorkspace().then(() => { successorFinished = true; });
        let racedPublication = false;
        try { await new Promise(resolve => setTimeout(resolve, 1000)); racedPublication = successorFinished; }
        finally { releaseOldTransfer!(); await Promise.all([oldExport!, successorExport]); }
        expect(racedPublication, "one exporter owns host publication through transfer, merge and stamp").toBe(false);
      } else await next.prepared.restoreWorkspace();
      const stampPath = path.join(remote, ".paperclip-runtime/paperclip-runner/workspace-sync-v1.json");
      const newerStamp = JSON.parse(await readFile(stampPath, "utf8"));
      const readSaved = async (runId: string, label: string, expectedValue = "successor wins\n") => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const reference = sync.readReference(run!.runnerProfileJson?.nativeWorkspaceSync)!;
        const { descriptor } = await sync.readDescriptor({ runId, reference });
        const snapshot = descriptor.finalSnapshot!;
        expect(snapshot).toBeDefined();
        const archive = sync.finalSnapshotPath(runId, snapshot.sha256);
        expect(createHash("sha256").update(await readFile(archive)).digest("hex")).toBe(snapshot.sha256);
        const readback = path.join(root, label);
        await restoreRemoteWorkspaceArchive({ archivePath: archive, targetDir: readback, expectedManifestDigest: snapshot.manifestDigest });
        expect(await readFile(path.join(readback, "stopped-only.txt"), "utf8")).toBe("completed before Stop\n");
        expect(await readFile(path.join(readback, "value.txt"), "utf8")).toBe(expectedValue);
        return { descriptor, snapshot, archive };
      };
      // The executor's normal cleanup must not erase the newer snapshot
      // before a delayed Stop export has even completed.
      await next.prepared.cleanup();
      const newer = await readSaved(next.runId, "newer-readback");
      if (mode === "legacy-stamp" || mode === "legacy-descriptor-cleaned") {
        delete newerStamp.preparedAt;
        await writeFile(stampPath, JSON.stringify(newerStamp));
        if (mode === "legacy-descriptor-cleaned") await rm(sync.descriptorPath(next.runId, next.prepared.reference.descriptorSha256));
      }
      expect(await resumeNativeWorkspaceSync({ db, runId: stopped.runId, target: stopped.target })).toBe(true);
      if (mode === "replayed") expect(await resumeNativeWorkspaceSync({ db, runId: stopped.runId, target: stopped.target })).toBe(true);
      if (mode === "concurrent") await Promise.all([
        resumeNativeWorkspaceSync({ db, runId: stopped.runId, target: stopped.target }),
        resumeNativeWorkspaceSync({ db, runId: next.runId, target: next.target }),
      ]);
      await cleanupNativeWorkspaceSync(stopped.runId);
      const older = await readSaved(stopped.runId, "older-readback", mode === "stale-transfer" ? "stopped\n" : "successor wins\n");
      expect(Date.parse(older.descriptor.createdAt)).toBeLessThan(Date.parse(newer.descriptor.createdAt));
      expect(JSON.parse(await readFile(stampPath, "utf8"))).toEqual(newerStamp);
      expect(await readFile(path.join(host, "value.txt"), "utf8")).toBe("successor wins\n");
      expect(await readFile(path.join(remote, "value.txt"), "utf8")).toBe("successor wins\n");
      expect(createHash("sha256").update(await readFile(newer.archive)).digest("hex")).toBe(newer.snapshot.sha256);
    }, 30_000,
  );
});
