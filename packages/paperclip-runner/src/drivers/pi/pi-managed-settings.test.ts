import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configurePiManagedCompaction } from "./pi-managed-settings.js";

const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "pi-managed-settings-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("copies complete original settings only for a fresh managed home, then adds the reserve", async () => {
  const original = await root(), managed = await root();
  const packageRoot = join(original, "npm", "node_modules", "@lll9p", "pi-better-compaction");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@lll9p/pi-better-compaction", version: "0.7.4" }));
  const source = { packages: ["/opt/pi-packages/tool-cap", "npm:@lll9p/pi-better-compaction@0.7.4"],
    compaction: { modelOverrides: { "vendor/model": { reserveTokens: 321, keepRecentTokens: 654 } } }, retry: { enabled: true, maxRetries: 4, baseDelayMs: 10, maxAgentDelayMs: 20, provider: { maxRetries: 2 } } };
  await writeFile(join(original, "settings.json"), JSON.stringify(source));
  await configurePiManagedCompaction({ agentHome: managed, originalAgentHome: original, model: "vendor/model", contextWindow: 1000 });
  expect(JSON.parse(await readFile(join(managed, "settings.json"), "utf8"))).toEqual({ ...source,
    packages: ["/opt/pi-packages/tool-cap", packageRoot], compaction: { ...source.compaction, reserveTokens: 321 } });
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

it("keeps session settings and models separate", async () => {
  const original = await root(), one = await root(), two = await root();
  await writeFile(join(original, "settings.json"), JSON.stringify({ packages: ["/opt/shared-package"], retry: { enabled: true } }));
  for (const [home, id] of [[one, "one"], [two, "two"]] as const) {
    await configurePiManagedCompaction({ agentHome: home, originalAgentHome: original, model: "m", contextWindow: 400 });
    await writeFile(join(home, "models.json"), id);
  }
  await writeFile(join(one, "settings.json"), `${JSON.stringify({ session: "one" })}\n`);
  expect(await readFile(join(one, "settings.json"), "utf8")).not.toBe(await readFile(join(two, "settings.json"), "utf8"));
  expect(await readFile(join(one, "models.json"), "utf8")).toBe("one");
  expect(await readFile(join(two, "models.json"), "utf8")).toBe("two");
});
