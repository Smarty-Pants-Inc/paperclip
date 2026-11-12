import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
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
      .map(path => path.slice(prefix.length).split("/")[0]))].sort((a, b) => a.localeCompare(b));
    for (const child of children) {
      const path = `${prefix}${child}`;
      if (path in files) records.push(`file\0${path}\0${sha(files[path])}\n`);
      else { records.push(`directory\0${path}\n`); visit(`${path}/`); }
    }
  };
  visit("");
  return sha(records.join(""));
}

async function nativePiFixture() {
  const root = await mkdtemp(join(tmpdir(), "native-pi-pack-verification-"));
  const pack = manifest("a") as NativePiPack;
  Object.assign(pack.payload.pins, { acpx: "0.22.0", claudeAcp: "0.73.0", codexAcp: "1.6.2" });
  const nativePath = "provider-assets/pi_rpc/linux-x64";
  const executablePath = `${nativePath}/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`;
  const proxyPath = "dist/cli/pi-rpc-app-server-proxy.cjs";
  const files: Record<string, string> = {
    [pack.payload.artifacts.nodeCommand.path]: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    [pack.payload.artifacts.opencodeCommand.path]: `#!/bin/sh\nprintf '%s\n' '${pack.payload.pins.opencode}'\n`,
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
  it("verifies the declared native Pi proxy, executable and closure over the remote runner", async () => {
    const fixture = await nativePiFixture();
    try {
      const verified = await verifyRemoteProviderPack(fixture.input);
      expect(verified).toEqual(fixture.pack);
      expect(verified).not.toBe(fixture.pack);
      expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({ bypassSession: true, timeoutMs: 30_000 }));
    } finally { await fixture.cleanup(); }
  });

  it.each(["piRpcProxy", "piRpcExecutable"])("refuses a missing %s manifest entry", async name => {
    const fixture = await nativePiFixture();
    try {
      delete fixture.pack.payload.artifacts[name];
      await fixture.seal();
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow(/runner_remote_provider_artifact_incompatible/);
    } finally { await fixture.cleanup(); }
  });

  it.each(["piRpcProxy", "piRpcExecutable"])("refuses a missing %s file", async name => {
    const fixture = await nativePiFixture();
    try {
      await rm(join(fixture.root, fixture.pack.payload.artifacts[name].path));
      await expect(verifyRemoteProviderPack(fixture.input)).rejects.toThrow(/runner_remote_provider_artifact_incompatible/);
    } finally { await fixture.cleanup(); }
  });

  it.each(["piRpcProxy", "piRpcExecutable"])("refuses a %s digest mismatch", async name => {
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
