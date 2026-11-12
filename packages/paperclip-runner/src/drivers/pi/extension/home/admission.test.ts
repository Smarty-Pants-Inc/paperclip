import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitNativeHome, assertClaudeClamp, checkNativeHomeEnvironment } from "./admission.js";
import { canonicalJson, computeNativeHomeManifest, sha256 } from "./manifest.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-admit-test-")); roots.push(root);
  const agentDir = join(root, "agent"), guard = join(root, "guard"), subagents = join(root, "subagents");
  for (const p of [agentDir, guard, subagents]) await mkdir(p);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [guard, subagents] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { managed: { models: [{ id: "claude-fable-5-2", thinkingLevelMap: { max: null } }], modelOverrides: { "claude-sonnet-5": { thinkingLevelMap: { max: null } } } } } }));
  for (const [path, name, version] of [[guard, "@smarty-pants-inc/tool-context-guard", "1.0.0"], [subagents, "pi-subagents", "0.88.0"]]) { await writeFile(join(path, "package.json"), JSON.stringify({ name, version, pi: { extensions: ["./index.js"] } })); await writeFile(join(path, "index.js"), "export default function() {}\n"); }
  const environment = { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
  const manifest = await computeNativeHomeManifest({ agentDir, packages: [{ source: guard, root: guard }, { source: subagents, root: subagents }], resources: [], allowedExternalRoots: [root], environment, runtime: { distributionDigest: "a".repeat(64), cwd: root, argv: [], projectTrust: "denied", approvedProjectRoots: [] }, effectiveMetadata: {}, effectivePackages: [guard, subagents], effectiveExtensions: [] });
  const required = [{ role: "tool-context-guard" as const, root: guard, version: "1.0.0" }, { role: "pi-subagents" as const, root: subagents, version: "0.88.0" }];
  const loadReceipt = { schema: "pi-native-load/v1" as const, sessionId: "native-session", manifestDigest: manifest.digest, startup: { rule: "startup-fatal" as const, piVersion: "1.5.2" }, effectiveSettingsDigest: sha256(canonicalJson({ effectivePackages: manifest.effectivePackages, effectiveExtensions: manifest.effectiveExtensions })), subagentTool: { name: "subagent" as const, root: subagents, path: join(subagents, "index.js") }, extensionErrors: { observability: "not observable in-process" as const } };
  return { agentDir, manifest, required, environment, sessionId: "native-session", loadReceipt };
}

describe("native required-load admission (trust boundary)", () => {
  it("fails closed without the resident's in-process load facts", async () => {
    const input = await fixture();
    await expect(admitNativeHome({ ...input, loadReceipt: undefined })).rejects.toMatchObject({ code: "pi_home_load_receipt_missing" });
  });
  it("admits exact loaded roots and versions, returning only the opaque digest contribution", async () => {
    const input = await fixture();
    expect(await admitNativeHome(input)).toEqual({ digest: input.manifest.digest });
  });
  it.each(["wrong-version", "wrong-root", "missing-root", "duplicate", "stale-session", "stale-digest", "missing-tool"])("rejects %s admission facts", async defect => {
    const input = await fixture(), receipt = input.loadReceipt;
    if (defect === "wrong-version") input.required[0].version = "999.0.0";
    if (defect === "wrong-root") input.required[0].root = input.required[1].root;
    if (defect === "missing-root") await rm(input.required[0].root, { recursive: true });
    if (defect === "duplicate") input.required.push(input.required[0]);
    if (defect === "stale-session") receipt.sessionId = "another-session";
    if (defect === "stale-digest") receipt.manifestDigest = "b".repeat(64);
    if (defect === "missing-tool") Object.assign(receipt, { subagentTool: undefined });
    await expect(admitNativeHome(input)).rejects.toBeInstanceOf(Error);
  });
  it("cannot silently omit either required package role", async () => {
    const input = await fixture(); await expect(admitNativeHome({ ...input, required: input.required.slice(1) })).rejects.toMatchObject({ code: "pi_home_required_packages" });
  });
  it("rechecks the manifest's model bytes and forbids stale disk admission", async () => {
    const input = await fixture(); await writeFile(join(input.agentDir, "models.json"), "{}");
    await expect(admitNativeHome(input)).rejects.toMatchObject({ code: "pi_home_models_drift" });
  });
  it("requires exact Claude max:null in models and modelOverrides; never lowers the request", () => {
    for (const max of [undefined, "high", "max", 0]) expect(() => assertClaudeClamp({ providers: { managed: { models: [{ id: "claude-fable-5-2", thinkingLevelMap: { max } }] } } })).toThrow();
    expect(() => assertClaudeClamp({ providers: { managed: { modelOverrides: { "claude-sonnet-5": { thinkingLevelMap: { max: "high" } } } } } })).toThrow();
    expect(() => assertClaudeClamp({ providers: { managed: { models: [{ id: "gpt-6-astra", thinkingLevelMap: { max: "max" } }, { id: "claude-fable-5-2", thinkingLevelMap: { max: null } }] } } })).not.toThrow();
  });
  it("has presence-sensitive offline policy, exact version-check policy, and F027 UI unset", () => {
    expect(() => checkNativeHomeEnvironment({ PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" })).not.toThrow();
    for (const PI_OFFLINE of [undefined, "0", ""]) expect(() => checkNativeHomeEnvironment({ PI_OFFLINE, PI_SKIP_VERSION_CHECK: "1" })).toThrow();
    for (const PI_SUBAGENTS_COMPONENT_UI of ["1", "0", ""]) expect(() => checkNativeHomeEnvironment({ PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_SUBAGENTS_COMPONENT_UI })).toThrow();
  });
});
