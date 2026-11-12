import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver, type NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import {
  buildNativeHarnessBackupManifestStreamed,
  resolveNativeHarnessPersistenceProfile,
  stageRemoteRunnerDirectory,
  syncRemoteRunnerDirectoryOut,
  verifyNativeHarnessBackupStreamed,
} from "./native-session-executor.js";

// Keep reason: data safety. Sandbox replacement must not discard the only Pi
// conversation copy. Use real archive/copy helpers and the driver's cold-open
// boundary; a completed-turn JSONL fixture needs no model or provider credentials.
describe("Pi conversation transcript sandbox backups", () => {
  it.each(["archive", "sync"] as const)("restores completed-turn bytes before the driver cold-opens them (%s)", async transfer => {
    const root = await mkdtemp(join(tmpdir(), "pi-transcript-backup-"));
    try {
      const sessionId = "native-pi-session";
      const live = join(root, "old-sandbox");
      const replacement = join(root, "fresh-sandbox");
      const controller = join(root, "controller");
      const backupRoot = join(controller, "failover-backups", "current");
      const runtimePath = (sandbox: string, directory: { name: string; location: string }) =>
        directory.location === "runner" ? join(sandbox, "runner") : join(sandbox, "filesystem", directory.name);
      const transcriptPath = (sandbox: string) => join(sandbox, "filesystem", "pi", `${sessionId}.jsonl`);
      const transcript = Buffer.from([
        { type: "session", version: 3, id: sessionId, timestamp: "2026-11-12T20:00:00.000Z", cwd: "/workspace" },
        { type: "message", id: "user-1", parentId: null, timestamp: "2026-11-12T20:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "Remember the Pi-only fact: violet π." }], timestamp: 1 } },
        { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-11-12T20:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Remembered." }], stopReason: "stop", timestamp: 2 } },
      ].map(record => JSON.stringify(record)).join("\n") + "\n");
      const execution = {
        provider: { kind: "pi_rpc", model: "neutral/model", piRpcThinkingLevel: "high" },
        binding: { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", executionWorkspaceId: "workspace" },
        workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: sessionId, driverKind: "pi_rpc", protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      } as unknown as NativeExecutionInputV1;
      for (const path of [join(live, "runner"), join(live, "filesystem", "pi-agent"), join(live, "filesystem", "pi")])
        await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(transcriptPath(live), transcript, { mode: 0o600 });
      await writeFile(join(live, "runner", "runner-state.json"), JSON.stringify({ lifecycle: "suspended" }), { mode: 0o600 });
      const launchFiles = ["auth.json", "auth.json.lock", "models.json", "settings.json"];
      for (const name of launchFiles)
        await writeFile(join(live, "filesystem", "pi-agent", name), "AUTH_SENTINEL", { mode: 0o600 });
      await writeFile(join(live, "filesystem", "pi-agent", "retained.txt"), "agent home state", { mode: 0o600 });
      const execute = async ({ command, args, stdin }: { command: string; args: string[]; stdin?: string }) => ({
        exitCode: 0, timedOut: false, stderr: "",
        stdout: execFileSync(command, args, { encoding: "utf8", input: stdin, maxBuffer: 64 * 1024 * 1024 }),
      });
      const copy = async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string; mode?: number }> }>) => {
        for (const operation of operations) for (const file of operation.files) {
          // Apply the sandbox boundary: transfers cannot escape this fixture.
          for (const path of [file.sourcePath, file.targetPath]) {
            const within = relative(root, path);
            expect(within).not.toMatch(/^\.\.(?:[\\/]|$)/u);
          }
          await mkdir(join(file.targetPath, ".."), { recursive: true, mode: 0o700 });
          await cp(file.sourcePath, file.targetPath, { recursive: true });
          if (file.mode !== undefined) await chmod(file.targetPath, file.mode);
        }
      };
      const runner = { execute, ...(transfer === "sync" ? { syncIn: copy, syncOut: copy } : {}) };
      const profile = resolveNativeHarnessPersistenceProfile(execution);
      for (const directory of profile.directories)
        await syncRemoteRunnerDirectoryOut({ runner: runner as never, sourcePath: runtimePath(live, directory),
          targetPath: join(backupRoot, directory.name), mode: 0o700, excludeEntries: directory.excludeEntries });
      const manifest = await buildNativeHarnessBackupManifestStreamed({ backupRoot, execution, runnerInstanceId: "runner-1",
        sourceProviderLeaseId: "old-sandbox", providerSessionIdentity: { providerSessionId: sessionId } });
      await writeFile(join(backupRoot, "manifest.json"), JSON.stringify(manifest));
      expect(await verifyNativeHarnessBackupStreamed({ root: controller, execution, runnerInstanceId: "runner-1" })).not.toBeNull();
      // The replacement cannot accidentally read the old sandbox's transcript.
      await rm(live, { recursive: true, force: true });
      await expect(access(replacement)).rejects.toMatchObject({ code: "ENOENT" });
      for (const directory of profile.directories)
        await stageRemoteRunnerDirectory({ target: { kind: "remote", transport: "provider", remoteCwd: replacement } as never,
          runner: runner as never, sourcePath: join(backupRoot, directory.name),
          targetPath: runtimePath(replacement, directory), mode: 0o700 });
      for (const name of launchFiles) {
        await expect(access(join(backupRoot, "pi-agent", name))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(join(replacement, "filesystem", "pi-agent", name))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await readFile(join(replacement, "filesystem", "pi-agent", "retained.txt"), "utf8")).toBe("agent home state");
      const stoppedAtOpen = new Error("checked Pi cold-open boundary");
      let openedPath: string | undefined;
      const driver = new PiRpcDriver({ runtimeDirectory: join(replacement, "filesystem", "pi"),
        model: "neutral/model", piRpcThinkingLevel: "high",
        environment: { PI_CODING_AGENT_DIR: join(replacement, "filesystem", "pi-agent") },
        transportFactory: options => {
          openedPath = options.args![options.args!.indexOf("--session") + 1];
          expect(openedPath).toBe(transcriptPath(replacement));
          expect(readFileSync(openedPath!)).toEqual(transcript);
          // No native process or model needed: inspect before transport startup.
          throw stoppedAtOpen;
        },
      });
      await expect(driver.openSession({ runId: "follow-up", normalizedSessionId: sessionId, workingDirectory: replacement }))
        .rejects.toBe(stoppedAtOpen);
      expect(openedPath).toBe(transcriptPath(replacement));
      expect(await readFile(join(backupRoot, "pi", `${sessionId}.jsonl`))).toEqual(transcript);
      expect((await stat(join(replacement, "filesystem", "pi"))).mode & 0o777).toBe(0o700);
      const restored = await stat(transcriptPath(replacement));
      expect(restored.mode & 0o777).toBe(0o600);
      expect(restored.uid).toBe(process.getuid!());
      // Previous releases omitted pi/: never accept that incomplete shape as
      // a complete recovery copy (the missing transcript cannot be invented).
      await writeFile(join(backupRoot, "manifest.json"), JSON.stringify({ ...manifest,
        directories: manifest.directories.filter(directory => directory.name !== "pi") }));
      expect(await verifyNativeHarnessBackupStreamed({ root: controller, execution, runnerInstanceId: "runner-1" })).toBeNull();
      await writeFile(join(backupRoot, "manifest.json"), JSON.stringify(manifest));
      // A later corruption of the transcript invalidates the verified backup.
      await writeFile(join(backupRoot, "pi", `${sessionId}.jsonl`), "corrupt");
      expect(await verifyNativeHarnessBackupStreamed({ root: controller, execution, runnerInstanceId: "runner-1" })).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
