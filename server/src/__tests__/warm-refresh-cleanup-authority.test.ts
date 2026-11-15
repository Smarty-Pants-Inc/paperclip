import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agentInstructionWorkingCopies } from "@paperclipai/db";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

// An absent OR failed authority record is a denial, not permission to use the
// pre-refresh recursive fallback. Exercise local and fresh-controller paths.
describe("default-deny directory cleanup authority", () => {
  it.each([
    { kind: "local", fault: "missing" }, { kind: "restart", fault: "missing" },
    { kind: "local", fault: "failed" }, { kind: "restart", fault: "failed" },
  ] as const)("keeps all files with $fault authority on $kind cleanup", async ({ kind, fault }) => {
    const f = await warmAgentFilesRefreshFixture();
    try {
      const remote = await f.prepare("session-a");
      const copy = kind === "local"
        ? (await f.copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId: await f.nextRun(), cwd: f.home, warm: true }))!
        : remote.copy;
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: copy.runId, target: kind === "restart" ? remote.target : undefined });
      const sentinel = path.join(copy.executionRoot, "KEEP.md");
      const localSentinel = path.join(copy.localRoot, "KEEP.md");
      await fs.writeFile(sentinel, "OWNER SENTINEL\n");
      await fs.writeFile(localSentinel, "OWNER SENTINEL\n");
      // A new service object alone still shares the module-level transport map.
      // Reload the module to exercise the actual no-cache restart branch.
      vi.resetModules();
      const { agentDirectoryWorkingCopyService } = await import("../services/agent-directory-working-copies.js");
      let attempted = false;
      if (fault === "failed") {
        const faulted = agentDirectoryWorkingCopyService(f.db, f.copies.get, async () => {
          attempted = true; throw Error("cleanup authority persistence failed");
        });
        expect(await faulted.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: copy.runId,
          target: kind === "restart" ? remote.target : undefined, canRefresh: async () => true })).toBe(false);
        expect(attempted).toBe(true);
      }
      const current = (await f.copies.get(f.companyId, copy.runId))!;
      const { refreshConfinedCleanup: _grant, localCleanupIdentity: _local, ...missing } = current.receipt!;
      const [stopped] = await f.db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date(),
        errorCode: "AGENT_FILES_REFRESH_INCOMPLETE", receipt: { ...(fault === "missing" ? missing : current.receipt), cleanupPending: true } })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId)).returning();
      const commands: string[] = [];
      const restarted = agentDirectoryWorkingCopyService(f.db, f.copies.get, async (row, values) => {
        const [updated] = await f.db.update(agentInstructionWorkingCopies).set(values)
          .where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
        return updated!;
      }, { execute: async (input: Parameters<EnvironmentRuntimeService["execute"]>[0]) => {
        commands.push(input.command);
        return remote.target.runner!.execute({ command: input.command, args: input.args, cwd: input.cwd, env: input.env, timeoutMs: input.timeoutMs });
      } } as EnvironmentRuntimeService);
      for (let i = 0; i < 2; i++) await restarted.release((await f.copies.get(f.companyId, stopped!.runId))!);
      expect(commands).toEqual([]);
      expect(await fs.readFile(sentinel, "utf8").catch(() => "MISSING")).toBe("OWNER SENTINEL\n");
      expect(await fs.readFile(localSentinel, "utf8").catch(() => "MISSING")).toBe("OWNER SENTINEL\n");
      expect(await f.copies.get(f.companyId, stopped!.runId)).toMatchObject({ receipt: { cleanupPending: true } });
      console.log(JSON.stringify({ case: "default-deny-cleanup", kind, fault, attempted, commands: commands.length, filesKept: true }));
    } finally { await f.cleanup(); }
  }, 90000);
});
