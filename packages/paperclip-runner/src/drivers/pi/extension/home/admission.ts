import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { PiNativeAdmissionError } from "../../pi-native-config.js";
import { canonicalJson, isWithin, nativeHomeEnvironment, NATIVE_HOME_SCHEMA, sha256, type NativeHomeEnvironment, type NativeHomeManifest } from "./manifest.js";
import { checkRequiredNativePackages } from "./required-packages.js";

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
export function assertNativeModels(config: unknown): void {
  const providers = object(object(config).providers ?? {});
  for (const provider of Object.values(providers)) {
    const definition = object(provider), models = definition.models ?? [];
    if (!Array.isArray(models)) fail("pi_home_models_invalid", "Native models must be an array.");
    for (const model of models) {
      const m = object(model);
      if (typeof m.id !== "string") fail("pi_home_models_invalid", "Native model ID is missing.");
    }
    object(definition.modelOverrides ?? {});
  }
}
export interface RequiredNativePackage {
  role: "tool-context-guard" | "tool-cap" | "pi-subagents";
  root: string;
  version: string;
}
/** In-process facts, not a fictional upstream loaded-extension inventory. */
export interface NativeHomeLoadReceipt {
  schema: "pi-native-load/v1";
  sessionId: string;
  manifestDigest: string;
  startup: { rule: "startup-fatal"; piVersion: string };
  effectiveSettingsDigest: string;
  subagentTool: { name: "subagent"; root: string; path?: string };
  /** Pi 1.5.2's public ExtensionAPI has no extension_error subscription; the driver owns it. */
  extensionErrors: { observability: "not observable in-process" };
}
export interface NativeHomeAdmissionInput {
  manifest: NativeHomeManifest;
  sessionId: string;
  required: readonly RequiredNativePackage[];
  environment: NativeHomeEnvironment;
  loadReceipt?: NativeHomeLoadReceipt;
  signal?: AbortSignal;
}
/** Contributes to BindReceipt.homeDigest only; does not commit a bind or allow a prompt. */
export async function admitNativeHome(input: NativeHomeAdmissionInput): Promise<{ digest: string }> {
  input.signal?.throwIfAborted();
  checkNativeHomeEnvironment(input.environment);
  const { digest, ...body } = input.manifest;
  if (body.schema !== NATIVE_HOME_SCHEMA || sha256(canonicalJson(body)) !== digest || canonicalJson(body.environment) !== canonicalJson(nativeHomeEnvironment(input.environment))) fail("pi_home_manifest_invalid", "Native home manifest/environment identity does not match.");
  const receipt = input.loadReceipt;
  if (!receipt) fail("pi_home_load_receipt_missing", "Native home requires the resident's in-process startup load facts.");
  if (!input.sessionId.trim() || receipt.schema !== "pi-native-load/v1" || receipt.sessionId !== input.sessionId || receipt.manifestDigest !== digest) fail("pi_home_load_receipt_stale", "Native loader receipt belongs to another session or home identity.");
  if (receipt.startup?.rule !== "startup-fatal" || receipt.startup.piVersion !== "1.5.2") fail("pi_home_startup_rule_invalid", "The startup-fatal load rule is established only for Pi 1.5.2.");
  if (receipt.extensionErrors?.observability !== "not observable in-process") fail("pi_home_error_observation_invalid", "Native error observability must be explicit; the RPC driver must fence required extension errors.");
  if (receipt.effectiveSettingsDigest !== sha256(canonicalJson({ effectivePackages: body.effectivePackages, effectiveExtensions: body.effectiveExtensions }))) fail("pi_home_effective_settings_mismatch", "The manifest does not describe the resident's actual effective package/extension settings.");
  const subagentsRoot = await checkRequiredNativePackages(input.manifest, input.required, input.signal);
  const tool = receipt.subagentTool;
  if (tool?.name !== "subagent" || tool.root !== subagentsRoot || await realpath(tool.root) !== subagentsRoot) fail("pi_home_subagent_provenance", "The subagent tool is not owned by the admitted pi-subagents root.");
  if (tool.path && (await realpath(tool.path) !== tool.path || !isWithin(subagentsRoot, tool.path) || !body.entries.some(entry => entry.kind === "file" && entry.resolvedPath === tool.path))) fail("pi_home_subagent_provenance", "The subagent tool entry is not backed by admitted package bytes.");
  const modelFile = await realpath(resolve(body.agentDir, "models.json"));
  const modelEntry = body.entries.find(entry => entry.kind === "file" && entry.resolvedPath === modelFile);
  if (!modelEntry) fail("pi_home_models_invalid", "Native models.json is required for admission.");
  const bytes = await readFile(modelFile, { signal: input.signal });
  if (sha256(bytes) !== modelEntry.sha256) fail("pi_home_models_drift", "Native model bytes changed after manifest collection.");
  let config: unknown;
  try { config = JSON.parse(bytes.toString("utf8")); }
  catch { return fail("pi_home_models_invalid", "Native models configuration is not valid JSON."); }
  assertNativeModels(config);
  // Model-family effort policy belongs to the admitted Pi configuration, not this driver.
  input.signal?.throwIfAborted();
  return { digest };
}
