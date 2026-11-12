import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PiNativeAdmissionError } from "../../pi-native-config.js";

export const NATIVE_HOME_SCHEMA = "pi-native-home/v1" as const;
export type NativeHomeEnvironment = Readonly<Record<string, string | undefined>>;
export function nativeHomeEnvironment(env: NativeHomeEnvironment) {
  const value = (key: string) => env[key] === undefined ? { present: false as const } : { present: true as const, value: env[key] };
  return { PI_OFFLINE: value("PI_OFFLINE"), PI_SKIP_VERSION_CHECK: value("PI_SKIP_VERSION_CHECK") };
}
const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Canonical JSON: recursively bytewise-key-sorted objects, ordered arrays, no non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort(bytewise).map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new PiNativeAdmissionError("pi_home_not_json", "Native home metadata is not canonical JSON.");
}
export function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
export interface NativeHomeEntry {
  logicalPath: string;
  resolvedPath: string;
  kind: "file" | "directory" | "symlink" | "absent" | "host-reference" | "dependency";
  length?: number;
  executableBits?: number;
  sha256?: string;
  target?: string;
}
export interface NativeHomePackage {
  source: string;
  root: string;
  name: string;
  version: string;
  extensionSelectors: string[];
}
export interface NativeHomePackageSelection {
  source: string;
  extensions?: string[];
  autoload?: boolean;
}
export interface NativeHomeSettings {
  packages?: readonly (string | NativeHomePackageSelection)[];
  extensions?: readonly string[];
}
export interface NativeHomeInput {
  /** Pass Pi's resolved getAgentDir() from the sandbox itself; never a Runner mirror. */
  agentDir: string;
  /** Actual native resolved package inventory, not inferred npm installation locations. */
  packages: readonly { source: string; root: string }[];
  /** Actual selected roots, including lazy skill supporting files, system/append and prompt sources. */
  resources: readonly { kind: "extension" | "skill" | "prompt" | "system" | "append-system" | "agents"; path: string; source: string }[];
  allowedExternalRoots: readonly string[];
  environment: NativeHomeEnvironment;
  /** argv contains resource selectors/exclusions only, never private IPC/capability arguments. */
  runtime: { distributionDigest: string; cwd: string; argv: readonly string[]; projectTrust: "denied" | "approved"; approvedProjectRoots: readonly string[] };
  /** Sanitized effective settings/model/MCP metadata from native readback; no credentials. */
  effectiveMetadata: unknown;
  /** Pi's effective package/resource settings, after trust/overrides; never guessed from installs. */
  effectivePackages?: readonly (string | NativeHomePackageSelection)[];
  effectiveExtensions?: readonly string[];
  signal?: AbortSignal;
}
export interface NativeHomeManifest {
  schema: typeof NATIVE_HOME_SCHEMA;
  agentDir: string;
  entries: NativeHomeEntry[];
  packages: NativeHomePackage[];
  resources: { kind: string; path: string; source: string }[];
  environment: ReturnType<typeof nativeHomeEnvironment>;
  runtime: NativeHomeInput["runtime"];
  effectiveMetadataDigest: string;
  effectivePackages?: NativeHomePackageSelection[];
  effectiveExtensions?: string[];
  digest: string;
}
const hostPackages = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox", "@mariozechner/pi-ai", "@mariozechner/pi-agent-core", "@mariozechner/pi-coding-agent", "@mariozechner/pi-tui", "@sinclair/typebox"]);
// Only selected roots are walked. Home sessions/auth/models-store/logs are never opened.
// Package node_modules are traversed through declared runtime dependencies, never by directory size.
const ignoredDirectories = new Set(["node_modules", ".git"]);
const ignoredFiles = new Set(["auth.json", "mcp-auth.json", "models-store.json"]);
export const isNativeHomeIgnoredName = (name: string) => ignoredDirectories.has(name) || ignoredFiles.has(name);
const stamp = (s: Awaited<ReturnType<typeof lstat>>) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(":");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PiNativeAdmissionError("pi_home_config_invalid", "Native home configuration must be an object.");
  return value as Record<string, unknown>;
}
/** Sanitized selection identity shared by the manifest and actual pi.getSettings() receipt. */
export function nativeHomeEffectiveSettings(settings: NativeHomeSettings) {
  if (!Array.isArray(settings.packages ?? []) || !Array.isArray(settings.extensions ?? []) || settings.extensions?.some(value => typeof value !== "string")) throw new PiNativeAdmissionError("pi_home_config_invalid", "Effective native resource settings are invalid.");
  const effectivePackages = (settings.packages ?? []).map(value => {
    const pkg = typeof value === "string" ? { source: value } : object(value);
    if (typeof pkg.source !== "string" || (pkg.extensions !== undefined && (!Array.isArray(pkg.extensions) || pkg.extensions.some(value => typeof value !== "string"))) || (pkg.autoload !== undefined && typeof pkg.autoload !== "boolean")) throw new PiNativeAdmissionError("pi_home_config_invalid", "Effective package settings are invalid.");
    return { source: pkg.source as string, ...(pkg.extensions === undefined ? {} : { extensions: [...pkg.extensions as string[]] }), ...(pkg.autoload === undefined ? {} : { autoload: pkg.autoload as boolean }) };
  });
  return { effectivePackages, effectiveExtensions: [...settings.extensions ?? []] };
}

