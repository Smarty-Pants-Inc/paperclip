import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createTarballFromDirectory } from "./sandbox-managed-runtime.js";

const execFile = promisify(execFileCallback);

describe("sandbox archive staging", () => {
  // Recorded real catch: a workspace resolving to os.tmpdir() included its own
  // archive and a concurrently removed snapshot directory. Keep the real tar
  // boundary, but use a private temporary root, never the host's shared /tmp.
  it("excludes its staging and tar-list directories when the source is os.tmpdir()", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-tar-staging-test-"));
    const temporary = vi.spyOn(os, "tmpdir").mockReturnValue(root);
    try {
      const staging = path.join(root, "paperclip-sandbox-sync-[one]*");
      await fs.mkdir(staging);
      await fs.writeFile(path.join(staging, "internal.txt"), "not workspace data\n");
      await fs.writeFile(path.join(root, "kept.txt"), "workspace data\n");
      // A literal exclude must not hide a sibling whose name matches its glob.
      const sibling = "paperclip-sandbox-sync-o-more";
      await fs.mkdir(path.join(root, sibling));
      await fs.writeFile(path.join(root, sibling, "kept.txt"), "keep sibling\n");
      const archivePath = path.join(staging, "workspace.tar");
      await createTarballFromDirectory({ localDir: os.tmpdir(), archivePath });
      const { stdout } = await execFile("tar", ["-tf", archivePath]);
      const members = stdout.trim().split("\n");
      expect(members).toContain("kept.txt");
      expect(members).toContain(`${sibling}/kept.txt`);
      expect(members.some(member => member.startsWith(path.basename(staging)))).toBe(false);
      expect(members.some(member => member.startsWith("paperclip-tar-list-"))).toBe(false);
    } finally {
      temporary.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes only the archive when its output directory is the source itself", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-tar-direct-test-"));
    try {
      await fs.writeFile(path.join(root, "kept.txt"), "workspace data\n");
      const archivePath = path.join(root, "workspace.tar");
      await createTarballFromDirectory({ localDir: root, archivePath });
      const { stdout } = await execFile("tar", ["-tf", archivePath]);
      expect(stdout.trim().split("\n")).toEqual(["kept.txt"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
