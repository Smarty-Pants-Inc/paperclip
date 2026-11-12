import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256DirectoryTree } from "./native-session-executor.js";
import { sha256DirectoryTreeStreamed } from "./off-loop-file-work.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
// Load only the real producer's two pure hash functions, never its deploy/build
// entrypoint. This exercises a tiny fixture rather than rebuilding the full pack.
const producerSource = readFileSync(new URL("../../../../packages/paperclip-runner/scripts/build-provider-pack.mjs", import.meta.url), "utf8");
const producerFunctions = producerSource.slice(producerSource.indexOf("function sha256File("), producerSource.indexOf("function writePortableNodeShim("));
const producerTree = runInNewContext(`${producerFunctions}\nsha256Tree`, { createHash, readFileSync, readdirSync, readlinkSync, join }) as (root: string) => string;

describe.skipIf(process.platform === "win32")("locale-independent provider pack tree order", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pack-tree-order-"));
    mkdirSync(join(root, "Z"));
    for (const name of ["a_b", "aB", "Z"]) writeFileSync(join(root, "Z", name), name);
    writeFileSync(join(root, "aB"), "upper");
    writeFileSync(join(root, "a_b"), "underscore");
    symlinkSync("a_b", join(root, "z-link"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(["producer", "controller-sync", "controller-streamed"] as const)("uses UTF-16 code-unit entry order in %s, including nested directories and symlinks", async implementation => {
    // Independent literal order: ICU collates these as a_b, aB, Z instead.
    const records = ["directory\0Z\n", ...["Z", "aB", "a_b"].map(name => `file\0Z/${name}\0${sha(name)}\n`),
      `file\0aB\0${sha("upper")}\n`, `file\0a_b\0${sha("underscore")}\n`, "symlink\0z-link\0a_b\n"];
    const actual = implementation === "producer" ? producerTree(root)
      : implementation === "controller-sync" ? sha256DirectoryTree(root) : await sha256DirectoryTreeStreamed(root, path => new Error(`Unsupported fixture entry ${path}`));
    expect(actual).toBe(sha(records.join("")));
  });
});
