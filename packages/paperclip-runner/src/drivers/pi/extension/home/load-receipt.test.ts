// Keep reason: required-package loading is an admission/trust boundary.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitNativeHome } from "./admission.js";
import { canonicalJson, computeNativeHomeManifest, sha256 } from "./manifest.js";
import { buildNativeHomeLoadReceipt, type NativeHomeToolInfo } from "./load-receipt.js";
import { registerNativeHome, type HomeAdmissionRequest, type NativeHomePi, type RegisterHomeAdmission } from "./register.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-load-")); roots.push(root);
  const agentDir = join(root, "agent"), guard = join(root, "guard"), subagents = join(root, "subagents");
  for (const path of [agentDir, guard, subagents]) await mkdir(path);
  const effectivePackages = [{ source: guard }, { source: subagents }];
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: effectivePackages }));
  await writeFile(join(agentDir, "models.json"), "{}");
  for (const [path, name, version] of [[guard, "@smarty-pants-inc/tool-context-guard", "1.0.0"], [subagents, "pi-subagents", "0.88.0"]]) {
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version, pi: { extensions: ["./index.js"] } }));
    await writeFile(join(path, "index.js"), "export default function() {}\n");
  }
  const environment = { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
  const options = { agentDir, packages: effectivePackages.map(pkg => ({ ...pkg, root: pkg.source })), resources: [], allowedExternalRoots: [root], environment, runtime: { distributionDigest: "a".repeat(64), cwd: root, argv: [], projectTrust: "denied" as const, approvedProjectRoots: [] }, effectiveMetadata: { packages: effectivePackages }, effectivePackages, effectiveExtensions: [] };
  const manifest = await computeNativeHomeManifest(options);
  const required = [{ role: "tool-context-guard" as const, root: guard, version: "1.0.0" }, { role: "pi-subagents" as const, root: subagents, version: "0.88.0" }];
  const loadReceipt = {
    schema: "pi-native-load/v1" as const, sessionId: "native-session", manifestDigest: manifest.digest,
    startup: { rule: "startup-fatal" as const, piVersion: "1.5.2" },
    effectiveSettingsDigest: sha256(canonicalJson({ effectivePackages: manifest.effectivePackages, effectiveExtensions: manifest.effectiveExtensions })),
    subagentTool: { name: "subagent" as const, root: subagents, path: join(subagents, "index.js") },
    extensionErrors: { observability: "not observable in-process" as const },
  };
  return { manifest, required, environment, sessionId: "native-session", loadReceipt, options, guard, subagents, settings: { packages: effectivePackages, extensions: [] as string[] } };
}
function resign(input: Awaited<ReturnType<typeof fixture>>) {
  const { digest: _, ...body } = input.manifest;
  input.manifest.digest = sha256(canonicalJson(body)); input.loadReceipt.manifestDigest = input.manifest.digest;
  input.loadReceipt.effectiveSettingsDigest = sha256(canonicalJson({ effectivePackages: body.effectivePackages, effectiveExtensions: body.effectiveExtensions }));
}

