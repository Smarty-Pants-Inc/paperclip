import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { remoteRunnerGenerationLost } from "./native-session-executor.js";

// Real shell + /proc corroboration of the fail-closed violation. The boot
// fingerprint is deliberately foreign, modeling a copied marker; this is NOT
// evidence of a real Boat migration or a second physical machine.
it.skipIf(process.platform !== "linux")("provider read failure cannot use a copied current-box marker as predecessor-death proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "rfl-provider-marker-"));
  const runnerInstanceId = randomUUID();
  const normalizedSessionId = randomUUID();
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", "--runner-id", runnerInstanceId], { stdio: "ignore" });
  const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
  const executions: number[] = [];
  const runner = { execute: async (request: { command: string; args?: string[] }) => {
    const result = spawnSync(request.command, request.args ?? [], { encoding: "utf8", timeout: 10000 });
    executions.push(result.status ?? -1);
    return { exitCode: result.status, signal: result.signal, timedOut: false, stdout: result.stdout, stderr: result.stderr };
  } } as unknown as CommandManagedRuntimeRunner;
  try {
    const stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[19];
    const directory = join(root, ".paperclip-runtime", "paperclip-runner", "sessions", createHash("sha256").update(normalizedSessionId).digest("hex"), "runner");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "runner-process.identity"), `judgeNonce\n${owner.pid}\n2026-11-13T10:00:00.000Z\n${runnerInstanceId}\nlinux:${randomUUID()}:${ticks}\n`);
    const lost = await remoteRunnerGenerationLost({ runner, remoteCwd: root, identity: { runnerInstanceId, normalizedSessionId }, predecessor: {
      start: { at: "2026-11-13T10:00:00.000Z", source: "process" }, providerLeaseId: "old-box", probedProviderLeaseId: "old-box",
      readSandbox: async () => { throw new Error("fresh predecessor provider read unavailable"); },
    } });
    console.log(JSON.stringify({ providerRead: "threw", shellExitCodes: executions, ownerStillAlive: owner.exitCode === null, decision: lost }));
    // Fail-closed: the failed provider read decides; the box is never probed.
    expect(executions).toEqual([]);
    expect(lost).toBe(false);
    // Control: without a predecessor read, the existing marker probe still runs and proves the changed generation.
    expect(await remoteRunnerGenerationLost({ runner, remoteCwd: root, identity: { runnerInstanceId, normalizedSessionId } })).toBe(true);
    expect(executions).toEqual([0, 47]);
  } finally {
    owner.kill("SIGKILL");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
