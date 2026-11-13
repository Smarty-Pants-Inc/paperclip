import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RUNNER_LAUNCH_ENVIRONMENT_SCRIPT } from "./runner-launch-environment.js";

// Trust boundary: emulate Boat injecting credentials after Core's env projection.
it("removes every ASCII_* machine variable before runner exec and keeps agent settings", () => {
  const script = RUNNER_LAUNCH_ENVIRONMENT_SCRIPT + 'exec "$@"';
  const observed = JSON.parse(execFileSync("/bin/sh", ["-c", script, "runner-env", process.execPath,
    "-e", "process.stdout.write(JSON.stringify(process.env))"], { encoding: "utf8", env: {
    PATH: process.env.PATH, ASCII_TOKEN: "decoy-machine-token", ASCII_API_KEY: "decoy-machine-api",
    ASCII_FUTURE_SECRET: "decoy-future", LANGFUSE_SECRET_KEY: "agent-export-decoy", NO_PROXY: "localhost",
    PAPERCLIP_AGENT_PRIVATE_KEY: "agent-identity-decoy", NON_ASCII_SETTING: "keep",
  } }));
  expect(Object.keys(observed).filter(key => key.startsWith("ASCII_"))).toEqual([]);
  expect(observed).toMatchObject({ LANGFUSE_SECRET_KEY: "agent-export-decoy", NO_PROXY: "localhost",
    PAPERCLIP_AGENT_PRIVATE_KEY: "agent-identity-decoy", NON_ASCII_SETTING: "keep" });
  if (process.env.PI_TEST_RUNNER_LAUNCH_SCRIPT) writeFileSync(process.env.PI_TEST_RUNNER_LAUNCH_SCRIPT, script);
});

it("fails closed when the required launch sanitizer runtime is unavailable", () => {
  expect(() => execFileSync("/bin/sh", ["-c", RUNNER_LAUNCH_ENVIRONMENT_SCRIPT + 'exec "$@"', "runner-env", "/bin/true"], {
    stdio: "pipe", env: { PATH: "/nonexistent-runner-node", ASCII_TOKEN: "decoy" },
  })).toThrow();
});
