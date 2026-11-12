import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

export type RuntimeStageAsset = { sourcePath: string; targetPath: string; mode: number; kind: "file" | "directory" };
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

async function assetDigest(root: string, kind: RuntimeStageAsset["kind"], mode: number): Promise<string> {
  const entries: unknown[] = [];
  const visit = async (relative: string): Promise<void> => {
    const path = relative ? join(root, relative) : root;
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
        (!relative && (kind === "directory") !== stat.isDirectory())) throw new Error("runtime_asset_not_regular");
    if (stat.isDirectory()) {
      // Archive extraction normalizes write permissions through its umask.
      // Compare executable semantics, and enforce the full explicit mapping
      // mode for standalone files (notably private runtime-context.json).
      entries.push(["directory", relative]);
      for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else entries.push(["file", relative, relative ? stat.mode & 0o111 : mode, sha(await readFile(path))]);
  };
  await visit("");
  return sha(JSON.stringify(entries));
}

// One remote invocation, irrespective of the number of bundles or files. Hash
// actual bytes rather than trusting a retained manifest/stamp that can outlive
// its files. No credential, auth home or writable working copy is cached here.
const REMOTE_RUNTIME_ASSET_HASH_SCRIPT = `
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const assets = JSON.parse(process.argv[1]);
const hashes = assets.map(({ targetPath: root, kind }) => {
  try {
    const entries = [];
    function visit(relative) {
      const file = relative ? path.join(root, relative) : root;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
          (!relative && (kind === "directory") !== stat.isDirectory())) throw Error("runtime_asset_not_regular");
      if (stat.isDirectory()) {
        entries.push(["directory", relative]);
        for (const name of fs.readdirSync(file).sort()) visit(relative ? relative + "/" + name : name);
      } else entries.push(["file", relative, stat.mode & (relative ? 0o111 : 0o777), sha(fs.readFileSync(file))]);
    }
    visit("");
    return sha(JSON.stringify(entries));
  } catch { return null; }
});
process.stdout.write(JSON.stringify(hashes));
`;

export async function changedRemoteRuntimeAssets(
  execute: CommandManagedRuntimeRunner["execute"], assets: RuntimeStageAsset[],
): Promise<RuntimeStageAsset[]> {
  if (!assets.length) return [];
  const expected: string[] = [];
  try {
    // Async filesystem reads keep the server responsive; visit sequentially so
    // large skill sets do not retain every bundle's bytes at the same time.
    for (const asset of assets) expected.push(await assetDigest(asset.sourcePath, asset.kind, asset.mode));
  } catch { return assets; } // Unsupported local trees keep the ordinary upload path.
  const result = await execute({ command: "node", args: ["-e", REMOTE_RUNTIME_ASSET_HASH_SCRIPT,
    JSON.stringify(assets.map(({ targetPath, kind }) => ({ targetPath, kind })))],
    bypassSession: true, timeoutMs: 10_000 }).catch(() => null);
  // An old host, failed probe or malformed response is never proof of a hit.
  // Preserve the ordinary upload path rather than adding a new startup failure.
  if (!result || result.exitCode !== 0 || result.timedOut) return assets;
  let actual: unknown;
  try { actual = JSON.parse(result.stdout); } catch { return assets; }
  if (!Array.isArray(actual) || actual.length !== assets.length) return assets;
  return assets.filter((_, index) => typeof actual[index] !== "string" || actual[index] !== expected[index]);
}
