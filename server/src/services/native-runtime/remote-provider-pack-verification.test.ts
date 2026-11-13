import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { remoteProviderPackMemoScope } from "./remote-provider-pack-memo.js";
import { canonicalProviderPackDigestJson, canonicalProviderPackJson, verifyRemoteProviderPack, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const manifest = (revision: string): ProviderPackIdentity => {
  const payload = {
    compatibility: { opencode: 1, acpx: 1 },
    contractDigest: sha("contracts"),
    pins: { opencode: "1.18.34", nodeMinimum: "24.11.0" },
    target: { platform: "linux", architecture: "x64" },
    runnerSourceRevision: revision.repeat(40),
    artifacts: Object.fromEntries(Object.entries({
      nodeCommand: "node_modules/node/bin/node", opencodeCommand: "node_modules/.bin/opencode",
      productionLock: "pnpm-lock.yaml", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
      opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
      grokLauncher: "dist/providers/grok/launcher.cjs",
    }).map(([name, path]) => [name, { path, sha256: sha(`${revision}-${name}`) }])) as ProviderPackIdentity["payload"]["artifacts"],
  };
  return { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: sha(canonicalProviderPackJson(payload)) };
};

describe("installed provider pack compatibility", () => {
  it("reuses a protected pack across app revisions without executing verification commands", async () => {
    const installed = manifest("a");
    const current = structuredClone(installed);
    current.payload.runnerSourceRevision = "b".repeat(40);
    current.digest = sha(canonicalProviderPackJson(current.payload));
    const root = await mkdtemp(join(tmpdir(), "installed-pack-compatibility-"));
    await mkdir(dirname(join(root, installed.payload.artifacts.nodeCommand.path)), { recursive: true });
    await symlink(process.execPath, join(root, installed.payload.artifacts.nodeCommand.path));
    await writeFile(join(root, "provider-pack.json"), JSON.stringify(installed));
    const execute = vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
      try {
        const result = await promisify(execFile)(request.command, request.args ?? [], { cwd: root, timeout: 2_000 });
        return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString() };
      } catch (error) {
        const failed = error as Error & { code: number; stdout: string; stderr: string };
        if (typeof failed.code !== "number") throw error;
        return { stdout: failed.stdout, stderr: failed.stderr, exitCode: failed.code, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString() };
      }
    });
    const input = { runner: { execute }, cwd: root, packRoot: root, manifest: current };
    try {
      // Exercise the old complete-manifest comparison in a real Node process.
      // Only provenance changed; provider bytes and interface are identical.
      await expect(verifyRemoteProviderPack(input)).rejects.toThrow("manifest mismatch");
      expect(execute).toHaveBeenCalledOnce();
      execute.mockClear();
      const selected = await verifyRemoteProviderPack({ ...input,
        installation: { root, manifest: installed, immutable: true }, provider: { kind: "opencode" } });
      expect(selected).toEqual(installed);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const reseal = (pack: ProviderPackIdentity) => ({ ...pack, digest: sha(canonicalProviderPackJson(pack.payload)) });
  const check = (installed: ProviderPackIdentity, options: { immutable?: boolean; requireExactIdentity?: boolean; requireCurrentOpenCodeProxy?: boolean } = {}) => {
    const execute = vi.fn();
    return verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: manifest("b"), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: installed, immutable: options.immutable ?? true },
      provider: { kind: "opencode" }, requireExactIdentity: options.requireExactIdentity,
      requireCurrentOpenCodeProxy: options.requireCurrentOpenCodeProxy });
  };
  it.each(["interface", "contracts", "platform", "schema", "artifact_path", "digest", "legacy", "legacy_contracts"])("rejects an incompatible %s", async field => {
    let pack = manifest("a");
    if (field === "interface") pack.payload.compatibility!.opencode += 1;
    if (field === "contracts") pack.payload.contractDigest = sha("other-contracts");
    if (field === "legacy") delete pack.payload.compatibility;
    if (field === "legacy_contracts") delete pack.payload.contractDigest;
    if (field === "platform") pack.payload.target.architecture = "arm64";
    if (field === "schema") pack.schema = "unknown";
    if (field === "artifact_path") pack.payload.artifacts.nodeCommand.path = "../node";
    pack = reseal(pack);
    if (field === "digest") pack.digest = sha("corrupt");
    await expect(check(pack)).rejects.toThrow("runner_remote_provider_artifact_incompatible");
  });
  it("does not reuse image packs when the controller's bundled pack records no contract digest", async () => {
    const current = manifest("b");
    delete current.payload.contractDigest;
    const installed = manifest("a");
    await expect(verifyRemoteProviderPack({ runner: { execute: vi.fn() }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: installed, immutable: true },
      provider: { kind: "opencode" } })).rejects.toThrow("interface or installation is incompatible");
  });
  it("keeps writable installations at the content-verification boundary", async () => {
    await expect(check(manifest("b"), { immutable: false })).rejects.toThrow("installation is incompatible");
  });
  it("does not replace an admitted pack during reattachment", async () => {
    await expect(check(manifest("a"), { requireExactIdentity: true })).rejects.toThrow("incompatible");
    await expect(check(manifest("b"), { requireExactIdentity: true })).resolves.toEqual(manifest("b"));
  });
  it("requires the current proxy for requested OpenCode diagnostics", async () => {
    const installed = manifest("a");
    await expect(check(installed)).resolves.toEqual(installed);
    await expect(check(installed, { requireCurrentOpenCodeProxy: true }))
      .rejects.toThrow("requested OpenCode diagnostics");
    installed.payload.artifacts.opencodeProxy = manifest("b").payload.artifacts.opencodeProxy;
    await expect(check(reseal(installed), { requireCurrentOpenCodeProxy: true }))
      .resolves.toEqual(reseal(installed));
  });
  it("ignores unrelated provider and dependency changes for OpenCode", async () => {
    const pack = manifest("a");
    pack.payload.compatibility!.acpx += 1;
    pack.payload.pins.acpx = "different-version";
    pack.payload.acpxProfileDigests = { codex: sha("different-codex") };
    await expect(check(reseal(pack))).resolves.toEqual(reseal(pack));
  });
  it("checks only the selected ACPX profile", async () => {
    const current = manifest("b"), installed = manifest("a");
    current.payload.acpxProfileDigests = { claude: sha("claude"), codex: sha("codex") };
    installed.payload.acpxProfileDigests = { claude: sha("claude"), codex: sha("other-codex") };
    const input = { runner: { execute: vi.fn() }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx" as const, agent: "claude" } };
    await expect(verifyRemoteProviderPack(input)).resolves.toEqual(reseal(installed));
    await expect(verifyRemoteProviderPack({ ...input, provider: { kind: "acpx", agent: "codex" } })).rejects.toThrow("profile is incompatible");
  });

  it("rejects the published Grok pack from before native effort admission", async () => {
    const profiles = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
    const current = manifest("b"), installed = manifest("a");
    // Published builtin Grok profile 1 predates grokEffort and grokDisableWebSearch
    // in session.open. Its launcher bytes equal today's, so its release digest
    // matches; the pack predates contract digests, so that gate refuses it.
    const published = "sha256:f0b698395a3704ed2ffaf84ea19bdb20c36c8a0a70b7c629c7b6ffe144e59e55";
    expect(profiles.profiles.grok.commandDigest).toBe(published);
    installed.payload.acpxProfileDigests = { grok: published };
    delete installed.payload.contractDigest;
    current.payload.acpxProfileDigests = { grok: profiles.profiles.grok.commandDigest };
    const execute = vi.fn();
    await expect(verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx", agent: "grok" } })).rejects.toThrow("interface or installation is incompatible");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an installed pack with another Grok release digest", async () => {
    const profiles = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
    const current = manifest("b"), installed = manifest("a");
    // The last source-bound Grok profile digest.
    installed.payload.acpxProfileDigests = { grok: "sha256:5205c2197b94cfbd3e62fbeea027f2e80d092f736ca52656dda2f7044ba9a5ca" };
    current.payload.acpxProfileDigests = { grok: profiles.profiles.grok.commandDigest };
    const execute = vi.fn();
    await expect(verifyRemoteProviderPack({ runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx", agent: "grok" } })).rejects.toThrow("selected ACPX provider profile is incompatible");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reuses the current Grok profile across source-only changes and retains exact historical recovery authority", async () => {
    const profiles = JSON.parse(readFileSync(new URL("../../../../packages/paperclip-runner/acpx-profiles.json", import.meta.url), "utf8"));
    const current = manifest("b"), installed = manifest("a");
    for (const pack of [current, installed]) pack.payload.acpxProfileDigests = { grok: profiles.profiles.grok.commandDigest };
    const execute = vi.fn();
    const input = { runner: { execute }, cwd: "/workspace", packRoot: "/opt/paperclip-runner/provider-pack",
      manifest: reseal(current), installation: { root: "/opt/paperclip-runner/provider-pack", manifest: reseal(installed), immutable: true },
      provider: { kind: "acpx" as const, agent: "grok" } };
    await expect(verifyRemoteProviderPack(input)).resolves.toEqual(reseal(installed));
    const historical = manifest("a");
    historical.payload.acpxProfileDigests = { grok: "sha256:5205c2197b94cfbd3e62fbeea027f2e80d092f736ca52656dda2f7044ba9a5ca" };
    await expect(verifyRemoteProviderPack({ ...input, manifest: reseal(historical),
      installation: { ...input.installation, manifest: reseal(historical) }, requireExactIdentity: true })).resolves.toEqual(reseal(historical));
    expect(execute).not.toHaveBeenCalled();
  });

});


// Trust-boundary regressions: execute the verifier's remote command against real
// pack files. No provider, network, credentials or live sandbox is needed.
type NativePiPack = ProviderPackIdentity & {
  payload: {
    distDigest: string;
    nativeProviders?: Record<string, { version: string; profileDigest: string; closureDigest: string; path: string; sha256: string }>;
  };
};

function fixtureTreeDigest(files: Record<string, string>): string {
  const records: string[] = [];
  const visit = (prefix: string) => {
    const children = [...new Set(Object.keys(files).filter(path => path.startsWith(prefix))
      .map(path => path.slice(prefix.length).split("/")[0]))].sort();
    for (const child of children) {
      const path = `${prefix}${child}`;
      if (path in files) records.push(`file\0${path}\0${sha(files[path])}\n`);
      else { records.push(`directory\0${path}\n`); visit(`${path}/`); }
    }
  };
  visit("");
  return sha(records.join(""));
}

async function nativePiFixture(extraFiles: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-pi-pack-verification-"));
  const pack = manifest("a") as NativePiPack;
  Object.assign(pack.payload.pins, { acpx: "0.22.0", claudeAcp: "0.73.0", codexAcp: "1.6.2" });
  const nativePath = "provider-assets/pi_rpc/linux-x64";
  const executablePath = `${nativePath}/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`;
  const proxyPath = "dist/cli/pi-rpc-app-server-proxy.cjs";
  const files: Record<string, string> = {
    [pack.payload.artifacts.nodeCommand.path]: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    [pack.payload.artifacts.opencodeCommand.path]: `#!/bin/sh\nprintf '%s\n' '${pack.payload.pins.opencode}'\n`,
    ...extraFiles,
    [proxyPath]: "// native Pi RPC proxy\n",
    [executablePath]: "// independently pinned native Pi CLI\n",
    [`${nativePath}/runtime/node_modules/@earendil-works/pi-ai/package.json`]: '{"version":"1.5.2"}\n',
  };
  for (const [pkg, version] of Object.entries({ acpx: pack.payload.pins.acpx,
    "@agentclientprotocol/claude-agent-acp": pack.payload.pins.claudeAcp,
    "@agentclientprotocol/codex-acp": pack.payload.pins.codexAcp, "opencode-ai": pack.payload.pins.opencode })) {
    files[`node_modules/${pkg}/package.json`] = JSON.stringify({ version });
  }
  pack.payload.artifacts.piRpcProxy = { path: proxyPath, sha256: sha(files[proxyPath]) };
  pack.payload.artifacts.piProcessHardening = { path: "dist/cli/linux-process-hardening.node", sha256: sha("fixture hardening") };
  pack.payload.artifacts.piRpcExecutable = { path: executablePath, sha256: sha(files[executablePath]) };
  for (const [name, artifact] of Object.entries(pack.payload.artifacts)) {
    files[artifact.path] ??= `fixture ${name}\n`;
    artifact.sha256 = sha(files[artifact.path]);
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, { mode: 0o755 });
  }
  const subtree = (prefix: string) => Object.fromEntries(Object.entries(files)
    .filter(([path]) => path.startsWith(`${prefix}/`)).map(([path, content]) => [path.slice(prefix.length + 1), content]));
  pack.payload.distDigest = fixtureTreeDigest(subtree("dist"));
  pack.payload.nativeProviders = { pi_rpc: { version: "1.5.2", profileDigest: sha("native-pi-profile"),
    closureDigest: sha("native-pi-closure"), path: nativePath, sha256: fixtureTreeDigest(subtree(nativePath)) } };
  const seal = async () => {
    pack.digest = sha(canonicalProviderPackDigestJson(pack.payload));
    await writeFile(join(root, "provider-pack.json"), JSON.stringify(pack));
  };
  await seal();
  const execute = vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
    try {
      const result = await promisify(execFile)(request.command, request.args ?? [], { cwd: request.cwd, timeout: request.timeoutMs });
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString() };
    } catch (error) {
      const failed = error as Error & { code: number; stdout: string; stderr: string };
      if (typeof failed.code !== "number") throw error;
      return { stdout: failed.stdout, stderr: failed.stderr, exitCode: failed.code, signal: null,
        timedOut: false, pid: null, startedAt: new Date().toISOString() };
    }
  });
  const input = { runner: { execute }, cwd: root, packRoot: root, manifest: pack, provider: { kind: "pi_rpc" as const } };
  return { root, pack, input, execute, seal, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("native Pi remote provider pack verification", () => {
  it.each(["en_US.UTF-8", "sv_SE.UTF-8"])("verifies code-unit tree digests for dist, native Pi and selected provider under %s", async locale => {
    const selectedPath = "provider-assets/pi/linux-x64";
    const files = Object.fromEntries(["dist/order", "provider-assets/pi_rpc/linux-x64/order", selectedPath]
      .flatMap(prefix => ["a_b", "aB", "Z"].map(name => [`${prefix}/${name}`, name])));
    const fixture = await nativePiFixture(files);
    try {
      const candidate = { path: selectedPath, sha256: fixtureTreeDigest({ a_b: "a_b", aB: "aB", Z: "Z" }) };
      fixture.pack.payload.providers = { pi: candidate };
      fixture.pack.payload.candidateProviders = { pi: candidate };
      await fixture.seal();
      // The remote command is a new Node process with this locale, not an
      // in-process comparison that happens to share the builder's ICU default.
      vi.stubEnv("LC_ALL", locale);
      vi.stubEnv("LANG", locale);
      await expect(verifyRemoteProviderPack({ ...fixture.input, provider: { kind: "acpx", agent: "pi" } })).resolves.toEqual(fixture.pack);
    } finally { vi.unstubAllEnvs(); await fixture.cleanup(); }
  });

  it("hashes only the selected provider and candidate on every cold remote admission", async () => {
    const fixture = await nativePiFixture();
    try {
      const path = "provider-assets/pi/linux-x64";
      await mkdir(join(fixture.root, path), { recursive: true });
      await writeFile(join(fixture.root, path, "dependency"), "original");
      const pi = { path, sha256: fixtureTreeDigest({ dependency: "original" }) };
      fixture.pack.payload.providers = { pi };
      fixture.pack.payload.candidateProviders = { pi: { ...pi, sha256: sha("bad candidate identity") } };
      await fixture.seal();
      await writeFile(join(fixture.root, path, "dependency"), "tampered");
      await expect(verifyRemoteProviderPack(fixture.input)).resolves.toEqual(fixture.pack);
      await expect(verifyRemoteProviderPack({ ...fixture.input, provider: { kind: "acpx", agent: "pi" } })).rejects.toThrow("candidate asset tree digest mismatch");
      await writeFile(join(fixture.root, path, "dependency"), "original");
      // Both inventories must be checked; a candidate cannot mask a provider.
      await expect(verifyRemoteProviderPack({ ...fixture.input, provider: { kind: "acpx", agent: "pi" } })).rejects.toThrow("candidate asset tree digest mismatch");
      fixture.pack.payload.candidateProviders = { pi };
      await fixture.seal();
      await expect(verifyRemoteProviderPack({ ...fixture.input, provider: { kind: "acpx", agent: "pi" } })).resolves.toEqual(fixture.pack);
      await writeFile(join(fixture.root, "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-ai/package.json"), "tampered native Pi");
      // No cross-sandbox success memo: the next call must read native Pi again.
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow("native Pi asset tree digest mismatch");
    } finally { await fixture.cleanup(); }
  });

  it("verifies the declared native Pi proxy, executable and closure over the remote runner", async () => {
    const fixture = await nativePiFixture();
    try {
      const verified = await verifyRemoteProviderPack(fixture.input);
      expect(verified).toEqual(fixture.pack);
      expect(verified).not.toBe(fixture.pack);
      expect(fixture.execute).toHaveBeenCalledTimes(2);
      expect(fixture.execute.mock.calls.map(([request]) => ({ argument: request.args?.[0], bypassSession: request.bypassSession, timeoutMs: request.timeoutMs })))
        .toEqual([{ argument: "-e", bypassSession: true, timeoutMs: 120_000 }, { argument: "--version", bypassSession: true, timeoutMs: 120_000 }]);
    } finally { await fixture.cleanup(); }
  });

  it.each(["piRpcProxy", "piRpcExecutable", "piProcessHardening"])("refuses a missing %s manifest entry", async name => {
    const fixture = await nativePiFixture();
    try {
      delete fixture.pack.payload.artifacts[name];
      await fixture.seal();
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow(/runner_remote_provider_artifact_incompatible/);
    } finally { await fixture.cleanup(); }
  });

  it.each(["piRpcProxy", "piRpcExecutable", "piProcessHardening"])("refuses a missing %s file", async name => {
    const fixture = await nativePiFixture();
    try {
      await rm(join(fixture.root, fixture.pack.payload.artifacts[name].path));
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow(/runner_remote_provider_artifact_incompatible/);
    } finally { await fixture.cleanup(); }
  });

  it.each(["piRpcProxy", "piRpcExecutable", "piProcessHardening"])("refuses a %s digest mismatch", async name => {
    const fixture = await nativePiFixture();
    try {
      fixture.pack.payload.artifacts[name].sha256 = sha("not the file's bytes");
      await fixture.seal();
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow(new RegExp(`runner_remote_provider_artifact_incompatible:.*${name} digest mismatch`, "s"));
    } finally { await fixture.cleanup(); }
  });

  it.each(["pi_rpc", "nativeProviders"])("refuses native Pi selection without %s, even with an ACPX Pi entry", async field => {
    const fixture = await nativePiFixture();
    try {
      // The legacy ACPX lane cannot authorize native Pi.
      fixture.pack.payload.candidateProviders = { pi: fixture.pack.payload.nativeProviders!.pi_rpc };
      if (field === "pi_rpc") delete fixture.pack.payload.nativeProviders!.pi_rpc;
      else delete fixture.pack.payload.nativeProviders;
      await fixture.seal();
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow(/runner_remote_provider_artifact_incompatible:.*pi_rpc/s);
    } finally { await fixture.cleanup(); }
  });

  it("refuses changed files elsewhere in the independent native Pi closure", async () => {
    const fixture = await nativePiFixture();
    try {
      await writeFile(join(fixture.root, "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-ai/package.json"), "corrupted dependency");
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow(/runner_remote_provider_artifact_incompatible:.*native Pi asset tree digest mismatch/s);
    } finally { await fixture.cleanup(); }
  });

  it("also verifies declared native Pi bytes when the caller omits provider", async () => {
    const fixture = await nativePiFixture();
    try {
      fixture.pack.payload.artifacts.piRpcExecutable.sha256 = sha("wrong executable");
      await fixture.seal();
      await expect(verifyRemoteProviderPack({ ...fixture.input, provider: undefined })).rejects.toThrow(/runner_remote_provider_artifact_incompatible:.*piRpcExecutable digest mismatch/s);
    } finally { await fixture.cleanup(); }
  });

  it("admits an exact protected native Pi installation without running commands", async () => {
    const fixture = await nativePiFixture();
    try {
      await expect(verifyRemoteProviderPack({ ...fixture.input,
        installation: { root: fixture.root, manifest: structuredClone(fixture.pack), immutable: true } })).resolves.toEqual(fixture.pack);
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { await fixture.cleanup(); }
  });

  it("refuses a protected installation without native Pi", async () => {
    const fixture = await nativePiFixture();
    try {
      const installed = structuredClone(fixture.pack);
      delete installed.payload.nativeProviders;
      installed.digest = sha(canonicalProviderPackJson(installed.payload));
      await expect(verifyRemoteProviderPack({ ...fixture.input,
        installation: { root: fixture.root, manifest: installed, immutable: true } })).rejects.toThrow("runner_remote_provider_artifact_incompatible");
    } finally { await fixture.cleanup(); }
  });

  it.each(["opencode", "acpx"] as const)("keeps legacy %s content verification valid without a native Pi declaration", async kind => {
    const fixture = await nativePiFixture();
    try {
      delete fixture.pack.payload.nativeProviders;
      delete fixture.pack.payload.artifacts.piRpcProxy;
      delete fixture.pack.payload.artifacts.piRpcExecutable;
      await fixture.seal();
      const provider = kind === "acpx" ? { kind, agent: "claude" } : { kind };
      await expect(verifyRemoteProviderPack({ ...fixture.input, provider })).resolves.toEqual(fixture.pack);
    } finally { await fixture.cleanup(); }
  });
});

// Keep reason: trust boundary. Real verifier subprocesses read fixture bytes;
// only root-owned OS metadata is simulated because the test user cannot chown.
describe("lease-scoped remote provider pack verification memo", () => {
  async function memoFixture() {
    const fixture = await nativePiFixture();
    const state = { mode: "41ed", uid: 0, manifestMode: "81a4", manifestUid: 0, remoteUid: 1000,
      inode: 10, boot: "boot-a", failProbe: false, immutable: true, resolvedRoot: fixture.root,
      fullCalls: 0, probes: 0, audits: 0 };
    const execute = vi.fn(async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
      const script = request.args?.[1] ?? "";
      const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode, signal: null,
        timedOut: false, pid: null, startedAt: new Date().toISOString() });
      if (script.includes("paperclip-provider-pack-fingerprint-v1")) {
        state.probes++;
        if (state.failProbe) return result("", 1);
        return result([state.resolvedRoot, state.boot, String(state.remoteUid), `1:${state.inode}:1:4096:${state.uid}:${state.mode}:1`,
          `1:11:1:1024:${state.manifestUid}:${state.manifestMode}:1`, sha(readFileSync(join(fixture.root, "provider-pack.json"), "utf8")).slice(7)].join("\n") + "\n");
      }
      if (script.includes("paperclip-provider-pack-immutable-v1")) {
        state.audits++;
        return result(state.immutable ? "immutable\n" : "", state.immutable ? 0 : 1);
      }
      state.fullCalls++;
      return fixture.execute(request);
    });
    const onMemoHit = vi.fn(async (_startedAt: number, _endedAt: number) => {});
    return { ...fixture, state, execute, onMemoHit,
      input: { ...fixture.input, runner: { execute }, memoScope: randomUUID(), onMemoHit } };
  }

  it("does the first full verify, then only one cheap round trip on the same lease", async () => {
    const f = await memoFixture();
    try {
      const started = performance.now();
      const first = await verifyRemoteProviderPack(f.input);
      const coldMs = performance.now() - started;
      expect(f.state.fullCalls).toBe(2); // content hash + OpenCode version
      f.execute.mockClear();
      const warmStarted = performance.now();
      const second = await verifyRemoteProviderPack({ ...f.input, runner: { execute: f.execute } });
      const warmMs = performance.now() - warmStarted;
      expect(f.state.fullCalls).toBe(2);
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.onMemoHit).toHaveBeenCalledOnce();
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      first.payload.runnerSourceRevision = "caller mutation";
      expect(second.payload.runnerSourceRevision).not.toBe("caller mutation");
      console.log(JSON.stringify({ evidence: "remote-pack-memo", coldMs, warmMs,
        fullVerifierInvocations: f.state.fullCalls / 2, warmRemoteRoundTrips: f.execute.mock.calls.length }));
    } finally { await f.cleanup(); }
  });

  it.each(["lease", "digest", "inode", "boot", "manifest-bytes", "provider"])("fully re-verifies a changed %s", async change => {
    const f = await memoFixture();
    try {
      await verifyRemoteProviderPack(f.input);
      const next = { ...f.input };
      if (change === "lease") next.memoScope = randomUUID();
      if (change === "digest") { f.pack.payload.runnerSourceRevision = "b".repeat(40); await f.seal(); }
      if (change === "inode") f.state.inode++;
      if (change === "boot") f.state.boot = "boot-b";
      if (change === "manifest-bytes") await writeFile(join(f.root, "provider-pack.json"), JSON.stringify(f.pack, null, 2));
      if (change === "provider") Object.assign(next, { provider: { kind: "opencode" } });
      await verifyRemoteProviderPack(next);
      expect(f.state.fullCalls).toBe(4);
      expect(f.onMemoHit).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it.each(["writable-root", "unowned-root", "writable-manifest", "unowned-manifest", "root-user", "writable-descendant", "failed-probe"])("never memoizes a %s", async failure => {
    const f = await memoFixture();
    try {
      if (failure === "writable-root") f.state.mode = "41fd";
      if (failure === "unowned-root") f.state.uid = 1000;
      if (failure === "writable-manifest") f.state.manifestMode = "81b4";
      if (failure === "unowned-manifest") f.state.manifestUid = 1000;
      if (failure === "root-user") f.state.remoteUid = 0;
      if (failure === "writable-descendant") f.state.immutable = false;
      if (failure === "failed-probe") f.state.failProbe = true;
      await verifyRemoteProviderPack(f.input);
      await verifyRemoteProviderPack(f.input);
      expect(f.state.fullCalls).toBe(4);
      expect(f.onMemoHit).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("never memoizes a failed full verification and still verifies before caching a retry", async () => {
    const f = await memoFixture();
    try {
      const path = join(f.root, f.pack.payload.artifacts.piRpcProxy.path);
      const original = readFileSync(path, "utf8");
      await writeFile(path, "tampered");
      await expect(verifyRemoteProviderPack(f.input)).rejects.toThrow("piRpcProxy digest mismatch");
      await writeFile(path, original);
      await verifyRemoteProviderPack(f.input);
      expect(f.state.fullCalls).toBe(3);
      await verifyRemoteProviderPack(f.input);
      expect(f.state.fullCalls).toBe(3);
      expect(f.onMemoHit).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });

  it("verifies the resolved root rather than a mutable workspace alias", async () => {
    const f = await memoFixture();
    try {
      const alias = `${f.root}-alias`;
      await symlink(f.root, alias);
      try {
        await verifyRemoteProviderPack({ ...f.input, packRoot: alias });
        const full = f.execute.mock.calls.find(([request]) => request.args?.[0] === "-e");
        expect(full?.[0].args?.[2]).toBe(f.root);
        await verifyRemoteProviderPack(f.input);
        expect(f.state.fullCalls).toBe(2);
      } finally { await rm(alias); }
    } finally { await f.cleanup(); }
  });

  it("does not carry a successful memo across a server-module restart", async () => {
    const f = await memoFixture();
    try {
      await verifyRemoteProviderPack(f.input);
      vi.resetModules();
      const restarted = await import("./remote-provider-pack-verification.js");
      await restarted.verifyRemoteProviderPack(f.input);
      expect(f.state.fullCalls).toBe(4);
      expect(f.onMemoHit).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("executes the real single-round-trip probe in milliseconds and refuses an unowned fixture", async () => {
    const f = await nativePiFixture();
    const probeMs: number[] = [];
    const execute = async (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
      const started = performance.now();
      const result = await f.execute(request);
      if (request.args?.[1]?.includes("paperclip-provider-pack-fingerprint-v1")) probeMs.push(performance.now() - started);
      return result;
    };
    const onMemoHit = vi.fn(async () => {});
    try {
      const input = { ...f.input, runner: { execute }, memoScope: randomUUID(), onMemoHit };
      await verifyRemoteProviderPack(input);
      await verifyRemoteProviderPack(input);
      expect(probeMs).toHaveLength(2);
      expect(onMemoHit).not.toHaveBeenCalled();
      expect(f.execute.mock.calls.filter(([request]) => request.args?.[0] === "-e")).toHaveLength(2);
      console.log(JSON.stringify({ evidence: "real-remote-fingerprint-shell", probeMs }));
    } finally { await f.cleanup(); }
  });

  it("requires both the controller lease and physical allocation, scoped to the environment", () => {
    const target = { transport: "sandbox", environmentId: "env-a", leaseId: "lease-a",
      sandboxLeaseAcquisition: { providerLeaseId: "allocation-a" } };
    const scope = remoteProviderPackMemoScope(target);
    expect(scope).toBeDefined();
    expect(remoteProviderPackMemoScope({ ...target })).toBe(scope);
    for (const changed of [{ environmentId: "env-b" }, { leaseId: "lease-b" },
      { sandboxLeaseAcquisition: { providerLeaseId: "allocation-b" } }]) {
      expect(remoteProviderPackMemoScope({ ...target, ...changed })).not.toBe(scope);
    }
    for (const missing of [{ transport: "ssh" }, { environmentId: null }, { leaseId: null }, { sandboxLeaseAcquisition: null }]) {
      expect(remoteProviderPackMemoScope({ ...target, ...missing })).toBeUndefined();
    }
  });

  it("falls back to full verification after a failed warm probe and refuses corrupt bytes", async () => {
    const f = await memoFixture();
    try {
      await verifyRemoteProviderPack(f.input);
      f.state.failProbe = true;
      await writeFile(join(f.root, f.pack.payload.artifacts.piRpcProxy.path), "tampered");
      await expect(verifyRemoteProviderPack(f.input)).rejects.toThrow("piRpcProxy digest mismatch");
      expect(f.onMemoHit).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
});

describe("provider pack manifest digest canonicalization", () => {
  it("matches build-provider-pack.mjs key order, including piRpcProfileDigest before pins", () => {
    const builder = (value: unknown): string => Array.isArray(value) ? `[${value.map(builder).join(",")}]`
      : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${builder((value as Record<string, unknown>)[key])}`).join(",")}}`
        : JSON.stringify(value);
    const payload = { pins: { node: "22" }, piRpcProfileDigest: "sha256:" + "a".repeat(64), nativeProviders: { pi_rpc: { piRpcProxy: { path: "p", sha256: "b" } } }, Zeta: 1, alpha: [ { B: 1, a: 2 } ] };
    expect(canonicalProviderPackDigestJson(payload)).toBe(builder(payload));
    expect(canonicalProviderPackDigestJson(payload).indexOf('"piRpcProfileDigest"')).toBeLessThan(canonicalProviderPackDigestJson(payload).indexOf('"pins"'));
    expect(canonicalProviderPackJson(payload)).toBe(builder(payload));
  });
});


it("verifies real native Pi producer keys with code-unit canonical ordering", async () => {
  const fixture = await nativePiFixture();
  try {
    Object.assign(fixture.pack.payload, { piRpcProfileDigest: sha("native-profile") });
    fixture.pack.payload.pins.piRpc = "1.5.2";
    await fixture.seal();
    await expect(verifyRemoteProviderPack(fixture.input)).resolves.toEqual(fixture.pack);
  } finally { await fixture.cleanup(); }
});


it("canonicalizes comparison keys recursively in code-unit order without localeCompare", () => {
  const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => { throw new Error("locale-dependent comparison"); });
  try {
    const payload = { pins: { z: 0, A: 1 }, piRpcProfileDigest: "profile", nativeProviders: { pi_rpc: { path: "native" } }, array: [{ z: 1, A: 2 }] };
    const expected = '{"array":[{"A":2,"z":1}],"nativeProviders":{"pi_rpc":{"path":"native"}},"piRpcProfileDigest":"profile","pins":{"A":1,"z":0}}';
    expect(canonicalProviderPackJson(payload)).toBe(expected);
    expect(canonicalProviderPackDigestJson(payload)).toBe(expected);
  } finally { localeCompare.mockRestore(); }
});
