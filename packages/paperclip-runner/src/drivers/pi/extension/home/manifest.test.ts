import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeNativeHomeManifest } from "./manifest.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-home-test-")); roots.push(root);
  const agentDir = join(root, "sandbox", ".pi", "agent");
  const guard = join(root, "packages", "guard"), subagents = join(root, "packages", "subagents");
  const skills = join(agentDir, "skills");
  for (const path of [agentDir, guard, subagents, skills, join(subagents, "node_modules", "runtime-dep")]) await mkdir(path, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [guard, subagents], skills: [skills] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { managed: { models: [{ id: "claude-fable-5-2", thinkingLevelMap: { max: null } }] } } }));
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { computer: { command: "computer-after-boat-start" } } }));
  await writeFile(join(guard, "package.json"), JSON.stringify({ name: "@smarty-pants-inc/tool-context-guard", version: "1.0.0", pi: { extensions: ["./index.js"] }, peerDependencies: { "@earendil-works/pi-coding-agent": "*" } }));
  await writeFile(join(guard, "index.js"), "export default function guard() {}\n");
  await writeFile(join(subagents, "package.json"), JSON.stringify({ name: "pi-subagents", version: "0.88.0", dependencies: { "runtime-dep": "1.0.0" }, pi: { extensions: ["./index.js"] } }));
  await writeFile(join(subagents, "index.js"), "import 'runtime-dep';\n");
  await writeFile(join(subagents, "node_modules", "runtime-dep", "package.json"), JSON.stringify({ name: "runtime-dep", version: "1.0.0", main: "index.js" }));
  await writeFile(join(subagents, "node_modules", "runtime-dep", "index.js"), "export const value = 1;\n");
  await writeFile(join(skills, "SKILL.md"), "# Assigned skill\n");
  await writeFile(join(skills, "support.txt"), "lazy supporting bytes\n");
  const options = { agentDir, packages: [{ source: guard, root: guard }, { source: subagents, root: subagents }], resources: [{ kind: "skill" as const, path: skills, source: "home" }], allowedExternalRoots: [join(root, "packages")], environment: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }, runtime: { distributionDigest: "a".repeat(64), cwd: root, argv: ["--no-approve"], projectTrust: "denied" as const, approvedProjectRoots: [] }, effectiveMetadata: { provider: "managed", model: "claude-fable-5-2", mcp: ["computer"] } };
  return { root, agentDir, guard, subagents, skills, options };
}

