import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agentInstructionWorkingCopies } from "@paperclipai/db";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

// The absence of an authority record must be a denial, not permission to use
// the pre-refresh recursive fallback. Exercise local and fresh-controller paths.
describe("default-deny directory cleanup authority", () => {
  it.each(["local", "restart"] as const)("keeps all files with missing/failed authority on %s cleanup", async kind => {
    const f = await warmAgentFilesRefreshFixture();
    try {
      const remote = await f.prepare("session-a");
      const copy = kind === "local"
        ? (await f.copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId: await f.nextRun(), cwd: f.home, warm: true }))!
        : remote.copy;
      const sentinel = path.join(copy.executionRoot, "KEEP.md");
      const localSentinel = path.join(copy.localRoot, "KEEP.md");
      await fs.writeFile(sentinel, "OWNER SENTINEL\n");
      await fs.writeFile(localSentinel, "OWNER SENTINEL\n");
      // This is the durable state left when an authority writer never committed.
      const { refreshConfinedCleanup: _grant, localCleanupIdentity: _local, ...receipt } = copy.receipt!;
      const [stopped] = await f.db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date(),
        errorCode: "AGENT_FILES_REFRESH_INCOMPLETE", receipt: { ...receipt, cleanupPending: true } })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId)).returning();
      const commands: string[] = [];
      // A new service object alone still shares the module-level transport map.
      // Reload the module to exercise the actual no-cache restart branch.
      vi.resetModules();
      const { agentDirectoryWorkingCopyService } = await import("../services/agent-directory-working-copies.js");
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
      console.log(JSON.stringify({ case: "default-deny-cleanup", kind, commands: commands.length, filesKept: true }));
    } finally { await f.cleanup(); }
  }, 90000);
});
