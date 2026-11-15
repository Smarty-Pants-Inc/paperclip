import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { directoryRefreshPayload, guardedDirectoryRefreshProgram } from "./guarded-directory-refresh.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function fixture(existing = true) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "refresh-file-races-")); homes.push(home);
  const root = path.join(home, "sub", "live"), source = path.join(home, "source");
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(source);
  const name = existing ? "KEEP.md" : "NEW.md";
  if (existing) await fs.writeFile(path.join(root, name), "checkpoint\n");
  await fs.writeFile(path.join(source, name), "canonical\n");
  const stat = await fs.lstat(root, { bigint: true });
  const entries: Array<[string, unknown]> = [];
  if (existing) {
    const fileStat = await fs.lstat(path.join(root, name));
    entries.push([name, { kind: "file", mode: fileStat.mode, hash: createHash("sha256").update("checkpoint\n").digest("hex") }]);
  }
  return { home, root, source, name, guard: { identity: [stat.dev, stat.ino, stat.birthtimeNs].join(":"),
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex") } };
}
function run(f: Awaited<ReturnType<typeof fixture>>, payload: string, program: string) {
  return spawnSync(process.execPath, ["-e", program, f.root, JSON.stringify(f.guard)], { input: payload, env: {}, timeout: 10000, encoding: "utf8" });
}

describe.skipIf(process.platform !== "linux")("write-time file authority", () => {
  it.each(["edit", "inode-replacement", "delete"] as const)("refuses a destination %s after initial hashing", async kind => {
    const f = await fixture();
    const payload = kind === "delete" ? "[]" : await directoryRefreshPayload(f.source);
    const injection = kind === "inode-replacement"
      ? `fs.renameSync(root+'/KEEP.md',root+'/original');fs.writeFileSync(root+'/KEEP.md','OWNER EDIT\\n');`
      : `fs.writeFileSync(root+'/KEEP.md','OWNER EDIT\\n');`;
    const needle = "const parentOf=name=>";
    expect(guardedDirectoryRefreshProgram).toContain(needle);
    const result = run(f, payload, guardedDirectoryRefreshProgram.replace(needle, injection + needle));
    expect(result.status).not.toBe(0);
    expect(await fs.readFile(path.join(f.root, f.name), "utf8")).toBe("OWNER EDIT\n");
  });

  it("installs a new file atomically without replacing an unexpected destination", async () => {
    const f = await fixture(false);
    // Inject *inside* the installation primitive, after every pathname check.
    // The former rename overwrites these bytes; link's EEXIST keeps them.
    const injection = `for(const operation of ['renameSync','linkSync']){const original=fs[operation];fs[operation]=function(from,to){if(to.endsWith('/NEW.md'))fs.writeFileSync(to,'LATE NEW FILE\\n');return original.apply(fs,arguments);};}`;
    const needle = "const root=process.argv[1]";
    expect(guardedDirectoryRefreshProgram).toContain(needle);
    const result = run(f, await directoryRefreshPayload(f.source), guardedDirectoryRefreshProgram.replace(needle, injection + needle));
    expect(result.status).not.toBe(0);
    expect(await fs.readFile(path.join(f.root, f.name), "utf8")).toBe("LATE NEW FILE\n");
    expect(await fs.readdir(f.root)).toEqual([f.name]);
  });

  it("does not retain a checkpointed file during ordinary removal", async () => {
    const f = await fixture();
    const result = run(f, "[]", guardedDirectoryRefreshProgram);
    expect(result.status).toBe(0);
    expect(await fs.readdir(f.root)).toEqual([]);
    await expect(fs.stat(path.join(f.home, ".paperclip-retained"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["removal", "replacement"] as const)("retains a Codex-shaped file renamed into a path scheduled for %s", async kind => {
    const f = await fixture();
    const bytes = '{"type":"response_item","payload":{"type":"message","content":"owner trace"}}\n';
    const intruder = path.join(f.home, "codex-rollout.jsonl");
    await fs.writeFile(intruder, bytes);
    const injection = `const intruder=${JSON.stringify(intruder)};let raced=false;const rename=fs.renameSync,unlink=fs.unlinkSync;` +
      `fs.renameSync=function(from,to){if(!raced&&String(from).endsWith('/KEEP.md')&&String(to).endsWith('/entry')){raced=true;rename.call(fs,from,path.dirname(process.argv[1])+'/moved-owner-file');rename.call(fs,intruder,from);}` +
      `else if(!raced&&String(to).endsWith('/KEEP.md')&&String(from).includes('/.refresh-')){raced=true;rename.call(fs,to,path.dirname(process.argv[1])+'/moved-owner-file');rename.call(fs,intruder,to);}return rename.apply(fs,arguments);};` +
      `fs.unlinkSync=function(name){if(!raced&&String(name).endsWith('/KEEP.md')){raced=true;rename.call(fs,name,path.dirname(process.argv[1])+'/moved-owner-file');rename.call(fs,intruder,name);}return unlink.apply(fs,arguments);};`;
    const needle = "const changed=()=>";
    expect(guardedDirectoryRefreshProgram).toContain(needle);
    const result = run(f, kind === "replacement" ? await directoryRefreshPayload(f.source) : "[]",
      guardedDirectoryRefreshProgram.replace(needle, injection + needle));
    const retainedRoot = path.join(f.home, ".paperclip-retained");
    const retainedDirs = await fs.readdir(retainedRoot).catch(() => []);
    const retainedFiles: string[] = [];
    for (const run of retainedDirs) for (const timestamp of await fs.readdir(path.join(retainedRoot, run)))
      for (const name of await fs.readdir(path.join(retainedRoot, run, timestamp)))
        retainedFiles.push(await fs.readFile(path.join(retainedRoot, run, timestamp, name), "utf8"));
    expect(retainedFiles).toEqual([bytes]);
    expect(result.stderr).toMatch(/PAPERCLIP_RETAINED .* identity=[0-9]+:[0-9]+ size=[0-9]+/);
    expect(result.status).not.toBe(0);
    const rootEntries = JSON.parse(await directoryRefreshPayload(f.root));
    expect(rootEntries.map((entry: { name: string }) => entry.name)).not.toContain(".paperclip-retained");
  });
});
