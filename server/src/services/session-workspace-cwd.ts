import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_CWD_SYSTEM_ROOTS = new Set([
  "/",
  "/tmp",
  "/var",
  "/var/tmp",
  "/var/run",
  "/usr",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/private",
  "/private/tmp",
]);

export function isUnsafeSessionWorkspaceCwd(cwd: string | null | undefined): boolean {
  const value = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  if (!value) return false;
  const normalized = path.resolve(value);
  if (SESSION_CWD_SYSTEM_ROOTS.has(normalized)) return true;
  const physicalPath = (input: string) => {
    try { return realpathSync(input); } catch { return path.resolve(input); }
  };
  const workspace = physicalPath(normalized);
  if (SESSION_CWD_SYSTEM_ROOTS.has(workspace)) return true;
  // Snapshots and sandbox-sync staging live under the actual runtime temp root.
  // A workspace may be a concrete child, but never that root or its ancestor,
  // including a symlink alias (or a non-default TMPDIR).
  const relative = path.relative(workspace, physicalPath(os.tmpdir()));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
