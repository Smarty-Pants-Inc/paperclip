import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativePiProviderPackFixture } from "./native-pi-provider-pack.test-fixture.js";
import { resolveLocalPiLaunchArtifacts, sha256DirectoryTree, verifyRemoteProviderPackManifest } from "./native-session-executor.js";
import { canonicalProviderPackDigestJson } from "./remote-provider-pack-verification.js";
import * as fileWork from "./off-loop-file-work.js";

// Keep: pack admission is a trust boundary. Real filesystem mutations reproduce
// both the per-turn full-pack rehash and unsafe stale-verification regressions.
afterEach(() => vi.restoreAllMocks());
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "selected-pack-memo-"));
  const result = await nativePiProviderPackFixture(root);
  const path = "provider-assets/pi/linux-x64";
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, "dependency"), "selected ACPX Pi dependency");
  const pi = { path, version: "test", profileDigest: sha("profile"), closureDigest: sha("closure"), qualification: "qualified", sha256: sha256DirectoryTree(join(root, path)) };
  Object.assign(result.manifest.payload, { providers: { pi }, candidateProviders: { pi } });
  result.manifest.digest = sha(canonicalProviderPackDigestJson(result.manifest.payload));
  await writeFile(join(root, "provider-pack.json"), JSON.stringify(result.manifest));
  return { ...result, pi };
}

describe("selected provider pack process memo", () => {
  it("skips tampered unselected trees but verifies them on selection, without caching failures", async () => {
    const { packRoot, pi } = await fixture();
    await writeFile(join(packRoot, pi.path, "dependency"), "tampered");
    const hash = vi.spyOn(fileWork, "sha256DirectoryTreeStreamed");
    await resolveLocalPiLaunchArtifacts(packRoot);
    expect(hash.mock.calls.map(([path]) => path)).toEqual([join(packRoot, "dist"), join(packRoot, "provider-assets/pi_rpc/linux-x64")]);
    hash.mockClear();
    await resolveLocalPiLaunchArtifacts(packRoot);
    expect(hash).not.toHaveBeenCalled();
    await expect(verifyRemoteProviderPackManifest(packRoot, { kind: "acpx", agent: "pi" })).rejects.toThrow("candidate asset tree digest mismatch");
    await expect(verifyRemoteProviderPackManifest(packRoot, { kind: "acpx", agent: "pi" })).rejects.toThrow("candidate asset tree digest mismatch");
    await writeFile(join(packRoot, pi.path, "dependency"), "selected ACPX Pi dependency");
    await expect(verifyRemoteProviderPackManifest(packRoot, { kind: "acpx", agent: "pi" })).resolves.toBeDefined();
  });

  it("invalidates a memo hit after deep selected-file tampering, even with the same manifest", async () => {
    const { packRoot, manifest } = await fixture();
    const dependency = join(packRoot, manifest.payload.nativeProviders.pi_rpc.path, "runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/dependency.js");
    // Seal a deep dependency into the fixture before the first successful check.
    await writeFile(dependency, "original");
    manifest.payload.nativeProviders.pi_rpc.sha256 = sha256DirectoryTree(join(packRoot, manifest.payload.nativeProviders.pi_rpc.path));
    manifest.digest = sha(canonicalProviderPackDigestJson(manifest.payload));
    await writeFile(join(packRoot, "provider-pack.json"), JSON.stringify(manifest));
    await resolveLocalPiLaunchArtifacts(packRoot);
    const metadata = await stat(dependency);
    await writeFile(dependency, "tampered"); // same length; preserve mtime as well
    await utimes(dependency, metadata.atime, metadata.mtime);
    await expect(resolveLocalPiLaunchArtifacts(packRoot)).rejects.toThrow("asset tree digest mismatch");
    await writeFile(dependency, "original");
    await expect(resolveLocalPiLaunchArtifacts(packRoot)).resolves.toBeDefined();
  });

  it("does not memoize a pack changed while its bytes are being verified", async () => {
    const { packRoot, manifest } = await fixture();
    const path = join(packRoot, manifest.payload.artifacts.opencodeProxy.path);
    const original = await readFile(path);
    const tree = fileWork.sha256DirectoryTreeStreamed;
    const hash = vi.spyOn(fileWork, "sha256DirectoryTreeStreamed").mockImplementationOnce(async (...args) => {
      const digest = await tree(...args);
      await writeFile(path, "changed after dist digest");
      return digest;
    });
    await expect(resolveLocalPiLaunchArtifacts(packRoot)).rejects.toThrow("changed during verification");
    await writeFile(path, original);
    hash.mockClear();
    await expect(resolveLocalPiLaunchArtifacts(packRoot)).resolves.toBeDefined();
    expect(hash).toHaveBeenCalledTimes(2);
  });

  it("binds hits to the manifest inode, real root and provider and returns isolated values", async () => {
    const { packRoot } = await fixture();
    const hash = vi.spyOn(fileWork, "sha256DirectoryTreeStreamed");
    const first = await verifyRemoteProviderPackManifest(packRoot, { kind: "pi_rpc" });
    first.payload.runnerSourceRevision = "mutated by caller";
    const alias = `${packRoot}-alias`;
    await symlink(packRoot, alias);
    expect((await verifyRemoteProviderPackManifest(alias, { kind: "pi_rpc" })).payload.runnerSourceRevision).not.toBe("mutated by caller");
    expect(hash).toHaveBeenCalledTimes(2);
    const manifestPath = join(packRoot, "provider-pack.json");
    await writeFile(`${manifestPath}.replacement`, await readFile(manifestPath));
    await rename(`${manifestPath}.replacement`, manifestPath);
    await verifyRemoteProviderPackManifest(packRoot, { kind: "pi_rpc" });
    expect(hash).toHaveBeenCalledTimes(4);
    await verifyRemoteProviderPackManifest(packRoot, { kind: "acpx", agent: "pi" });
    // The selected provider and candidate share identical bytes; hash once.
    expect(hash).toHaveBeenCalledTimes(7);
    const other = await fixture();
    await verifyRemoteProviderPackManifest(other.packRoot, { kind: "pi_rpc" });
    expect(hash).toHaveBeenCalledTimes(9);
  });
});
