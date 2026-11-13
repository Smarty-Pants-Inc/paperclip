import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteCommandArgv } from "./remote-command-environment.js";

// Keep reason: REG-12 bootstrap crosses a provider argv/uid boundary before Pi exists.
describe("remote command compile-cache policy", () => {
  it("rejects empty commands rather than printing the inherited environment", () => {
    for (const input of [[], [""]]) expect(() => remoteCommandArgv(input)).toThrow("must not be empty");
  });

  it.skipIf(process.platform === "win32")("passes literal arguments through the real shell without mutation", () => {
    const input = ["printf", "%s|", "a b", "c'd", "$HOME"];
    const argv = remoteCommandArgv(input);
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv.slice(3)).toEqual(["paperclip-node-cache", ...input]);
    expect(execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8" })).toBe("a b|c'd|$HOME|");
    expect(input).toEqual(["printf", "%s|", "a b", "c'd", "$HOME"]);
  });

  it.skipIf(process.platform === "win32")("respects XDG_CACHE_HOME and a caller's cache including its disable flag", () => {
    const root = mkdtempSync(join(tmpdir(), "reg12c-xdg-"));
    try {
      const env = { PATH: process.env.PATH!, HOME: "/nonexistent", XDG_CACHE_HOME: root, NODE_DISABLE_COMPILE_CACHE: "1" };
      const script = 'printf "%s|%s" "$NODE_COMPILE_CACHE" "${NODE_DISABLE_COMPILE_CACHE-unset}"';
      const argv = remoteCommandArgv(["sh", "-c", script]);
      expect(execFileSync(argv[0]!, argv.slice(1), { env, encoding: "utf8" })).toBe(`${root}/node-compile-cache|unset`);
      expect(execFileSync(argv[0]!, argv.slice(1), { env: { ...env, NODE_COMPILE_CACHE: "/private/pi" }, encoding: "utf8" })).toBe("/private/pi|1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
