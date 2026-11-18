import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { inventoryPiRuntimeFiles } from "../acpx/pi-verified-runtime.js";
import { PI_RPC_DISTRIBUTION } from "./generated-distribution.js";

export { PI_RPC_DISTRIBUTION } from "./generated-distribution.js";

/** Native-only installation admission. The manifest in an installed tree is
 * never an authority: every regular byte is checked against the source pin.
 * The runner-owned Node, proxy and returned raw CLI are separately opened by
 * Rust's verified launch; this verifier is not itself a process lease.
 */
export async function verifyPiRpcDistribution(runtimeRoot: string, target = `${process.platform}-${process.arch}`) {
  const expected = PI_RPC_DISTRIBUTION.targets[target as keyof typeof PI_RPC_DISTRIBUTION.targets];
  if (!expected) throw new Error(`Native Pi RPC distribution target unsupported: ${target}`);
  if (!(await lstat(runtimeRoot)).isDirectory() || (await lstat(runtimeRoot)).isSymbolicLink()) throw new Error("Native Pi RPC root must be a regular directory");
  const root = await realpath(runtimeRoot);
  const inventory = await inventoryPiRuntimeFiles(root);
  const entries = await Promise.all(inventory.map(async file => {
    if (file.kind !== "file") throw new Error("Native Pi RPC distribution permits regular files only");
    const stat = await lstat(join(root, file.path));
    return { path: file.path, sha256: file.sha256.slice(7), size: stat.size, executable: Boolean(stat.mode & 0o111) };
  }));
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const closureDigest = `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
  if (closureDigest !== expected.closureSha256) throw new Error("Native Pi RPC distribution differs from its trusted complete closure");
  const manifest = JSON.parse(await readFile(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
  if (manifest.name !== PI_RPC_DISTRIBUTION.runtimePackage || manifest.version !== PI_RPC_DISTRIBUTION.runtimeVersion
    || manifest.bin?.pi !== "dist/bundle/cli.js" || manifest.engines?.node !== ">=22.19.0") throw new Error("Native Pi RPC package declaration differs from its admitted release");
  return { executable: join(root, PI_RPC_DISTRIBUTION.entrypoint), runtimeRoot: root, closureDigest,
    version: PI_RPC_DISTRIBUTION.runtimeVersion };
}