/**
 * Private, startup/re-admission collection. Does no installs, imports, reloads or network calls.
 * O(files + declared dependency closure), async I/O, abortable between reads. The launcher must
 * supply immutable roots. Pre/post stamps detect ordinary concurrent edits, not hostile FS atomicity.
 */
export async function computeNativeHomeManifest(input: NativeHomeInput): Promise<NativeHomeManifest> {
  const fail = (code: string, message: string): never => { throw new PiNativeAdmissionError(code, message); };
  if (!/^[a-f0-9]{64}$/.test(input.runtime.distributionDigest)) fail("pi_home_distribution_missing", "A pinned Pi/Node/host-peer distribution digest is required.");
  if (input.runtime.projectTrust === "denied" && input.runtime.approvedProjectRoots.length) fail("pi_home_trust_invalid", "Denied project trust cannot admit project roots.");
  const agentDir = await realpath(input.agentDir);
  const allowed = await Promise.all([agentDir, ...input.allowedExternalRoots, ...input.runtime.approvedProjectRoots].map(path => realpath(path)));
  const entries: NativeHomeEntry[] = [], observations = new Map<string, string | null>();
  const check = () => input.signal?.throwIfAborted();
  const allowedPath = (path: string) => { if (!allowed.some(root => isWithin(root, path))) fail("pi_home_external_root", "Native resource resolves outside admitted immutable roots."); };
  async function observe(path: string, optional = false) {
    check();
    try { const s = await lstat(path); const before = observations.get(path); if (before !== undefined && before !== stamp(s)) fail("pi_home_collection_race", "Native home changed during manifest collection."); observations.set(path, stamp(s)); return s; }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") { observations.set(path, null); return undefined; } throw error; }
  }
  async function walk(path: string, logicalPath: string, ancestors = new Set<string>(), optional = false): Promise<void> {
    const before = await observe(path, optional);
    if (!before) { entries.push({ logicalPath, resolvedPath: resolve(path), kind: "absent" }); return; }
    const resolvedPath = await realpath(path); allowedPath(resolvedPath);
    if (before.isSymbolicLink()) {
      const link = await readlink(path, { encoding: "buffer" });
      entries.push({ logicalPath, resolvedPath: resolve(path), kind: "symlink", length: link.length, sha256: sha256(link), target: resolvedPath });
      if (ancestors.has(resolvedPath)) fail("pi_home_symlink_cycle", "Native resource has a cyclic symlink.");
      await walk(resolvedPath, `${logicalPath}/@target`, ancestors); return;
    }
    if (before.isDirectory()) {
      if (ancestors.has(resolvedPath)) fail("pi_home_symlink_cycle", "Native resource has a cyclic directory.");
      entries.push({ logicalPath, resolvedPath, kind: "directory" });
      const next = new Set(ancestors).add(resolvedPath);
      for (const name of (await readdir(path)).sort(bytewise)) {
        if (isNativeHomeIgnoredName(name)) continue;
        await walk(join(path, name), `${logicalPath}/${name}`, next);
      }
      return;
    }
    if (!before.isFile()) fail("pi_home_file_type", "Native resources must be regular files or admitted symlinks.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (stamp(await file.stat()) !== stamp(before)) fail("pi_home_collection_race", "Native home changed while opening a file.");
      const bytes = await file.readFile({ signal: input.signal });
      if (stamp(await file.stat()) !== stamp(before)) fail("pi_home_collection_race", "Native home changed while reading a file.");
      entries.push({ logicalPath, resolvedPath, kind: "file", length: bytes.length, executableBits: before.mode & 0o111, sha256: sha256(bytes) });
    } finally { await file.close(); }
  }
  for (const name of ["settings.json", "models.json", "mcp.json", "AGENTS.md"]) await walk(join(agentDir, name), `home/${name}`, new Set(), true);
  async function readJson(path: string) {
    const bytes = await readFile(path);
    const canonicalPath = await realpath(path);
    const entry = entries.find(entry => entry.resolvedPath === canonicalPath && entry.kind === "file");
    if (!entry || sha256(bytes) !== entry.sha256) fail("pi_home_collection_race", "Native configuration changed during collection.");
    try { return object(JSON.parse(bytes.toString("utf8"))); }
    catch { return fail("pi_home_config_invalid", "Native configuration is not a valid JSON object."); }
  }
  const configured = entries.some(entry => entry.logicalPath === "home/settings.json" && entry.kind !== "absent") ? (await readJson(join(agentDir, "settings.json"))).packages ?? [] : [];
  const configuredPackages: unknown[] = Array.isArray(configured) ? configured : fail("pi_home_config_invalid", "Native package selection is not an array.");
  const sources = configuredPackages.map(value => typeof value === "string" ? value : object(value).source);
  if (sources.some(source => typeof source !== "string" || input.packages.filter(pkg => pkg.source === source).length !== 1)) fail("pi_home_package_unresolved", "A configured package has no unique native resolved root.");
  const packages: NativeHomePackage[] = [], visited = new Set<string>();
  async function dependencyRoot(root: string, name: string): Promise<string | undefined> {
    if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) fail("pi_home_dependency_invalid", "Invalid runtime dependency name.");
    for (const base of createRequire(join(root, "package.json")).resolve.paths(name) ?? []) {
      const candidate = join(base, name);
      try { await lstat(join(candidate, "package.json")); return candidate; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return undefined;
  }
  async function packageClosure(path: string, logicalPath: string): Promise<Record<string, unknown>> {
    check(); const root = await realpath(path); allowedPath(root);
    const manifestPath = join(root, "package.json");
    if (visited.has(root)) return readJson(manifestPath);
    visited.add(root);
    // Include the root's symlink and all its immutable resource/bundle/asset bytes.
    await walk(path, logicalPath);
    const pkg = await readJson(manifestPath);
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") fail("pi_home_package_invalid", "A native package lacks exact name/version identity.");
    const dependencies = object(pkg.dependencies ?? {}), optional = object(pkg.optionalDependencies ?? {}), peers = object(pkg.peerDependencies ?? {});
    for (const name of [...new Set([...Object.keys(dependencies), ...Object.keys(optional), ...Object.keys(peers)])].sort(bytewise)) {
      const edge = `${logicalPath}/@dependencies/${name}`;
      if (hostPackages.has(name)) {
        if (name in dependencies || name in optional) fail("pi_home_duplicate_host_peer", "Native packages must use Pi's pinned host peers, not private copies.");
        entries.push({ logicalPath: edge, resolvedPath: `distribution:${name}`, kind: "host-reference", sha256: input.runtime.distributionDigest }); continue;
      }
      const resolved = await dependencyRoot(root, name);
      if (!resolved) {
        const meta = object(object(pkg.peerDependenciesMeta ?? {})[name] ?? {});
        if (!(name in optional) && meta.optional !== true) fail("pi_home_dependency_missing", "A required native runtime dependency could not be resolved.");
        entries.push({ logicalPath: edge, resolvedPath: `unresolved:${name}`, kind: "absent" }); continue;
      }
      entries.push({ logicalPath: edge, resolvedPath: await realpath(resolved), kind: "dependency" });
      await packageClosure(resolved, `${edge}/@package`);
    }
    return pkg;
  }
  for (const selected of [...input.packages].sort((a, b) => bytewise(a.source, b.source))) {
    const pkg = await packageClosure(selected.root, `packages/${encodeURIComponent(selected.source)}`);
    const selectors = object(pkg.pi ?? {}).extensions ?? [];
    if (!Array.isArray(selectors) || selectors.some(value => typeof value !== "string")) fail("pi_home_package_invalid", "Native extension selectors are invalid.");
    packages.push({ source: selected.source, root: await realpath(selected.root), name: pkg.name as string, version: pkg.version as string, extensionSelectors: selectors as string[] });
  }
  const resources = input.resources.map(({ kind, path, source }) => ({ kind, path, source })).sort((a, b) => bytewise(`${a.kind}:${a.path}:${a.source}`, `${b.kind}:${b.path}:${b.source}`));
  for (const resource of resources) await walk(resource.path, `resources/${resource.kind}/${encodeURIComponent(resource.path)}`);
  // Recheck the complete observation set, not just individual read windows; no mtime in digest.
  for (const [path, before] of observations) {
    check(); let after: string | null = null;
    try { after = stamp(await lstat(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (after !== before) fail("pi_home_collection_race", "Native home changed during manifest collection.");
  }
  entries.sort((a, b) => bytewise(a.logicalPath, b.logicalPath));
  const effective = nativeHomeEffectiveSettings({ packages: input.effectivePackages, extensions: input.effectiveExtensions });
  const body = { schema: NATIVE_HOME_SCHEMA, agentDir, entries, packages, resources, environment: nativeHomeEnvironment(input.environment), runtime: { distributionDigest: input.runtime.distributionDigest, cwd: await realpath(input.runtime.cwd), argv: [...input.runtime.argv], projectTrust: input.runtime.projectTrust, approvedProjectRoots: [...input.runtime.approvedProjectRoots].sort(bytewise) }, effectiveMetadataDigest: sha256(canonicalJson(input.effectiveMetadata)), ...(input.effectivePackages === undefined ? {} : { effectivePackages: effective.effectivePackages }), ...(input.effectiveExtensions === undefined ? {} : { effectiveExtensions: effective.effectiveExtensions }) };
  return { ...body, digest: sha256(canonicalJson(body)) };
}
