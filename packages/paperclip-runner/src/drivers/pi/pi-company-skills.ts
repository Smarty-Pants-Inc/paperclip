import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

const NAMESPACE = "paperclip-company-skills";
const OWNER = "paperclip.pi.company-skills.v1\n";
const MANAGED_LINK = /^bundle-[a-f0-9]{64}$/u;

/** Use Pi's documented agent directory, not a new empty home for native providers. */
export function piCompanySkillsAgentHome(environment: NodeJS.ProcessEnv): string {
  const selected = environment.PI_CODING_AGENT_DIR
    ?? join(environment.HOME ?? process.env.HOME ?? homedir(), ".pi", "agent");
  if (!selected || !isAbsolute(selected) || selected.includes("\0")) throw new Error("Pi agent directory must be absolute");
  return resolve(selected);
}

/** Publish only admitted roots. Pi recursively discovers SKILL.md through these
 * directory links, preserving bundle bytes and relative supporting-file paths.
 * Refresh deletes only identified symlinks, never a bundle or home resource. */
export async function syncPiCompanySkills(agentHome: string, runtimeContext: unknown): Promise<void> {
  const context = record(runtimeContext);
  if (context.skills === undefined) return;
  if (!Array.isArray(context.skills)) throw new Error("Pi company skills must be an array");
  if (!isAbsolute(agentHome) || agentHome.includes("\0")) throw new Error("Pi agent directory must be absolute");
  const namespace = join(resolve(agentHome), "skills", NAMESPACE);
  const roots = new Set<string>();
  // Validate the entire selection before touching the discovery directory.
  for (const skill of context.skills) {
    const root = record(record(skill).bundle).rootPath;
    if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0") || resolve(root) !== root) throw new Error("Pi company skill bundle.rootPath must be canonical and absolute");
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Pi company skill root must be a directory");
    const skillFile = join(canonical, "SKILL.md");
    if (!(await lstat(skillFile)).isFile()) throw new Error("Pi company skill requires a regular SKILL.md");
    if (contains(namespace, canonical) || contains(canonical, namespace)) throw new Error("Pi company skill cannot overlap its managed namespace");
    roots.add(canonical);
  }
  const skillsDirectory = join(resolve(agentHome), "skills");
  await mkdir(skillsDirectory, { recursive: true });
  if (!(await lstat(skillsDirectory)).isDirectory()) throw new Error("Pi skills directory must not be a symlink");
  try {
    await mkdir(namespace);
    await writeFile(join(namespace, ".owner"), OWNER, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await lstat(namespace)).isDirectory() || !(await lstat(join(namespace, ".owner"))).isFile()
      || await readFile(join(namespace, ".owner"), "utf8") !== OWNER) throw new Error("Pi company skills namespace is not owned");
  const desired = new Map([...roots].map(root => [`bundle-${createHash("sha256").update(root).digest("hex")}`, root]));
  const entries = await readdir(namespace);
  // A real directory/file at a managed name is a conflict, never a deletion target.
  for (const name of entries) {
    if (MANAGED_LINK.test(name) && !(await lstat(join(namespace, name))).isSymbolicLink()) throw new Error("Pi company skills managed path is not a symlink");
  }
  for (const name of entries) {
    if (!MANAGED_LINK.test(name)) continue;
    const path = join(namespace, name);
    if (desired.get(name) === await readlink(path)) { desired.delete(name); continue; }
    await unlink(path);
  }
  for (const [name, root] of desired) await symlink(root, join(namespace, name), "dir");
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
