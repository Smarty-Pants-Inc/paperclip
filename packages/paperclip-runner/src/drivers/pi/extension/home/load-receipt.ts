import { realpath } from "node:fs/promises";
import { PiNativeAdmissionError } from "../../pi-native-config.js";
import type { NativeHomeLoadReceipt, RequiredNativePackage } from "./admission.js";
import { canonicalJson, nativeHomeEffectiveSettings, sha256, type NativeHomeManifest, type NativeHomeSettings } from "./manifest.js";

export interface NativeHomeToolInfo {
  name: string;
  sourceInfo?: { baseDir?: string; path?: string };
}

/** Called inside the resident only, after its initial session_start (not after /reload). */
export async function buildNativeHomeLoadReceipt(input: {
  piVersion: string;
  sessionId: string;
  manifest: NativeHomeManifest;
  required: readonly RequiredNativePackage[];
  tools: readonly NativeHomeToolInfo[];
  settings: NativeHomeSettings;
  signal?: AbortSignal;
}): Promise<NativeHomeLoadReceipt> {
  input.signal?.throwIfAborted();
  if (input.piVersion !== "1.5.2") throw new PiNativeAdmissionError("pi_home_startup_rule_invalid", "The startup-fatal load rule is established only for Pi 1.5.2.");
  const declaration = input.required.find(pkg => pkg.role === "pi-subagents");
  const tools = input.tools.filter(tool => tool.name === "subagent");
  const source = tools.length === 1 ? tools[0].sourceInfo : undefined;
  const owner = source?.baseDir ?? source?.path;
  if (!declaration || !owner) throw new PiNativeAdmissionError("pi_home_subagent_provenance", "The resident must expose exactly one subagent tool with loader-owned provenance.");
  const root = await realpath(owner);
  if (root !== await realpath(declaration.root)) throw new PiNativeAdmissionError("pi_home_subagent_provenance", "The resident's subagent tool belongs to a different package root.");
  const path = source?.baseDir && source.path ? await realpath(source.path) : undefined;
  input.signal?.throwIfAborted();
  return {
    schema: "pi-native-load/v1", sessionId: input.sessionId, manifestDigest: input.manifest.digest,
    startup: { rule: "startup-fatal", piVersion: input.piVersion },
    effectiveSettingsDigest: sha256(canonicalJson(nativeHomeEffectiveSettings(input.settings))),
    subagentTool: { name: "subagent", root, ...(path === undefined ? {} : { path }) },
    // extension_error is an RPC/runtime event, not a public ExtensionAPI event in Pi 1.5.2.
    // Do not mistake pi.events (the arbitrary extension bus) for that runtime error stream.
    extensionErrors: { observability: "not observable in-process" },
  };
}
