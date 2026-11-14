import { execFile } from "node:child_process";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

/** Controlled provider boundary: commands run in distinct fixture allocation roots. */
export function localSandboxCommandRunner(): CommandManagedRuntimeRunner {
  return { execute: input => new Promise((resolve, reject) => {
    const child = execFile(input.command, [...input.args ?? []], { cwd: input.cwd,
      env: { PATH: process.env.PATH, ...input.env }, timeout: input.timeoutMs ?? 30_000,
      maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ exitCode: typeof error?.code === "number" ? error.code : 0,
        signal: error?.signal ?? null, timedOut: !!error?.killed, stdout, stderr,
        pid: child.pid ?? null, startedAt: new Date().toISOString() });
    });
    child.stdin?.end(input.stdin);
  }) };
}
