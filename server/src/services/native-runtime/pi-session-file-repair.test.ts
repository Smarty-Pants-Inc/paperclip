import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { beforeAll, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { probePiSessionResumeFile, restorePiSessionResumeFile } from "./pi-session-file-repair.js";

// Keep reason: data safety. Run the actual pack-owned validator in a real Node
// subprocess; a mock cannot prove no-follow, cwd/identity checks or quarantine.
let providerPackRoot: string;
beforeAll(async () => {
  providerPackRoot = await mkdtemp(join(tmpdir(), "pi-repair-validator-"));
  await build({ entryPoints: [resolve(import.meta.dirname, "../../../../packages/paperclip-runner/src/drivers/pi/pi-session-file.ts")],
    outfile: join(providerPackRoot, "dist/drivers/pi/pi-session-file.js"), bundle: true, platform: "node", format: "esm" });
  await writeFile(join(providerPackRoot, "package.json"), JSON.stringify({ type: "module" }));
});

async function fixture(state: "missing" | "invalid" | "foreign" | "symlink" | "valid") {
  const root = await mkdtemp(join(tmpdir(), "pi-file-repair-"));
  const directory = join(root, "pi"); await mkdir(directory);
  const normalizedSessionId = randomUUID(), providerSessionId = randomUUID();
  const filename = `${normalizedSessionId}.jsonl`, target = join(directory, filename);
  const transcript = (id = providerSessionId) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root }) + "\n";
  const sourcePath = join(root, "verified-backup.jsonl"); await writeFile(sourcePath, transcript());
  const original = state === "foreign" ? transcript(randomUUID()) : state === "valid" ? transcript() : "{invalid history}\n";
  const foreignTarget = join(root, "foreign.jsonl");
  if (state === "symlink") { await writeFile(foreignTarget, original); await symlink(foreignTarget, target); }
  else if (state !== "missing") await writeFile(target, original);
  const runner: CommandManagedRuntimeRunner = { execute: input => runChildProcess(`pi-repair-${randomUUID()}`,
    input.command, input.args ?? [], { cwd: root, env: {}, timeoutSec: (input.timeoutMs ?? 30_000) / 1000, graceSec: 1, onLog: async () => {} }) };
  const input = { runner, node: process.execPath, providerPackRoot, directory, filename, normalizedSessionId,
    providerSessionId, providerBackendSessionId: providerSessionId, workingDirectory: root, sourcePath,
    stageFile: async (source: string, target: string) => { await copyFile(source, target); } };
  return { input, target, original, foreignTarget };
}

it.each(["missing", "invalid", "foreign", "symlink"] as const)("repairs %s from a valid copy without touching foreign data", async state => {
  const f = await fixture(state);
  expect(await probePiSessionResumeFile(f.input)).toBe(state === "missing" ? "missing" : "invalid");
  await restorePiSessionResumeFile(f.input);
  expect(await probePiSessionResumeFile(f.input)).toBe("valid");
  expect(await readFile(f.target)).toEqual(await readFile(f.input.sourcePath));
  const evidenceDirectory = state === "symlink" ? `${f.input.directory}.quarantined-links` : f.input.directory;
  const aside = (await readdir(evidenceDirectory)).filter(name => name.includes(".invalid-"));
  expect(aside).toHaveLength(state === "missing" ? 0 : 1);
  if (state === "symlink") {
    const original = join(evidenceDirectory, aside[0]!);
    expect((await lstat(original)).isSymbolicLink()).toBe(true);
    expect(await readlink(original)).toBe(f.foreignTarget);
    expect(await readFile(f.foreignTarget, "utf8")).toBe(f.original);
    const retained = join(f.input.directory, aside[0]! + ".evidence.json");
    expect((await lstat(retained)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(retained, "utf8"))).toMatchObject({ kind: "quarantined-symbolic-link", original, target: f.foreignTarget });
    for (const name of await readdir(f.input.directory)) expect((await lstat(join(f.input.directory, name))).isSymbolicLink()).toBe(false);
  } else if (state !== "missing") expect(await readFile(join(f.input.directory, aside[0]!), "utf8")).toBe(f.original);
});

it.each(["missing", "invalid", "foreign", "symlink"] as const)("leaves %s untouched when the backup is invalid", async state => {
  const f = await fixture(state);
  await writeFile(f.input.sourcePath, "{invalid backup}\n");
  await restorePiSessionResumeFile(f.input);
  expect((await readdir(f.input.directory)).filter(name => name.includes(".invalid-"))).toEqual([]);
  if (state === "missing") expect(existsSync(f.target)).toBe(false);
  else if (state === "symlink") {
    expect((await lstat(f.target)).isSymbolicLink()).toBe(true);
    expect(await readFile(f.foreignTarget, "utf8")).toBe(f.original);
  } else expect(await readFile(f.target, "utf8")).toBe(f.original);
});

it("refuses a redirected evidence directory without following it or restoring over the link", async () => {
  const f = await fixture("symlink");
  const foreignDirectory = join(f.input.directory, "..", "foreign-evidence");
  await mkdir(foreignDirectory);
  await symlink(foreignDirectory, `${f.input.directory}.quarantined-links`);
  await expect(restorePiSessionResumeFile(f.input)).rejects.toThrow("resume_file_validation_failed");
  expect(await readdir(foreignDirectory)).toEqual([]);
  expect(await readFile(f.foreignTarget, "utf8")).toBe(f.original);
  expect(existsSync(f.target)).toBe(false);
  const aside = (await readdir(f.input.directory)).filter(name => name.includes(".invalid-"));
  expect(aside).toHaveLength(1);
  expect((await lstat(join(f.input.directory, aside[0]!))).isSymbolicLink()).toBe(true);
});

it("does not rewind an already-valid live conversation", async () => {
  const f = await fixture("valid");
  const addition = JSON.stringify({ type: "message", id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant" } }) + "\n";
  await writeFile(f.target, f.original + addition);
  await restorePiSessionResumeFile(f.input);
  expect(await readFile(f.target, "utf8")).toBe(f.original + addition);
  expect((await readdir(f.input.directory)).filter(name => name.includes(".invalid-"))).toEqual([]);
});
