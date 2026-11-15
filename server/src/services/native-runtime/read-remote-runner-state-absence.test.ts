// D-B4 regression rows; author of the fix: code-lead.
// RFL condition (absence only): only a missing runner-state.json may report
// exit=66 timedOut=false. An existing unreadable file must retain a different
// exit; valid state must still parse. Transport timeout/exit/JSON classification
// controls live in runnerd-codex-transport-missing-runner-state.test.ts.
// Keep reason: recovery/data-safety boundary. Call the real reader and execute
// its actual sh/base64 command in a real mkdtemp directory, not a mocked result.
// Expected skip: chmod 000 cannot prove unreadability when running as root.
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { afterEach, expect, it } from "vitest";
import { readRemoteRunnerState } from "./native-session-executor.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "db4-read-remote-runner-state-"));
  roots.push(root);
  const runner: CommandManagedRuntimeRunner = {
    execute: async input => {
      const startedAt = new Date().toISOString();
      const result = spawnSync(input.command, input.args ?? [], {
        cwd: input.cwd ?? root, env: { ...process.env, ...input.env },
        input: input.stdin, encoding: "utf8", timeout: input.timeoutMs,
      });
      // Spawn/timeout failures are not fabricated shell exits. For a completed
      // sh process, pass through its actual status, signal, stdout and stderr.
      if (result.error) throw result.error;
      return {
        exitCode: result.status, signal: result.signal, timedOut: false,
        stdout: result.stdout, stderr: result.stderr, pid: result.pid, startedAt,
      };
    },
  };
  return { root, statePath: join(root, "runner-state.json"), input: { runner, stateDirectory: root } };
}

it("D-B4 gives a missing runner-state.json the dedicated absence exit 66", async () => {
  const f = await fixture();
  const failure = await readRemoteRunnerState(f.input).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/^runner_remote_state_unavailable: exit=66 timedOut=false(?:\s|$)/);
});

it.skipIf(process.getuid?.() === 0)("D-B4 keeps an unreadable existing runner-state.json distinct from absence", async () => {
  const f = await fixture();
  await writeFile(f.statePath, JSON.stringify({ lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, runId: "db4-prior-run" }));
  await chmod(f.statePath, 0o000);
  try {
    expect((await stat(f.statePath)).isFile()).toBe(true);
    expect((await stat(f.statePath)).mode & 0o777).toBe(0);
    const failure = await readRemoteRunnerState(f.input).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/^runner_remote_state_unavailable: exit=[1-9]\d* timedOut=false(?:\s|$)/);
    expect(message).not.toMatch(/^runner_remote_state_unavailable: exit=66 timedOut=false(?:\s|$)/);
  } finally {
    await chmod(f.statePath, 0o600);
  }
});

it("D-B4 parses an existing valid runner-state.json through the real shell reader", async () => {
  const f = await fixture();
  // Same valid retained-state shape as remote-workspaces.integration.test.ts.
  const state = { lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, runId: "db4-prior-run" };
  await writeFile(f.statePath, JSON.stringify(state));
  await expect(readRemoteRunnerState(f.input)).resolves.toEqual(state);
});
