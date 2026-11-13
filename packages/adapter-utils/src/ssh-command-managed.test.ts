import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.execFile("sh", ["-c", args.at(-1)!], options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") throw new Error(`Unexpected subprocess ${file}`);
      return actual.spawn("sh", ["-c", args.at(-1)!], options);
    }),
  };
});

import { createSshCommandManagedRuntimeRunner } from "./ssh.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function runner() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ssh-managed-argv-"));
  roots.push(cwd);
  return createSshCommandManagedRuntimeRunner({
    spec: {
      host: "fixture.invalid", username: "fixture", port: 22,
      remoteCwd: cwd, remoteWorkspacePath: cwd,
      privateKey: null, knownHosts: null, strictHostKeyChecking: true,
    },
  });
}

describe("SSH command-managed argv", () => {
  // REG-12: this probe runs before runnerd/Pi can select a private cache.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("preserves caller-selected caches for bootstrap commands and descendants", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-node-cache-"));
    roots.push(root);
    const shared = path.join(root, "node-compile-cache");
    await mkdir(shared, { mode: 0o555 });
    try {
      await expect(writeFile(path.join(shared, "permission-probe"), "no")).rejects.toMatchObject({ code: "EACCES" });
      const script = "const result=require('node:module').enableCompileCache(); console.log(JSON.stringify({disabled:process.env.NODE_DISABLE_COMPILE_CACHE,status:result.status}));";
      for (const disabled of [undefined, "", "0"]) {
        const result = await (await runner()).execute({
          command: process.execPath, args: ["-e", `require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(script)}],{stdio:'inherit'});`],
          env: { TMPDIR: root, NODE_COMPILE_CACHE: shared, ...(disabled === undefined ? {} : { NODE_DISABLE_COMPILE_CACHE: disabled }) }, timeoutMs: 5000,
        });
        expect(result.exitCode).toBe(0);
        // Caller paths/flags win, even when unusable; the controller cannot validate them.
        expect(JSON.parse(result.stdout)).toEqual({ ...(disabled === undefined ? {} : { disabled }), status: disabled === undefined ? 0 : 3 });
      }
      expect(await readdir(shared)).toEqual([]);
    } finally { await chmod(shared, 0o700); }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("carries the policy into Node run by a login profile before the payload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ssh-profile-node-cache-"));
    roots.push(root);
    const marker = path.join(root, "profile.json"), shared = path.join(root, "node-compile-cache");
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    await mkdir(shared, { mode: 0o555 });
    vi.stubEnv("HOME", root);
    vi.stubEnv("TMPDIR", root);
    vi.stubEnv("NODE_COMPILE_CACHE", undefined);
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", undefined);
    try {
      const script = "console.log(JSON.stringify({disabled:process.env.NODE_DISABLE_COMPILE_CACHE,cache:process.env.NODE_COMPILE_CACHE,cacheDir:require('node:module').getCompileCacheDir()}));";
      await writeFile(path.join(root, ".profile"), `${quote(process.execPath)} -e ${quote(script)} > ${quote(marker)}\n`);
      const result = await (await runner()).execute({ command: process.execPath, args: ["-e", script], timeoutMs: 5000 });
      expect(result.exitCode).toBe(0);
      const actual = JSON.parse(result.stdout);
      expect(actual.cache).toBe(path.join(root, ".cache", "node-compile-cache"));
      expect(actual.disabled).toBeUndefined();
      expect(actual.cacheDir.startsWith(`${actual.cache}/`)).toBe(true);
      expect(JSON.parse(await readFile(marker, "utf8"))).toEqual(actual);
      expect(await readdir(shared)).toEqual([]);
    } finally { await chmod(shared, 0o700); }
  });

  it("rejects environment keys that could be interpreted as env options", async () => {
    await expect((await runner()).execute({ command: "true", env: { "-u": "PATH" } }))
      .rejects.toThrow("Invalid SSH environment variable key");
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    "preserves shell positional arguments with environment=%s and stdin=%s",
    async (withEnvironment, withStdin) => {
      const value = "literal 'quote' $(printf unsafe) `printf unsafe`";
      const result = await (await runner()).execute({
        command: "sh",
        args: ["-c", 'set -eu; printf "%s\\n" "$0" "$1" "$2" "${SENTINEL_TEXT-unset}"', "named-probe", "two words", value],
        ...(withEnvironment ? { env: { SENTINEL_TEXT: value } } : {}),
        ...(withStdin ? { stdin: "" } : {}),
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(["named-probe", "two words", value, withEnvironment ? value : "unset"].join("\n") + "\n");
    },
  );

  it("applies environment to a non-shell command", async () => {
    const result = await (await runner()).execute({
      command: "printenv", args: ["SENTINEL_TEXT"],
      env: { SENTINEL_TEXT: "two words" }, timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("two words\n");
  });
});
