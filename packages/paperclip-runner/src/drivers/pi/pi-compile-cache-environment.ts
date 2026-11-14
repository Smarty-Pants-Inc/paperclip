import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { nodeCompileCacheEnvironment } from "../../node-compile-cache-environment.js";

/** Derived Node code is host-local, not Pi conversation state. Reuse one private
 * cache per execution uid outside the trees retained for backup and evidence.
 * Never chmod an existing directory: the shared helper must verify its owner,
 * permissions and writeability, or disable this optional optimization. */
export async function piCompileCacheEnvironment(runtimeDirectory: string): Promise<NodeJS.ProcessEnv> {
  try {
    const temporaryDirectory = await realpath(tmpdir());
    // A custom TMPDIR inside the session would reintroduce cache replication.
    // The caller supplies the physical runtime directory, not a symlink alias.
    const root = join(temporaryDirectory, `paperclip-pi-cache-${process.getuid?.() ?? process.pid}`);
    const within = relative(runtimeDirectory, root);
    if (within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`))) {
      return nodeCompileCacheEnvironment();
    }
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return nodeCompileCacheEnvironment(root, { enableLocalCache: true });
  } catch {
    return nodeCompileCacheEnvironment();
  }
}
