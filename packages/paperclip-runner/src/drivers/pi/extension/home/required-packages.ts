import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PiNativeAdmissionError } from "../../pi-native-config.js";
import type { RequiredNativePackage } from "./admission.js";
import { canonicalJson, isNativeHomeIgnoredName, isWithin, sha256, type NativeHomeManifest } from "./manifest.js";

function fail(code: string, message: string): never { throw new PiNativeAdmissionError(code, message); }
const patterned = (path: string) => /[!*?\[\]]/.test(path) || path.startsWith("-");

/** Deliberately admit literal package manifests only; do not reimplement Pi's glob resolver. */
export async function checkRequiredNativePackages(manifest: NativeHomeManifest, required: readonly RequiredNativePackage[], signal?: AbortSignal): Promise<string> {
  if (required.length !== 2 || required.filter(pkg => pkg.role === "tool-context-guard" || pkg.role === "tool-cap").length !== 1 || required.filter(pkg => pkg.role === "pi-subagents").length !== 1) fail("pi_home_required_packages", "Exactly one declared guard and pi-subagents are required.");
  const { effectivePackages, effectiveExtensions } = manifest;
  if (!effectivePackages || !effectiveExtensions) fail("pi_home_effective_settings_missing", "Native effective package and extension settings are required.");
  await checkBytes(manifest, "home/settings.json", "pi_home_settings_drift", signal);
  if (manifest.runtime.argv.some(arg => ["-ne", "--no-extensions", "-np", "--no-packages"].includes(arg))) fail("pi_home_required_disabled", "CLI resource suppression cannot establish the required startup load.");
  let subagentsRoot = "";
  for (const declaration of required) {
    signal?.throwIfAborted();
    const root = await realpath(declaration.root);
    const selected = manifest.packages.filter(pkg => pkg.root === root);
    if (selected.length !== 1) fail("pi_home_required_load_failed", "A required package has no unique admitted root.");
    const pkg = selected[0];
    if (pkg.name.split("/").at(-1) !== declaration.role || !declaration.version || pkg.version !== declaration.version || !pkg.extensionSelectors.length) fail("pi_home_required_load_failed", "A required package has the wrong name/version or no explicit extension entry.");
    const configured = effectivePackages.filter(value => value.source === pkg.source);
    if (configured.length !== 1) fail("pi_home_required_not_configured", "A required root has no unique effective settings package entry.");
    const selection = configured[0];
    if (selection.autoload === false || selection.extensions?.length === 0) fail("pi_home_required_disabled", "A required package's extensions are disabled.");
    const paths: string[] = [];
    for (const selector of pkg.extensionSelectors) {
      if (patterned(selector) || selector.startsWith("+")) fail("pi_home_selector_receipt_required", "Patterned required manifests need Pi's resolved selector diagnostics.");
      const path = await realpath(resolve(root, selector));
      if (!isWithin(root, path) || !manifest.entries.some(entry => entry.kind === "file" && entry.resolvedPath === path)) fail("pi_home_required_load_failed", "A required extension entry is outside its admitted file closure.");
      paths.push(path);
    }
    if (selection.extensions) {
      if (selection.extensions.some(patterned)) fail("pi_home_selector_receipt_required", "Patterned required settings need Pi's resolved selector diagnostics.");
      const enabled = await Promise.all(selection.extensions.map(path => realpath(resolve(root, path.replace(/^\+/, "")))));
      if (paths.some(path => !enabled.includes(path))) fail("pi_home_required_disabled", "A required extension is filtered out of effective settings.");
    }
    // Effective extension selectors must retain their native-resolved absolute paths. The CLI
    // array is the launcher's resource-selector-only argv, never a capability-bearing argv.
    const selectors = [...effectiveExtensions, ...manifest.runtime.argv.map(arg => arg.replace(/^--extension=/, ""))];
    for (const selector of selectors) {
      if (!selector.startsWith("-") && !selector.startsWith("!")) continue;
      if (selector.startsWith("--") || selector === "-e" || selector.startsWith("-builtin:")) continue;
      const path = selector.slice(1);
      if (patterned(path) || !isAbsolute(path)) fail("pi_home_selector_receipt_required", "Unresolved extension exclusions cannot prove required startup loading.");
      if (isWithin(root, path) || paths.includes(path)) fail("pi_home_required_disabled", "A required extension is excluded from loading.");
      // Resolve aliases too, including symlink paths outside the package root.
      try { if (isWithin(root, await realpath(path))) fail("pi_home_required_disabled", "A required extension alias is excluded from loading."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await checkBytes(manifest, `packages/${encodeURIComponent(pkg.source)}`, "pi_home_package_drift", signal);
    if (declaration.role === "pi-subagents") subagentsRoot = root;
  }
  return subagentsRoot;
}

/** Recheck the admitted file/dependency closure, including additions and symlink retargets. */
async function checkBytes(manifest: NativeHomeManifest, prefix: string, code: string, signal?: AbortSignal): Promise<void> {
  const entries = manifest.entries.filter(entry => entry.logicalPath === prefix || entry.logicalPath.startsWith(`${prefix}/`));
  if (!entries.length) fail(code, "A required native resource has no admitted byte closure.");
  const children = new Map<string, string[]>();
  for (const entry of entries) {
    const slash = entry.logicalPath.lastIndexOf("/"), parent = entry.logicalPath.slice(0, slash);
    const names = children.get(parent) ?? []; names.push(entry.logicalPath.slice(slash + 1)); children.set(parent, names);
  }
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.kind === "absent" && isAbsolute(entry.resolvedPath)) {
        try { await lstat(entry.resolvedPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        fail(code, "An absent native resource appeared after home collection.");
      }
      if (!["file", "directory", "symlink"].includes(entry.kind)) continue;
      const stat = await lstat(entry.resolvedPath);
      if (entry.kind === "file") {
        if (!stat.isFile() || await realpath(entry.resolvedPath) !== entry.resolvedPath || stat.size !== entry.length || (stat.mode & 0o111) !== entry.executableBits || sha256(await readFile(entry.resolvedPath, { signal })) !== entry.sha256) fail(code, "Required native resource bytes changed after home collection.");
      } else if (entry.kind === "symlink") {
        if (!stat.isSymbolicLink() || await realpath(entry.resolvedPath) !== entry.target || sha256(await readlink(entry.resolvedPath, { encoding: "buffer" })) !== entry.sha256) fail(code, "A required native resource symlink changed after home collection.");
      } else {
        const expected = (children.get(entry.logicalPath) ?? []).sort();
        if (!stat.isDirectory() || canonicalJson((await readdir(entry.resolvedPath)).filter(name => !isNativeHomeIgnoredName(name)).sort()) !== canonicalJson(expected)) fail(code, "Required native resource directory contents changed after home collection.");
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof PiNativeAdmissionError) throw error;
    fail(code, "A required native resource's admitted bytes are no longer present.");
  }
}
