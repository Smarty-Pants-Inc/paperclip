import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configurePiManagedCompaction } from "./pi-managed-settings.js";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-settings-"));
  const original = join(root, "original"), sessionA = join(root, "sessions", "a"), sessionB = join(root, "sessions", "b");
  await mkdir(original, { recursive: true });
  const models = JSON.stringify({ providers: { paperclip: { apiKey: "session-token" } } });
  await writeFile(join(sessionA, "models.json"), models).catch(async () => {
    await mkdir(sessionA, { recursive: true }); await writeFile(join(sessionA, "models.json"), models);
  });
  return { root, original, sessionA, sessionB, models };
}
const call = (agentHome: string, originalAgentHome: string) => configurePiManagedCompaction({ agentHome, originalAgentHome, model: "paperclip/x", contextWindow: 200000 });

it("copies only original packages to an absent per-session settings file and applies reserve", async () => {
  const f = await fixture();
  const packages = ["/opt/pi-packages/tool-cap", "npm:@lll9p/pi-better-compaction@0.7.4"];
  await writeFile(join(f.original, "settings.json"), JSON.stringify({ packages, compaction: { reserveTokens: 12345 }, model: "wrong" }));
  await call(f.sessionA, f.original);
  expect(JSON.parse(await readFile(join(f.sessionA, "settings.json"), "utf8"))).toEqual({ packages, compaction: { reserveTokens: 12345 } });
});

it("does not merge packages into an existing per-session settings file", async () => {
  const f = await fixture();
  await writeFile(join(f.original, "settings.json"), JSON.stringify({ packages: ["original"], compaction: { reserveTokens: 12345 } }));
  await writeFile(join(f.sessionA, "settings.json"), JSON.stringify({ quietStartup: true }));
  await call(f.sessionA, f.original);
  expect(JSON.parse(await readFile(join(f.sessionA, "settings.json"), "utf8"))).toEqual({ quietStartup: true, compaction: { reserveTokens: 12345 } });
});

it("keeps same-home settings behavior", async () => {
  const f = await fixture();
  await writeFile(join(f.original, "settings.json"), JSON.stringify({ packages: ["same"], compaction: { enabled: false } }));
  await call(f.original, f.original);
  expect(JSON.parse(await readFile(join(f.original, "settings.json"), "utf8"))).toEqual({ packages: ["same"], compaction: { enabled: false, reserveTokens: 50000 } });
});

it("uses defaults when original settings are absent", async () => {
  const f = await fixture();
  await call(f.sessionA, f.original);
  expect(JSON.parse(await readFile(join(f.sessionA, "settings.json"), "utf8"))).toEqual({ compaction: { reserveTokens: 50000 } });
});

it("keeps settings separate for sessions and never touches per-session models.json", async () => {
  const f = await fixture();
  const packages = ["/opt/pi-packages/tool-cap"];
  await writeFile(join(f.original, "settings.json"), JSON.stringify({ packages }));
  await call(f.sessionA, f.original);
  await call(f.sessionB, f.original);
  expect(JSON.parse(await readFile(join(f.sessionA, "settings.json"), "utf8"))).toEqual({ packages, compaction: { reserveTokens: 50000 } });
  expect(JSON.parse(await readFile(join(f.sessionB, "settings.json"), "utf8"))).toEqual({ packages, compaction: { reserveTokens: 50000 } });
  expect(await readFile(join(f.sessionA, "models.json"), "utf8")).toBe(f.models);
});
