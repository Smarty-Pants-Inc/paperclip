import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: a bare `heartbeatService(db)` (no options, so no plugin worker manager)
// that can START a run fails environment setup on a plugin sandbox provider
// ("sandbox plugin workers are unavailable in this server process"). Every
// non-test server module must reach a run-starting heartbeat through
// processHeartbeatFor(db) / wiredHeartbeatFor(db). Cancelling STARTS runs too
// (cancelRun promotes the deferred successor and starts the agent's next queued
// run; cancelBudgetScopeWork cancels through cancelRun), so only truly read-only
// callers are allow-listed. An allow-listed file may call ONLY its named methods
// on a bare instance; any other method (run-starting or not yet classified) fails
// the guard, and so does a run-starting method anywhere in the file.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const READ_ONLY: Record<string, { why: string; methods: string[] }> = {
  "services/heartbeat-registry.ts": { why: "the registry's own fallback when nothing is registered (tests)", methods: [] },
  "routes/activity.ts": { why: "heartbeat.getRunReadAccess only (read)", methods: ["getRunReadAccess"] },
};
const RUN_STARTING = /\.(cancelRun|cancelBudgetScopeWork|releaseIssueExecutionAndPromote|sweepStaleIssueLocks|wakeup|startNextQueuedRunForAgent)\b/;
const isComment = (line: string) => /^\s*(\/\/|\*)/.test(line);

/** Methods an allow-listed file calls on a bare heartbeatService(...) instance, by line. */
function bareMethodCalls(lines: string[]): { names: string[]; calls: Array<{ line: number; method: string; text: string }> } {
  const code = lines.map(line => isComment(line) ? "" : line);
  const names = [...code.join("\n").matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*heartbeatService\(/g)].map(m => m[1]!);
  const calls: Array<{ line: number; method: string; text: string }> = [];
  code.forEach((line, index) => {
    const patterns = [/heartbeatService\([^)]*\)\s*\??\.\s*([\w$]+)/g, ...names.map(name => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\??\\.\\s*([\\w$]+)`, "g"))];
    for (const pattern of patterns) for (const m of line.matchAll(pattern)) calls.push({ line: index + 1, method: m[1]!, text: line.trim() });
  });
  return { names, calls };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "helpers" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$|test-support|\.d\.ts$/.test(name) ? [path] : [];
  });
}

describe("process heartbeat guard", () => {
  it("no non-test module starts runs on a bare heartbeatService(db) outside processHeartbeatFor", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      const lines = readFileSync(file, "utf8").split("\n");
      const allowed = READ_ONLY[rel];
      if (allowed) {
        lines.forEach((line, index) => {
          if (!isComment(line) && RUN_STARTING.test(line)) {
            offenders.push(`${rel}:${index + 1}: allow-listed as read-only but starts runs: ${line.trim()}`);
          }
        });
        const { names, calls } = bareMethodCalls(lines);
        for (const call of calls) {
          if (!allowed.methods.includes(call.method)) {
            offenders.push(`${rel}:${call.line}: allow-listed for ${allowed.methods.join(", ") || "no methods"} but calls .${call.method} on a bare heartbeat: ${call.text}`);
          }
        }
        // An entry whose bare instance can no longer be found would allow anything silently.
        if (allowed.methods.length > 0 && names.length === 0) offenders.push(`${rel}: allow-list entry but no bare heartbeatService(...) instance found`);
        continue;
      }
      lines.forEach((line, index) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/heartbeatService\(\s*[\w.$]+(\s+as\s+\w+)?\s*\)/.test(line) && !/processHeartbeatFor\(/.test(line)) {
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
      // A call split across lines with a single argument.
      const text = lines.join("\n");
      for (const match of text.matchAll(/heartbeatService\(\s*\n\s*[\w.$]+(\s+as\s+\w+)?\s*,?\s*\)/g)) {
        offenders.push(`${rel}: multi-line ${match[0].replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("index.ts registers the wired heartbeat before the app, listener, recovery or ownership reconciliation can run", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const at = (needle: string) => {
      const offset = index.indexOf(needle);
      expect(offset, needle).toBeGreaterThanOrEqual(0);
      return offset;
    };
    const registered = at("registerProcessHeartbeat(db as any, accountingHeartbeat);");
    // Registered right after the wired instance is built ...
    expect(registered).toBeGreaterThan(at("const accountingHeartbeat = heartbeat ?? heartbeatService(db as any, { pluginWorkerManager });"));
    // ... and before anything that can settle a lock, drain a finalizer or ingest steering.
    for (const later of ["registerNativeRestartRecheck(", "await createApp(db as any", "server.listen(",
      "recoverNativeRunsAfterRestart(new Date(), undefined", "Report-only ownership reconciliation",
      "reconcileAbandonedExecutionControl(db"]) {
      expect(registered, later).toBeLessThan(at(later));
    }
  });
});
