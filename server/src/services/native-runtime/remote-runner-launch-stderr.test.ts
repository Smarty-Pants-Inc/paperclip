import { execFileSync, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT } from "./native-session-executor.js";
import { REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT } from "./remote-runner-recovery-diagnostics.js";

/** Exercise the real remote launch writer and recovery reader, without a Rust binary. */
async function launch(root: string, nonce: string, childSource: string, script = REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT) {
  const child = spawn("/bin/sh", ["-c", script, "paperclip-runner-child", join(root, "state", "identity"), nonce, "runner-id",
    join(root, "diagnostics"), process.execPath, "-e", childSource, "--", "--runner-id", "runner-id"],
  { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { code, stderr, pid: child.pid!, file: join(root, "diagnostics", `runnerd.launch-stderr.${nonce}.${child.pid}.log`) };
}

const evidence = (root: string, nonce: string, pid: number) => execFileSync("sh",
  ["-c", REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT, "t", nonce, String(pid), join(root, "diagnostics")], { encoding: "utf8" });

describe("remote runnerd stderr evidence", () => {
  it("reads the exact nonce/PID generation after relaunch without overwriting earlier evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-stderr-"));
    try {
      await mkdir(join(root, "state"));
      const first = await launch(root, "first", 'process.stderr.write("paperclip-runnerd: lease expired\\n"); process.exit(3)');
      expect(first.code).toBe(3);
      expect(first.stderr).toBe("");
      expect(await readFile(first.file, "utf8")).toBe("paperclip-runnerd: lease expired\n");
      expect((await stat(first.file)).mode & 0o077).toBe(0);
      expect((await readFile(join(root, "state", "identity"), "utf8")).split("\n")[1]).toBe(String(first.pid));
      const second = await launch(root, "second", 'process.stderr.write("second generation\\n")');
      expect(evidence(root, "first", first.pid)).toContain("lease expired");
      expect(evidence(root, "first", first.pid)).not.toContain("second generation");
      expect(evidence(root, "second", second.pid)).toContain("second generation");
      expect(await readFile(first.file, "utf8")).toBe("paperclip-runnerd: lease expired\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains an oversized generation in full while recovery reads only its bounded tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-retain-"));
    try {
      await mkdir(join(root, "state"));
      const bytes = 8_388_608 + 4096;
      const first = await launch(root, "large", `process.stderr.write("z".repeat(${bytes}) + "\\nend\\n")`);
      expect((await stat(first.file)).size).toBe(bytes + 5);
      const output = evidence(root, "large", first.pid);
      expect(output).toContain("end");
      expect(output.length).toBeLessThan(2200);
      await launch(root, "next", 'process.stderr.write("fresh\\n")');
      expect((await stat(first.file)).size).toBe(bytes + 5);
      expect((await readdir(join(root, "diagnostics"))).sort()).toHaveLength(2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a planted generation symlink rather than writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-symlink-"));
    try {
      await mkdir(join(root, "state"));
      await mkdir(join(root, "diagnostics"), { mode: 0o700 });
      const target = join(root, "target");
      const planted = join(root, "diagnostics", "runnerd.launch-stderr.planted.log");
      await writeFile(target, "unchanged");
      await symlink(target, planted);
      const fixedPath = REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT.replace("runnerd.launch-stderr.${identity_nonce}.$$.log", "runnerd.launch-stderr.planted.log");
      expect(fixedPath).not.toBe(REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT);
      const result = await launch(root, "planted", 'process.stderr.write("must not land\\n")', fixedPath);
      expect(result.code).not.toBe(0);
      expect(await readFile(target, "utf8")).toBe("unchanged");
      expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
