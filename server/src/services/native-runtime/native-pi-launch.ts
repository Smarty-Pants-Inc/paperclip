import { posix } from "node:path";
import { QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import type { probeNativeRunnerEnvironment } from "../../vendor/paperclip-runner/index.js";

type Artifact = { path: string; sha256: string };
export interface NativePiPack {
  digest: string;
  payload: {
    artifacts: { nodeCommand: Artifact; piRpcProxy?: Artifact; piRpcExecutable?: Artifact };
    nativeProviders?: { pi_rpc?: { version: string; profileDigest: string; path: string; sha256: string; closureDigest: string } };
  };
}

/** The exact same verified native distribution/launch binding for Setup and Run. */
export function nativePiRemoteLaunchOptions(root: string, manifest: NativePiPack, runtimeRoot: string): Pick<NonNullable<Parameters<typeof probeNativeRunnerEnvironment>[0]["transportOptions"]>,
  "providerNodeCommand" | "providerNodeCommandSha256" | "providerPackAuthorityDigest" | "piCommand" | "piCommandSha256" | "piProxyPath" | "piProxySha256" | "piRuntimeDirectory"> {
  const native = manifest.payload.nativeProviders?.pi_rpc;
  const proxy = manifest.payload.artifacts.piRpcProxy, executable = manifest.payload.artifacts.piRpcExecutable;
  const nativeRoot = "provider-assets/pi_rpc/linux-x64";
  if (!native || native.version !== "1.5.2" || native.profileDigest !== QUALIFIED_PI_RPC_PROFILE.commandDigest
    || native.path !== nativeRoot || !/^sha256:[a-f0-9]{64}$/.test(native.sha256) || !/^sha256:[a-f0-9]{64}$/.test(native.closureDigest)
    || proxy?.path !== "dist/cli/pi-rpc-app-server-proxy.cjs"
    || executable?.path !== `${nativeRoot}/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`
    || !/^sha256:[a-f0-9]{64}$/.test(proxy?.sha256 ?? "") || !/^sha256:[a-f0-9]{64}$/.test(executable?.sha256 ?? "")) {
    throw new Error("pi_native_pack_unavailable: the selected factory needs the qualified native Pi distribution, not the ACPX Pi assets");
  }
  return {
    providerNodeCommand: posix.join(root, manifest.payload.artifacts.nodeCommand.path),
    providerNodeCommandSha256: manifest.payload.artifacts.nodeCommand.sha256,
    providerPackAuthorityDigest: manifest.digest,
    piProxyPath: posix.join(root, proxy.path), piProxySha256: proxy.sha256,
    piCommand: posix.join(root, executable.path), piCommandSha256: executable.sha256,
    piRuntimeDirectory: posix.join(runtimeRoot, "pi"),
  };
}
