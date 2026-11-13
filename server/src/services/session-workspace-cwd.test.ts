import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isUnsafeSessionWorkspaceCwd } from "./session-workspace-cwd.js";

describe("isUnsafeSessionWorkspaceCwd", () => {
  it("rejects system roots that can poison remote sandbox session resumes", () => {
    expect(isUnsafeSessionWorkspaceCwd("/")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp/")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/private/tmp")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/var/tmp")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/var/run")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/proc")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/sys")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/dev")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/run")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp/.")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/tmp/..")).toBe(true);
    expect(isUnsafeSessionWorkspaceCwd("/var/./run")).toBe(true);
  });

  it("rejects the actual temporary root, its ancestors and physical aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cwd-safety-"));
    try {
      const temporary = path.join(root, "runtime-tmp");
      const alias = path.join(root, "tmp-alias");
      await fs.mkdir(temporary);
      await fs.symlink(temporary, alias);
      vi.stubEnv("TMPDIR", temporary);
      expect(isUnsafeSessionWorkspaceCwd(temporary)).toBe(true);
      expect(isUnsafeSessionWorkspaceCwd(root)).toBe(true);
      expect(isUnsafeSessionWorkspaceCwd(alias)).toBe(true);
      expect(isUnsafeSessionWorkspaceCwd(path.join(temporary, "task-one"))).toBe(false);
      expect(isUnsafeSessionWorkspaceCwd(`${temporary}-sibling`)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("allows concrete workspace descendants", () => {
    expect(isUnsafeSessionWorkspaceCwd("/tmp/paperclip-workspace")).toBe(false);
    expect(isUnsafeSessionWorkspaceCwd("/Users/dotta/paperclip")).toBe(false);
    expect(isUnsafeSessionWorkspaceCwd(null)).toBe(false);
  });
});