describe("F014 startup-fatal load receipt", () => {
  it("rejects the version-specific startup-fatal rule on the wrong Pi version", async () => {
    const input = await fixture(); input.loadReceipt.startup.piVersion = "1.5.3";
    await expect(admitNativeHome(input)).rejects.toMatchObject({ code: "pi_home_startup_rule_invalid" });
  });
  it("rejects a required root missing from the effective settings packages", async () => {
    const input = await fixture();
    Object.assign(input.manifest, { effectivePackages: [{ source: input.subagents }] }); resign(input);
    await expect(admitNativeHome(input)).rejects.toMatchObject({ code: "pi_home_required_not_configured" });
  });
  it("rejects a required root disabled in effective settings", async () => {
    const input = await fixture();
    Object.assign(input.manifest, { effectivePackages: [{ source: input.guard, extensions: [] }, { source: input.subagents }] }); resign(input);
    await expect(admitNativeHome(input)).rejects.toMatchObject({ code: "pi_home_required_disabled" });
  });
  it("rejects a subagent tool whose owning baseDir is another package", async () => {
    const input = await fixture(); input.loadReceipt.subagentTool.root = input.guard;
    await expect(admitNativeHome(input)).rejects.toMatchObject({ code: "pi_home_subagent_provenance" });
  });
  it("admits all required in-process facts and returns the exact pi-native-home/v1 digest", async () => {
    const input = await fixture();
    expect(await admitNativeHome(input)).toEqual({ digest: input.manifest.digest });
    expect(input.manifest.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("accepts the declared tool-cap guard alternative, without requiring both guards", async () => {
    const input = await fixture();
    await writeFile(join(input.guard, "package.json"), JSON.stringify({ name: "@smarty-pants-inc/tool-cap", version: "1.0.0", pi: { extensions: ["./index.js"] } }));
    Object.assign(input.required[0], { role: "tool-cap" }); input.manifest = await computeNativeHomeManifest(input.options); resign(input);
    expect(await admitNativeHome(input)).toEqual({ digest: input.manifest.digest });
  });
  it("rejects required package bytes changed after manifest collection", async () => {
    const input = await fixture(); await writeFile(join(input.guard, "index.js"), "throw Error('drift');\n");
    await expect(admitNativeHome(input)).rejects.toMatchObject({ code: "pi_home_package_drift" });
  });
  it("rejects an added package entry rather than trusting a stale closure", async () => {
    const input = await fixture(); await writeFile(join(input.guard, "extra.js"), "export {};\n");
    await expect(admitNativeHome(input)).rejects.toMatchObject({ code: "pi_home_package_drift" });
  });
  it.each(["missing-effective-settings", "top-level-disable", "cli-disable", "partial-package-selection", "patterned-package-selection", "legacy-loader-receipt"])("fails closed on %s", async defect => {
    const input = await fixture();
    if (defect === "missing-effective-settings") Object.assign(input.manifest, { effectivePackages: undefined });
    if (defect === "top-level-disable") Object.assign(input.manifest, { effectiveExtensions: [`-${join(input.guard, "index.js")}`] });
    if (defect === "cli-disable") input.manifest.runtime.argv = ["--no-extensions"];
    if (defect === "partial-package-selection") input.manifest.effectivePackages![0].extensions = ["package.json"];
    if (defect === "patterned-package-selection") input.manifest.effectivePackages![0].extensions = ["*.js"];
    resign(input);
    if (defect === "legacy-loader-receipt") Object.assign(input.loadReceipt, { startup: undefined, packages: [] });
    await expect(admitNativeHome(input)).rejects.toBeInstanceOf(Error);
  });
});

function nativePort(input: Awaited<ReturnType<typeof fixture>>) {
  type Start = (event: { reason?: string }, ctx: { sessionManager: { getSessionId(): string } }) => void | Promise<void>;
  type Shutdown = (event: { reason?: string }) => void;
  let start: Start | undefined, shutdown: Shutdown | undefined;
  let admission: Parameters<RegisterHomeAdmission>[0] | undefined;
  let tools: NativeHomeToolInfo[] = [{ name: "subagent", sourceInfo: { baseDir: input.subagents, path: join(input.subagents, "index.js") } }];
  const pi: NativeHomePi = {
    getAllTools: () => tools,
    getSettings: () => input.settings,
    on: ((event: string, handler: Start | Shutdown) => {
      if (event === "session_start") { start = handler as Start; return () => { start = undefined; }; }
      if (event === "session_shutdown") { shutdown = handler as Shutdown; return () => { shutdown = undefined; }; }
      throw new Error(`Unsupported public event: ${event}`);
    }) as NativeHomePi["on"],
  };
  const registration = registerNativeHome(pi, handler => { admission = handler; return () => { admission = undefined; }; });
  const configure = () => registration.configure({ piVersion: "1.5.2", collect: async () => ({ ...input, manifest: await computeNativeHomeManifest(input.options) }) });
  const request = (overrides: Partial<HomeAdmissionRequest> = {}) => {
    if (!admission) throw new Error("Home seam is unregistered");
    return Promise.resolve(admission({ sessionId: input.sessionId, epoch: 1, runId: "run-1", signal: new AbortController().signal, ...overrides }));
  };
  return { pi, registration, configure, request, start: (reason = "startup", id = input.sessionId) => start?.({ reason }, { sessionManager: { getSessionId: () => id } }), shutdown: (reason = "new") => shutdown?.({ reason }), setTools: (value: NativeHomeToolInfo[]) => { tools = value; } };
}

describe("F014 in-process collection and bind seam", () => {
  it("builds startup-fatal and explicit unobservable-error facts using ALL tools, not active tools", async () => {
    const input = await fixture(), port = nativePort(input);
    const receipt = await buildNativeHomeLoadReceipt({ ...input, piVersion: "1.5.2", tools: port.pi.getAllTools() });
    expect(receipt).toEqual(input.loadReceipt);
    port.configure(); await port.start();
    expect(await port.request()).toEqual({ digest: input.manifest.digest });
    port.registration.dispose();
  });
  it.each(["wrong-version", "missing-tool", "wrong-baseDir", "duplicate-tool", "missing-provenance"])("rejects %s native API evidence", async defect => {
    const input = await fixture(), port = nativePort(input);
    let tools = [...port.pi.getAllTools()];
    if (defect === "missing-tool") tools = [];
    if (defect === "wrong-baseDir") tools[0] = { name: "subagent", sourceInfo: { baseDir: input.guard } };
    if (defect === "duplicate-tool") tools.push(tools[0]);
    if (defect === "missing-provenance") tools[0] = { name: "subagent" };
    await expect(buildNativeHomeLoadReceipt({ ...input, piVersion: defect === "wrong-version" ? "1.5.3" : "1.5.2", tools })).rejects.toBeInstanceOf(Error);
    port.registration.dispose();
  });
  it("canonicalizes a loader-owned baseDir alias, and supports path-only root provenance", async () => {
    const input = await fixture(), alias = join(input.options.agentDir, "subagents-alias");
    await symlink(input.subagents, alias);
    const receipt = await buildNativeHomeLoadReceipt({ ...input, piVersion: "1.5.2", tools: [{ name: "subagent", sourceInfo: { baseDir: alias, path: join(alias, "index.js") } }] });
    expect(receipt.subagentTool).toEqual(input.loadReceipt.subagentTool);
    const fallback = await buildNativeHomeLoadReceipt({ ...input, piVersion: "1.5.2", tools: [{ name: "subagent", sourceInfo: { path: alias } }] });
    expect(fallback.subagentTool).toEqual({ name: "subagent", root: input.subagents });
  });
  it("does not infer the owner from a path substring or an arbitrary extension file", async () => {
    const input = await fixture();
    await expect(buildNativeHomeLoadReceipt({ ...input, piVersion: "1.5.2", tools: [{ name: "subagent", sourceInfo: { path: join(input.subagents, "index.js") } }] })).rejects.toMatchObject({ code: "pi_home_subagent_provenance" });
  });
  it("rejects a fabricated effective-settings manifest instead of trusting caller-supplied selection", async () => {
    const input = await fixture(), port = nativePort(input); port.configure(); await port.start();
    input.settings.extensions.push(`-${join(input.guard, "index.js")}`);
    await expect(port.request()).rejects.toMatchObject({ code: "pi_home_effective_settings_mismatch" });
    port.registration.dispose();
  });
  it("rejects settings bytes changed on disk after the resident startup snapshot", async () => {
    const input = await fixture(), port = nativePort(input); port.configure(); await port.start();
    await writeFile(join(input.options.agentDir, "settings.json"), "{}");
    await expect(port.request()).rejects.toMatchObject({ code: "pi_home_settings_drift" });
    port.registration.dispose();
  });
  it("fails closed before configuration/session_start and on another session", async () => {
    const input = await fixture(), port = nativePort(input);
    await expect(port.request()).rejects.toMatchObject({ code: "pi_home_not_configured" });
    port.configure(); await expect(port.request()).rejects.toMatchObject({ code: "pi_home_load_receipt_stale" });
    await port.start(); await expect(port.request({ sessionId: "other" })).rejects.toMatchObject({ code: "pi_home_load_receipt_stale" });
    port.registration.dispose(); expect(() => port.request()).toThrow("unregistered");
  });
  it.each(["quit", "reload"])("unregisters the contributor on native %s shutdown", async reason => {
    const input = await fixture(), port = nativePort(input); port.configure(); await port.start();
    port.shutdown(reason); expect(() => port.request()).toThrow("unregistered");
    port.registration.dispose();
  });
  it("refuses /reload because only INITIAL CLI import/factory failure is startup-fatal", async () => {
    const input = await fixture(), port = nativePort(input); port.configure(); await port.start();
    expect(await port.request()).toEqual({ digest: input.manifest.digest });
    await port.start("reload"); await expect(port.request()).rejects.toMatchObject({ code: "pi_home_startup_rule_invalid" });
    port.registration.dispose();
  });
  it.each(["new", "resume", "fork"])("revalidates the startup bytes and binds the new session after %s", async reason => {
    const input = await fixture(), port = nativePort(input); port.configure(); await port.start();
    const first = await port.request(); await port.start(reason, "next-session");
    await expect(port.request()).rejects.toMatchObject({ code: "pi_home_load_receipt_stale" });
    expect(await port.request({ sessionId: "next-session" })).toEqual(first);
    await writeFile(join(input.guard, "index.js"), "export default function(){ /* NOT the loaded bytes */ }\n");
    await expect(port.request({ sessionId: "next-session" })).rejects.toMatchObject({ code: "pi_home_package_drift" });
    port.shutdown(); await expect(port.request({ sessionId: "next-session" })).rejects.toMatchObject({ code: "pi_home_load_receipt_stale" });
    port.registration.dispose();
  });
  it.each(["abort", "session-change", "shutdown", "dispose"])("does not return a digest if %s races collection", async defect => {
    const input = await fixture(), port = nativePort(input), controller = new AbortController();
    let finish!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; }), collected = new Promise<void>(resolve => { entered = resolve; });
    port.registration.configure({ piVersion: "1.5.2", collect: async () => { entered(); await waiting; return input; } });
    const starting = port.start(); const pending = port.request({ signal: controller.signal }); await collected;
    if (defect === "abort") controller.abort(new Error("bind cancelled"));
    if (defect === "session-change") await port.start("resume");
    if (defect === "shutdown") port.shutdown();
    if (defect === "dispose") port.registration.dispose();
    finish(); await starting; await expect(pending).rejects.toBeInstanceOf(Error); port.registration.dispose();
  });
});
