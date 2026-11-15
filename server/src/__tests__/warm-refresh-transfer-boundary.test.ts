import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import { canRefreshNativeAgentFiles } from "../services/native-runtime/runtime-context.js";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";

async function advancedFixture() {
  const f = await warmAgentFilesRefreshFixture();
  const a = await f.prepare("session-a"), b = await f.prepare("session-b");
  await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
  await fs.writeFile(path.join(b.copy.executionRoot, "continuity.jsonl"), "canonical ordinary agent file\n");
  await f.copies.checkpointWarm({ companyId: f.companyId, runId: b.copy.runId, target: b.target });
  const refresh = () => f.copies.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId, target: a.target,
    canRefresh: (canonicalRoot, entryFile) => canRefreshNativeAgentFiles({ runtimeContext: a.context, canonicalRoot, entryFile,
      runtimeConfig: f.runtimeConfig, runtimeSkillEntries: f.runtimeSkillEntries, adapterType: f.agent.adapterType }) });
  return { f, a, refresh };
}

describe("warm refresh transfer boundary", () => {
  it("retires a dirty owner without refreshing, then saves its real edits normally", async () => {
    const { f, a, refresh } = await advancedFixture();
    try {
      await fs.writeFile(path.join(a.copy.executionRoot, "NOTES.md"), "unsaved daily work\n");
      expect(await refresh()).toBe(false);
      expect((await f.copies.get(f.companyId, a.copy.runId))?.state).toBe("warm_saved");
      expect((await f.copies.collectStopped({ companyId: f.companyId, runId: a.copy.runId, target: a.target }))?.state).toBe("saved");
      expect(await fs.readFile(path.join(f.root, "NOTES.md"), "utf8")).toBe("unsaved daily work\n");
      expect(await fs.readFile(path.join(f.root, "continuity.jsonl"), "utf8")).toBe("canonical ordinary agent file\n");
    } finally { await f.cleanup(); }
  }, 90_000);
  it("refuses a root redirected after observation but before remote upload, including collection", async () => {
    const { f, a, refresh } = await advancedFixture();
    const original = executionTargetTools.prepareAdapterExecutionTargetRuntime;
    const transfer = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime");
    try {
      const pi = path.join(a.target.remoteCwd, ".paperclip-runtime/paperclip-runner/sessions/owned-session/pi");
      await fs.mkdir(pi, { recursive: true }); await fs.writeFile(path.join(pi, "continuity.jsonl"), "ORIGINAL TRACE\n");
      transfer.mockImplementation(async input => {
        if (input.adapterKey === "agent-files" && input.workspaceRefreshGuard) {
          await fs.rename(a.copy.executionRoot, a.copy.executionRoot + "-preserved");
          await fs.symlink(pi, a.copy.executionRoot);
        }
        return original(input);
      });
      expect(await refresh()).toBe(false);
      expect((await f.copies.get(f.companyId, a.copy.runId))?.errorCode).toBe("AGENT_FILES_REFRESH_INCOMPLETE");
      expect(await fs.readFile(path.join(pi, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
      expect((await f.copies.collectStopped({ companyId: f.companyId, runId: a.copy.runId, target: a.target }))?.state).toBe("unavailable");
      expect(await fs.readFile(path.join(pi, "continuity.jsonl"), "utf8")).toBe("ORIGINAL TRACE\n");
    } finally { transfer.mockRestore(); await f.cleanup(); }
  }, 90_000);
  it("never publishes a real remote write interrupted after truncation and rename", async () => {
    const { f, a, refresh } = await advancedFixture();
    const runner = a.target.runner!;
    const execute = runner.execute;
    let interrupted = false;
    runner.execute = async input => {
      const args = [...(input.args ?? [])];
      if (args[1]?.includes("Descriptor-relative refresh unavailable")) {
        const original = args[1];
        args[1] = original.replace("fs.renameSync(temporary,filename);", 'fs.ftruncateSync(file,6);fs.renameSync(temporary,filename);throw Error("injected interrupted remote refresh");');
        expect(args[1]).not.toBe(original); interrupted = true;
      }
      return execute({ ...input, args });
    };
    try {
      const before = await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8");
      expect(await refresh()).toBe(false); expect(interrupted).toBe(true);
      expect(await fs.readFile(path.join(a.copy.executionRoot, "AGENTS.md"), "utf8")).toBe("# Load");
      const failed = await f.copies.get(f.companyId, a.copy.runId);
      expect(failed?.state).toBe("unavailable"); expect(failed?.errorCode).toBe("AGENT_FILES_REFRESH_INCOMPLETE");
      expect((await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target }))?.errorCode).toBe("AGENT_FILES_REFRESH_INCOMPLETE");
      expect((await f.copies.collectStopped({ companyId: f.companyId, runId: a.copy.runId, target: a.target }))?.state).toBe("unavailable");
      expect(await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8")).toBe(before);
    } finally { runner.execute = execute; await f.cleanup(); }
  }, 90_000);
});
