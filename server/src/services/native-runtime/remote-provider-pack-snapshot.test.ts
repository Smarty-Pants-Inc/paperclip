import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { canonicalProviderPackDigestJson, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";
import { verifySnapshotProviderPack } from "./remote-provider-pack-snapshot.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function manifest(): ProviderPackIdentity {
  const payload = { pins: { opencode: "1.18.34" }, target: { platform: "linux", architecture: "x64" },
    runnerSourceRevision: "1".repeat(40), nativeProviders: { pi_rpc: { path: "provider-assets/pi_rpc/linux-x64", sha256: sha("pi") } },
    artifacts: { nodeCommand: { path: "node_modules/node/bin/node", sha256: sha("node") },
      opencodeCommand: { path: "node_modules/.bin/opencode", sha256: sha("opencode") },
      piRpcProxy: { path: "dist/cli/pi-rpc-app-server-proxy.cjs", sha256: sha("proxy") },
      piRpcExecutable: { path: "provider-assets/pi_rpc/linux-x64/cli.js", sha256: sha("cli") } } };
  return { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: sha(canonicalProviderPackDigestJson(payload)) };
}
const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode, timedOut: false, signal: null, pid: null, startedAt: null });

// Keep reason: trust boundary. Image bytes are publisher-verified; runtime only
// accepts the OS-protected manifest for the controller's exact expected digest.
describe("snapshot provider pack digest admission", () => {
  it("accepts an exact sealed snapshot without invoking a pack executable or hashing its tree", async () => {
    const pack = manifest();
    const execute = vi.fn(async () => result(Buffer.from(JSON.stringify({ ...pack, snapshotNote: "non-identity metadata" })).toString("base64")));
    await expect(verifySnapshotProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack", manifest: pack,
      provider: { kind: "pi_rpc" } })).resolves.toEqual(expect.objectContaining({ digest: pack.digest }));
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]).toBeDefined();
    const request = (execute.mock.calls as unknown as [Parameters<CommandManagedRuntimeRunner["execute"]>[0]][])[0]![0];
    expect(request.command).toBe("sh");
    expect(request.bypassSession).toBe(true);
    expect(request.args).toContain("/opt/paperclip-runner/provider-pack");
    await expect(promisify(execFile)("sh", ["-n", "-c", request.args![1]!])).resolves.toMatchObject({ stderr: "" });
    expect(request.args![1]).toContain("-writable");
    expect(request.args![1]).not.toMatch(/sha256sum|verifyProviderPack|node -e/);
  });

  it.each(["digest", "payload", "schema", "unprotected", "timeout", "signal", "malformed"])("refuses %s instead of trusting a self-reported pack", async field => {
    const expected = manifest();
    const actual = structuredClone(expected);
    if (field === "digest") actual.digest = sha("different snapshot");
    if (field === "payload") actual.payload.runnerSourceRevision = "2".repeat(40);
    if (field === "schema") actual.schema = "unknown";
    const execute = vi.fn(async () => ({ ...result(field === "malformed" ? "!bad!" : Buffer.from(JSON.stringify(actual)).toString("base64"), field === "unprotected" ? 1 : 0),
      timedOut: field === "timeout", signal: field === "signal" ? "SIGTERM" : null }));
    await expect(verifySnapshotProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack", manifest: expected,
      provider: { kind: "pi_rpc" } })).rejects.toThrow("runner_remote_provider_artifact_incompatible");
  });

  it("executes the ownership probe against a real writable installation and refuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-pack-unprotected-"));
    const pack = manifest();
    await writeFile(join(root, "provider-pack.json"), JSON.stringify(pack));
    const execute: CommandManagedRuntimeRunner["execute"] = async request => {
      try {
        const output = await promisify(execFile)(request.command, request.args ?? [], { cwd: request.cwd, timeout: request.timeoutMs });
        return result(output.stdout);
      } catch (error) {
        const failure = error as Error & { code: number; stdout: string; stderr: string };
        if (typeof failure.code !== "number") throw error;
        return { ...result(failure.stdout, failure.code), stderr: failure.stderr };
      }
    };
    try {
      await expect(verifySnapshotProviderPack({ runner: { execute }, cwd: root, packRoot: root, manifest: pack,
        provider: { kind: "pi_rpc" } })).rejects.toThrow("snapshot installation is not protected");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
