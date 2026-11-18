import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTarballFromDirectory } from "./sandbox-managed-runtime.js";

const execFile = promisify(execFileCallback);

describe("sandbox archive exact owned paths", () => {
  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/d5be605025ee57ca41e8855d51117d14b099c185 (R1 rfl-verdicts/VERDICT-m1-tmpsync2.md, VERDICT-c10-tmpsync.md)
  it("preserves a nested user artifact with the same basename as the output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-archive-preservation-"));
    try {
      await fs.mkdir(path.join(root, "releases"));
      await fs.writeFile(path.join(root, "releases/workspace.tar"), "user artifact");
      const archivePath = path.join(root, "workspace.tar");
      await fs.writeFile(archivePath, "old archive");
      await createTarballFromDirectory({ localDir: root, archivePath });
      const { stdout } = await execFile("tar", ["-tf", archivePath]);
      expect(stdout.trim().split("\n")).toContain("releases/workspace.tar");
      expect(stdout.trim().split("\n")).not.toContain("workspace.tar");
      expect((await execFile("tar", ["-xOf", archivePath, "releases/workspace.tar"])).stdout).toBe("user artifact");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["staging-[one]*", "build/cache/staging-[one]*"])("omits only the exact owned directory %s", async (staging) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-archive-preservation-"));
    try {
      await fs.mkdir(path.join(root, staging), { recursive: true });
      await fs.writeFile(path.join(root, staging, "internal.txt"), "owned scratch");
      const real = `fixtures/${staging}/real.txt`;
      await fs.mkdir(path.dirname(path.join(root, real)), { recursive: true });
      await fs.writeFile(path.join(root, real), "user content");
      await fs.writeFile(path.join(root, "build-kept.txt"), "keep sibling");
      const archivePath = path.join(root, staging, "workspace.tar");
      await createTarballFromDirectory({ localDir: root, archivePath });
      const { stdout } = await execFile("tar", ["-tf", archivePath]);
      const members = stdout.trim().split("\n");
      expect(members).toContain(real);
      expect(members).toContain("build-kept.txt");
      expect(members.some(member => member === `${staging}/` || member.startsWith(`${staging}/`))).toBe(false);
      expect((await execFile("tar", ["-xOf", archivePath, real])).stdout).toBe("user content");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("omits a deeper entry-list directory while retaining caller excludes, directories and symlinks (follow=%s)", async (followSymlinks) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-archive-preservation-"));
    try {
      const source = path.join(root, "source");
      const runtime = path.join(source, "runtime/tmp");
      await fs.mkdir(runtime, { recursive: true });
      const external = path.join(root, "external");
      await fs.mkdir(external);
      await fs.writeFile(path.join(external, "linked.txt"), "linked content");
      await fs.symlink(external, path.join(source, "link"));
      await fs.mkdir(path.join(source, "empty"), { mode: 0o750 });
      await fs.writeFile(path.join(source, "kept.txt"), "user content");
      await fs.writeFile(path.join(source, "runtime/omitted.log"), "caller excluded");
      await fs.mkdir(path.join(source, "omitted/subdir"), { recursive: true });
      await fs.writeFile(path.join(source, "omitted/subdir/file.txt"), "caller excluded directory");
      const temporary = vi.spyOn(os, "tmpdir").mockReturnValue(runtime);
      const archivePath = path.join(source, "workspace.tar");
      try {
        await createTarballFromDirectory({ localDir: source, archivePath, exclude: ["*.log", "omitted"], followSymlinks });
      } finally { temporary.mockRestore(); }
      const { stdout } = await execFile("tar", ["-tf", archivePath]);
      const members = stdout.trim().split("\n");
      expect(members).toContain("kept.txt");
      expect(members).toContain("empty/");
      expect(members).toContain("runtime/tmp/");
      expect(members.some(member => member.includes("paperclip-tar-list-") || member.endsWith(".log"))).toBe(false);
      expect(members).not.toContain("workspace.tar");
      expect(members.some(member => member.startsWith("omitted/"))).toBe(false);
      expect(members.includes("link/linked.txt")).toBe(followSymlinks);
      const extracted = path.join(root, "extracted");
      await fs.mkdir(extracted);
      await execFile("tar", ["-xf", archivePath, "-C", extracted]);
      expect((await fs.lstat(path.join(extracted, "link"))).isSymbolicLink()).toBe(!followSymlinks);
      expect((await fs.stat(path.join(extracted, "empty"))).mode & 0o777).toBe(0o750);
      if (followSymlinks) expect(await fs.readFile(path.join(extracted, "link/linked.txt"), "utf8")).toBe("linked content");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe("sandbox archive preservation boundaries", () => {
  let root:string;
  beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'judge-archive-'));});
  afterEach(async()=>{vi.restoreAllMocks(); await fs.chmod(path.join(root,'source','omitted'),0o700).catch(()=>{}); await fs.rm(root,{recursive:true,force:true});});
  async function seed(name:string,bytes='user content\n') {const target=path.join(root,'source',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
  async function members(archive:string) { return (await execFile('tar',['-tf',archive])).stdout.trim().split('\n'); }
  async function bytes(archive:string,name:string) { return (await execFile('tar',['-xOf',archive,name])).stdout; }

  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/d5be605025ee57ca41e8855d51117d14b099c185 (R1 rfl-verdicts/VERDICT-m1-tmpsync2.md, VERDICT-c10-tmpsync.md)
  it('own direct staging does not drop fixtures/paperclip-sandbox-sync-example',async()=>{
    await seed('fixtures/paperclip-sandbox-sync-example/real.txt','fixture bytes');
    await seed('paperclip-sandbox-sync-example/scratch.txt','owned bytes');
    const archive=path.join(root,'source','paperclip-sandbox-sync-example','workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive});
    expect(await bytes(archive,'fixtures/paperclip-sandbox-sync-example/real.txt')).toBe('fixture bytes');
    expect((await members(archive)).some(x=>x.startsWith('paperclip-sandbox-sync-example/'))).toBe(false);
  });
  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/d5be605025ee57ca41e8855d51117d14b099c185 (R1 rfl-verdicts/VERDICT-m1-tmpsync2.md, VERDICT-c10-tmpsync.md)
  it.each(['build','.git','node_modules','build/cache/staging-[one]*'])('excludes exact owned %s while keeping nested siblings',async owned=>{
    const archive=path.join(root,'source',owned,'workspace.tar');
    await seed(`${owned}/internal.txt`,'owned scratch');
    for(const p of ['src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt',`fixtures/${owned}/real.txt`]) await seed(p,`KEEP:${p}\n`);
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive});
    const list=await members(archive);
    expect(list.some(x=>x.startsWith(`${owned}/`))).toBe(false);
    for(const p of ['src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt',`fixtures/${owned}/real.txt`]) expect(await bytes(archive,p)).toBe(`KEEP:${p}\n`);
  });
  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/d5be605025ee57ca41e8855d51117d14b099c185 (R1 rfl-verdicts/VERDICT-m1-tmpsync2.md, VERDICT-c10-tmpsync.md)
  it('retains caller root directory exclusions without erasing same-looking file names or nested build',async()=>{
    for(const p of ['.git/config','node_modules/lib/index.js','src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt','build/staging/internal.txt'])await seed(p);
    const archive=path.join(root,'source/build/staging/workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive,exclude:['.git','node_modules']});
    const list=await members(archive);
    expect(list.some(x=>x.startsWith('.git/')||x.startsWith('node_modules/')||x.startsWith('build/staging/'))).toBe(false);
    for(const p of ['src/.git-notes','pkg/node_modules-readme','pkg/build/real.txt'])expect(await bytes(archive,p)).toBe('user content\n');
  });
  // v3: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20495 (base still opens the excluded directory: EACCES)
  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/d5be605025ee57ca41e8855d51117d14b099c185 (R1 rfl-verdicts/VERDICT-m1-tmpsync2.md, VERDICT-c10-tmpsync.md)
  it.skip('does not inspect a caller-excluded unreadable directory',async()=>{
    await seed('omitted/private.txt'); await fs.chmod(path.join(root,'source/omitted'),0);
    await seed('kept.txt'); await fs.mkdir(path.join(root,'source/build/staging'),{recursive:true});
    const archive=path.join(root,'source/build/staging/workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive,exclude:['omitted']});
    expect(await bytes(archive,'kept.txt')).toBe('user content\n');
    expect((await members(archive)).some(x=>x.startsWith('omitted/'))).toBe(false);
  });
  // v3: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20495 (base still stats the excluded dangling link: ENOENT)
  // catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/d5be605025ee57ca41e8855d51117d14b099c185 (R1 rfl-verdicts/VERDICT-m1-tmpsync2.md, VERDICT-c10-tmpsync.md)
  it.skip('does not follow a dangling link inside a caller-excluded directory',async()=>{
    await seed('kept.txt'); await fs.mkdir(path.join(root,'source/omitted'));
    await fs.symlink(path.join(root,'missing'),path.join(root,'source/omitted/dangling'));
    await fs.mkdir(path.join(root,'source/build/staging'),{recursive:true});
    const archive=path.join(root,'source/build/staging/workspace.tar');
    await createTarballFromDirectory({localDir:path.join(root,'source'),archivePath:archive,exclude:['omitted'],followSymlinks:true});
    expect(await bytes(archive,'kept.txt')).toBe('user content\n');
  });
});
