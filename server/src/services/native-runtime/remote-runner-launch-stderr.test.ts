import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, REMOTE_RUNNER_PROCESS_STDERR_FILE, REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES,
  REMOTE_RUNNER_PROCESS_STDERR_TRIM_BYTES,
} from "./native-session-executor.js";

/** The shared process log is a copy the detached copier appends about once a second; wait for it. */
async function eventually(read: () => Promise<string>, check: (text: string) => void, timeout = 5_000) {
  await vi.waitFor(async () => check(await read()), { timeout, interval: 50 });
}

/** The copier/trimmer for runnerd `pid`, found by its own argv, as the stale-state fence finds it. */
async function copierPids(pid: number) {
  const found: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const argv = await readFile(`/proc/${entry}/cmdline`, "utf8").then(text => text.split("\0"), () => []);
    if (argv[3] === "paperclip-runner-stderr-trim" && argv[4] === String(pid)) found.push(Number(entry));
  }
  return found;
}

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
      await eventually(() => readFile(file, "utf8"), text => expect(text).toBe("paperclip-runnerd: lease expired\n"));
      expect((await stat(file)).mode & 0o077).toBe(0);
      expect((await readFile(join(root, "state", "identity"), "utf8")).split("\n")[1]).toBe(String(result.pid));
      // A second launch appends: the earlier exit reason survives the relaunch.
      await launch(root, 'process.stderr.write("second\\n")');
      await eventually(() => readFile(file, "utf8"), text => expect(text).toBe("paperclip-runnerd: lease expired\nsecond\n"));
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
      await eventually(() => readFile(file, "utf8"), text => expect(text).toBe("fresh\n"));
      // The copier passes every second and trims every 15 passes in production; check it quickly here.
      const fast = REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT.replace('"$passes" -ge 15', '"$passes" -ge 1').replace("sleep 1; done", "sleep 0.2; done");
      expect(fast).not.toContain('"$passes" -ge 15');
      expect(fast).not.toContain("sleep 1; done");
      await launch(root, `process.stderr.write("z".repeat(${REMOTE_RUNNER_PROCESS_STDERR_TRIM_BYTES + 4096}) + "\\nend\\n"); setTimeout(() => {}, 1500)`, fast);
      await eventually(() => readFile(file, "utf8"), text => expect(text.endsWith("end\n")).toBe(true));
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

  // Trust-boundary failure path: runnerd must never start without its generation's evidence file.
  it.each(["EACCES", "noclobber"] as const)("fails promptly before exec when the generation log open gets %s", async (failure) => {
    // Root bypasses mode 0500, so running this permission regression as root is not valid proof.
    expect(process.geteuid?.(), "run the real-file EACCES regression as a non-root user").toBeGreaterThan(0);
    const root = await mkdtemp(join(tmpdir(), "runner-launch-open-failure-"));
    const directory = join(root, "diagnostics");
    const identity = join(root, "state", "identity");
    const marker = join(root, "child-started");
    const nonce = "open-failure-nonce";
    const existing = "previous generation evidence\n";
    try {
      await mkdir(join(root, "state"));
      await mkdir(directory, { mode: 0o700 });
      if (failure === "EACCES") await chmod(directory, 0o500);
      // The real launcher deliberately chmods the directory to 0700. Restore 0500
      // immediately after that setup call to inject a real EACCES at the open,
      // rather than accidentally testing the chmod repair or an earlier failure.
      // The production script below is unchanged; only this shell's chmod is wrapped.
      const setup = failure === "EACCES"
        ? 'failure_diagnostics=$4; chmod() { command chmod "$@" || return; if test "$1" = 0700 && test "$2" = "$failure_diagnostics"; then command chmod 0500 "$2"; fi; }; '
        // Use this shell's actual PID: no guessed PID, glob, or race with the open.
        : `umask 077; printf '%s' '${existing}' > "$4/runnerd.launch-stderr.$2.$$.log"; `;
      const result = spawnSync("/bin/sh", ["-c", setup + REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT,
        "paperclip-runner-child", identity, nonce, "runner-id", directory, process.execPath, "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "runnerd started")`, "--", "--runner-id", "runner-id"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" },
        timeout: 5_000, killSignal: "SIGKILL" });
      // A timeout/signal is not a clear failure: require the shell's own nonzero exit.
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBeNull();
      expect(result.status).toBeGreaterThan(0);
      const name = `runnerd.launch-stderr.${nonce}.${result.pid}.log`;
      expect(result.stderr).toContain(join(directory, name));
      expect(result.stderr).toMatch(failure === "EACCES" ? /Permission denied/i : /File exists|cannot overwrite/i);
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(identity)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(root, "state"))).toEqual([]);
      expect(await copierPids(result.pid)).toEqual([]);
      if (failure === "EACCES") {
        expect((await stat(directory)).mode & 0o777).toBe(0o500);
        expect(await readdir(directory)).toEqual([]);
      } else {
        expect(await readdir(directory)).toEqual([name]);
        expect(await readFile(join(directory, name), "utf8")).toBe(existing);
      }
    } finally {
      await chmod(directory, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  // Upstream's rotation alone kept only the last two generations; no generation's evidence may be discarded.
  it("keeps every generation's stderr across three oversized launches", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-generations-"));
    try {
      await mkdir(join(root, "state"));
      const directory = join(root, "diagnostics");
      for (const generation of [1, 2, 3]) {
        await launch(root, `process.stderr.write("GENERATION_${generation}\\n" + "x".repeat(${REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES + 64}) + "\\n")`,
          REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, join(root, "state", "identity"), `nonce-${generation}`);
        await eventually(() => readFile(join(directory, REMOTE_RUNNER_PROCESS_STDERR_FILE), "utf8"),
          text => expect(text.startsWith(`GENERATION_${generation}\n`)
            && text.length === `GENERATION_${generation}\n`.length + REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES + 65).toBe(true));
      }
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

  // review-fleet-2 (m1a2tee): an earlier short generation's stderr sat only in the
  // shared log, and a later noisy generation's live trimmer cut it to its last
  // 1 MiB, erasing that trace and the noisy generation's start. Each generation's
  // own file must keep its whole stream. Unmodified production script and interval.
  it("keeps every generation's whole stderr in its own file when the live trimmer cuts the shared log", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-shared-trim-"));
    try {
      await mkdir(join(root, "state"));
      const directory = join(root, "diagnostics");
      const log = join(directory, REMOTE_RUNNER_PROCESS_STDERR_FILE);
      const marker = "PRIOR_GENERATION_TRACE_MUST_SURVIVE\n";
      const first = await launch(root, `process.stderr.write(${JSON.stringify(marker)})`, REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT,
        join(root, "state", "identity"), "nonce-1");
      expect(first.code).toBe(0);
      await eventually(() => readFile(log, "utf8"), text => expect(text).toBe(marker));
      const payloadSource = `"NOISY_SECOND_GENERATION\\n" + "x".repeat(${REMOTE_RUNNER_PROCESS_STDERR_TRIM_BYTES + 4096}) + "\\nEND_SECOND\\n"`;
      const payload = `NOISY_SECOND_GENERATION\n${"x".repeat(REMOTE_RUNNER_PROCESS_STDERR_TRIM_BYTES + 4096)}\nEND_SECOND\n`;
      // runnerd stays up, as a live one does, until its own trimmer has cut the shared log (30 s cap).
      const second = await launch(root, `const fs = require("node:fs"); let data = Buffer.from(${payloadSource});
        while (data.length) data = data.subarray(fs.writeSync(2, data));
        const started = Date.now(); let grown = false;
        const check = () => { let size = 0; try { size = fs.statSync(${JSON.stringify(log)}).size } catch {}
          if (size > ${REMOTE_RUNNER_PROCESS_STDERR_TRIM_BYTES}) grown = true;
          if ((grown && size <= ${REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES}) || Date.now() - started > 30000) process.exit(0); setTimeout(check, 200); };
        check();`, REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, join(root, "state", "identity"), "nonce-2");
      expect(second.code).toBe(0);
      const names = (await readdir(directory)).sort();
      const launchFile = (nonce: string) => names.find(name => name.startsWith(`runnerd.launch-stderr.${nonce}.`))!;
      expect(names).toEqual([launchFile("nonce-1"), launchFile("nonce-2"), REMOTE_RUNNER_PROCESS_STDERR_FILE].sort());
      // Both generations are whole in their own files.
      expect(await readFile(join(directory, launchFile("nonce-1")), "utf8")).toBe(marker);
      expect(await readFile(join(directory, launchFile("nonce-2")), "utf8")).toBe(payload);
      // The shared log is still upstream's bounded copy: trimmed live to its last 1 MiB, newest bytes kept.
      const shared = await readFile(log, "utf8");
      expect(shared.length).toBeLessThanOrEqual(REMOTE_RUNNER_PROCESS_STDERR_MAX_BYTES);
      expect(shared.endsWith("\nEND_SECOND\n")).toBe(true);
      expect(shared).not.toContain(marker);
      for (const name of names) expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);

  // The copy into the shared log runs beside runnerd, never in its write path:
  // a stopped or killed copier must not block runnerd, fail its writes, or change its exit status.
  it.each(["SIGSTOP", "SIGKILL"] as const)("never blocks runnerd or changes its exit status when the copier gets %s", async (signal) => {
    const root = await mkdtemp(join(tmpdir(), "runner-launch-copier-"));
    let stopped: number[] = [];
    try {
      await mkdir(join(root, "state"));
      const directory = join(root, "diagnostics");
      const ready = join(root, "ready");
      const go = join(root, "go");
      const payload = `START\n${"y".repeat(4 * 1_048_576)}\nEND\n`;
      const exited = launch(root, `const fs = require("node:fs");
        fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        const wait = () => { if (!fs.existsSync(${JSON.stringify(go)})) return setTimeout(wait, 20);
          let data = Buffer.from("START\\n" + "y".repeat(${4 * 1_048_576}) + "\\nEND\\n"); while (data.length) data = data.subarray(fs.writeSync(2, data));
          process.exit(7); };
        wait();`);
      let pid = 0;
      await vi.waitFor(async () => { pid = Number(await readFile(ready, "utf8")); expect(pid).toBeGreaterThan(0); }, { timeout: 5_000 });
      await vi.waitFor(async () => { stopped = await copierPids(pid); expect(stopped).toHaveLength(1); }, { timeout: 5_000 });
      process.kill(stopped[0], signal);
      await writeFile(go, "");
      const result = await Promise.race([exited, new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 10_000))]);
      expect(result).not.toBe("blocked");
      expect((result as Awaited<typeof exited>).code).toBe(7);
      expect((await readFile(join(root, "state", "identity"), "utf8")).split("\n")[1]).toBe(String(pid));
      const names = await readdir(directory);
      const own = names.find(name => name.startsWith("runnerd.launch-stderr.nonce."))!;
      expect(await readFile(join(directory, own), "utf8")).toBe(payload);
      expect((await stat(join(directory, own))).mode & 0o777).toBe(0o600);
      if (signal === "SIGSTOP") {
        // Resumed, the copier sees runnerd gone and copies everything it wrote before exiting.
        process.kill(stopped[0], "SIGCONT");
        await eventually(() => readFile(join(directory, REMOTE_RUNNER_PROCESS_STDERR_FILE), "utf8"), text => expect(text).toBe(payload), 10_000);
        await vi.waitFor(async () => expect(await copierPids(pid)).toEqual([]), { timeout: 5_000 });
      }
    } finally {
      for (const copier of stopped) { try { process.kill(copier, "SIGKILL"); } catch {} }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

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
