// Keep reason: C44 credential trust boundary; configured keys must not expand
// a subprocess allowlist. The real runnerd/Pi flow covers shell/proc behavior.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { cleanupGitHubOperationLaunchers, prepareGitHubOperationLaunchers } from "@paperclipai/adapter-utils/execution-target";
import { githubBrokerEnvironment } from "@paperclipai/adapter-utils/github-launcher";
import { describe, expect, it } from "vitest";
import { piProcessEnvironment, piProxyEnvironment } from "./pi-process-environment.js";

const secrets = Object.fromEntries([
  "PAPERCLIP_AGENT_API_KEY", "PAPERCLIP_API_KEY", "PAPERCLIP_AGENT_JWT_SECRET",
  "ASCII_TOKEN",
  "PAPERCLIP_PROVIDER_TRACE_PATH", "PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT", "GH_TOKEN",
  "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN",
  "NODE_OPTIONS", "NODE_PATH", "UNRECOGNIZED_FUTURE_SECRET",
  "PAPERCLIP_PI_FUTURE_SECRET", "OTEL_EXPORTER_OTLP_HEADERS",
].map(name => [name, `decoy-${name}`]));
const safe = { PATH: "/usr/bin:/bin", HOME: "/tmp/pi-home", TMPDIR: "/tmp", LANG: "C.UTF-8", LC_CTYPE: "C.UTF-8",
  TERM: "xterm", PI_CODING_AGENT_DIR: "/tmp/pi-agent", NODE_COMPILE_CACHE: "/tmp/pi-cache",
  PAPERCLIP_PI_BIND_SOCKET: "/tmp/bind.sock", PAPERCLIP_PI_BIND_INITIAL_FILE: "/tmp/initial.json",
  PAPERCLIP_PI_INSTRUCTIONS_FILE: "/tmp/instructions.md", PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY: "host-boundary",
  PAPERCLIP_AGENT_KEY_ID: "agent-identity-id", PAPERCLIP_AGENT_PUBLIC_KEY: "agent-public-decoy",
  PAPERCLIP_AGENT_PRIVATE_KEY: "agent-private-decoy",
  PAPERCLIP_GITHUB_BROKER_TOKEN: "run-broker-capability",
  // Documented Langfuse export for Pi's observability plugin (org 11-13 00:45Z).
  LANGFUSE_BASE_URL: "https://langfuse.example", LANGFUSE_PUBLIC_KEY: "pk-decoy", LANGFUSE_SECRET_KEY: "sk-decoy",
  LANGFUSE_TRACING_ENABLED: "true", LANGFUSE_FLUSH_AT: "1" };

