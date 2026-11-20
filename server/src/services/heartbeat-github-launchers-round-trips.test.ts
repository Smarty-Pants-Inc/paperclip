import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { expect, it } from "vitest";
import { prepareHeartbeatGitHubLaunchers } from "./heartbeat-github-launchers.js";

// Requested red-first regression for launcher-prep's Boat control-channel budget.
// The remote is a real shell/filesystem, not a mock of launcher preparation.
it("prepares heartbeat launchers in <=2 cold and <=1 warm serial round trips without a lease receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "heartbeat-launcher-round-trips-"));
  let total = 0, active = 0, serialDepth = 0, completedDepth = 0;
  const execute: CommandManagedRuntimeRunner["execute"] = async (input) => {
    total += 1;
    active += 1;
    const depth = completedDepth + 1;
    serialDepth = Math.max(serialDepth, depth);
    const startedAt = new Date().toISOString();
    try {
      const child = promisify(execFile)(input.command, input.args ?? [], {
        cwd: input.cwd ?? root,
        env: { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...input.env },
        timeout: input.timeoutMs ?? 15_000,
        maxBuffer: 1024 * 1024,
      });
      child.child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") throw error;
      });
      child.child.stdin?.end(input.stdin ?? "");
      const result = await child;
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
    } finally {
      active -= 1;
      completedDepth = Math.max(completedDepth, depth);
    }
  };
  const input = {
    native: true, githubConfigured: false, agentId: "agent-round-trips", runId: "cold",
    target: { kind: "remote" as const, transport: "sandbox" as const, providerKey: "boat-fixture",
      remoteCwd: root, runner: { execute, allowConcurrentSyncOperations: true } },
    cwd: "/controller-only/workspace", env: {}, brokerUrl: "https://unused.invalid",
    createBrokerToken: () => { throw new Error("Anonymous prep must not mint a capability"); },
  };
  try {
    const cold = await prepareHeartbeatGitHubLaunchers(input);
    const coldRow = { total, serialDepth };
    total = serialDepth = completedDepth = 0;
    const warm = await prepareHeartbeatGitHubLaunchers({ ...input, runId: "warm" });
    const warmRow = { total, serialDepth };
    console.info("HEARTBEAT_LAUNCHER_ROUND_TRIPS", JSON.stringify({ cold: coldRow, warm: warmRow }));
    expect(warm.env).toEqual(cold.env);
    expect(cold.cleanupLocation).toBeNull();
    expect(warm.cleanupLocation).toBeNull();
    expect(active).toBe(0);
    expect.soft(coldRow.total).toBeLessThanOrEqual(2);
    expect.soft(coldRow.serialDepth).toBeLessThanOrEqual(2);
    expect.soft(warmRow.total).toBeLessThanOrEqual(1);
    expect.soft(warmRow.serialDepth).toBeLessThanOrEqual(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
