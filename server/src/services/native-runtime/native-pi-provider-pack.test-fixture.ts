import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PI_RPC_DISTRIBUTION, QUALIFIED_ACPX_PROFILES, QUALIFIED_PI_RPC_PROFILE } from "@paperclipai/paperclip-runner";
import { sha256DirectoryTree } from "./native-session-executor.js";
import { canonicalProviderPackDigestJson } from "./remote-provider-pack-verification.js";

const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Fully digested qualification fixture; executable bytes are never run. */
export async function nativePiProviderPackFixture(packRoot: string) {
  const paths = {
    grokLauncher: "dist/providers/grok/launcher.cjs", nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml",
    opencodeCommand: "node_modules/.bin/opencode", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
    opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
    piRpcProxy: "dist/cli/pi-rpc-app-server-proxy.cjs",
    piProcessHardening: "dist/cli/linux-process-hardening.node",
    piRpcExecutable: "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  };
  const artifacts = {} as Record<keyof typeof paths, { path: string; sha256: string }>;
  for (const [key, path] of Object.entries(paths)) {
    const bytes = `native-pi fixture: ${key}\n`;
    await mkdir(dirname(join(packRoot, path)), { recursive: true });
    await writeFile(join(packRoot, path), bytes);
    artifacts[key as keyof typeof paths] = { path, sha256: digest(bytes) };
  }
  const payload = {
    compatibility: { opencode: 1, acpx: 1 }, contractDigest: digest("native-pi-contract"),
    pins: { nodeMinimum: "24.11.0", codex: QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion,
      opencode: "1.18.34", piRpc: "1.5.2", acpx: "0.22.0", grok: QUALIFIED_ACPX_PROFILES.grok.agentRuntimeVersion,
      claudeAcp: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion, codexAcp: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion },
    target: { platform: process.platform, architecture: process.arch }, runnerSourceRevision: "1".repeat(40),
    distDigest: sha256DirectoryTree(join(packRoot, "dist")), bridgeDigest: "", artifacts,
    acpxProfileDigests: { grok: QUALIFIED_ACPX_PROFILES.grok.commandDigest,
      claude: QUALIFIED_ACPX_PROFILES.claude.commandDigest, codex: QUALIFIED_ACPX_PROFILES.codex.commandDigest },
    piRpcProfileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest,
    nativeProviders: { pi_rpc: { version: "1.5.2", profileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest,
      closureDigest: PI_RPC_DISTRIBUTION.targets["linux-x64"].closureSha256, path: "provider-assets/pi_rpc/linux-x64",
      sha256: sha256DirectoryTree(join(packRoot, "provider-assets/pi_rpc/linux-x64")) } },
  };
  payload.bridgeDigest = digest(`${artifacts.opencodeProxy.sha256}\n${artifacts.acpxSidecar.sha256}\n${payload.distDigest}`);
  const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: digest(canonicalProviderPackDigestJson(payload)) };
  await writeFile(join(packRoot, "provider-pack.json"), JSON.stringify(manifest));
  return { packRoot, manifest };
}
