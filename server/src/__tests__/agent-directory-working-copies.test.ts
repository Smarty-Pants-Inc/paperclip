import { gitExclusionRetryContract } from "./helpers/git-exclusion-retry-contract.js";
import { queueGitExclusionNextTry } from "./helpers/git-exclusion-next-try.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createHeartbeatInstructionWorkingCopy } from "../services/heartbeat/instruction-working-copy.js";
import * as fileStoreModule from "../services/agent-file-store.js";
import * as fileCheckpoints from "../services/agent-file-checkpoints.js";
import * as instructionAuthorization from "../services/agent-instruction-authorization.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDirectoryCleanup } from "../services/directory-cleanup-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";
import * as ssh from "@paperclipai/adapter-utils/ssh";
const execFile = promisify(execFileCallback);
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { spawn } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { agentFileStore, fileHash, inspectAgentFile, inspectAgentDirectory, snapshotAgentFiles, MAX_AGENT_FILE_BYTES, MAX_AGENT_DIRECTORY_BYTES, MAX_AGENT_DIRECTORY_ENTRIES } from "../services/agent-file-store.js";
import { activityLog, agents, companies, issues, authUsers, companyMemberships, principalPermissionGrants, heartbeatRuns, environmentLeases, environments, agentInstructionWorkingCopies, agentInstructionRevisions, agentInstructionHeads, createDb, fileStorageDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService, instructionWorkingCopyGuidance } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { buildNativeRuntimeContext } from "../services/native-runtime/runtime-context.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildNativeModelEnvelope } from "../vendor/paperclip-runner/index.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { createReusableLeaseHandoff } from "../services/environment-lease-handoff.js";
import { AGENT_FILES_SAVE_PENDING_INSTRUCTION, AgentDirectoryReuseInvalidatedError, agentDirectoryWorkingCopyService, agentFileSaveHeld, applyWarmNotesProgram } from "../services/agent-directory-working-copies.js";
import { agentFileSaveHeldOnLease } from "../services/agent-file-save-hold.js";
import { collectStoppedInstructionCopyWithRetries } from "../services/agent-instruction-working-copies.js";
import { HttpError } from "../errors.js";
import { withDirectoryMergeLock, directorySnapshotSha256 } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { heartbeatRunEvents } from "@paperclipai/db";
import { agentFileRoots } from "@paperclipai/db";
import * as storageModule from "../storage/index.js";
import { Readable } from "node:stream";
import { logger } from "../middleware/logger.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_DIRECTORY_TEST_DATABASE_URL");

