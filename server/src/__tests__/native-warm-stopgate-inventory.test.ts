import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const services = new URL("../services/", import.meta.url);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith(".ts") && !/\.(?:test|spec)\.ts$/.test(path) ? [path] : [];
  });
}

describe("native warm stop dispatch inventory", () => {
  it("keeps every physical sandbox lifecycle dispatch adjacent to the checkpoint predicate", () => {
    const files = sourceFiles(new URL("../services/", import.meta.url).pathname);
    const callSites: Array<{ file: string; offset: number; source: string }> = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const matches = [
        /(?:pluginWorkerManager|workerManager)\.call\([^)]{0,180}?["']environment(?:Stop|Destroy|Release)Lease["']/g,
        /await\s+(?:release|destroy)SandboxProviderLease\s*\(/g,
        /await\s+provider\.stopLease\s*\(/g,
      ];
      for (const expression of matches) {
        for (const match of source.matchAll(expression)) {
          callSites.push({ file, offset: match.index!, source });
        }
      }
    }
    expect(callSites.length).toBeGreaterThanOrEqual(6);
    for (const callSite of callSites) {
      const prefix = callSite.source.slice(Math.max(0, callSite.offset - 360), callSite.offset);
      expect(prefix, `${callSite.file}:${callSite.offset} provider lifecycle dispatch bypasses the shared gate`)
        .toContain("assertNativeWarmSessionStopReady");
    }
  });
});
