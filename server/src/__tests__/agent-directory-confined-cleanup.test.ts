import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentDirectoryConfinedCleanupProgram, removeLocalAgentDirectoryConfined } from "../services/agent-directory-probe.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "confined-cleanup-")); homes.push(home);
  const root = path.join(home, "agent/run"), pi = path.join(home, "paperclip-runner/sessions/run/pi");
  await fs.mkdir(root, { recursive: true }); await fs.mkdir(pi, { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "owner bytes\n");
  await fs.writeFile(path.join(pi, "continuity.jsonl"), "ORIGINAL TRACE\n");
  const s = await fs.lstat(root, { bigint: true }), identity = [s.dev, s.ino, s.birthtimeNs].join(":");
  return { home, root, pi, identity };
}
function cleanup(root: string, identity?: string, program = agentDirectoryConfinedCleanupProgram) {
  execFileSync(process.execPath, ["-e", program, JSON.stringify([{ root, identity }])], { env: {}, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
}

describe.skipIf(process.platform !== "linux")("refresh retirement cleanup custody", () => {
  it("removes the stopped physical tree and tolerates an already missing root", async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, "nested")); await fs.writeFile(path.join(f.root, "nested/file"), "partial");
    cleanup(f.root, f.identity); await expect(fs.lstat(f.root)).rejects.toHaveProperty("code", "ENOENT");
    cleanup(f.root, f.identity);
    expect(await fs.readFile(path.join(f.pi, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
  });
  it.each(["root", "ancestor"])("refuses a redirected %s without removing the trace", async redirected => {
    const f = await fixture(), alias = redirected === "root" ? f.root : path.dirname(f.root);
    await fs.rename(alias, alias + "-preserved");
    await fs.symlink(redirected === "root" ? f.pi : path.dirname(path.dirname(f.pi)), alias);
    expect(() => cleanup(f.root, f.identity)).toThrow();
    expect(await fs.readFile(path.join(f.pi, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
  });
  it("refuses a different inode and direct runner-session roots", async () => {
    const f = await fixture(); await fs.rename(f.root, f.root + "-preserved"); await fs.cp(f.root + "-preserved", f.root, { recursive: true });
    expect(() => cleanup(f.root, f.identity)).toThrow(); expect(() => cleanup(f.pi)).toThrow();
    expect(await fs.readFile(path.join(f.pi, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
  });
  it("pins the unlink parent even when an ancestor is replaced immediately before removal", async () => {
    const f = await fixture();
    const program = agentDirectoryConfinedCleanupProgram.replace("fs.unlinkSync(filename);", `fs.renameSync(${JSON.stringify(path.dirname(f.root))},${JSON.stringify(path.dirname(f.root) + "-preserved")});fs.symlinkSync(${JSON.stringify(path.dirname(path.dirname(f.pi)))},${JSON.stringify(path.dirname(f.root))});fs.unlinkSync(filename);`);
    expect(program).not.toBe(agentDirectoryConfinedCleanupProgram);
    expect(() => cleanup(f.root, f.identity, program)).toThrow();
    expect(await fs.readFile(path.join(f.pi, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
  });
  it("applies the same no-follow cleanup to controller mirrors", async () => {
    const f = await fixture(); await removeLocalAgentDirectoryConfined(path.dirname(f.root));
    await expect(fs.lstat(path.dirname(f.root))).rejects.toHaveProperty("code", "ENOENT");
    const alias = path.join(f.home, "alias"); await fs.symlink(f.pi, alias);
    await expect(removeLocalAgentDirectoryConfined(alias)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.pi, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
  });
});
