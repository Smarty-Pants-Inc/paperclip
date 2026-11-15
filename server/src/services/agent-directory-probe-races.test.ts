import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentDirectoryConfinedCleanupProgram } from "./agent-directory-probe.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("confined cleanup file authority", () => {
  it("retains and logs a Codex-shaped file renamed into a cleanup path", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "confined-cleanup-races-")); homes.push(home);
    const root = path.join(home, "sub", "live");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "KEEP.md"), "checkpoint\n");
    const intruder = path.join(home, "codex-rollout.jsonl");
    const bytes = '{"type":"response_item","payload":{"type":"message","content":"owner trace"}}\n';
    await fs.writeFile(intruder, bytes);
    const stat = await fs.lstat(root, { bigint: true });
    const identity = [stat.dev, stat.ino, stat.birthtimeNs].join(":");
    const needle = "if(process.platform!=='linux')throw Error('Confined cleanup unavailable');";
    const injection = `const intruder=${JSON.stringify(intruder)};let raced=false;const rename=fs.renameSync,unlink=fs.unlinkSync;` +
      `fs.renameSync=function(from,to){if(!raced&&String(from).endsWith('/KEEP.md')&&String(to).endsWith('/entry')){raced=true;rename.call(fs,from,path.dirname(JSON.parse(process.argv[1])[0].root)+'/moved-owner-file');rename.call(fs,intruder,from);}return rename.apply(fs,arguments);};` +
      `fs.unlinkSync=function(name){if(!raced&&String(name).endsWith('/KEEP.md')){raced=true;rename.call(fs,name,path.dirname(JSON.parse(process.argv[1])[0].root)+'/moved-owner-file');rename.call(fs,intruder,name);}return unlink.apply(fs,arguments);};`;
    expect(agentDirectoryConfinedCleanupProgram).toContain(needle);
    const program = agentDirectoryConfinedCleanupProgram.replace(needle, needle + injection);
    const result = spawnSync(process.execPath, ["-e", program, JSON.stringify([{ root, identity, runId: "race-run" }])], {
      cwd: "/", env: {}, timeout: 10_000, encoding: "utf8",
    });
    const retainedRoot = path.join(home, ".paperclip-retained");
    const retainedDirs = await fs.readdir(retainedRoot).catch(() => []);
    const retainedFiles: string[] = [];
    for (const run of retainedDirs) for (const timestamp of await fs.readdir(path.join(retainedRoot, run)))
      for (const name of await fs.readdir(path.join(retainedRoot, run, timestamp)))
        retainedFiles.push(await fs.readFile(path.join(retainedRoot, run, timestamp, name), "utf8"));
    expect(retainedFiles).toEqual([bytes]);
    expect(result.stderr).toMatch(/PAPERCLIP_RETAINED .* identity=[0-9]+:[0-9]+ size=[0-9]+/);
    expect(result.status).toBe(0);
    expect(await fs.stat(root).catch(() => null)).toBeNull();

    // A later cleanup rooted next door does not recurse into retained traces.
    const sibling = path.join(home, "sibling", "live");
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, "ordinary.txt"), "ordinary\n");
    const siblingStat = await fs.lstat(sibling, { bigint: true });
    const siblingIdentity = [siblingStat.dev, siblingStat.ino, siblingStat.birthtimeNs].join(":");
    const later = spawnSync(process.execPath, ["-e", agentDirectoryConfinedCleanupProgram,
      JSON.stringify([{ root: sibling, identity: siblingIdentity, runId: "later-run" }])], { cwd: "/", env: {}, timeout: 10_000, encoding: "utf8" });
    expect(later.status).toBe(0);
    const retainedAfter: string[] = [];
    for (const run of retainedDirs) for (const timestamp of await fs.readdir(path.join(retainedRoot, run)))
      for (const name of await fs.readdir(path.join(retainedRoot, run, timestamp)))
        retainedAfter.push(await fs.readFile(path.join(retainedRoot, run, timestamp, name), "utf8"));
    expect(retainedAfter).toEqual([bytes]);
    console.log(JSON.stringify({ case: "confined-cleanup-race", retainedBytes: retainedAfter.reduce((total, value) => total + Buffer.byteLength(value), 0), checkpointBytesRetained: 0 }));
  });
});
