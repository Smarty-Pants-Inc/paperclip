import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, REMOTE_RUNNER_PROCESS_STDERR_FILE, REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES,
  REMOTE_RUNNER_PROCESS_STDERR_TRIM_BYTES,
} from "./native-session-executor.js";

/** Runs the launch writer as the remote launcher does, with a Node child standing in for runnerd. */
async function launch(root: string, childSource: string, script = REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT,
  identityPath = join(root, "state", "identity"), nonce = "nonce") {
  const child = spawn("/bin/sh", ["-c", script, "paperclip-runner-child", identityPath, nonce, "runner-id",
    join(root, "diagnostics"), process.execPath, "-e", childSource, "--", "--runner-id", "runner-id"],
  { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
  return { code, stderr, pid: child.pid! };
}

describe("remote runnerd stderr evidence", () => {
  it("keeps runnerd's stderr in its private diagnostics directory and still writes the identity marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-stderr-"));
    try {
      await mkdir(join(root, "state"));
      const result = await launch(root, 'process.stderr.write("paperclip-runnerd: lease expired\\n"); process.exit(3)');
      expect(result.code).toBe(3);
      // Nothing reaches the launcher's own stderr; the reason stays in the sandbox file.
      expect(result.stderr).toBe("");
      const file = join(root, "diagnostics", REMOTE_RUNNER_PROCESS_STDERR_FILE);
      expect(await readFile(file, "utf8")).toBe("paperclip-runnerd: lease expired\n");
      expect((await stat(file)).mode & 0o077).toBe(0);
      expect((await readFile(join(root, "state", "identity"), "utf8")).split("\n")[1]).toBe(String(result.pid));
      // A second launch appends: the earlier exit reason survives the relaunch.
      await launch(root, 'process.stderr.write("second\\n")');
      expect(await readFile(file, "utf8")).toBe("paperclip-runnerd: lease expired\nsecond\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rotates an oversized file at launch and trims it while runnerd runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-rotate-"));
    try {
      await mkdir(join(root, "state"));
      await mkdir(join(root, "diagnostics"), { mode: 0o700 });
      const file = join(root, "diagnostics", REMOTE_RUNNER_PROCESS_STDERR_FILE);
      await writeFile(file, "o".repeat(REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES + 1));
      await launch(root, 'process.stderr.write("fresh\\n")');
      expect((await stat(`${file}.1`)).size).toBe(REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES + 1);
      // The trimmer checks every 15 s in production; check it quickly here.
      const fast = REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT.replace("sleep 15", "sleep 0.2");
      expect(fast).not.toBe(REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT);
      await launch(root, `process.stderr.write("z".repeat(${REMOTE_RUNNER_PROCESS_STDERR_TRIM_BYTES + 4096}) + "\\nend\\n"); setTimeout(() => {}, 1500)`, fast);
      const size = (await stat(file)).size;
      // Past the 8 MiB backstop the trimmer keeps the last 1 MiB, the most recent lines included.
      expect(size).toBeLessThanOrEqual(REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES + 4096);
      expect((await readFile(file, "utf8")).endsWith("end\n")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Trace-keep (C8 2868978cf): a launch that fails before exec, for example on the
  // identity-marker write, still leaves durable evidence in its own private file.
  it("keeps a pre-exec launch failure in that generation's own launch-stderr file", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-pre-exec-"));
    try {
      const result = await launch(root, 'process.stderr.write("must not start\\n")', REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT,
        join(root, "missing-parent", "identity"), "pre-exec-nonce");
      expect(result.code).not.toBe(0);
      const names = await readdir(join(root, "diagnostics"));
      const launchFile = names.find(name => name.startsWith("runnerd.launch-stderr.pre-exec-nonce."));
      expect(launchFile).toBeDefined();
      const path = join(root, "diagnostics", launchFile!);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).toContain("missing-parent");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // Upstream's rotation alone kept only the last two generations; no generation's evidence may be discarded.
  it("keeps every generation's stderr across three oversized launches", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-generations-"));
    try {
      await mkdir(join(root, "state"));
      for (const generation of [1, 2, 3]) {
        await launch(root, `process.stderr.write("GENERATION_${generation}\\n" + "x".repeat(${REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES + 64}) + "\\n")`,
          REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, join(root, "state", "identity"), `nonce-${generation}`);
      }
      const directory = join(root, "diagnostics");
      const names = await readdir(directory);
      const all = (await Promise.all(names.map(name => readFile(join(directory, name), "utf8")))).join("");
      for (const generation of [1, 2, 3]) expect(all).toContain(`GENERATION_${generation}\n`);
      // The newest generation is still the recovery-readable file; the previous one is `.1`.
      expect((await readFile(join(directory, REMOTE_RUNNER_PROCESS_STDERR_FILE), "utf8")).startsWith("GENERATION_3\n")).toBe(true);
      expect((await readFile(join(directory, `${REMOTE_RUNNER_PROCESS_STDERR_FILE}.1`), "utf8")).startsWith("GENERATION_2\n")).toBe(true);
      expect(names.filter(name => name.startsWith("runnerd.launch-stderr."))).toHaveLength(3);
      for (const name of names) expect((await stat(join(directory, name))).mode & 0o077).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("never writes through a symlink at the stderr path", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-symlink-"));
    try {
      await mkdir(join(root, "state"));
      await mkdir(join(root, "diagnostics"), { mode: 0o700 });
      await writeFile(join(root, "target"), "");
      await symlink(join(root, "target"), join(root, "diagnostics", REMOTE_RUNNER_PROCESS_STDERR_FILE));
      const result = await launch(root, 'process.stderr.write("must not land\\n")');
      expect(result.code).toBe(0);
      expect(await readFile(join(root, "target"), "utf8")).toBe("");
      expect((await lstat(join(root, "diagnostics", REMOTE_RUNNER_PROCESS_STDERR_FILE))).isSymbolicLink()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
