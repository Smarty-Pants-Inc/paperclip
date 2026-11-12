import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { changedRemoteRuntimeAssets } from "./remote-runtime-assets.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-asset-cache-")); roots.push(root);
  const assets = ["instructions", "skill", "runtime-context.json"].map(name => ({
    sourcePath: join(root, "source", name), targetPath: join(root, "remote", name),
    mode: name.endsWith(".json") ? 0o600 : 0o555,
    kind: name.endsWith(".json") ? "file" as const : "directory" as const,
  }));
  for (const asset of assets) {
    await mkdir(asset.kind === "directory" ? asset.sourcePath : join(root, "source"), { recursive: true });
    await writeFile(asset.kind === "directory" ? join(asset.sourcePath, "CONTENT.md") : asset.sourcePath, "selected content");
  }
  const execute = vi.fn(async ({ command, args }: { command: string; args?: string[] }) => {
    const { stdout, stderr } = await exec(command, args ?? []);
    return { stdout, stderr, exitCode: 0, timedOut: false, signal: null, pid: null, startedAt: null };
  });
  const copy = async () => {
    await mkdir(join(root, "remote"), { recursive: true });
    for (const asset of assets) {
      await cp(asset.sourcePath, asset.targetPath, { recursive: true });
      if (asset.kind === "file") await chmod(asset.targetPath, asset.mode);
    }
  };
  return { root, assets, execute, copy };
}

// Keep: data safety. Exercise actual local/remote bytes, not caller-supplied
// manifest digests, so a stale or corrupted retained copy cannot suppress upload.
it("uses one remote read for all missing, unchanged and individually changed assets", async () => {
  const f = await fixture();
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual(f.assets);
  expect(f.execute).toHaveBeenCalledTimes(1);
  await f.copy(); f.execute.mockClear();
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual([]);
  expect(f.execute).toHaveBeenCalledTimes(1);
  await writeFile(join(f.assets[1]!.targetPath, "CONTENT.md"), "corrupted remote copy");
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual([f.assets[1]]);
  await f.copy();
  await writeFile(f.assets[2]!.sourcePath, "fresh run grant");
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual([f.assets[2]]);
});

it("does not trust a previous hit after remote files disappear", async () => {
  const f = await fixture(); await f.copy();
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual([]);
  await rm(join(f.assets[0]!.targetPath, "CONTENT.md"));
  await rm(f.assets[2]!.targetPath);
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual([f.assets[0], f.assets[2]]);
});

it("hashes paths, executable bits and empty directories as well as content", async () => {
  const f = await fixture(); await f.copy();
  await mkdir(join(f.assets[0]!.targetPath, "stale-empty-directory"));
  await chmod(join(f.assets[1]!.targetPath, "CONTENT.md"), 0o755);
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual(f.assets.slice(0, 2));
});

it("does not cache a private context file made readable", async () => {
  const f = await fixture(); await f.copy();
  await chmod(f.assets[2]!.targetPath, 0o644);
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual([f.assets[2]]);
});

it("preserves the upload path if the source cannot be hashed and does not probe empty input", async () => {
  const f = await fixture();
  expect(await changedRemoteRuntimeAssets(f.execute, [])).toEqual([]);
  await rm(f.assets[0]!.sourcePath, { recursive: true });
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual(f.assets);
  expect(f.execute).not.toHaveBeenCalled();
});

it("never accepts a symlink or a failed/malformed hash read as a cache hit", async () => {
  const f = await fixture(); await f.copy();
  await rm(f.assets[0]!.targetPath, { recursive: true });
  await symlink(f.assets[0]!.sourcePath, f.assets[0]!.targetPath);
  expect(await changedRemoteRuntimeAssets(f.execute, f.assets)).toEqual([f.assets[0]]);
  for (const response of ["", "null", "[]", "{}", '["not-a-hash"]']) {
    const execute = vi.fn(async () => ({ stdout: response, stderr: "", exitCode: 0, timedOut: false }));
    expect(await changedRemoteRuntimeAssets(execute as never, f.assets)).toEqual(f.assets);
  }
  expect(await changedRemoteRuntimeAssets(vi.fn().mockRejectedValue(new Error("offline")), f.assets)).toEqual(f.assets);
});
