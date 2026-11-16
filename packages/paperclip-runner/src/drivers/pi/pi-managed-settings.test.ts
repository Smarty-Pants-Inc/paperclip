import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configurePiManagedCompaction } from "./pi-managed-settings.js";

const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "pi-managed-settings-")); roots.push(path); return path; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("copies complete original settings only for a fresh managed home, then adds the reserve", async () => {
  const original = await root(), managed = await root();
  const packageRoot = join(original, "npm", "node_modules", "@lll9p", "pi-better-compaction");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@lll9p/pi-better-compaction", version: "0.7.4" }));
  const localRoot = join(original, "tool-cap");
  await mkdir(localRoot);
  const source = { packages: [localRoot, "npm:@lll9p/pi-better-compaction@0.7.4"],
    compaction: { modelOverrides: { "vendor/model": { reserveTokens: 321, keepRecentTokens: 654 } } }, retry: { enabled: true, maxRetries: 4, baseDelayMs: 10, maxAgentDelayMs: 20, provider: { maxRetries: 2 } } };
  await writeFile(join(original, "settings.json"), JSON.stringify(source));
  await configurePiManagedCompaction({ agentHome: managed, originalAgentHome: original, model: "vendor/model", contextWindow: 1000 });
  expect(JSON.parse(await readFile(join(managed, "settings.json"), "utf8"))).toEqual({ ...source,
    packages: [localRoot, packageRoot], compaction: { ...source.compaction, reserveTokens: 321 } });
});

it("keeps existing managed settings behaviour and original-home behaviour", async () => {
  const original = await root(), managed = await root();
  const originalSettings = { packages: ["npm:original"], compaction: { modelOverrides: { "vendor/model": { reserveTokens: 11 } } }, retry: { enabled: true } };
  await writeFile(join(original, "settings.json"), JSON.stringify(originalSettings));
  await writeFile(join(managed, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  await configurePiManagedCompaction({ agentHome: managed, originalAgentHome: original, model: "vendor/model", contextWindow: 2000 });
  expect(JSON.parse(await readFile(join(managed, "settings.json"), "utf8"))).toEqual({ retry: { enabled: false }, compaction: { reserveTokens: 11 } });
  await configurePiManagedCompaction({ agentHome: original, originalAgentHome: original, model: "vendor/model", contextWindow: 2000 });
  expect(JSON.parse(await readFile(join(original, "settings.json"), "utf8"))).toEqual(originalSettings);
});

it.each(["missing-package", "invalid-settings"])("fails closed on the runtime image's %s before writing session settings", async failure => {
  const home = await root(), managed = await root();
  const imageHome = join(home, ".pi", "agent");
  await mkdir(imageHome, { recursive: true });
  const bytes = failure === "missing-package" ? JSON.stringify({ packages: ["npm:missing"] }) : "{invalid";
  await writeFile(join(imageHome, "settings.json"), bytes);
  vi.stubEnv("HOME", home);
  const configure = configurePiManagedCompaction({ agentHome: managed, originalAgentHome: managed, model: "paperclip/m", contextWindow: 400 });
  if (failure === "missing-package") await expect(configure).rejects.toMatchObject({ code: "pi_managed_package_not_installed" });
  else await expect(configure).rejects.toThrow("refusing to overwrite");
  await expect(readFile(join(managed, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(imageHome, "settings.json"), "utf8")).toBe(bytes);
});

it("preserves absolute local paths, git declarations and existing managed-relative packages", async () => {
  const original = await root(), managed = await root();
  const localRoot = join(original, "absolute-tools"), managedRoot = join(managed, "managed-tools");
  await mkdir(localRoot); await mkdir(managedRoot);
  const sources = [localRoot, "git:github.com/example/pi-tools@v1", "https://github.com/example/pi-tools", "ssh://git@example.com/org/tools"];
  await writeFile(join(original, "settings.json"), JSON.stringify({ packages: sources }));
  await configurePiManagedCompaction({ agentHome: managed, originalAgentHome: original, model: "m", contextWindow: 400 });
  expect(JSON.parse(await readFile(join(managed, "settings.json"), "utf8"))).toEqual({ packages: sources, compaction: { reserveTokens: 100 } });
  const ownSettings = { packages: ["./managed-tools"], compaction: { reserveTokens: 77 } };
  await writeFile(join(managed, "settings.json"), JSON.stringify(ownSettings));
  await configurePiManagedCompaction({ agentHome: managed, originalAgentHome: original, model: "m", contextWindow: 400 });
  expect(JSON.parse(await readFile(join(managed, "settings.json"), "utf8"))).toEqual(ownSettings);
});

// Keep: RFL F4/F5 pre-write validation protects the managed settings trust boundary.
it.each(["relative", "absolute", "filtered"] as const)("fails closed on a missing %s local package before writing settings", async kind => {
  const original = await root(), managed = await root();
  const source = kind === "absolute" ? join(original, "missing") : "./missing";
  const bytes = JSON.stringify({ packages: [kind === "filtered" ? { source, extensions: [] } : source] });
  await writeFile(join(original, "settings.json"), bytes);
  await expect(configurePiManagedCompaction({ agentHome: managed, originalAgentHome: original, model: "m", contextWindow: 400 }))
    .rejects.toMatchObject({ code: "pi_managed_local_package_missing" });
  await expect(readFile(join(managed, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(original, "settings.json"), "utf8")).toBe(bytes);
});

it.each([
  ["image", "string", "./tools"], ["image", "object", { source: "./tools" }], ["image", "number", 7],
  ["original", "string", "./tools"], ["original", "object", { source: "./tools" }], ["original", "number", 7],
] as const)("rejects non-array packages from the %s home (%s) before writing settings", async (kind, _type, packages) => {
  const home = await root(), managed = await root();
  const original = kind === "image" ? join(home, ".pi", "agent") : home;
  await mkdir(original, { recursive: true });
  const bytes = JSON.stringify({ packages });
  await writeFile(join(original, "settings.json"), bytes);
  vi.stubEnv("HOME", home);
  await expect(configurePiManagedCompaction({ agentHome: managed, originalAgentHome: kind === "image" ? managed : original, model: "m", contextWindow: 400 }))
    .rejects.toMatchObject({ code: "pi_managed_packages_invalid" });
  await expect(readFile(join(managed, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(original, "settings.json"), "utf8")).toBe(bytes);
});

it("keeps session settings and models separate", async () => {
  const original = await root(), one = await root(), two = await root();
  const localRoot = join(original, "shared-package");
  await mkdir(localRoot);
  await writeFile(join(original, "settings.json"), JSON.stringify({ packages: [localRoot], retry: { enabled: true } }));
  for (const [home, id] of [[one, "one"], [two, "two"]] as const) {
    await configurePiManagedCompaction({ agentHome: home, originalAgentHome: original, model: "m", contextWindow: 400 });
    await writeFile(join(home, "models.json"), id);
  }
  await writeFile(join(one, "settings.json"), `${JSON.stringify({ session: "one" })}\n`);
  expect(await readFile(join(one, "settings.json"), "utf8")).not.toBe(await readFile(join(two, "settings.json"), "utf8"));
  expect(await readFile(join(one, "models.json"), "utf8")).toBe("one");
  expect(await readFile(join(two, "models.json"), "utf8")).toBe("two");
});
