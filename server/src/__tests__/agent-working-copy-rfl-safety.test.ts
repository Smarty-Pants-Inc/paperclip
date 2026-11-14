import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, environments, environmentLeases, agentInstructionWorkingCopies as copies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

import { environmentService } from "../services/environments.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

// Reconstructed from VERDICT-wcstorm-791c137d.md; judge source unavailable locally.
// Keep: data safety and late-event recovery from the recorded RFL incident.
// Keep: production M1 idle retry storm (2,736 old unavailable rows), plus data
// safety: retiring cleanup never invents a save/stop receipt or deletes evidence.
describe("RFL working-copy reversible parking safety", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof agentInstructionWorkingCopyService>;
  let companyId: string, agentId: string, home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "wc-storm-"));
    database = await startEmbeddedPostgresTestDatabase("wc-storm-db-");
    db = createDb(database.connectionString);
    service = agentInstructionWorkingCopyService(db);
  }, 90_000);
  beforeEach(async () => {
    service = agentInstructionWorkingCopyService(db);
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Working-copy storm", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Cleanup owner" });
  });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(copies).where(eq(copies.companyId, companyId));
    await db.delete(environmentLeases).where(eq(environmentLeases.companyId, companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function seed(count: number, stopped: boolean, source: "released" | "expired" | "stopped" | "missing_sandbox" | "active" = "released") {
    const environmentId = randomUUID(), remoteCwd = "/fixture/old-source";
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    const rows = Array.from({ length: count }, () => ({ runId: randomUUID(), leaseId: randomUUID() }));
    await db.insert(heartbeatRuns).values(rows.map(({ runId }) => ({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "failed" })));
    await db.insert(environmentLeases).values(rows.map(({ runId, leaseId }) => {
      const lease = { id: leaseId, companyId, heartbeatRunId: runId, environmentId: source === "missing_sandbox" ? null : environmentId,
        provider: "daytona", providerLeaseId: "old-box-" + runId };
      return { ...lease, status: source === "active" || source === "missing_sandbox" ? "active" : source === "expired" ? "expired" : "released",
        releasedAt: source === "active" || source === "missing_sandbox" ? null : new Date(Date.now() - 3_600_000),
        cleanupStatus: source === "active" ? null : "success", metadata: source === "stopped" ? {
          remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
        } : {} };
    }));
    // Chunk to stay beneath the driver's bind-parameter limit at production size.
    for (let offset = 0; offset < rows.length; offset += 200) await db.insert(copies).values(rows.slice(offset, offset + 200).map(({ runId, leaseId }) => ({
      runId, companyId, agentId, responsibleUserId: "fixture-user", entryFile: "AGENTS.md", baseHash: "baseline",
      localRoot: path.join(home, runId, "live"), executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, runId),
      location: `remote:${environmentId}`, state: "unavailable", attempts: 3, processStoppedAt: stopped ? new Date() : null,
      errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", errorMessage: "Original collection failure", candidateHash: "preserved",
      candidateBase64: Buffer.from("preserved bytes").toString("base64"), nextAttemptAt: new Date(0),
      receipt: { schema: "paperclip.agent-files.v1", state: "unavailable", baseline: { evidence: "keep" },
        cleanupPending: true, cleanup: { leaseId, remoteCwd } },
    })));
    return rows;
  }
  const recover = (stopped: boolean) => stopped ? service.recoverCaptured() : service.recoverStopped();
  const get = async (runId: string) => (await service.get(companyId, runId))!;


  async function exhaust(stopped: boolean, runId: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let attempt = 0; attempt < 12; attempt++) {
      await recover(stopped);
      const row = await get(runId);
      if (row.nextAttemptAt) vi.setSystemTime(row.nextAttemptAt);
    }
  }
  it.each(["expired", "released", "stopped", "missing_sandbox"] as const)("parks, never source_gone, for unproven %s", async source => {
    const [{ runId, leaseId }] = await seed(1, false, source === "stopped" ? "active" : source);
    if (source === "expired") await db.update(environmentLeases).set({ releasedAt: null }).where(eq(environmentLeases.id, leaseId));
    if (source === "released") await db.update(environmentLeases).set({ releasedAt: new Date(Date.now() - 31_000) }).where(eq(environmentLeases.id, leaseId));
    if (source === "stopped") {
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const receipt = remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" })!;
      receipt.confirmedAt = new Date(Date.now() - 3_600_000).toISOString();
      await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: receipt } }).where(eq(environmentLeases.id, leaseId));
    }
    const initial = await get(runId);
    await fs.mkdir(initial.localRoot, { recursive: true });
    await fs.writeFile(path.join(initial.localRoot, "unsaved.txt"), "unsaved bytes");
    await exhaust(false, runId);
    const parked = await get(runId);
    expect(parked.receipt?.cleanupTerminal).toBeUndefined();
    expect(parked.receipt?.cleanupParked).toMatchObject({ reason: "retry_exhausted", attempts: 12 });
    expect(parked.processStoppedAt).toBeNull();
    expect(parked.nextAttemptAt).toBeNull();
    expect(parked.candidateBase64).toBe(initial.candidateBase64);
    expect(await fs.readFile(path.join(initial.localRoot, "unsaved.txt"), "utf8")).toBe("unsaved bytes");
    await recover(false);
    expect(await get(runId)).toEqual(parked);
  });
  it.each([false, true])("a real destruction producer rearms a parked row and settles it (stopped=%s)", async stopped => {
    const [{ runId, leaseId }] = await seed(1, stopped, "active");
    await exhaust(stopped, runId);
    expect((await get(runId)).receipt?.cleanupParked).toBeDefined();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    await environmentService(db).releaseLease(leaseId, "released", { cleanupStatus: "success",
      remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "destroyed" })! });
    // New process/service and DB handle: no process-local rearm workaround.
    const peer = createDb(database.connectionString);
    try {
      const restored = agentInstructionWorkingCopyService(peer);
      await restored.recoverStopped(); await restored.recoverCaptured(); await restored.release(companyId, runId);
      const settled = await restored.get(companyId, runId);
      expect(settled?.processStoppedAt).not.toBeNull();
      expect(settled?.receipt?.cleanupParked).toBeUndefined();
      expect(settled?.receipt?.cleanupPending).toBe(false);
      expect(settled?.receipt?.cleanupTerminal).toMatchObject({ state: "settled", reason: "source_gone" });
    } finally { await peer.$client.end({ timeout: 1 }); }
  });
  it("explicit release retries a parked saved copy when its transport returns", async () => {
    const [{ runId }] = await seed(1, true, "active");
    await db.update(copies).set({ state: "saved" }).where(eq(copies.runId, runId));
    let healthy = false;
    const execute = vi.fn(async () => ({ exitCode: healthy ? 0 : 1, timedOut: false, stdout: "", stderr: "" }));
    service = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    await exhaust(true, runId);
    expect(execute).toHaveBeenCalledTimes(12);
    expect((await get(runId)).receipt?.cleanupParked).toBeDefined();
    healthy = true;
    await service.release(companyId, runId);
    expect(execute).toHaveBeenCalledTimes(13);
    expect((await get(runId)).receipt?.cleanupParked).toBeUndefined();
    expect((await get(runId)).receipt?.cleanupPending).toBe(false);
  });

  it("a destruction event during the last failed cleanup cannot be overwritten by its stale receipt", async () => {
    const [{ runId, leaseId }] = await seed(1, true, "active");
    await db.update(copies).set({ state: "saved", receipt: sql`${copies.receipt} || '{"cleanupAttempts":11}'::jsonb` }).where(eq(copies.runId, runId));
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { unblock = resolve; });
    const execute = vi.fn(async () => { started(); await held; return { exitCode: 1, timedOut: false, stdout: "", stderr: "" }; });
    service = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    const last = recover(true);
    try {
      await entered;
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      await environmentService(db).releaseLease(leaseId, "released", { cleanupStatus: "success",
        remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "destroyed" })! });
      expect((await get(runId)).receipt?.cleanupParked).toBeUndefined();
    } finally { unblock(); await last; }
    expect((await get(runId)).receipt?.cleanupParked).toBeUndefined();
    await recover(true);
    expect((await get(runId)).receipt?.cleanupPending).toBe(false);
    expect((await get(runId)).receipt?.cleanupTerminal).toMatchObject({ reason: "source_gone" });
  });

  it("persists the final park before I/O so another process cannot claim attempt thirteen", async () => {
    const [{ runId }] = await seed(1, true, "active");
    await db.update(copies).set({ state: "saved" }).where(eq(copies.runId, runId));
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { unblock = resolve; });
    let calls = 0;
    const execute = vi.fn(async () => {
      if (++calls === 12) { started(); await held; }
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "" };
    });
    service = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let attempt = 0; attempt < 11; attempt++) {
      await recover(true);
      vi.setSystemTime((await get(runId)).nextAttemptAt!);
    }
    const last = recover(true);
    const peer = createDb(database.connectionString);
    try {
      await entered;
      expect((await get(runId)).receipt?.cleanupParked).toMatchObject({ attempts: 12 });
      vi.setSystemTime(Date.now() + 86_400_000);
      await agentInstructionWorkingCopyService(peer, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService }).recoverCaptured();
      expect(execute).toHaveBeenCalledTimes(12);
    } finally { unblock(); await last; await peer.$client.end({ timeout: 1 }); }
    expect((await get(runId)).receipt?.cleanupParked).toMatchObject({ attempts: 12 });
  });

  it.each(["gone", "stopped", "unknown"] as const)("uses fresh standing provider proof, never a %s timer/label guess", async kind => {
    const [{ runId }] = await seed(1, false, "active");
    await db.update(heartbeatRuns).set({ runnerInstanceId: randomUUID(), nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, runId));
    const execute = vi.fn(async () => { throw new Error("must not restart a stopped provider"); });
    const readPredecessorSandboxRecord = vi.fn(async () => kind === "gone" ? { kind: "gone" } : kind === "unknown" ? { kind: "unknown" }
      : { kind: "present", state: "stopped", stoppedAt: new Date(Date.now() - 86_400_000).toISOString(), lastRebootAt: null });
    service = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute, readPredecessorSandboxRecord } as unknown as EnvironmentRuntimeService });
    await recover(false);
    const row = await get(runId);
    expect(readPredecessorSandboxRecord).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    if (kind === "gone") {
      expect(row.receipt?.cleanupTerminal).toMatchObject({ state: "abandoned", reason: "source_gone", proof: { predicate: "remoteRunnerGenerationLost" } });
      const before = row;
      await service.release(companyId, runId); // does not contradict standing proof
      expect(await get(runId)).toEqual(before);
    } else {
      expect(row.receipt?.cleanupTerminal).toBeUndefined();
      expect(row.nextAttemptAt).not.toBeNull();
    }
  });

  it.each([false, true])("a committed destruction event wakes the existing idle workers; rollback does not (stopped=%s)", async stopped => {
    const [{ runId, leaseId }] = await seed(1, stopped, "active");
    await exhaust(stopped, runId);
    vi.useRealTimers();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const destroy = (client: typeof db) => environmentService(client).releaseLease(leaseId, "released", { cleanupStatus: "success",
      remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "destroyed" })! });
    const errors: unknown[] = [];
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => { errors.push(error); } });
    try {
      await service.registerStoppedCollectionWork(worker, () => true, async () => true).ready;
      await service.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
      await expect.poll(() => idleWorkSnapshot().active).toBe(0);
      expect(worker.nextWakeAt()).toBeNull();
      await expect(db.transaction(async tx => { await destroy(tx as unknown as typeof db); throw new Error("rollback fixture"); })).rejects.toThrow("rollback fixture");
      expect((await get(runId)).receipt?.cleanupParked).toBeDefined();
      await destroy(db);
      await expect.poll(async () => (await get(runId)).receipt?.cleanupPending, { timeout: 10_000 }).toBe(false);
      expect((await get(runId)).receipt?.cleanupParked).toBeUndefined();
      expect((await get(runId)).receipt?.cleanupTerminal).toMatchObject({ state: "settled", reason: "source_gone" });
      expect(errors).toEqual([]);
    } finally { await worker.stop(); }
  });
});
