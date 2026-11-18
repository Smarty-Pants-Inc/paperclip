import { afterEach, expect, it, vi } from "vitest";
import { createSanitizedAcpxSpawnInput } from "../drivers/acpx/environment.js";
import { createCapabilityRunnerdProviderEnvironment } from "./runnerd-codex-transport.js";

// Keep reason: controller -> runnerd credential/command-launcher trust boundary;
// regression reproduced by the native Pi launch dropping the managed projection.
const projection = {
  BASH_ENV: "/managed/.bashrc",
  ZDOTDIR: "/managed",
  GH_CONFIG_DIR: "/managed/gh",
  PAPERCLIP_GITHUB_LAUNCHER_DIR: "/managed",
  PAPERCLIP_GITHUB_BROKER_URL: "http://127.0.0.1:3210",
  PAPERCLIP_GITHUB_BROKER_TOKEN: "fixture-session-capability",
  PAPERCLIP_GITHUB_BRIDGE_TOKEN: "fixture-bridge-capability",
};
const credentialsAndIsolation = {
  GH_TOKEN: "host-secret", GITHUB_TOKEN: "host-secret", PAPERCLIP_GIT_TOKEN: "host-secret",
  GIT_CONFIG_GLOBAL: "/host/gitconfig", GIT_CONFIG_SYSTEM: "/host/system", GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/host/askpass", SSH_ASKPASS: "/host/askpass",
  GIT_SSH_COMMAND: "host-ssh", SSH_AUTH_SOCK: "/host/socket",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "host-helper",
  NODE_OPTIONS: "--require=/host/bootstrap.cjs", PAPERCLIP_API_KEY: "host-api-secret",
};
function launch(environment?: NodeJS.ProcessEnv) {
  return createCapabilityRunnerdProviderEnvironment({
    provider: "pi_rpc", options: { provider: "pi_rpc", environment },
    identity: { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1", normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1" },
    codexHome: "/isolated/home", runtimeContextPath: "/isolated/context.json", hasRuntimeContext: false,
  });
}
afterEach(() => vi.unstubAllEnvs());

it.each(Object.keys(projection) as Array<keyof typeof projection>)("preserves the exact managed Pi RPC launcher value for %s", name => {
  const source = { PATH: "/managed:/usr/bin", ...projection, ...credentialsAndIsolation };
  const environment = launch(source);
  expect(environment[name]).toBe(projection[name]);
  expect(environment[name]).toBe(createSanitizedAcpxSpawnInput(source, "claude").env[name]);
  expect(environment.PATH).toBe(source.PATH);
});

it.each([undefined, "", "  "])("does not admit managed Pi RPC selectors without a nonempty launcher (%s)", launcher => {
  const environment = launch({ ...projection, PAPERCLIP_GITHUB_LAUNCHER_DIR: launcher });
  for (const name of Object.keys(projection)) expect(environment).not.toHaveProperty(name);
});

it("does not inherit an ambient managed projection", () => {
  for (const [name, value] of Object.entries(projection)) vi.stubEnv(name, value);
  for (const name of Object.keys(projection)) expect(launch()).not.toHaveProperty(name);
});

it("keeps ACPX Pi unchanged and excludes raw credentials and ambient Git configuration just like Claude", () => {
  const source = { ...projection, ...credentialsAndIsolation };
  const pi = launch(source);
  const claude = createSanitizedAcpxSpawnInput(source, "claude").env;
  const acpxPi = createSanitizedAcpxSpawnInput(source, "pi").env;
  for (const name of Object.keys(projection)) expect(acpxPi).not.toHaveProperty(name);
  // Both paths rely on the same managed launcher to install per-operation Git
  // isolation/config pairs, not inherited host helpers or login credentials.
  for (const name of Object.keys(credentialsAndIsolation)) {
    expect(claude).not.toHaveProperty(name);
    expect(pi).not.toHaveProperty(name);
  }
  expect(source).toEqual({ ...projection, ...credentialsAndIsolation });
});
