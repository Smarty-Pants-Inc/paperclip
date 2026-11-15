import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { directoryRefreshPayload, guardedDirectoryRefreshProgram, type DirectoryRefreshGuard } from "./guarded-directory-refresh.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "guarded-refresh-")); homes.push(home);
  const source = path.join(home, "source"), root = path.join(home, "live"), trace = path.join(home, "paperclip-runner/sessions/owner/pi");
  await Promise.all([source, root, trace].map(p => fs.mkdir(p, { recursive: true })));
  await fs.writeFile(path.join(root, "AGENTS.md"), "old policy\n");
  await fs.writeFile(path.join(source, "AGENTS.md"), "new policy\n");
  await fs.writeFile(path.join(trace, "continuity.jsonl"), "ORIGINAL TRACE\n");
  return { home, source, root, trace };
}
async function observation(root: string): Promise<DirectoryRefreshGuard> {
  const stat = await fs.lstat(root, { bigint: true });
  const entries: Array<[string, unknown]> = [];
  async function walk(relative: string) {
    for (const name of await fs.readdir(path.join(root, relative))) {
      const next = relative ? `${relative}/${name}` : name, filename = path.join(root, next), stat = await fs.lstat(filename);
      if (next === ".paperclip-runtime") continue;
      if (stat.isDirectory()) { entries.push([next, { kind: "dir" }]); await walk(next); }
      else entries.push([next, { kind: "file", mode: stat.mode, hash: createHash("sha256").update(await fs.readFile(filename)).digest("hex") }]);
    }
  }
  await walk(""); entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { identity: [stat.dev, stat.ino, stat.birthtimeNs].join(":"), digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
}
function run(root: string, guard: DirectoryRefreshGuard, payload: string, program = guardedDirectoryRefreshProgram) {
  execFileSync(process.execPath, ["-e", program, root, JSON.stringify(guard)], { input: payload, env: {}, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
}

describe.skipIf(process.platform !== "linux")("descriptor-confined directory refresh", () => {
  it("refreshes files, binary bytes, modes and membership without changing the root inode", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "obsolete"), "remove me");
    await fs.mkdir(path.join(f.source, "nested"));
    await fs.writeFile(path.join(f.source, "nested", "binary"), Buffer.from([0, 255, 1]), { mode: 0o750 });
    const guard = await observation(f.root);
    run(f.root, guard, await directoryRefreshPayload(f.source));
    expect((await observation(f.root)).identity).toBe(guard.identity);
    expect((await observation(f.root)).digest).toBe((await observation(f.source)).digest);
    expect(await fs.readFile(path.join(f.root, "nested/binary"))).toEqual(Buffer.from([0, 255, 1]));
  });
  it.each(["root", "ancestor"])("refuses a symlink at the %s before any trace write", async kind => {
    const f = await fixture(), guard = await observation(f.root), payload = await directoryRefreshPayload(f.source);
    let root = f.root;
    if (kind === "root") { await fs.rename(f.root, f.root + "-old"); await fs.symlink(f.trace, f.root); }
    else { const alias = path.join(f.home, "alias"); await fs.symlink(f.home, alias); root = path.join(alias, "live"); }
    expect(() => run(root, guard, payload)).toThrow();
    expect(await fs.readFile(path.join(f.trace, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
  });
  it("refuses a physically replaced root even when its bytes are identical", async () => {
    const f = await fixture(), guard = await observation(f.root);
    await fs.rename(f.root, f.root + "-old"); await fs.cp(f.root + "-old", f.root, { recursive: true });
    expect(() => run(f.root, guard, JSON.stringify([{ name: "AGENTS.md", mode: 0o644, data: Buffer.from("replacement").toString("base64") }]))).toThrow();
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe("old policy\n");
  });
  it("rechecks live bytes immediately before mutation", async () => {
    const f = await fixture(), guard = await observation(f.root), payload = await directoryRefreshPayload(f.source);
    await fs.writeFile(path.join(f.root, "AGENTS.md"), "unsaved owner edit\n");
    expect(() => run(f.root, guard, payload)).toThrow();
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe("unsaved owner edit\n");
  });
  it.each(["symbolic", "hard"])("refuses a %s file link anywhere in the destination", async kind => {
    const f = await fixture(), guard = await observation(f.root), payload = await directoryRefreshPayload(f.source);
    const filename = path.join(f.root, "continuity.jsonl"), trace = path.join(f.trace, "continuity.jsonl");
    if (kind === "symbolic") await fs.symlink(trace, filename); else await fs.link(trace, filename);
    expect(() => run(f.root, guard, payload)).toThrow();
    expect(await fs.readFile(trace, "utf8")).toBe("ORIGINAL TRACE\n");
  });
  it("refuses a real, non-symlink runner session destination", async () => {
    const f = await fixture(), guard = await observation(f.trace);
    expect(() => run(f.trace, guard, JSON.stringify([{ name: "continuity.jsonl", mode: 0o644, data: Buffer.from("wrong").toString("base64") }]))).toThrow();
    expect(await fs.readFile(path.join(f.trace, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
  });
  it("refuses a Pi JSONL destination outside the standard runner tree", async () => {
    const f = await fixture(), pi = path.join(f.home, "pi"); await fs.mkdir(pi);
    const guard = await observation(pi);
    expect(() => run(pi, guard, JSON.stringify([{ name: "session.jsonl", mode: 0o644, data: "eA==" }]))).toThrow();
    expect(await fs.readdir(pi)).toEqual([]);
  });
  it("supports directory/file type changes without following old children", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, "to-file")); await fs.writeFile(path.join(f.root, "to-file/old"), "old");
    await fs.writeFile(path.join(f.source, "to-file"), "new");
    await fs.writeFile(path.join(f.root, "to-dir"), "old"); await fs.mkdir(path.join(f.source, "to-dir"));
    await fs.writeFile(path.join(f.source, "to-dir/new"), "new");
    run(f.root, await observation(f.root), await directoryRefreshPayload(f.source));
    expect((await observation(f.root)).digest).toBe((await observation(f.source)).digest);
  });
  it.each([false, true])("only preserves reserved runtime scratch when empty (nonempty=%s)", async nonempty => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, ".paperclip-runtime"));
    if (nonempty) await fs.writeFile(path.join(f.root, ".paperclip-runtime/owner"), "do not touch");
    const guard = await observation(f.root), payload = await directoryRefreshPayload(f.source);
    if (nonempty) expect(() => run(f.root, guard, payload)).toThrow(); else run(f.root, guard, payload);
    expect(await fs.readdir(path.join(f.root, ".paperclip-runtime"))).toEqual(nonempty ? ["owner"] : []);
  });
  it("pins an in-flight write when the root is redirected after the last pre-write check", async () => {
    const f = await fixture(), guard = await observation(f.root), payload = await directoryRefreshPayload(f.source);
    const program = guardedDirectoryRefreshProgram.replace("fs.writeFileSync(file,Buffer.from(e.data,'base64'));", `fs.renameSync(root,root+'-preserved');fs.symlinkSync(${JSON.stringify(f.trace)},root);fs.writeFileSync(file,Buffer.from(e.data,'base64'));`);
    expect(program).not.toBe(guardedDirectoryRefreshProgram);
    expect(() => run(f.root, guard, payload, program)).toThrow();
    expect(await fs.readFile(path.join(f.trace, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
    expect(await fs.readdir(f.trace)).toEqual(["continuity.jsonl"]);
  });
  it("bounds refresh payloads rather than starting an unbounded transfer", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.source, "large"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(directoryRefreshPayload(f.source)).rejects.toThrow("oversized");
    expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe("old policy\n");
  });
});
