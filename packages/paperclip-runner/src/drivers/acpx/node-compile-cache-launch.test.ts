import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sanitizedNodeEnvironment } from "./installation-integrity.js";

// REG-12: a minimal metadata-probe env must not drop the launch policy.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("protects verified ACPX/probe Node launches with minimal or caller env", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-node-policy-")), shared = join(root, "node-compile-cache");
  mkdirSync(shared, { mode: 0o555 });
  try {
    expect(() => writeFileSync(join(shared, "permission-probe"), "no")).toThrow(/EACCES/);
    for (const flag of [undefined, "", "0"]) {
      const input = { TMPDIR: root, NODE_COMPILE_CACHE: shared, ...(flag === undefined ? {} : { NODE_DISABLE_COMPILE_CACHE: flag }) };
      const environment = sanitizedNodeEnvironment(input);
      expect(environment.NODE_DISABLE_COMPILE_CACHE).toBe("1");
      const script = "console.log(JSON.stringify({disabled:process.env.NODE_DISABLE_COMPILE_CACHE,status:require('node:module').enableCompileCache().status}));";
      expect(JSON.parse(execFileSync(process.execPath, ["-e", script], { env: environment, encoding: "utf8", timeout: 5000 }))).toEqual({ disabled: "1", status: 3 });
      expect(input.NODE_COMPILE_CACHE).toBe(shared);
    }
    expect(readdirSync(shared)).toEqual([]);
  } finally { chmodSync(shared, 0o700); rmSync(root, { recursive: true, force: true }); }
});
