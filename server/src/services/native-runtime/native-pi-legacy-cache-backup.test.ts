import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { localCheckpointDirectoryExclusions, remoteCheckpointDirectoryExclusions } from "./checkpoint-directory-exclusions.js";
import {
  buildNativeHarnessBackupManifest, buildNativeHarnessBackupManifestStreamed,
  resolveNativeHarnessPersistenceProfile, stageRemoteRunnerDirectory, syncRemoteRunnerDirectoryOut,
  verifyNativeHarnessBackup, verifyNativeHarnessBackupStreamed,
} from "./native-session-executor.js";
import { createNativeHarnessBackupStamp, verifyNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";

// Keep reason: data safety / real catch. Optional derived state must not erase
// trace bytes or contaminate backups, even when no Pi launch preceded capture.
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(transfer: "archive" | "sync" | "full-disk-stream" = "archive") {
  const root = await mkdtemp(join(tmpdir(), "pi-legacy-backup-")); roots.push(root);
  const calls: string[] = [], copies: string[] = [];
  let injectedDiskFull = false;
  const execute = async ({ command, args, stdin }: { command: string; args: string[]; stdin?: string }) => {
    calls.push(args.join(" "));
    if (transfer === "full-disk-stream" && args.join(" ").includes("'--exclude=./node-compile-cache'") && args.join(" ").includes(" -cf ")) {
      injectedDiskFull = true;
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "tar: No space left on device" };
    }
    const result = spawnSync(command, args, { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { exitCode: result.status ?? 1, timedOut: false, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
  };
  const copy = async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string; mode?: number; exclude?: string[] }> }>) => {
    for (const operation of operations) for (const file of operation.files) {
      // A provider-native unanchored exclusion is NOT an acceptable fallback.
      expect(file.exclude).toBeUndefined();
      for (const path of [file.sourcePath, file.targetPath]) expect(relative(root, path)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
      copies.push(file.sourcePath);
      await mkdir(join(file.targetPath, ".."), { recursive: true, mode: 0o700 });
      await cp(file.sourcePath, file.targetPath, { recursive: true, verbatimSymlinks: true });
      if (file.mode !== undefined) await chmod(file.targetPath, file.mode);
    }
  };
  const runner = { execute, ...(transfer !== "archive" ? { syncIn: copy, syncOut: copy } : {}) };
  return { root, runner, calls, copies, diskFull: () => injectedDiskFull };
}

it.each(["archive", "sync", "full-disk-stream"] as const)("copies and stamps zero legacy cache paths without deleting source bytes (%s)", async transfer => {
  for (const layout of ["local", "remote"] as const) {
    const f = await fixture(transfer), sessionId = `pi-${layout}`, scope = `${transfer}-${layout}`;
    const base = join(f.root, "durable-sessions"), controller = join(base, createHash("sha256").update(scope).digest("hex"));
    const live = join(base, "live"), backup = join(controller, "failover-backups", "current"), restored = join(base, "replacement");
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
    const execution = {
      provider: { kind: "pi_rpc", model: "neutral/model", piRpcThinkingLevel: "off" },
      binding: { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", executionWorkspaceId: "workspace" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: sessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    } as unknown as NativeExecutionInputV1;
    const profile = resolveNativeHarnessPersistenceProfile(execution);
    const pathFor = (sandbox: string, directory: { name: string; location: string }) =>
      directory.location === "runner" || layout === "local" ? join(sandbox, directory.name) : join(sandbox, "filesystem", directory.name);
    for (const directory of profile.directories) await mkdir(pathFor(live, directory), { recursive: true, mode: 0o700 });
    const runtime = pathFor(live, { name: "pi", location: "filesystem" }), legacy = join(runtime, "node-compile-cache", "v24");
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    await writeFile(join(legacy, "bytecode"), "DERIVED_OLD_CACHE");
    const trace = '{"type":"session","version":3,"id":"trace"}\n';
    await writeFile(join(runtime, `${sessionId}.jsonl`), trace, { mode: 0o600 });
    for (const directory of profile.directories) await syncRemoteRunnerDirectoryOut({ runner: f.runner as never,
      sourcePath: pathFor(live, directory), targetPath: join(backup, directory.name), mode: 0o700,
      excludeEntries: directory.excludeEntries, excludeDirectories: directory.excludeDirectories });
    expect(await readFile(join(legacy, "bytecode"), "utf8")).toBe("DERIVED_OLD_CACHE");
    const cachePaths = (await readdir(backup, { recursive: true })).filter(path => path.split(/[\\/]/u).includes("node-compile-cache"));
    expect(cachePaths).toEqual([]);
    expect(await readFile(join(backup, "pi", `${sessionId}.jsonl`), "utf8")).toBe(trace);
    const input = { backupRoot: backup, execution, runnerInstanceId: "runner", sourceProviderLeaseId: "old-lease", providerSessionIdentity: { providerSessionId: sessionId }, completedAt: "2026-11-14T00:00:00.000Z" };
    const manifest = await buildNativeHarnessBackupManifestStreamed(input);
    expect(buildNativeHarnessBackupManifest(input)).toEqual(manifest);
    expect(manifest.directories.find(directory => directory.name === "pi")!.bytes).toBe(Buffer.byteLength(trace));
    await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: join(backup, "manifest.json"), sessionScopeId: scope,
      authorizedProviderLeaseId: "new-lease", normalizedSessionId: sessionId, runnerInstanceId: "runner", completedAt: manifest.completedAt });
    const verifyAll = async (valid: boolean) => {
      const actual = {
        stamp: verifyNativeHarnessBackupStamp(stamp, "new-lease"),
        stampAsync: await verifyNativeHarnessBackupStampAsync(stamp, "new-lease", new AbortController().signal, backup),
        manifest: verifyNativeHarnessBackup({ root: controller, execution, runnerInstanceId: "runner" }) !== null,
        manifestStreamed: await verifyNativeHarnessBackupStreamed({ root: controller, execution, runnerInstanceId: "runner" }) !== null,
      };
      for (const value of Object.values(actual)) expect(value).toBe(valid);
      return actual;
    };
    const initialVerification = await verifyAll(true);
    // The manifest inventories copied state, not uncopied source caches.
    await writeFile(join(legacy, "bytecode"), "SOURCE_STILL_PRESENT"); await verifyAll(true);
    // A verifier must NOT silently skip a cache which appears in its copied tree.
    await mkdir(join(backup, "pi", "node-compile-cache"));
    await writeFile(join(backup, "pi", "node-compile-cache", "unexpected"), "UNMANIFESTED");
    const pollutedVerification = await verifyAll(false);
    await rm(join(backup, "pi", "node-compile-cache"), { recursive: true }); await verifyAll(true);
    for (const directory of profile.directories) await stageRemoteRunnerDirectory({ target: { kind: "remote", transport: "provider", remoteCwd: restored } as never,
      runner: f.runner as never, sourcePath: join(backup, directory.name), targetPath: pathFor(restored, directory), mode: 0o700,
      excludeDirectories: directory.excludeDirectories });
    expect(await readFile(join(pathFor(restored, { name: "pi", location: "filesystem" }), `${sessionId}.jsonl`), "utf8")).toBe(trace);
    expect(f.diskFull()).toBe(transfer === "full-disk-stream");
    if (transfer === "sync") expect(f.copies.some(path => path.includes(".paperclip-checkpoint-"))).toBe(true);
    if (process.env.JUDGE_PROOF_DIRECTORY) {
      const out = process.env.JUDGE_PROOF_DIRECTORY; await mkdir(out, { recursive: true });
      await cp(base, join(out, scope), { recursive: true });
      await writeFile(join(out, scope + ".json"), JSON.stringify({ transfer, layout, cachePaths, manifest, stamp,
        sourceBytes: await readFile(join(legacy, "bytecode"), "utf8"), initialVerification, pollutedVerification,
        fullDiskStreamingFallback: f.diskFull(), sourceCommands: f.calls, copiedPaths: f.copies }, null, 2) + "\n");
    }
  }
});

it.each(["archive", "sync", "full-disk-stream"] as const)("matches only the exact root directory, not files or nested/nearby names (%s)", async transfer => {
  const f = await fixture(transfer), source = join(f.root, "source"), target = join(f.root, "target");
  for (const name of ["node-compile-cache", "nested/node-compile-cache", "node-compile-cache-keep"])
    await mkdir(join(source, name), { recursive: true, mode: 0o700 });
  await writeFile(join(source, "node-compile-cache", "derived"), "CACHE");
  await writeFile(join(source, "nested", "node-compile-cache", "trace.jsonl"), "NESTED_TRACE");
  await writeFile(join(source, "node-compile-cache-keep", "trace.jsonl"), "NEARBY_TRACE");
  await syncRemoteRunnerDirectoryOut({ runner: f.runner as never, sourcePath: source, targetPath: target, mode: 0o700, excludeDirectories: ["node-compile-cache"] });
  await expect(lstat(join(target, "node-compile-cache"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(target, "nested", "node-compile-cache", "trace.jsonl"), "utf8")).toBe("NESTED_TRACE");
  expect(await readFile(join(target, "node-compile-cache-keep", "trace.jsonl"), "utf8")).toBe("NEARBY_TRACE");
  await rm(join(source, "node-compile-cache"), { recursive: true });
  await writeFile(join(source, "node-compile-cache"), "REAL_FILE_NOT_A_CACHE_DIRECTORY");
  await syncRemoteRunnerDirectoryOut({ runner: f.runner as never, sourcePath: source, targetPath: join(f.root, "file-target"), mode: 0o700, excludeDirectories: ["node-compile-cache"] });
  expect(await readFile(join(f.root, "file-target", "node-compile-cache"), "utf8")).toBe("REAL_FILE_NOT_A_CACHE_DIRECTORY");
});

it("does not exclude or follow symlinks, including symlink ancestors, on either host", async () => {
  const f = await fixture(), source = join(f.root, "source"), external = join(f.root, "evidence");
  await mkdir(source); await mkdir(join(external, "node-compile-cache"), { recursive: true });
  await writeFile(join(external, "node-compile-cache", "trace.jsonl"), "DO_NOT_FOLLOW");
  await symlink(external, join(source, "alias"));
  await symlink(external, join(source, "node-compile-cache"));
  const entries = ["node-compile-cache", "alias/node-compile-cache"];
  expect(await localCheckpointDirectoryExclusions(source, entries)).toEqual([]);
  expect(await remoteCheckpointDirectoryExclusions({ runner: f.runner as never, sourcePath: source, entries })).toEqual([]);
  const restored = join(f.root, "restored");
  await stageRemoteRunnerDirectory({ target: { kind: "remote", transport: "provider", remoteCwd: restored } as never,
    runner: f.runner as never, sourcePath: source, targetPath: restored, mode: 0o700, excludeDirectories: entries });
  expect((await lstat(join(restored, "node-compile-cache"))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(restored, "node-compile-cache"))).toBe(external);
  // The normal archive safety rule refuses symlinks rather than erasing them.
  await expect(syncRemoteRunnerDirectoryOut({ runner: f.runner as never, sourcePath: source,
    targetPath: join(f.root, "unsafe-backup"), mode: 0o700, excludeDirectories: entries })).rejects.toThrow("runner_remote_checkpoint_archive_unsafe_entry");
  expect(await readFile(join(external, "node-compile-cache", "trace.jsonl"), "utf8")).toBe("DO_NOT_FOLLOW");
  expect((await lstat(join(source, "node-compile-cache"))).isSymbolicLink()).toBe(true);
});

it.each(["archive", "sync"] as const)("restores an old full-tree backup while preserving its legacy cache and original stamp (%s)", async transfer => {
  const f = await fixture(transfer), scope = "old-saved-state", sessionId = "old-session";
  // Controller-side filtered restore staging must also stay inside this owned
  // fixture; keep the sandbox boundary check strict rather than waiving it.
  vi.stubEnv("TMPDIR", f.root);
  const base = join(f.root, "durable-sessions"), controller = join(base, createHash("sha256").update(scope).digest("hex"));
  const backup = join(controller, "failover-backups", "current"), restored = join(f.root, "restored");
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
  const execution = { provider: { kind: "pi_rpc", model: "neutral/model", piRpcThinkingLevel: "off" },
    binding: { companyId: "company", agentId: "agent", issueId: "issue", runId: "old-run", executionWorkspaceId: "workspace" },
    workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: sessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
  } as unknown as NativeExecutionInputV1;
  const profile = resolveNativeHarnessPersistenceProfile(execution);
  for (const directory of profile.directories) await mkdir(join(backup, directory.name), { recursive: true, mode: 0o700 });
  const legacy = join(backup, "pi", "node-compile-cache"); await mkdir(legacy);
  await writeFile(join(legacy, "old-bytecode"), "OLD_CACHE_MUST_REMAIN");
  await writeFile(join(backup, "pi", `${sessionId}.jsonl`), "OLD_CONVERSATION_TRACE");
  // The previous release's manifest is a full-tree digest, including its cache.
  const manifest = buildNativeHarnessBackupManifest({ backupRoot: backup, execution, runnerInstanceId: "runner",
    sourceProviderLeaseId: "old-lease", providerSessionIdentity: { providerSessionId: sessionId } });
  expect(manifest.directories.find(directory => directory.name === "pi")!.bytes)
    .toBe(Buffer.byteLength("OLD_CACHE_MUST_REMAINOLD_CONVERSATION_TRACE"));
  await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest));
  const stamp = createNativeHarnessBackupStamp({ manifestPath: join(backup, "manifest.json"), sessionScopeId: scope,
    authorizedProviderLeaseId: "new-lease", normalizedSessionId: sessionId, runnerInstanceId: "runner", completedAt: manifest.completedAt });
  expect(verifyNativeHarnessBackupStamp(stamp, "new-lease")).toBe(true);
  for (const directory of profile.directories) await stageRemoteRunnerDirectory({ target: { kind: "remote", transport: "provider", remoteCwd: restored } as never,
    runner: f.runner as never, sourcePath: join(backup, directory.name), targetPath: join(restored, directory.name), mode: 0o700,
    excludeDirectories: directory.excludeDirectories });
  expect(await readFile(join(restored, "pi", `${sessionId}.jsonl`), "utf8")).toBe("OLD_CONVERSATION_TRACE");
  await expect(lstat(join(restored, "pi", "node-compile-cache"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(legacy, "old-bytecode"), "utf8")).toBe("OLD_CACHE_MUST_REMAIN");
  expect(verifyNativeHarnessBackupStamp(stamp, "new-lease")).toBe(true);
  expect(await verifyNativeHarnessBackupStampAsync(stamp, "new-lease", new AbortController().signal, backup)).toBe(true);
});

it.each(["../evidence", "/absolute", "node-compile-cache/", "nested//cache", "cache*", "cache;rm"])("refuses invalid directory exclusions without mutating source: %s", async entry => {
  const f = await fixture(), source = join(f.root, "source"); await mkdir(source);
  await writeFile(join(source, "trace.jsonl"), "KEEP");
  await expect(syncRemoteRunnerDirectoryOut({ runner: f.runner as never, sourcePath: source,
    targetPath: join(f.root, "target"), mode: 0o700, excludeDirectories: [entry] })).rejects.toThrow("runner_remote_checkpoint_exclusion_invalid");
  expect(await readFile(join(source, "trace.jsonl"), "utf8")).toBe("KEEP");
});
