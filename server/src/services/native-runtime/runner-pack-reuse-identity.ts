import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bundledRemoteProviderPackManifestPath } from "../../vendor/paperclip-runner/index.js";
import { canonicalProviderPackDigestJson } from "./remote-provider-pack-verification.js";

/** Selection identity only, not artifact verification (the launch owner does that).
 * Publication inputs stay stable across controller-only rebuilds. Development
 * packs have no image-input stamp, so their sealed manifest is the boundary.
 * An unpackaged source checkout has neither and keeps its unversioned behavior.
 */
export function runnerPackReuseIdentity(adapterType: string | null): string | null {
  if (adapterType !== "paperclip_runner") return null;
  const configured = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim();
  const path = configured ? join(configured, "provider-pack.json") : bundledRemoteProviderPackManifestPath();
  let text: string;
  try {
    if (statSync(path).size > 512 * 1024) throw new Error("provider pack manifest is too large");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!configured && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("runner_remote_provider_artifact_incompatible: cannot read reuse pack identity", { cause: error });
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error("runner_remote_provider_artifact_incompatible: invalid reuse pack identity", { cause: error });
  }
  const payload = manifest?.payload;
  if (manifest?.schema !== "paperclip-runner/remote-provider-pack/v1" || !payload
    || !/^[a-f0-9]{40}(?:-dirty)?$/.test(payload.runnerSourceRevision ?? "")
    || manifest.digest !== `sha256:${createHash("sha256").update(canonicalProviderPackDigestJson(payload)).digest("hex")}`
    || (payload.runnerInputsDigest !== undefined && !/^[a-f0-9]{64}$/.test(payload.runnerInputsDigest))) {
    throw new Error("runner_remote_provider_artifact_incompatible: invalid reuse pack identity");
  }
  return payload.runnerInputsDigest ? `inputs:${payload.runnerInputsDigest}` : `pack:${manifest.digest}`;
}

export function admittedRunnerPackIdentity(metadata: Record<string, unknown> | null | undefined): string | null {
  const scope = metadata?.reusableSandboxLease as Record<string, unknown> | undefined;
  return typeof scope?.runnerPackIdentity === "string" ? scope.runnerPackIdentity : null;
}
