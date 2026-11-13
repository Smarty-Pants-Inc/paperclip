import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createTarballFromDirectory } from "./sandbox-managed-runtime.js";

const execFile = promisify(execFileCallback);

describe("sandbox archive exact owned paths", () => {
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