describe("pi-native-home/v1 (private manifest, data safety boundary)", () => {
  it("hashes the post-start sandbox native home, not a Runner copy", async () => {
    const f = await fixture();
    const before = await computeNativeHomeManifest(f.options);
    const path = join(f.agentDir, "mcp.json");
    expect(before.schema).toBe("pi-native-home/v1");
    expect(before.entries.find(entry => entry.logicalPath === "home/mcp.json")).toMatchObject({ kind: "file", resolvedPath: path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
    await mkdir(join(f.root, "runner-private"));
    await writeFile(join(f.root, "runner-private", "mcp.json"), "wrong Runner copy");
    expect((await computeNativeHomeManifest(f.options)).digest).toBe(before.digest);
    await writeFile(path, JSON.stringify({ mcpServers: { computer: { command: "new-boat-computer" } } }));
    expect((await computeNativeHomeManifest(f.options)).digest).not.toBe(before.digest);
  });
  it.each(["guard", "dependency", "skill", "agents", "settings", "models"])("includes %s bytes", async target => {
    const f = await fixture(); const before = await computeNativeHomeManifest(f.options);
    const path = target === "guard" ? join(f.guard, "index.js") : target === "dependency" ? join(f.subagents, "node_modules", "runtime-dep", "index.js") : target === "skill" ? join(f.skills, "support.txt") : join(f.agentDir, target === "agents" ? "AGENTS.md" : `${target}.json`);
    await writeFile(path, target === "settings" ? JSON.stringify({ packages: [f.guard, f.subagents], changed: true }) : target === "models" ? "{}" : "changed executable/resource bytes\n");
    expect((await computeNativeHomeManifest(f.options)).digest).not.toBe(before.digest);
  });
  it("ignores session, spill, cache, auth, log and mtime churn", async () => {
    const f = await fixture(); const before = await computeNativeHomeManifest(f.options);
    for (const name of ["sessions", "spills", "cache", "logs"]) { await mkdir(join(f.agentDir, name)); await writeFile(join(f.agentDir, name, "churn"), "PRIVATE_SENTINEL"); }
    for (const name of ["auth.json", "models-store.json", "mcp.log"]) await writeFile(join(f.agentDir, name), "PRIVATE_SENTINEL");
    await utimes(join(f.guard, "index.js"), new Date(1), new Date(1));
    const after = await computeNativeHomeManifest(f.options);
    expect(after.digest).toBe(before.digest);
    expect(JSON.stringify(after)).not.toContain("PRIVATE_SENTINEL");
    expect(before.entries.find(entry => entry.logicalPath === "home/AGENTS.md")).toMatchObject({ kind: "absent" });
  });
  it("is bytewise sorted and independent of supplied inventory enumeration order", async () => {
    const f = await fixture(); const before = await computeNativeHomeManifest(f.options);
    const after = await computeNativeHomeManifest({ ...f.options, packages: [...f.options.packages].reverse() });
    expect(after.digest).toBe(before.digest);
    const keys = before.entries.map(entry => entry.logicalPath);
    expect(keys).toEqual([...keys].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    await chmod(join(f.guard, "index.js"), 0o755);
    expect((await computeNativeHomeManifest(f.options)).digest).not.toBe(before.digest);
  });
  it("includes approved symlink bytes and targets; rejects undeclared external code", async () => {
    const f = await fixture(); const external = join(f.root, "external"); await mkdir(external); await writeFile(join(external, "code.js"), "first");
    await symlink(join(external, "code.js"), join(f.guard, "linked.js"));
    await expect(computeNativeHomeManifest(f.options)).rejects.toMatchObject({ code: "pi_home_external_root" });
    const options = { ...f.options, allowedExternalRoots: [...f.options.allowedExternalRoots, external] };
    const before = await computeNativeHomeManifest(options);
    expect(before.entries.some(entry => entry.kind === "symlink")).toBe(true);
    await writeFile(join(external, "code.js"), "other");
    expect((await computeNativeHomeManifest(options)).digest).not.toBe(before.digest);
  });
  it("fails closed on dangling links, cycles and unresolved runtime dependencies", async () => {
    const f = await fixture(); await symlink("missing", join(f.guard, "broken.js"));
    await expect(computeNativeHomeManifest(f.options)).rejects.toThrow(); await rm(join(f.guard, "broken.js"));
    await symlink(".", join(f.guard, "loop"));
    await expect(computeNativeHomeManifest(f.options)).rejects.toMatchObject({ code: "pi_home_symlink_cycle" }); await rm(join(f.guard, "loop"));
    await rm(join(f.subagents, "node_modules"), { recursive: true });
    await expect(computeNativeHomeManifest(f.options)).rejects.toMatchObject({ code: "pi_home_dependency_missing" });
  });
  it("does not let cache/log directory names hide executable package assets", async () => {
    const f = await fixture(); await mkdir(join(f.guard, "cache"));
    await writeFile(join(f.guard, "cache", "runtime.js"), "first");
    const before = await computeNativeHomeManifest(f.options);
    await writeFile(join(f.guard, "cache", "runtime.js"), "other");
    expect((await computeNativeHomeManifest(f.options)).digest).not.toBe(before.digest);
  });
  it("supports admitted settings symlinks and does not accept a declaration without its resolved closure", async () => {
    const f = await fixture(), path = join(f.agentDir, "settings.json"), target = join(f.guard, "native-settings.json");
    await writeFile(target, await readFile(path)); await rm(path); await symlink(target, path);
    const manifest = await computeNativeHomeManifest(f.options);
    expect(manifest.entries.some(entry => entry.logicalPath === "home/settings.json" && entry.kind === "symlink")).toBe(true);
    await expect(computeNativeHomeManifest({ ...f.options, packages: [] })).rejects.toMatchObject({ code: "pi_home_package_unresolved" });
  });
  it("does not spread unallowlisted runtime/resource properties into stable identity", async () => {
    const f = await fixture(), before = await computeNativeHomeManifest(f.options);
    const after = await computeNativeHomeManifest({ ...f.options, runtime: { ...f.options.runtime, ...{ pid: 123, secret: "PRIVATE_SENTINEL" } }, resources: f.options.resources.map(resource => ({ ...resource, secret: "PRIVATE_SENTINEL" })) });
    expect(after.digest).toBe(before.digest); expect(JSON.stringify(after)).not.toContain("PRIVATE_SENTINEL");
  });
  it("requires every configured package to have a native resolved root (no install guessing)", async () => {
    const f = await fixture();
    await expect(computeNativeHomeManifest({ ...f.options, packages: f.options.packages.slice(0, 1) })).rejects.toMatchObject({ code: "pi_home_package_unresolved" });
  });
  it("does not leak malformed private configuration bytes in errors", async () => {
    const f = await fixture(); await writeFile(join(f.agentDir, "settings.json"), "PRIVATE_SENTINEL");
    const error = await computeNativeHomeManifest(f.options).then(() => undefined, error => error);
    expect(error).toMatchObject({ code: "pi_home_config_invalid" }); expect(String(error)).not.toContain("PRIVATE_SENTINEL");
  });
  it("records allowlisted env presence exactly, but never arbitrary env secrets", async () => {
    const f = await fixture();
    const manifests = await Promise.all([undefined, "0", "1"].map(PI_OFFLINE => computeNativeHomeManifest({ ...f.options, environment: { ...f.options.environment, PI_OFFLINE, DO_NOT_HASH_SECRET: "PRIVATE_SENTINEL" } })));
    expect(new Set(manifests.map(m => m.digest)).size).toBe(3);
    expect(manifests[0].environment.PI_OFFLINE).toEqual({ present: false });
    expect(manifests[1].environment.PI_OFFLINE).toEqual({ present: true, value: "0" });
    expect(JSON.stringify(manifests)).not.toContain("PRIVATE_SENTINEL");
  });
});
