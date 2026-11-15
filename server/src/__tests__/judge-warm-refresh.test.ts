import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import { canRefreshNativeAgentFiles } from "../services/native-runtime/runtime-context.js";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";

describe("independent warm refresh safety", () => {
  it("rechecks handoff after a second other-session save requested during a paused refresh", async () => {
    const f = await warmAgentFilesRefreshFixture();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending: Promise<unknown>[] = [];
    let transfer: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const a = await f.prepare("session-a"), b = await f.prepare("session-b"), c = await f.prepare("session-c");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
      await fs.writeFile(path.join(b.copy.executionRoot, "FIRST.md"), "first peer save");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: b.copy.runId, target: b.target });
      await fs.writeFile(path.join(c.copy.executionRoot, "SECOND.md"), "second peer save");
      const original = executionTargetTools.prepareAdapterExecutionTargetRuntime;
      transfer = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementationOnce(async input => {
        entered(); await gate; return original(input);
      });
      const refresh = f.copies.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId, target: a.target,
        canRefresh: (canonicalRoot, entryFile) => canRefreshNativeAgentFiles({ runtimeContext: a.context, canonicalRoot, entryFile,
          runtimeConfig: f.runtimeConfig, runtimeSkillEntries: f.runtimeSkillEntries, adapterType: f.agent.adapterType }) });
      pending.push(refresh);
      await Promise.race([started, refresh.then(() => { throw new Error("refresh finished before transfer barrier"); })]);
      const save = f.copies.checkpointWarm({ companyId: f.companyId, runId: c.copy.runId, target: c.target });
      pending.push(save);
      resume();
      expect(await refresh).toBe(true);
      expect((await save)?.state).toBe("warm_saved");
      const runId = await f.nextRun();
      await expect(f.copies.prepare({ companyId: f.companyId, agentId: f.agentId, runId, cwd: f.home,
        target: a.target, warm: true, reuseRunId: a.copy.runId })).rejects.toThrow("changed before warm directory handoff");
      expect(await fs.readFile(path.join(f.root, "FIRST.md"), "utf8")).toBe("first peer save");
      expect(await fs.readFile(path.join(f.root, "SECOND.md"), "utf8")).toBe("second peer save");
    } finally { resume(); await Promise.allSettled(pending); transfer?.mockRestore(); await f.cleanup(); }
  }, 90000);
  it("rejects a change to a selected skill's supporting file, not only SKILL.md", async () => {
    const f = await warmAgentFilesRefreshFixture();
    try {
      const a = await f.prepare("session-a"), b = await f.prepare("session-b");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
      await fs.writeFile(path.join(b.copy.executionRoot, "skills/reviewer/support.txt"), "new selected skill content\n");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: b.copy.runId, target: b.target });
      const accepted = await f.copies.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId, target: a.target,
        canRefresh: (canonicalRoot, entryFile) => canRefreshNativeAgentFiles({ runtimeContext: a.context, canonicalRoot, entryFile,
          runtimeConfig: f.runtimeConfig, runtimeSkillEntries: f.runtimeSkillEntries, adapterType: f.agent.adapterType }) });
      expect(accepted).toBe(false);
    } finally { await f.cleanup(); }
  }, 90000);
  it.each(["NOTES.md", "AGENTS.md"])("does not overwrite unsaved live %s after a warm checkpoint", async file => {
    const f = await warmAgentFilesRefreshFixture();
    try {
      const a = await f.prepare("session-a"), b = await f.prepare("session-b");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
      await fs.writeFile(path.join(b.copy.executionRoot, "OTHER.md"), "other session save\n");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: b.copy.runId, target: b.target });
      await fs.writeFile(path.join(a.copy.executionRoot, file), "UNSAVED OWNER BYTES\n");
      const status = await f.copies.canReuseWarm(f.companyId, f.agentId, a.copy.runId);
      const accepted = await f.copies.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId, target: a.target,
        canRefresh: (canonicalRoot, entryFile) => canRefreshNativeAgentFiles({ runtimeContext: a.context, canonicalRoot, entryFile,
          runtimeConfig: f.runtimeConfig, runtimeSkillEntries: f.runtimeSkillEntries, adapterType: f.agent.adapterType }) });
      const after = await fs.readFile(path.join(a.copy.executionRoot, file), "utf8").catch(() => "MISSING");
      console.log(JSON.stringify({ case: "unsaved", file, status, accepted, after }));
      expect({ accepted, after }).toEqual({ accepted: false, after: "UNSAVED OWNER BYTES\n" });
    } finally { await f.cleanup(); }
  }, 90000);

  it("never overwrites the runner's Pi trace through a redirected live root", async () => {
    const f = await warmAgentFilesRefreshFixture();
    try {
      const a = await f.prepare("session-a"), b = await f.prepare("session-b");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
      await fs.writeFile(path.join(b.copy.executionRoot, "continuity.jsonl"), "ordinary canonical agent file\n");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: b.copy.runId, target: b.target });
      const pi = path.join(a.target.remoteCwd, ".paperclip-runtime", "paperclip-runner", "sessions", "owned-session", "pi");
      await fs.mkdir(pi, { recursive: true });
      await fs.writeFile(path.join(pi, "continuity.jsonl"), "ORIGINAL PI TRACE\n");
      await fs.rename(a.copy.executionRoot, a.copy.executionRoot + "-preserved");
      await fs.symlink(pi, a.copy.executionRoot, "dir");
      const accepted = await f.copies.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId, target: a.target,
        canRefresh: (canonicalRoot, entryFile) => canRefreshNativeAgentFiles({ runtimeContext: a.context, canonicalRoot, entryFile,
          runtimeConfig: f.runtimeConfig, runtimeSkillEntries: f.runtimeSkillEntries, adapterType: f.agent.adapterType }) });
      const trace = await fs.readFile(path.join(pi, "continuity.jsonl"), "utf8");
      console.log(JSON.stringify({ case: "trace-custody", accepted, trace }));
      expect(trace).toBe("ORIGINAL PI TRACE\n");
      expect(accepted).toBe(false);
    } finally { await f.cleanup(); }
  }, 90000);

  it("does not commit a partial failed refresh as owner edits during retirement collection", async () => {
    const f = await warmAgentFilesRefreshFixture();
    const transfer = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime");
    try {
      const a = await f.prepare("session-a"), b = await f.prepare("session-b");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
      await fs.writeFile(path.join(b.copy.executionRoot, "OTHER.md"), "other session save\n");
      await f.copies.checkpointWarm({ companyId: f.companyId, runId: b.copy.runId, target: b.target });
      const before = await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8");
      transfer.mockImplementationOnce(async () => {
        await fs.writeFile(path.join(a.copy.executionRoot, "AGENTS.md"), "# Load");
        throw new Error("injected transport interruption after partial extraction");
      });
      const accepted = await f.copies.refreshWarm({ companyId: f.companyId, agentId: f.agentId, runId: a.copy.runId, target: a.target,
        canRefresh: (canonicalRoot, entryFile) => canRefreshNativeAgentFiles({ runtimeContext: a.context, canonicalRoot, entryFile,
          runtimeConfig: f.runtimeConfig, runtimeSkillEntries: f.runtimeSkillEntries, adapterType: f.agent.adapterType }) });
      const failed = await f.copies.get(f.companyId, a.copy.runId);
      // This is the same stopped-copy collector invoked after warm owner retirement.
      const collected = await f.copies.collectStopped({ companyId: f.companyId, runId: a.copy.runId, target: a.target });
      const after = await fs.readFile(path.join(f.root, "AGENTS.md"), "utf8");
      console.log(JSON.stringify({ case: "partial-transfer", accepted, failedState: failed?.state, errorCode: failed?.errorCode,
        collectedState: collected?.state, before, after }));
      expect(accepted).toBe(false);
      expect(after).toBe(before);
      expect(failed?.state !== "warm_saved" || Boolean(failed?.errorCode)).toBe(true);
    } finally { transfer.mockRestore(); await f.cleanup(); }
  }, 90000);
});
