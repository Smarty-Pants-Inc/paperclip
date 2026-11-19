import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { providerPrefixKeys } from "../../../packages/paperclip-runner/test/provider-prefix-keys.js";

// Keep reason: never-OK exposing a matched credential in a diagnostic side effect.
// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21032
// All canaries are assembled at runtime. Assertions name families, never raw keys.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const filesUnder = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
});

if (process.env.N1_DIRECTORY) {
  it("N1 subprocess: real callers with trace logging", async () => {
    const { exerciseNoWrite } = await import("./fixtures/provider-prefix-no-write.js");
    await exerciseNoWrite();
  }, 180_000);
} else describe("N1 no-write of the matched secret with trace logging enabled", () => {
  for (const mode of ["production", "development"]) {
    it(`${mode}: all five callers have zero cleartext side effects`, () => {
      const directory = mkdtempSync(join(tmpdir(), `provider-no-write-${mode}-`));
      const environment = {
        PATH: process.env.PATH, NODE_ENV: mode, PAPERCLIP_LOG_LEVEL: "trace", LOG_LEVEL: "trace",
        PAPERCLIP_MANAGED_RUNTIME_HTTPS: "off", PAPERCLIP_HOME: join(directory, "home"),
        PAPERCLIP_CONFIG: join(directory, "home", "config.json"),
        PAPERCLIP_INSTANCE_ID: "no-write", TMPDIR: directory, HOME: join(directory, "user"),
        XDG_CACHE_HOME: join(directory, "cache"), N1_DIRECTORY: directory,
      };
      const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "src/__tests__/provider-prefix-no-write.test.ts", "--maxWorkers=2"], {
        cwd: join(root, "server"), env: environment, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      });
      writeFileSync(join(directory, "stdout.log"), result.stdout ?? "");
      writeFileSync(join(directory, "stderr.log"), result.stderr ?? "");
      writeFileSync(join(directory, "process-result.json"), JSON.stringify({ status: result.status, signal: result.signal, error: result.error ? String(result.error) : null }));
      const files = filesUnder(directory);
      const hits: { family: string; path: string }[] = [];
      for (const path of files) {
        const bytes = readFileSync(path);
        for (const [family, key] of providerPrefixKeys) if (bytes.includes(Buffer.from(key))) hits.push({ family, path });
      }
      const census = { mode, directory, status: result.status, files: files.length, families: providerPrefixKeys.length, hits };
      const evidence = process.env.PAPERCLIP_REDACTION_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, `N1-${mode}.json`), JSON.stringify(census, null, 2));
      }
      // Emit only safe census metadata. Full child stdout/stderr/files are retained
      // at the printed directory even on failure; do not echo raw child errors.
      console.log("N1", JSON.stringify(census));
      expect(hits, "raw canary found in captured side effects").toEqual([]);
      expect(result.status, `fixture failed; inspect ${directory}/stderr.log`).toBe(0);
      const coverage = JSON.parse(readFileSync(join(directory, "coverage.json"), "utf8"));
      expect(coverage.canaries).toBe(29);
      expect(coverage.callers).toHaveLength(5);
      expect(coverage.level).toBe("trace");
      expect(readFileSync(join(directory, "stdout.log"), "utf8").includes(mode === "production" ? '"level":10' : "TRACE")).toBe(true);
    }, 190_000);
  }

  it("committed snapshots contain zero full canary values", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0")
      .filter(path => /(?:__snapshots__\/|\.snap$|snapshot[^/]*\.(?:json|ndjson)$)/i.test(path));
    expect(files.length).toBeGreaterThan(0);
    const hits: { family: string; path: string }[] = [];
    for (const path of files) {
      const bytes = readFileSync(resolve(root, path));
      for (const [family, key] of providerPrefixKeys) if (bytes.includes(Buffer.from(key))) hits.push({ family, path });
    }
    console.log("N1 committed snapshots", JSON.stringify({ files: files.length, families: providerPrefixKeys.length, hits }));
    expect(hits).toEqual([]);
  });
});
