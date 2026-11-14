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

// Keep: production M1 idle retry storm (2,736 old unavailable rows), plus data
// safety: retiring cleanup never invents a save/stop receipt or deletes evidence.
describe("working-copy cleanup retry storm", () => {
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

  it.each([false, true])("parks 2,736 unproven sources, then executes zero SQL in a two-minute worker window (stop proof=%s)", async stopped => {
    const rows = await seed(2736, stopped);
    // Performance starts at the final budgeted attempt. Per-row tests below
    // exercise all twelve claims and their durable deadlines.
    await db.update(copies).set({ receipt: sql`${copies.receipt} || '{"cleanupAttempts":11}'::jsonb` }).where(eq(copies.companyId, companyId));
    for (let batch = 0; batch < Math.ceil(rows.length / 20); batch++) await recover(stopped);
    const retained = await db.select().from(copies).where(eq(copies.companyId, companyId));
    expect(retained).toHaveLength(2736);
    // Real wall clock and the real coordinator/DB: retained parked rows must
    // cause no recurring statements, not merely have their timers cancelled.
    const errors: unknown[] = [];
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => { errors.push(error); } });
    const priorDebug = db.$client.options.debug;
    try {
      await service.registerStoppedCollectionWork(worker, () => true, async () => true).ready;
      await service.registerDirectoryCleanupWork(worker, () => true, async () => true).ready;
      await expect.poll(() => idleWorkSnapshot().active).toBe(0);
      const statements: string[] = [];
      db.$client.options.debug = (_id, query) => { statements.push(query); };
      const start = performance.now();
      await new Promise(resolve => setTimeout(resolve, 120_000));
      const windowMs = performance.now() - start;
      await expect.poll(() => idleWorkSnapshot().active).toBe(0);
      process.stdout.write(`STORM realWallClock=true stopProof=${stopped} retained=2736 windowMs=${windowMs} SQL=${statements.length} statementsPerMinute=${statements.length * 60_000 / windowMs}\n`);
      expect(windowMs).toBeGreaterThanOrEqual(119_900);
      expect(statements).toEqual([]);
      expect(worker.nextWakeAt()).toBeNull();
      expect(errors).toEqual([]);
    } finally { db.$client.options.debug = priorDebug; await worker.stop(); }
    // A stale claimed queue entry must also be rejected by SQL after restart;
    // the two partial indexes contain no retired cleanup obligations.
    const plan = await db.transaction(async tx => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(sql`explain (format json) select run_id from ${copies}
        where not (coalesce(${copies.receipt}, '{}'::jsonb) ? 'cleanupParked')
          and not (coalesce(${copies.receipt}, '{}'::jsonb) ? 'cleanupTerminal')
          and not (coalesce(${copies.receipt}, '{}'::jsonb) ? 'retainedByRunId')
          and ${copies.state} = 'unavailable' and ${copies.processStoppedAt} is null
          and ${copies.location} like 'remote:%' and ${copies.receipt}->>'schema' = 'paperclip.agent-files.v1'
        order by run_id limit 20`);
    });
    expect(JSON.stringify(plan)).toContain("agent_instruction_copies_collection_v2_idx");
    const indexes = await db.execute(sql`select indexname, indexdef from pg_indexes where tablename = 'agent_instruction_working_copies'
      and indexname in ('agent_instruction_copies_collection_v2_idx', 'agent_instruction_copies_cleanup_v2_idx')`);
    expect(indexes).toHaveLength(2);
    for (const index of indexes) {
      expect(index.indexdef).toContain("cleanupTerminal");
      expect(index.indexdef).toContain("cleanupParked");
    }
    for (const row of retained) {
      expect(row.receipt).toMatchObject({ cleanupParked: { state: "parked", reason: "retry_exhausted", attempts: 12 }, baseline: { evidence: "keep" } });
      expect(row.receipt?.cleanupTerminal).toBeUndefined();
      expect(row.nextAttemptAt).toBeNull();
      expect(row.errorCode).toBe("INSTRUCTION_COLLECTION_UNAVAILABLE");
      expect(row.candidateHash).toBe("preserved");
      expect(row.candidateBase64).toBe(Buffer.from("preserved bytes").toString("base64"));
      expect(row.processStoppedAt !== null).toBe(stopped);
    }
  }, 180_000);

  it.each(["expired", "stopped", "missing_sandbox"] as const)("parks an unproven %s source without granting stop proof or discarding local bytes", async source => {
    const [{ runId }] = await seed(1, false, source);
    const row = await get(runId);
    await fs.mkdir(row.localRoot, { recursive: true });
    await fs.writeFile(path.join(row.localRoot, "unsaved.txt"), "uncollected evidence");
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let attempt = 0; attempt < 12; attempt++) {
      await recover(false);
      const next = (await get(runId)).nextAttemptAt;
      if (next) vi.setSystemTime(next);
    }
    expect(await get(runId)).toMatchObject({ state: "unavailable", processStoppedAt: null, nextAttemptAt: null,
      receipt: { cleanupParked: { reason: "retry_exhausted" } } });
    expect((await get(runId)).receipt?.cleanupTerminal).toBeUndefined();
    expect(await fs.readFile(path.join(row.localRoot, "unsaved.txt"), "utf8")).toBe("uncollected evidence");
  });

  it("parks an active stopped-and-retained source without executing or granting cleanup authority", async () => {
    const [{ runId, leaseId }] = await seed(1, false, "active");
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const receipt = remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" })!;
    receipt.confirmedAt = new Date(Date.now() - 3_600_000).toISOString();
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: receipt } }).where(eq(environmentLeases.id, leaseId));
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let attempt = 0; attempt < 12; attempt++) {
      await recover(false);
      const next = (await get(runId)).nextAttemptAt;
      if (next) vi.setSystemTime(next);
    }
    expect(await get(runId)).toMatchObject({ state: "unavailable", processStoppedAt: null, nextAttemptAt: null,
      receipt: { cleanupParked: { reason: "retry_exhausted" } } });
    expect((await get(runId)).receipt?.cleanupTerminal).toBeUndefined();
  });

  it.each([false, true])("a fresh retirement backs off without inventing source loss (stop proof=%s)", async stopped => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [{ runId, leaseId }] = await seed(1, stopped);
    const now = Date.now();
    await db.update(environmentLeases).set({ releasedAt: new Date(now) }).where(eq(environmentLeases.id, leaseId));
    await recover(stopped);
    expect((await get(runId)).nextAttemptAt?.getTime()).toBe(now + 30_000);
    expect((await get(runId)).receipt?.cleanupTerminal).toBeUndefined();
    vi.setSystemTime(now + 30_000);
    await recover(stopped);
    expect(await get(runId)).toMatchObject({ nextAttemptAt: new Date(now + 90_000), receipt: { cleanupAttempts: 2 } });
    expect((await get(runId)).receipt?.cleanupTerminal).toBeUndefined();
  });

  it.each([false, true])("concurrent owners count only one due claim (stop proof=%s)", async stopped => {
    const [{ runId }] = await seed(1, stopped, "active");
    vi.useFakeTimers({ toFake: ["Date"] });
    await Promise.all(Array.from({ length: 4 }, () => recover(stopped)));
    expect(await get(runId)).toMatchObject({ receipt: { cleanupAttempts: 1 }, nextAttemptAt: new Date(Date.now() + 30_000) });
  });

  it.each([false, true])("backs off a live lease through minutes/hours and exhausts durably with its last reason (stop proof=%s)", async stopped => {
    const [{ runId }] = await seed(1, stopped, "active");
    vi.useFakeTimers({ toFake: ["Date"] });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      const now = Date.now();
      await recover(stopped);
      const row = await get(runId);
      expect(row.receipt?.cleanupAttempts).toBe(attempt);
      if (attempt < 12) {
        const delay = Math.min(3_600_000, 30_000 * 2 ** (attempt - 1));
        expect(row.nextAttemptAt?.getTime()).toBe(now + delay);
        delays.push(delay);
        // Reinspection before the saved deadline cannot claim or reset it.
        await recover(stopped);
        expect((await get(runId)).nextAttemptAt).toEqual(row.nextAttemptAt);
        vi.setSystemTime(now + delay);
        service = agentInstructionWorkingCopyService(db); // retry count survives restart
      } else {
        expect(row.nextAttemptAt).toBeNull();
        expect(row.receipt).toMatchObject({ cleanupParked: { state: "parked", reason: "retry_exhausted",
          lastReason: stopped ? "remote_cleanup_failed" : "stop_unconfirmed", attempts: 12 } });
        expect(row.errorCode).toBe("INSTRUCTION_COLLECTION_UNAVAILABLE");
      }
    }
    expect(delays.slice(0, 4)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(delays).toContain(3_600_000);
    const settled = await get(runId);
    vi.setSystemTime(Date.now() + 86_400_000);
    await recover(stopped);
    expect(await get(runId)).toEqual(settled);
    const [{ count }] = await db.execute(sql`select count(*)::int as count from ${copies} where ${copies.companyId} = ${companyId}`);
    expect(count).toBe(1);
  });
});
