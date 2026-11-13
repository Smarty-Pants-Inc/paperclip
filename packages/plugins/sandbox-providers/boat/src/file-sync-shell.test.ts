import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginSyncFileMapping } from "@paperclipai/plugin-sdk";

// Keep: real hq-test incident, directory mode 0555 prevented publication and
// replacement. Run the actual generated shell as a non-root user, without
// network, transport, filesystem or process mocks. Extract the private generator
// and its two helpers verbatim through the TS AST; do not add a production export.
// The exact-package run extracts the same functions from packed dist instead.
const subject = process.env.BOAT_PACKAGED_DIR
  ? path.join(process.env.BOAT_PACKAGED_DIR, "dist/file-sync.js")
  : path.join(import.meta.dirname, "file-sync.ts");
const source = ts.createSourceFile(subject, readFileSync(subject, "utf8"), ts.ScriptTarget.Latest, true);
const helpers = source.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && node.name?.text === "installSandbox") ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(decl =>
    ts.isIdentifier(decl.name) && ["q", "octal"].includes(decl.name.text))));
if (helpers.length !== 3) throw new Error(`Expected three real generator declarations in ${subject}`);
const javascript = ts.transpileModule(helpers.map(node => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const installSandbox = runInNewContext(`${javascript}\ninstallSandbox;`, { path }) as
  (mapping: PluginSyncFileMapping, archive: string, rootMode?: number) => string;
let root: string, sourceDir: string, parent: string, target: string, serial: number;

beforeEach(async () => {
  expect(process.getuid?.(), "Permission regression must not run as root").not.toBe(0);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boat-syncfix-shell-"));
  sourceDir = path.join(root, "source ' quoted");
  parent = path.join(root, "target parent ' quoted");
  target = path.join(parent, "instructions");
  await fs.mkdir(sourceDir); await fs.mkdir(parent); serial = 0;
  await fs.writeFile(path.join(sourceDir, "instructions.md"), "new instructions", { mode: 0o640 });
  await fs.mkdir(path.join(sourceDir, "nested"), { mode: 0o755 });
  await fs.writeFile(path.join(sourceDir, "nested/context.md"), "new context", { mode: 0o644 });
});
afterEach(async () => {
  if (!root) return;
  // Also clean the intentionally broken RED stage and read-only targets.
  const result = spawnSync("chmod", ["-R", "u+w", "--", root], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  await fs.rm(root, { recursive: true, force: true });
});
async function install(name: string, kind: "file" | "directory", mode?: number, rootMode?: number) {
  const archive = path.join(root, `transfer-${serial++}.tar`);
  const entries = kind === "directory" ? await fs.readdir(sourceDir) : ["instructions.md"];
  // Like archiveHost, archive the entries, not '.', so tar does not set the
  // staging root's mode. This is the real production archive shape.
  const tar = spawnSync("tar", ["-cf", archive, "-C", sourceDir, "--", ...entries], {
    encoding: "utf8", env: { ...process.env, TAR_OPTIONS: "" },
  });
  expect(tar.status, tar.stderr).toBe(0);
  const command = installSandbox({ kind, mode, sourcePath: kind === "directory" ? sourceDir : path.join(sourceDir, "instructions.md"), targetPath: target }, archive, rootMode);
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });
  const remainingStages = (await fs.readdir(parent)).filter(entry => entry.startsWith(".paperclip-upload-boat-"));
  const evidence = { subject, uid: process.getuid?.(), exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, remainingStages };
  if (process.env.BOAT_SYNCFIX_EVIDENCE) {
    mkdirSync(process.env.BOAT_SYNCFIX_EVIDENCE, { recursive: true });
    writeFileSync(path.join(process.env.BOAT_SYNCFIX_EVIDENCE, `${name}.sh`), command + "\n");
    writeFileSync(path.join(process.env.BOAT_SYNCFIX_EVIDENCE, `${name}.json`), JSON.stringify(evidence, null, 2) + "\n");
  }
  expect(result.error).toBeUndefined();
  expect(result.status, JSON.stringify(evidence)).toBe(0);
  expect(remainingStages, "No upload staging directory remains after success").toEqual([]);
  await expect(fs.lstat(archive)).rejects.toMatchObject({ code: "ENOENT" });
}
const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o777;

describe("installSandbox real generated shell", () => {
  it("cleans a failed extraction-stage install with a 0555 nested directory", async () => {
    // Extraction succeeds. The real file-presence guard then fails, before mv.
    // The EXIT trap must make read-only extracted directories removable.
    await fs.chmod(path.join(sourceDir, "nested"), 0o555);
    const archive = path.join(root, "failed-transfer.tar");
    const tar = spawnSync("tar", ["-cf", archive, "-C", sourceDir, "--", "nested"], {
      encoding: "utf8", env: { ...process.env, TAR_OPTIONS: "" },
    });
    expect(tar.status, tar.stderr).toBe(0);
    const command = installSandbox({ kind: "file", sourcePath: path.join(sourceDir, "missing.md"), targetPath: target }, archive);
    const result = spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 10_000 });
    const remainingStages = (await fs.readdir(parent)).filter(entry => entry.startsWith(".paperclip-upload-boat-"));
    const evidence = { subject, uid: process.getuid?.(), exitCode: result.status, stderr: result.stderr, remainingStages };
    if (process.env.BOAT_SYNCFIX_EVIDENCE) {
      mkdirSync(process.env.BOAT_SYNCFIX_EVIDENCE, { recursive: true });
      writeFileSync(path.join(process.env.BOAT_SYNCFIX_EVIDENCE, "failed-extraction-555.sh"), command + "\n");
      writeFileSync(path.join(process.env.BOAT_SYNCFIX_EVIDENCE, "failed-extraction-555.json"), JSON.stringify(evidence, null, 2) + "\n");
    }
    expect(result.error).toBeUndefined();
    expect(result.status, JSON.stringify(evidence)).toBe(1);
    expect(remainingStages, "Failure must not strand a read-only upload stage").toEqual([]);
    await expect(fs.lstat(archive)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("publishes a fresh 0555 directory and sets all regular files to 0555", async () => {
    await install("fresh-555", "directory", 0o555, 0o755);
    expect(await modeOf(target)).toBe(0o555);
    for (const name of ["instructions.md", "nested/context.md"]) expect(await modeOf(path.join(target, name))).toBe(0o555);
    expect(await fs.readFile(path.join(target, "instructions.md"), "utf8")).toBe("new instructions");
  });
  it("replaces an existing 0555 target including read-only nested directories", async () => {
    await fs.mkdir(target); await fs.mkdir(path.join(target, "stale"));
    await fs.writeFile(path.join(target, "stale/old.md"), "old instructions");
    for (const name of ["stale/old.md", "stale", ""]) await fs.chmod(path.join(target, name), 0o555);
    await install("resync-555", "directory", 0o555, 0o755);
    expect(await modeOf(target)).toBe(0o555);
    expect((await fs.readdir(target)).sort()).toEqual(["instructions.md", "nested"]);
    expect(await fs.readFile(path.join(target, "nested/context.md"), "utf8")).toBe("new context");
    expect(await modeOf(path.join(target, "nested/context.md"))).toBe(0o555);
  });
  it.each([0o755, 0o555])("preserves source rootMode %i when mapping mode is absent", async rootMode => {
    await install(`root-mode-${rootMode.toString(8)}`, "directory", undefined, rootMode);
    expect(await modeOf(target)).toBe(rootMode);
    expect(await modeOf(path.join(target, "instructions.md"))).toBe(0o640);
  });
  it.each([0o600, undefined])("leaves single-file publication behavior unchanged (mode=%s)", async mode => {
    await fs.writeFile(target, "old bytes", { mode: 0o444 });
    await install(`file-${mode?.toString(8) ?? "preserve"}`, "file", mode);
    expect(await fs.readFile(target, "utf8")).toBe("new instructions");
    expect(await modeOf(target)).toBe(mode ?? 0o640);
  });
  it("defaults directory mode to 0755 and removes all upload stages after success", async () => {
    await install("default-mode-cleanup", "directory");
    expect(await modeOf(target)).toBe(0o755);
    expect(await fs.readdir(parent)).toEqual(["instructions"]);
  });
});
