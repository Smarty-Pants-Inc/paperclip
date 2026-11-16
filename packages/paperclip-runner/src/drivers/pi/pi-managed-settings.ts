import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writePrivateFile } from "../private-file.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > 60 * 1024) throw new Error();
    const settings: unknown = JSON.parse(text);
    if (!record(settings) || (settings.compaction !== undefined && !record(settings.compaction))) throw new Error();
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Pi settings.json could not be read as bounded JSON; refusing to overwrite it (content redacted)");
  }
}

function explicitReserve(settings: Record<string, unknown>, model: string): unknown {
  const compaction = record(settings.compaction) ? settings.compaction : {};
  const overrides = record(compaction.modelOverrides) ? compaction.modelOverrides : {};
  const override = record(overrides[model]) ? overrides[model] : {};
  return override.reserveTokens ?? compaction.reserveTokens;
}

/** V2-R2 row 1: match v1's 100k headroom on large windows, without
 * exceeding a quarter of a small model's context. Leave Pi's other defaults alone.
 * Managed-home settings win; otherwise honor the original user's explicit reserve.
 */
function packageNotInstalled(source: string): Error & { code: string } {
  return Object.assign(new Error(`Pi managed npm package ${JSON.stringify(source)} is not installed under the original agent home`), {
    code: "pi_managed_package_not_installed",
  });
}

function npmPackageName(source: string): string | undefined {
  const spec = source.slice("npm:".length).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  const name = match?.[1] ?? spec;
  const valid = name.startsWith("@")
    ? /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(name)
    : /^[a-z0-9][a-z0-9._-]*$/i.test(name);
  return valid ? name : undefined;
}

async function installedNpmPackageRoot(source: string, originalAgentHome: string): Promise<string> {
  const name = npmPackageName(source);
  if (!name) throw packageNotInstalled(source);
  const root = resolve(originalAgentHome, "npm", "node_modules", name);
  try {
    if (!(await stat(root)).isDirectory() || !(await stat(join(root, "package.json"))).isFile()) {
      throw packageNotInstalled(source);
    }
  } catch {
    throw packageNotInstalled(source);
  }
  return root;
}

async function rewriteManagedPackages(settings: Record<string, unknown>, originalAgentHome: string): Promise<{
  settings: Record<string, unknown>; changed: boolean;
}> {
  if (!Array.isArray(settings.packages)) return { settings, changed: false };
  let changed = false;
  const packages: unknown[] = [];
  for (const entry of settings.packages) {
    const source = typeof entry === "string" ? entry
      : record(entry) && typeof entry.source === "string" ? entry.source : undefined;
    if (!source?.startsWith("npm:")) { packages.push(entry); continue; }
    const installed = await installedNpmPackageRoot(source, originalAgentHome);
    if (typeof entry === "string") packages.push(installed);
    else packages.push({ ...entry, source: installed });
    changed ||= installed !== source;
  }
  return { settings: changed ? { ...settings, packages } : settings, changed };
}

/** V2-R2 row 1: match v1's 100k headroom on large windows, without
 * exceeding a quarter of a small model's context. Leave Pi's other defaults alone.
 * Managed-home settings win; otherwise honor the original user's explicit reserve.
 * Pi 1.5.2 loads configured local package paths directly from the installed roots.
 */
export async function configurePiManagedCompaction(input: {
  agentHome: string; originalAgentHome: string; model: string; contextWindow: number;
}): Promise<void> {
  const path = join(input.agentHome, "settings.json");
  const settings = await readSettings(path);
  const hasSettings = await lstat(path).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  const sameHome = resolve(input.originalAgentHome) === resolve(input.agentHome);
  const original = sameHome ? settings : await readSettings(join(input.originalAgentHome, "settings.json"));
  const base = !hasSettings && !sameHome ? original : settings;
  // Validate every package before creating or writing the managed home: Pi must
  // never fall back to installing a missing npm source during startup.
  const rewritten = sameHome ? { settings: base, changed: false }
    : await rewriteManagedPackages(base, input.originalAgentHome);
  const hasExplicitReserve = explicitReserve(settings, input.model) !== undefined;
  if (hasExplicitReserve) {
    if (!rewritten.changed) return;
    await mkdir(input.agentHome, { recursive: true, mode: 0o700 });
    await writePrivateFile(path, `${JSON.stringify(rewritten.settings)}\n`);
    return;
  }
  const reserveTokens = explicitReserve(original, input.model)
    ?? Math.min(100000, Math.floor(input.contextWindow * 0.25));
  const compaction = record(rewritten.settings.compaction) ? rewritten.settings.compaction : {};
  await mkdir(input.agentHome, { recursive: true, mode: 0o700 });
  await writePrivateFile(path, `${JSON.stringify({ ...rewritten.settings, compaction: { ...compaction, reserveTokens } })}\n`);
}
