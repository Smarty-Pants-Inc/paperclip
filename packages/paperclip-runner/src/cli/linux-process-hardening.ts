import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Node has no prctl API. A tiny pack-owned Node-API initializer applies it in
 * THIS process, after exec, before the broker reads any upstream credential.
 * Missing/tampered native code is a startup error, never an insecure fallback.
 */
export function protectPiProxyProcess(trustedProxyEntrypointUrl: string | undefined): void {
  if (process.platform !== "linux") return;
  if (!trustedProxyEntrypointUrl) throw new Error("Pi proxy isolation requires the verified pack resource binding");
  const cli = dirname(fileURLToPath(trustedProxyEntrypointUrl));
  const path = resolve(cli, "linux-process-hardening.node"), root = resolve(cli, "../..");
  const metadata = lstatSync(path), directory = lstatSync(cli);
  const trustedOwner = (uid: number) => uid === 0 || uid === process.getuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o022) !== 0
    || !trustedOwner(metadata.uid) || !directory.isDirectory() || (directory.mode & 0o022) !== 0 || !trustedOwner(directory.uid)) {
    throw new Error("Pi proxy isolation artifact is not a trusted regular file");
  }
  const artifact = JSON.parse(readFileSync(resolve(root, "provider-pack.json"), "utf8"))?.payload?.artifacts?.piProcessHardening;
  const actual = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  if (!artifact || typeof artifact.path !== "string" || resolve(root, artifact.path) !== realpathSync(path) || artifact.sha256 !== actual) {
    throw new Error("Pi proxy isolation artifact integrity check failed");
  }
  createRequire(trustedProxyEntrypointUrl)(path);
}
