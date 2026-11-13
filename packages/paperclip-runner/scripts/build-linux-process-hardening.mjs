import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** No npm/native dependency or target Node headers: just the stable Node-API
 * initializer ABI and Linux prctl. Build on the provider pack's target host/libc.
 */
export function buildLinuxProcessHardening(output = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli/linux-process-hardening.node")) {
  if (process.platform !== "linux") return;
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("cc", ["-shared", "-fPIC", "-O2", "-Wall", "-Wextra", "-Werror", "-Wl,-z,relro,-z,now",
    resolve(dirname(fileURLToPath(import.meta.url)), "linux-process-hardening.c"), "-o", output], { stdio: "pipe" });
  chmodSync(output, 0o644);
  return output;
}