describe("persistent agent directories", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  let revisions: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\uFEFF# Original\r\n☃\n";
  const target = () => ({ companyId, agentId });
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  async function run(options: { warm?: boolean; reuseRunId?: string } = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return (await copies.prepare({ ...target(), runId, cwd: home, ...options }))!;
  }
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-working-copies-")));
    process.env.PAPERCLIP_HOME = home;
    if (!external) database = await startEmbeddedPostgresTestDatabase("instruction-copies-db-");
    db = createDb(external ?? database.connectionString);
    copies = agentInstructionWorkingCopyService(db);
    revisions = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) {
      const writable = async (dir: string) => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      };
      await writable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
  });

  gitExclusionRetryContract(async (runId, executionTarget) => {
    if (!(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).length) {
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    }
    return copies.prepare({ companyId, agentId, runId, cwd: home, target: executionTarget });
  }, async () => {
    // Retire fixture-only remote owners before the unscoped cleanup-worker tests.
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), nextAttemptAt: null,
      receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } }).where(eq(agentInstructionWorkingCopies.companyId, companyId));
  }, (runId, error) => queueGitExclusionNextTry(db, companyId, agentId, userId, runId, error));

  describe("post-save directory cleanup worker", () => {
    afterEach(async () => {
      vi.useRealTimers(); vi.restoreAllMocks();
      await db.update(agentInstructionWorkingCopies).set({ receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } })
        .where(eq(agentInstructionWorkingCopies.companyId, companyId));
    });
    const clock = () => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const coordinator = (canRun = () => true, canReconcile = () => true, onError = (_error: unknown) => {}) =>
      createDeliveryWorkCoordinator({ owner: db, canRun, canReconcile, onError });
    async function stopped(copy: NonNullable<Awaited<ReturnType<typeof copies.get>>>, dueAt = new Date(), owner = db) {
      await owner.transaction(async tx => {
        await notifyDirectoryCleanup(tx, { companyId: copy.companyId, runId: copy.runId });
        await tx.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), nextAttemptAt: dueAt })
          .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      });
    }
    async function released(runId: string) {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect((await copies.get(companyId, runId))?.receipt?.cleanupPending).toBe(false);
      }, { timeout: 5000 });
    }
    it("leaves active, transferred, and completed receipts quiet even with retained baselines", async () => {
      const active = await run(), completed = await run(), transferred = await run();
      await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(),
        receipt: { ...completed.receipt, cleanupPending: false } }).where(eq(agentInstructionWorkingCopies.runId, completed.runId));
      await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(),
        receipt: { ...transferred.receipt, retainedByRunId: active.runId } }).where(eq(agentInstructionWorkingCopies.runId, transferred.runId));
      clock(); const worker = coordinator();
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select"), removes = vi.spyOn(fs, "rm");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(removes).not.toHaveBeenCalled();
        expect(worker.nextWakeAt()).toBeNull();
        for (const copy of [active, completed, transferred]) expect((await fs.stat(copy.localRoot)).isDirectory()).toBe(true);
      } finally { await worker.stop(); }
    });
    it("retires a stale retry on an already cleaned receipt after restart without filesystem work", async () => {
      const copy = await run();
      await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date(),
        nextAttemptAt: new Date(), receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      clock(); const worker = coordinator(), removes = vi.spyOn(fs, "rm");
      try {
        await agentInstructionWorkingCopyService(db).registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(100);
          expect((await copies.get(companyId, copy.runId))?.nextAttemptAt).toBeNull();
        });
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(removes).not.toHaveBeenCalled();
        expect(worker.nextWakeAt()).toBeNull();
        expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
      } finally { await worker.stop(); }
    });
    it("honors a cleanup obligation published before stale-deadline settlement", async () => {
      const copy = await run(), dueAt = new Date(Date.now() + 30_000);
      await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date(),
        nextAttemptAt: dueAt, receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      const transact = db.transaction.bind(db);
      const race = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
        await db.update(agentInstructionWorkingCopies).set({ receipt: { ...copy.receipt, cleanupPending: true } })
          .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
        return transact(callback, config);
      });
      try {
        await copies.release(companyId, copy.runId);
        expect(await copies.get(companyId, copy.runId)).toMatchObject({ receipt: { cleanupPending: false }, nextAttemptAt: null });
        await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
      } finally { race.mockRestore(); }
    });
    it("reactivates from real collection, preserves saved files, retries failed cleanup, and becomes quiet", async () => {
      const copy = await run(); await fs.writeFile(path.join(copy.localRoot, "memory.txt"), "saved memory");
      clock(); const worker = coordinator();
      const remove = fs.rm.bind(fs);
      let failing = true;
      const removes = vi.spyOn(fs, "rm").mockImplementation(async (file, opts) => {
        if (failing && file === path.dirname(copy.localRoot)) throw new Error("temporary cleanup failure");
        return remove(file, opts);
      });
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(100);
          expect((await copies.get(companyId, copy.runId))?.nextAttemptAt).toBeInstanceOf(Date);
        });
        const pending = (await copies.get(companyId, copy.runId))!;
        expect(pending.receipt?.cleanupPending).toBe(true);
        expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe("saved memory");
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(worker.nextWakeAt()).toBe(pending.nextAttemptAt!.getTime());
        failing = false;
        await vi.advanceTimersByTimeAsync(30_000); await released(copy.runId);
        await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await vi.advanceTimersByTimeAsync(1000); await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select"); removes.mockClear();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled(); expect(removes).not.toHaveBeenCalled();
        expect(worker.nextWakeAt()).toBeNull();
      } finally { removes.mockRestore(); await worker.stop(); }
    });
    it.each(["restart", "drain", "standby"] as const)("preserves cleanup across %s", async mode => {
      const copy = await run();
      if (mode === "restart") await stopped(copy);
      let admitted = mode === "restart";
      clock(); const worker = coordinator(() => admitted, () => mode !== "standby");
      try {
        await agentInstructionWorkingCopyService(db).registerDirectoryCleanupWork(worker, () => admitted, async () => true).ready;
        if (mode !== "restart") {
          await stopped(copy); await vi.advanceTimersByTimeAsync(1000);
          if (mode === "drain") await expect.poll(() => idleWorkSnapshot().active).toBe(0);
          const reads = vi.spyOn(db, "select");
          await vi.advanceTimersByTimeAsync(60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
          expect((await fs.stat(copy.localRoot)).isDirectory()).toBe(true);
          admitted = true; await vi.advanceTimersByTimeAsync(30_000);
        }
        await released(copy.runId);
        await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await worker.stop(); }
    });
    it("retains a future cleanup deadline across restart without early file operations", async () => {
      const copy = await run(); clock(); const due = new Date(Date.now() + 90_000);
      await stopped(copy, due); const worker = coordinator();
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        expect(worker.nextWakeAt()).toBe(due.getTime());
        const removes = vi.spyOn(fs, "rm"); await vi.advanceTimersByTimeAsync(60_000);
        expect(removes).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000); await released(copy.runId);
      } finally { await worker.stop(); }
    });
    it("honors outer rollback and only releases after the outer commit", async () => {
      const copy = await run(); clock(); const worker = coordinator();
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        await expect(db.transaction(async tx => {
          await stopped(copy, new Date(), tx as unknown as typeof db);
          await vi.advanceTimersByTimeAsync(1000);
          expect((await fs.stat(copy.localRoot)).isDirectory()).toBe(true);
          throw new Error("rollback cleanup");
        })).rejects.toThrow("rollback cleanup");
        await vi.advanceTimersByTimeAsync(1000);
        expect((await copies.get(companyId, copy.runId))?.state).toBe("prepared");
        await db.transaction(async tx => {
          await stopped(copy, new Date(), tx as unknown as typeof db);
          await vi.advanceTimersByTimeAsync(1000);
          expect((await fs.stat(copy.localRoot)).isDirectory()).toBe(true);
        });
        await released(copy.runId);
      } finally { await worker.stop(); }
    });
    it("joins destructive cleanup on shutdown and restores quiet after restart", async () => {
      const copy = await run(); await stopped(copy); clock(); const worker = coordinator();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entry = new Promise<void>(resolve => { entered = resolve; });
      const remove = fs.rm.bind(fs);
      const removes = vi.spyOn(fs, "rm").mockImplementation(async (file, opts) => {
        if (file === path.dirname(copy.localRoot)) { entered(); await gate; }
        return remove(file, opts);
      });
      let stopping: Promise<void> | undefined;
      try {
        const registration = copies.registerDirectoryCleanupWork(worker, () => true, async () => true);
        await entry; let finished = false;
        stopping = worker.stop().then(() => { finished = true; });
        await vi.advanceTimersByTimeAsync(1000); expect(finished).toBe(false);
        release(); await stopping; await registration.ready;
        expect((await copies.get(companyId, copy.runId))?.receipt?.cleanupPending).toBe(false);
        const restarted = coordinator();
        try {
          await copies.registerDirectoryCleanupWork(restarted, () => true, async () => true).ready;
          expect(restarted.nextWakeAt()).toBeNull();
        } finally { await restarted.stop(); }
      } finally { release(); removes.mockRestore(); await stopping; await worker.stop(); }
    });
    it("drains more than one discovery page in bounded execution batches", async () => {
      const rows = [];
      for (let index = 0; index < 103; index++) rows.push(await run());
      for (const copy of rows) await stopped(copy);
      clock(); const worker = coordinator();
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        const first = await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.companyId, companyId));
        expect(first.filter(row => row.receipt?.cleanupPending === false)).toHaveLength(20);
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          const all = await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.companyId, companyId));
          expect(all.every(row => row.receipt?.cleanupPending === false)).toBe(true);
        }, { timeout: 10_000 });
        for (const row of rows) await expect(fs.stat(row.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await worker.stop(); }
    }, 30_000);
    it("honors a newer deadline committed before the cleanup claim", async () => {
      const copy = await run(); await stopped(copy); clock(); const worker = coordinator();
      const later = new Date(Date.now() + 60_000), transaction = db.transaction.bind(db);
      let changed = false;
      const transactions = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => {
        if (!changed) {
          changed = true;
          await transaction(async tx => {
            await notifyDirectoryCleanup(tx, { companyId, runId: copy.runId });
            await tx.update(agentInstructionWorkingCopies).set({ nextAttemptAt: later })
              .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
          });
        }
        return transaction(callback, options);
      }) as typeof db.transaction);
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        transactions.mockRestore();
        expect(changed).toBe(true);
        expect((await fs.stat(copy.localRoot)).isDirectory()).toBe(true);
        expect((await copies.get(companyId, copy.runId))?.nextAttemptAt).toEqual(later);
        await vi.advanceTimersByTimeAsync(1000); await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(worker.nextWakeAt()).toBe(later.getTime());
        await vi.advanceTimersByTimeAsync(60_000); await released(copy.runId);
      } finally { transactions.mockRestore(); await worker.stop(); }
    });
    it("backs off a failed reservation without losing cleanup or blocking another owner", async () => {
      const first = await run(), second = await run();
      clock(); await stopped(first, new Date(Date.now() - 1000)); await stopped(second);
      const errors: unknown[] = [], worker = coordinator(() => true, () => true, error => errors.push(error));
      const transaction = vi.spyOn(db, "transaction").mockImplementationOnce(async () => { throw new Error("cleanup reservation unavailable"); });
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        transaction.mockRestore();
        expect(errors).toHaveLength(1);
        expect((await fs.stat(first.localRoot)).isDirectory()).toBe(true);
        expect((await copies.get(companyId, second.runId))?.receipt?.cleanupPending).toBe(false);
        await vi.advanceTimersByTimeAsync(1000); await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(15_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        await vi.advanceTimersByTimeAsync(30_000); await released(first.runId);
      } finally { transaction.mockRestore(); await worker.stop(); }
    });
    it("shares the directory lock with foreground collection and deletes only once", async () => {
      const copy = await run(); await fs.writeFile(path.join(copy.localRoot, "memory.txt"), "last save");
      clock(); const worker = coordinator();
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entry = new Promise<void>(resolve => { entered = resolve; });
      const remove = fs.rm.bind(fs); let removals = 0;
      const removes = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (file === path.dirname(copy.localRoot)) { removals += 1; entered(); await gate; }
        return remove(file, options);
      });
      let foreground: ReturnType<typeof copies.collectStopped> | undefined;
      try {
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        foreground = copies.collectStopped({ companyId, runId: copy.runId });
        await entry;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(100);
          expect((await copies.get(companyId, copy.runId))?.nextAttemptAt).toBeInstanceOf(Date);
        });
        release(); await foreground; await released(copy.runId);
        await vi.advanceTimersByTimeAsync(1000); await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(removals).toBe(1);
        expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe("last save");
        expect(worker.nextWakeAt()).toBeNull();
      } finally { release(); await foreground; removes.mockRestore(); await worker.stop(); }
    });
    it("keeps a cleanup pending without an error while another server holds the agent directory lock", async () => {
      const copy = await run();
      await db.update(agentInstructionWorkingCopies).set({ location: `remote:${randomUUID()}` })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      await stopped(copy, new Date(Date.now() - 1000));
      vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
      const held = await db.$client.reserve();
      const lockKey = `agent-directory:${companyId}:${agentId}`;
      await held`select pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
      const errors: unknown[] = [], worker = coordinator(() => true, () => true, error => errors.push(error));
      try {
        const before = Date.now();
        await copies.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(errors).toEqual([]);
        const pending = (await copies.get(companyId, copy.runId))!;
        expect(pending.receipt?.cleanupPending).not.toBe(false);
        expect(pending.nextAttemptAt!.getTime()).toBeGreaterThan(before);
      } finally {
        await worker.stop();
        await held`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
        held.release();
        vi.unstubAllEnvs();
      }
    });
    it("reactivates from the real worktree setting without polling disabled policy", async () => {
      const copy = await run(); await stopped(copy);
      const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "sleep41-directory-activation" };
      const settings = instanceSettingsService(db, { runtimeEnv });
      await settings.updateExperimental({ enableWorktreeRunExecution: false });
      const service = heartbeatService(db, { runtimeEnv });
      clock(); const worker = coordinator();
      try {
        await service.registerInstructionDirectoryCleanupWork(worker, () => true).ready;
        expect(worker.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(60_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        await service.resolveSchedulingSuppression();
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await released(copy.runId);
      } finally { await worker.stop(); await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    });
    it("retains unknown remote cleanup without acquiring a replacement environment", async () => {
      const copy = await run();
      await db.update(agentInstructionWorkingCopies).set({ location: `remote:${randomUUID()}` })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      await stopped(copy); clock(); const worker = coordinator();
      const execute = vi.fn();
      const service = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
      try {
        await service.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
        const pending = (await copies.get(companyId, copy.runId))!;
        expect(pending.receipt?.cleanupPending).toBe(true); expect(pending.nextAttemptAt).toBeInstanceOf(Date);
        expect(execute).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        await expect.poll(async () => (await copies.get(companyId, copy.runId))!.nextAttemptAt!.getTime()).toBeGreaterThan(pending.nextAttemptAt!.getTime());
        expect(execute).not.toHaveBeenCalled();
      } finally { await worker.stop(); }
    });
  });

  describe("warm directory ownership", () => {
    async function nextRun() {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      return runId;
    }
    describe("Paul's managed bundle: notes do not retire a warm chat (notes-digest)", () => {
      const instructionFiles = ["AGENTS.md", "RULES.md", "DECISIONS.md", "PREFERENCES.md", "MODELS.md", "LANDSCAPE.md"];
      const note = "memory/2026-11-17-playful-handover-sma612.md";
      async function paulBundle() {
        // Exact mode: managed, entry AGENTS.md, top-level instruction files + memory/** archive/** templates/** work/**.
        await db.update(agents).set({ adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" } })
          .where(eq(agents.id, agentId));
        await fs.rm(path.join(root, "policy"), { recursive: true, force: true });
        for (const name of instructionFiles) await fs.writeFile(path.join(root, name), `# ${name}\n`);
        await fs.writeFile(path.join(root, "DECISIONS.md"), "# Decisions\nDECISION-FACT: the blue kettle is retired.\n");
        for (const [name, body] of [["memory/README.md", "notes\n"], ["memory/2026-11-16-old.md", "old note\n"], ["archive/README.md", "archive\n"],
          ["templates/project-lead.md", "template\n"], ["work/sma408_check.py", "print(1)\n"]]) {
          await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
          await fs.writeFile(path.join(root, name), body);
        }
      }
      async function siblingSaves(relative: string, body: string) {
        const sibling = await run();
        await fs.mkdir(path.dirname(path.join(sibling.localRoot, relative)), { recursive: true });
        await fs.writeFile(path.join(sibling.localRoot, relative), body);
        expect((await copies.collectStopped({ companyId, runId: sibling.runId }))?.state).toBe("saved");
        expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(body);
      }
      async function onDisk(dir: string) {
        const out: string[] = [];
        const walk = async (rel: string) => {
          for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
            const next = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(next); else out.push(next);
          }
        };
        await walk("");
        return out.sort();
      }

      it("keeps chat A warm on its SAME directory after a sibling saves a memory note; a NEW chat sees the note and DECISIONS", async () => {
        await paulBundle();
        const chatA = await run({ warm: true });
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId }))?.state).toBe("warm_saved");
        const before = await onDisk(root);
        await siblingSaves(note, "NOTE-FACT: Kate takes the SMA-612 handover.\n");

        // Warm chat A: its FIRST next turn reuses the same materialization (no retirement, no fresh restore).
        expect(await copies.canReuseWarm(companyId, agentId, chatA.runId)).toBe(true);
        const turn2 = await run({ warm: true, reuseRunId: chatA.runId });
        expect(turn2.localRoot).toBe(chatA.localRoot);
        expect(turn2.executionRoot).toBe(chatA.executionRoot);
        expect(await copies.get(companyId, chatA.runId)).toMatchObject({ state: "superseded", receipt: { successorRunId: turn2.runId } });
        // The runner's 'instructions' for the warm turn are unchanged (no refresh_required).
        const contextFor = async (copy: typeof chatA) => buildNativeRuntimeContext({ db, agent: { id: agentId, companyId, name: "Target",
          adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" } },
          runId: copy.runId, runtimeConfig: {}, runtimeSkillEntries: [], instructionWorkingCopy: { rootPath: copy.executionRoot, entryPath: "AGENTS.md", kind: "agent_files" } });
        const [contextA, context2] = [await contextFor(chatA), await contextFor(turn2)];
        expect(context2.instructions).toEqual(contextA.instructions);
        expect(context2.aggregateDigest).toBe(contextA.aggregateDigest);
        // ...and still sees the sibling's note on disk.
        expect(await fs.readFile(path.join(turn2.localRoot, note), "utf8")).toBe("NOTE-FACT: Kate takes the SMA-612 handover.\n");

        // A NEW chat started after the note restores the whole folder: the note and DECISIONS.md facts.
        const chatB = await run({ warm: true });
        expect(chatB.localRoot).not.toBe(chatA.localRoot);
        expect(await fs.readFile(path.join(chatB.localRoot, note), "utf8")).toContain("NOTE-FACT");
        expect(await fs.readFile(path.join(chatB.localRoot, "DECISIONS.md"), "utf8")).toContain("DECISION-FACT");
        expect(await onDisk(chatB.localRoot)).toEqual([...before, note].sort());

        // Never-OK: chat A's own later save keeps every note (nothing dropped or moved).
        await fs.writeFile(path.join(turn2.localRoot, "memory/2026-11-17-chat-a.md"), "chat A note\n");
        expect((await copies.checkpointWarm({ companyId, runId: turn2.runId }))?.state).toBe("warm_saved");
        await copies.collectStopped({ companyId, runId: turn2.runId });
        await copies.collectStopped({ companyId, runId: chatB.runId });
        expect(await onDisk(root)).toEqual([...before, note, "memory/2026-11-17-chat-a.md"].sort());
        expect(await fs.readFile(path.join(root, note), "utf8")).toContain("NOTE-FACT");
      }, 20_000);

      it.each(["AGENTS.md", "DECISIONS.md"])("still retires the warm chat when a sibling edits %s", async edited => {
        await paulBundle();
        const chatA = await run({ warm: true });
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId }))?.state).toBe("warm_saved");
        await siblingSaves(edited, `# ${edited} edited\n`);
        expect(await copies.canReuseWarm(companyId, agentId, chatA.runId)).toBe(false);
        const runId = await nextRun();
        await expect(copies.prepare({ ...target(), runId, cwd: home, warm: true, reuseRunId: chatA.runId }))
          .rejects.toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
        await copies.collectStopped({ companyId, runId: chatA.runId });
        const fresh = (await copies.prepare({ ...target(), runId, cwd: home, warm: true }))!;
        expect(fresh.localRoot).not.toBe(chatA.localRoot);
        expect(await fs.readFile(path.join(fresh.localRoot, edited), "utf8")).toBe(`# ${edited} edited\n`);
      }, 20_000);

      it("adopts a retained session after a sibling note without retirement; the note is on disk", async () => {
        await paulBundle();
        const first = await run();
        expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
        await siblingSaves(note, "NOTE-FACT adopt\n");
        const secondId = await nextRun();
        const second = await copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home });
        expect(second).toMatchObject({ runId: secondId, localRoot: first.localRoot });
        expect(second?.receipt?.retirementRequired).toBeUndefined();
        expect(await fs.readFile(path.join(first.localRoot, note), "utf8")).toBe("NOTE-FACT adopt\n");
        expect(await copies.hasChanges({ companyId, runId: secondId })).toBe(false);
        await copies.collectStopped({ companyId, runId: secondId });
        expect(await fs.readFile(path.join(root, note), "utf8")).toBe("NOTE-FACT adopt\n");
        await copies.release(companyId, first.runId);
      }, 20_000);

      it("adoption still refuses a retained session after a DECISIONS.md edit", async () => {
        await paulBundle();
        const first = await run();
        expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
        await siblingSaves("DECISIONS.md", "# changed\n");
        const secondId = await nextRun();
        expect(await copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home })).toBeNull();
        await copies.collectStopped({ companyId, runId: first.runId });
      }, 20_000);

      // Paul's REAL shape: the chat runs on a REMOTE sandbox (Boat). AGENT_HOME is
      // the remote executionRoot and is written into the runner's instruction text,
      // so a fresh restore into a new per-run root forces native_runner_refresh_required.
      async function sandbox() {
        const remoteCwd = await fs.mkdtemp(path.join(home, "boat-sandbox-"));
        const runner: import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner = {
          execute: async input => {
            const startedAt = new Date().toISOString();
            const env = { ...process.env, ...input.env };
            const args = [...(input.args ?? [])];
            if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
              env.PAPERCLIP_TEST_STDIN = input.stdin;
              args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
            }
            try {
              const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
              return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
            } catch (error) {
              const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
              return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
            }
          },
        };
        const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), leaseId: "", remoteCwd, runner };
        await db.insert(environments).values({ id: executionTarget.environmentId, name: `Boat sandbox ${executionTarget.environmentId}`, driver: "sandbox" });
        // The parked chat on the box: a runnerd stand-in with ONE idle provider
        // child, journalled in the runner's real process-lineage layout
        // (runner-core process_lineage/journal.rs). backgroundChild() adds a
        // live tool/background job under runnerd.
        const runnerStateDirectory = path.join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "sessions", createHash("sha256").update(randomUUID()).digest("hex"), "runner");
        await fs.mkdir(path.join(runnerStateDirectory, "process-lineage"), { recursive: true });
        const started = async (pid: number) => { const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]); };
        const runnerd = spawn(process.execPath, ["-e", `const { spawn } = require("node:child_process");
          const children = [];
          const start = () => { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); children.push(child); process.stdout.write(child.pid + "\\n"); };
          process.stdin.on("data", () => start()); process.on("SIGTERM", () => { for (const child of children) child.kill("SIGKILL"); process.exit(0); }); start();`], { stdio: ["pipe", "pipe", "inherit"] });
        const childPids: number[] = [];
        let waiting: ((pid: number) => void) | null = null;
        runnerd.stdout!.setEncoding("utf8").on("data", (chunk: string) => { for (const line of chunk.split("\n").filter(Boolean)) { childPids.push(Number(line)); waiting?.(Number(line)); } });
        onTestFinished(() => { runnerd.kill("SIGTERM"); });
        const nextChild = () => new Promise<number>(resolve => { waiting = pid => { waiting = null; resolve(pid); }; });
        const providerPid = childPids[0] ?? await nextChild();
        const writer = { pid: runnerd.pid!, started: await started(runnerd.pid!) }, provider: [number, number] = [providerPid, await started(providerPid)];
        await fs.writeFile(path.join(runnerStateDirectory, "process-lineage", `writer-${writer.pid}.json`), JSON.stringify({ schema: "paperclip.runner.process-lineage-writer.v1", writer }));
        await fs.writeFile(path.join(runnerStateDirectory, "process-lineage", `lineage-${writer.pid}-0.json`), JSON.stringify({ schema: "paperclip.runner.process-lineage.v1",
          writer, root: provider, members: [provider], groups: [], sessions: [], sampled_through: provider[1] }));
        const backgroundChild = async () => { const next = nextChild(); runnerd.stdin!.write("x"); return next; };
        const prepare = async (options: { warm?: boolean; reuseRunId?: string } = {}) => {
          const runId = await nextRun();
          executionTarget.leaseId = randomUUID();
          await db.insert(environmentLeases).values({ id: executionTarget.leaseId, companyId, environmentId: executionTarget.environmentId,
            heartbeatRunId: runId, provider: "daytona", providerLeaseId: "boat-fixture-allocation" });
          return (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget, ...(options.reuseRunId ? { runnerStateDirectory } : {}), ...options }))!;
        };
        // A sibling task on the same sandbox saves through its own remote run.
        const siblingSavesRemote = async (relative: string, body: string) => {
          const sibling = await prepare();
          await fs.mkdir(path.dirname(path.join(sibling.executionRoot, relative)), { recursive: true });
          await fs.writeFile(path.join(sibling.executionRoot, relative), body);
          expect((await copies.collectStopped({ companyId, runId: sibling.runId, target: executionTarget }))?.state).toBe("saved");
          expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(body);
        };
        return { executionTarget, prepare, siblingSavesRemote, runnerStateDirectory, backgroundChild };
      }
      const contextFor = async (copy: { runId: string; executionRoot: string }) => buildNativeRuntimeContext({ db, agent: { id: agentId, companyId, name: "Target",
        adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" } },
        runId: copy.runId, runtimeConfig: {}, runtimeSkillEntries: [], instructionWorkingCopy: { rootPath: copy.executionRoot, entryPath: "AGENTS.md", kind: "agent_files" } });

      it("REMOTE sandbox: keeps chat A warm on its SAME AGENT_HOME after a sibling saves a memory note; a NEW chat sees the note and DECISIONS", async () => {
        await paulBundle();
        const boat = await sandbox();
        const chatA = await boat.prepare({ warm: true });
        expect(chatA.location).toBe(`remote:${boat.executionTarget.environmentId}`);
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
        const before = await onDisk(root);
        await boat.siblingSavesRemote(note, "NOTE-FACT: Kate takes the SMA-612 handover.\n");

        // Chat A's FIRST next turn reuses the same remote root: no retirement, no re-copy.
        expect(await copies.canReuseWarm(companyId, agentId, chatA.runId)).toBe(true);
        const turn2 = await boat.prepare({ warm: true, reuseRunId: chatA.runId });
        expect(turn2.executionRoot).toBe(chatA.executionRoot);
        expect(turn2.localRoot).toBe(chatA.localRoot);
        expect(await copies.get(companyId, chatA.runId)).toMatchObject({ state: "superseded", receipt: { successorRunId: turn2.runId } });
        // 'AGENT_HOME is <root>' and every other instruction byte the runner compares are unchanged.
        const [contextA, context2] = [await contextFor(chatA), await contextFor(turn2)];
        expect(context2.instructions).toEqual(contextA.instructions);
        expect(context2.aggregateDigest).toBe(contextA.aggregateDigest);
        // The sibling's note is readable in the remote folder chat A is using.
        expect(await fs.readFile(path.join(turn2.executionRoot, note), "utf8")).toBe("NOTE-FACT: Kate takes the SMA-612 handover.\n");
        expect(await onDisk(turn2.executionRoot).then(files => files.filter(name => !name.startsWith(".paperclip-runtime/")))).toEqual([...before, note].sort());
        // No upload or capture scratch is left in the remote root or on the host.
        expect((await fs.readdir(path.join(turn2.executionRoot, ".paperclip-runtime"))).filter(name => /^(notes|checkpoint)-/.test(name))).toEqual([]);
        expect((await fs.readdir(path.dirname(turn2.localRoot))).filter(name => /^(notes|checkpoint)-/.test(name))).toEqual([]);
        // The refreshed tree is the new checkpoint baseline: an idle turn saves nothing.
        expect((await copies.checkpointWarm({ companyId, runId: turn2.runId, target: boat.executionTarget }))).toMatchObject({ state: "warm_saved", receipt: { checkpointState: "unchanged" } });

        // A NEW chat restores the whole folder: the note and the DECISIONS.md fact.
        const chatB = await boat.prepare({ warm: true });
        expect(chatB.executionRoot).not.toBe(chatA.executionRoot);
        expect(await fs.readFile(path.join(chatB.executionRoot, note), "utf8")).toContain("NOTE-FACT");
        expect(await fs.readFile(path.join(chatB.executionRoot, "DECISIONS.md"), "utf8")).toContain("DECISION-FACT");

        // Never-OK: chat A's own later save keeps every note (nothing dropped or moved).
        await fs.writeFile(path.join(turn2.executionRoot, "memory/2026-11-17-chat-a.md"), "chat A note\n");
        expect((await copies.checkpointWarm({ companyId, runId: turn2.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
        await copies.collectStopped({ companyId, runId: turn2.runId, target: boat.executionTarget });
        await copies.collectStopped({ companyId, runId: chatB.runId, target: boat.executionTarget });
        expect(await onDisk(root)).toEqual([...before, note, "memory/2026-11-17-chat-a.md"].sort());
        expect(await fs.readFile(path.join(root, note), "utf8")).toContain("NOTE-FACT");
      }, 30_000);

      // Data-safety guards: exercise the real remote capture, subset upload and
      // rename program, not a mocked manifest or a source-text assertion.
      it("REMOTE sandbox never-OK: delete propagation delivers A' and removes B before the canonical post-check", async () => {
        await paulBundle();
        const a = "memory/notes-a.md", b = "memory/notes-b.md";
        await fs.writeFile(path.join(root, a), "A\n");
        await fs.writeFile(path.join(root, b), "B\n");
        const boat = await sandbox();
        const chatA = await boat.prepare({ warm: true });
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
        expect(await fs.readFile(path.join(chatA.executionRoot, a), "utf8")).toBe("A\n");
        expect(await fs.readFile(path.join(chatA.executionRoot, b), "utf8")).toBe("B\n");
        const sibling = await boat.prepare();
        await fs.writeFile(path.join(sibling.executionRoot, a), "A'\n");
        await fs.unlink(path.join(sibling.executionRoot, b));
        expect((await copies.collectStopped({ companyId, runId: sibling.runId, target: boat.executionTarget }))?.state).toBe("saved");
        expect(await fs.readFile(path.join(root, a), "utf8")).toBe("A'\n");
        await expect(fs.stat(path.join(root, b))).rejects.toMatchObject({ code: "ENOENT" });

        const capture = vi.spyOn(fileCheckpoints, "captureAgentFileCheckpoint");
        const actualUpload = executionTargetTools.prepareAdapterExecutionTargetRuntime;
        const stagedPaths: string[][] = [];
        const upload = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementation(async input => {
          if (input.adapterKey.startsWith("agent-notes-")) stagedPaths.push(await onDisk(input.assets![0]!.localDir));
          return actualUpload(input);
        });
        try {
          const turn2 = await boat.prepare({ warm: true, reuseRunId: chatA.runId });
          expect(turn2.executionRoot).toBe(chatA.executionRoot);
          expect(await fs.readFile(path.join(turn2.executionRoot, a), "utf8")).toBe("A'\n");
          await expect(fs.stat(path.join(turn2.executionRoot, b))).rejects.toMatchObject({ code: "ENOENT" });
          const deliveries = upload.mock.calls.filter(([input]) => input.adapterKey.startsWith("agent-notes-"));
          expect(deliveries).toHaveLength(1);
          expect(stagedPaths).toEqual([[a]]);
          const captures = capture.mock.calls.flatMap(([input], index) => input.runId === chatA.runId ? [capture.mock.results[index]!.value] : []);
          expect(captures).toHaveLength(2);
          const verified = await captures[1]!;
          const canonical = fileCheckpoints.checkpointSnapshot(await fileCheckpoints.cachedAgentFileManifest(root));
          expect(fileCheckpoints.checkpointSnapshot(verified.manifest)).toEqual(canonical);
          expect(turn2.baseHash).toBe(directorySnapshotSha256(canonical));
        } finally { capture.mockRestore(); upload.mockRestore(); }
      }, 90_000);

      it("REMOTE sandbox never-OK: two writers never touch one file; dirty and mid-delivery writes survive retirement", async () => {
        await paulBundle();
        const f = "memory/warm-writer.md";
        const bytes = Buffer.concat([Buffer.from("warm writer\r\n☃\n"), Buffer.from([0, 255, 127])]);
        for (const timing of ["after-checkpoint", "between-capture-and-rename", "same-file-between-capture-and-rename"] as const) {
          await fs.writeFile(path.join(root, f), "checkpoint baseline\n");
          const boat = await sandbox();
          const chatA = await boat.prepare({ warm: true });
          expect((await copies.checkpointWarm({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
          if (timing === "after-checkpoint") await fs.writeFile(path.join(chatA.executionRoot, f), bytes);
          await boat.siblingSavesRemote(note, `sibling ${timing}\n`);
          // Check both disjoint and overlapping writes. Only a disjoint-file
          // race would miss a rename overwriting F before the post-capture.
          if (timing !== "between-capture-and-rename") await boat.siblingSavesRemote(f, `sibling F ${timing}\n`);
          const actualUpload = executionTargetTools.prepareAdapterExecutionTargetRuntime;
          const capture = vi.spyOn(fileCheckpoints, "captureAgentFileCheckpoint");
          let raced = false;
          const upload = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementation(async input => {
            if (input.adapterKey.startsWith("agent-notes-") && timing !== "after-checkpoint") {
              expect(capture.mock.calls.filter(([input]) => input.runId === chatA.runId)).toHaveLength(1);
              await fs.writeFile(path.join(chatA.executionRoot, f), bytes);
              raced = true;
            }
            return actualUpload(input);
          });
          const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand");
          const runId = await nextRun();
          try {
            let handoffError: unknown;
            await copies.prepare({ ...target(), runId, cwd: home, target: boat.executionTarget, warm: true, reuseRunId: chatA.runId, runnerStateDirectory: boat.runnerStateDirectory })
              .catch(error => { handoffError = error; });
            expect({ bytes: await fs.readFile(path.join(chatA.executionRoot, f)), refused: handoffError instanceof AgentDirectoryReuseInvalidatedError },
              `${timing}: never overwrite the warm writer's bytes or accept a raced handoff`).toEqual({ bytes, refused: true });
            expect(handoffError).toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
            // A same-file write is caught IN placement (moved-aside bytes differ
            // from the baseline) and put back; a disjoint write by the post-check.
            expect((handoffError as Error).message).toBe(timing === "after-checkpoint" ? "Warm agent directory changed after its checkpoint"
              : timing === "between-capture-and-rename" ? "Warm agent directory note refresh could not be verified" : "Warm agent directory note refresh failed");
            const deliveries = upload.mock.calls.filter(([input]) => input.adapterKey.startsWith("agent-notes-"));
            const renames = shell.mock.calls.filter(([, , command]) => command.includes(applyWarmNotesProgram));
            expect(deliveries).toHaveLength(timing === "after-checkpoint" ? 0 : 1);
            expect(renames).toHaveLength(timing === "after-checkpoint" ? 0 : 1);
            expect(raced).toBe(timing !== "after-checkpoint");
            const captures = capture.mock.calls.flatMap(([input], index) => input.runId === chatA.runId ? [capture.mock.results[index]!.value] : []);
            expect(captures).toHaveLength(timing === "between-capture-and-rename" ? 2 : 1);
            const observed = fileCheckpoints.checkpointSnapshot((await captures[0]!).manifest);
            expect(directorySnapshotSha256(observed) === chatA.baseHash).toBe(timing !== "after-checkpoint");
            if (timing === "between-capture-and-rename") {
              const verified = fileCheckpoints.checkpointSnapshot((await captures[1]!).manifest);
              const canonical = fileCheckpoints.checkpointSnapshot(await fileCheckpoints.cachedAgentFileManifest(root));
              expect(directorySnapshotSha256(verified)).not.toBe(directorySnapshotSha256(canonical));
            }
            if (timing === "after-checkpoint") {
              await expect(fs.stat(path.join(chatA.executionRoot, note))).rejects.toMatchObject({ code: "ENOENT" });
            }
            expect(await copies.get(companyId, runId)).toBeNull();
            expect((await copies.get(companyId, chatA.runId))?.state).toBe("warm_saved");
            // The existing retirement contract: save the old owner FIRST, then
            // restore this same proposed run fresh, after the handoff releases its lock.
            expect((await copies.collectStopped({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("saved");
            expect(await fs.readFile(path.join(root, f))).toEqual(bytes);
            const fresh = (await copies.prepare({ ...target(), runId, cwd: home, target: boat.executionTarget, warm: true }))!;
            expect(fresh.executionRoot).not.toBe(chatA.executionRoot);
            expect(await fs.readFile(path.join(fresh.executionRoot, f))).toEqual(bytes);
            expect(await fs.readFile(path.join(fresh.executionRoot, note), "utf8")).toBe(`sibling ${timing}\n`);
            await copies.collectStopped({ companyId, runId, target: boat.executionTarget });
          } finally { capture.mockRestore(); upload.mockRestore(); shell.mockRestore(); }
        }
      }, 90_000);

      // RFL ruling (a)+(b): a race INSIDE delivery keeps the agent's change and
      // takes the existing retirement + fresh restore. One helper per shape.
      async function raceDuringDelivery(input: { baseline: Record<string, string>; sibling: (boat: Awaited<ReturnType<typeof sandbox>>) => Promise<void>;
        race: (warmRoot: string) => Promise<void> }) {
        await paulBundle();
        for (const [name, body] of Object.entries(input.baseline)) await fs.writeFile(path.join(root, name), body);
        const boat = await sandbox();
        const chatA = await boat.prepare({ warm: true });
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
        await input.sibling(boat);
        const actualUpload = executionTargetTools.prepareAdapterExecutionTargetRuntime;
        let raced = false;
        const upload = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementation(async uploadInput => {
          if (uploadInput.adapterKey.startsWith("agent-notes-")) { await input.race(chatA.executionRoot); raced = true; }
          return actualUpload(uploadInput);
        });
        const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand");
        const runId = await nextRun();
        let handoffError: unknown;
        try {
          await copies.prepare({ ...target(), runId, cwd: home, target: boat.executionTarget, warm: true, reuseRunId: chatA.runId, runnerStateDirectory: boat.runnerStateDirectory })
            .catch(error => { handoffError = error; });
          return { boat, chatA, runId, raced, handoffError, applies: shell.mock.calls.filter(([, , command]) => command.includes(applyWarmNotesProgram)).length };
        } finally { upload.mockRestore(); shell.mockRestore(); }
      }

      it("REMOTE sandbox never-OK: a delete that lands during delivery is not resurrected", async () => {
        const f = "memory/warm-deleted.md";
        const result = await raceDuringDelivery({ baseline: { [f]: "checkpoint baseline\n" },
          sibling: boat => boat.siblingSavesRemote(f, "sibling F'\n"), race: async warm => fs.unlink(path.join(warm, f)) });
        expect(result.raced).toBe(true);
        expect(result.applies).toBe(1);
        expect(result.handoffError).toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
        await expect(fs.stat(path.join(result.chatA.executionRoot, f))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await copies.get(companyId, result.runId)).toBeNull();
        expect((await copies.get(companyId, result.chatA.runId))?.state).toBe("warm_saved");
      }, 60_000);

      it("REMOTE sandbox never-OK: a write to a file on the remove list that lands during delivery survives", async () => {
        const b = "memory/warm-removed.md";
        const bytes = Buffer.from("warm writer kept B\n");
        const result = await raceDuringDelivery({ baseline: { [b]: "B\n" },
          sibling: async boat => {
            const sibling = await boat.prepare();
            await fs.unlink(path.join(sibling.executionRoot, b));
            await fs.writeFile(path.join(sibling.executionRoot, note), "sibling note\n");
            expect((await copies.collectStopped({ companyId, runId: sibling.runId, target: boat.executionTarget }))?.state).toBe("saved");
            await expect(fs.stat(path.join(root, b))).rejects.toMatchObject({ code: "ENOENT" });
          },
          race: async warm => fs.writeFile(path.join(warm, b), bytes) });
        expect(result.raced).toBe(true);
        expect(result.applies).toBe(1);
        expect(result.handoffError).toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
        expect(await fs.readFile(path.join(result.chatA.executionRoot, b))).toEqual(bytes);
        // Retirement saves the agent's bytes first; the fresh restore has them.
        expect((await copies.collectStopped({ companyId, runId: result.chatA.runId, target: result.boat.executionTarget }))?.state).toBe("saved");
        expect(await fs.readFile(path.join(root, b))).toEqual(bytes);
        const fresh = (await copies.prepare({ ...target(), runId: result.runId, cwd: home, target: result.boat.executionTarget, warm: true }))!;
        expect(await fs.readFile(path.join(fresh.executionRoot, b))).toEqual(bytes);
        await copies.collectStopped({ companyId, runId: result.runId, target: result.boat.executionTarget });
      }, 60_000);

      it("REMOTE sandbox never-OK: a live background child of the chat falls back with no delivery", async () => {
        await paulBundle();
        const boat = await sandbox();
        const chatA = await boat.prepare({ warm: true });
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
        await boat.siblingSavesRemote(note, "sibling note\n");
        await boat.backgroundChild();
        const upload = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime");
        const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand");
        const runId = await nextRun();
        try {
          await expect(copies.prepare({ ...target(), runId, cwd: home, target: boat.executionTarget, warm: true, reuseRunId: chatA.runId, runnerStateDirectory: boat.runnerStateDirectory }))
            .rejects.toThrow("Warm runner quiescence is unproven");
          expect(upload.mock.calls.filter(([input]) => input.adapterKey.startsWith("agent-notes-"))).toHaveLength(0);
          expect(shell.mock.calls.filter(([, , command]) => command.includes(applyWarmNotesProgram))).toHaveLength(0);
        } finally { upload.mockRestore(); shell.mockRestore(); }
        await expect(fs.stat(path.join(chatA.executionRoot, note))).rejects.toMatchObject({ code: "ENOENT" });
        // Without the runner's state directory nothing is delivered either.
        const runId2 = await nextRun();
        await expect(copies.prepare({ ...target(), runId: runId2, cwd: home, target: boat.executionTarget, warm: true, reuseRunId: chatA.runId }))
          .rejects.toThrow("Warm runner quiescence is unproven");
        // The existing fallback: collect the old owner (no unsaved change), then restore fresh.
        expect((await copies.collectStopped({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("unchanged");
        const fresh = (await copies.prepare({ ...target(), runId, cwd: home, target: boat.executionTarget, warm: true }))!;
        expect(fresh.executionRoot).not.toBe(chatA.executionRoot);
        expect(await fs.readFile(path.join(fresh.executionRoot, note), "utf8")).toBe("sibling note\n");
        await copies.collectStopped({ companyId, runId, target: boat.executionTarget });
      }, 60_000);

      it("REMOTE sandbox never-OK: EEXIST on no-replace placement keeps the agent's bytes", async () => {
        // The path is recreated between the move-aside and link(2): a preload
        // performs that write inside the real program's first linkSync call.
        const boat = await sandbox();
        const warmRoot = path.join(boat.executionTarget.remoteCwd, "warm-root"), source = path.join(warmRoot, ".paperclip-runtime", "notes-x", "files");
        const f = "memory/eexist.md", baselineBytes = "baseline\n", agentBytes = "agent recreated\n", sibling = "sibling\n";
        await fs.mkdir(path.join(warmRoot, "memory"), { recursive: true });
        await fs.mkdir(path.join(source, "memory"), { recursive: true });
        await fs.writeFile(path.join(warmRoot, f), baselineBytes);
        await fs.writeFile(path.join(source, f), sibling);
        const preload = path.join(boat.executionTarget.remoteCwd, "eexist-preload.cjs");
        await fs.writeFile(preload, `const fs = require("node:fs"); const link = fs.linkSync; let once = false;
          fs.linkSync = (from, to) => { if (!once) { once = true; fs.writeFileSync(to, ${JSON.stringify(agentBytes)}); } return link(from, to); };`);
        const sha = (text: string) => createHash("sha256").update(text).digest("hex");
        const plan = { root: warmRoot, source, aside: path.join(warmRoot, ".paperclip-runtime", "notes-x", "aside"), runner: boat.runnerStateDirectory,
          remove: [], dirs: [], files: [[f, 0o600, { "": sha(baselineBytes) }, sha(sibling)]] };
        const result = await execFile(process.execPath, ["-r", preload, "-e", applyWarmNotesProgram, JSON.stringify(plan)]).then(() => null, error => error as { code: number; stderr: string });
        expect(result?.code).not.toBe(0);
        expect(result?.stderr).toContain("EEXIST");
        // The agent's recreated bytes stay in the tree; the moved-aside original is kept, never deleted.
        expect(await fs.readFile(path.join(warmRoot, f), "utf8")).toBe(agentBytes);
        expect(result?.stderr).toContain("agent bytes kept aside");
        expect(await fs.readFile(path.join(plan.aside, "0"), "utf8")).toBe(baselineBytes);
      }, 30_000);

      it("REMOTE sandbox never-OK: chat A's unsynced write survives a sibling note (no refresh over a dirty tree)", async () => {
        await paulBundle();
        const boat = await sandbox();
        const chatA = await boat.prepare({ warm: true });
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
        // Chat A writes after its last checkpoint (its idle tree no longer equals the baseline).
        await fs.writeFile(path.join(chatA.executionRoot, "memory/2026-11-17-a-unsynced.md"), "A-UNSYNCED\n");
        await boat.siblingSavesRemote(note, "NOTE-FACT sibling\n");
        const runId = await nextRun();
        await expect(copies.prepare({ ...target(), runId, cwd: home, target: boat.executionTarget, warm: true, reuseRunId: chatA.runId, runnerStateDirectory: boat.runnerStateDirectory }))
          .rejects.toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
        // The tree was not touched: A's write is still there and the sibling's note was not pushed over it.
        expect(await fs.readFile(path.join(chatA.executionRoot, "memory/2026-11-17-a-unsynced.md"), "utf8")).toBe("A-UNSYNCED\n");
        await expect(fs.stat(path.join(chatA.executionRoot, note))).rejects.toMatchObject({ code: "ENOENT" });
        // Retirement collects A first; then the fresh copy has both A's write and the sibling's note.
        expect((await copies.collectStopped({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("saved");
        expect(await fs.readFile(path.join(root, "memory/2026-11-17-a-unsynced.md"), "utf8")).toBe("A-UNSYNCED\n");
        expect(await fs.readFile(path.join(root, note), "utf8")).toBe("NOTE-FACT sibling\n");
        const fresh = await boat.prepare({ warm: true });
        expect(await fs.readFile(path.join(fresh.executionRoot, "memory/2026-11-17-a-unsynced.md"), "utf8")).toBe("A-UNSYNCED\n");
        expect(await fs.readFile(path.join(fresh.executionRoot, note), "utf8")).toBe("NOTE-FACT sibling\n");
        await copies.collectStopped({ companyId, runId: fresh.runId, target: boat.executionTarget });
      }, 30_000);

      it.each(["AGENTS.md", "DECISIONS.md"])("REMOTE sandbox: still retires the warm chat when a sibling edits %s", async edited => {
        await paulBundle();
        const boat = await sandbox();
        const chatA = await boat.prepare({ warm: true });
        expect((await copies.checkpointWarm({ companyId, runId: chatA.runId, target: boat.executionTarget }))?.state).toBe("warm_saved");
        await boat.siblingSavesRemote(edited, `# ${edited} edited\n`);
        expect(await copies.canReuseWarm(companyId, agentId, chatA.runId)).toBe(false);
        const runId = await nextRun();
        await expect(copies.prepare({ ...target(), runId, cwd: home, target: boat.executionTarget, warm: true, reuseRunId: chatA.runId, runnerStateDirectory: boat.runnerStateDirectory }))
          .rejects.toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
        expect(await fs.readFile(path.join(chatA.executionRoot, edited), "utf8")).not.toBe(`# ${edited} edited\n`);
        await copies.collectStopped({ companyId, runId: chatA.runId, target: boat.executionTarget });
        const fresh = await boat.prepare({ warm: true });
        expect(fresh.executionRoot).not.toBe(chatA.executionRoot);
        expect(await fs.readFile(path.join(fresh.executionRoot, edited), "utf8")).toBe(`# ${edited} edited\n`);
        await copies.collectStopped({ companyId, runId: fresh.runId, target: boat.executionTarget });
      }, 30_000);
    });

    it("adopts one physical root and fences stale cleanup through final save", async () => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      const secondId = await nextRun();
      const second = await copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home });
      expect(second).toMatchObject({ runId: secondId, localRoot: first.localRoot, executionRoot: first.executionRoot,
        responsibleUserId: userId, receipt: { materializationRunId: first.runId } });
      expect((await copies.get(companyId, first.runId))?.receipt?.retainedByRunId).toBe(secondId);
      await copies.release(companyId, first.runId);
      expect((await copies.collectStopped({ companyId, runId: first.runId }))?.processStoppedAt).toBeNull();
      await copies.reportUnavailable(companyId, first.runId);
      expect(await fs.readFile(path.join(first.localRoot, entryFile), "utf8")).toBe(initial);
      await copies.release(companyId, secondId);
      expect(await copies.hasChanges({ companyId, runId: secondId })).toBe(false);
      const thirdId = await nextRun();
      const third = await copies.adopt({ companyId, agentId, runId: thirdId, previousRunId: secondId, cwd: home });
      expect(third?.executionRoot).toBe(first.executionRoot);
      await fs.writeFile(path.join(first.localRoot, "warm-memory.txt"), "third turn edit");
      expect(await copies.hasChanges({ companyId, runId: thirdId })).toBe(true);
      expect(await copies.collectStopped({ companyId, runId: thirdId })).toMatchObject({ state: "saved", receipt: { cleanupPending: false } });
      expect(await fs.readFile(path.join(root, "warm-memory.txt"), "utf8")).toBe("third turn edit");
      await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await copies.release(companyId, first.runId);
    });
    it.each(["company", "agent", "workspace", "environment"])("rejects foreign %s adoption", async mismatch => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      const secondId = await nextRun();
      expect(await copies.adopt({ companyId: mismatch === "company" ? randomUUID() : companyId,
        agentId: mismatch === "agent" ? randomUUID() : agentId, runId: secondId, previousRunId: first.runId,
        cwd: mismatch === "workspace" ? `${home}-other` : home,
        ...(mismatch === "environment" ? { target: { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), remoteCwd: "/workspace" } } : {}),
      })).toBeNull();
      expect((await copies.get(companyId, first.runId))?.receipt?.retainedByRunId).toBeUndefined();
      await copies.collectStopped({ companyId, runId: first.runId });
    });
    it("adopts unchanged ownership after collection retry metadata changes before claim", async () => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native" }).where(eq(heartbeatRuns.id, first.runId));
      const secondId = await nextRun();
      const fileDb = fileStorageDb(db);
      const transaction = fileDb.transaction.bind(fileDb);
      let injected = false;
      const spy = vi.spyOn(fileDb, "transaction").mockImplementation((async (callback, options) => {
        if (!injected) {
          injected = true;
          const before = (await copies.get(companyId, first.runId))!;
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date(before.updatedAt.getTime() + 1000));
          try { await copies.recoverStopped(); } finally { vi.useRealTimers(); }
          const after = (await copies.get(companyId, first.runId))!;
          expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
          expect(after.nextAttemptAt).toBeInstanceOf(Date);
          for (const field of ["state", "baseHash", "localRoot", "executionRoot", "processStoppedAt", "receipt", "attempts"] as const)
            expect(after[field]).toEqual(before[field]);
        }
        return transaction(callback, options);
      }) as typeof db.transaction);
      try {
        const adopted = await copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home });
        expect(injected).toBe(true);
        expect(adopted).toMatchObject({ runId: secondId, localRoot: first.localRoot, executionRoot: first.executionRoot });
        expect((await copies.get(companyId, first.runId))?.receipt?.retainedByRunId).toBe(secondId);
      } finally { spy.mockRestore(); vi.useRealTimers(); expect(injected).toBe(true); }
    });

    it.each(["materialization", "checkpoint", "stopped", "state"])("rejects changed %s authority with the same baseline before adoption", async change => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      const secondId = await nextRun();
      const warning = vi.spyOn(logger, "warn");
      const privateValue = "private-materialization-/tmp/untrusted-token-do-not-log";
      const fileDb = fileStorageDb(db);
      const transaction = fileDb.transaction.bind(fileDb);
      let injected = false;
      const spy = vi.spyOn(fileDb, "transaction").mockImplementation((async (callback, options) => {
        if (!injected) {
          injected = true;
          const prior = (await copies.get(companyId, first.runId))!;
          const values = change === "materialization" ? { receipt: { ...prior.receipt, materializationIdentity: privateValue } }
            : change === "checkpoint" ? { receipt: { ...prior.receipt, checkpointState: "saved" } }
              : change === "stopped" ? { processStoppedAt: new Date() } : { state: "pending_collection" };
          await db.update(agentInstructionWorkingCopies).set({ ...values, updatedAt: new Date(Date.now() + 1000) })
            .where(eq(agentInstructionWorkingCopies.runId, first.runId));
          expect((await copies.get(companyId, first.runId))!.baseHash).toBe(prior.baseHash);
        }
        return transaction(callback, options);
      }) as typeof db.transaction);
      try {
        await expect(copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home }))
          .rejects.toMatchObject({ status: 409, details: { stage: "locked_adoption_authority", predecessorPresent: true,
            observedAfterInitialRead: true, changedFields: expect.arrayContaining([change === "materialization" || change === "checkpoint" ? "receipt" : change === "stopped" ? "processStoppedAt" : "state"]) } });
        expect(injected).toBe(true);
        expect(warning).toHaveBeenCalledWith({ companyId, agentId, runId: secondId, previousRunId: first.runId,
          adoptionConflict: { stage: "locked_adoption_authority", predecessorPresent: true, observedAfterInitialRead: true,
            changedFields: [change === "materialization" || change === "checkpoint" ? "receipt" : change === "stopped" ? "processStoppedAt" : "state"] } },
          "Agent directory adoption conflict");
        expect(JSON.stringify(warning.mock.calls)).not.toContain(privateValue);
        expect(await copies.get(companyId, secondId)).toBeNull();
        expect((await copies.get(companyId, first.runId))?.receipt?.retainedByRunId).toBeUndefined();
        expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
      } finally { spy.mockRestore(); warning.mockRestore(); }
    });

    it("reports closed claim predicates when retirement wins before the final owner read", async () => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      const secondId = await nextRun();
      const warning = vi.spyOn(logger, "warn");
      const transaction = db.transaction.bind(db);
      let injected = false;
      const spy = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => {
        const result = await transaction(callback, options);
        if (!injected) {
          injected = true;
          await db.update(agentInstructionWorkingCopies).set({ state: "pending_collection" })
            .where(eq(agentInstructionWorkingCopies.runId, first.runId));
        }
        return result;
      }) as typeof db.transaction);
      try {
        await expect(copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home }))
          .rejects.toMatchObject({ status: 409, details: { stage: "adoption_claim", observedAfterClaim: true,
            predecessorPresent: true, conditions: { unchangedTurn: false, timestampMatches: true, baselineMatches: true,
              localRootMatches: true, unstopped: true, successorAbsent: true, receiptMatches: true } } });
        expect(warning).toHaveBeenCalledWith({ companyId, agentId, runId: secondId, previousRunId: first.runId,
          adoptionConflict: { stage: "adoption_claim", observedAfterClaim: true, predecessorPresent: true,
            conditions: { unchangedTurn: false, timestampMatches: true, baselineMatches: true, localRootMatches: true,
              unstopped: true, successorAbsent: true, receiptMatches: true } } }, "Agent directory adoption conflict");
        expect(await copies.get(companyId, secondId)).toBeNull();
        expect((await copies.get(companyId, first.runId))?.receipt?.retainedByRunId).toBeUndefined();
      } finally { spy.mockRestore(); warning.mockRestore(); }
    });

    it("allows only one stale concurrent adoption with identical updatedAt timestamps", async () => {
      const fixed = new Date("2030-01-01T00:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(fixed);
      try {
        const first = await run();
        expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
        const next = await Promise.all([nextRun(), nextRun()]);
        let reads = 0;
        let releaseReads!: () => void;
        const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
        // Both claimants see the same unclaimed row before either can enter
        // the agent-row transaction. Date precision cannot distinguish them.
        const staleReader = async () => {
          const captured = await copies.get(companyId, first.runId);
          reads++;
          if (reads >= 3) { if (reads === 4) releaseReads(); await bothRead; }
          return captured;
        };
        const service = agentDirectoryWorkingCopyService(db, staleReader, async (row, values) => {
          const [updated] = await db.update(agentInstructionWorkingCopies).set({ ...values, updatedAt: fixed })
            .where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
          return updated;
        });
        const settled = await Promise.allSettled(next.map(runId => service.adopt({ companyId, agentId, runId, previousRunId: first.runId, cwd: home })));
        const winners = settled.filter(result => result.status === "fulfilled" && result.value);
        expect(winners).toHaveLength(1);
        expect(settled.filter(result => result.status === "rejected")).toHaveLength(1);
        const prior = await copies.get(companyId, first.runId);
        expect(prior?.updatedAt).toEqual(fixed);
        const winnerId = prior?.receipt?.retainedByRunId as string;
        expect(next).toContain(winnerId);
        expect(await copies.get(companyId, next.find(id => id !== winnerId)!)).toBeNull();
        await copies.collectStopped({ companyId, runId: winnerId });
      } finally { vi.useRealTimers(); }
    });
    it("fences a stale collector when adoption commits immediately before its stop CAS", async () => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      const secondId = await nextRun();
      const transaction = db.transaction.bind(db);
      let injected = false;
      const spy = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => {
        if (!injected) {
          injected = true;
          expect(await copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home })).not.toBeNull();
        }
        return transaction(callback, options);
      }) as typeof db.transaction);
      try {
        expect(await copies.collectStopped({ companyId, runId: first.runId })).toMatchObject({
          receipt: { retainedByRunId: secondId }, processStoppedAt: null, attempts: 0,
        });
        expect(injected).toBe(true);
        expect(await fs.readFile(path.join(first.localRoot, entryFile), "utf8")).toBe(initial);
        expect((await copies.get(companyId, secondId))?.processStoppedAt).toBeNull();
      } finally { spy.mockRestore(); }
      await copies.collectStopped({ companyId, runId: secondId });
    });
    it("requires current-run authorization before transferring collection authority", async () => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      const secondId = await nextRun();
      await db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, secondId));
      await expect(copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home })).rejects.toMatchObject({ status: 403 });
      expect((await copies.get(companyId, first.runId))?.receipt?.retainedByRunId).toBeUndefined();
      await copies.collectStopped({ companyId, runId: first.runId });
    });
    it.each(["owner-close", "restart-proof"])("durably preserves an adopted directory after retirement failure and final cleanup: %s", async recovery => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      const secondId = await nextRun();
      await copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home });
      await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native" }).where(eq(heartbeatRuns.id, secondId));
      expect(await copies.reportRetirementUnconfirmed(companyId, secondId)).toMatchObject({
        state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED", processStoppedAt: null,
      });
      await fs.writeFile(path.join(first.localRoot, "unsaved-memory.txt"), "Keep failed retirement edits");
      // Mirror heartbeat's final cleanup after preparation throws. Neither the
      // current pending owner nor the prior alias may become terminal loss.
      await copies.reportUnavailable(companyId, secondId);
      await copies.reportUnavailable(companyId, first.runId);
      expect(await copies.get(companyId, secondId)).toMatchObject({ state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED", processStoppedAt: null });
      await copies.reportRetirementUnconfirmed(companyId, first.runId);
      await copies.release(companyId, first.runId);
      await copies.release(companyId, secondId);
      await copies.recoverStopped(); // A terminal run with no stop receipt grants no collection authority.
      expect((await copies.get(companyId, secondId))?.processStoppedAt).toBeNull();
      expect(await fs.readFile(path.join(first.localRoot, entryFile), "utf8")).toBe(initial);
      if (recovery === "owner-close") await copies.collectStopped({ companyId, runId: secondId }); // Explicit test owner retirement.
      else {
        const { appendHeartbeatRunEvent } = await import("../services/heartbeat-run-events.js");
        const stop = (runId: string) => appendHeartbeatRunEvent(db, { companyId, runId, agentId,
          eventType: "native.local_process_stopped", stream: "system", level: "info", message: "Test-owned process retirement proof", payload: {} });
        await stop(first.runId);
        copies = agentInstructionWorkingCopyService(db); // No in-memory owner or transport survives.
        await copies.recoverStopped();
        expect((await copies.get(companyId, secondId))?.processStoppedAt).toBeNull();
        await stop(secondId);
        // Make the deferred maintenance retry due after the new owner stop proof.
        await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: null }).where(eq(agentInstructionWorkingCopies.runId, secondId));
        await copies.recoverStopped();
      }
      expect(await copies.get(companyId, secondId)).toMatchObject({ state: "saved", receipt: { cleanupPending: false } });
      expect(await fs.readFile(path.join(root, "unsaved-memory.txt"), "utf8")).toBe("Keep failed retirement edits");
      await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("declines reuse after canonical instruction changes", async () => {
      const first = await run();
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(false);
      await fs.writeFile(path.join(root, entryFile), "Changed canonical instructions");
      const secondId = await nextRun();
      expect(await copies.adopt({ companyId, agentId, runId: secondId, previousRunId: first.runId, cwd: home })).toBeNull();
      await copies.collectStopped({ companyId, runId: first.runId });
    });
    it("requires stop for matching bytes at a replaced materialized root", async () => {
      const first = await run();
      const replaced = `${first.localRoot}-old`;
      await fs.rename(first.localRoot, replaced);
      await fs.cp(replaced, first.localRoot, { recursive: true });
      expect(await copies.hasChanges({ companyId, runId: first.runId })).toBe(true);
      await copies.collectStopped({ companyId, runId: first.runId });
    });
  });

  it.each([".paperclip-runtime/state", "notes/.paperclip-runtime/state", "promptTemplate.legacy.md"])("rejects reserved board path %s before mutation", async (reserved) => {
    await expect(agentFileStore(db).write({ ...target(), path: reserved, bytes: Buffer.from("reserved"), baseHash: null }, board())).rejects.toMatchObject({ status: 422 });
    await expect(fs.stat(path.join(root, reserved))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run()).toBeTruthy();
  });

  it("round trips nested text, empty directories and binary bytes independently of task files", async () => {
    const first = await run();
    expect(first.localRoot.startsWith(path.join(home, ".paperclip-runtime"))).toBe(false);
    await fs.mkdir(path.join(first.localRoot, "notes", "empty"), { recursive: true });
    await fs.writeFile(path.join(first.localRoot, "notes", "fact.txt"), "remember me");
    const bytes = Buffer.from([0, 255, 17, 128, 9]);
    await fs.writeFile(path.join(first.localRoot, "image.bin"), bytes);
    await fs.writeFile(path.join(home, "task-only.txt"), "not personal");
    expect((await copies.collectStopped({ companyId, runId: first.runId }))?.state).toBe("saved");
    copies = agentInstructionWorkingCopyService(db);
    const next = await run();
    expect(await fs.readFile(path.join(next.localRoot, "notes", "fact.txt"), "utf8")).toBe("remember me");
    expect(await fs.readFile(path.join(next.localRoot, "image.bin"))).toEqual(bytes);
    expect((await fs.stat(path.join(next.localRoot, "notes", "empty"))).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(next.localRoot, "task-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).toHaveLength(0);
  });

  async function sparseFile(filename: string, size: number) {
    const handle = await fs.open(filename, "w");
    try { await handle.truncate(size); } finally { await handle.close(); }
  }

  it("saves and restores files beyond the former file and folder limits, with streaming inspection and download", async () => {
    const first = await run();
    const size = 66 * 1024 * 1024;
    await sparseFile(path.join(first.localRoot, "large.bin"), size);
    expect((await copies.collectStopped({ companyId, runId: first.runId }))?.state).toBe("saved");
    await copies.release(companyId, first.runId);
    const next = await run();
    const restored = await inspectAgentFile(next.localRoot, "large.bin");
    expect(restored).toMatchObject({ size, bytes: null });
    const store = agentFileStore(db);
    const download = (await store.download(companyId, agentId, "large.bin", board()))!;
    expect(download.size).toBe(size);
    // The lock is released before consuming the stream. An editor replacement
    // must not change the already opened download's bytes.
    await store.write({ ...target(), path: "large.bin", bytes: Buffer.from("replacement"), baseHash: restored!.hash }, board());
    const hash = createHash("sha256");
    let downloaded = 0;
    for await (const chunk of download.stream) { downloaded += chunk.length; hash.update(chunk); }
    expect(downloaded).toBe(size);
    expect(hash.digest("hex")).toBe(restored!.hash);
    expect(await fs.readFile(path.join(root, "large.bin"), "utf8")).toBe("replacement");
    await store.write({ ...target(), path: "empty.bin", bytes: Buffer.alloc(0), baseHash: null }, board());
    const empty = (await store.download(companyId, agentId, "empty.bin", board()))!;
    expect(empty.size).toBe(0);
    for await (const _chunk of empty.stream) throw new Error("Empty download must have no chunks");
  }, 30_000);

  it("accepts the exact 256 MiB file boundary without retaining a text buffer", async () => {
    expect(MAX_AGENT_FILE_BYTES).toBe(256 * 1024 * 1024);
    await sparseFile(path.join(root, "boundary.bin"), MAX_AGENT_FILE_BYTES);
    expect(await inspectAgentFile(root, "boundary.bin")).toMatchObject({ size: MAX_AGENT_FILE_BYTES, bytes: null });
  });

  describe("fail-closed agent-directory saves", () => {
    afterEach(() => { vi.restoreAllMocks(); });
    const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    type Kind = "apply" | "quota" | "authorization" | "timeout";
    const failureFor = (kind: Kind) => kind === "quota" ? new fileStoreModule.AgentFileLimitError("Agent folder exceeds a storage limit")
      : kind === "authorization" ? new HttpError(403, "Current permissions do not allow this agent-file save")
        : kind === "timeout" ? new Error("Remote agent-file capture timed out") : new Error("store.apply failed (EIO)");
    /** A service instance whose real store fails every apply, as a controller would see. */
    function failingService(kind: Kind) {
      const actual = fileStoreModule.agentFileStore;
      vi.spyOn(fileStoreModule, "agentFileStore").mockImplementation((...args) => {
        const store = actual(...args);
        vi.spyOn(store, "apply").mockRejectedValue(failureFor(kind));
        return store;
      });
      const service = agentInstructionWorkingCopyService(db);
      vi.mocked(fileStoreModule.agentFileStore).mockRestore();
      return service;
    }
    async function holdUnsavedNote(warm: boolean, kind: Kind) {
      const copy = await run({ warm });
      const note = `unsaved note ${randomUUID()}`;
      await fs.writeFile(path.join(copy.localRoot, "unsaved-note.txt"), note);
      const failing = failingService(kind);
      // The wrapper's immediate retry helper, then heartbeat teardown, then the cleanup worker.
      const held = (await collectStoppedInstructionCopyWithRetries(() => failing.collectStopped({ companyId, runId: copy.runId })))!;
      return { copy, note, failing, held };
    }
    async function assertRetained(copy: Awaited<ReturnType<typeof run>>, note: string) {
      const row = (await copies.get(companyId, copy.runId))!;
      expect(agentFileSaveHeld(row)).toBe(true);
      expect(row).toMatchObject({ state: "unavailable", errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION });
      expect(row.processStoppedAt).not.toBeNull();
      expect(row.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() - 1);
      expect(row.receipt?.baseline).toBeTruthy();
      expect(row.receipt?.cleanupPending).toBeUndefined();
      expect(sha(await fs.readFile(path.join(copy.localRoot, "unsaved-note.txt")))).toBe(sha(note));
      if (copy.receipt?.warm === true) expect(JSON.parse(await fs.readFile(path.join(path.dirname(copy.localRoot), "owner.json"), "utf8")).runId).toBe(copy.runId);
      await expect(fs.stat(path.join(root, "unsaved-note.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      return row;
    }
    const cases = [false, true].flatMap(warm => (["apply", "quota", "authorization", "timeout"] as const).map(kind => [warm ? "warm" : "cold", kind] as const));
    it.each(cases)("stopped agent-directory save failure retains exact source and lease across teardown/restart, then retries to a verified save (%s, local, %s)", async (mode, kind) => {
      const warm = mode === "warm";
      const { copy, note, failing, held } = await holdUnsavedNote(warm, kind);
      expect(held).toMatchObject({ state: "unavailable", errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION,
        errorCode: kind === "quota" ? "AGENT_FILES_LIMIT_EXCEEDED" : "AGENT_FILES_SAVE_FAILED" });
      expect((held.receipt?.savePending as { code?: string }).code).toBe(held.errorCode);
      // Heartbeat teardown: loss report, instruction cleanup, then the cleanup worker sweep.
      expect((await failing.reportUnavailable(companyId, copy.runId))?.state).toBe("unavailable");
      await failing.release(companyId, copy.runId);
      await failing.recoverCaptured();
      await assertRetained(copy, note);
      // The one true instruction is listed for the person/operator.
      const listed = await copies.list(companyId, agentId, board());
      expect(listed.find(entry => entry.runId === copy.runId)).toMatchObject({ state: "unavailable", errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION });
      // Restart: a fresh controller service, real store, durable retry is due.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, copy.runId));
      await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      const restarted = agentInstructionWorkingCopyService(db);
      expect(await restarted.recoverStopped()).toBeGreaterThan(0);
      const saved = (await restarted.get(companyId, copy.runId))!;
      expect(saved.state).toBe("saved");
      expect(agentFileSaveHeld(saved)).toBe(false);
      expect(sha(await fs.readFile(path.join(root, "unsaved-note.txt")))).toBe(sha(note));
      // Only after the verified save may cleanup discard the temporary tree.
      await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }, 60_000);

    it("a held save does not block the next message: the next run starts from canonical and the instruction stays visible", async () => {
      const { copy, note } = await holdUnsavedNote(false, "apply");
      const next = await run();
      expect(next.state).toBe("prepared");
      expect(await fs.readFile(path.join(next.localRoot, entryFile), "utf8")).toBe(initial);
      await fs.writeFile(path.join(next.localRoot, "next.txt"), "answered");
      expect((await copies.collectStopped({ companyId, runId: next.runId }))?.state).toBe("saved");
      expect(await fs.readFile(path.join(root, "next.txt"), "utf8")).toBe("answered");
      const listed = await copies.list(companyId, agentId, board());
      expect(listed.find(entry => entry.runId === copy.runId)?.errorMessage).toBe(AGENT_FILES_SAVE_PENDING_INSTRUCTION);
      await assertRetained(copy, note);
    });

    it("stopped agent-directory save failure retains exact source and lease across teardown/restart, then retries to a verified save (cold, remote, lease uncertainty)", async () => {
      const { copy, note, failing } = await holdUnsavedNote(false, "apply");
      const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/held-task";
      await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
      await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId,
        provider: "daytona", providerLeaseId: `held-${leaseId}`, status: "active", metadata: { remoteCwd } });
      const row = (await copies.get(companyId, copy.runId))!;
      expect(typeof (row.receipt?.savePending as { mirrorHash?: unknown }).mirrorHash).toBe("string");
      // The same held tree, recorded as a remote copy whose mirror was retrieved.
      await db.update(agentInstructionWorkingCopies).set({ location: `remote:${environmentId}`,
        executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
        receipt: { ...row.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      expect(await agentFileSaveHeldOnLease(db, { id: leaseId, companyId, providerLeaseId: `held-${leaseId}` })).toBe(true);
      // Lease uncertainty: the lease is released mid-hold. No remote rm, no mirror rm.
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.id, leaseId));
      const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand");
      await failing.release(companyId, copy.runId);
      await failing.recoverCaptured();
      expect(shell).not.toHaveBeenCalled();
      await assertRetained(copy, note);
      // Restart with no collector: retry from the verified mirror.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, copy.runId));
      await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      const restarted = agentInstructionWorkingCopyService(db);
      await restarted.recoverStopped();
      expect((await restarted.get(companyId, copy.runId))?.state).toBe("saved");
      expect(sha(await fs.readFile(path.join(root, "unsaved-note.txt")))).toBe(sha(note));
      expect(await agentFileSaveHeldOnLease(db, { id: leaseId, companyId, providerLeaseId: `held-${leaseId}` })).toBe(false);
      expect(shell).not.toHaveBeenCalled();
    }, 60_000);
    // review-fleet-4 (rf4-samenote): on the fail-closed branch alone, a SUCCESSFUL
    // durable RETRY after a failed save replaced the sibling's canonical B with the
    // held A and made no conflict copy, so B was lost. The retry must go through
    // the same three-way compare as a first save: B stays canonical, A is a named
    // conflict copy, and the save receipt/event names both.
    it.each([false, true])("RF4 failed save then durable retry keeps B and names A (warm=%s)", async warm => {
      const hash = (text: string) => fileHash(Buffer.from(text));
      await fs.mkdir(path.join(root, "memory"), { recursive: true });
      await fs.writeFile(path.join(root, "memory", "daily.md"), "C");
      const copy = await run({ warm });
      await fs.writeFile(path.join(copy.localRoot, "memory", "daily.md"), "A");
      const failing = failingService("apply");
      const held = (await collectStoppedInstructionCopyWithRetries(() => failing.collectStopped({ companyId, runId: copy.runId })))!;
      expect(held).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED", errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION });
      expect(agentFileSaveHeld(held)).toBe(true);
      // A sibling saves B over the same base C while A is held.
      const sibling = await run();
      await fs.writeFile(path.join(sibling.localRoot, "memory", "daily.md"), "B");
      expect((await copies.collectStopped({ companyId, runId: sibling.runId }))?.state).toBe("saved");
      expect(await fs.readFile(path.join(root, "memory", "daily.md"), "utf8")).toBe("B");
      // Heartbeat teardown and the cleanup worker leave the held A in place.
      await failing.release(companyId, copy.runId);
      await failing.recoverCaptured();
      expect(await fs.readFile(path.join(copy.localRoot, "memory", "daily.md"), "utf8")).toBe("A");
      // Restart: a fresh service retries the held save from the durable row.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, copy.runId));
      await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      const restarted = agentInstructionWorkingCopyService(db);
      expect(await restarted.recoverStopped()).toBeGreaterThan(0);
      const retried = (await restarted.get(companyId, copy.runId))!;
      expect(retried.state).toBe("saved");
      expect(agentFileSaveHeld(retried)).toBe(false);
      // B stays canonical; A is a named conflict copy.
      expect(await fs.readFile(path.join(root, "memory", "daily.md"), "utf8"), "the retry must not replace the sibling's canonical B").toBe("B");
      const names = (await fs.readdir(path.join(root, "memory"))).filter(name => name !== "daily.md");
      expect(names).toHaveLength(1);
      const copyPath = `memory/${names[0]}`;
      expect(copyPath).toMatch(new RegExp(`^memory/daily\\.conflict-${copy.runId.slice(0, 8)}-\\d+\\.md$`));
      expect(await fs.readFile(path.join(root, copyPath), "utf8")).toBe("A");
      // The save names both: receipt conflicts and the audited save event.
      const conflict = { path: "memory/daily.md", baseHash: hash("C"), currentHash: hash("B"), incomingHash: hash("A"), conflictCopy: copyPath };
      expect(retried.receipt?.conflicts).toEqual([conflict]);
      const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, agentId));
      expect(audits.map(row => row.details)).toContainEqual(expect.objectContaining({ conflicts: [conflict] }));
      // Only after the verified save may cleanup discard the temporary tree.
      await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // The next turn is told: B was kept, A is saved as the conflict copy.
      const next = await run();
      expect(await restarted.claimConflictNotice({ companyId, agentId, runId: next.runId, previousRunId: copy.runId }))
        .toBe(`Note: "memory/daily.md" was also saved by another run; that version was kept. Your earlier edit is saved as "${copyPath}".`);
    }, 60_000);
  });
  // Ported from the RFL same-note judge (judge-lifecycle-addition.ts, fixture from judge-samefile.test.ts):
  // the conflict-side bytes A are in the stopped run's copy, canonical has moved on to B, and the
  // durable upload of A fails after a prefix (before any head commit). Production retirement
  // (collectStopped, which retries and then gives up) must keep the only copy of A and a durable retry.
  // These assertions use only the row and the filesystem, so the same block runs unchanged on N23c (RED).
  describe("JUDGE same-note retirement variants: failed conflict upload", () => {
    const objects = { bytes: new Map<string, Buffer>(), failHash: null as string | null, failedPrefix: 0 };
    const judgeStorage = () => ({
      provider: "s3" as const,
      async putFile(input: { companyId: string; namespace: string; body: Readable; byteSize: number; sha256: string }) {
        if (objects.failHash === input.sha256) {
          for await (const chunk of input.body) {
            objects.failedPrefix = Math.min(Buffer.from(chunk).length, Math.floor(input.byteSize / 2));
            throw new Error("JUDGE interrupted A upload after prefix");
          }
        }
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        expect(body.length).toBe(input.byteSize);
        expect(fileHash(body)).toBe(input.sha256);
        const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
        objects.bytes.set(objectKey, body);
        return { objectKey };
      },
      async getObject(owner: string, objectKey: string) {
        expect(objectKey.startsWith(`${owner}/`)).toBe(true);
        const body = objects.bytes.get(objectKey);
        if (!body) throw new Error("fixture object missing");
        return { stream: Readable.from([body]) };
      },
      async headObject(_owner: string, key: string) { return { exists: objects.bytes.has(key), lastModified: new Date(0) }; },
      async deleteObject(owner: string, key: string) { expect(key.startsWith(`${owner}/`)).toBe(true); objects.bytes.delete(key); },
    });
    beforeEach(() => {
      objects.bytes.clear(); objects.failHash = null; objects.failedPrefix = 0;
      vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
      vi.spyOn(storageModule, "getStorageService").mockImplementation(() => judgeStorage() as unknown as ReturnType<typeof storageModule.getStorageService>);
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it.each([false, true])("JUDGE failed conflict upload must retain source through production retirement (warm=%s)", async warm => {
      const store = agentFileStore(db);
      await store.write({ ...target(), path: "daily.md", bytes: Buffer.from("C"), baseHash: null }, board());
      const parked = await run({ warm });
      expect(parked).toBeTruthy();
      const A = Buffer.alloc(512 * 1024, 0x41);
      await fs.writeFile(path.join(parked.localRoot, "daily.md"), A);
      await store.write({ ...target(), path: "daily.md", bytes: Buffer.from("B"), baseHash: fileHash(Buffer.from("C")) }, board());
      const [prior] = await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId));
      expect(prior).toBeTruthy();
      objects.failHash = fileHash(A);
      // Production retirement: the wrapper's collect-with-retries, then heartbeat teardown and the cleanup worker.
      const saved = await collectStoppedInstructionCopyWithRetries(() => copies.collectStopped({ companyId, runId: parked.runId }));
      await copies.release(companyId, parked.runId);
      await copies.recoverCaptured();
      const source = await fs.readFile(path.join(parked.localRoot, "daily.md")).catch(() => null);
      const [after] = await db.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId));
      const row = (await copies.get(companyId, parked.runId))!;
      console.log("JUDGE failed production retirement", JSON.stringify({ warm, state: saved?.state, code: saved?.errorCode,
        failedPrefix: objects.failedPrefix, receipt: row.receipt, nextAttemptAt: row.nextAttemptAt, sourceRetained: source !== null,
        AInObjectStore: [...objects.bytes.values()].some(b => b.equals(A)) }));
      expect(objects.failedPrefix).toBeGreaterThan(0);
      expect(after).toEqual(prior);
      expect(await store.read(companyId, agentId, "daily.md", board())).toEqual(Buffer.from("B"));
      expect(source, "refused save must keep the only source A, not remove it on terminal cleanup").toEqual(A);
      // A durable retry exists: the row is held (not completed), its baseline is kept, and a retry is scheduled.
      expect(row.state).not.toBe("saved");
      expect((row.receipt as { savePending?: unknown } | null)?.savePending).toBeTruthy();
      expect(row.receipt?.baseline).toBeTruthy();
      expect(row.nextAttemptAt).not.toBeNull();
      // The retry, once storage recovers, durably records A; only then may the temporary tree go.
      objects.failHash = null;
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, parked.runId));
      await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(agentInstructionWorkingCopies.runId, parked.runId));
      const restarted = agentInstructionWorkingCopyService(db);
      await restarted.recoverStopped();
      expect((await restarted.get(companyId, parked.runId))?.state).toBe("saved");
      expect([...objects.bytes.values()].some(b => b.equals(A))).toBe(true);
    }, 60_000);
  });
  it("checks quota for a small editor save without reading unrelated file bytes", async () => {
    const asset = path.join(root, "large.bin");
    await sparseFile(asset, MAX_AGENT_FILE_BYTES);
    const open = vi.spyOn(fs, "open");
    try {
      await agentFileStore(db).write({ ...target(), path: "note.txt", bytes: Buffer.from("small edit"), baseHash: null }, board());
      expect(open.mock.calls.some(([filename]) => filename === asset)).toBe(false);
      expect(await fs.readFile(path.join(root, "note.txt"), "utf8")).toBe("small edit");
    } finally { open.mockRestore(); }
  });

  // supersedes (fail-closed): the old test asserted the temporary copy was deleted
  // (ENOENT + compacted baseline) after an over-quota save. That discarded the only
  // copy of "changed instructions". It now asserts retention under a held save.
  it("supersedes: reports an oversized run file without a partial save and removes its temporary copy → reports an oversized run file without a partial save and retains its unsaved source", async () => {
    const copy = await run();
    await sparseFile(path.join(copy.localRoot, "too-large.bin"), MAX_AGENT_FILE_BYTES + 1);
    await fs.writeFile(path.join(copy.localRoot, entryFile), "changed instructions");
    const failed = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(failed).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", candidateHash: null, attempts: 1,
      errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION });
    expect(failed?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    expect(failed?.receipt?.storageWarning).toContain("Runs can continue");
    expect((failed?.receipt?.savePending as { reason?: string }).reason).toContain('"too-large.bin" exceeds the 256 MiB');
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
    await expect(fs.stat(path.join(root, "too-large.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await copies.reportUnavailable(companyId, copy.runId))?.errorCode).toBe("AGENT_FILES_LIMIT_EXCEEDED");
    await copies.release(companyId, copy.runId);
    expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe("changed instructions");
    expect((await copies.get(companyId, copy.runId))?.receipt?.baseline).toBeTruthy();
    const next = await run();
    expect(await fs.readFile(path.join(next.localRoot, entryFile), "utf8")).toBe(initial);
    await fs.writeFile(path.join(next.localRoot, "next-task.txt"), "still working");
    expect((await copies.collectStopped({ companyId, runId: next.runId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "next-task.txt"), "utf8")).toBe("still working");
  });

  it.each([false, true])("warns on each run at the file limit and clears the warning after ordinary agent cleanup (warm=%s)", async (warm) => {
    await sparseFile(path.join(root, "full.bin"), MAX_AGENT_FILE_BYTES);
    const first = await run({ warm });
    expect(first.receipt?.storageWarning).toContain("256 MiB");
    expect(instructionWorkingCopyGuidance(first)).toContain("Runs can continue");
    const unchanged = await copies[warm ? "checkpointWarm" : "collectStopped"]({ companyId, runId: first.runId });
    expect(unchanged).toMatchObject({ state: warm ? "warm_saved" : "unchanged", errorCode: null });
    if (warm) expect(unchanged?.receipt?.checkpointState).toBe("unchanged");
    expect(unchanged?.receipt?.storageWarning).toContain("Agent storage is full");
    copies = agentInstructionWorkingCopyService(db);
    const second = await run({ warm, ...(warm ? { reuseRunId: first.runId } : {}) });
    if (warm) expect(second.localRoot).toBe(first.localRoot);
    expect(second.receipt?.storageWarning).toContain("Agent storage is full");
    await fs.unlink(path.join(second.localRoot, "full.bin"));
    await fs.writeFile(path.join(second.localRoot, "task-output.txt"), "work continues");
    expect(await copies.collectStopped({ companyId, runId: second.runId })).toMatchObject({ state: "saved", receipt: { storageWarning: null } });
    const next = await run();
    expect(next.receipt?.storageWarning).toBeNull();
    expect(await fs.readFile(path.join(next.localRoot, "task-output.txt"), "utf8")).toBe("work continues");
  }, 30_000);

  // supersedes (fail-closed): the old test asserted ENOENT for the first run's copy after its
  // stopped save hit the limit. A failed stopped save now holds its source; later runs still start.
  it("supersedes: starts successive runs with an already oversized saved file and lets the agent remove it → the first run's unsaved copy is retained and successive runs still start", async () => {
    await sparseFile(path.join(root, "old-large.bin"), MAX_AGENT_FILE_BYTES + 1);
    const first = await run();
    expect(first.state).toBe("prepared");
    expect(first.receipt?.storageWarning).toContain("256 MiB");
    expect(await fs.readFile(path.join(first.localRoot, entryFile), "utf8")).toBe(initial);
    const stopped = await copies.collectStopped({ companyId, runId: first.runId });
    expect(stopped).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION });
    expect((await fs.stat(first.localRoot)).isDirectory()).toBe(true);
    copies = agentInstructionWorkingCopyService(db);
    const cleanup = await run();
    expect(cleanup.state).toBe("prepared");
    await fs.unlink(path.join(cleanup.localRoot, "old-large.bin"));
    expect(await copies.collectStopped({ companyId, runId: cleanup.runId })).toMatchObject({ state: "saved", receipt: { storageWarning: null } });
    expect((await run()).receipt?.storageWarning).toBeNull();
  }, 30_000);

  it("starts when the existing folder exceeds its total quota and accepts agent cleanup", async () => {
    for (let index = 0; index < 8; index++) await fs.writeFile(path.join(root, `quota-part-${index}.bin`), "fixture");
    const lstat = fs.lstat.bind(fs);
    // Keep this regression small on disk while exercising the real filesystem,
    // snapshots, database receipts, restore, and merge with 2 GiB of metadata.
    const sizes = vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args);
      if (path.basename(String(args[0])).startsWith("quota-part-")) Object.assign(stat, { size: MAX_AGENT_FILE_BYTES });
      return stat;
    });
    try {
      const first = await run();
      expect(first.receipt?.storageWarning).toContain("2 GiB");
      expect((await copies.collectStopped({ companyId, runId: first.runId }))?.errorCode).toBe("AGENT_FILES_LIMIT_EXCEEDED");
      const cleanup = await run();
      for (let index = 0; index < 8; index++) await fs.unlink(path.join(cleanup.localRoot, `quota-part-${index}.bin`));
      await fs.writeFile(path.join(cleanup.localRoot, "small.txt"), "recovered");
      expect(await copies.collectStopped({ companyId, runId: cleanup.runId })).toMatchObject({ state: "saved", receipt: { storageWarning: null } });
      expect((await run()).receipt?.storageWarning).toBeNull();
    } finally { sizes.mockRestore(); }
  });

  it("supersedes: rejects more than 2 GiB in aggregate before hashing or saving any file → the limit reason is kept in the held save receipt", async () => {
    expect(MAX_AGENT_DIRECTORY_BYTES).toBe(2 * 1024 * 1024 * 1024);
    const copy = await run();
    for (let index = 0; index < 8; index++) await sparseFile(path.join(copy.localRoot, `part-${index}.bin`), MAX_AGENT_FILE_BYTES);
    // The eight allowed files exactly fill the quota; the entry is additional.
    const result = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(result).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION });
    // supersedes (fail-closed): the limit reason moved from errorMessage to the held save receipt.
    expect((result?.receipt?.savePending as { reason?: string }).reason).toContain("2 GiB total storage limit");
    expect(await fs.readdir(root)).toEqual(["policy"]);
  });

  it("rejects excessive entry count before snapshotting", async () => {
    const directory = path.join(home, "many-entries");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "empty"), "");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    // Exercise the walker bound without creating 100,001 physical files.
    const readdir = vi.spyOn(fs, "readdir").mockResolvedValue(Array(MAX_AGENT_DIRECTORY_ENTRIES + 1).fill(entries[0]));
    try {
      await expect(snapshotAgentFiles(directory)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("100,000-entry limit") });
    } finally { readdir.mockRestore(); }
  }, 30_000);

  // supersedes (fail-closed): the old test asserted the failed copy was deleted (ENOENT).
  // The over-limit entry is the only copy of that edit; it is now retained under a held save.
  it("supersedes: keeps the entry's 1 MiB limit and cleans up failed synchronization → keeps the entry's 1 MiB limit and retains the unsaved source after failed synchronization", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "a".repeat(1024 * 1024 + 1));
    const result = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(result?.state).toBe("unavailable");
    expect((await fs.readFile(path.join(copy.localRoot, entryFile))).length).toBe(1024 * 1024 + 1);
    expect(result?.errorMessage).toBe(AGENT_FILES_SAVE_PENDING_INSTRUCTION);
    expect((result?.receipt?.savePending as { reason?: string }).reason).toContain("at most 1 MiB");
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
  });

  it("supersedes: merges independent changes and uses the last synchronization for same-file edits — keeps a sibling's same-file save, with the later edit as a conflict copy", async () => {
    const a = await run(), b = await run();
    await fs.writeFile(path.join(a.localRoot, "a.txt"), "A");
    await fs.writeFile(path.join(b.localRoot, "b.txt"), "B");
    await Promise.all([a, b].map(copy => copies.collectStopped({ companyId, runId: copy.runId })));
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("A");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("B");
    const c = await run(), d = await run();
    await fs.writeFile(path.join(c.localRoot, "a.txt"), "C");
    await fs.writeFile(path.join(d.localRoot, "a.txt"), "D");
    await fs.writeFile(path.join(c.localRoot, "b.txt"), "new B");
    expect((await copies.collectStopped({ companyId, runId: c.runId }))?.state).toBe("saved");
    const saved = await copies.collectStopped({ companyId, runId: d.runId });
    expect(saved?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("C");
    const [kept] = saved?.receipt?.conflicts as Array<{ path: string; conflictCopy: string }>;
    expect(kept).toMatchObject({ path: "a.txt", currentHash: fileHash(Buffer.from("C")), incomingHash: fileHash(Buffer.from("D")),
      conflictCopy: expect.stringMatching(new RegExp(`^a\\.conflict-${d.runId.slice(0, 8)}-\\d+\\.txt$`)) });
    expect(await fs.readFile(path.join(root, kept!.conflictCopy), "utf8")).toBe("D");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("new B");
    expect(await copies.list(companyId, agentId, board())).toEqual([]);
    for (const copy of [a, b, c, d]) await expect(fs.stat(path.dirname(copy.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.join(path.dirname(root), "file-sync", "runs"))).toEqual([]);
  });

  it("supersedes: makes concurrent edit/delete races last-sync-wins and preserves unrelated new files — keeps a saved edit over a stale deletion and applies a later edit over a deletion", async () => {
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "old.txt"), "old");
    const deleting = await run(), editing = await run();
    await fs.rm(path.join(deleting.localRoot, "notes"), { recursive: true });
    await fs.writeFile(path.join(editing.localRoot, "notes", "old.txt"), "edited");
    await fs.writeFile(path.join(editing.localRoot, "notes", "new.txt"), "unrelated");
    await copies.collectStopped({ companyId, runId: editing.runId });
    const deleted = await copies.collectStopped({ companyId, runId: deleting.runId });
    expect(deleted?.state).toBe("saved");
    expect(deleted?.receipt?.conflicts).toEqual([{ path: "notes/old.txt", baseHash: fileHash(Buffer.from("old")),
      currentHash: fileHash(Buffer.from("edited")), incomingHash: null, conflictCopy: null }]);
    expect(await fs.readFile(path.join(root, "notes", "old.txt"), "utf8")).toBe("edited");
    expect(await fs.readFile(path.join(root, "notes", "new.txt"), "utf8")).toBe("unrelated");
    const remove = await run(), change = await run();
    await fs.unlink(path.join(remove.localRoot, "notes", "new.txt"));
    await fs.writeFile(path.join(change.localRoot, "notes", "new.txt"), "restored by later edit");
    await copies.collectStopped({ companyId, runId: remove.runId });
    await copies.collectStopped({ companyId, runId: change.runId });
    expect(await fs.readFile(path.join(root, "notes", "new.txt"), "utf8")).toBe("restored by later edit");
  });

  it("handles a concurrently replaced parent and keeps the later file change", async () => {
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "fact.txt"), "old");
    const replacing = await run(), editing = await run();
    await fs.rm(path.join(replacing.localRoot, "notes"), { recursive: true });
    await fs.writeFile(path.join(replacing.localRoot, "notes"), "now a file");
    await fs.writeFile(path.join(editing.localRoot, "notes", "fact.txt"), "new fact");
    await copies.collectStopped({ companyId, runId: replacing.runId });
    expect(await fs.readFile(path.join(root, "notes"), "utf8")).toBe("now a file");
    expect((await copies.collectStopped({ companyId, runId: editing.runId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "notes", "fact.txt"), "utf8")).toBe("new fact");
  });

  it("cleans stopped copies after a crash during cleanup without touching active copies", async () => {
    const finished = await run(), active = await run();
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date() }).where(eq(agentInstructionWorkingCopies.runId, finished.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    await expect(fs.stat(finished.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(active.localRoot)).isDirectory()).toBe(true);
  });

  it("cleans up a staging failure before any provider starts", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "fixture failure", pid: null, startedAt: null });
    try {
      await expect(copies.prepare({ ...target(), runId, cwd: home, target: { kind: "remote", transport: "ssh", environmentId: randomUUID(), remoteCwd: "/fixture/task",
        spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd: "/fixture/task", remoteWorkspacePath: "/fixture/task", privateKey: null, knownHosts: null, strictHostKeyChecking: true } } })).rejects.toThrow("Could not exclude");
      const row = (await copies.get(companyId, runId))!;
      expect(row.state).toBe("unavailable");
      expect(row.receipt?.baseline).toBeUndefined();
      await expect(fs.stat(path.dirname(row.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { shell.mockRestore(); }
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])("registers staging ownership before copying and cleans preparation for a %s run after restart", async (status) => {
    const original = fs.cp.bind(fs);
    const copy = vi.spyOn(fs, "cp").mockImplementationOnce(async (source, destination, options) => {
      const rows = await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.agentId, agentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "preparing", localRoot: destination });
      return original(source, destination, options);
    });
    const interrupted = await run();
    copy.mockRestore();
    const active = await run();
    for (const row of [interrupted, active]) {
      await db.update(agentInstructionWorkingCopies).set({ state: "preparing", baseHash: "preparing", receipt: { schema: "paperclip.agent-files.v1" } }).where(eq(agentInstructionWorkingCopies.runId, row.runId));
    }
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, interrupted.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    expect((await copies.get(companyId, interrupted.runId))?.state).toBe("unavailable");
    await expect(fs.stat(path.dirname(interrupted.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(active.localRoot)).isDirectory()).toBe(true);
  });

  it.each(["new-home", "same-path-empty", "foreign-lease", "other-controller", "missing-collector", "over-quota"] as const)("recovers remote agent files after controller cache loss: %s", async scenario => {
    const copy = await run({ warm: true });
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/retained-task";
    const executionRoot = path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId);
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId,
      provider: "daytona", providerLeaseId: "original-sandbox", status: "active", metadata: { remoteCwd } });
    await db.update(agentInstructionWorkingCopies).set({ location: `remote:${environmentId}`, executionRoot,
      receipt: { ...copy.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    const saved = (await copies.get(companyId, copy.runId))!;
    const replacementHome = path.join(home, `replacement-${randomUUID()}`);
    const remoteFiles = await fs.mkdtemp(path.join(home, "remote-checkpoint-"));
    await fs.mkdir(path.join(remoteFiles, "files", "policy"), { recursive: true });
    await fs.writeFile(path.join(remoteFiles, "files", entryFile), "Remote instructions changed during the turn");
    await fs.writeFile(path.join(remoteFiles, "files", "unsaved.txt"), "Only the running sandbox has this");
    await fs.rm(path.dirname(copy.localRoot), { recursive: true, force: true });
    if (scenario === "over-quota") {
      const handle = await fs.open(path.join(remoteFiles, "files", "too-large.bin"), "w");
      try { await handle.truncate(MAX_AGENT_FILE_BYTES + 1); } finally { await handle.close(); }
    }
    const transport = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementation(async options => ({
      target: options.target!, workspaceRemoteDir: options.workspaceRemoteDir!, runtimeRootDir: options.runtimeRootDir!,
      assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
      restoreWorkspace: async () => { await fs.cp(path.join(remoteFiles, "files"), options.workspaceLocalDir, { recursive: true }); },
    }));
    const ephemeralBefore = process.env.PAPERCLIP_EPHEMERAL_SERVER;
    process.env.PAPERCLIP_EPHEMERAL_SERVER = "true";
    if (scenario === "new-home") process.env.PAPERCLIP_HOME = replacementHome;
    const remote = { kind: "remote" as const, transport: "sandbox" as const, environmentId,
      leaseId: scenario === "foreign-lease" ? randomUUID() : leaseId, remoteCwd, runner: { execute: vi.fn() } };
    try {
      if (scenario === "missing-collector") {
        const retained = await copies.collectStopped({ companyId, runId: copy.runId });
        expect(retained).toMatchObject({ state: "pending_collection", errorCode: "INSTRUCTION_REMOTE_COLLECTOR_UNAVAILABLE", baseHash: saved.baseHash });
        expect(retained?.receipt?.baseline).toEqual(saved.receipt?.baseline);
        expect(retained?.nextAttemptAt).toBeInstanceOf(Date);
        expect(transport).not.toHaveBeenCalled();
        return;
      }
      if (scenario === "other-controller") {
        await db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-directory:${companyId}:${agentId}`}, 0))`);
          await expect(copies.prepare({ ...target(), runId: copy.runId, cwd: remoteCwd, target: remote, warm: true }))
            .rejects.toThrow("Agent directory operation is already active");
          expect(transport).not.toHaveBeenCalled();
        });
        return;
      }
      const preparing = copies.prepare({ ...target(), runId: copy.runId, cwd: remoteCwd, target: remote, warm: true });
      if (scenario === "foreign-lease") {
        await expect(preparing).rejects.toThrow("Agent directory recovery lease changed");
        expect(transport).not.toHaveBeenCalled();
        return;
      }
      const recovered = (await preparing)!;
      expect(recovered.executionRoot).toBe(executionRoot);
      expect(recovered.baseHash).toBe(saved.baseHash);
      expect(recovered.receipt).toEqual(saved.receipt);
      if (scenario === "new-home") {
        expect(recovered.localRoot.startsWith(replacementHome)).toBe(true);
        await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else expect(recovered.localRoot).toBe(copy.localRoot);
      expect(await fs.readFile(path.join(recovered.localRoot, "unsaved.txt"), "utf8")).toBe("Only the running sandbox has this");
      expect(await fs.readFile(path.join(recovered.localRoot, entryFile), "utf8")).toBe("Remote instructions changed during the turn");
      expect(transport).toHaveBeenNthCalledWith(1, expect.objectContaining({ adapterKey: "agent-files-recovery", workspaceRemoteDir: executionRoot,
        workspaceBaseline: { exclude: [".paperclip-runtime"], entries: new Map() }, workspaceInboundMode: "adopt_remote" }));
      if (scenario === "over-quota") {
        expect((await fs.stat(path.join(recovered.localRoot, "too-large.bin"))).size).toBe(MAX_AGENT_FILE_BYTES + 1);
        await expect(inspectAgentDirectory(recovered.localRoot)).rejects.toThrow();
      }
      expect(transport).toHaveBeenCalledWith(expect.objectContaining({ workspaceLocalDir: recovered.localRoot, workspaceInboundMode: "adopt_remote" }));
      await copies.prepare({ ...target(), runId: copy.runId, cwd: remoteCwd, target: remote, warm: true });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      process.env.PAPERCLIP_HOME = home;
      if (ephemeralBefore === undefined) delete process.env.PAPERCLIP_EPHEMERAL_SERVER;
      else process.env.PAPERCLIP_EPHEMERAL_SERVER = ephemeralBefore;
      transport.mockRestore();
    }
  });

  it("retains remote cleanup across restart and failed retries until the original lease is cleaned", async () => {
    const copy = await run();
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/task";
    const executionRoot = path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId);
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "original-sandbox" });
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), location: `remote:${environmentId}`, executionRoot,
      receipt: { ...copy.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    const pending = (await copies.get(companyId, copy.runId))!;
    expect(pending.receipt).toMatchObject({ cleanupPending: true, cleanup: { leaseId, remoteCwd } });
    expect(pending.receipt?.baseline).toBeUndefined();
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const execute = vi.fn().mockRejectedValueOnce(new Error("provider temporarily unavailable")).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    for (const expectedPending of [true, false]) {
      await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: null }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      await copies.recoverCaptured();
      expect((await copies.get(companyId, copy.runId))?.receipt?.cleanupPending).toBe(expectedPending);
    }
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ lease: expect.objectContaining({ id: leaseId, providerLeaseId: "original-sandbox" }),
      command: "rm", args: ["-rf", "--", executionRoot,
        path.posix.join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "agent-file-transfers", agentId, copy.runId)], bypassSession: true }));
    await copies.recoverCaptured();
    expect(execute).toHaveBeenCalledTimes(2);
    await copies.release(companyId, copy.runId);
    expect((await copies.get(companyId, copy.runId))?.receipt?.cleanupPending).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "stopped", "destroyed"])("recovers a retained remote unchanged turn only with exact stop proof: %s", async stopped => {
    const copy = await run();
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "retained-sandbox" };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ ...lease, status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: stopped !== "missing" ? { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: stopped }) } : {} });
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native" }).where(eq(heartbeatRuns.id, copy.runId));
    await db.update(agentInstructionWorkingCopies).set({ state: "unchanged_turn", location: `remote:${environmentId}`,
      executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...copy.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    const execute = vi.fn();
    copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    expect((await copies.reportUnavailable(companyId, copy.runId))?.state).toBe("unchanged_turn");
    await copies.recoverStopped();
    const recovered = (await copies.get(companyId, copy.runId))!;
    if (stopped === "destroyed") {
      expect(recovered).toMatchObject({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", receipt: { cleanupPending: false } });
      expect(recovered.processStoppedAt).toBeInstanceOf(Date);
      await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await copies.recoverStopped();
      expect((await copies.get(companyId, copy.runId))?.updatedAt).toEqual(recovered.updatedAt);
    } else {
      expect(recovered).toMatchObject({ state: stopped === "stopped" ? "pending_collection" : "unchanged_turn", processStoppedAt: null });
      if (stopped === "stopped") {
        expect(recovered.errorCode).toBe("INSTRUCTION_STOPPED_REMOTE_COLLECTION_PENDING");
        expect(recovered.receipt?.baseline).toBeDefined();
        await copies.release(companyId, copy.runId);
        await copies.recoverCaptured();
      }
      expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
    }
    expect(execute).not.toHaveBeenCalled(); // Never restart a remote provider to recover bytes.
  });

  it.each([0, 2])("preserves a legacy no-ID remote copy with %s matching leases", async count => {
    const copy = await run();
    const environmentId = randomUUID(), remoteCwd = "/fixture/task";
    await db.insert(environments).values({ id: environmentId, name: `Legacy remote ${environmentId}`, driver: "sandbox" });
    for (let index = 0; index < count; index++) await db.insert(environmentLeases).values({
      companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: `allocation-${index}` });
    await db.update(agentInstructionWorkingCopies).set({ location: `remote:${environmentId}`,
      executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...copy.receipt, cleanup: { remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    const execute = vi.fn();
    copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    const pending = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(pending).toMatchObject({ state: "pending_collection", attempts: 0, processStoppedAt: null, errorCode: "INSTRUCTION_REMOTE_LEASE_UNVERIFIED" });
    expect(pending!.receipt?.baseline).toBeDefined();
    await copies.release(companyId, copy.runId);
    expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
    expect(execute).not.toHaveBeenCalled();
  });

  it("finishes remote cleanup from a destruction receipt after the environment is deleted", async () => {
    const copy = await run();
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "destroyed-sandbox" };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ ...lease, status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), location: `remote:${environmentId}`,
      executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...copy.receipt, cleanupPending: true, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    await db.delete(environments).where(eq(environments.id, environmentId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    expect((await copies.get(companyId, copy.runId))?.receipt?.cleanupPending).toBe(false);
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // supersedes (fail-closed): the old test asserted ENOENT for the copy holding "innocent.txt".
  // That valid unsaved file is now retained; the symlink is still never saved.
  it.each([false, true])("supersedes: rejects symlinks without saving any part of the tree, preserving an existing full-storage warning: %s → the valid unsaved file is retained", async (full) => {
    if (full) await sparseFile(path.join(root, "full.bin"), MAX_AGENT_FILE_BYTES);
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "innocent.txt"), "changed");
    await fs.symlink(path.join(home, "outside"), path.join(copy.localRoot, "escape"));
    const result = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(result?.state).toBe("unavailable");
    expect(result?.errorCode).toBe("AGENT_FILES_SAVE_FAILED");
    expect(result?.receipt?.storageWarning).toBe(copy.receipt?.storageWarning);
    if (full) expect(result?.receipt?.storageWarning).toContain("Agent storage is full");
    expect(await fs.readFile(path.join(copy.localRoot, "innocent.txt"), "utf8")).toBe("changed");
    await expect(fs.stat(path.join(root, "innocent.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("adopts the last deployed head once and bridges an old collector without appending history", async () => {
    const id = randomUUID();
    const content = "last deployed revision";
    await db.insert(agentInstructionRevisions).values({ id, ...target(), entryFile, contentBase64: Buffer.from(content).toString("base64"), contentHash: fileHash(Buffer.from(content)), byteLength: content.length, source: "board" });
    await db.insert(agentInstructionHeads).values({ ...target(), entryFile, revisionId: id });
    const current = await revisions.readCurrent(target(), board());
    expect(current?.content).toBe(content);
    await revisions.commit({ ...target(), entryFile, content: "new directory contents", baseRevisionId: id, source: "cleanup" }, board());
    await revisions.materializeCurrent(target());
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe("new directory contents");
    await expect(revisions.commit({ ...target(), entryFile, content: "stale legacy run", baseRevisionId: id, source: "cleanup" }, board())).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).toHaveLength(1);
  });

  it("ordinary file edits leave the loaded instruction digest unchanged", async () => {
    const make = async () => {
      const copy = await run();
      const context = await buildNativeRuntimeContext({ db, agent: { id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } },
        runId: copy.runId, runtimeConfig: {}, runtimeSkillEntries: [], instructionWorkingCopy: { rootPath: copy.executionRoot, entryPath: entryFile, kind: "agent_files" } });
      return { copy, context };
    };
    const before = await make();
    await fs.writeFile(path.join(before.copy.localRoot, "notes.txt"), "new personal knowledge");
    await copies.collectStopped({ companyId, runId: before.copy.runId });
    const after = await make();
    expect(after.context.aggregateDigest).toBe(before.context.aggregateDigest);
    expect(after.context.instructions.bundle.fileCount).toBe(1);
  });
  it("checkpoints three managed turns into one live directory, fences old cleanup, and persists after retirement", async () => {
    let copy = await run({ warm: true });
    const original = copy;
    for (let turn = 1; turn <= 3; turn++) {
      await fs.appendFile(path.join(copy.localRoot, "memory.txt"), `turn ${turn}\n`);
      const saved = (await copies.checkpointWarm({ companyId, runId: copy.runId }))!;
      expect(saved.state).toBe("warm_saved");
      expect(saved.processStoppedAt).toBeNull();
      expect(await agentFileStore(db).read(companyId, agentId, "memory.txt", board())).toEqual(Buffer.from(Array.from({ length: turn }, (_, i) => `turn ${i + 1}\n`).join("")));
      await copies.release(companyId, copy.runId);
      expect(await fs.stat(copy.localRoot)).toBeTruthy();
      if (turn < 3) {
        expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(true);
        copy = await run({ warm: true, reuseRunId: copy.runId });
        expect(copy.executionRoot).toBe(original.executionRoot);
        await copies.collectStopped({ companyId, runId: original.runId });
        await copies.release(companyId, original.runId);
        expect(await fs.stat(copy.localRoot)).toBeTruthy();
      }
    }
    // A child may write after the last turn's checkpoint; session retirement
    // must collect this delta using the current owner, not the first run.
    await fs.writeFile(path.join(copy.localRoot, "late.txt"), "after turn");
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const fresh = await run();
    expect(await fs.readFile(path.join(fresh.localRoot, "memory.txt"), "utf8")).toBe("turn 1\nturn 2\nturn 3\n");
    expect(await fs.readFile(path.join(fresh.localRoot, "late.txt"), "utf8")).toBe("after turn");
  });

  it("retires the predecessor retry at warm handoff without stop proof or releasing the successor's tree", async () => {
    const first = await run({ warm: true });
    await copies.checkpointWarm({ companyId, runId: first.runId });
    await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(eq(agentInstructionWorkingCopies.runId, first.runId));
    const successor = await run({ warm: true, reuseRunId: first.runId });
    expect(await copies.get(companyId, first.runId)).toMatchObject({ state: "superseded",
      processStoppedAt: null, nextAttemptAt: null, receipt: { successorRunId: successor.runId } });
    await copies.collectStopped({ companyId, runId: first.runId });
    await copies.release(companyId, first.runId);
    expect((await copies.get(companyId, first.runId))?.processStoppedAt).toBeNull();
    expect(await fs.readFile(path.join(successor.localRoot, entryFile), "utf8")).toBe(initial);
    expect(JSON.parse(await fs.readFile(path.join(path.dirname(successor.localRoot), "owner.json"), "utf8")).runId)
      .toBe(successor.runId);
  });

  it("rechecks canonical edits at handoff and releases the writer lock before retirement and fresh restore", async () => {
    const first = await run({ warm: true });
    await copies.checkpointWarm({ companyId, runId: first.runId });
    expect(await copies.canReuseWarm(companyId, agentId, first.runId)).toBe(true);
    await agentFileStore(db).write({ ...target(), path: "editor.txt", bytes: Buffer.from("new canonical content"), baseHash: null }, board());

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await expect(copies.prepare({ ...target(), runId, cwd: home, warm: true, reuseRunId: first.runId })).rejects.toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
    expect(JSON.parse(await fs.readFile(path.join(path.dirname(first.localRoot), "owner.json"), "utf8")).runId).toBe(first.runId);
    // Both paths need the canonical writer lock. A handoff failure must release
    // it before orchestration stops the old session and restores a fresh copy.
    expect((await copies.collectStopped({ companyId, runId: first.runId }))?.state).toBe("unchanged");
    const next = (await copies.prepare({ ...target(), runId, cwd: home, warm: true }))!;
    expect(next.localRoot).not.toBe(first.localRoot);
    expect(await fs.readFile(path.join(next.localRoot, "editor.txt"), "utf8")).toBe("new canonical content");
  }, 10_000);

  it("attaches the successor collector before fallible post-handoff bookkeeping", async () => {
    const first = await run({ warm: true });
    await copies.checkpointWarm({ companyId, runId: first.runId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    let collectorRunId = first.runId;
    const handoff = vi.fn((copy: typeof first) => { collectorRunId = copy.runId; });
    const directories = agentDirectoryWorkingCopyService(db, copies.get, async () => { throw new Error("injected post-handoff database failure"); });

    await expect(directories.prepare({ ...target(), runId, cwd: home, warm: true, reuseRunId: first.runId, onWarmHandoff: handoff }))
      .rejects.toThrow("injected post-handoff database failure");
    expect(handoff).toHaveBeenCalledOnce();
    expect(collectorRunId).toBe(runId);
    await fs.writeFile(path.join(first.localRoot, "last-write.txt"), "saved after failed handoff");
    // The stale collector cannot touch the successor; the attached collector
    // still saves and cleans the actual owner after process retirement.
    await copies.collectStopped({ companyId, runId: first.runId });
    expect((await fs.stat(first.localRoot)).isDirectory()).toBe(true);
    expect((await copies.collectStopped({ companyId, runId: collectorRunId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "last-write.txt"), "utf8")).toBe("saved after failed handoff");
    await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);
  it("retires loaded instruction edits while allowing ordinary personal-file edits to stay warm", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, entryFile), "# New loaded policy\n");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    await copies.collectStopped({ companyId, runId: copy.runId });
    const fresh = await run({ warm: true });
    expect(fresh.executionRoot).not.toBe(copy.executionRoot);
    expect(await fs.readFile(path.join(fresh.localRoot, entryFile), "utf8")).toBe("# New loaded policy\n");
  });
  it("refreshes after editor changes and preserves concurrent unrelated files", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, "mine.txt"), "from run");
    await agentFileStore(db).write({ ...target(), path: "board.txt", bytes: Buffer.from("from board"), baseHash: null }, board());
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    expect(await fs.readFile(path.join(root, "board.txt"), "utf8")).toBe("from board");
    expect(await fs.readFile(path.join(root, "mine.txt"), "utf8")).toBe("from run");
    await copies.collectStopped({ companyId, runId: copy.runId });
  });
  it("keeps an invalid warm checkpoint unsaved and requests stopped collection", async () => {
    const copy = await run({ warm: true });
    await fs.symlink(root, path.join(copy.localRoot, "escape"));
    const failed = await copies.checkpointWarm({ companyId, runId: copy.runId });
    expect(failed?.state).toBe("prepared");
    expect(failed?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(failed?.processStoppedAt).toBeNull();
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    await fs.rm(path.join(copy.localRoot, "escape"));
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unchanged");
  });
  // supersedes (fail-closed): the old test asserted the warm directory was deleted
  // (ENOENT) after an over-quota stopped save. It now asserts the source is held.
  it("supersedes: rejects over-quota warm changes without replacing saved bytes, then permits a clean future run → rejects over-quota warm changes without replacing saved bytes, retains them, then permits a clean future run", async () => {
    const copy = await run({ warm: true });
    const handle = await fs.open(path.join(copy.localRoot, "too-large.bin"), "w");
    await handle.truncate(MAX_AGENT_FILE_BYTES + 1); await handle.close();
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    const stopped = (await copies.collectStopped({ companyId, runId: copy.runId }))!;
    expect(stopped).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", errorMessage: AGENT_FILES_SAVE_PENDING_INSTRUCTION });
    expect(stopped.receipt?.storageWarning).toContain("Agent storage is full");
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
    expect((await fs.stat(path.join(copy.localRoot, "too-large.bin"))).size).toBe(MAX_AGENT_FILE_BYTES + 1);
    expect(agentFileSaveHeld(stopped)).toBe(true);
    expect(await run({ warm: true })).toBeTruthy();
  });
  // RED for smarty-dev#20814 (b13): a low-trust run that changed nothing must not be asked for write authority.
  const lowTrust = () => db.update(agents).set({ permissions: { trustPreset: "low_trust_review",
    authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: randomUUID() } } } }).where(eq(agents.id, agentId));
  it("b13 RED: a low-trust warm run that changed no agent file checkpoints cleanly and stays warm", async () => {
    await lowTrust();
    const copy = await run({ warm: true });
    const warn = vi.spyOn(logger, "warn");
    try {
      const saved = await copies.checkpointWarm({ companyId, runId: copy.runId });
      expect(warn.mock.calls.filter(call => call[1] === "Agent file checkpoint failed")).toEqual([]);
      expect(saved).toMatchObject({ state: "warm_saved", errorCode: null, errorMessage: null });
      expect(saved?.receipt?.checkpointState).toBe("unchanged");
      expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(true);
      expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unchanged");
    } finally { warn.mockRestore(); }
  });
  // Exercise the production heartbeat callback consumed by the native executor,
  // rather than duplicating its saved-state-to-boolean expression in this test.
  async function heartbeatCopy(copy: Awaited<ReturnType<typeof run>>, appendRunEvent = vi.fn(async (..._args: unknown[]) => {}),
    options: { previousRunId?: string; context?: Record<string, unknown> } = {}) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, copy.runId));
    type Input = Parameters<typeof createHeartbeatInstructionWorkingCopy>[0];
    const lifecycle = createHeartbeatInstructionWorkingCopy({ db, instructionCopies: copies,
      agent: agent!, readRun: () => currentRun!, context: options.context ?? {},
      session: { taskSession: options.previousRunId ? { lastRunId: options.previousRunId } : null,
        taskSessionForRun: null, sessionConfigMetadata: {} as Input["session"]["sessionConfigMetadata"] },
      workspace: { executionTarget: null, executionWorkspace: { cwd: home } as Input["workspace"]["executionWorkspace"], persistedExecutionWorkspace: null },
      appendRunEvent,
    });
    type Prepare = Parameters<typeof lifecycle.prepare>[0];
    await lifecycle.prepare({ runtimeConfig: {}, hasInstructionFilesystem: true,
      nativeRuntimeResolution: { kind: "native", profile: { backend: "pi_rpc" } } as Prepare["nativeRuntimeResolution"],
      nativeLifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } });
    expect(lifecycle.instructionCopy?.runId).toBe(copy.runId);
    return lifecycle;
  }
  it("keeps a sibling's saved note canonical when a parked chat's retirement checkpoint carries an older edit, and names both in the save event", async () => {
    await fs.mkdir(path.join(root, "memory"));
    await fs.writeFile(path.join(root, "memory", "x.md"), "C");
    const parked = await run({ warm: true });
    const appendRunEvent = vi.fn(async (..._args: unknown[]) => {});
    const lifecycle = await heartbeatCopy(parked, appendRunEvent);
    const sibling = await run();
    await fs.writeFile(path.join(sibling.localRoot, "memory", "x.md"), "B");
    expect((await copies.collectStopped({ companyId, runId: sibling.runId }))?.state).toBe("saved");
    await fs.writeFile(path.join(parked.localRoot, "memory", "x.md"), "A");
    await lifecycle.collectStoppedInstructions();
    expect(await fs.readFile(path.join(root, "memory", "x.md"), "utf8")).toBe("B");
    const hash = (text: string) => fileHash(Buffer.from(text));
    const save = lifecycle.getInstructionSave() as { state?: string; conflicts?: Array<{ conflictCopy: string }> } | null;
    expect(save).toMatchObject({ state: "saved", conflicts: [{ path: "memory/x.md", baseHash: hash("C"), currentHash: hash("B"), incomingHash: hash("A"),
      conflictCopy: expect.stringMatching(/^memory\/x\.conflict-[0-9a-z]{8}-\d+\.md$/) }] });
    const copyPath = save!.conflicts![0]!.conflictCopy;
    expect(copyPath.startsWith(`memory/x.conflict-${parked.runId.slice(0, 8)}-`)).toBe(true);
    expect(await fs.readFile(path.join(root, copyPath), "utf8")).toBe("A");
    expect(await agentFileStore(db).read(companyId, agentId, copyPath, board())).toEqual(Buffer.from("A"));
    const event = appendRunEvent.mock.calls.map(call => call[1] as { eventType: string; level: string; message: string; payload: Record<string, unknown> })
      .find(entry => entry.eventType === "instruction_save");
    expect(event).toMatchObject({ level: "warn", payload: { conflicts: save!.conflicts } });
    for (const text of ["memory/x.md", hash("B"), hash("A"), copyPath]) expect(event!.message).toContain(text);
    // A fresh chat starts from the sibling's note and sees the conflict copy.
    const fresh = await run();
    expect(await fs.readFile(path.join(fresh.localRoot, "memory", "x.md"), "utf8")).toBe("B");
    expect(await fs.readFile(path.join(fresh.localRoot, copyPath), "utf8")).toBe("A");
  });
  // Data-safety regression: use real saves, cleanup, the next run's prepare,
  // and the native envelope consumed on warm resume (not just save events).
  it.each([false, true])("carries a conflict notice into the next model input once, after cleanup (warm save: %s)", async warm => {
    await fs.mkdir(path.join(root, "memory"));
    await fs.writeFile(path.join(root, "memory/x.md"), "C");
    await fs.writeFile(path.join(root, "memory/y.md"), "C");
    const first = await run({ warm });
    await fs.writeFile(path.join(first.localRoot, "memory/x.md"), "A");
    await fs.unlink(path.join(first.localRoot, "memory/y.md"));
    await fs.writeFile(path.join(root, "memory/x.md"), "B");
    await fs.writeFile(path.join(root, "memory/y.md"), "B");
    const saved = warm ? await copies.checkpointWarm({ companyId, runId: first.runId })
      : await copies.collectStopped({ companyId, runId: first.runId });
    const conflicts = saved!.receipt!.conflicts as Array<{ path: string; conflictCopy: string | null }>;
    const copyPath = conflicts.find(item => item.path === "memory/x.md")!.conflictCopy!;
    // A no-change retirement checkpoint must not erase an undelivered notice.
    if (warm) await copies.collectStopped({ companyId, runId: first.runId });
    const next = await run();
    const context: Record<string, unknown> = {};
    await heartbeatCopy(next, undefined, { previousRunId: first.runId, context });
    const notice = context.paperclipAgentFileConflictNotice;
    expect(notice).toBe(`Note: "memory/x.md" was also saved by another run; that version was kept. Your earlier edit is saved as "${copyPath}".\nNote: "memory/y.md" was also saved by another run; that version was kept. Your earlier deletion was not applied.`);
    const modelInput = (text: unknown) => buildNativeExecutionInput({ companyId, agentId, runId: next.runId,
      issue: { id: randomUUID(), identifier: null, title: "Continue this chat", description: null, workMode: "standard" },
      taskPrompt: "Continue", agentFileConflictNotice: typeof text === "string" ? text : null,
      workspace: { id: next.runId, cwd: home, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: randomUUID(), resumedSession: true,
      previousTurn: { runId: first.runId, task: { title: "Continue this chat", description: null } },
      provider: "codex", completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Continue", criteria: [{ id: "answer", requirement: "Answer" }] } },
      runtimeContext: nativeRuntimeContextFixture() });
    for (const envelope of [buildNativeModelEnvelope(modelInput(notice)), buildNativeModelEnvelope(modelInput(notice), { resumedSession: true })]) {
      const text = JSON.stringify(envelope);
      expect(text).toContain(copyPath);
      expect(text).toContain("that version was kept");
      expect(text.split("Your earlier edit is saved as")).toHaveLength(2);
    }
    // Preparation retries, including a new facade after controller restart,
    // rebuild the same input without consuming another delivery.
    await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, next.runId));
    copies = agentInstructionWorkingCopyService(db);
    const retryContext: Record<string, unknown> = {};
    await heartbeatCopy(next, undefined, { previousRunId: first.runId, context: retryContext });
    expect(retryContext.paperclipAgentFileConflictNotice).toBe(notice);
    await copies.collectStopped({ companyId, runId: next.runId });
    const later = await run();
    const laterContext: Record<string, unknown> = {};
    await heartbeatCopy(later, undefined, { previousRunId: next.runId, context: laterContext });
    expect(laterContext.paperclipAgentFileConflictNotice ?? null).toBeNull();
    expect(JSON.stringify(buildNativeModelEnvelope(modelInput(laterContext.paperclipAgentFileConflictNotice), { resumedSession: true }))).not.toContain("Your earlier edit");
    expect(await fs.readFile(path.join(root, "memory/x.md"), "utf8")).toBe("B");
    expect(await fs.readFile(path.join(root, copyPath), "utf8")).toBe("A");
  });
  it("refreshes a still-warm conflicted tree and its baseline before same-root reuse, with a next-turn notice", async () => {
    await fs.mkdir(path.join(root, "memory"));
    await fs.writeFile(path.join(root, "memory/x.md"), "C");
    const first = await run({ warm: true });
    await fs.writeFile(path.join(first.localRoot, "memory/x.md"), "A");
    await fs.writeFile(path.join(root, "memory/x.md"), "B");
    const saved = (await copies.checkpointWarm({ companyId, runId: first.runId }))!;
    const [item] = saved.receipt!.conflicts as Array<{ conflictCopy: string }>;
    expect(await fs.readFile(path.join(first.localRoot, "memory/x.md"), "utf8")).toBe("B");
    expect(await fs.readFile(path.join(first.localRoot, item!.conflictCopy), "utf8")).toBe("A");
    expect(saved.receipt?.checkpointManifest).toMatchObject({ entries: expect.arrayContaining([
      ["memory/x.md", expect.objectContaining({ hash: fileHash(Buffer.from("B")) })],
    ]) });
    expect(await copies.canReuseWarm(companyId, agentId, first.runId)).toBe(true);
    const repeated = (await copies.checkpointWarm({ companyId, runId: first.runId }))!;
    expect(repeated.receipt?.checkpointState).toBe("unchanged");
    expect(repeated.receipt?.conflicts).toEqual([]);
    const next = await run({ warm: true, reuseRunId: first.runId });
    expect(next.localRoot).toBe(first.localRoot);
    const context: Record<string, unknown> = {};
    await heartbeatCopy(next, undefined, { previousRunId: first.runId, context });
    const notice = context.paperclipAgentFileConflictNotice;
    expect(notice).toBe(`Note: "memory/x.md" was also saved by another run; that version was kept. Your earlier edit is saved as "${item!.conflictCopy}".`);
    const input = buildNativeExecutionInput({ companyId, agentId, runId: next.runId,
      issue: { id: randomUUID(), identifier: null, title: "Continue", description: null, workMode: "standard" },
      taskPrompt: "Continue", agentFileConflictNotice: String(notice),
      workspace: { id: next.runId, cwd: home, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: randomUUID(), resumedSession: true,
      previousTurn: { runId: first.runId, task: { title: "Continue", description: null } },
      provider: "codex", completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Continue", criteria: [{ id: "answer", requirement: "Answer" }] } },
      runtimeContext: nativeRuntimeContextFixture() });
    expect(JSON.stringify(buildNativeModelEnvelope(input, { resumedSession: true }))).toContain(item!.conflictCopy);
    await fs.writeFile(path.join(next.localRoot, "memory/x.md"), "D");
    const later = (await copies.checkpointWarm({ companyId, runId: next.runId }))!;
    expect(later.receipt?.conflicts).toEqual([]);
    expect(await fs.readFile(path.join(root, "memory/x.md"), "utf8")).toBe("D");
    expect((await fs.readdir(path.join(root, "memory"))).filter(name => name.includes(".conflict-"))).toEqual([path.basename(item!.conflictCopy)]);
    await copies.collectStopped({ companyId, runId: next.runId });
  });
  it.each([false, true])("does not claim a sibling's file was kept when a folder replacement removed it (warm: %s)", async warm => {
    await fs.mkdir(path.join(root, "memory"));
    await fs.writeFile(path.join(root, "memory/x.md"), "C");
    const first = await run({ warm });
    const events = vi.fn(async (..._args: unknown[]) => {});
    const lifecycle = await heartbeatCopy(first, events);
    await fs.rm(path.join(first.localRoot, "memory"), { recursive: true });
    await fs.writeFile(path.join(first.localRoot, "memory"), "A replacement");
    await fs.writeFile(path.join(root, "memory/x.md"), "B");
    await lifecycle.collectStoppedInstructions();
    const save = lifecycle.getInstructionSave();
    expect(save).toMatchObject({ state: "saved", conflicts: [{ path: "memory/x.md", currentKept: false }] });
    expect(await fs.readFile(path.join(root, "memory"), "utf8")).toBe("A replacement");
    const event = events.mock.calls.map(call => call[1] as { eventType: string; message: string })
      .find(row => row.eventType === "instruction_save");
    expect(event?.message).toContain("not kept");
    expect(event?.message).not.toContain("and kept");
    expect(event?.message).not.toContain(`: kept ${fileHash(Buffer.from("B"))}`);
    const next = await run(), context: Record<string, unknown> = {};
    await heartbeatCopy(next, undefined, { previousRunId: first.runId, context });
    expect(context.paperclipAgentFileConflictNotice).toContain("that version was not kept");
    expect(context.paperclipAgentFileConflictNotice).not.toContain("that version was kept");
  });
  it("retires instead of overwriting a post-capture edit when refreshing a warm conflict", async () => {
    await fs.mkdir(path.join(root, "memory"));
    await fs.writeFile(path.join(root, "memory/x.md"), "C");
    const first = await run({ warm: true });
    await fs.writeFile(path.join(first.localRoot, "memory/x.md"), "A");
    await fs.writeFile(path.join(root, "memory/x.md"), "B");
    const actual = fileStoreModule.agentFileStore;
    const factory = vi.spyOn(fileStoreModule, "agentFileStore").mockImplementation((...args) => {
      const store = actual(...args), apply = store.apply;
      vi.spyOn(store, "apply").mockImplementation(async (...input) => {
        const saved = await apply(...input);
        // Real post-capture write, not a mocked merge/conflict result.
        await fs.writeFile(path.join(first.localRoot, "memory/x.md"), "A2");
        return saved;
      });
      return store;
    });
    try {
      copies = agentInstructionWorkingCopyService(db);
      const saved = (await copies.checkpointWarm({ companyId, runId: first.runId }))!;
      expect(saved).toMatchObject({ state: "warm_saved", errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE" });
      expect(saved.errorMessage).toContain("conflict save succeeded");
      expect(await copies.canReuseWarm(companyId, agentId, first.runId)).toBe(false);
      expect(await fs.readFile(path.join(first.localRoot, "memory/x.md"), "utf8")).toBe("A2");
      expect(await fs.readFile(path.join(root, "memory/x.md"), "utf8")).toBe("B");
      const files = (await fs.readdir(path.join(root, "memory"))).filter(name => name.includes(".conflict-"));
      expect(files).toHaveLength(1); // A committed save was not replayed on refresh failure.
      expect(await fs.readFile(path.join(root, "memory", files[0]!), "utf8")).toBe("A");
    } finally { factory.mockRestore(); copies = agentInstructionWorkingCopyService(db); }
    await copies.collectStopped({ companyId, runId: first.runId });
  });
  it("adds no next-turn notice after an ordinary save", async () => {
    const first = await run();
    await fs.writeFile(path.join(first.localRoot, "ordinary.md"), "Saved without a competing writer");
    await copies.collectStopped({ companyId, runId: first.runId });
    const next = await run(), context: Record<string, unknown> = {};
    await heartbeatCopy(next, undefined, { previousRunId: first.runId, context });
    expect(context.paperclipAgentFileConflictNotice ?? null).toBeNull();
  });
  it("b13 RED: the executor-facing checkpointWarm callback returns true for an unchanged low-trust turn", async () => {
    await lowTrust();
    const copy = await run({ warm: true });
    const lifecycle = await heartbeatCopy(copy);
    expect(await lifecycle.nativeInstructionWorkingCopy()!.checkpointWarm!()).toBe(true);
    expect(lifecycle.getInstructionSave()).toMatchObject({ state: "unchanged", errorCode: null });
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(true);
  });
  it("b13 KEEP: a low-trust warm run that changed an agent file is refused with the named reason and nothing is saved", async () => {
    await lowTrust();
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, "memory.txt"), "note written by an outside-triggered run");
    const refused = await copies.checkpointWarm({ companyId, runId: copy.runId });
    expect(refused?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(refused?.errorMessage).toContain("This low-trust run cannot change persistent agent instructions, including AGENTS.md");
    const stopped = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(stopped).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED" });
    await expect(fs.stat(path.join(root, "memory.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
  });
  // Instrument real stores without replacing their implementation or policy.
  function observedStore(afterWriteDenied?: () => Promise<void>) {
    const actual = fileStoreModule.agentFileStore;
    const stores: Array<ReturnType<typeof actual>> = [];
    const factory = vi.spyOn(fileStoreModule, "agentFileStore").mockImplementation((...args) => {
      const store = actual(...args);
      vi.spyOn(store, "apply");
      const locked = store.locked;
      vi.spyOn(store, "locked").mockImplementation((async (...args: Parameters<typeof locked>) => {
        try { return await locked(...args); }
        catch (error) {
          if (args[3]) await afterWriteDenied?.();
          throw error;
        }
      }) as typeof locked);
      stores.push(store);
      return store;
    });
    copies = agentInstructionWorkingCopyService(db);
    return { stores, restore() { factory.mockRestore(); copies = agentInstructionWorkingCopyService(db); } };
  }
  it.each(["one-byte", "added", "deleted", "renamed", "executable"] as const)(
    "b13 GUARD: low-trust %s mutation reaches real store.apply and is refused without saving", async mutation => {
      await lowTrust();
      await fs.writeFile(path.join(root, "note.txt"), "abc");
      await fs.chmod(path.join(root, "note.txt"), 0o600);
      const observed = observedStore();
      const commit = vi.spyOn(instructionAuthorization, "authorizeInstructionCommit");
      try {
        const before = await snapshotAgentFiles(root);
        const copy = await run({ warm: true });
        const note = path.join(copy.localRoot, "note.txt");
        if (mutation === "one-byte") await fs.writeFile(note, "abd");
        if (mutation === "added") await fs.writeFile(path.join(copy.localRoot, "new.txt"), "new");
        if (mutation === "deleted") await fs.unlink(note);
        if (mutation === "renamed") await fs.rename(note, path.join(copy.localRoot, "renamed.txt"));
        if (mutation === "executable") await fs.chmod(note, 0o700);
        const refused = await copies.checkpointWarm({ companyId, runId: copy.runId });
        expect(refused).toMatchObject({ state: "prepared", errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE", candidateHash: null });
        expect(refused?.receipt?.checkpointState).toBeUndefined();
        const apply = observed.stores.flatMap(store => vi.mocked(store.apply).mock.results);
        expect(apply).toHaveLength(1);
        await expect(apply[0]!.value).rejects.toMatchObject({ status: 403, details: { reason: "deny_low_trust_boundary" } });
        expect(commit).toHaveBeenCalledOnce();
        expect(await snapshotAgentFiles(root)).toEqual(before);
        expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unavailable");
        expect(await snapshotAgentFiles(root)).toEqual(before);
      } finally { commit.mockRestore(); observed.restore(); }
    });
  it("b13 GUARD: a low-trust added symlink is rejected before store.apply, not silently classified unchanged", async () => {
    await lowTrust();
    const observed = observedStore();
    const warn = vi.spyOn(logger, "warn");
    try {
      const before = await snapshotAgentFiles(root);
      const copy = await run({ warm: true });
      await fs.symlink(entryFile, path.join(copy.localRoot, "link"));
      const refused = await copies.checkpointWarm({ companyId, runId: copy.runId });
      expect(refused).toMatchObject({ state: "prepared", errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE", candidateHash: null });
      expect(refused?.receipt?.checkpointState).toBeUndefined();
      expect(observed.stores.flatMap(store => vi.mocked(store.apply).mock.calls)).toEqual([]);
      const failures = warn.mock.calls.filter(call => call[1] === "Agent file checkpoint failed");
      expect(failures).toHaveLength(3);
      for (const call of failures) expect(call[0]).toMatchObject({ err: { code: "AGENT_FILES_UNSAFE_PATH" } });
      expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unavailable");
      expect(await snapshotAgentFiles(root)).toEqual(before);
    } finally { warn.mockRestore(); observed.restore(); }
  });
  it("b13 GUARD: revoked read access after admission returns false and records no save or unchanged receipt", async () => {
    await lowTrust();
    const copy = await run({ warm: true });
    const lifecycle = await heartbeatCopy(copy);
    const before = await snapshotAgentFiles(root);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, userId));
    await expect(agentFileStore(db).read(companyId, agentId, entryFile,
      { type: "agent", companyId, agentId, runId: copy.runId })).rejects.toMatchObject({ status: 403, details: { code: "RESPONSIBLE_USER_UNAVAILABLE" } });
    expect(await lifecycle.nativeInstructionWorkingCopy()!.checkpointWarm!()).toBe(false);
    const refused = await copies.get(companyId, copy.runId);
    expect(refused).toMatchObject({ state: "prepared", candidateHash: null, errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE" });
    expect(refused?.receipt?.checkpointState).toBeUndefined();
    expect(lifecycle.getInstructionSave()).toMatchObject({ state: "pending_collection" });
    expect(await snapshotAgentFiles(root)).toEqual(before);
  });
  it("b13 GUARD: read access revoked between write refusal and fallback cannot record unchanged", async () => {
    await lowTrust();
    const copy = await run({ warm: true });
    const before = await snapshotAgentFiles(root);
    // A real membership revocation after the write transaction has rejected,
    // before a possible read transaction. No authorization decision is faked.
    let revocations = 0;
    const observed = observedStore(async () => {
      revocations++;
      await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, userId));
    });
    const read = vi.spyOn(instructionAuthorization, "authorizeInstructionRead");
    try {
      const lifecycle = await heartbeatCopy(copy);
      read.mockClear();
      expect(await lifecycle.nativeInstructionWorkingCopy()!.checkpointWarm!()).toBe(false);
      const checkpoint = await copies.get(companyId, copy.runId);
      expect(revocations).toBe(1);
      expect(checkpoint).toMatchObject({ state: "prepared", errorCode: "AGENT_FILES_CHECKPOINT_UNSTABLE", candidateHash: null });
      expect(checkpoint?.receipt?.checkpointState).toBeUndefined();
      // Base has no fallback; candidate must not turn a failed fallback into a
      // successful receipt. Retain the actual attempt count as judge evidence.
      console.info("b13 read-revocation observation", { readFallbackAttempts: read.mock.calls.length });
      for (const result of read.mock.results) await expect(result.value).rejects.toMatchObject({ status: 403,
        details: { code: "RESPONSIBLE_USER_UNAVAILABLE" } });
      expect(lifecycle.getInstructionSave()).toMatchObject({ state: "pending_collection" });
      expect(await snapshotAgentFiles(root)).toEqual(before);
    } finally { read.mockRestore(); observed.restore(); }
  });
  it("b13 GUARD: normal-trust unchanged warm checkpoint uses the write recheck with no read fallback", async () => {
    const copy = await run({ warm: true });
    const observed = observedStore();
    const read = vi.spyOn(instructionAuthorization, "authorizeInstructionRead");
    const commit = vi.spyOn(instructionAuthorization, "authorizeInstructionCommit");
    try {
      const before = await snapshotAgentFiles(root);
      const saved = await copies.checkpointWarm({ companyId, runId: copy.runId });
      expect(saved).toMatchObject({ state: "warm_saved", errorCode: null, receipt: { checkpointState: "unchanged" } });
      expect(commit).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
      expect(observed.stores.flatMap(store => vi.mocked(store.apply).mock.calls)).toEqual([]);
      expect(observed.stores.flatMap(store => vi.mocked(store.locked).mock.calls).map(call => call[3])).toEqual([true]);
      expect(await snapshotAgentFiles(root)).toEqual(before);
    } finally { read.mockRestore(); commit.mockRestore(); observed.restore(); }
  });
  it("rechecks authorization even for an unchanged warm checkpoint", async () => {
    const copy = await run({ warm: true });
    await copies.checkpointWarm({ companyId, runId: copy.runId });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, companyId));
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unavailable");
  });
  it("reclaims a warm remote owner after verified sandbox destruction without claiming unsaved tail bytes", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, "saved.txt"), "checkpoint");
    await copies.checkpointWarm({ companyId, runId: copy.runId });
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "destroyed-warm" };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ ...lease, status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native" }).where(eq(heartbeatRuns.id, copy.runId));
    const saved = (await copies.get(companyId, copy.runId))!;
    await db.update(agentInstructionWorkingCopies).set({ location: `remote:${environmentId}`,
      executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...saved.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    const recovered = (await copies.get(companyId, copy.runId))!;
    expect(recovered).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_FINAL_COLLECTION_UNAVAILABLE" });
    expect(recovered.receipt?.cleanupPending).toBe(false);
    expect(await fs.readFile(path.join(root, "saved.txt"), "utf8")).toBe("checkpoint");
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses the workspace transport to restore after destruction of the remote filesystem", async () => {
    const remoteCwd = path.join(home, "remote-task");
    await fs.mkdir(remoteCwd, { recursive: true });
    await execFile("git", ["init", remoteCwd]);
    const runner: import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner = {
      execute: async input => {
        const startedAt = new Date().toISOString();
        const env = { ...process.env, ...input.env };
        const args = [...(input.args ?? [])];
        if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        try {
          const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
        } catch (error) {
          const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
          return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
        }
      },
    };
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), leaseId: "", remoteCwd, runner };
    await db.insert(environments).values({ id: executionTarget.environmentId, name: "Fixture sandbox", driver: "sandbox" });
    const prepare = async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      executionTarget.leaseId = randomUUID();
      await db.insert(environmentLeases).values({ id: executionTarget.leaseId, companyId, environmentId: executionTarget.environmentId,
        heartbeatRunId: runId, provider: "daytona", providerLeaseId: "fixture-allocation" });
      return (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget }))!;
    };
    await fs.mkdir(path.join(root, "build"));
    await fs.writeFile(path.join(root, "build", "personal.txt"), "cache-like names are still agent files");
    const first = await prepare();
    const firstScratch = path.join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "agent-file-transfers", agentId, first.runId);
    expect(await fs.readdir(firstScratch)).toEqual([]);
    await expect(fs.stat(path.join(first.executionRoot, ".paperclip-runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(first.executionRoot, "build", "personal.txt"), "utf8")).toBe("cache-like names are still agent files");
    await fs.mkdir(path.join(first.executionRoot, "notes"));
    await fs.writeFile(path.join(first.executionRoot, "notes", "bytes.bin"), Buffer.from([0, 128, 255]));
    await fs.mkdir(path.join(first.executionRoot, "node_modules"));
    await fs.writeFile(path.join(first.executionRoot, "node_modules", "personal.txt"), "retain this too");
    await fs.writeFile(path.join(remoteCwd, "task-only.txt"), "task");
    expect((await execFile("git", ["-C", remoteCwd, "status", "--porcelain", "--untracked-files=all"])).stdout).toBe("?? task-only.txt\n");
    expect((await copies.collectStopped({ companyId, runId: first.runId, target: executionTarget }))?.state).toBe("saved");
    await copies.release(companyId, first.runId);
    await expect(fs.stat(firstScratch)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await copies.get(companyId, first.runId))?.receipt?.baseline).toBeUndefined();
    await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(remoteCwd, { recursive: true });
    await fs.mkdir(remoteCwd);
    copies = agentInstructionWorkingCopyService(db);
    const second = await prepare();
    expect(await fs.readFile(path.join(second.executionRoot, "notes", "bytes.bin"))).toEqual(Buffer.from([0,128,255]));
    expect(await fs.readFile(path.join(second.executionRoot, "node_modules", "personal.txt"), "utf8")).toBe("retain this too");
    await expect(fs.stat(path.join(second.executionRoot, "task-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await copies.collectStopped({ companyId, runId: second.runId, target: executionTarget });
    await copies.release(companyId, second.runId);
  });

  it("checkpoints and reuses the remote directory through the real transport without copying unchanged bytes", async () => {
    const remoteCwd = path.join(home, "warm-remote-task");
    await fs.mkdir(remoteCwd, { recursive: true });
    const runner: import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner = {
      execute: async input => {
        const startedAt = new Date().toISOString();
        const env = { ...process.env, ...input.env };
        const args = [...(input.args ?? [])];
        if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        try {
          const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
        } catch (error) {
          const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
          return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
        }
      },
    };
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), leaseId: "", remoteCwd, runner };
    await db.insert(environments).values({ id: executionTarget.environmentId, name: "Warm fixture sandbox", driver: "sandbox" });
    const prepare = async (reuseRunId?: string) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      executionTarget.leaseId = randomUUID();
      await db.insert(environmentLeases).values({ id: executionTarget.leaseId, companyId, environmentId: executionTarget.environmentId,
        heartbeatRunId: runId, provider: "daytona", providerLeaseId: "warm-fixture-allocation" });
      return (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget, warm: true, reuseRunId }))!;
    };
    let copy = await prepare();
    const original = copy;
    await fs.writeFile(path.join(copy.executionRoot, "image.bin"), Buffer.alloc(32768, 93));
    for (let turn = 1; turn <= 3; turn++) {
      await fs.appendFile(path.join(copy.executionRoot, "memory.txt"), `turn ${turn}\n`);
      const saved = (await copies.checkpointWarm({ companyId, runId: copy.runId, target: executionTarget }))!;
      expect(saved, JSON.stringify({ code: saved.errorCode, message: saved.errorMessage })).toMatchObject({ state: "warm_saved", errorCode: null });
      if (turn > 1) expect(saved.receipt?.checkpointStats).toMatchObject({ copiedFiles: 1, copiedBytes: turn * 7, hashedBytes: turn * 7 });
      expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe(Array.from({ length: turn }, (_, i) => `turn ${i + 1}\n`).join(""));
      expect((await fs.readdir(path.dirname(copy.localRoot))).filter(name => name.startsWith("checkpoint-"))).toEqual([]);
      expect((await fs.readdir(path.join(copy.executionRoot, ".paperclip-runtime"))).filter(name => name.startsWith("checkpoint-"))).toEqual([]);
      if (turn < 3) { copy = await prepare(copy.runId); expect(copy.executionRoot).toBe(original.executionRoot); }
    }
    await copies.collectStopped({ companyId, runId: original.runId, target: executionTarget });
    expect(await fs.stat(copy.executionRoot)).toBeTruthy();
    expect((await copies.collectStopped({ companyId, runId: copy.runId, target: executionTarget }))?.receipt).toMatchObject({ cleanupPending: false });
    await expect(fs.stat(copy.executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages SSH agent files at the registered root without a nested task workspace", async () => {
    const remoteCwd = path.join(home, "ssh-task");
    const exclude = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null });
    const stage = vi.spyOn(ssh, "syncDirectoryToSsh").mockImplementation(async input => {
      await fs.mkdir(path.dirname(input.remoteDir), { recursive: true });
      await fs.cp(input.localDir, input.remoteDir, { recursive: true });
    });
    const restore = vi.spyOn(ssh, "restoreWorkspaceFromSshExecution").mockImplementation(async input => {
      await fs.cp(input.remoteDir!, input.localDir, { recursive: true });
    });
    try {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      const target = { kind: "remote" as const, transport: "ssh" as const, environmentId: randomUUID(), remoteCwd,
        spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd, remoteWorkspacePath: remoteCwd, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
      await db.insert(environments).values({ id: target.environmentId, name: "Fixture SSH", driver: "ssh" });
      // Legacy no-ID receipt: only the unique run/environment lease authorizes retrieval.
      await db.insert(environmentLeases).values({ companyId, environmentId: target.environmentId, heartbeatRunId: runId, provider: "ssh", providerLeaseId: "fixture-host" });
      const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home, target }))!;
      expect(stage).toHaveBeenCalledWith(expect.objectContaining({ remoteDir: copy.executionRoot }));
      expect(await fs.readFile(path.join(copy.executionRoot, entryFile), "utf8")).toBe(initial);
      await fs.writeFile(path.join(copy.executionRoot, "ssh-note.txt"), "persistent SSH file");
      expect((await copies.collectStopped({ companyId, runId, target }))?.state).toBe("saved");
      expect(restore).toHaveBeenCalledWith(expect.objectContaining({ remoteDir: copy.executionRoot, restoreGitHistory: false }));
      expect(await fs.readFile(path.join(root, "ssh-note.txt"), "utf8")).toBe("persistent SSH file");
    } finally { stage.mockRestore(); restore.mockRestore(); exclude.mockRestore(); }
  });

  it("deduplicates concurrent stopped callbacks and discards completed operational snapshots", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "note.txt"), "one write");
    const results = await Promise.all([copies.collectStopped({ companyId, runId: copy.runId }), copies.collectStopped({ companyId, runId: copy.runId })]);
    expect(results.every(result => result?.state === "saved")).toBe(true);
    // Simulate a crash after save but before release. The restart sweeper must
    // reclaim operational baselines without touching canonical files.
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    const row = await copies.get(companyId, copy.runId);
    expect(row?.receipt?.schema).toBe("paperclip.agent-files.v1");
    expect(row?.receipt?.baseline).toBeUndefined();
    expect(await fs.readFile(path.join(root, "note.txt"), "utf8")).toBe("one write");
  });

  it.each(["prepared", "unavailable", "warm_saved", "superseded", "saved", "unchanged", "resolved"])(
    "does not acquire a held directory lock for a no-op %s release", async state => {
      const copy = await run();
      const stopped = ["superseded", "saved", "unchanged", "resolved"].includes(state);
      await db.update(agentInstructionWorkingCopies).set({ state, processStoppedAt: stopped ? new Date() : null,
        receipt: { ...copy.receipt, ...(stopped ? { cleanupPending: false } : {}) } })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      const before = await copies.get(companyId, copy.runId);
      await withDirectoryMergeLock(path.resolve(copy.localRoot, "../../.."), async () => {
        // Any attempted nested acquisition fails promptly instead of hanging the test.
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 31_000);
        try { await copies.release(companyId, copy.runId); } finally { clock.mockRestore(); }
        expect(await copies.get(companyId, copy.runId)).toEqual(before);
        expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
      });
    });

  async function unavailableRemote(options: { state?: "stopped" | "destroyed"; receiptMismatch?: string } = {}) {
    const copy = await run();
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/cleanup-task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "cleanup-fixture" };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    const receipt = options.state ? remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: options.state })! : undefined;
    if (receipt && options.receiptMismatch) (receipt as Record<string, unknown>)[options.receiptMismatch] = randomUUID();
    await db.insert(environmentLeases).values({ ...lease, ...(receipt ? { status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: receipt } } : {}) });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, copy.runId));
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE",
      errorMessage: "Fixture could not collect files", candidateHash: "preserved-candidate", candidateBase64: Buffer.from("preserved bytes").toString("base64"), attempts: 3,
      location: `remote:${environmentId}`, executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...copy.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    return { copy: (await copies.get(companyId, copy.runId))!, lease, environmentId };
  }

  it.each(["destroyed", "stopped", "broken_handoff", "extra_owner", "foreign_company"] as const)(
    "recovers an earlier remote copy only from the exact destroyed successor chain (%s)", async scenario => {
      const { copy, lease } = await unavailableRemote();
      const issueId = randomUUID(), successorRunId = randomUUID(), successorId = randomUUID();
      const acquiredAt = new Date(Date.now() - 2000), handoffAt = new Date(Date.now() - 1000);
      await db.insert(issues).values({ id: issueId, companyId, title: "Completed retained workspace", status: "done" });
      await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, invocationSource: "on_demand", status: "succeeded" });
      const [previous] = await db.update(environmentLeases).set({ status: "expired", leasePolicy: "reuse_by_environment",
        issueId, acquiredAt, releasedAt: handoffAt, cleanupStatus: "success", metadata: { agentId } })
        .where(eq(environmentLeases.id, lease.id)).returning();
      const successor = { ...previous!, id: successorId, heartbeatRunId: successorRunId, acquiredAt: handoffAt,
        releasedAt: new Date(), metadata: { agentId } };
      if (scenario === "foreign_company") {
        const foreignCompanyId = randomUUID();
        await db.insert(companies).values({ id: foreignCompanyId, name: "Unrelated owner", issuePrefix: randomUUID().slice(0, 8) });
        successor.companyId = foreignCompanyId;
      }
      const handoff = createReusableLeaseHandoff(previous!, successor);
      const termination = remoteTerminationReceipt(successor, { providerLeaseId: lease.providerLeaseId,
        state: scenario === "stopped" ? "stopped" : "destroyed" });
      await db.update(environmentLeases).set({ metadata: { agentId, reusableLeaseSuccessor: handoff } })
        .where(eq(environmentLeases.id, lease.id));
      await db.insert(environmentLeases).values({ ...successor, metadata: { agentId, remoteExecutionTermination: termination,
        reusableLeasePredecessor: scenario === "broken_handoff" ? { ...handoff, handoffId: randomUUID() } : handoff } });
      if (scenario === "extra_owner") await db.insert(environmentLeases).values({ ...lease, id: randomUUID(), status: "active" });
      await db.update(agentInstructionWorkingCopies).set({ state: "pending_collection", attempts: 0, candidateHash: null, candidateBase64: null })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockRejectedValue(new Error("must not execute"));
      try {
        await copies.recoverStopped();
        const recovered = (await copies.get(companyId, copy.runId))!;
        if (scenario === "destroyed") {
          expect(recovered).toMatchObject({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE",
            receipt: { cleanupPending: false }, nextAttemptAt: null });
          expect(recovered.processStoppedAt).toBeInstanceOf(Date);
          await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(recovered).toMatchObject({ state: "pending_collection", processStoppedAt: null });
          expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
        }
        expect(shell).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
        const [historical] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
        expect(historical!.metadata).not.toHaveProperty("remoteExecutionTermination");
      } finally { shell.mockRestore(); }
    });

  it.each([undefined, "stopped", "companyId", "runId", "leaseId", "provider", "providerLeaseId"])(
    "defers unavailable cleanup without exact destruction proof (%s)", async proof => {
      const { copy } = await unavailableRemote({ state: proof === undefined ? undefined : proof === "stopped" ? "stopped" : "destroyed",
        receiptMismatch: proof && proof !== "stopped" ? proof : undefined });
      const execute = vi.fn();
      copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
      const before = Date.now();
      await withDirectoryMergeLock(path.resolve(copy.localRoot, "../../.."), () => copies.recoverStopped());
      const deferred = (await copies.get(companyId, copy.runId))!;
      expect(deferred).toMatchObject({ state: "unavailable", processStoppedAt: null, attempts: 3,
        candidateHash: copy.candidateHash, candidateBase64: copy.candidateBase64, errorCode: copy.errorCode, errorMessage: copy.errorMessage, receipt: copy.receipt });
      expect(deferred.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
      expect(await copies.recoverStopped()).toBe(0);
      expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
      expect(execute).not.toHaveBeenCalled();
    });

  it("cleans an unavailable copy after exact destruction without claiming a save or executing remotely", async () => {
    const { copy, environmentId } = await unavailableRemote({ state: "destroyed" });
    await fs.writeFile(path.join(copy.localRoot, "unsaved.txt"), "unsaved edit");
    await db.delete(environments).where(eq(environments.id, environmentId));
    const execute = vi.fn();
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockRejectedValue(new Error("must not execute"));
    copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    try {
      await copies.recoverStopped();
      const recovered = (await copies.get(companyId, copy.runId))!;
      expect(recovered).toMatchObject({ state: "unavailable", candidateHash: copy.candidateHash, candidateBase64: copy.candidateBase64, attempts: 3,
        errorCode: copy.errorCode, errorMessage: copy.errorMessage, receipt: { cleanupPending: false } });
      expect(recovered.processStoppedAt).toBeInstanceOf(Date);
      expect(recovered.nextAttemptAt).toBeNull();
      await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(root, "unsaved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
      expect(execute).not.toHaveBeenCalled(); expect(shell).not.toHaveBeenCalled();
    } finally { shell.mockRestore(); }
  });

  it.each([false, true])("preserves uncollected local edits and their unavailable receipt even after local stop proof (%s)", async stopped => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "unsaved-local.txt"), "recoverable local edit");
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native" }).where(eq(heartbeatRuns.id, copy.runId));
    await copies.reportUnavailable(companyId, copy.runId);
    if (stopped) await db.insert(heartbeatRunEvents).values({ companyId, runId: copy.runId, agentId, seq: 1, eventType: "native.local_process_stopped", stream: "system", level: "info", message: "fixture stop" });
    const before = (await copies.get(companyId, copy.runId))!;
    expect(before).toMatchObject({ state: "unavailable", attempts: 0, processStoppedAt: null });
    await copies.recoverStopped();
    const patch = vi.fn(async () => { throw new Error("local copy must not be changed"); });
    await agentDirectoryWorkingCopyService(db, copies.get, patch).recoverUnavailable(before);
    expect(patch).not.toHaveBeenCalled();
    expect(await copies.get(companyId, copy.runId)).toEqual(before);
    expect(await fs.readFile(path.join(copy.localRoot, "unsaved-local.txt"), "utf8")).toBe("recoverable local edit");
    await expect(fs.stat(path.join(root, "unsaved-local.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes same-run preparation after recovery commits stop proof and before it removes bytes", async () => {
    const { copy, lease } = await unavailableRemote({ state: "destroyed" });
    const remoteCwd = "/fixture/cleanup-task";
    const executionTarget = { kind: "remote" as const, transport: "ssh" as const, environmentId: lease.environmentId, leaseId: lease.id, remoteCwd,
      spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd, remoteWorkspacePath: remoteCwd, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null });
    const stage = vi.spyOn(ssh, "syncDirectoryToSsh").mockResolvedValue(undefined);
    let stopCommitted!: () => void, finishCleanup!: () => void;
    const committed = new Promise<void>(resolve => { stopCommitted = resolve; });
    const proceed = new Promise<void>(resolve => { finishCleanup = resolve; });
    const directories = agentDirectoryWorkingCopyService(db, copies.get, async (row, values) => {
      const [updated] = await db.update(agentInstructionWorkingCopies).set(values).where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
      if (values.processStoppedAt) { stopCommitted(); await proceed; }
      return updated!;
    });
    const recovering = directories.recoverUnavailable(copy);
    await committed;
    let prepareSettled = false;
    const preparing = copies.prepare({ ...target(), runId: copy.runId, cwd: home, target: executionTarget }).then(row => { prepareSettled = true; return row; });
    try {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(prepareSettled).toBe(false);
        expect((await copies.get(companyId, copy.runId))?.state).toBe("unavailable");
      } finally { finishCleanup(); await recovering; }
      const prepared = await preparing;
      expect(prepared).toMatchObject({ state: "prepared", processStoppedAt: null });
      expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
      // A stale cleanup callback now observes the live lifecycle and does nothing.
      await directories.release(copy);
      expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
    } finally { shell.mockRestore(); stage.mockRestore(); }
  });

  it("keeps stopped pending cleanup behind a held lock and lets recovery proceed to other agents", async () => {
    const blocked = await run();
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date() }).where(eq(agentInstructionWorkingCopies.runId, blocked.runId));
    // A distinct canonical agent has its own lifecycle lock.
    const firstAgent = agentId, firstRoot = root;
    agentId = randomUUID();
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Other", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Other", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, membershipRole: "member" });
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [firstAgent, agentId] } }).where(eq(principalPermissionGrants.companyId, companyId));
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true }); await fs.writeFile(path.join(root, entryFile), initial);
    const other = await run();
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date() }).where(eq(agentInstructionWorkingCopies.runId, other.runId));
    agentId = firstAgent; root = firstRoot;
    await withDirectoryMergeLock(path.resolve(blocked.localRoot, "../../.."), async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 31_000);
      try {
        await expect(copies.release(companyId, blocked.runId)).rejects.toMatchObject({ code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT" });
        await copies.recoverCaptured();
      } finally { clock.mockRestore(); }
      expect((await copies.get(companyId, blocked.runId))?.nextAttemptAt).toBeInstanceOf(Date);
      expect(await fs.readFile(path.join(blocked.localRoot, entryFile), "utf8")).toBe(initial);
      await expect(fs.stat(other.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
    // A fresh recovery worker retries after the holder releases the lock. It
    // cleans the pending copy without changing the failed-save receipt.
    const deferred = (await copies.get(companyId, blocked.runId))!;
    await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: new Date(0) })
      .where(eq(agentInstructionWorkingCopies.runId, blocked.runId));
    await agentInstructionWorkingCopyService(db).recoverCaptured();
    expect(await copies.get(companyId, blocked.runId)).toMatchObject({ state: deferred.state,
      errorCode: deferred.errorCode, errorMessage: deferred.errorMessage,
      candidateHash: deferred.candidateHash, receipt: { cleanupPending: false }, nextAttemptAt: null });
    await expect(fs.stat(blocked.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["environment", "path", "lease-run"])("rejects destruction outside the registered copy binding (%s)", async mismatch => {
    const { copy, lease } = await unavailableRemote({ state: "destroyed" });
    if (mismatch === "environment") await db.update(agentInstructionWorkingCopies).set({ location: `remote:${randomUUID()}` }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    if (mismatch === "path") await db.update(agentInstructionWorkingCopies).set({ executionRoot: "/fixture/foreign" }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    if (mismatch === "lease-run") {
      const other = await run();
      const moved = { ...lease, heartbeatRunId: other.runId };
      await db.update(environmentLeases).set({ heartbeatRunId: other.runId, metadata: { remoteExecutionTermination: remoteTerminationReceipt(moved, { providerLeaseId: moved.providerLeaseId, state: "destroyed" }) } }).where(eq(environmentLeases.id, lease.id));
    }
    await copies.recoverStopped();
    expect((await copies.get(companyId, copy.runId))?.processStoppedAt).toBeNull();
    expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
  });

  it("backs off an unproven batch so the next unavailable copy can be cleaned", async () => {
    const deferred: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { copy } = await unavailableRemote();
      deferred.push(copy.runId);
      await db.update(agentInstructionWorkingCopies).set({ updatedAt: new Date(i) }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    }
    const { copy: ready } = await unavailableRemote({ state: "destroyed" });
    await db.update(agentInstructionWorkingCopies).set({ updatedAt: new Date(20) }).where(eq(agentInstructionWorkingCopies.runId, ready.runId));
    await copies.recoverStopped();
    expect((await copies.get(companyId, ready.runId))?.processStoppedAt).toBeNull();
    await copies.recoverStopped();
    expect((await copies.get(companyId, ready.runId))?.receipt?.cleanupPending).toBe(false);
    for (const runId of deferred) expect(await copies.get(companyId, runId)).toMatchObject({ state: "unavailable", processStoppedAt: null, attempts: 3 });
  });

  it("continues cleanup when the retry reservation fails for the first copy", async () => {
    const first = await run(), second = await run();
    for (const [index, copy] of [first, second].entries()) {
      await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date(), updatedAt: new Date(index),
        errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", candidateHash: "preserved", candidateBase64: Buffer.from("candidate").toString("base64") })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    }
    const before = await copies.get(companyId, first.runId);
    const failReservation = () => { throw new Error("fixture retry-reservation write failure"); };
    const update = vi.spyOn(db, "transaction").mockImplementationOnce(failReservation);
    try { await copies.recoverCaptured(); } finally { update.mockRestore(); }
    expect(await copies.get(companyId, first.runId)).toEqual(before);
    expect(await fs.readFile(path.join(first.localRoot, entryFile), "utf8")).toBe(initial);
    expect(await copies.get(companyId, second.runId)).toMatchObject({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", candidateHash: "preserved", receipt: { cleanupPending: false } });
    await expect(fs.stat(second.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("does not execute a cached transport after destruction, including an ambiguous stop-proof commit (%s)", async interrupted => {
    const runId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/cached-task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: runId, provider: "daytona", providerLeaseId: "cached-fixture" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values(lease);
    const execute = vi.fn(), restoreWorkspace = vi.fn(), cleanupWorkspaceSnapshot = vi.fn().mockResolvedValue(undefined);
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId, leaseId, remoteCwd, runner: { execute } };
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null });
    const stage = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementation(async options => ({ target: executionTarget,
      workspaceRemoteDir: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, runId), runtimeRootDir: options.runtimeRootDir ?? null,
      assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null, restoreWorkspace, cleanupWorkspaceSnapshot }));
    try {
      const copy = (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget }))!;
      await copies.reportUnavailable(companyId, runId);
      await copies.release(companyId, runId);
      expect(cleanupWorkspaceSnapshot).not.toHaveBeenCalled();
      shell.mockClear(); stage.mockClear();
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } }).where(eq(environmentLeases.id, leaseId));
      if (interrupted) {
        const directories = agentDirectoryWorkingCopyService(db, copies.get, async (row, values) => {
          const [updated] = await db.update(agentInstructionWorkingCopies).set(values).where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
          if (values.processStoppedAt) throw new Error("fixture lost update response after commit");
          return updated!;
        });
        await expect(directories.recoverUnavailable((await copies.get(companyId, runId))!)).rejects.toThrow("lost update response");
        expect((await copies.get(companyId, runId))?.receipt?.cleanupDestroyedOnly).toBe(true);
        await copies.recoverCaptured();
      } else await copies.recoverStopped();
      expect(await copies.get(companyId, runId)).toMatchObject({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", receipt: { cleanupPending: false } });
      await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(cleanupWorkspaceSnapshot).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled(); expect(restoreWorkspace).not.toHaveBeenCalled(); expect(shell).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled();
    } finally { shell.mockRestore(); stage.mockRestore(); }
  });

});
