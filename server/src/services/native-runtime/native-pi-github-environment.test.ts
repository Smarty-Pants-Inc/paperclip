// Keep reason: controller -> runnerd credential trust boundary, I-4 scrub gap.
import { describe, expect, it } from "vitest";
import { redactEnvForLogs } from "@paperclipai/adapter-utils/server-utils";
import { configuredEnvironment, configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";
import { nativePiGitHubEnvironment, PI_GITHUB_PROJECTION_KEYS } from "./native-pi-github-environment.js";

const configured = Object.fromEntries(PI_GITHUB_PROJECTION_KEYS.map(key => [key, `configured-${key}`]));

describe("native Pi GitHub projection authority", () => {
  it("redacts the run's broker capabilities in existing environment logs", () => {
    const result = nativePiGitHubEnvironment({}, { PAPERCLIP_GITHUB_BROKER_TOKEN: "run-capability-decoy", PAPERCLIP_GITHUB_BRIDGE_TOKEN: "bridge-capability-decoy" });
    expect(redactEnvForLogs(result as Record<string, string>))
      .toEqual({ PAPERCLIP_GITHUB_BROKER_TOKEN: "***REDACTED***", PAPERCLIP_GITHUB_BRIDGE_TOKEN: "***REDACTED***" });
  });
  it("keeps the configured-key manifest valid after removing SSH authority", () => {
    const input = configuredEnvironmentProjection({ SSH_AUTH_SOCK: "/configured/agent.sock", GIT_SSH_COMMAND: "ssh -i /configured/key", ORDINARY_SETTING: "kept" });
    const result = nativePiGitHubEnvironment({ ...input, UNLISTED_SETTING: "not-configured" });
    expect(configuredEnvironment(result)).toEqual(configuredEnvironmentProjection({ ORDINARY_SETTING: "kept" }));
  });
  it.each([undefined, "managed"])("strips all 15 configured names without a connection (auth mode %s)", authMode => {
    const input = { ...configured, PATH: "/configured/bin", PAPERCLIP_GITHUB_AUTH_MODE: authMode,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/work" };
    const result = nativePiGitHubEnvironment(input);
    for (const key of PI_GITHUB_PROJECTION_KEYS) expect(result).not.toHaveProperty(key);
    expect(result).toMatchObject({ PATH: "/configured/bin", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/work" });
    expect(input).toMatchObject(configured);
  });

  it("takes exactly this run's projection values, including empty values, over configured collisions", () => {
    const projection = Object.fromEntries(PI_GITHUB_PROJECTION_KEYS.map((key, index) => [key, index % 2 ? "" : `projection-${key}`]));
    const result = nativePiGitHubEnvironment(configured, { ...projection, PATH: "/managed/bin" });
    expect(result).toEqual({ ...projection, PATH: "/managed/bin" });
    const next = nativePiGitHubEnvironment(result, { BASH_ENV: "/next-run/bash-env" });
    expect(next).toEqual({ PATH: "/managed/bin", BASH_ENV: "/next-run/bash-env" });
    const disconnected = nativePiGitHubEnvironment(next);
    for (const key of PI_GITHUB_PROJECTION_KEYS) expect(disconnected).not.toHaveProperty(key);
  });
});
