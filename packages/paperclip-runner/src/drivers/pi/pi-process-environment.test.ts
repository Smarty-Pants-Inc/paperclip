// Keep reason: C44 credential trust boundary; configured keys must not expand
// a subprocess allowlist. The real runnerd/Pi flow covers shell/proc behavior.
import { describe, expect, it } from "vitest";
import { piProcessEnvironment, piProxyEnvironment } from "./pi-process-environment.js";

const secrets = Object.fromEntries([
  "PAPERCLIP_AGENT_API_KEY", "PAPERCLIP_API_KEY", "PAPERCLIP_AGENT_JWT_SECRET",
  "ASCII_TOKEN",
  "PAPERCLIP_PROVIDER_TRACE_PATH", "PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT", "GH_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_TOKEN", "NODE_OPTIONS", "NODE_PATH", "UNRECOGNIZED_FUTURE_SECRET",
  "PAPERCLIP_PI_FUTURE_SECRET", "OTEL_EXPORTER_OTLP_HEADERS",
].map(name => [name, `decoy-${name}`]));
const safe = { PATH: "/usr/bin:/bin", HOME: "/tmp/pi-home", TMPDIR: "/tmp", LANG: "C.UTF-8", LC_CTYPE: "C.UTF-8",
  TERM: "xterm", PI_CODING_AGENT_DIR: "/tmp/pi-agent", NODE_COMPILE_CACHE: "/tmp/pi-cache",
  PAPERCLIP_PI_BIND_SOCKET: "/tmp/bind.sock", PAPERCLIP_PI_BIND_INITIAL_FILE: "/tmp/initial.json",
  PAPERCLIP_PI_INSTRUCTIONS_FILE: "/tmp/instructions.md", PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY: "host-boundary",
  PAPERCLIP_AGENT_KEY_ID: "agent-identity-id", PAPERCLIP_AGENT_PUBLIC_KEY: "agent-public-decoy",
  PAPERCLIP_AGENT_PRIVATE_KEY: "agent-private-decoy",
  // Documented Langfuse export for Pi's observability plugin (org 11-13 00:45Z).
  LANGFUSE_BASE_URL: "https://langfuse.example", LANGFUSE_PUBLIC_KEY: "pk-decoy", LANGFUSE_SECRET_KEY: "sk-decoy",
  LANGFUSE_TRACING_ENABLED: "true", LANGFUSE_FLUSH_AT: "1" };

describe("native Pi environment ceilings", () => {
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
