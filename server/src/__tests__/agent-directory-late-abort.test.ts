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
  /** R6: armed by plantAbortInReleaseCleanup; consumed by the sandbox runner below. */
  let cleanupFault: { armed: boolean; controller: AbortController; reason: Error; reached: () => void; gate: Promise<void> } | null = null;
  /** R8: counts remote capture commands; the second one (the retry's) aborts and hangs. */
  let captureFault: { captures: number; controller: AbortController; reason: Error; reached: () => void; gate: Promise<void> } | null = null;

  const evidence = async (name: string, proof: unknown) => {
    if (process.env.TASK_OUT) await fs.writeFile(path.join(process.env.TASK_OUT, name), JSON.stringify(proof, null, 2));
  };
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  /** In-memory stand-in for the shared object store (provider "s3"). */
  const memoryStorage = () => ({
    provider: "s3" as const,
    async putFile(input: { companyId: string; namespace: string; body: Readable; byteSize: number; sha256: string }) {
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
  async function stoppedRunWithUnsavedNote(options: { agentFileLateAbortSettleMs: number }) {
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), leaseId: randomUUID(), remoteCwd, runner };
    await db.insert(environments).values({ id: executionTarget.environmentId, name: `Late abort fixture ${executionTarget.environmentId}`, driver: "sandbox" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.insert(environmentLeases).values({ id: executionTarget.leaseId, companyId, environmentId: executionTarget.environmentId,
      heartbeatRunId: runId, provider: "daytona", providerLeaseId: `late-abort-${runId}` });
    const service = agentInstructionWorkingCopyService(db, options as Parameters<typeof agentInstructionWorkingCopyService>[1]);
    const copy = (await service.prepare({ companyId, agentId, runId, cwd: home, target: executionTarget, warm: true }))!;
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
    abortSignal = null; cleanupFault = null; captureFault = null; runnerCalls.length = 0; releases.length = 0; objects.clear();
    applyCount.started = 0; applyCount.settled = 0;
    const actualStore = fileStoreModule.agentFileStore;
    vi.spyOn(fileStoreModule, "agentFileStore").mockImplementation((...args) => {
      const store = actualStore(...args), realApply = store.apply.bind(store);
      vi.spyOn(store, "apply").mockImplementation(async (...applyArgs) => {
        applyCount.started++;
        try { return await realApply(...applyArgs); } finally { applyCount.settled++; }
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
    // No rollback machinery is added: the rolled-back transaction leaves the
    // merged tree, and the store's existing restore heals it under its next lock.
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
});
