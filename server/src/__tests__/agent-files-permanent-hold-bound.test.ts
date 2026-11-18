import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentInstructionWorkingCopies, authUsers, companies, companyMemberships, createDb,
  environmentLeases, environments, issues, principalPermissionGrants,
} from "@paperclipai/db";
import { directorySnapshotSha256, serializeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";
import { environmentRoutes } from "../routes/environments.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { agentFileSaveHeld } from "../services/agent-directory-working-copies.js";
import { agentFileCopiesToCollectOnLease, agentFileSaveHeldOnLease } from "../services/agent-file-save-hold.js";
import * as fileStoreModule from "../services/agent-file-store.js";
import * as holdModule from "../services/agent-file-save-hold.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { heartbeatService } from "../services/heartbeat.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: BRIEF held-save-bound rows R1-R6. Real producer: the real store
// refuses a run that deleted the configured entry (422), exactly as
// agent-files-held-save-person.test.ts does. Only the model adapter is a
// deterministic process boundary. R2 injects a transient (network) refusal in
// front of the real store; R3/R6 plant a lease binding beside the real hold
// (the local adapter has no sandbox), and R6 plants a mirror change/removal
// beside the real held bytes to prove the per-file gate.
// B0a rows (rf-3 caveat 1): "nothing to save" only when the last verified
// checkpoint is at/after the process stop, or the box is proven gone. Real-world
// mate of the planted R0a shape: platform-lead's live metadata-only read of Paul's
// run 035deeb8 (R1: /srv/scratch/paul/org-board/HELD-SAVE-PAUL-SMARTY-1118.txt):
// checkpointState unchanged, process stopped ~08:4x, refused LEASE-GONE, box RETAINED.
describe("held-save bound: a permanent 4xx hold stops retrying, frees its box, tells its owner once", () => {
  const adapterType = "held_save_bound_test";
  const originalHome = process.env.PAPERCLIP_HOME;
  const initial = "# Persistent instructions\n";
  const HOUR = 60 * 60_000;
  let home: string;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  const applyCalls = new Map<string, number>();
  const applyFailures: Array<{ agentId: string; status?: number; message: string }> = [];
  const transientAgentId = randomUUID();
  // B0: "Paused" changes files but its source read is refused with the Boat
  // plugin's LEASE-GONE message until its box is resumed; "Idle" changes nothing.
  const leaseGoneAgentId = randomUUID(), unchangedAgentId = randomUUID();
  const LEASE_GONE = "Boat sandbox lease is no longer active.";
  // Set by Paused's run after it wrote its files: its stopped source read is refused.
  let leaseGone = false;
  // B0a rows: Idle's real row is refused LEASE-GONE (box paused) while listed here.
  const refusedAgents = new Set<string>();
  let realInspect: typeof fileStoreModule.inspectAgentDirectory | undefined;
  const sourceReads = new Map<string, number>();
  let leaseGoneRunId = "", unchangedRunId = "";
  const companyId = randomUUID(), userId = randomUUID(), permanentAgentId = randomUUID();
  let permanentRunId = "", transientRunId = "", heldRoot = "";
  const runIdOf = new Map<string, string>();
  // The held candidate as the RUN wrote it (path -> sha256), recorded by the
  // adapter at stop time, independently of the server's own manifest.
  const candidate = new Map<string, string>();
  const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const listFiles = async (root: string, prefix = ""): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...await listFiles(root, relative));
      else if (entry.isFile()) out.push(relative);
    }
    return out;
  };

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "held-save-bound-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("held-save-bound-db-");
    db = createDb(database.connectionString);
    // B0 boundary: the collector's read of the stopped source (retrieve ->
    // inspectAgentDirectory) is refused while Paused's lease is gone.
    const inspect = fileStoreModule.inspectAgentDirectory;
    realInspect = inspect;
    vi.spyOn(fileStoreModule, "inspectAgentDirectory").mockImplementation(async (root, ...rest) => {
      for (const agentId of [leaseGoneAgentId, unchangedAgentId]) if (String(root).includes(agentId)) {
        sourceReads.set(agentId, (sourceReads.get(agentId) ?? 0) + 1);
        if (agentId === leaseGoneAgentId && leaseGone) throw new Error(LEASE_GONE);
        if (refusedAgents.has(agentId)) throw new Error(LEASE_GONE);
      }
      return inspect(root, ...rest);
    });
    const actual = fileStoreModule.agentFileStore;
    vi.spyOn(fileStoreModule, "agentFileStore").mockImplementation((...args) => {
      const store = actual(...args);
      const apply = store.apply.bind(store);
      store.apply = async (...input) => {
        const agentId = input[0].agentId;
        applyCalls.set(agentId, (applyCalls.get(agentId) ?? 0) + 1);
        try {
          // R2: a transient network refusal in front of the real store.
          if (agentId === transientAgentId) throw new Error("connect ECONNRESET (injected transient refusal)");
          return await apply(...input);
        } catch (error) {
          const failure = error as { status?: number; message: string };
          applyFailures.push({ agentId, status: failure.status, message: failure.message });
          throw error;
        }
      };
      return store;
    });
    heartbeat = heartbeatService(db);
    copies = agentInstructionWorkingCopyService(db);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false, supportsInstructionsBundle: true,
      execute: async input => {
        const entry = String(input.config.instructionsFilePath);
        if (input.agent.id === permanentAgentId) {
          // Genuine permanent 422: canonical AGENTS.md exists, this run deletes it.
          await fs.unlink(entry);
          await fs.writeFile(path.join(path.dirname(entry), "unsaved-note.txt"), "Keep these exact held bytes\n");
          await fs.mkdir(path.join(path.dirname(entry), "notes"), { recursive: true });
          await fs.writeFile(path.join(path.dirname(entry), "notes", "plan.md"), "# Plan\nSecond held file in a subfolder\n");
          for (const file of ["unsaved-note.txt", "notes/plan.md"]) candidate.set(file, sha256(await fs.readFile(path.join(path.dirname(entry), file))));
        } else if (input.agent.id === transientAgentId) {
          await fs.writeFile(path.join(path.dirname(entry), "transient-note.txt"), "Transient refusal bytes\n");
        } else if (input.agent.id === leaseGoneAgentId) {
          await fs.writeFile(path.join(path.dirname(entry), "paused-note.txt"), "Bytes written before the lease went away\n");
          leaseGone = true;
        }
        await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, String(input.context.issueId)));
        await input.onProviderStopped?.();
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: "done" } };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });

    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Held save bound", issuePrefix: `B${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [permanentAgentId, transientAgentId, leaseGoneAgentId, unchangedAgentId] } });
    let issueNumber = 0;
    for (const [agentId, name] of [[permanentAgentId, "Editor"], [transientAgentId, "Flaky"], [leaseGoneAgentId, "Paused"], [unchangedAgentId, "Idle"]] as const) {
      await db.insert(companyMemberships).values([
        ...(agentId === permanentAgentId ? [{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" }] : []),
        { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
      ]);
      const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name, adapterConfig: {} });
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "AGENTS.md"), initial);
      const cwd = await fs.mkdtemp(path.join(home, "workspace-"));
      await db.insert(agents).values({ id: agentId, companyId, name, adapterType, status: "idle",
        adapterConfig: { cwd, instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: `${name} run`, status: "todo",
        assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: ++issueNumber });
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId }, contextSnapshot: { issueId } });
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      runIdOf.set(agentId, run!.id);
      if (agentId === permanentAgentId) permanentRunId = run!.id;
      else if (agentId === transientAgentId) transientRunId = run!.id;
      else if (agentId === leaseGoneAgentId) leaseGoneRunId = run!.id;
      else unchangedRunId = run!.id;
    }
    expect(applyFailures).toContainEqual({ agentId: permanentAgentId, status: 422, message: "The configured instruction entry cannot be deleted" });
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    vi.restoreAllMocks();
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    if (home) {
      const writable = async (dir: string): Promise<void> => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await writable(path.join(dir, entry.name));
        }
      };
      await writable(home).catch(() => undefined);
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  const notices = async () => (await db.select().from(activityLog)
    .where(and(eq(activityLog.runId, permanentRunId), eq(activityLog.action, "agent_files.save_held_permanent"))));

  // Plants a held LEASE-GONE copy on Idle's REAL row: the last verified
  // checkpoint recorded unchanged (candidate == base, 0 copied files, no
  // conflicts) at checkpointAt (absent for rows written before it existed), the
  // process stopped at stoppedAt, and the stopped read was refused LEASE-GONE.
  // warm: false routes the stopped read through retrieve -> inspectAgentDirectory,
  // where the LEASE-GONE refusal is planted (the local adapter has no sandbox).
  const plantUnchangedLeaseGoneHold = async (input: { stoppedAt: Date; checkpointAt?: Date; patch?: Record<string, unknown>; receipt?: Record<string, unknown> }) => {
    const current = (await copies.get(companyId, unchangedRunId))!;
    const { savePending: _held, nothingToSave: _settled, checkpointAt: _at, ...receipt } = current.receipt ?? {};
    // A released row keeps no baseline; the held stopped copy's baseline is the
    // canonical folder it was prepared from (read without the planted refusal).
    const canonical = (await realInspect!(resolveManagedInstructionsRoot({ companyId, id: unchangedAgentId, name: "Idle", adapterConfig: {} }))).snapshot;
    const baseHash = directorySnapshotSha256(canonical);
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: input.stoppedAt,
      baseHash, candidateHash: baseHash, errorCode: "AGENT_FILES_SAVE_FAILED", nextAttemptAt: new Date(Date.now() - 1_000),
      ...input.patch,
      receipt: { ...receipt, baseline: serializeDirectorySnapshot(canonical), warm: false, checkpointState: "unchanged", conflicts: [], pendingConflicts: [],
        checkpointStats: { copiedFiles: 0, copiedBytes: 0 }, ...(input.checkpointAt ? { checkpointAt: input.checkpointAt.toISOString() } : {}),
        ...input.receipt,
        savePending: { since: input.stoppedAt.toISOString(), code: "AGENT_FILES_SAVE_FAILED", reason: LEASE_GONE, failures: 3 } } })
      .where(and(eq(agentInstructionWorkingCopies.companyId, companyId), eq(agentInstructionWorkingCopies.runId, unchangedRunId)));
    expect(agentFileSaveHeld(await copies.get(companyId, unchangedRunId))).toBe(true);
  };
  const sweep = async (hours: number[]) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try { for (const ahead of hours) { vi.setSystemTime(Date.now() + ahead * HOUR); await copies.recoverStopped(); } }
    finally { vi.useRealTimers(); }
  };

  it("R0a (supersedes R0a 'settles'): Paul's 035deeb8 shape, an unchanged checkpoint with NO recorded time and a RETAINED box refused LEASE-GONE, stays held under B0b: no timer, retried on resume", async () => {
    // Real producer: Idle's run changed nothing, and the real collector settled it unchanged.
    const real = (await copies.get(companyId, unchangedRunId))!;
    console.log("R0A_REAL", JSON.stringify({ runId: unchangedRunId, state: real.state, held: agentFileSaveHeld(real), nextAttemptAt: real.nextAttemptAt }));
    expect(real.state).toBe("unchanged");
    expect(agentFileSaveHeld(real)).toBe(false);
    // PLANTED beside it: Paul's live shape (run 035deeb8; R1 above): checkpointState
    // unchanged, process stopped, no checkpointAt, the box retained but its lease gone.
    refusedAgents.add(unchangedAgentId);
    const applyBefore = applyCalls.get(unchangedAgentId) ?? 0;
    try {
      await plantUnchangedLeaseGoneHold({ stoppedAt: new Date(Date.now() - 12 * HOUR) });
      await copies.collectStopped({ companyId, runId: unchangedRunId });
      const readsBefore = sourceReads.get(unchangedAgentId) ?? 0;
      await sweep([0, 7, 30]);
      const after = (await copies.get(companyId, unchangedRunId))!;
      console.log("R0A_PAUL_SHAPE", JSON.stringify({ state: after.state, held: agentFileSaveHeld(after), errorCode: after.errorCode,
        nextAttemptAt: after.nextAttemptAt, savePending: after.receipt?.savePending ?? null,
        timerReads: (sourceReads.get(unchangedAgentId) ?? 0) - readsBefore, applies: (applyCalls.get(unchangedAgentId) ?? 0) - applyBefore }));
      expect(agentFileSaveHeld(after)).toBe(true);
      expect(after.receipt?.savePending).toMatchObject({ reason: LEASE_GONE, retryOn: "lease_active" });
      expect(after.nextAttemptAt).toBeNull();
      expect((sourceReads.get(unchangedAgentId) ?? 0) - readsBefore).toBe(0);
      expect(after.receipt?.nothingToSave).toBeUndefined();
    } finally { refusedAgents.delete(unchangedAgentId); }
  }, 60_000);

  it("B0A-1: an edit made AFTER the last (unchanged) checkpoint, then LEASE-GONE, is STILL HELD, and saved on resume", async () => {
    const stoppedAt = new Date(Date.now() - 2 * HOUR);
    const row = (await copies.get(companyId, unchangedRunId))!;
    refusedAgents.add(unchangedAgentId);
    try {
      // The last verified checkpoint (unchanged) is 10 min BEFORE the process stop ...
      await plantUnchangedLeaseGoneHold({ stoppedAt, checkpointAt: new Date(stoppedAt.getTime() - 10 * 60_000) });
      // ... and the run edited a file after it, before the stop (the box keeps it:
      // the stopped tree as the run left it, i.e. the canonical files plus the edit).
      const canonical = resolveManagedInstructionsRoot({ companyId, id: unchangedAgentId, name: "Idle", adapterConfig: {} });
      await fs.mkdir(row.localRoot, { recursive: true });
      await fs.cp(canonical, row.localRoot, { recursive: true, force: true });
      await fs.writeFile(path.join(row.localRoot, "after-checkpoint.md"), "Edited after the last checkpoint\n");
      await copies.collectStopped({ companyId, runId: unchangedRunId });
      await sweep([0, 7, 30]);
      const held = (await copies.get(companyId, unchangedRunId))!;
      console.log("B0A_1_HELD", JSON.stringify({ state: held.state, held: agentFileSaveHeld(held), nextAttemptAt: held.nextAttemptAt,
        processStoppedAt: held.processStoppedAt, checkpointAt: held.receipt?.checkpointAt, savePending: held.receipt?.savePending ?? null,
        nothingToSave: held.receipt?.nothingToSave ?? null }));
      expect(agentFileSaveHeld(held)).toBe(true);
      expect(held.receipt?.savePending).toMatchObject({ reason: LEASE_GONE, retryOn: "lease_active" });
      expect(held.nextAttemptAt).toBeNull();
      expect(held.receipt?.nothingToSave).toBeUndefined();
      expect(await fs.readFile(path.join(held.localRoot, "after-checkpoint.md"), "utf8")).toBe("Edited after the last checkpoint\n");
    } finally { refusedAgents.delete(unchangedAgentId); }
    // Resume: the box's lease is active again (PLANTED lease row) -> retried, and the edit is saved.
    const [environment] = await db.insert(environments).values({ name: "Planted resumed Idle sandbox", driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
      heartbeatRunId: unchangedRunId, status: "active", leasePolicy: "reuse_by_environment", provider: "daytona",
      providerLeaseId: randomUUID(), metadata: { driver: "sandbox" } }).returning();
    const rearmed = await holdModule.rearmAgentFileHoldsOnLeaseActive(db, { id: lease!.id, companyId, providerLeaseId: lease!.providerLeaseId, heartbeatRunId: unchangedRunId });
    const rearmedRow = (await copies.get(companyId, unchangedRunId))!;
    const readsBeforeResume = sourceReads.get(unchangedAgentId) ?? 0;
    await copies.recoverStopped();
    const swept = (await copies.get(companyId, unchangedRunId))!;
    console.log("B0A_1_SWEPT", JSON.stringify({ rearmedNextAttemptAt: rearmedRow.nextAttemptAt, rearmedPending: rearmedRow.receipt?.savePending,
      state: swept.state, errorCode: swept.errorCode, errorMessage: swept.errorMessage, nextAttemptAt: swept.nextAttemptAt,
      savePending: swept.receipt?.savePending, reads: (sourceReads.get(unchangedAgentId) ?? 0) - readsBeforeResume }));
    const after = (await copies.get(companyId, unchangedRunId))!;
    const root = resolveManagedInstructionsRoot({ companyId, id: unchangedAgentId, name: "Idle", adapterConfig: {} });
    const saved = await fs.readFile(path.join(root, "after-checkpoint.md"), "utf8").catch(() => null);
    console.log("B0A_1_RESUMED", JSON.stringify({ rearmed, state: after.state, held: agentFileSaveHeld(after), saved }));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, lease!.id));
    expect(rearmed).toEqual([unchangedRunId]);
    expect(after.state).toBe("saved");
    expect(saved).toBe("Edited after the last checkpoint\n");
  }, 60_000);

  it("B0A-2: a final unchanged checkpoint AT/AFTER the process stop, then LEASE-GONE, settles as nothing to save, no retry", async () => {
    const stoppedAt = new Date(Date.now() - 2 * HOUR);
    refusedAgents.add(unchangedAgentId);
    const readsBefore = sourceReads.get(unchangedAgentId) ?? 0, applyBefore = applyCalls.get(unchangedAgentId) ?? 0;
    try {
      await plantUnchangedLeaseGoneHold({ stoppedAt, checkpointAt: new Date(stoppedAt.getTime() + 30_000) });
      await copies.collectStopped({ companyId, runId: unchangedRunId });
      await sweep([0, 7, 30]);
    } finally { refusedAgents.delete(unchangedAgentId); }
    const after = (await copies.get(companyId, unchangedRunId))!;
    console.log("B0A_2_SETTLED", JSON.stringify({ state: after.state, held: agentFileSaveHeld(after), nextAttemptAt: after.nextAttemptAt,
      processStoppedAt: after.processStoppedAt, checkpointAt: after.receipt?.checkpointAt, nothingToSave: after.receipt?.nothingToSave ?? null,
      sourceReads: (sourceReads.get(unchangedAgentId) ?? 0) - readsBefore, applies: (applyCalls.get(unchangedAgentId) ?? 0) - applyBefore }));
    expect(agentFileSaveHeld(after)).toBe(false);
    expect(after.state).toBe("unchanged");
    expect(after.receipt?.savePending).toBeUndefined();
    expect(after.receipt?.nothingToSave).toMatchObject({ reason: LEASE_GONE });
    expect(after.nextAttemptAt).toBeNull();
    expect((sourceReads.get(unchangedAgentId) ?? 0) - readsBefore).toBe(0);
    expect((applyCalls.get(unchangedAgentId) ?? 0) - applyBefore).toBe(0);
  }, 60_000);

  it("B0A-3: the box PROVEN gone (destroyed termination receipt) + an unchanged checkpoint before the stop settles as nothing to save", async () => {
    const stoppedAt = new Date(Date.now() - 2 * HOUR);
    // PLANTED: Idle's copy bound to a remote box whose lease carries a destroyed termination receipt.
    const [environment] = await db.insert(environments).values({ name: "Planted destroyed Idle sandbox", driver: "sandbox" }).returning();
    const providerLeaseId = randomUUID();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
      heartbeatRunId: unchangedRunId, status: "released", releasedAt: new Date(), cleanupStatus: "success", leasePolicy: "ephemeral",
      provider: "daytona", providerLeaseId, metadata: { driver: "sandbox" } }).returning();
    const receipt = remoteTerminationReceipt(lease!, { providerLeaseId, state: "destroyed" });
    await db.update(environmentLeases).set({ metadata: { driver: "sandbox", remoteExecutionTermination: receipt } }).where(eq(environmentLeases.id, lease!.id));
    const applyBefore = applyCalls.get(unchangedAgentId) ?? 0;
    await plantUnchangedLeaseGoneHold({ stoppedAt, checkpointAt: new Date(stoppedAt.getTime() - 10 * 60_000),
      patch: { location: `remote:${environment!.id}` }, receipt: { cleanup: { leaseId: lease!.id, remoteCwd: "/planted" } } });
    await copies.collectStopped({ companyId, runId: unchangedRunId });
    const after = (await copies.get(companyId, unchangedRunId))!;
    console.log("B0A_3_GONE", JSON.stringify({ leaseId: lease!.id, state: after.state, held: agentFileSaveHeld(after), errorMessage: after.errorMessage,
      nothingToSave: after.receipt?.nothingToSave ?? null, applies: (applyCalls.get(unchangedAgentId) ?? 0) - applyBefore }));
    expect(agentFileSaveHeld(after)).toBe(false);
    expect(after.receipt?.nothingToSave).toMatchObject({ reason: LEASE_GONE });
    expect(after.nextAttemptAt).toBeNull();
    expect((applyCalls.get(unchangedAgentId) ?? 0) - applyBefore).toBe(0);
  }, 60_000);

  it("R0a-REMOTE: Paul's 035deeb8 branch by line, an EXISTING legacy LEASE-GONE hold (no retryOn, no checkpointAt) on a RETAINED remote box whose lease is not active is parked under B0b: no timer", async () => {
    const stoppedAt = new Date(Date.now() - 13 * HOUR);
    // PLANTED: Idle's copy bound to a retained (not destroyed) remote box whose lease is no longer active.
    const [environment] = await db.insert(environments).values({ name: "Planted retained paused sandbox", driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
      heartbeatRunId: unchangedRunId, status: "expired", leasePolicy: "ephemeral", provider: "daytona",
      providerLeaseId: randomUUID(), metadata: { driver: "sandbox" } }).returning();
    await plantUnchangedLeaseGoneHold({ stoppedAt, patch: { location: `remote:${environment!.id}` },
      receipt: { warm: true, cleanup: { leaseId: lease!.id, remoteCwd: "/planted" } } });
    const before = (await copies.get(companyId, unchangedRunId))!;
    await copies.collectStopped({ companyId, runId: unchangedRunId });
    await sweep([0, 7, 30]);
    const after = (await copies.get(companyId, unchangedRunId))!;
    console.log("R0A_REMOTE_PAUL_BRANCH", JSON.stringify({ leaseStatus: lease!.status, checkpointAt: after.receipt?.checkpointAt ?? null,
      processStoppedAt: after.processStoppedAt, beforeNextAttemptAt: before.nextAttemptAt, state: after.state, held: agentFileSaveHeld(after),
      nextAttemptAt: after.nextAttemptAt, savePending: after.receipt?.savePending ?? null, nothingToSave: after.receipt?.nothingToSave ?? null }));
    expect(agentFileSaveHeld(after)).toBe(true);
    expect(after.receipt?.savePending).toMatchObject({ reason: LEASE_GONE, retryOn: "lease_active" });
    expect(after.nextAttemptAt).toBeNull();
    expect(after.receipt?.nothingToSave).toBeUndefined();
  }, 60_000);

  it("R0b: a CHANGED copy refused with LEASE-GONE stays held, stops time-polling, and is retried when its lease is active again", async () => {
    const held = (await copies.get(companyId, leaseGoneRunId))!;
    const pending = held.receipt?.savePending as Record<string, unknown> | undefined;
    console.log("R0B_HOLD", JSON.stringify({ runId: leaseGoneRunId, state: held.state, nextAttemptAt: held.nextAttemptAt, savePending: pending }));
    expect(agentFileSaveHeld(held)).toBe(true);
    expect(pending).toMatchObject({ reason: LEASE_GONE, retryOn: "lease_active" });
    expect(pending?.permanent).toBeUndefined();
    expect(held.nextAttemptAt).toBeNull();
    // No timer retry: sweeps at any age never read the source again.
    const readsBefore = sourceReads.get(leaseGoneAgentId) ?? 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const ahead of [0, 1, 7, 30]) { vi.setSystemTime(Date.now() + ahead * HOUR); await copies.recoverStopped(); }
    } finally { vi.useRealTimers(); }
    const parked = (await copies.get(companyId, leaseGoneRunId))!;
    const timerReads = (sourceReads.get(leaseGoneAgentId) ?? 0) - readsBefore;
    console.log("R0B_NO_TIMER", JSON.stringify({ timerReads, held: agentFileSaveHeld(parked), nextAttemptAt: parked.nextAttemptAt }));
    expect(timerReads).toBe(0);
    expect(agentFileSaveHeld(parked)).toBe(true);
    // Resume: the box's lease is active again (PLANTED lease row: the local adapter has no sandbox).
    const [environment] = await db.insert(environments).values({ name: "Planted resumed sandbox", driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
      heartbeatRunId: leaseGoneRunId, status: "active", leasePolicy: "reuse_by_environment", provider: "daytona",
      providerLeaseId: randomUUID(), metadata: { driver: "sandbox" } }).returning();
    leaseGone = false;
    const rearm = (holdModule as unknown as Record<string, unknown>).rearmAgentFileHoldsOnLeaseActive as
      undefined | ((db: unknown, lease: unknown) => Promise<string[]>);
    expect(typeof rearm).toBe("function");
    const rearmed = await rearm!(db, { id: lease!.id, companyId, providerLeaseId: lease!.providerLeaseId, heartbeatRunId: leaseGoneRunId });
    await copies.recoverStopped();
    const after = (await copies.get(companyId, leaseGoneRunId))!;
    console.log("R0B_RESUMED", JSON.stringify({ rearmed, state: after.state, held: agentFileSaveHeld(after),
      resumeReads: (sourceReads.get(leaseGoneAgentId) ?? 0) - readsBefore - timerReads }));
    expect(rearmed).toEqual([leaseGoneRunId]);
    expect(after.state).toBe("saved");
    expect(agentFileSaveHeld(after)).toBe(false);
  }, 60_000);

  it("R1: a permanent 422 hold is marked permanent and schedules no further retry", async () => {
    const held = (await copies.get(companyId, permanentRunId))!;
    console.log("R1_HOLD", JSON.stringify({ runId: permanentRunId, state: held.state, errorCode: held.errorCode,
      nextAttemptAt: held.nextAttemptAt, savePending: held.receipt?.savePending }));
    expect(agentFileSaveHeld(held)).toBe(true);
    expect(held.receipt?.savePending).toMatchObject({ code: "AGENT_FILES_SAVE_FAILED", reason: "The configured instruction entry cannot be deleted",
      permanent: true, permanentStatus: 422 });
    expect(held.nextAttemptAt).toBeNull();
    expect(held.errorMessage).toContain(`/api/companies/${companyId}/agent-file-holds/${permanentRunId}/discard`);
    const before = applyCalls.get(permanentAgentId) ?? 0;
    // Every sweep, at any age (well past the 6 h retry cap), retries nothing.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const ahead of [0, 1, 7, 30]) {
        vi.setSystemTime(Date.now() + ahead * HOUR);
        await copies.recoverStopped();
      }
      await copies.collectStopped({ companyId, runId: permanentRunId });
    } finally { vi.useRealTimers(); }
    console.log("R1_RETRIES", JSON.stringify({ applyBefore: before, applyAfter: applyCalls.get(permanentAgentId) }));
    expect(applyCalls.get(permanentAgentId) ?? 0).toBe(before);
    const after = (await copies.get(companyId, permanentRunId))!;
    expect(agentFileSaveHeld(after)).toBe(true);
    expect(after.nextAttemptAt).toBeNull();
  }, 60_000);

  it("R2 (control): a transient refusal still holds with a scheduled retry and is retried", async () => {
    const held = (await copies.get(companyId, transientRunId))!;
    console.log("R2_HOLD", JSON.stringify({ runId: transientRunId, state: held.state, nextAttemptAt: held.nextAttemptAt, savePending: held.receipt?.savePending }));
    expect(agentFileSaveHeld(held)).toBe(true);
    expect((held.receipt?.savePending as { permanent?: unknown }).permanent).toBeUndefined();
    expect(held.nextAttemptAt).toBeInstanceOf(Date);
    const before = applyCalls.get(transientAgentId) ?? 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(held.nextAttemptAt!.getTime() + 1_000);
      await copies.recoverStopped();
    } finally { vi.useRealTimers(); }
    console.log("R2_RETRIES", JSON.stringify({ applyBefore: before, applyAfter: applyCalls.get(transientAgentId) }));
    expect(applyCalls.get(transientAgentId) ?? 0).toBeGreaterThan(before);
    const after = (await copies.get(companyId, transientRunId))!;
    expect(agentFileSaveHeld(after)).toBe(true);
    expect(after.nextAttemptAt).toBeInstanceOf(Date);
  }, 60_000);

  it("R4: exactly one owner notice names the agent, the reason and the discard route; a second sweep posts none", async () => {
    const first = await notices();
    console.log("R4_NOTICE", JSON.stringify(first.map(row => ({ id: row.id, actorType: row.actorType, entityId: row.entityId, details: row.details }))));
    expect(first).toHaveLength(1);
    const discardRoute = `POST /api/companies/${companyId}/agent-file-holds/${permanentRunId}/discard`;
    expect(first[0]).toMatchObject({ entityType: "agent", entityId: permanentAgentId, agentId: permanentAgentId });
    expect(first[0]!.details).toMatchObject({ agentName: "Editor", ownerUserId: userId, discardRoute, status: 422,
      reason: "The configured instruction entry cannot be deleted" });
    expect(String((first[0]!.details as { message?: unknown }).message)).toContain(discardRoute);
    // Second (and third) sweep: retirement collection and the recovery worker.
    await copies.collectStopped({ companyId, runId: permanentRunId });
    await copies.recoverStopped();
    await copies.collectStopped({ companyId, runId: permanentRunId });
    const again = await notices();
    console.log("R4_AFTER_SWEEPS", JSON.stringify({ notices: again.length }));
    expect(again).toHaveLength(1);
  }, 60_000);

  it("R4b (B3 person-visible): the owner reads the notice exactly once through the real GET activity route their agent page uses", async () => {
    // ui/src/pages/AgentDetail.tsx:1429 -> activityApi.list (ui/src/api/activity.ts:87)
    // -> GET /api/companies/:companyId/activity?agentId= (server/src/routes/activity.ts:231).
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false }; next(); });
    app.use("/api", activityRoutes(db)); app.use(errorHandler);
    const route = `/api/companies/${companyId}/activity?agentId=${permanentAgentId}`;
    const read = await request(app).get(route);
    const seen = (read.body as Array<{ action?: string; runId?: string; details?: { message?: string; discardRoute?: string } }>)
      .filter(row => row.action === "agent_files.save_held_permanent");
    console.log("R4B_GET", JSON.stringify({ route: `GET ${route}`, status: read.status, notices: seen.length, rows: seen.map(row => ({ id: (row as { id?: string }).id, runId: row.runId, agentId: (row as { agentId?: string }).agentId, agentName: (row.details as { agentName?: string } | undefined)?.agentName, status: (row.details as { status?: number } | undefined)?.status })), message: seen.find(row => row.runId === permanentRunId)?.details?.message }));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    // One notice per held run: this hold's notice is on the person's screen exactly once
    // (any other permanent hold of the same agent carries its own single notice).
    const mine = seen.filter(row => row.runId === permanentRunId);
    expect(mine).toHaveLength(1);
    expect(new Set(seen.map(row => row.runId)).size).toBe(seen.length);
    expect(mine[0]!.details?.message).toContain(`POST /api/companies/${companyId}/agent-file-holds/${permanentRunId}/discard`);
  }, 60_000);

  it("R3: after the bound the box is no longer blocked from destroy and the held bytes stay readable through the hold", async () => {
    let held = (await copies.get(companyId, permanentRunId))!;
    heldRoot = held.localRoot;
    // PLANTED beside the real hold: bind the real 422 hold to a sandbox lease
    // (the local adapter has none) so the destroy gate can be observed.
    const [environment] = await db.insert(environments).values({ name: "Planted sandbox", driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id,
      heartbeatRunId: permanentRunId, status: "active", leasePolicy: "ephemeral", provider: "daytona",
      providerLeaseId: randomUUID(), metadata: { driver: "sandbox" } }).returning();
    await db.update(agentInstructionWorkingCopies).set({ receipt: { ...held.receipt, cleanup: { leaseId: lease!.id, remoteCwd: "/planted" } } })
      .where(and(eq(agentInstructionWorkingCopies.companyId, companyId), eq(agentInstructionWorkingCopies.runId, permanentRunId)));
    held = (await copies.get(companyId, permanentRunId))!;
    const leaseRef = { id: lease!.id, companyId, providerLeaseId: lease!.providerLeaseId, heartbeatRunId: permanentRunId };
    const blockedNow = await agentFileSaveHeldOnLease(db, leaseRef);
    vi.useFakeTimers({ toFake: ["Date"] });
    let blockedAfter: boolean, toCollectAfter: string[];
    try {
      vi.setSystemTime(Date.now() + 25 * HOUR);
      blockedAfter = await agentFileSaveHeldOnLease(db, leaseRef);
      toCollectAfter = await agentFileCopiesToCollectOnLease(db, leaseRef);
    } finally { vi.useRealTimers(); }
    const mirrorHash = (held.receipt?.savePending as { mirrorHash?: unknown }).mirrorHash;
    const readable = directorySnapshotSha256((await fileStoreModule.inspectAgentDirectory(heldRoot)).snapshot);
    const bytes = await fs.readFile(path.join(heldRoot, "unsaved-note.txt"), "utf8");
    const after = (await copies.get(companyId, permanentRunId))!;
    console.log("R3_BOUND", JSON.stringify({ leaseId: lease!.id, blockedNow, blockedAfter, toCollectAfter, mirrorHash, readable, bytes, heldAfter: agentFileSaveHeld(after) }));
    expect(blockedNow).toBe(true);
    expect(blockedAfter).toBe(false);
    expect(toCollectAfter).not.toContain(permanentRunId);
    expect(agentFileSaveHeld(after)).toBe(true);
    expect(mirrorHash).toBe(readable);
    expect(bytes).toBe("Keep these exact held bytes\n");
  }, 60_000);

  it("R6: every held file is byte-equal in the durable mirror (path + sha256) before destroy; a missing or changed file keeps destroy blocked and the hold says so", async () => {
    const held = (await copies.get(companyId, permanentRunId))!;
    const leaseId = (held.receipt?.cleanup as { leaseId: string }).leaseId;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const leaseRef = { id: lease!.id, companyId, providerLeaseId: lease!.providerLeaseId, heartbeatRunId: permanentRunId };
    const manifest = (held.receipt?.savePending as { heldFiles?: Array<{ path: string; sha256: string }> }).heldFiles ?? [];
    // Every held candidate file vs its stored (mirror) copy, path + sha256.
    const rows = await Promise.all([...candidate].map(async ([file, hash]) => ({ path: file, candidate: hash,
      manifest: manifest.find(item => item.path === file)?.sha256 ?? null,
      stored: await fs.readFile(path.join(held.localRoot, file)).then(sha256, () => null) })));
    console.log("R6_FILES", JSON.stringify({ mirror: held.localRoot, rows, manifestPaths: manifest.map(item => item.path) }));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) { expect(row.manifest, row.path).toBe(row.candidate); expect(row.stored, row.path).toBe(row.candidate); }
    // The server manifest names exactly the files the mirror holds (deleted entry absent).
    expect(manifest.map(item => item.path).sort()).toEqual((await listFiles(held.localRoot)).filter(file => !file.startsWith(".paperclip-runtime/")).sort());
    expect(manifest.map(item => item.path)).not.toContain("AGENTS.md");
    const gate = async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try { vi.setSystemTime(Date.now() + 25 * HOUR); return await agentFileSaveHeldOnLease(db, leaseRef); }
      finally { vi.useRealTimers(); }
    };
    const durableCheck = async () => ((await copies.get(companyId, permanentRunId))!.receipt?.savePending as { durableCheck?: Record<string, unknown> }).durableCheck;
    const notePath = path.join(held.localRoot, "unsaved-note.txt");
    const original = await fs.readFile(notePath);
    // PLANTED: one stored byte changes. Destroy stays blocked; the hold says which file.
    await fs.writeFile(notePath, "Keep these exact held byteZ\n");
    const blockedChanged = await gate();
    const checkChanged = await durableCheck();
    await fs.writeFile(notePath, original);
    // PLANTED: one stored file goes missing. Destroy stays blocked; the hold says which file.
    const planPath = path.join(held.localRoot, "notes", "plan.md");
    const plan = await fs.readFile(planPath);
    await fs.rm(planPath);
    const blockedMissing = await gate();
    const checkMissing = await durableCheck();
    await fs.writeFile(planPath, plan);
    // Restored to the held bytes: every file matches, destroy is allowed.
    const allowed = !await gate();
    const checkOk = await durableCheck();
    console.log("R6_GATE", JSON.stringify({ blockedChanged, checkChanged, blockedMissing, checkMissing, allowed, checkOk }));
    expect(blockedChanged).toBe(true);
    expect(checkChanged).toMatchObject({ durable: false, changed: ["unsaved-note.txt"], missing: [] });
    expect(blockedMissing).toBe(true);
    expect(checkMissing).toMatchObject({ durable: false, changed: [], missing: ["notes/plan.md"] });
    expect(allowed).toBe(true);
    expect(checkOk).toMatchObject({ durable: true, changed: [], missing: [] });
    expect(agentFileSaveHeld(await copies.get(companyId, permanentRunId))).toBe(true);
  }, 60_000);

  it("R5: the operator discard still works after the bound", async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: true }; next(); });
    app.use("/api", environmentRoutes(db)); app.use(errorHandler);
    const discardPath = `/api/companies/${companyId}/agent-file-holds/${permanentRunId}/discard`;
    vi.useFakeTimers({ toFake: ["Date"] });
    let discard: request.Response;
    try {
      vi.setSystemTime(Date.now() + 25 * HOUR);
      discard = await request(app).post(discardPath).send({ reason: "Permanent 422 past the bound; owner accepts losing it" });
    } finally { vi.useRealTimers(); }
    console.log("R5_DISCARD", JSON.stringify({ route: `POST ${discardPath}`, status: discard.status, body: { state: discard.body.state, errorCode: discard.body.errorCode } }));
    expect(discard.status, JSON.stringify(discard.body)).toBe(200);
    expect(discard.body).toMatchObject({ state: "resolved", errorCode: "AGENT_FILES_SAVE_DISCARDED" });
    expect(agentFileSaveHeld(await copies.get(companyId, permanentRunId))).toBe(false);
    const log = await db.select().from(activityLog).where(eq(activityLog.runId, permanentRunId));
    expect(log.find(row => row.action === "agent_files.save_discarded")).toMatchObject({ actorType: "user", actorId: userId });
    expect(await notices()).toHaveLength(1);
  }, 60_000);
});
