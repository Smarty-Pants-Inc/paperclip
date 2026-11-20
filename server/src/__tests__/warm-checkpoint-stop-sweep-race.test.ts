import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import * as checkpointFiles from "../services/agent-file-checkpoints.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";

// Keep: the gate-2 Stop retention race (adopt-idlecp2). PostgreSQL rows, the
// warm checkpoint capture/save and the stopped-collection sweep are real.
// A Stop cancels the run row at once; its terminal projection wakes the sweep
// while the retained provider is (correctly) still alive, so the sweep marks
// the first-turn copy INSTRUCTION_STOP_UNCONFIRMED. When that lands while the
// ~2 s warm checkpoint is capturing, the checkpoint's verified save must still
// be recorded: retention reads `warm_saved && errorCode === null` (the
// heartbeat checkpointWarm wrapper) and otherwise refuses with
// instruction_checkpoint_failed.
describeEmbeddedPostgres("warm checkpoint vs stop-unconfirmed sweep", () => {
  const fixture = nativeRestartFixture();
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const waits: number[] = [];

  async function setup(label: string) {
    const f = await fixture.seedRun(label);
    const { companyId, agentId, paperclipHome } = fixture.current;
    const userId = randomUUID();
    await f.db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await f.db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]).onConflictDoNothing();
    await f.db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } }).onConflictDoNothing();
    await f.db.update(heartbeatRuns).set({ responsibleUserId: userId, completionContractId: null, completionContractSha256: null }).where(eq(heartbeatRuns.id, f.runId));
    const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Editor", adapterConfig: {} });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "before stop\n");
    await f.db.update(agents).set({ adapterConfig: { provider: "codex", instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" } }).where(eq(agents.id, agentId));
    const copies = agentInstructionWorkingCopyService(f.db);
    const copy = (await copies.prepare({ companyId, agentId, runId: f.runId, cwd: paperclipHome, warm: true }))!;
    expect(copy).toMatchObject({ state: "prepared", processStoppedAt: null });
    await fs.writeFile(path.join(copy.localRoot, "AGENTS.md"), "edited before Stop\n");
    // Stop acknowledged: the run row is cancelled before retention runs.
    await f.db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    return { f, copies, companyId, root };
  }

  // The sweep lands +0.5 s / +2 s / +3 s after the checkpoint starts; the
  // capture takes 3.5 s (gate 2 measured 1.8-2.7 s).
  it.each([500, 2_000, 3_000])("a sweep %i ms into the checkpoint does not void its verified save", async (sweepAfterMs) => {
    const { f, copies, companyId, root } = await setup(`ICP2-RACE-${sweepAfterMs}`);
    const captureFile = checkpointFiles.captureAgentFileCheckpoint;
    const capture = vi.spyOn(checkpointFiles, "captureAgentFileCheckpoint").mockImplementation(async input => {
      const result = await captureFile(input);
      await sleep(3_500);
      return result;
    });
    try {
      const started = Date.now();
      const checkpoint = copies.checkpointWarm({ companyId, runId: f.runId });
      await sleep(sweepAfterMs);
      expect(await copies.recoverStopped()).toBeGreaterThanOrEqual(1);
      // The sweep's marker really landed mid-checkpoint (the gate row's state).
      expect(await copies.get(companyId, f.runId)).toMatchObject({ state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED", processStoppedAt: null });
      const saved = await checkpoint;
      waits.push(Date.now() - started);
      // Exactly the retention predicate (heartbeat instruction-working-copy checkpointWarm).
      console.log(`ICP2 sweep+${sweepAfterMs}ms checkpoint result: ${JSON.stringify({ state: saved?.state, errorCode: saved?.errorCode, errorMessage: saved?.errorMessage })}`);
      expect(saved?.state === "warm_saved" && saved.errorCode === null).toBe(true);
      expect(saved).toMatchObject({ state: "warm_saved", errorCode: null, processStoppedAt: null, receipt: { checkpointState: "saved" } });
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("edited before Stop\n");
    } finally {
      capture.mockRestore();
    }
  }, 60_000);

  it("control: the clean path (no concurrent sweep) is unchanged", async () => {
    const { f, copies, companyId, root } = await setup("ICP2-CLEAN");
    const started = Date.now();
    const saved = await copies.checkpointWarm({ companyId, runId: f.runId });
    waits.push(Date.now() - started);
    expect(saved).toMatchObject({ state: "warm_saved", errorCode: null, receipt: { checkpointState: "saved" } });
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("edited before Stop\n");
  }, 60_000);

  it("control: a different concurrent stop-unconfirmed write (retirement unconfirmed) still refuses; no false checkpoint", async () => {
    const { f, copies, companyId } = await setup("ICP2-RETIRE");
    const captureFile = checkpointFiles.captureAgentFileCheckpoint;
    const capture = vi.spyOn(checkpointFiles, "captureAgentFileCheckpoint").mockImplementation(async input => {
      const result = await captureFile(input);
      await sleep(1_000);
      return result;
    });
    try {
      const checkpoint = copies.checkpointWarm({ companyId, runId: f.runId });
      await sleep(300);
      await copies.reportRetirementUnconfirmed(companyId, f.runId);
      const saved = await checkpoint;
      expect(saved?.state === "warm_saved" && saved.errorCode === null).toBe(false);
      expect(saved).toMatchObject({ state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED" });
    } finally {
      capture.mockRestore();
    }
  }, 60_000);

  it("control: a confirmed stop with a truly failing save refuses; no false checkpoint", async () => {
    const { f, copies, companyId } = await setup("ICP2-FAIL");
    const capture = vi.spyOn(checkpointFiles, "captureAgentFileCheckpoint").mockRejectedValue(new Error("capture failed"));
    try {
      const saved = await copies.checkpointWarm({ companyId, runId: f.runId });
      expect(saved?.state === "warm_saved" && saved.errorCode === null).toBe(false);
      expect(saved?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    } finally {
      capture.mockRestore();
    }
  }, 60_000);

  it("records the checkpoint wall time of the rows", () => {
    const sorted = [...waits].sort((a, b) => a - b);
    console.log(`ICP2 checkpoint wall ms: ${JSON.stringify(waits)} p50=${sorted[Math.floor(sorted.length / 2)]} max=${sorted.at(-1)}`);
  });
});
