import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: a bare `heartbeatService(db)` (no options, so no plugin worker manager)
// that can START a run fails environment setup on a plugin sandbox provider
// ("sandbox plugin workers are unavailable in this server process"). Every
// non-test server module must reach a run-starting heartbeat through
// processHeartbeatFor(db) / wiredHeartbeatFor(db). Known callers that only
// cancel or read are allow-listed by file, with the reason.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANCEL_OR_READ_ONLY: Record<string, string> = {
  "services/heartbeat-registry.ts": "the registry's own fallback when nothing is registered (tests)",
  "services/issues.ts": "heartbeat.cancelRun only",
  "routes/activity.ts": "heartbeat.getRunReadAccess only (read)",
  "routes/prompt-injection-prevention.ts": "cancelBudgetScopeWork only",
  "routes/fast-responses.ts": "cancelBudgetScopeWork only",
  "routes/decision-models.ts": "cancelBudgetScopeWork only",
  "routes/companies.ts": "cancelBudgetScopeWork only",
};

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
      if (CANCEL_OR_READ_ONLY[rel]) continue;
      const lines = readFileSync(file, "utf8").split("\n");
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
