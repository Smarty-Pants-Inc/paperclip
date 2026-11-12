import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { PiNativeAdmissionError } from "../../pi-native-config.js";
import { canonicalJson, isWithin, nativeHomeEnvironment, NATIVE_HOME_SCHEMA, sha256, type NativeHomeEnvironment, type NativeHomeManifest } from "./manifest.js";

function fail(code: string, message: string): never { throw new PiNativeAdmissionError(code, message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("pi_home_models_invalid", "Native models configuration is invalid.");
  return value as Record<string, unknown>;
}
/** Presence matters to Pi: PI_OFFLINE=0 still enables offline mode. Never coerce booleans. */
export function checkNativeHomeEnvironment(env: NativeHomeEnvironment): void {
  if (env.PI_OFFLINE !== "1" || env.PI_SKIP_VERSION_CHECK !== "1") fail("pi_home_environment_invalid", "Native Pi requires PI_OFFLINE=1 and PI_SKIP_VERSION_CHECK=1.");
  if (env.PI_SUBAGENTS_COMPONENT_UI !== undefined) fail("pi_home_rpc_components_forbidden", "PI_SUBAGENTS_COMPONENT_UI must remain unset in RPC mode.");
}
/** Validate file declarations; exact live model/effort readback remains admitPiRpcSession's job. */
export function assertClaudeClamp(config: unknown): void {
  const providers = object(object(config).providers ?? {});
  for (const provider of Object.values(providers)) {
    const definition = object(provider), models = definition.models ?? [];
    if (!Array.isArray(models)) fail("pi_home_models_invalid", "Native models must be an array.");
    const selected: [string, unknown][] = models.map(model => { const m = object(model); if (typeof m.id !== "string") fail("pi_home_models_invalid", "Native model ID is missing."); return [m.id, m]; });
    selected.push(...Object.entries(object(definition.modelOverrides ?? {})));
    for (const [id, model] of selected) {
      if (/claude/i.test(id) && object(object(model).thinkingLevelMap ?? {}).max !== null) fail("pi_home_claude_clamp_missing", "Every configured Claude model must explicitly map max to null; never silently lower a request.");
    }
  }
}
export interface RequiredNativePackage {
  role: "tool-context-guard" | "tool-cap" | "pi-subagents";
  root: string;
  version: string;
}
/**
 * TEMP integration port: actual Pi loader diagnostics, not disk/get_commands/import probes.
 * Stock Pi 1.5.2 RPC/ExtensionContext exposes no complete startup receipt. Caller MUST omit
 * this until the approved loader hook exists; absence fails closed. Never synthesize it.
 */
export interface NativeHomeLoadReceipt {
  schema: "pi-native-load/v1";
  sessionId: string;
  manifestDigest: string;
  packages: { root: string; name: string; version: string; failed: boolean; shadowed: boolean; extensions: { path: string; loaded: boolean }[] }[];
}
export interface NativeHomeAdmissionInput {
  manifest: NativeHomeManifest;
  sessionId: string;
  required: readonly RequiredNativePackage[];
  environment: NativeHomeEnvironment;
  loadReceipt?: NativeHomeLoadReceipt;
}
/** Contributes to BindReceipt.digest only; does not commit a bind or allow a prompt. */
export async function admitNativeHome(input: NativeHomeAdmissionInput): Promise<{ schema: typeof NATIVE_HOME_SCHEMA; digest: string }> {
  checkNativeHomeEnvironment(input.environment);
  const { digest, ...body } = input.manifest;
  if (body.schema !== NATIVE_HOME_SCHEMA || sha256(canonicalJson(body)) !== digest || canonicalJson(body.environment) !== canonicalJson(nativeHomeEnvironment(input.environment))) fail("pi_home_manifest_invalid", "Native home manifest/environment identity does not match.");
  const receipt = input.loadReceipt;
  if (!receipt) fail("pi_home_load_receipt_missing", "Pi must expose actual required-resource load receipts before native-home admission can succeed.");
  if (receipt.schema !== "pi-native-load/v1" || receipt.sessionId !== input.sessionId || receipt.manifestDigest !== digest) fail("pi_home_load_receipt_stale", "Native loader receipt belongs to another session or home identity.");
  if (input.required.length !== 2 || input.required.filter(pkg => pkg.role === "tool-context-guard" || pkg.role === "tool-cap").length !== 1 || input.required.filter(pkg => pkg.role === "pi-subagents").length !== 1) fail("pi_home_required_packages", "Exactly one declared guard and pi-subagents are required.");
  for (const required of input.required) {
    const root = await realpath(required.root);
    const selected = body.packages.filter(pkg => pkg.root === root);
    const loaded = receipt.packages.filter(pkg => pkg.root === root);
    if (selected.length !== 1 || loaded.length !== 1) fail("pi_home_required_load_failed", "A required native package is missing, duplicated or unresolved.");
    const pkg = selected[0], proof = loaded[0];
    const expectedName = required.role === "pi-subagents" ? "pi-subagents" : required.role;
    if (pkg.name.split("/").at(-1) !== expectedName || !required.version || pkg.version !== required.version || proof.name !== pkg.name || proof.version !== required.version || proof.failed !== false || proof.shadowed !== false || !proof.extensions.length) fail("pi_home_required_load_failed", "Required native package did not load at the exact admitted identity.");
    for (const extension of proof.extensions) {
      if (extension.loaded !== true || !isWithin(root, extension.path) || !body.entries.some(entry => entry.kind === "file" && entry.resolvedPath === extension.path)) fail("pi_home_required_load_failed", "Required extension load is not backed by the admitted file closure.");
    }
    // Canonical path packages use explicit pi.extensions. Wildcards/selection need native
    // resolved-selector diagnostics, not a second resource-discovery implementation here.
    for (const selector of pkg.extensionSelectors) {
      if (/[!*?\[\]]/.test(selector) || selector.startsWith("+") || selector.startsWith("-")) fail("pi_home_selector_receipt_required", "Filtered required extensions need native resolved-selector diagnostics.");
      const expected = await realpath(resolve(root, selector));
      if (!proof.extensions.some(extension => extension.path === expected && extension.loaded)) fail("pi_home_required_load_failed", "A declared required extension has no native successful-load receipt.");
    }
  }
  const modelFile = await realpath(resolve(body.agentDir, "models.json"));
  const modelEntry = body.entries.find(entry => entry.kind === "file" && entry.resolvedPath === modelFile);
  if (!modelEntry) fail("pi_home_claude_clamp_missing", "Native models.json is required to verify the Claude clamp.");
  const bytes = await readFile(modelFile);
  if (sha256(bytes) !== modelEntry.sha256) fail("pi_home_models_drift", "Native model bytes changed after manifest collection.");
  let config: unknown;
  try { config = JSON.parse(bytes.toString("utf8")); }
  catch { return fail("pi_home_models_invalid", "Native models configuration is not valid JSON."); }
  assertClaudeClamp(config);
  return { schema: NATIVE_HOME_SCHEMA, digest };
}