describe("native Pi environment ceilings", () => {
  it("passes Paperclip's managed GitHub projection through the proxy and final Pi spawn", async () => {
    const location = { runId: `pi-env-${randomUUID()}`, target: null };
    try {
      const broker = githubBrokerEnvironment({ PATH: "/usr/bin:/bin", ...secrets,
        GITHUB_TOKEN: "raw-github-decoy", GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "!echo credential-decoy" },
      { url: "http://127.0.0.1:43210", token: "run-broker-capability" });
      const runnerEnvironment = await prepareGitHubOperationLaunchers({ ...location, cwd: tmpdir(),
        env: { ...broker, PAPERCLIP_GITHUB_BRIDGE_TOKEN: "run-bridge-capability" } });
      const expected = {
        PATH: runnerEnvironment.PATH, ZDOTDIR: runnerEnvironment.ZDOTDIR, BASH_ENV: runnerEnvironment.BASH_ENV,
        GH_CONFIG_DIR: runnerEnvironment.GH_CONFIG_DIR, PAPERCLIP_GITHUB_LAUNCHER_DIR: runnerEnvironment.PAPERCLIP_GITHUB_LAUNCHER_DIR,
        PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:43210", PAPERCLIP_GITHUB_BROKER_TOKEN: "run-broker-capability",
        PAPERCLIP_GITHUB_BRIDGE_TOKEN: "run-bridge-capability",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", SSH_AUTH_SOCK: "",
        GIT_SSH_COMMAND: "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes",
      };
      const proxy = piProxyEnvironment(runnerEnvironment);
      expect(proxy).toEqual(expected);
      const pi = piProcessEnvironment(proxy, {});
      expect(pi).toEqual(expected);
      if (process.platform !== "win32") {
        const shell = spawnSync("/bin/bash", ["-c", "command -v git; command -v gh"], { env: pi, encoding: "utf8" });
        expect(shell.status, shell.stderr).toBe(0);
        expect(shell.stdout).toBe(`${runnerEnvironment.PAPERCLIP_GITHUB_LAUNCHER_DIR}/git\n${runnerEnvironment.PAPERCLIP_GITHUB_LAUNCHER_DIR}/gh\n`);
      }
      // No ambient launchers or broker capabilities may bypass the explicit projection.
      expect(piProcessEnvironment({}, runnerEnvironment)).toEqual({ PATH: runnerEnvironment.PATH });
    } finally {
      await cleanupGitHubOperationLaunchers(location);
    }
  });
  it.each(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN"])(
    "never forwards a nonempty raw %s, even with a configured-env marker", (name) => {
      const source = { [name]: "raw-token-decoy", PAPERCLIP_CONFIGURED_ENV_KEYS: JSON.stringify([name]) };
      expect(piProxyEnvironment(source)).toEqual({});
      expect(piProcessEnvironment(source, source)).toEqual({});
    });
  it("does not forward credential-bearing GIT_CONFIG pairs or their count", () => {
    const source = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "!echo credential-decoy",
      PAPERCLIP_CONFIGURED_ENV_KEYS: '["GIT_CONFIG_COUNT","GIT_CONFIG_KEY_0","GIT_CONFIG_VALUE_0"]' };
    expect(piProxyEnvironment(source)).toEqual({});
    expect(piProcessEnvironment(source, source)).toEqual({});
  });
  it("filters explicit overrides AND ambient values; configured marker cannot expand either", () => {
    const source = { ...safe, ...secrets, PAPERCLIP_CONFIGURED_ENV_KEYS: JSON.stringify(Object.keys(secrets)) };
    expect(piProcessEnvironment(source, source)).toEqual(safe);
    expect(piProcessEnvironment({}, source)).toEqual(Object.fromEntries(Object.entries(safe).filter(([name]) => !name.startsWith("PAPERCLIP_") && !name.startsWith("LANGFUSE_") && name !== "PI_CODING_AGENT_DIR")));
  });
  it("retains assigned Ed25519 identity but keeps API/model authentication out of Pi", () => {
    const source = { ...safe, ...secrets, PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:9/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat",
      PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "model-broker-decoy", PAPERCLIP_RUN_ID: "run-current",
      PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker", PAPERCLIP_CONFIGURED_ENV_KEYS: '["ASCII_TOKEN"]' };
    const proxy = piProxyEnvironment(source);
    expect(proxy).toEqual({ ...safe, PAPERCLIP_AI_PROVIDER_URL: source.PAPERCLIP_AI_PROVIDER_URL,
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "model-broker-decoy",
      PAPERCLIP_RUN_ID: "run-current", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker" });
    expect(piProcessEnvironment(proxy, {})).toEqual(safe);
  });
});

const gitConfigEnvironment = (pairs: readonly (readonly [string, string])[]): NodeJS.ProcessEnv => ({
  GIT_CONFIG_COUNT: String(pairs.length),
  ...Object.fromEntries(pairs.flatMap(([key, value], index) => [
    [`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value],
  ])),
});

describe.each([
  ["Pi spawn", (source: NodeJS.ProcessEnv) => piProcessEnvironment(source, {})],
  ["proxy launch", piProxyEnvironment],
  ["proxy then Pi", (source: NodeJS.ProcessEnv) => piProcessEnvironment(piProxyEnvironment(source), {})],
] as const)("safe Git configuration at %s", (_name, project) => {
  it("passes safe.directory and renumbers it after a rejected pair", () => {
    expect(project(gitConfigEnvironment([
      ["http.https://github.com/.extraheader", "Authorization: decoy"],
      ["safe.directory", "/work/project"],
    ]))).toEqual(gitConfigEnvironment([["safe.directory", "/work/project"]]));
  });

  it("drops HTTP credentials and emits no Git variables when none are safe", () => {
    expect(project(gitConfigEnvironment([
      ["http.https://github.com/.extraheader", "Authorization: decoy"],
    ]))).toEqual({});
  });

  it("keeps only the exact safe keys and namespaces in a mixed set", () => {
    const allowed = ["safe.directory", "UsEr.NaMe", "user.email", "gc.auto", "init.defaultbranch",
      "pull.rebase", "fetch.prune", "advice.detachedHead", "CoLoR.ui", "CoRe.autocrlf"];
    const denied = ["http.proxy", "credential.helper", "url.https://github.com/.insteadof", "remote.origin.url",
      "core.SSHCommand", "core.askPass", "core.gitProxy", "core.hooksPath", "core.fsMonitor", "core.pager", "core.editor",
      "include.path", "filter.foo.clean", "user.signingkey", "safe.directory.extra", "core", "core.", "advice.", "color."];
    const pairs = [...allowed, ...denied].map((key) => [key, `value-${key}`] as const);
    expect(project({ ...gitConfigEnvironment(pairs), GIT_CONFIG_KEY_99: "user.name", GIT_CONFIG_VALUE_99: "orphan" }))
      .toEqual(gitConfigEnvironment(pairs.slice(0, allowed.length)));
  });

  it.each([undefined, "", "-1", "+1", "1.0", " 1", "1x", "NaN", "1\n", "9007199254740992"])("drops the whole malformed COUNT %s", (count) => {
    expect(project({ GIT_CONFIG_COUNT: count, GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/work" })).toEqual({});
  });

  it.each(["GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"])("drops all pairs if %s is missing, even on a denied pair", (missing) => {
    const source = gitConfigEnvironment([["safe.directory", "/work"], ["http.extraheader", "decoy"]]);
    delete source[missing];
    expect(project(source)).toEqual({});
  });

  it("preserves empty values, accepts decimal leading zeroes, and drops zero-count orphans", () => {
    expect(project({ ...gitConfigEnvironment([["user.name", ""]]), GIT_CONFIG_COUNT: "01" }))
      .toEqual(gitConfigEnvironment([["user.name", ""]]));
    expect(project({ GIT_CONFIG_COUNT: "0", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "orphan" })).toEqual({});
  });

  it("passes LANGFUSE_FLUSH_AT but no wildcard Langfuse setting", () => {
    expect(project({ LANGFUSE_FLUSH_AT: "1", LANGFUSE_UNKNOWN_SECRET: "decoy" })).toEqual({ LANGFUSE_FLUSH_AT: "1" });
  });
});
