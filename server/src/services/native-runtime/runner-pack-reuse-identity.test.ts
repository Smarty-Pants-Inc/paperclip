import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalProviderPackDigestJson } from "./remote-provider-pack-verification.js";
import { runnerPackReuseIdentity } from "./runner-pack-reuse-identity.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-reuse-identity-"));
  roots.push(root);
  vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", root);
  return async (payload: Record<string, unknown>, digest?: string) => {
    const seal = digest ?? `sha256:${createHash("sha256").update(canonicalProviderPackDigestJson(payload)).digest("hex")}`;
    await writeFile(join(root, "provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1", digest: seal, payload }));
    return seal;
  };
}

describe("build-owned Runner reuse identity", () => {
  it("uses the existing image input stamp: controller-only revisions do not replace the pack", async () => {
    const write = await fixture();
    await write({ runnerSourceRevision: "a".repeat(40), runnerInputsDigest: "1".repeat(64) });
    const original = runnerPackReuseIdentity("paperclip_runner");
    expect(original).toBe(`inputs:${"1".repeat(64)}`);
    await write({ runnerSourceRevision: "b".repeat(40), runnerInputsDigest: "1".repeat(64) });
    expect(runnerPackReuseIdentity("paperclip_runner")).toBe(original);
    await write({ runnerSourceRevision: "b".repeat(40), runnerInputsDigest: "2".repeat(64) });
    expect(runnerPackReuseIdentity("paperclip_runner")).not.toBe(original);
  });
  it("uses the sealed pack for development/older builds without image inputs", async () => {
    const write = await fixture();
    const seal = await write({ runnerSourceRevision: "a".repeat(40), distDigest: "old" });
    expect(runnerPackReuseIdentity("paperclip_runner")).toBe(`pack:${seal}`);
    await write({ runnerSourceRevision: "a".repeat(40) + "-dirty", distDigest: "new" });
    expect(runnerPackReuseIdentity("paperclip_runner")).not.toBe(`pack:${seal}`);
  });
  it("does not read a pack for a different adapter", async () => {
    await fixture(); // Deliberately no manifest.
    expect(runnerPackReuseIdentity("process")).toBeNull();
    expect(runnerPackReuseIdentity(null)).toBeNull();
    expect(() => runnerPackReuseIdentity("paperclip_runner")).toThrow("runner_remote_provider_artifact_incompatible");
  });
  it.each(["bad seal", "bad revision", "bad inputs", "malformed JSON"])("refuses a configured pack with %s rather than reusing unversioned", async mode => {
    const write = await fixture();
    await write({ runnerSourceRevision: mode === "bad revision" ? "" : "a".repeat(40),
      runnerInputsDigest: mode === "bad inputs" ? "wrong" : "1".repeat(64) }, mode === "bad seal" ? "sha256:wrong" : undefined);
    if (mode === "malformed JSON") await writeFile(join(roots.at(-1)!, "provider-pack.json"), "{");
    expect(() => runnerPackReuseIdentity("paperclip_runner")).toThrow("runner_remote_provider_artifact_incompatible");
  });
});
