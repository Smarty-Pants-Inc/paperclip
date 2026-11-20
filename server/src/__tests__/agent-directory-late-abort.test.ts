import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { agentFileRoots, agentInstructionWorkingCopies, agents, authUsers, closeFileStorageDb, companies, companyMemberships, createDb, environmentLeases,
  environments, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionWorkingCopyService, collectStoppedInstructionCopyWithRetries } from "../services/agent-instruction-working-copies.js";
import { AgentDirectoryOperationBusyError, agentFileSaveHeld, drainAgentFileCheckpoints } from "../services/agent-directory-working-copies.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { agentFileCopiesToCollectOnLease, agentFileCopyRetirementSettled, holdUncollectedAgentFileCopy } from "../services/agent-file-save-hold.js";
import * as saveHold from "../services/agent-file-save-hold.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { fileHash, snapshotAgentFiles } from "../services/agent-file-store.js";
import * as fileStoreModule from "../services/agent-file-store.js";
import * as fileDurability from "../services/agent-file-durability.js";
import * as storageModule from "../storage/index.js";

const execFile = promisify(execFileCallback);

// LATE-ABORT (RFL + rf-3 agreed contract). Person case: a stopped agent's
// working copy is collected into the canonical files and the collection is
// aborted AFTER the canonical write began. Boundary of every row: the real
// collector (agentInstructionWorkingCopyService.collectStopped) -> the real
// agentFileStore.apply -> the real persistDurableAgentFiles, real PostgreSQL,
// real files, and the collector's advisory lock read from an INDEPENDENT pool.
// Not real: the object store (an in-memory stand-in for S3) and the sandbox
// (its commands run as local child processes). Codes are string literals on
// purpose, so the rows also run (red) against a tree without the fix. Every
// row writes its observations as evidence first and then checks them all
// (expect.soft), so a red run lists every broken fact, not only the first.
describe("agent directory collection aborted after the canonical commit boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  /** The independent pool: every lock, row and manifest observation reads here. */
  let observer: ReturnType<typeof createDb>;
  const extraDbs: Array<ReturnType<typeof createDb>> = [];
  let home: string, companyId: string, agentId: string, userId: string, root: string, remoteCwd: string;
  const entryFile = "AGENTS.md";
  const noteName = "late-abort-note.txt";
  let abortSignal: AbortSignal | null = null;
  const runnerCalls: Array<{ afterAbort: boolean }> = [];
  const releases: Array<() => void> = [];
  const objects = new Map<string, Buffer>();
  /** Every real store.apply of every service built in a row (counted around the real call). */
  const applyCount = { started: 0, settled: 0 };
  let lastApplySettledAt = 0;
  /** R6: armed by plantAbortInReleaseCleanup; consumed by the sandbox runner below. */
  let cleanupFault: { armed: boolean; controller: AbortController; reason: Error; reached: () => void; gate: Promise<void> } | null = null;
  /** R8: counts remote capture commands; the second one (the retry's) aborts and hangs. */
  let captureFault: { captures: number; controller: AbortController; reason: Error; reached: () => void; gate: Promise<void> } | null = null;
  /** R11: while armed, the object-store stand-in rejects every upload (PLANTED at its putFile line below). */
  let objectStoreFault: { armed: boolean; rejected: number } | null = null;
  /** R10-R14: SQL that removes a fault planted in PostgreSQL; always run after the row. */
  const plantedInPostgres: string[] = [];

  const evidence = async (name: string, proof: unknown) => {
    if (process.env.TASK_OUT) await fs.writeFile(path.join(process.env.TASK_OUT, name), JSON.stringify(proof, null, 2));
  };
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /** In-memory stand-in for the shared object store (provider "s3"). */
  const memoryStorage = () => ({
    provider: "s3" as const,
    async putFile(input: { companyId: string; namespace: string; body: Readable; byteSize: number; sha256: string }) {
      if (objectStoreFault?.armed) {
        objectStoreFault.rejected++;
        throw new Error("PLANTED persist failure: object storage rejects the upload"); // PLANTED FAILURE (R11): every upload while armed
      }
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (body.length !== input.byteSize || fileHash(body) !== input.sha256) throw new Error("fixture object does not match its digest");
      const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
      objects.set(objectKey, body);
      return { objectKey };
    },
    async getObject(_owner: string, objectKey: string) {
      const body = objects.get(objectKey);
      if (!body) throw new Error("fixture object missing");
      return { stream: Readable.from([body]) };
    },
    async headObject(_owner: string, key: string) { return { exists: objects.has(key), lastModified: new Date(0) }; },
    async deleteObject(_owner: string, key: string) { objects.delete(key); },
  });

  /** The sandbox: every remote command runs as a local child process. */
  const runner: CommandManagedRuntimeRunner = {
    execute: async input => {
      runnerCalls.push({ afterAbort: abortSignal?.aborted === true });
      const startedAt = new Date().toISOString();
      const env = { ...process.env, ...input.env };
      const args = [...(input.args ?? [])];
      if (captureFault && args.some(arg => arg.includes("--checkpoint")) && ++captureFault.captures === 2) {
        const fault = captureFault;
        fault.controller.abort(fault.reason); // PLANTED ABORT: inside the retry attempt's remote capture command
        fault.reached();
        await fault.gate; // PLANTED HANG: that capture command stays in flight until release()
      }
      if (cleanupFault?.armed && args.some(arg => arg.includes("rm -rf -- "))) {
        const fault = cleanupFault;
        fault.armed = false;
        fault.controller.abort(fault.reason); // PLANTED ABORT: inside the release's remote cleanup, after the save was recorded
        fault.reached();
        await fault.gate; // PLANTED HANG: that cleanup command stays in flight until release()
      }
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

  /** A warm copy on a remote sandbox of an ephemeral server: the path whose
   * collector takes the session advisory lock on a dedicated connection. */
  async function stoppedRunWithUnsavedNote(options: { agentFileLateAbortSettleMs: number }, warm = true) {
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), leaseId: randomUUID(), remoteCwd, runner };
    await db.insert(environments).values({ id: executionTarget.environmentId, name: `Late abort fixture ${executionTarget.environmentId}`, driver: "sandbox" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.insert(environmentLeases).values({ id: executionTarget.leaseId, companyId, environmentId: executionTarget.environmentId,
      heartbeatRunId: runId, provider: "daytona", providerLeaseId: `late-abort-${runId}` });
    const service = agentInstructionWorkingCopyService(db, options as Parameters<typeof agentInstructionWorkingCopyService>[1]);
    const copy = (await service.prepare({ companyId, agentId, runId, cwd: home, target: executionTarget, warm }))!;
    const note = `late abort run bytes ${randomUUID()}\n`;
    await fs.writeFile(path.join(copy.executionRoot, noteName), note);
    return { service, copy, executionTarget, runId, note };
  }

  /**
   * PLANTED FAULT, named at its line. The abort is raised inside the real
   * store.apply right after the real persistDurableAgentFiles returned: the
   * tree is merged, the durable rows are written in the store's still-open
   * transaction, and nothing is committed yet (past the canonical commit
   * boundary). With `hang`, the same line then keeps that transaction open (an
   * apply that hangs) until release(). With `failure`, the same line then
   * fails the apply (its transaction rolls back).
   */
  function plantAbortAfterPersist(note: string, hang: boolean, failure?: Error) {
    const controller = new AbortController();
    abortSignal = controller.signal;
    const reason = new Error("LATE-ABORT fixture: abort after persist, before commit");
    const fault = { get applies() { return applyCount.started; }, get appliesSettled() { return applyCount.settled; }, persisted: 0, stagedNote: false, armed: true };
    let reached!: () => void, release!: () => void;
    const persisted = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    const realPersist = fileDurability.persistDurableAgentFiles;
    vi.spyOn(fileDurability, "persistDurableAgentFiles").mockImplementation(async (...args) => {
      const result = await realPersist(...args);
      if (args[3] === true || !fault.armed || args[1].id !== agentId) return result;
      fault.armed = false;
      const [staged] = await args[0].select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId));
      fault.stagedNote = staged?.entries.some(entry => entry.path === noteName && entry.kind === "file" && entry.sha256 === fileHash(Buffer.from(note))) === true;
      fault.persisted++;
      controller.abort(reason); // PLANTED ABORT: after persist, before the store transaction commits
      reached();
      if (hang) await gate; // PLANTED HANG: the apply stays in flight until release()
      if (failure) throw failure; // PLANTED FAILURE: the store transaction rolls back after the tree merge
      return result;
    });
    return { controller, reason, fault, persisted, release };
  }

  /**
   * PLANTED FAULT, named at its line (in the sandbox runner above). The abort
   * is raised inside the collection's release, in its remote cleanup command,
   * AFTER the real apply committed and the copy row was recorded as saved;
   * that cleanup command then hangs until release().
   */
  function plantAbortInReleaseCleanup() {
    const controller = new AbortController();
    abortSignal = controller.signal;
    const reason = new Error("LATE-ABORT fixture: abort during the release after the save was recorded");
    let reached!: () => void, release!: () => void;
    const inCleanup = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    cleanupFault = { armed: true, controller, reason, reached, gate };
    return { controller, reason, inCleanup, release };
  }
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  const lockKey = () => `agent-directory:${companyId}:${agentId}`;
  /** Can a writer on an independent pool take the collector's advisory key now? */
  const independentPoolCanTakeLock = () => observer.transaction(async tx => {
    const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${lockKey()}, 0)) as acquired`);
    return row?.acquired === true;
  });
  /** Committed durable manifest (independent pool) and the real canonical tree, hashed the same way. */
  async function canonical(note: string) {
    const digest = (entries: Array<[string, string, string | null]>) => createHash("sha256")
      .update(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex");
    const [head] = await observer.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId));
    const tree = await snapshotAgentFiles(root, false);
    const noteHash = fileHash(Buffer.from(note));
    return {
      generation: head?.generation ?? null,
      manifestHash: digest((head?.entries ?? []).map(entry => [entry.path, entry.kind, entry.kind === "file" ? entry.sha256 : null])),
      treeHash: digest([...tree.entries].map(([name, entry]) => [name, entry.kind, entry.kind === "file" ? entry.hash : null])),
      manifestHasNote: (head?.entries ?? []).some(entry => entry.path === noteName && entry.kind === "file" && entry.sha256 === noteHash),
      treeHasNote: await fs.readFile(path.join(root, noteName), "utf8").then(body => body === note, () => false),
    };
  }
  const copyRow = async (runId: string) => (await observer.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, runId)))[0]!;
  /** Wait (bounded) until every real apply that started has settled, so the
   * final observation is of the settled write even when the collection that
   * started it has already answered (as a tree without the fix does). */
  const appliesSettled = async () => { for (let i = 0; i < 200 && applyCount.settled < applyCount.started; i++) await sleep(50); };
  const outcomeOf = <T>(work: Promise<T>) => work.then(row => ({ row, error: null as unknown }), (error: unknown) => ({ row: null as T | null, error }));

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-directory-late-abort-");
    db = createDb(database.connectionString);
    observer = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await observer?.$client.end({ timeout: 1 });
    if (db) { await closeFileStorageDb(db, 1); await db.$client.end({ timeout: 1 }); }
    await database?.cleanup();
  });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-directory-late-abort-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    vi.stubEnv("PAPERCLIP_DURABLE_AGENT_FILES", "true");
    vi.spyOn(storageModule, "getStorageService").mockImplementation(() => memoryStorage() as unknown as ReturnType<typeof storageModule.getStorageService>);
    abortSignal = null; cleanupFault = null; captureFault = null; objectStoreFault = null; runnerCalls.length = 0; releases.length = 0; objects.clear();
    applyCount.started = 0; applyCount.settled = 0; lastApplySettledAt = 0;
    const actualStore = fileStoreModule.agentFileStore;
    vi.spyOn(fileStoreModule, "agentFileStore").mockImplementation((...args) => {
      const store = actualStore(...args), realApply = store.apply.bind(store);
      vi.spyOn(store, "apply").mockImplementation(async (...applyArgs) => {
        applyCount.started++;
        try { return await realApply(...applyArgs); } finally { applyCount.settled++; lastApplySettledAt = performance.now(); }
      });
      return store;
    });
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Owner", adapterConfig: {} });
    remoteCwd = path.join(home, "remote-task");
    await fs.mkdir(remoteCwd, { recursive: true });
    await db.insert(companies).values({ id: companyId, name: "Late abort", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner",
      adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, entryFile), "# Policy\n");
  });
  afterEach(async () => {
    // Never leave a planted hang or a background save behind for the next row.
    for (const release of releases) release();
    if (objectStoreFault) objectStoreFault.armed = false;
    for (const statement of plantedInPostgres.splice(0)) await db.execute(sql.raw(statement));
    await drainAgentFileCheckpoints();
    await appliesSettled();
    vi.restoreAllMocks();
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), nextAttemptAt: null,
      receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } }).where(eq(agentInstructionWorkingCopies.companyId, companyId));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.companyId, companyId));
    for (const extra of extraDbs.splice(0)) { await closeFileStorageDb(extra, 1); await extra.$client.end({ timeout: 1 }); }
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("R1 abort after persist: the collection is SAVED and marked 'abort came too late'; DB and tree change together; no independent pool takes the lock until the apply settled", async () => {
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 30_000 });
    const before = await canonical(note);
    expect(before, "fixture: the durable manifest equals the canonical tree before the collection").toMatchObject({ manifestHash: before.treeHash, manifestHasNote: false, treeHasNote: false });
    const { controller, reason, fault, persisted, release } = plantAbortAfterPersist(note, true);
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([persisted, collection]);
    // The late window: aborted, the apply is still in flight (transaction open).
    const settledInWindow = await Promise.race([collection.then(() => true), sleep(400).then(() => false)]);
    const lockFreeInWindow = await independentPoolCanTakeLock();
    const inWindow = await canonical(note);
    release();
    const { row, error } = await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const after = await canonical(note);
    const lockFreeAfter = await independentPoolCanTakeLock();
    const recorded = await copyRow(runId);
    await evidence("r1-abort-after-persist.json", { fault, aborted: controller.signal.aborted, settledInWindow, lockFreeInWindow, inWindow,
      error: error ? String(error) : null, returned: row && { state: row.state, errorCode: row.errorCode, abortCameTooLate: row.receipt?.abortCameTooLate ?? null },
      recorded: { state: recorded.state, errorCode: recorded.errorCode, abortCameTooLate: recorded.receipt?.abortCameTooLate ?? null }, before, after, lockFreeAfter,
      source: await fs.readFile(path.join(copy.executionRoot, noteName), "utf8").catch(() => null) });
    expect.soft(fault).toMatchObject({ applies: 1, appliesSettled: 1, persisted: 1, stagedNote: true });
    expect.soft(controller.signal.aborted).toBe(true);
    expect.soft(settledInWindow, "the collection must not report anything while its apply is still landing").toBe(false);
    expect.soft(lockFreeInWindow, "no other writer may take the collector's lock while the write is landing").toBe(false);
    expect.soft(error, "an abort after the commit boundary must not reject the collection as cancelled").toBeNull();
    expect.soft(error).not.toBe(reason);
    expect.soft(row, "the collection reports the true outcome").toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft(recorded).toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft(after.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after, "DB and tree changed together").toMatchObject({ manifestHasNote: true, treeHasNote: true });
    expect.soft(after.generation).not.toBe(before.generation);
    expect.soft(after.treeHash).not.toBe(before.treeHash);
    expect.soft(lockFreeAfter, "the lock is released once the apply settled").toBe(true);
  }, 60_000);

  it("R2 apply hangs past the bound: the collection reports 'still saving, abort came too late' and keeps its lock; when the apply settles the record is SAVED and the lock released", async () => {
    const { service, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 200 });
    const before = await canonical(note);
    const { controller, reason, fault, persisted, release } = plantAbortAfterPersist(note, true);
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([persisted, collection]);
    // The apply hangs (planted) well past the 200 ms bound; the collection must answer at the bound.
    const atBound = await Promise.race([collection, sleep(5_000).then(() => null)]);
    const reported = atBound?.row ?? null;
    const recordedAtBound = await copyRow(runId);
    const lockFreeAtBound = await independentPoolCanTakeLock();
    const whileHanging = await canonical(note);
    const appliesSettledAtBound = fault.appliesSettled;
    release();
    await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const recorded = await copyRow(runId);
    const after = await canonical(note);
    const lockFreeAfter = await independentPoolCanTakeLock();
    const brief = (row: typeof recorded | null) => row && { state: row.state, errorCode: row.errorCode, errorMessage: row.errorMessage,
      abortCameTooLate: row.receipt?.abortCameTooLate ?? null, savePending: row.receipt?.savePending ?? null, held: agentFileSaveHeld(row) };
    await evidence("r2-apply-hangs-past-bound.json", { fault, boundMs: 200, answeredAtBound: atBound !== null, error: atBound?.error ? String(atBound.error) : null,
      reported: brief(reported), recordedAtBound: brief(recordedAtBound), lockFreeAtBound, whileHanging, appliesSettledAtBound,
      recorded: brief(recorded), before, after, lockFreeAfter });
    expect.soft(fault).toMatchObject({ applies: 1, appliesSettled: 1, persisted: 1, stagedNote: true });
    expect.soft(atBound, "the collection answers at the bound instead of waiting for the hanging apply").not.toBeNull();
    expect.soft(atBound?.error, "never 'cancelled'").toBeNull();
    expect.soft(atBound?.error).not.toBe(reason);
    expect.soft(appliesSettledAtBound, "the apply was still running when the collection answered").toBe(0);
    const stillSaving = { state: "unavailable", errorCode: "AGENT_FILES_SAVE_STILL_RUNNING",
      receipt: { abortCameTooLate: true, savePending: { code: "AGENT_FILES_SAVE_STILL_RUNNING" } } };
    expect.soft(reported, "never 'saved' before it is: the report is 'still saving, abort came too late'").toMatchObject(stillSaving);
    expect.soft(String(reported?.errorMessage ?? "")).toMatch(/still being saved.*too late to cancel/i);
    expect.soft(recordedAtBound, "the same report is the durable record").toMatchObject(stillSaving);
    expect.soft(agentFileSaveHeld(recordedAtBound), "it is a held save: nothing destroys or releases its source").toBe(true);
    expect.soft(whileHanging, "nothing was committed yet").toMatchObject({ generation: before.generation, manifestHasNote: false });
    expect.soft(lockFreeAtBound, "the lock is KEPT while the apply is still running").toBe(false);
    // Released hang: the settling write updates the record and only then gives up the lock.
    expect.soft(recorded, "the record becomes SAVED").toMatchObject({ state: "saved", errorCode: null, errorMessage: null, receipt: { abortCameTooLate: true } });
    expect.soft(recorded.receipt).not.toHaveProperty("savePending");
    expect.soft(after.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ manifestHasNote: true, treeHasNote: true });
    expect.soft(after.generation).not.toBe(before.generation);
    expect.soft(lockFreeAfter, "the lock is released once the apply settled").toBe(true);
  }, 60_000);

  // There is no periodic lock-release worker: serial()'s finally unlocks the
  // collector session; this real worker releases the saved SOURCE afterwards.
  // These rows deliberately observe the lock before even creating that worker.
  it.each([false, true])("R9 settled late-abort lock is free before real source cleanup (worker admission delayed: %s)", async delayed => {
    const UNLOCK_TIMEOUT_MS = 2_000; // releaseOperationLock's real timeout
    const LOCK_OBSERVATION_SLACK_MS = 500;
    const CLEANUP_ADMISSION_RETRY_MS = 30_000; // scoped-deadline-work retryMs, NOT a sweep period
    const WORKER_COMPLETION_SLACK_MS = 5_000;
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 200 });
    const [[collectorPool], [observerPool]] = await Promise.all([
      db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`),
      observer.execute<{ pid: number; version: string }>(sql`select pg_backend_pid() as pid, version() as version`),
    ]);
    expect(observerPool!.pid, "fixture: the observer uses a different PostgreSQL pool/session").not.toBe(collectorPool!.pid);
    const { controller, persisted, release } = plantAbortAfterPersist(note, true);
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([persisted, collection]);
    const atBound = await Promise.race([collection, sleep(5_000).then(() => null)]);
    const lockFreeWhileLanding = await independentPoolCanTakeLock();
    release();
    // Start the stopwatch at the real apply's finally, NOT after a drain,
    // cleanup pass, or collection return. Do not join the operation before
    // probing: a stuck unlock must fail this observation rather than hang it.
    const applyDeadline = performance.now() + 5_000;
    while (!lastApplySettledAt && performance.now() < applyDeadline) await sleep(10);
    expect(lastApplySettledAt, "fixture: the real apply settled").toBeGreaterThan(0);
    let lockFreeBeforeWorker = false;
    const lockDeadline = lastApplySettledAt + UNLOCK_TIMEOUT_MS + LOCK_OBSERVATION_SLACK_MS;
    do {
      lockFreeBeforeWorker = await independentPoolCanTakeLock();
      if (lockFreeBeforeWorker) break;
      await sleep(10);
    } while (performance.now() < lockDeadline);
    const lockAcquiredAfterSettleMs = performance.now() - lastApplySettledAt;
    const beforeWorker = await copyRow(runId);
    const sourceBeforeWorker = await fs.readFile(path.join(copy.executionRoot, noteName), "utf8").catch(() => null);
    // The normal case boots immediately. The delayed case lets the REAL
    // coordinator schedule its boot-admission retry, then opens admission;
    // no wake(), fake timers, direct release(), or worker.run() short-circuit.
    let admitted = !delayed;
    const errors: string[] = [];
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, onError: error => { errors.push(String(error)); } });
    const workerStartedAt = performance.now();
    let nextWakeAfterBoot: number | null = null;
    let cleaned = false;
    try {
      await service.registerDirectoryCleanupWork(worker, () => admitted, async () => true).ready;
      nextWakeAfterBoot = worker.nextWakeAt();
      admitted = true;
      const cleanupDeadline = workerStartedAt + (delayed ? CLEANUP_ADMISSION_RETRY_MS : 0) + WORKER_COMPLETION_SLACK_MS;
      do {
        cleaned = (await copyRow(runId)).receipt?.cleanupPending === false;
        if (cleaned) break;
        await sleep(25);
      } while (performance.now() < cleanupDeadline);
      const after = await canonical(note);
      const afterWorker = await copyRow(runId);
      const sourceAfterWorker = await fs.readFile(path.join(copy.executionRoot, noteName), "utf8").catch(() => null);
      await evidence(`r9-cleanup-${delayed ? "delayed" : "normal"}.json`, {
        realTimers: true, postgres: { version: observerPool!.version, collectorPoolPid: collectorPool!.pid, observerPoolPid: observerPool!.pid },
        workerHasFixedPeriod: false, cleanupAdmissionRetryMs: CLEANUP_ADMISSION_RETRY_MS,
        unlockTimeoutMs: UNLOCK_TIMEOUT_MS, lockObservationSlackMs: LOCK_OBSERVATION_SLACK_MS,
        lockFreeWhileLanding, lockFreeBeforeWorker, lockAcquiredAfterSettleMs,
        reported: atBound?.row?.errorCode, error: atBound?.error ? String(atBound.error) : null,
        beforeWorker: { state: beforeWorker.state, abortCameTooLate: beforeWorker.receipt?.abortCameTooLate, cleanupPending: beforeWorker.receipt?.cleanupPending, sourcePresent: sourceBeforeWorker === note },
        delayed, nextWakeAfterBoot, cleaned, cleanupObservedAfterWorkerBootMs: performance.now() - workerStartedAt,
        afterWorker: { state: afterWorker.state, cleanupPending: afterWorker.receipt?.cleanupPending, sourcePresent: sourceAfterWorker !== null },
        workerErrors: errors, applies: { ...applyCount }, after,
      });
      expect.soft(atBound?.row?.errorCode).toBe("AGENT_FILES_SAVE_STILL_RUNNING");
      expect.soft(atBound?.error).toBeNull();
      expect.soft(lockFreeWhileLanding).toBe(false);
      expect.soft(lockFreeBeforeWorker, "collector unlock does not depend on cleanup admission").toBe(true);
      expect.soft(lockAcquiredAfterSettleMs).toBeLessThanOrEqual(UNLOCK_TIMEOUT_MS + LOCK_OBSERVATION_SLACK_MS);
      expect.soft(beforeWorker).toMatchObject({ state: "saved", receipt: { abortCameTooLate: true } });
      expect.soft(beforeWorker.receipt?.cleanupPending).not.toBe(false);
      expect.soft(sourceBeforeWorker).toBe(note);
      if (delayed) expect.soft(nextWakeAfterBoot, "real coordinator scheduled its admission retry").not.toBeNull();
      expect.soft(cleaned, "the real cleanup worker must release the saved source").toBe(true);
      expect.soft(sourceAfterWorker).toBeNull();
      expect.soft(afterWorker).toMatchObject({ state: "saved", receipt: { cleanupPending: false } });
      expect.soft(errors).toEqual([]);
      expect.soft(applyCount).toEqual({ started: 1, settled: 1 });
      expect.soft(after).toMatchObject({ manifestHash: after.treeHash, manifestHasNote: true, treeHasNote: true });
    } finally { await worker.stop(); }
  }, 60_000);

  it("R3 the caller treats 'saved, abort came too late' as saved: one apply, no retry, no re-collection, no hold, and the aborted run takes no further step", async () => {
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 30_000 });
    const before = await canonical(note);
    const { controller, reason, fault } = plantAbortAfterPersist(note, false);
    let collects = 0;
    const collect = () => { collects++; return service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }); };
    // The retirement Stop collector's own call (createAgentFileRetirementCollector): the retry owner.
    const result = await outcomeOf(collectStoppedInstructionCopyWithRetries(collect, controller.signal));
    const saved = result.row;
    const commandsAfterAbort = runnerCalls.filter(call => call.afterAbort).length;
    const sourceKept = await fs.readFile(path.join(copy.executionRoot, noteName), "utf8").catch(() => null);
    // The deadline owner's own follow-ups (cleanupObsoleteReusableSandboxLeases).
    const lease = { id: executionTarget.leaseId, companyId, providerLeaseId: `late-abort-${runId}`, heartbeatRunId: runId };
    const settledForRetirement = saved ? agentFileCopyRetirementSettled(saved) : null;
    const stillToCollect = await agentFileCopiesToCollectOnLease(db, lease);
    const deadlineHoldWritten = await holdUncollectedAgentFileCopy(db, { companyId, runId, reason: "R3: the deadline expired" });
    // The durable retry owner (stopped-collection recovery) finds nothing to retry.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const recovered = await service.recoverStopped();
    // Any further step of the aborted run is still refused by its signal.
    const further = await outcomeOf(collectStoppedInstructionCopyWithRetries(collect, controller.signal));
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const recorded = await copyRow(runId);
    const after = await canonical(note);
    await evidence("r3-caller-treats-late-save-as-saved.json", { fault, collects, error: result.error ? String(result.error) : null,
      saved: saved && { state: saved.state, errorCode: saved.errorCode, abortCameTooLate: saved.receipt?.abortCameTooLate ?? null },
      settledForRetirement, stillToCollect, deadlineHoldWritten, recovered, furtherError: further.error ? String(further.error) : null,
      commandsAfterAbort, sourceKept: sourceKept === note, recorded: { state: recorded.state, errorCode: recorded.errorCode, receipt: recorded.receipt && {
        abortCameTooLate: recorded.receipt.abortCameTooLate ?? null, savePending: recorded.receipt.savePending ?? null, cleanupPending: recorded.receipt.cleanupPending ?? null } },
      before, after });
    expect.soft(result.error, "the caller is not told 'cancelled'").toBeNull();
    expect.soft(saved).toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft({ applies: fault.applies, collects }, "no retry, no re-collection, no second apply").toEqual({ applies: 1, collects: 1 });
    expect.soft(settledForRetirement, "the retirement counts it as saved").toBe(true);
    expect.soft(stillToCollect, "the retirement does not collect it again").not.toContain(runId);
    expect.soft(deadlineHoldWritten, "the deadline owner writes no 'not saved' hold over the save").toBe(false);
    expect.soft(recovered, "the durable retry owner has nothing to retry").toBe(0);
    expect.soft(further.error, "the run still stops: its abort refuses any further step").toBe(reason);
    expect.soft({ applies: fault.applies, collects }).toEqual({ applies: 1, collects: 1 });
    expect.soft(commandsAfterAbort, "the aborted collection starts no remote command after its abort").toBe(0);
    expect.soft(sourceKept, "and releases nothing itself: the sandbox copy is left to the cleanup owner").toBe(note);
    expect.soft(recorded).toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft(recorded.receipt).not.toHaveProperty("savePending");
    expect.soft(after.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ manifestHasNote: true, treeHasNote: true });
    expect.soft(after.generation).not.toBe(before.generation);
  }, 60_000);

  it("R4 a second collector started in the late window is refused, then sees the committed state and never a half tree", async () => {
    const { service, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 30_000 });
    const before = await canonical(note);
    const { controller, fault, persisted, release } = plantAbortAfterPersist(note, true);
    const first = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([persisted, first]);
    // Another controller: its own pool, its own service, the same copy.
    const otherDb = createDb(database.connectionString);
    extraDbs.push(otherDb);
    const second = agentInstructionWorkingCopyService(otherDb);
    const attempt = outcomeOf(second.collectStopped({ companyId, runId, target: executionTarget }));
    const inWindow = await Promise.race([attempt, sleep(2_000).then(() => "pending" as const)]);
    // What the second collector was kept away from: the tree is merged, the manifest is not committed.
    const half = await canonical(note);
    const appliesInWindow = fault.applies;
    release();
    const firstOutcome = await first;
    await attempt;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const committed = await canonical(note);
    const retried = await outcomeOf(second.collectStopped({ companyId, runId, target: executionTarget }));
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const after = await canonical(note);
    const recorded = await copyRow(runId);
    const lockFreeAfter = await independentPoolCanTakeLock();
    await evidence("r4-second-collector-in-late-window.json", { fault, appliesInWindow,
      inWindow: inWindow === "pending" ? "pending (it took the lock and is working on the half-landed write)"
        : { error: inWindow.error ? `${(inWindow.error as Error).name}: ${String((inWindow.error as Error).message)}` : null, state: inWindow.row?.state ?? null },
      half, first: { error: firstOutcome.error ? String(firstOutcome.error) : null, state: firstOutcome.row?.state ?? null },
      committed, retried: { error: retried.error ? String(retried.error) : null, state: retried.row?.state ?? null, abortCameTooLate: retried.row?.receipt?.abortCameTooLate ?? null },
      recorded: { state: recorded.state, errorCode: recorded.errorCode }, before, after, lockFreeAfter });
    expect.soft(half, "fixture: the late window really is a half-landed write").toMatchObject({ treeHasNote: true, manifestHasNote: false, generation: before.generation });
    expect.soft(inWindow, "the second collector must not get the lock while the first write is landing").not.toBe("pending");
    expect.soft(inWindow === "pending" ? null : inWindow.error, "it is refused as busy").toBeInstanceOf(AgentDirectoryOperationBusyError);
    expect.soft(appliesInWindow, "and applies nothing").toBe(1);
    expect.soft(firstOutcome).toMatchObject({ error: null, row: { state: "saved", receipt: { abortCameTooLate: true } } });
    expect.soft(committed.manifestHash, "the first write committed whole").toBe(committed.treeHash);
    expect.soft(retried, "admitted after the write settled, it sees the committed save").toMatchObject({ error: null, row: { state: "saved", errorCode: null, receipt: { abortCameTooLate: true } } });
    expect.soft(fault.applies, "one apply in total: the second collector saved nothing of its own").toBe(1);
    expect.soft(after.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ manifestHasNote: true, treeHasNote: true });
    expect.soft(recorded).toMatchObject({ state: "saved", errorCode: null });
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  it("R5 apply fails after the boundary: the collection reports the failed save as held (never 'cancelled', never 'saved') and retries nothing itself; a later collection saves it", async () => {
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 30_000 });
    const before = await canonical(note);
    const planted = new Error("LATE-ABORT fixture: durable persist failed after the abort");
    const { controller, reason, fault } = plantAbortAfterPersist(note, false, planted);
    const { row, error } = await outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const appliesByAbortedRun = fault.applies;
    const recorded = await copyRow(runId);
    const lockFreeAfter = await independentPoolCanTakeLock();
    const sourceKept = await fs.readFile(path.join(copy.executionRoot, noteName), "utf8").catch(() => null);
    // The failed apply puts the tree back itself (R10/R11 observe that raw).
    // This row keeps its original observation: after a store read, DB == tree.
    const rolledBack = await canonical(note);
    await fileStoreModule.agentFileStore(db).read(companyId, agentId, entryFile, board());
    const healed = await canonical(note);
    // The durable retry owner's later collection (no abort) saves the held copy.
    const retried = await outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget }));
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const after = await canonical(note);
    const final = await copyRow(runId);
    const brief = (value: typeof recorded | null) => value && { state: value.state, errorCode: value.errorCode, abortCameTooLate: value.receipt?.abortCameTooLate ?? null,
      savePending: value.receipt?.savePending ?? null, held: agentFileSaveHeld(value) };
    await evidence("r5-apply-fails-after-boundary.json", { fault, appliesByAbortedRun, error: error ? String(error) : null, returned: brief(row), recorded: brief(recorded),
      lockFreeAfter, sourceKept: sourceKept === note, before, rolledBack, healed,
      retried: { error: retried.error ? String(retried.error) : null, state: retried.row?.state ?? null }, final: brief(final), after });
    expect.soft(error, "never 'cancelled'").toBeNull();
    expect.soft(error).not.toBe(reason);
    const failedHold = { state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED",
      receipt: { abortCameTooLate: true, savePending: { code: "AGENT_FILES_SAVE_FAILED", reason: planted.message } } };
    expect.soft(row, "never 'saved': the failed save is reported as it is, held").toMatchObject(failedHold);
    expect.soft(recorded, "and recorded so").toMatchObject(failedHold);
    expect.soft(agentFileSaveHeld(recorded)).toBe(true);
    expect.soft(appliesByAbortedRun, "the aborted run makes no second attempt").toBe(1);
    expect.soft(sourceKept, "its source is kept for the durable retry").toBe(note);
    expect.soft(lockFreeAfter, "the lock is released once the apply settled").toBe(true);
    expect.soft(rolledBack, "the durable rows did not change").toMatchObject({ generation: before.generation, manifestHasNote: false });
    expect.soft(healed.manifestHash, "DB and tree agree after the store's existing restore: durable manifest == on-disk tree hash").toBe(healed.treeHash);
    expect.soft(healed).toMatchObject({ generation: before.generation, manifestHasNote: false, treeHasNote: false });
    expect.soft(retried, "the later collection saves it").toMatchObject({ error: null, row: { state: "saved", errorCode: null } });
    expect.soft(fault.applies).toBe(2);
    expect.soft(final).toMatchObject({ state: "saved", errorCode: null });
    expect.soft(final.receipt).not.toHaveProperty("savePending");
    expect.soft(final.receipt, "the later save was not aborted: it does not carry the earlier collection's marker").not.toHaveProperty("abortCameTooLate");
    expect.soft(after.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ manifestHasNote: true, treeHasNote: true });
  }, 60_000);

  it("R6 abort during the release after the save was recorded: the collection reports SAVED at once (never 'cancelled', never 'still saving') and keeps no lock across the hanging cleanup command", async () => {
    // A long bound: the answer below is not the bound's.
    const { service, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 30_000 });
    const before = await canonical(note);
    const { controller, reason, inCleanup, release } = plantAbortInReleaseCleanup();
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([inCleanup, collection]);
    // The cleanup command hangs (planted). The write is already on the row.
    const answered = await Promise.race([collection, sleep(3_000).then(() => null)]);
    const recordedWhileHanging = await copyRow(runId);
    let lockFreeWhileHanging = false;
    for (let i = 0; i < 60 && !(lockFreeWhileHanging = await independentPoolCanTakeLock()); i++) await sleep(50);
    const committedWhileHanging = await canonical(note);
    release();
    await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    await sleep(300); // the abandoned cleanup (not joined by anything) finishes its own bookkeeping
    const recorded = await copyRow(runId);
    const after = await canonical(note);
    const lockFreeAfter = await independentPoolCanTakeLock();
    const brief = (row: typeof recorded | null | undefined) => row && { state: row.state, errorCode: row.errorCode,
      abortCameTooLate: row.receipt?.abortCameTooLate ?? null, savePending: row.receipt?.savePending ?? null, held: agentFileSaveHeld(row) };
    await evidence("r6-abort-during-release-after-save.json", { applies: applyCount.started, aborted: controller.signal.aborted, boundMs: 30_000,
      answeredAtOnce: answered !== null, error: answered?.error ? String(answered.error) : null, reported: brief(answered?.row), recordedWhileHanging: brief(recordedWhileHanging),
      lockFreeWhileHanging, committedWhileHanging, recorded: brief(recorded), before, after, lockFreeAfter });
    expect.soft(controller.signal.aborted, "fixture: the abort was raised inside the release's cleanup").toBe(true);
    expect.soft(committedWhileHanging, "fixture: the write had already committed whole").toMatchObject({ manifestHasNote: true, treeHasNote: true, manifestHash: committedWhileHanging.treeHash });
    expect.soft(answered, "the collection answers at once, not at its 30 s bound and not when the hanging cleanup ends").not.toBeNull();
    expect.soft(answered?.error, "never 'cancelled': the files were saved").toBeNull();
    expect.soft(answered?.error).not.toBe(reason);
    expect.soft(answered?.row, "the true outcome is SAVED, marked 'abort came too late', never relabelled 'still saving'")
      .toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft(recordedWhileHanging, "and the durable record stays SAVED").toMatchObject({ state: "saved", errorCode: null });
    expect.soft(recordedWhileHanging.receipt).not.toHaveProperty("savePending");
    expect.soft(lockFreeWhileHanging, "no lock is kept across the hanging provider call: the write was already recorded").toBe(true);
    expect.soft(recorded).toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft(recorded.receipt).not.toHaveProperty("savePending");
    expect.soft(applyCount.started, "one apply").toBe(1);
    expect.soft(after.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ manifestHasNote: true, treeHasNote: true });
    expect.soft(after.generation).not.toBe(before.generation);
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  it("R7 abort after persist, then the collection lingers after recording the save (planted): it still answers at the bound with the SAVED record, never 'still saving'", async () => {
    const { service, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 200 });
    const { controller, reason, fault } = plantAbortAfterPersist(note, false);
    // PLANTED HANG, named at its line: the collection's own bookkeeping after
    // the save is recorded (dropping its lease pin) stays in flight until release().
    let reached!: () => void, release!: () => void;
    const inUnpin = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    const realUnpin = saveHold.unpinLeaseForCollection;
    vi.spyOn(saveHold, "unpinLeaseForCollection").mockImplementation(async (...args) => {
      reached();
      await gate; // PLANTED HANG
      return realUnpin(...args);
    });
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([inUnpin, collection]);
    const atBound = await Promise.race([collection, sleep(5_000).then(() => null)]);
    const recordedAtBound = await copyRow(runId);
    release();
    await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const recorded = await copyRow(runId);
    const after = await canonical(note);
    const lockFreeAfter = await independentPoolCanTakeLock();
    await evidence("r7-lingers-after-recording.json", { fault, boundMs: 200, answeredAtBound: atBound !== null, error: atBound?.error ? String(atBound.error) : null,
      reported: atBound?.row && { state: atBound.row.state, errorCode: atBound.row.errorCode, abortCameTooLate: atBound.row.receipt?.abortCameTooLate ?? null },
      recordedAtBound: { state: recordedAtBound.state, errorCode: recordedAtBound.errorCode, savePending: recordedAtBound.receipt?.savePending ?? null },
      recorded: { state: recorded.state, errorCode: recorded.errorCode, abortCameTooLate: recorded.receipt?.abortCameTooLate ?? null }, after, lockFreeAfter });
    expect.soft(fault).toMatchObject({ applies: 1, persisted: 1, stagedNote: true });
    expect.soft(atBound, "the collection answers at the bound instead of waiting for its lingering bookkeeping").not.toBeNull();
    expect.soft(atBound?.error, "never 'cancelled'").toBeNull();
    expect.soft(atBound?.error).not.toBe(reason);
    expect.soft(atBound?.row, "the write is recorded: the report is SAVED, never 'still saving'").toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft(recordedAtBound).toMatchObject({ state: "saved", errorCode: null });
    expect.soft(recordedAtBound.receipt).not.toHaveProperty("savePending");
    expect.soft(recorded).toMatchObject({ state: "saved", errorCode: null, receipt: { abortCameTooLate: true } });
    expect.soft(after.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ manifestHasNote: true, treeHasNote: true });
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  it("R8 the apply fails after the boundary with no abort pending, then the abort arrives while the retry's remote capture hangs: nothing is saved, the collection is cancelled as before and keeps no lock across the hanging provider call", async () => {
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 30_000 });
    const before = await canonical(note);
    const controller = new AbortController();
    abortSignal = controller.signal;
    const reason = new Error("LATE-ABORT fixture: abort during the retry's remote capture");
    // PLANTED FAILURE, named at its line: the first real apply fails right
    // after the real persistDurableAgentFiles returned (past the commit
    // boundary; its transaction rolls back). No abort is raised here.
    let persistFailures = 0;
    const realPersist = fileDurability.persistDurableAgentFiles;
    vi.spyOn(fileDurability, "persistDurableAgentFiles").mockImplementation(async (...args) => {
      const result = await realPersist(...args);
      if (args[3] === true || args[1].id !== agentId || persistFailures > 0) return result;
      persistFailures++;
      throw new Error("LATE-ABORT fixture: durable persist failed, no abort pending"); // PLANTED FAILURE
    });
    let reached!: () => void, release!: () => void;
    const inRetryCapture = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    captureFault = { captures: 0, controller, reason, reached, gate };
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([inRetryCapture, collection]);
    // The retry's capture command hangs (planted); no canonical write is in flight.
    const answered = await Promise.race([collection, sleep(3_000).then(() => null)]);
    let lockFreeWhileHanging = false;
    for (let i = 0; i < 60 && !(lockFreeWhileHanging = await independentPoolCanTakeLock()); i++) await sleep(50);
    const recordedWhileHanging = await copyRow(runId);
    release();
    await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    await sleep(300); // the abandoned retry (not joined by anything) ends at its next abort check
    const recorded = await copyRow(runId);
    const sourceKept = await fs.readFile(path.join(copy.executionRoot, noteName), "utf8").catch(() => null);
    await fileStoreModule.agentFileStore(db).read(companyId, agentId, entryFile, board());
    const after = await canonical(note);
    const lockFreeAfter = await independentPoolCanTakeLock();
    const brief = (row: typeof recorded) => ({ state: row.state, errorCode: row.errorCode, abortCameTooLate: row.receipt?.abortCameTooLate ?? null,
      savePending: row.receipt?.savePending ?? null });
    await evidence("r8-abort-in-retry-capture-after-failed-apply.json", { persistFailures, captures: captureFault?.captures ?? null, applies: applyCount.started,
      aborted: controller.signal.aborted, answeredAtOnce: answered !== null, error: answered?.error ? String(answered.error) : null,
      returnedState: answered?.row?.state ?? null, lockFreeWhileHanging, recordedWhileHanging: brief(recordedWhileHanging), recorded: brief(recorded),
      sourceKept: sourceKept === note, before, after, lockFreeAfter });
    expect.soft({ persistFailures, captures: captureFault?.captures, aborted: controller.signal.aborted }, "fixture: one failed apply past the boundary, then the abort inside the second capture")
      .toEqual({ persistFailures: 1, captures: 2, aborted: true });
    expect.soft(lockFreeWhileHanging, "no lock is kept across the hanging provider call: no canonical write is in flight").toBe(true);
    expect.soft(answered, "the collection answers at once").not.toBeNull();
    expect.soft(answered?.error, "nothing was saved: this abort cancels the collection as before").toBe(reason);
    expect.soft(recorded.state, "never 'saved'").not.toBe("saved");
    expect.soft(recorded.errorCode, "and never 'still saving': nothing is landing").not.toBe("AGENT_FILES_SAVE_STILL_RUNNING");
    expect.soft(applyCount.started, "the abandoned retry applies nothing").toBe(1);
    expect.soft(sourceKept, "the source copy is kept").toBe(note);
    expect.soft(after.manifestHash, "DB and tree agree after the store's existing restore: durable manifest == on-disk tree hash").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ generation: before.generation, manifestHasNote: false, treeHasNote: false });
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  // PERSIST FAILURE after the commit boundary (rf-3, smarty-dev#20787: "row 2"
  // and "R7 with a failure already recorded"). Person case: the stopped
  // agent's working copy is collected, the tree merge has written files, and
  // then the canonical persist FAILS. Same boundary as the rows above, with a
  // REAL persist failure: no row below throws from a wrapper around the
  // persist. The failure is raised inside the real persistDurableAgentFiles,
  // by PostgreSQL (a planted trigger on agent_file_roots) or by the object
  // store stand-in (its putFile). Every tree observation is raw: the real
  // files on disk and the committed manifest from the independent pool, with
  // no store read (which would restore the tree) before it.

  /**
   * PLANTED FAULT, named at its line: PostgreSQL itself rejects the durable
   * head of THIS agent. The real persistDurableAgentFiles then fails at its
   * own `tx.insert(agentFileRoots)...onConflictDoUpdate(...)` statement, after
   * the tree merge, and its transaction is aborted by the database.
   */
  async function plantDurableHeadRejection() {
    const name = "planted_agent_file_head_rejection";
    await db.execute(sql.raw(`create or replace function ${name}() returns trigger language plpgsql as $$
      begin if new.agent_id = '${agentId}'::uuid then raise exception 'PLANTED persist failure: PostgreSQL rejects the durable agent-file head'; end if; return new; end $$`));
    await db.execute(sql.raw(`create trigger ${name} before insert or update on agent_file_roots for each row execute function ${name}()`)); // PLANTED FAILURE
    const remove = `drop function if exists ${name}() cascade`;
    plantedInPostgres.push(remove);
    return { disarm: () => db.execute(sql.raw(remove)) };
  }
  /**
   * PLANTED ABORT (and optional hang), named at its line: raised as the real
   * persistDurableAgentFiles of the collection's store transaction STARTS,
   * i.e. after the tree merge (past the canonical commit boundary). Nothing is
   * thrown here: the real persist is then called and fails by itself.
   */
  function plantAbortAsPersistStarts(note: string, hang: boolean) {
    const controller = new AbortController();
    abortSignal = controller.signal;
    const reason = new Error("PERSIST-FAILURE fixture: abort after the tree merge, as the persist starts");
    const fault = { get applies() { return applyCount.started; }, get appliesSettled() { return applyCount.settled; }, realPersistCalls: 0, treeMergedAtPersist: false, abortedAt: 0, armed: true };
    let reached!: () => void, release!: () => void;
    const persisting = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    const realPersist = fileDurability.persistDurableAgentFiles;
    vi.spyOn(fileDurability, "persistDurableAgentFiles").mockImplementation(async (...args) => {
      if (args[3] === true || !fault.armed || args[1].id !== agentId) return realPersist(...args);
      fault.armed = false;
      fault.treeMergedAtPersist = await fs.readFile(path.join(root, noteName), "utf8").then(body => body === note, () => false);
      fault.abortedAt = performance.now();
      controller.abort(reason); // PLANTED ABORT: after the tree merge, before the real persist runs
      reached();
      if (hang) await gate; // PLANTED HANG: the apply stays in flight until release()
      fault.realPersistCalls++;
      return realPersist(...args); // the REAL persist; it fails by itself (plantDurableHeadRejection)
    });
    return { controller, reason, fault, persisting, release };
  }
  /** PLANTED HANG, named at its line: the collection's own bookkeeping after its
   * outcome is recorded (dropping its lease pin) stays in flight until release(). */
  function plantLingeringUnpin() {
    const state = { reached: false, returned: false };
    let reached!: () => void, release!: () => void;
    const inUnpin = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    releases.push(release);
    const realUnpin = saveHold.unpinLeaseForCollection;
    vi.spyOn(saveHold, "unpinLeaseForCollection").mockImplementation(async (...args) => {
      state.reached = true;
      reached();
      await gate; // PLANTED HANG
      try { return await realUnpin(...args); } finally { state.returned = true; }
    });
    return { state, inUnpin, release };
  }
  /** The real canonical tree as it is on disk now (no store read): every entry with kind, content hash and mode. */
  const rawTree = async () => [...(await snapshotAgentFiles(root, false)).entries]
    .map(([name, entry]) => [name, entry.kind, entry.kind === "file" ? entry.hash : null, entry.kind === "file" ? (entry.mode & 0o777).toString(8) : null] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  /** Anything a save left beside the canonical tree (undo or restore scratch). */
  const scratchBesideTree = async () => (await fs.readdir(path.dirname(root))).filter(name => name.startsWith(".agent-files"));
  /** Polls the collector's key from the independent pool. At the FIRST moment
   * that pool can take it, reads the committed manifest and the raw tree. */
  async function atFirstUnlock(note: string) {
    for (let i = 0; i < 3_000; i++) {
      if (await independentPoolCanTakeLock()) return { lockFree: true, ...await canonical(note), tree: await rawTree() };
      await sleep(5);
    }
    return { lockFree: false, ...await canonical(note), tree: await rawTree() };
  }
  const leasePins = async (leaseId: string) => {
    const [lease] = await observer.select({ metadata: environmentLeases.metadata }).from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    return Object.keys((lease?.metadata as { agentFileCollectionPins?: Record<string, string> } | null)?.agentFileCollectionPins ?? {});
  };
  const briefRow = (row: Awaited<ReturnType<typeof copyRow>> | null | undefined) => row && { state: row.state, errorCode: row.errorCode,
    abortCameTooLate: row.receipt?.abortCameTooLate ?? null, savePending: row.receipt?.savePending ?? null, held: agentFileSaveHeld(row) };
  const failedHold = { state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED", receipt: { savePending: { code: "AGENT_FILES_SAVE_FAILED" } } };

  it("R10 a REAL persist failure after the commit boundary (PostgreSQL rejects the durable head; late abort, apply held past the bound): the merged tree is rolled back, the lock is never free while manifest != tree, never 'saved'", async () => {
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 200 });
    const before = await canonical(note), treeBefore = await rawTree();
    expect(before, "fixture: the durable manifest equals the canonical tree before the collection").toMatchObject({ manifestHash: before.treeHash, manifestHasNote: false, treeHasNote: false });
    const entryInode = async () => (await fs.stat(path.join(root, entryFile), { bigint: true })).ino.toString();
    const entryInodeBefore = await entryInode();
    await plantDurableHeadRejection();
    const { controller, reason, fault, persisting, release } = plantAbortAsPersistStarts(note, true);
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([persisting, collection]);
    // The late window: the tree is merged, the real persist has not run yet (planted hang).
    const atBound = await Promise.race([collection, sleep(2_000).then(() => null)]);
    const lockFreeAtBound = await independentPoolCanTakeLock();
    const half = await canonical(note);
    release();
    const unlocked = await atFirstUnlock(note);
    await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    // RAW: no store read between the failed apply and these observations.
    const after = await canonical(note), treeAfter = await rawTree(), scratch = await scratchBesideTree(), entryInodeAfter = await entryInode();
    const lockFreeAfter = await independentPoolCanTakeLock();
    const recorded = await copyRow(runId);
    const sourceKept = await fs.readFile(path.join(copy.executionRoot, noteName), "utf8").catch(() => null);
    await evidence("r10-real-persist-failure-late-abort.json", { entryInodeBefore, entryInodeAfter, fault, boundMs: 200, atBound: atBound && { error: atBound.error ? String(atBound.error) : null, row: briefRow(atBound.row) },
      lockFreeAtBound, half, unlocked, recorded: briefRow(recorded), before, after, treeBefore, treeAfter, scratch, lockFreeAfter, sourceKept: sourceKept === note });
    expect.soft(fault, "fixture: one apply; the abort came after the tree merge; the REAL persist ran once and failed").toMatchObject({ applies: 1, appliesSettled: 1, realPersistCalls: 1, treeMergedAtPersist: true });
    expect.soft(half, "fixture: the late window really is a merged tree with an uncommitted manifest").toMatchObject({ treeHasNote: true, manifestHasNote: false, generation: before.generation });
    expect.soft(atBound, "the collection answers at the bound: still saving, never 'cancelled'").toMatchObject({ error: null, row: { state: "unavailable", errorCode: "AGENT_FILES_SAVE_STILL_RUNNING" } });
    expect.soft(atBound?.error).not.toBe(reason);
    expect.soft(lockFreeAtBound, "the lock is KEPT while the write is still landing").toBe(false);
    expect.soft(recorded, "the settled record is the failed-save hold").toMatchObject(failedHold);
    expect.soft(String((recorded.receipt?.savePending as { reason?: unknown } | undefined)?.reason), "and it names the REAL persist failure: the durable-head upsert PostgreSQL rejected").toMatch(/insert into "agent_file_roots"/);
    expect.soft(recorded.state, "never 'saved'").not.toBe("saved");
    expect.soft(agentFileSaveHeld(recorded), "its source is held for the durable retry").toBe(true);
    expect.soft(sourceKept).toBe(note);
    expect.soft(unlocked.lockFree, "the lock is released once the failed write settled").toBe(true);
    expect.soft(unlocked.manifestHash, "at the FIRST moment an independent pool can take the lock, manifest == on-disk tree").toBe(unlocked.treeHash);
    expect.soft(unlocked.tree, "and that tree is the pre-merge tree").toEqual(treeBefore);
    expect.soft(after.manifestHash, "raw DB and raw tree agree after the failed apply, with no restoring store read").toBe(after.treeHash);
    expect.soft(after, "PostgreSQL rolled back and nothing of the failed save is left on disk").toMatchObject({ generation: before.generation, manifestHasNote: false, treeHasNote: false });
    expect.soft(treeAfter, "the canonical tree is exactly its pre-merge state (names, kinds, bytes, modes)").toEqual(treeBefore);
    expect.soft(entryInodeAfter, "a file the merge did not touch is not rewritten by the rollback").toBe(entryInodeBefore);
    expect.soft(scratch, "no undo or restore scratch is left beside the tree").toEqual([]);
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  it.each([
    ["PostgreSQL rejects the durable head upsert", "warm"], ["PostgreSQL rejects the durable head upsert", "cold"],
    ["object storage rejects the upload", "warm"], ["object storage rejects the upload", "cold"],
  ] as const)("R11 a REAL persist failure on every attempt, no abort (%s; %s stopped copy): each failed merge (edit, delete, add, mode, file<->folder swap, conflict copy) is rolled back whole, then a later collection saves it once", async (failure, kind) => {
    // The canonical tree before the run, adopted with the copy below.
    const seed: Record<string, string> = { "memory/keep.md": "keep\n", "memory/edit.md": "v1\n", "memory/gone.md": "gone\n", "old-dir/a.md": "a\n", "old-dir/sub/b.md": "b\n",
      "swap-file": "was a file\n", "swap-dir/x.md": "x\n", "mode.sh": "#!/bin/sh\n", "memory/conflict.md": "base\n" };
    for (const [name, body] of Object.entries(seed)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), body, { mode: 0o644 });
    }
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 30_000 }, kind === "warm");
    // Another writer saves memory/conflict.md after the run started.
    await fileStoreModule.agentFileStore(db).write({ companyId, agentId, path: "memory/conflict.md", bytes: Buffer.from("other writer\n"), baseHash: fileHash(Buffer.from("base\n")) }, board());
    // The stopped run's own changes, in its working copy.
    const run = (name: string) => path.join(copy.executionRoot, name);
    await fs.writeFile(run("memory/edit.md"), "v2 by the run\n");
    await fs.rm(run("memory/gone.md"));
    await fs.rm(run("old-dir"), { recursive: true });
    await fs.mkdir(run("new/deep"), { recursive: true });
    await fs.writeFile(run("new/deep/file.md"), "new\n");
    await fs.rm(run("swap-file"));
    await fs.mkdir(run("swap-file"));
    await fs.writeFile(run("swap-file/inner.md"), "inner\n");
    await fs.rm(run("swap-dir"), { recursive: true });
    await fs.writeFile(run("swap-dir"), "now a file\n");
    await fs.chmod(run("mode.sh"), 0o755);
    await fs.writeFile(run("memory/conflict.md"), "run version\n");
    const before = await canonical(note), treeBefore = await rawTree();
    expect(before.manifestHash, "fixture: manifest == tree before the collection").toBe(before.treeHash);
    const pg = failure.startsWith("PostgreSQL") ? await plantDurableHeadRejection() : null;
    if (!pg) objectStoreFault = { armed: true, rejected: 0 };
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget }));
    for (let i = 0; i < 2_000 && applyCount.started === 0; i++) await sleep(5);
    const unlocked = await atFirstUnlock(note);
    const { row, error } = await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    // RAW: no store read between the failed applies and these observations.
    const failedApplies = { ...applyCount };
    const after = await canonical(note), treeAfter = await rawTree(), scratch = await scratchBesideTree();
    const recorded = await copyRow(runId);
    const sourceKept = await fs.readFile(run(noteName), "utf8").catch(() => null);
    // The fault is removed; the durable retry owner's later collection saves the held copy.
    await pg?.disarm();
    if (objectStoreFault) objectStoreFault.armed = false;
    const retried = await outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget }));
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const saved = await canonical(note), treeSaved = await rawTree(), final = await copyRow(runId);
    const savedNames = treeSaved.map(([name]) => name);
    const conflictCopies = savedNames.filter(name => /^memory\/conflict\.conflict-/.test(name));
    const read = (name: string) => fs.readFile(path.join(root, name), "utf8").catch(() => null);
    const savedTree = { edit: await read("memory/edit.md"), gone: await read("memory/gone.md"), oldDir: savedNames.filter(name => name.startsWith("old-dir")),
      added: await read("new/deep/file.md"), swapFile: await read("swap-file/inner.md"), swapDir: await read("swap-dir"),
      mode: treeSaved.find(([name]) => name === "mode.sh")?.[3] ?? null, conflict: await read("memory/conflict.md"),
      conflictCopy: conflictCopies.length === 1 ? await read(conflictCopies[0]!) : null, note: await read(noteName) };
    await evidence(`r11-real-persist-failure-${failure.startsWith("PostgreSQL") ? "postgres" : "object-store"}-${kind}.json`, { failure, kind, failedApplies,
      objectUploadsRejected: objectStoreFault?.rejected ?? null, error: error ? String(error) : null, returned: briefRow(row), recorded: briefRow(recorded), unlocked,
      before, after, treeBefore, treeAfter, scratch, sourceKept: sourceKept === note,
      retried: { error: retried.error ? String(retried.error) : null, row: briefRow(retried.row) }, applies: { ...applyCount }, saved, treeSaved, conflictCopies, savedTree, final: briefRow(final) });
    expect.soft(error, "the collection is not rejected").toBeNull();
    expect.soft(row, "never 'saved': the failed save is reported as held").toMatchObject(failedHold);
    expect.soft(recorded).toMatchObject(failedHold);
    expect.soft(String((recorded.receipt?.savePending as { reason?: unknown } | undefined)?.reason), "the hold names the REAL persist failure")
      .toMatch(pg ? /insert into "agent_file_roots"/ : /PLANTED persist failure: object storage rejects the upload/);
    expect.soft(failedApplies, "fixture: every attempt of the collection passed the boundary and failed in the real persist").toEqual({ started: 3, settled: 3 });
    expect.soft(sourceKept, "the source is kept for the retry").toBe(note);
    expect.soft(unlocked.lockFree).toBe(true);
    expect.soft(unlocked.manifestHash, "at the FIRST moment an independent pool can take the lock, manifest == on-disk tree").toBe(unlocked.treeHash);
    expect.soft(after.manifestHash, "raw DB and raw tree agree after the failed applies, with no restoring store read").toBe(after.treeHash);
    expect.soft(after.generation, "PostgreSQL kept the committed head").toBe(before.generation);
    expect.soft(treeAfter, "the canonical tree is exactly its pre-merge state: nothing of the failed save is left (no merged file, no conflict copy, no new folder)").toEqual(treeBefore);
    expect.soft(scratch, "no undo or restore scratch is left beside the tree").toEqual([]);
    expect.soft(retried, "the later collection saves it").toMatchObject({ error: null, row: { state: "saved", errorCode: null } });
    expect.soft(final.receipt).not.toHaveProperty("savePending");
    expect.soft(saved.manifestHash, "DB and tree agree: durable manifest == on-disk tree hash").toBe(saved.treeHash);
    expect.soft(saved.generation).not.toBe(before.generation);
    expect.soft(savedTree, "the save landed whole, once: the other writer's file kept, the run's version in exactly one conflict copy").toEqual({ edit: "v2 by the run\n", gone: null, oldDir: [],
      added: "new\n", swapFile: "inner\n", swapDir: "now a file\n", mode: "755", conflict: "other writer\n", conflictCopy: "run version\n", note });
    expect.soft(conflictCopies).toHaveLength(1);
  }, 90_000);

  it("R13 a REAL persist failure after a late abort, then the collection's lease-unpin bookkeeping lingers: the failed-save hold is durable and the collection ANSWERS with it at the bound; the bookkeeping continues after", async () => {
    const BOUND_MS = 200, OBSERVE_MS = 1_500;
    const { service, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: BOUND_MS });
    await plantDurableHeadRejection();
    const { controller, reason, fault } = plantAbortAsPersistStarts(note, false);
    const unpin = plantLingeringUnpin();
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([unpin.inUnpin, collection]);
    const recordedWhileLingering = await copyRow(runId);
    const answer = await Promise.race([collection.then(value => ({ ...value, at: performance.now() })), sleep(BOUND_MS + OBSERVE_MS).then(() => null)]);
    const unpinWhenAnswered = { ...unpin.state }, pinsWhenAnswered = await leasePins(executionTarget.leaseId);
    const lockFreeWhileLingering = await independentPoolCanTakeLock();
    unpin.release();
    const result = await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const recorded = await copyRow(runId), pinsAfter = await leasePins(executionTarget.leaseId), lockFreeAfter = await independentPoolCanTakeLock();
    await evidence("r13-failed-outcome-answers-at-the-bound.json", { fault: { ...fault, abortedAt: undefined }, boundMs: BOUND_MS, observedMs: BOUND_MS + OBSERVE_MS,
      answered: answer !== null, answeredAfterAbortMs: answer ? answer.at - fault.abortedAt : null, error: answer?.error ? String(answer.error) : null, reported: briefRow(answer?.row),
      recordedWhileLingering: briefRow(recordedWhileLingering), unpinWhenAnswered, pinsWhenAnswered, lockFreeWhileLingering,
      result: { error: result.error ? String(result.error) : null, row: briefRow(result.row) }, recorded: briefRow(recorded), unpinAfter: { ...unpin.state }, pinsAfter, lockFreeAfter });
    expect.soft(fault, "fixture: one apply, aborted after the tree merge, whose REAL persist failed").toMatchObject({ applies: 1, realPersistCalls: 1, treeMergedAtPersist: true });
    expect.soft(recordedWhileLingering, "fixture: the failed-save hold is already durable while the unpin lingers").toMatchObject({ ...failedHold, receipt: { abortCameTooLate: true, savePending: { code: "AGENT_FILES_SAVE_FAILED" } } });
    expect.soft(answer, `the collection answers within its ${BOUND_MS} ms bound (+ ${OBSERVE_MS} ms observed), not when its lingering bookkeeping ends`).not.toBeNull();
    expect.soft(unpinWhenAnswered, "the bookkeeping was still in flight when the collection answered").toEqual({ reached: true, returned: false });
    expect.soft(answer?.error, "never 'cancelled'").toBeNull();
    expect.soft(answer?.error).not.toBe(reason);
    expect.soft(answer?.row, "the answer is the recorded failed-save hold: never 'saved', never 'still saving'").toMatchObject({ ...failedHold, receipt: { abortCameTooLate: true, savePending: { code: "AGENT_FILES_SAVE_FAILED" } } });
    expect.soft(result).toMatchObject({ error: null, row: failedHold });
    expect.soft(recorded, "the durable record stays the failed-save hold").toMatchObject(failedHold);
    expect.soft(pinsWhenAnswered, "fixture: the lease pin was still set when the collection answered").toHaveLength(1);
    expect.soft({ unpin: unpin.state, pinsAfter }, "the bookkeeping continued after the answer: the lease pin is dropped").toEqual({ unpin: { reached: true, returned: true }, pinsAfter: [] });
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  it("R15 a failed-save record held mid-write for 10 s: answer within 200 ms + 200 ms slack as still saving; settle records the failed hold and DB == tree", async () => {
    const BOUND_MS = 200, ANSWER_SLACK_MS = 200, RECORD_HOLD_MS = 10_000;
    const { service, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: BOUND_MS });
    const before = await canonical(note);
    await plantDurableHeadRejection();
    const slow = "planted_ten_second_failed_save_record";
    await db.execute(sql.raw(`create or replace function ${slow}() returns trigger language plpgsql as $$
      begin if new.company_id = '${companyId}'::uuid and new.error_code = 'AGENT_FILES_SAVE_FAILED' and old.error_code is distinct from 'AGENT_FILES_SAVE_FAILED'
        then perform pg_sleep(${RECORD_HOLD_MS / 1000}); end if; return new; end $$`));
    await db.execute(sql.raw(`create trigger ${slow} before update on agent_instruction_working_copies for each row execute function ${slow}()`)); // PLANTED 10 s mid-write hold, in real PostgreSQL
    plantedInPostgres.push(`drop function if exists ${slow}() cascade`);
    const { controller, reason, fault } = plantAbortAsPersistStarts(note, false);
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    const timedAnswer = collection.then(value => ({ ...value, at: performance.now() }));
    await Promise.race([sleep(15_000), collection, (async () => { while (!fault.abortedAt) await sleep(5); })()]);
    const atDeadline = await Promise.race([timedAnswer, sleep(Math.max(0, fault.abortedAt + BOUND_MS + ANSWER_SLACK_MS - performance.now())).then(() => null)]);
    const recordedAtDeadline = await copyRow(runId), lockFreeAtDeadline = await independentPoolCanTakeLock();
    const answer = await timedAnswer;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const recorded = await copyRow(runId), after = await canonical(note), lockFreeAfter = await independentPoolCanTakeLock();
    await evidence("r15-ten-second-mid-write-bound.json", { boundMs: BOUND_MS, answerSlackMs: ANSWER_SLACK_MS, recordHoldMs: RECORD_HOLD_MS,
      fault: { ...fault, abortedAt: undefined }, answeredWithinBoundAndSlack: atDeadline !== null, answeredAfterAbortMs: answer.at - fault.abortedAt,
      reported: briefRow(answer.row), error: answer.error ? String(answer.error) : null, recordedAtDeadline: briefRow(recordedAtDeadline), lockFreeAtDeadline,
      recorded: briefRow(recorded), before, after, lockFreeAfter });
    expect.soft(fault).toMatchObject({ applies: 1, appliesSettled: 1, realPersistCalls: 1, treeMergedAtPersist: true });
    expect.soft(atDeadline, "the 10 s failed-save UPDATE must not extend the caller's bound").not.toBeNull();
    expect.soft(answer.at - fault.abortedAt).toBeLessThanOrEqual(BOUND_MS + ANSWER_SLACK_MS);
    expect.soft(answer.error, "never cancelled").toBeNull();
    expect.soft(answer.error).not.toBe(reason);
    expect.soft(answer.row, "never saved or failed-save before its record is durable").toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_SAVE_STILL_RUNNING",
      receipt: { abortCameTooLate: true, savePending: { code: "AGENT_FILES_SAVE_STILL_RUNNING" } } });
    expect.soft(recordedAtDeadline.errorCode, "fixture: failed-save record really is still in flight").toBeNull();
    expect.soft(lockFreeAtDeadline, "the mid-write collection keeps its lock after answering").toBe(false);
    expect.soft(recorded).toMatchObject({ ...failedHold, receipt: { abortCameTooLate: true, savePending: { code: "AGENT_FILES_SAVE_FAILED" } } });
    expect.soft(after.manifestHash, "settled durable DB == raw tree").toBe(after.treeHash);
    expect.soft(after).toMatchObject({ generation: before.generation, manifestHasNote: false, treeHasNote: false });
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  it("R14 the failed-save hold is still being WRITTEN when the bound passes, then the unpin lingers: the bounded still-saving answer does not wait for either", async () => {
    const BOUND_MS = 200, RECORD_MS = 1_500, ANSWER_SLACK_MS = 200;
    const { service, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: BOUND_MS });
    await plantDurableHeadRejection();
    // PLANTED DELAY, named at its line: PostgreSQL holds the UPDATE that writes
    // this company's failed-save hold on the copy row for RECORD_MS.
    const slow = "planted_slow_failed_save_record";
    await db.execute(sql.raw(`create or replace function ${slow}() returns trigger language plpgsql as $$
      begin if new.company_id = '${companyId}'::uuid and new.error_code = 'AGENT_FILES_SAVE_FAILED' and old.error_code is distinct from 'AGENT_FILES_SAVE_FAILED'
        then perform pg_sleep(${RECORD_MS / 1000}); end if; return new; end $$`));
    await db.execute(sql.raw(`create trigger ${slow} before update on agent_instruction_working_copies for each row execute function ${slow}()`)); // PLANTED DELAY
    plantedInPostgres.push(`drop function if exists ${slow}() cascade`);
    const { controller, fault } = plantAbortAsPersistStarts(note, false);
    const unpin = plantLingeringUnpin();
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([sleep(15_000), collection, (async () => { while (!fault.abortedAt) await sleep(5); })()]);
    await sleep(Math.max(0, fault.abortedAt + BOUND_MS + 100 - performance.now()));
    // Just past the initial bound: the hold write is still in flight in PostgreSQL.
    // The cap now answers "still saving" rather than waiting 1.5 s for this row.
    const recordedPastBound = await copyRow(runId), answeredPastBound = await Promise.race([collection.then(() => true), sleep(0).then(() => false)]);
    const answer = await Promise.race([collection.then(value => ({ ...value, at: performance.now() })), sleep(Math.max(0, fault.abortedAt + BOUND_MS + ANSWER_SLACK_MS - performance.now())).then(() => null)]);
    const unpinWhenAnswered = { ...unpin.state }, recordedWhenAnswered = await copyRow(runId);
    await unpin.inUnpin;
    const unpinBeforeRelease = { ...unpin.state };
    unpin.release();
    await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    const recorded = await copyRow(runId), pinsAfter = await leasePins(executionTarget.leaseId), lockFreeAfter = await independentPoolCanTakeLock();
    await evidence("r14-failed-outcome-recorded-past-the-bound.json", { fault: { ...fault, abortedAt: undefined }, boundMs: BOUND_MS, recordDelayMs: RECORD_MS,
      recordedPastBound: briefRow(recordedPastBound), answeredPastBound, answered: answer !== null, answeredAfterAbortMs: answer ? answer.at - fault.abortedAt : null,
      error: answer?.error ? String(answer.error) : null, reported: briefRow(answer?.row), unpinWhenAnswered, unpinBeforeRelease, recordedWhenAnswered: briefRow(recordedWhenAnswered),
      recorded: briefRow(recorded), pinsAfter, lockFreeAfter });
    expect.soft(fault).toMatchObject({ applies: 1, realPersistCalls: 1, treeMergedAtPersist: true });
    expect.soft(recordedPastBound.errorCode, "fixture: the failed-save hold is not on the row yet").toBeNull();
    expect.soft(answer, "the record's 1.5 s delay cannot extend the answer bound + 200 ms slack").not.toBeNull();
    expect.soft(answer ? answer.at - fault.abortedAt : Infinity).toBeLessThanOrEqual(BOUND_MS + ANSWER_SLACK_MS);
    expect.soft(unpinWhenAnswered, "the answer precedes even the bookkeeping").toEqual({ reached: false, returned: false });
    expect.soft(unpinBeforeRelease, "the real outcome still records and the bookkeeping continues after the answer").toEqual({ reached: true, returned: false });
    expect.soft(answer?.error, "never 'cancelled'").toBeNull();
    expect.soft(answer?.row, "while its failure is mid-write the answer is still saving, never saved or cancelled").toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_SAVE_STILL_RUNNING",
      receipt: { abortCameTooLate: true, savePending: { code: "AGENT_FILES_SAVE_STILL_RUNNING" } } });
    expect.soft(recordedWhenAnswered?.errorCode, "no concurrent UPDATE overwrote the in-flight outcome").toBeNull();
    expect.soft(recorded).toMatchObject(failedHold);
    expect.soft(pinsAfter, "the bookkeeping continued after the answer").toEqual([]);
    expect.soft(lockFreeAfter).toBe(true);
  }, 60_000);

  // UNVERIFIED-PROJECTION READERS (rf-3 3b(iv), smarty-dev#20787). Person case:
  // a save fails after its tree merge AND the rollback restore ITSELF fails (a
  // double fault). The on-disk files then hold bytes that were never saved, and
  // the projection is marked unverified (its generation marker is removed).
  // A person reading the agent's instructions through feedback or through the
  // support inspection must get the saved files (restored from the durable
  // head under the agent row lock) or a truthful "not available", never the
  // failed save's bytes. Boundary: the REAL readers (feedbackService
  // .saveIssueVote -> its trace bundle; readCustomerSuccessResource), a real
  // agent, real PostgreSQL and files, and rf-3's failed-restore plant below.

  /**
   * PLANTED FAULT, named at its line: rf-3's failed-restore plant (rf3-mcoll9
   * judge-mcoll9-next.test.ts, "JUDGE next unsafe"). The rollback of a failed
   * save puts each kept file back with fs.rename from its `.agent-files-undo-`
   * directory; the SECOND of those renames fails with EIO, so the restore
   * stops part-way and the tree keeps bytes of the failed save.
   */
  function plantFailedRestore() {
    const realRename = fs.rename.bind(fs);
    const fault = { undoRenames: 0, failed: 0 };
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".agent-files-undo-") && ++fault.undoRenames === 2) {
        fault.failed++;
        throw Object.assign(new Error("PLANTED restore failure: the rollback's undo rename fails part-way"), { code: "EIO" }); // PLANTED FAILURE (rf-3's failed-restore plant)
      }
      return realRename(from, to);
    });
    return { fault, remove: () => spy.mockRestore() };
  }

  it.each(["feedback", "customer-success inspection", "database-less instructions service"] as const)("R16 the rollback restore itself fails (rf-3's failed-restore plant: PostgreSQL rejects the durable head, then the undo rename fails with EIO): the real %s reader returns the saved files or 'not available', never the failed save's bytes", async reader => {
    // The saved (durable) files before the run. `0-first.txt` sorts before the
    // entry file, so the entry file is the second undo rename: the planted one.
    const saved: Record<string, string> = { [entryFile]: "# Policy\n", "0-first.txt": "saved first file\n", "edit-me.txt": "pre-existing edited file\n",
      "delete-me.txt": "pre-existing deleted file\n", "outside/deep/untouched.bin": "outside merge entries must never change\n" };
    for (const [name, body] of Object.entries(saved)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), body);
    }
    const { service, copy, executionTarget, runId, note } = await stoppedRunWithUnsavedNote({ agentFileLateAbortSettleMs: 200 });
    // The stopped run's changes. Its save fails: none of these bytes is ever saved.
    const neverSaved = { entry: "# NEVER SAVED instructions of the failed save\n", edit: "new failed-save edit\n" };
    const run = (name: string) => path.join(copy.executionRoot, name);
    await fs.writeFile(run("0-first.txt"), "new failed-save first file\n");
    await fs.writeFile(run(entryFile), neverSaved.entry);
    await fs.writeFile(run("edit-me.txt"), neverSaved.edit);
    await fs.rm(run("delete-me.txt"));
    await fs.mkdir(run("added"), { recursive: true });
    await fs.writeFile(run("added/new.txt"), "new failed-save addition\n");
    const before = await canonical(note);
    const [savedHead] = await observer.select().from(agentFileRoots).where(eq(agentFileRoots.agentId, agentId));
    const savedListing = (savedHead?.entries ?? []).flatMap(entry => entry.kind === "file" ? [[entry.path, entry.size] as const] : []).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    expect(before.manifestHash, "fixture: manifest == tree before the collection").toBe(before.treeHash);
    const rejection = await plantDurableHeadRejection(); // PLANTED: the real persist fails after the tree merge
    const restoreFault = plantFailedRestore(); // PLANTED: the rollback restore of that failed save fails part-way (EIO)
    const { controller, fault, persisting } = plantAbortAsPersistStarts(note, false);
    const collection = outcomeOf(service.collectStopped({ companyId, runId, target: executionTarget, signal: controller.signal }));
    await Promise.race([persisting, collection]);
    const failure = await collection;
    await drainAgentFileCheckpoints();
    await appliesSettled();
    restoreFault.remove();
    await rejection.disarm();
    // RAW: the double fault as it is on disk and in PostgreSQL, before any reader.
    const markerPath = path.join(path.dirname(root), "file-sync", "durable-generation");
    const readMarker = () => fs.readFile(markerPath, "utf8").catch(() => null);
    const onDisk = async (name: string) => fs.readFile(path.join(root, name), "utf8").catch(() => null);
    const faulted = { marker: await readMarker(), ...await canonical(note), entry: await onDisk(entryFile), edit: await onDisk("edit-me.txt") };

    let returned: { entry: string | null; edit: string | null; listing: unknown; unavailable: string | null; raw: unknown };
    if (reader === "feedback") {
      // READER: the real feedback path. A person votes on the agent's comment; the
      // trace bundle carries the agent's current instructions (listing + entry body).
      const { feedbackService } = await import("../services/feedback.js");
      const { issues, issueComments } = await import("@paperclipai/db");
      const issueId = randomUUID(), commentId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Feedback on an agent whose last save failed", status: "todo", priority: "medium", createdByUserId: userId });
      await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorAgentId: agentId, body: "The agent's answer." });
      const feedback = feedbackService(db);
      await feedback.saveIssueVote({ issueId, targetType: "issue_comment", targetId: commentId, vote: "up", authorUserId: userId, allowSharing: true });
      const [trace] = await feedback.listFeedbackTraces({ companyId, issueId, includePayload: true });
      const context = ((trace?.payloadSnapshot as { bundle?: { agentContext?: Record<string, unknown> | null } } | null)?.bundle?.agentContext ?? null);
      const instructions = (context?.instructions ?? null) as { entryBody?: string | null; files?: Array<{ path: string; size: number }> } | null;
      const notes = (trace?.payloadSnapshot as { redactionSummary?: { notes?: string[] } } | null)?.redactionSummary?.notes ?? [];
      returned = { entry: instructions?.entryBody ?? null, edit: null,
        listing: instructions?.files ? instructions.files.map(file => [file.path, file.size] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : null,
        unavailable: instructions ? null : notes.find(item => /agent_instructions_unavailable/.test(item)) ?? "instructions omitted without a reason", raw: { instructions, notes } };
    } else if (reader === "database-less instructions service") {
      // READER: the instructions service built WITHOUT a database (as feedback built it
      // at 17202674). It cannot lock or restore, so its truthful answer is a refusal.
      const { agentInstructionsService } = await import("../services/agent-instructions.js");
      const [owner] = await db.select().from(agents).where(eq(agents.id, agentId));
      const outcome = <T>(work: Promise<T>) => work.then(value => ({ value, refused: null as string | null }),
        (error: { message?: string; details?: { code?: string } }) => ({ value: null as T | null, refused: `${error?.details?.code ?? "error"}: ${error?.message}` }));
      const bundle = await outcome(agentInstructionsService().getBundle(owner!));
      const entry = await outcome(agentInstructionsService().readFile(owner!, entryFile)), edit = await outcome(agentInstructionsService().readFile(owner!, "edit-me.txt"));
      returned = { entry: entry.value?.content ?? null, edit: edit.value?.content ?? null,
        listing: bundle.value ? bundle.value.files.map(file => [file.path, file.size] as const) : null,
        unavailable: bundle.refused ?? entry.refused ?? edit.refused, raw: { bundle: bundle.refused, entry: entry.refused, edit: edit.refused } };
    } else {
      // READER: the real support inspection of the agent's instruction files.
      const { readCustomerSuccessResource } = await import("../services/customer-success-inspection.js");
      const inspect = async (file?: string) => await readCustomerSuccessResource(db, memoryStorage() as never,
        { operation: "instructions.file", companyId, resourceId: agentId, ...(file ? { path: file } : {}) } as never) as { available: boolean; reason?: string; content?: string };
      const text = (answer: { available: boolean; content?: string }) => answer.available ? Buffer.from(answer.content ?? "", "base64").toString("utf8") : null;
      const entry = await inspect(), edit = await inspect("edit-me.txt");
      returned = { entry: text(entry), edit: text(edit), listing: null, unavailable: entry.available && edit.available ? null : String(entry.reason ?? edit.reason), raw: { entry, edit } };
    }
    const after = { marker: await readMarker(), ...await canonical(note), entry: await onDisk(entryFile), edit: await onDisk("edit-me.txt") };
    await evidence(`r16-failed-restore-${reader === "feedback" ? "feedback" : reader === "customer-success inspection" ? "inspection" : "database-less"}-reader.json`, { reader, plant: { persistRejectedBy: "PostgreSQL trigger on agent_file_roots", restore: restoreFault.fault, fault: { ...fault, abortedAt: undefined } },
      failure: { error: failure.error ? String(failure.error) : null, row: briefRow(failure.row) }, saved: { entry: saved[entryFile], edit: saved["edit-me.txt"], listing: savedListing }, neverSaved, before, faulted, returned, after });
    // The fixture really is the double fault: a failed save whose restore failed, marked unverified.
    expect.soft(fault, "fixture: one apply whose REAL persist failed after the tree merge").toMatchObject({ applies: 1, appliesSettled: 1, realPersistCalls: 1, treeMergedAtPersist: true });
    expect.soft(restoreFault.fault, "fixture: the rollback restore failed at its second undo rename (rf-3's plant)").toEqual({ undoRenames: 2, failed: 1 });
    expect.soft(failure, "fixture: the failed save is recorded as held, never 'saved'").toMatchObject({ error: null, row: failedHold });
    expect.soft(faulted.marker, "fixture: the projection is marked UNVERIFIED (no generation marker)").toBeNull();
    expect.soft(faulted.manifestHash, "fixture: the on-disk files no longer match the durable manifest").not.toBe(faulted.treeHash);
    expect.soft(faulted.generation, "fixture: nothing of the failed save was committed").toBe(before.generation);
    expect.soft({ entry: faulted.entry, edit: faulted.edit }, "fixture: the files on disk hold the failed save's never-saved bytes").toEqual(neverSaved);
    // The outcome: what the real reader returned.
    expect.soft(returned.entry ?? "", "the reader never returns the failed save's never-saved entry bytes").not.toContain("NEVER SAVED");
    expect.soft(returned.edit ?? "", "the reader never returns the failed save's never-saved file bytes").not.toBe(neverSaved.edit);
    if (reader === "database-less instructions service") expect.soft(returned.unavailable, "without a database the files cannot be restored: the reader must refuse").not.toBeNull();
    if (returned.unavailable !== null) {
      expect.soft(returned.unavailable, "a reader that cannot restore says the files are not available while they are verified").toMatch(/verif|agent_instructions_unavailable/);
      expect.soft({ entry: returned.entry, edit: returned.edit, listing: returned.listing }, "and returns nothing of the tree").toEqual({ entry: null, edit: null, listing: null });
    } else {
      expect.soft(returned.entry?.trimEnd(), "the saved entry file, restored from the durable head").toBe(saved[entryFile]!.trimEnd());
      if (reader === "feedback") expect.soft(returned.listing, "the saved file listing (paths and sizes), not the failed save's").toEqual(savedListing);
      else expect.soft(returned.edit, "the saved file bytes, restored from the durable head").toBe(saved["edit-me.txt"]);
      expect.soft(after.marker, "the reader restored the projection under the guard: it is marked at the durable generation again").toBe(before.generation);
      expect.soft(after.manifestHash, "and the on-disk files match the durable manifest again").toBe(after.treeHash);
      expect.soft({ entry: after.entry, edit: after.edit }).toEqual({ entry: saved[entryFile], edit: saved["edit-me.txt"] });
    }
    expect.soft(after.generation, "a read never changes what is saved").toBe(before.generation);
  }, 90_000);
});
