import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { nodeCompileCacheEnvironment } from "../../node-compile-cache-environment.js";

function contains(parent: string, child: string): boolean {
  const within = relative(parent, child);
  return within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`));
}

function persistedDirectories(runtimeDirectory: string, additional: readonly string[]): string[] {
  let session = runtimeDirectory;
  if (basename(session) === "pi") {
    session = dirname(session);
    if (basename(session) === "filesystem") session = dirname(session);
  }
  const roots = [runtimeDirectory, session, ...additional];
  for (let ancestor = session; ; ancestor = dirname(ancestor)) {
    if (["durable-sessions", ".paperclip-runtime"].includes(basename(ancestor))) roots.push(ancestor);
    if (dirname(ancestor) === ancestor) break;
  }
  return roots;
}

export async function removeLegacyPiCompileCache(runtimeDirectory: string): Promise<void> {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const runtime = await lstat(runtimeDirectory);
    if (!runtime.isDirectory() || runtime.uid !== uid || await realpath(runtimeDirectory) !== runtimeDirectory) return;
    const cache = join(runtimeDirectory, "node-compile-cache");
    const metadata = await lstat(cache);
    if (!metadata.isDirectory() || metadata.uid !== uid) return;
    await rm(cache, { recursive: true, force: true });
  } catch {
  }
}

async function seedImageCache(source: string, root: string, cache: string): Promise<void> {
  let staging: string | undefined;
  try {
    if ((await readdir(cache)).length) return;
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const sourceMetadata = await lstat(source);
    const protectedSource = sourceMetadata.isDirectory() && sourceMetadata.uid === uid && (sourceMetadata.mode & 0o077) === 0;
    let entries = 0, bytes = 0;
    const copy = async (from: string, to: string, depth: number): Promise<void> => {
      if (++entries > 10_000 || depth > 4) throw new Error("pi_compile_cache_seed_limit");
      const metadata = await lstat(from);
      if ((metadata.uid !== uid && metadata.uid !== 0) || (!protectedSource && (metadata.mode & 0o022) !== 0)) throw new Error("pi_compile_cache_seed_unsafe");
      if (metadata.isDirectory()) {
        await mkdir(to, { mode: 0o700 });
        for (const name of await readdir(from)) await copy(join(from, name), join(to, name), depth + 1);
      } else if (metadata.isFile()) {
        bytes += metadata.size;
        if (bytes > 128 * 1024 * 1024) throw new Error("pi_compile_cache_seed_limit");
        const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await input.stat();
          if (!before.isFile() || before.dev !== metadata.dev || before.ino !== metadata.ino || before.size !== metadata.size) throw new Error("pi_compile_cache_seed_changed");
          const output = await open(to, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          try {
            let copied = 0;
            for await (const chunk of input.createReadStream({ autoClose: false })) {
              copied += chunk.length;
              if (copied > metadata.size) throw new Error("pi_compile_cache_seed_changed");
              await output.writeFile(chunk);
            }
          } finally { await output.close(); }
          const after = await input.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("pi_compile_cache_seed_changed");
        } finally { await input.close(); }
      } else throw new Error("pi_compile_cache_seed_unsafe");
    };
    if (await realpath(source) !== source) return;
    staging = await mkdtemp(join(root, ".image-seed-"));
    const candidate = join(staging, "node-compile-cache");
    await copy(source, candidate, 0);
    if (!(await readdir(cache)).length) await rename(candidate, cache);
  } catch {
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function piCompileCacheEnvironment(runtimeDirectory: string, additionalPersistedDirectories: readonly string[] = []): Promise<NodeJS.ProcessEnv> {
  try {
    const temporaryDirectory = await realpath(tmpdir());
    const root = join(temporaryDirectory, `paperclip-pi-cache-${process.getuid?.() ?? process.pid}`);
    const physicalRuntime = await realpath(runtimeDirectory);
    const persistedRoots = [...persistedDirectories(runtimeDirectory, additionalPersistedDirectories), ...persistedDirectories(physicalRuntime, [])];
    for (const persisted of new Set(persistedRoots)) {
      let ancestor = resolve(persisted), suffix = "";
      while (true) {
        try {
          if (contains(join(await realpath(ancestor), suffix), root)) return nodeCompileCacheEnvironment();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
          suffix = join(basename(ancestor), suffix); ancestor = dirname(ancestor);
        }
      }
    }
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const environment = nodeCompileCacheEnvironment(root, { enableLocalCache: true });
    if (!environment.NODE_DISABLE_COMPILE_CACHE) {
      await seedImageCache(join(physicalRuntime, "node-compile-cache"), root, environment.NODE_COMPILE_CACHE!);
      await seedImageCache(join(temporaryDirectory, "node-compile-cache"), root, environment.NODE_COMPILE_CACHE!);
    }
    return environment;
  } catch {
    return nodeCompileCacheEnvironment();
  }
}
