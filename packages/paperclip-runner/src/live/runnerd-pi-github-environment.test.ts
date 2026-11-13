import { afterEach, expect, it, vi } from "vitest";
import { createSanitizedAcpxSpawnInput } from "../drivers/acpx/environment.js";
import { spawnRunner } from "../control-plane/durable-prp-control-plane.js";
import { createCapabilityRunnerdProviderEnvironment } from "./runnerd-codex-transport.js";
import { piProcessEnvironment } from "../drivers/pi/pi-process-environment.js";

// Keep reason: controller -> runnerd credential/command-launcher trust boundary.
// These explicit values have already crossed nativePiGitHubEnvironment; agent
// configuration is stripped there, before the native transport is constructed.
const projection = {
  BASH_ENV: "/managed/.bashrc", ZDOTDIR: "/managed", GH_CONFIG_DIR: "/managed/gh",
  PAPERCLIP_GITHUB_LAUNCHER_DIR: "/managed",
  PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:3210",
  PAPERCLIP_GITHUB_BROKER_TOKEN: "fixture-session-capability",
  PAPERCLIP_GITHUB_BRIDGE_TOKEN: "fixture-bridge-capability",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -F /dev/null", SSH_AUTH_SOCK: "",
};
const credentials = { GH_TOKEN: "raw-gh", GITHUB_TOKEN: "raw-github", PAPERCLIP_GIT_TOKEN: "raw-internal" };
const identity = { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1", normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1" };
function launch(environment?: NodeJS.ProcessEnv) {
  return createCapabilityRunnerdProviderEnvironment({
    provider: "pi_rpc", options: { provider: "pi_rpc", environment }, identity,
    codexHome: "/isolated/home", runtimeContextPath: "/isolated/context.json", hasRuntimeContext: false,
  });
}
function runner(environment?: NodeJS.ProcessEnv) {
  let launched: NodeJS.ProcessEnv | undefined;
  spawnRunner({ connection: { mode: "connect", connectUrl: "ws://127.0.0.1:43127" }, stateDirectory: "/tmp/pi-github-projection-test", identity,
    ticket: "fake-ticket", maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: "0.3.0", runnerDigest: `sha256:${"a".repeat(64)}`, environment,
    processLauncher: spec => { launched = spec.environment; return { child: { pid: 42, exitCode: null, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" }) }; },
  });
  return launched!;
}
afterEach(() => vi.unstubAllEnvs());

it.each(Object.keys(projection) as Array<keyof typeof projection>)("carries this run's exact managed value for %s through both runnerd boundaries", name => {
  const source = { PATH: "/managed:/usr/bin", ...projection, ...credentials };
  const environment = runner(launch(source));
  expect(environment[name]).toBe(projection[name]);
  expect(environment.PATH).toBe(source.PATH);
  expect(piProcessEnvironment(environment, {})[name]).toBe(projection[name]);
});

it.each([undefined, "", "  "])("does not authorize managed selectors without a launcher (%s)", launcher => {
  const environment = launch({ ...projection, PAPERCLIP_GITHUB_LAUNCHER_DIR: launcher, PAPERCLIP_GITHUB_AUTH_MODE: "managed" });
  for (const name of Object.keys(projection)) expect(environment).not.toHaveProperty(name);
});

it("does not inherit an ambient managed projection at either runnerd boundary", () => {
  for (const [name, value] of Object.entries(projection)) vi.stubEnv(name, value);
  for (const environment of [launch(), runner(launch()), runner()]) {
    for (const name of Object.keys(projection)) expect(environment).not.toHaveProperty(name);
  }
});

it.each(Object.keys(projection))("validates the managed %s through the shared sanitizer", name => {
  expect(() => launch({ ...projection, [name]: "invalid\0value" })).toThrow(/null byte/);
  expect(() => launch({ ...projection, [name]: "x".repeat(65_537) })).toThrow(/bounded launch size/);
});

it("keeps ACPX Pi unchanged and excludes raw credentials from native Pi", () => {
  const source = { ...projection, ...credentials };
  const acpxPi = createSanitizedAcpxSpawnInput(source, "pi").env;
  for (const name of Object.keys(projection)) expect(acpxPi).not.toHaveProperty(name);
  for (const name of Object.keys(credentials)) {
    expect(launch(source)).not.toHaveProperty(name);
    expect(piProcessEnvironment(runner(launch(source)), {})).not.toHaveProperty(name);
  }
  expect(source).toEqual({ ...projection, ...credentials });
});
