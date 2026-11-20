import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { providerPrefixKeys } from "./fixtures/provider-prefix-keys.js";

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
    it(`${mode}: all four server callers have zero cleartext side effects`, () => {
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
      // R-keep-all-traces: exclude ONLY raw provider trace frame files:
      // **/data/provider-traces/<uuid>.ndjson (and their .rehydration sidecars).
      // Raw-frame masking is the runner half, next pack; logs, comments, events,
      // snapshots and every other captured file remain in the census.
      const rawTraceFiles = files.filter(path => /(?:^|\/)data\/provider-traces\/[a-f0-9-]+\.ndjson(?:\.rehydration)?$/.test(relative(directory, path).replaceAll("\\", "/")));
      expect(rawTraceFiles).toHaveLength(1);
      const hits: { family: string; path: string }[] = [];
      for (const path of files) {
        if (rawTraceFiles.includes(path)) continue;
        const bytes = readFileSync(path);
        for (const [family, key] of providerPrefixKeys) if (bytes.includes(Buffer.from(key))) hits.push({ family, path });
      }
      const census = { mode, directory, status: result.status, files: files.length, families: providerPrefixKeys.length, hits, rawTraceFiles };
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
      expect(coverage.callers).toHaveLength(4);
      expect(coverage.level).toBe("trace");
      expect(readFileSync(join(directory, "stdout.log"), "utf8").includes(mode === "production" ? '"level":10' : "TRACE")).toBe(true);
    }, 190_000);
  }

  // https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21366
  it.skip("runner half: sink redaction before persistence, next pack", async () => {
    const { createProviderTraceFileSink } = await import("../../../packages/paperclip-runner/src/contracts/provider-trace-file-sink.js");
    const directory = mkdtempSync(join(tmpdir(), "provider-raw-frame-no-write-"));
    const path = join(directory, "raw.ndjson");
    const sink = await createProviderTraceFileSink({ path, provider: "pi_rpc", channel: "N1" });
    assert.ok(sink);
    try {
      for (const [, key] of providerPrefixKeys) {
        sink.frame({ direction: "provider_to_client", transport: "stdio", raw: JSON.stringify({ detail: `upstream ${key}\nretry denied` }) });
      }
    } finally {
      await sink.finish();
    }
    const frames = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const decoded = frames.filter(row => row.kind === "frame").map(row => Buffer.from(row.rawBase64 as string, "base64").toString("utf8"));
    assert.equal(decoded.length, providerPrefixKeys.length);
    const noKey = (data: unknown, caller: string) => {
      const text = JSON.stringify(data);
      for (const [family, key] of providerPrefixKeys) assert.ok(!text.includes(key), `${caller}: ${family} leaked`);
    };
    noKey(decoded, "decoded trace frames");
  });

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
