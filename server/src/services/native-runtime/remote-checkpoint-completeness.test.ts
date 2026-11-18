import { spawnSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncRemoteRunnerDirectoryOut } from "./native-session-executor.js";

// Keep reason: data safety. Execute the real remote shell
// command on real bytes as a non-root user, then take the callers' destructive
// cleanup path only if sync-out resolves. No model, SSH or credentials required.
describe.skipIf(process.platform === "win32")("remote checkpoint completeness before removal", () => {
  let root: string;
  let source: string;
  let target: string;
  let commands: Array<{ script: string; status: number | null; stderr: string }>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "checkpoint-completeness-"));
    source = join(root, "remote 'session");
    target = join(root, "durable");
    await mkdir(source);
    commands = [];
  });
  afterEach(async () => {
    await chmod(join(source, "unreadable.jsonl"), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const executeWith = (shell: "sh" | "dash" | "busybox" = "sh") => async ({ command, args }: { command: string; args: string[] }) => {
    const result = spawnSync(command === "sh" ? shell : command,
      command === "sh" && shell === "busybox" ? ["sh", ...args] : args,
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    commands.push({ script: args[1] ?? "", status: result.status, stderr: result.stderr });
    return { exitCode: result.status, timedOut: false, stdout: result.stdout, stderr: result.stderr };
  };
  const pullThenRemove = async (runner: unknown, excludeEntries?: string[]) => {
    await syncRemoteRunnerDirectoryOut({ runner: runner as never, sourcePath: source, targetPath: target,
      mode: 0o700, excludeEntries });
    await rm(source, { recursive: true });
  };

  // Root bypasses chmod 000; it cannot provide this permission-denial proof.
  it.skipIf(process.getuid?.() === 0)("throws on an unreadable real file and retains the remote root and previous durable checkpoint", async () => {
    await writeFile(join(source, "readable.jsonl"), "retained trace\n");
    await writeFile(join(source, "unreadable.jsonl"), "only remote copy\n");
    await chmod(join(source, "unreadable.jsonl"), 0o000);
    await mkdir(target);
    await writeFile(join(target, "previous.jsonl"), "previous checkpoint\n");
    let failure: unknown;
    try { await pullThenRemove({ execute: executeWith() }); } catch (error) { failure = error; }
    const remoteSurvived = await access(source).then(() => true, () => false);
    console.info(JSON.stringify({ proof: "unreadable-file", uid: process.getuid!(),
      pullThrew: failure instanceof Error, remoteSurvived,
      remoteCommands: commands.map(({ status, stderr }) => ({ status, stderr })) }));
    expect(failure, "pull must throw before the caller removes the only remote copy").toBeInstanceOf(Error);
    expect(remoteSurvived).toBe(true);
    expect(await readFile(join(target, "previous.jsonl"), "utf8")).toBe("previous checkpoint\n");
  });

  for (const shell of ["sh", "dash", "busybox"] as const) {
    const unavailable = !!spawnSync(shell, shell === "busybox" ? ["sh", "-c", ":"] : ["-c", ":"]).error;
    it.skipIf(unavailable)(`propagates tar's own nonzero exit through base64 under ${shell}`, async () => {
      await writeFile(join(source, "trace.jsonl"), "trace\n");
      const bin = join(root, "bin");
      await mkdir(bin);
      const tar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
      // Emit a valid complete archive but report a tar warning/failure afterwards.
      // Manifest comparison alone cannot detect that nonzero tar status.
      await writeFile(join(bin, "tar"), `#!/bin/sh\n'${tar}' "$@"\nexit 2\n`, { mode: 0o755 });
      const execute = executeWith(shell);
      const runner = { execute: async (request: { command: string; args: string[] }) => {
        // BusyBox standalone ash prefers its own applets over PATH. Pin only
        // tar's executable here so all three shells exercise the same failure.
        const script = request.args[1]!.replace(/\btar (?=[^;]*-czf)/, `'${join(bin, "tar")}' `);
        return execute({ ...request, args: [request.args[0]!, script] });
      } };
      await expect(pullThenRemove(runner)).rejects.toThrow("runner_remote_checkpoint_failed");
      await expect(access(source)).resolves.toBeUndefined();
    });
  }

  it.each(["archive", "provider"] as const)("matches real counts/bytes, exclusions and modes on the happy path (%s)", async transfer => {
    await mkdir(join(source, "skip"));
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "trace π\n.jsonl"), "retained π\n", { mode: 0o600 });
    await writeFile(join(source, "empty"), "");
    await writeFile(join(source, "nested", "trace"), "second trace", { mode: 0o600 });
    await writeFile(join(source, "skip", "unreadable"), "excluded");
    await chmod(join(source, "skip", "unreadable"), 0o000);
    const syncOut = async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>) => {
      for (const operation of operations) for (const file of operation.files)
        await cp(file.sourcePath, file.targetPath, { recursive: true });
    };
    try {
      await pullThenRemove({ execute: executeWith(), ...(transfer === "provider" ? { syncOut } : {}) }, ["skip"]);
      expect(await readFile(join(target, "trace π\n.jsonl"), "utf8")).toBe("retained π\n");
      expect(await readFile(join(target, "nested", "trace"), "utf8")).toBe("second trace");
      expect((await stat(join(target, "empty"))).size).toBe(0);
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      expect((await stat(join(target, "trace π\n.jsonl"))).mode & 0o777).toBe(0o600);
      expect(await readdir(target)).not.toContain("skip");
      await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
      console.info(JSON.stringify({ proof: "happy-path", transfer, fileCount: 3,
        totalBytes: Buffer.byteLength("retained π\nsecond trace"), removedOnlyAfterVerifiedPull: true }));
    } finally { await chmod(join(source, "skip", "unreadable"), 0o600).catch(() => undefined); }
  });

  it("keeps the provider full-disk fallback's unanchored exclusions consistent with its manifest", async () => {
    await mkdir(join(source, "skip"));
    await mkdir(join(source, "nested", "skip"), { recursive: true });
    await writeFile(join(source, "trace.jsonl"), "trace\n");
    await writeFile(join(source, "skip", "cache"), "root cache");
    await writeFile(join(source, "nested", "skip", "cache"), "nested cache");
    const execute = executeWith();
    const runner = {
      execute: async (request: { command: string; args: string[] }) => request.args[1]?.includes(" -cf ")
        ? { exitCode: 2, timedOut: false, stdout: "", stderr: "No space left on device" }
        : execute(request),
      syncOut: async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string; exclude?: string[] }> }>) => {
        for (const operation of operations) for (const file of operation.files) {
          expect(file.exclude).toEqual(["skip"]);
          await cp(file.sourcePath, file.targetPath, { recursive: true,
            filter: path => !path.split("/").includes("skip") });
        }
      },
    };
    await pullThenRemove(runner, ["skip"]);
    expect(await readFile(join(target, "trace.jsonl"), "utf8")).toBe("trace\n");
    expect(await readdir(join(target, "nested"))).toEqual([]);
  });

  it("refuses a failed base64 encoder even when tar succeeds", async () => {
    await writeFile(join(source, "trace.jsonl"), "trace\n");
    const execute = executeWith();
    const runner = { execute: async (request: { command: string; args: string[] }) => execute({ ...request,
      args: [request.args[0]!, request.args[1]!.replace("| base64;", "| { base64; exit 3; };")] }) };
    await expect(pullThenRemove(runner)).rejects.toThrow("runner_remote_checkpoint_failed");
    await expect(access(source)).resolves.toBeUndefined();
  });

  it("verifies an empty directory without inventing missing files", async () => {
    await pullThenRemove({ execute: executeWith() });
    expect(await readdir(target)).toEqual([]);
    await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["count", "bytes"] as const)("refuses a successful but incomplete provider copy (%s mismatch)", async mismatch => {
    await writeFile(join(source, "trace.jsonl"), "trace\n");
    await writeFile(join(source, "empty"), "");
    const syncOut = async () => {
      await cp(source, target, { recursive: true });
      if (mismatch === "count") await rm(join(target, "empty"));
      else await writeFile(join(target, "trace.jsonl"), "truncated");
    };
    await expect(pullThenRemove({ execute: executeWith(), syncOut })).rejects.toThrow("runner_remote_checkpoint_manifest_mismatch");
    expect(await readFile(join(source, "trace.jsonl"), "utf8")).toBe("trace\n");
  });

  it.each(["malformed", "timeout"] as const)("refuses an unverifiable remote manifest (%s)", async failure => {
    await writeFile(join(source, "trace.jsonl"), "trace\n");
    const execute = executeWith();
    const runner = { execute: async (request: { command: string; args: string[] }) => {
      if (request.args[1]?.includes("paperclip_sizes=$(find "))
        return { exitCode: 0, timedOut: failure === "timeout", stdout: "not an inventory", stderr: "" };
      return execute(request);
    } };
    await expect(pullThenRemove(runner)).rejects.toThrow("runner_remote_checkpoint_manifest_failed");
    await expect(access(source)).resolves.toBeUndefined();
  });

  it("refuses an archive which silently loses a file after the remote inventory and preserves prior local state", async () => {
    await writeFile(join(source, "trace.jsonl"), "trace\n");
    await writeFile(join(source, "empty"), "");
    await mkdir(target);
    await writeFile(join(target, "previous"), "previous");
    const execute = executeWith();
    const runner = { execute: async (request: { command: string; args: string[] }) => {
      if (request.args[1]?.includes("-czf")) await rm(join(source, "empty"));
      return execute(request);
    } };
    await expect(pullThenRemove(runner)).rejects.toThrow("runner_remote_checkpoint_manifest_mismatch");
    await expect(access(source)).resolves.toBeUndefined();
    expect(await readFile(join(target, "previous"), "utf8")).toBe("previous");
  });
});
