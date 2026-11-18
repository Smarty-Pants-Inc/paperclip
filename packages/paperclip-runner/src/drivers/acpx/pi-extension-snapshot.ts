import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { configuredEnvironment } from "../../configured-environment.js";
import { createAcpxPrivateSnapshot, type AcpxPrivateSnapshot } from "./private-snapshot.js";
import { inventoryPiRuntimeFiles } from "./pi-verified-runtime.js";

function checkedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(path => typeof path !== "string"
    || !isAbsolute(path) || path === sep || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path))) {
    throw new Error("Pi extensions require at most 32 canonical absolute local paths");
  }
  return [...new Set(value as string[])];
}

/** Only the controller's explicit task environment grants extension authority. */
export function configuredPiExtensions(environment: NodeJS.ProcessEnv | undefined): string[] {
  const raw = configuredEnvironment(environment).PAPERCLIP_PI_EXTENSIONS;
  if (raw === undefined) return [];
  if (Buffer.byteLength(raw) > 32 * 1024) throw new Error("Pi extensions exceed their configuration bound");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Pi extensions require a JSON array of absolute local paths"); }
  return checkedPaths(value);
}

/** Operator configuration, never an ambient or agent-supplied launch variable. */
export function configuredPiNativeExtensions(environment: NodeJS.ProcessEnv | undefined): boolean {
  const mode = configuredEnvironment(environment).PAPERCLIP_PI_EXTENSIONS_MODE;
  if (mode === undefined) return false;
  if (mode !== "native") throw new Error("Pi extensions mode must be native or unset");
  return true;
}

export interface PiExtensionSnapshot {
  snapshot: AcpxPrivateSnapshot;
  paths: string[];
}
const contains = (root: string, path: string) => {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
};

/**
 * Operator-trusted code, not provider-release code. Freeze complete local package
 * trees (a file uses its parent for sibling imports/dependencies), then bind every
 * copied regular file to the same SHA-256 inventory used for Pi distributions.
 * This is a supplemental command lease; it never widens the pinned base closure.
 */
export async function createPiExtensionSnapshot(paths: readonly string[]): Promise<PiExtensionSnapshot> {
  const selected = checkedPaths(paths);
  const candidates = await Promise.all(selected.map(async path => {
    if (await realpath(path) !== path) throw new Error("Pi extensions require canonical paths without symlink aliases");
    const stat = await lstat(path);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error("Pi extensions require a regular file or package directory");
    if (stat.isDirectory()) {
      const manifest = join(path, "package.json");
      try {
        if (!(await lstat(manifest)).isFile() || await realpath(manifest) !== manifest) throw new Error();
        const metadata: unknown = JSON.parse(await readFile(manifest, "utf8"));
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
      } catch { throw new Error("Pi extension package directory requires a regular valid package.json"); }
    }
    const root = stat.isDirectory() ? path : dirname(path);
    if (root === sep) throw new Error("Pi extensions require a dedicated package directory");
    return root;
  }));
  // Coalesce overlapping packages without copying or remapping the same tree twice.
  const roots = [...new Set(candidates)].filter(root => !candidates.some(other => other !== root && contains(other, root)));
  const inventories = await Promise.all(roots.map(root => inventoryPiRuntimeFiles(root)));
  const snapshot = await createAcpxPrivateSnapshot(roots, null);
  try {
    let regularFiles = 0;
    for (const [index, files] of inventories.entries()) for (const file of files) {
      if (file.kind !== "file") continue;
      regularFiles++;
      if (`sha256:${snapshot.digests[join(snapshot.roots[index]!, file.path)]}` !== file.sha256) {
        throw new Error("Pi extension files changed during admission");
      }
    }
    if (Object.keys(snapshot.digests).length !== regularFiles) throw new Error("Pi extension inventory changed during admission");
    return { snapshot, paths: selected.map(path => {
      const index = roots.findIndex(root => contains(root, path));
      return join(snapshot.roots[index]!, relative(roots[index]!, path));
    }) };
  } catch (error) { await snapshot.close(); throw error; }
}
