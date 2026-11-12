import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnRunner } from "./control-plane/durable-prp-control-plane.js";
import { nodeCompileCacheEnvironment } from "./node-compile-cache-environment.js";
import { createCapabilityRunnerdProviderEnvironment } from "./live/runnerd-codex-transport.js";

// Keep reason: the Boat compile-cache EACCES incident. Exercise the actual
// pinned Pi entrypoint and Node API, not a source-text or mock-call assertion.
const identity = { runnerInstanceId: "runner-cache", environmentLeaseId: "lease-cache", runId: "run-cache", normalizedSessionId: "session-cache", turnId: "turn-cache", itemId: "item-cache" };
const piCli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));

function launchEnvironment(runtime: string, environment: NodeJS.ProcessEnv = {}) {
  return createCapabilityRunnerdProviderEnvironment({ provider: "pi_rpc", options: { stateDirectory: runtime, environment }, identity, codexHome: join(runtime, "home"), runtimeContextPath: join(runtime, "context.json"), hasRuntimeContext: false });
}

describe("sandbox Node compile-cache policy", () => {
  it("disables caching when no process-local private directory exists", () => {
    expect(nodeCompileCacheEnvironment(undefined, { enableLocalCache: true })).toEqual({ NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: "1" });
    expect(nodeCompileCacheEnvironment("/no-such-private-runtime", { enableLocalCache: true }).NODE_DISABLE_COMPILE_CACHE).toBe("1");
  });

  it("enables Node's actual cache only in a verified private local directory", () => {
    const root = mkdtempSync(join(tmpdir(), "paperclip-private-cache-"));
    try {
      const environment = nodeCompileCacheEnvironment(root, { enableLocalCache: true });
      expect(environment).toEqual({ NODE_COMPILE_CACHE: join(root, "node-compile-cache"), NODE_DISABLE_COMPILE_CACHE: undefined });
      const probe = 'import { enableCompileCache, constants } from "node:module"; const result = enableCompileCache(); console.log(JSON.stringify({enabled: [constants.compileCacheStatus.ENABLED, constants.compileCacheStatus.ALREADY_ENABLED].includes(result.status), directory: result.directory}));';
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...environment }, encoding: "utf8", timeout: 10_000 }));
      expect(result.enabled).toBe(true);
      expect(result.directory === environment.NODE_COMPILE_CACHE || result.directory.startsWith(`${environment.NODE_COMPILE_CACHE}/`)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["unwritable", "not-a-directory", "not-private"])("disables rather than throws for a %s cache", kind => {
    const root = mkdtempSync(join(tmpdir(), "paperclip-unusable-cache-"));
    const cache = join(root, "node-compile-cache");
    try {
      if (kind === "not-a-directory") writeFileSync(cache, "not a directory");
      else mkdirSync(cache, { mode: kind === "unwritable" ? 0o500 : 0o755 });
      expect(nodeCompileCacheEnvironment(root, { enableLocalCache: true })).toEqual({ NODE_COMPILE_CACHE: cache, NODE_DISABLE_COMPILE_CACHE: "1" });
    } finally {
      if (kind !== "not-a-directory") chmodSync(cache, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["codex", "pi_rpc", "opencode", "acpx", "claude_managed", "aws_agentcore"] as const)("applies the same private policy to %s provider launches", provider => {
    const environment = createCapabilityRunnerdProviderEnvironment({ provider, options: { stateDirectory: "/private/runtime", acpxAgent: "codex", environment: { NODE_COMPILE_CACHE: "/tmp/node-compile-cache", NODE_DISABLE_COMPILE_CACHE: "0" } }, identity, codexHome: "/private/runtime/home", runtimeContextPath: "/private/runtime/context.json", hasRuntimeContext: false });
    expect(environment).toMatchObject({ NODE_COMPILE_CACHE: "/private/runtime/node-compile-cache", NODE_DISABLE_COMPILE_CACHE: "1" });
  });

  it("keeps the policy in the structured launch handed to a remote sandbox owner", () => {
    let launched: NodeJS.ProcessEnv | undefined;
    spawnRunner({ connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" }, stateDirectory: "/remote/private/runtime", identity, ticket: "fake-ticket", maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: "0.3.0", runnerDigest: `sha256:${"a".repeat(64)}`, environment: { NODE_COMPILE_CACHE: "/tmp/node-compile-cache", NODE_DISABLE_COMPILE_CACHE: "0" },
      processLauncher: spec => { launched = spec.environment; return { child: { pid: 42, exitCode: null, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" }) }; },
    });
    expect(launched).toMatchObject({ NODE_COMPILE_CACHE: "/remote/private/runtime/node-compile-cache", NODE_DISABLE_COMPILE_CACHE: "1" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("starts the pinned Pi CLI despite an unwritable shared cache and an unusable private cache", () => {
    const root = mkdtempSync(join(tmpdir(), "paperclip-node-cache-"));
    const shared = join(root, "node-compile-cache");
    const runtime = join(root, "private-runtime");
    mkdirSync(shared, { mode: 0o555 });
    mkdirSync(runtime, { mode: 0o700 });
    try {
      expect(() => writeFileSync(join(shared, "permission-probe"), "denied")).toThrow(/EACCES/);
      const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: runtime, PI_CODING_AGENT_DIR: join(runtime, "agent"), ...launchEnvironment(runtime, { TMPDIR: root }) };
      const probe = 'import { enableCompileCache, constants } from "node:module"; const result = enableCompileCache(); console.log(result.status === constants.compileCacheStatus.DISABLED ? "DISABLED" : JSON.stringify(result));';
      // The native API must be disabled, not merely tolerate a cache write error.
      expect(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env: environment, encoding: "utf8", timeout: 10_000 }).trim()).toBe("DISABLED");
      expect(execFileSync(process.execPath, [piCli, "--version"], { env: environment, encoding: "utf8", timeout: 20_000 }).trim()).toBe("1.5.2");
      expect(environment.NODE_COMPILE_CACHE).toBe(join(runtime, "node-compile-cache"));
      // Even private-cache provisioning errors must never turn into run failure.
      writeFileSync(join(runtime, "node-compile-cache"), "not a directory");
      expect(execFileSync(process.execPath, [piCli, "--version"], { env: environment, encoding: "utf8", timeout: 20_000 }).trim()).toBe("1.5.2");
    } finally {
      chmodSync(shared, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
