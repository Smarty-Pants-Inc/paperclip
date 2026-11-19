import { notifyNativeEnvironmentSettlement } from "../services/native-environment-settlement-notifications.js";
import { notifyRetainedNativeSessionCleanup, onRetainedNativeSessionCleanupRelease, releaseRetainedNativeSessionCleanup } from "../services/retained-native-session-cleanup-notifications.js";
import { environmentService } from "../services/environments.js";
import { agentService } from "../services/agents.js";
import { publishNativeHarnessBackup } from "../services/native-runtime/native-harness-backup-publication.js";
import { registerNativeHarnessBackupExpirationWork } from "../services/native-runtime/native-harness-backup-expiration-work.js";
import { noteNativeHarnessBackupChange } from "../services/native-harness-backup-expiration-notifications.js";
import { writeEnvironmentCleanup } from "../services/environment-cleanup-notifications.js";
import { issueService } from "../services/issues.js";
import { applyPendingMigrations } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { registerNativeRunnerEvidenceRetentionWork } from "../services/native-runtime/native-runner-evidence-retention-work.js";
import { noteNativeRunnerEvidence } from "../services/native-runtime/native-runner-evidence-signal.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  environmentLeases,
  environments,
  sandboxCreationOperations,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunnerCheckpoints,
} from "@paperclipai/db";
import { recoveryPostgresSupport as embeddedPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { nativeHarnessBackupExpirationService } from "../services/native-runtime/native-harness-backup-expiration.ts";
import { buildNativeHarnessBackupManifest } from "../services/native-runtime/native-session-executor.ts";
import { createNativeHarnessBackupStamp, verifyNativeHarnessBackupStamp } from "../services/native-runtime/native-harness-backup-stamp.ts";
import { createNativeSetupRuntime } from "../services/native-runtime/native-setup-evidence.js";
import { nativeCheckpointRetirement } from "../services/native-runtime/native-runner-checkpoint-retirement.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { logger } from "../middleware/logger.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_RETENTION_TEST_DATABASE_URL");
const describeEmbeddedPostgres = external || embeddedPostgresSupport.supported ? describe : describe.skip;

if (!external && !embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres native harness backup expiration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

describeEmbeddedPostgres("native harness backup expiration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startRecoveryPostgres>> | null = null;
  let stateBase = "";
  const now = new Date();

  beforeAll(async () => {
    if (!external) tempDb = await startRecoveryPostgres("paperclip-native-backup-expiration-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? tempDb!.connectionString);
  }, 20_000);

  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerNativeRunnerEvidenceRetentionWork> | undefined;
  let admitted = true;
  let backupWorker: ReturnType<typeof registerNativeHarnessBackupExpirationWork> | undefined;
  const backupErrors: unknown[] = [];
  afterEach(async () => {
    await backupWorker?.stop(); backupWorker = undefined; backupErrors.length = 0;
    worker?.unsubscribe(); await coordinator?.stop(); coordinator = undefined; worker = undefined; admitted = true;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await db.delete(agentTaskSessions);
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    if (stateBase) await fs.rm(stateBase, { recursive: true, force: true });
    stateBase = "";
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedSession(input: {
    companyId?: string; agentId?: string;
    issueStatus?: string;
    closedDaysAgo?: number;
    runStatus?: string;
    finalization?: { phase: string; recoveryState?: string | null; leaseOwner?: string | null };
    leaseStatus?: string;
    backupAgeDays?: number;
    cleanupActive?: boolean;
  } = {}) {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-sessions-"));
    const companyId = input.companyId ?? randomUUID();
    if (!input.companyId) await db.insert(companies).values({ id: companyId, name: "Backups", issuePrefix: `B${companyId.slice(0, 6)}` });
    const [agent] = input.agentId ? [{ id: input.agentId }]
      : await db.insert(agents).values({ companyId, name: "Coder" }).returning();
    const issueStatus = input.issueStatus ?? "done";
    const closedAt = new Date(now.getTime() - (input.closedDaysAgo ?? 10) * DAY_MS);
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Closed work",
      status: issueStatus,
      completedAt: issueStatus === "done" ? closedAt : null,
      cancelledAt: issueStatus === "cancelled" ? closedAt : null,
    }).returning();
    const sessionId = randomUUID();
    const runStatus = input.runStatus ?? "succeeded";
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent!.id,
      status: runStatus,
      issueId: issue!.id,
      nativeIssueId: issue!.id,
      nativeSessionId: sessionId,
      finishedAt: ["queued", "running"].includes(runStatus) ? null : closedAt,
    }).returning();
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId: agent!.id,
      adapterType: "paperclip_runner",
      taskKey: issue!.id,
      sessionParamsJson: { sessionId },
      lastRunId: run!.id,
    });
    if (input.finalization) {
      await db.insert(nativeRunFinalizations).values({
        runId: run!.id,
        companyId,
        issueId: issue!.id,
        phase: input.finalization.phase,
        recoveryState: input.finalization.recoveryState ?? null,
        leaseOwner: input.finalization.leaseOwner ?? null,
      });
    }
    const scopeId = randomUUID();
    const scope = createHash("sha256").update(scopeId).digest("hex");
    const root = path.join(stateBase, scope);
    const current = path.join(root, "failover-backups", "current");
    await fs.mkdir(path.join(root, "control-plane"), { recursive: true });
    await fs.writeFile(
      path.join(root, "control-plane", "control-plane-state.json"),
      JSON.stringify({ identity: { runId: run!.id, normalizedSessionId: sessionId } }),
    );
    await fs.mkdir(path.join(current, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(current, "codex-home", "history.jsonl"), "x".repeat(64 * 1024));
    await fs.writeFile(path.join(current, "manifest.json"), "{}");
    const backupAt = new Date(now.getTime() - (input.backupAgeDays ?? 9) * DAY_MS);
    await fs.utimes(current, backupAt, backupAt);
    if (input.cleanupActive) await fs.writeFile(path.join(root, "cleanup-activation.json"), "{}");
    if (input.leaseStatus) {
      await db.insert(environmentLeases).values({
        companyId,
        status: input.leaseStatus,
        metadata: { nativeHarnessBackup: { sessionScopeSha256: scope } },
      });
    }
    const digest = await treeDigest(current);
    return { companyId, agentId: agent!.id, issueId: issue!.id, runId: run!.id, sessionId, scopeId, scope, root, current, digest };
  }

  /** Seed-time content digest of a backup tree (paths + bytes), re-hashed by expectKept. */
  async function treeDigest(directory: string): Promise<string> {
    const hash = createHash("sha256");
    const visit = async (current: string, relative: string): Promise<void> => {
      for (const name of (await fs.readdir(current)).sort()) {
        const full = path.join(current, name), entry = relative ? `${relative}/${name}` : name;
        if ((await fs.lstat(full)).isDirectory()) { hash.update(`d:${entry}\0`); await visit(full, entry); }
        else { hash.update(`f:${entry}\0`); hash.update(await fs.readFile(full)); }
      }
    };
    await visit(directory, "");
    return hash.digest("hex");
  }

  /** SUPERSEDE-HARNESS-BACKUP-RETENTION-KEEP-1118: the backup is still current and re-hashes to its seed digest. */
  async function expectKept(session: { current: string; digest: string }) {
    expect(await exists(session.current)).toBe(true);
    expect(await treeDigest(session.current)).toBe(session.digest);
  }

  /** The real producers behind a stamp: buildNativeHarnessBackupManifest writes the
   * manifest of `current`, createNativeHarnessBackupStamp stamps it (as the executor
   * does, exec:20079-20129), so verifyNativeHarnessBackupStamp re-hashes the bytes. */
  async function stampBackup(session: Awaited<ReturnType<typeof seedSession>>) {
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", stateBase);
    await fs.mkdir(path.join(session.current, "runner"), { recursive: true });
    await fs.writeFile(path.join(session.current, "runner", "runner-state.json"), JSON.stringify({ runId: session.runId }));
    const runnerInstanceId = randomUUID(), providerLeaseId = randomUUID();
    const execution = { provider: { kind: "codex" }, binding: { companyId: session.companyId, issueId: session.issueId,
      runId: session.runId, agentId: session.agentId, executionWorkspaceId: randomUUID() },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: session.sessionId, driverKind: "codex_app_server",
        protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } as never;
    const manifest = buildNativeHarnessBackupManifest({ backupRoot: session.current, execution, runnerInstanceId,
      providerSessionIdentity: { providerSessionId: randomUUID() }, sourceProviderLeaseId: providerLeaseId });
    await fs.writeFile(path.join(session.current, "manifest.json"), JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: path.join(session.current, "manifest.json"),
      sessionScopeId: session.scopeId, authorizedProviderLeaseId: providerLeaseId, runnerInstanceId,
      normalizedSessionId: session.sessionId, completedAt: manifest.completedAt });
    return { stamp, providerLeaseId };
  }

  function service() {
    return nativeHarnessBackupExpirationService(db, {
      stateBase,
      closedForDays: 7,
      now,
      isSessionBusy: () => false,
    });
  }

  async function taskSessionCount(agentId: string) {
    return (await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId))).length;
  }

  async function seedCheckpoint(session: Awaited<ReturnType<typeof seedSession>>) {
    await db.insert(nativeRunnerCheckpoints).values(["header", "cursor", "event:1"].map(part => ({
      companyId: session.companyId, issueId: session.issueId, runId: session.runId, part, material: { encrypted: true },
    })));
  }

  it.each([false, true])("adds no periodic database work after startup (retained history: %s)", async retained => {
    if (retained) {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session); // Saved resume pointer deliberately protects it.
      await fs.rm(stateBase, { recursive: true, force: true });
    } else {
      stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "empty-checkpoint-retention-"));
    }
    const expiration = service();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const select = vi.spyOn(db, "select");
    try {
      await expiration.registerCheckpointExpiration(coordinator).ready;
      expect(select).toHaveBeenCalled();
      const reads = select.mock.calls.length;
      expect(coordinator.nextWakeAt()).toBeNull();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      // The unchanged hourly filesystem sweep must not enumerate DB checkpoints.
      for (let hour = 0; hour < 3; hour++) await expiration.tick();
      expect(select).toHaveBeenCalledTimes(reads);
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally {
      await coordinator.stop();
      select.mockRestore();
      vi.useRealTimers();
    }
    if (retained) {
      expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
      await db.delete(agentTaskSessions);
      const nextStartup = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
      try {
        await service().registerCheckpointExpiration(nextStartup).ready;
        // Retention keeps the unreferenced checkpoint (R-keep-all-traces) and goes quiet.
        expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
        expect(nextStartup.nextWakeAt()).toBeNull();
      } finally { await nextStartup.stop(); }
    }
  });

  it("preserves startup expiration across drain without querying while paused", async () => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    let draining = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const select = vi.spyOn(db, "select");
    const onError = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError });
    try {
      await service().registerCheckpointExpiration(coordinator).ready;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(select).not.toHaveBeenCalled();
      draining = false;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
      await coordinator.stop(); // Await the DB transaction before asserting.
      expect(onError).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalled(); // the resumed pass ran, and kept every row
      expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
    } finally {
      await coordinator.stop();
      select.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries a failed checkpoint from an earlier page before startup cleanup goes quiet, keeping every checkpoint", async () => {
    for (let index = 0; index < 2; index++) {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session);
    }
    await db.delete(agentTaskSessions);
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("temporary retention failure"));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
    try {
      const expiration = nativeHarnessBackupExpirationService(db, { now, maxEntries: 1 });
      await expiration.registerCheckpointExpiration(coordinator).ready;
      await vi.waitFor(async () => {
        // The failed first transaction is retried (fail + retry + second page).
        expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(6);
    } finally {
      await coordinator.stop();
      transaction.mockRestore();
    }
  });

  it.each(["query", "transaction"] as const)("bounds persistent startup %s failures and becomes quiet until the next startup", async fault => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    const failure = fault === "query"
      ? vi.spyOn(db, "select").mockImplementation(() => { throw new Error("retention candidate query unavailable"); })
      : vi.spyOn(db, "transaction").mockRejectedValue(new Error("retention transaction unavailable"));
    const warning = vi.spyOn(logger, "warn");
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
    try {
      await service().registerCheckpointExpiration(coordinator).ready;
      await vi.waitFor(() => {
        // No scheduled deadline can also mean a retry is currently running.
        // Wait for the owner's final deferral before asserting quiet time.
        expect(warning).toHaveBeenCalledWith(expect.objectContaining({ failedPasses: 3 }),
          "startup checkpoint expiration retries exhausted; retained checkpoints deferred to next startup");
        expect(failure).toHaveBeenCalledTimes(3);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const attempts = failure.mock.calls.length;
      expect(attempts).toBe(3);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(failure).toHaveBeenCalledTimes(attempts);
    } finally {
      await coordinator.stop(); failure.mockRestore(); warning.mockRestore(); vi.useRealTimers();
    }
    expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
    const nextStartup = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: vi.fn() });
    try {
      await service().registerCheckpointExpiration(nextStartup).ready;
      expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3); // kept, not deleted
      expect(nextStartup.nextWakeAt()).toBeNull();
    } finally { await nextStartup.stop(); }
  });

  it("keeps unreferenced settled checkpoints even with an empty controller disk and fences no writer", async () => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    await fs.rm(stateBase, { recursive: true, force: true });
    const result = await service().tickCheckpoints();
    expect(result).toMatchObject({ expiredCheckpoints: 0, checkpointCandidates: 0, failed: 0 });
    expect(result.skipped.native_runner_checkpoint_kept).toBe(1);
    expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
    const [authority] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, session.runId));
    expect(authority?.controllerGeneration).toBe(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it.each(["fresh", "retired_before_rule"] as const)("RK4 (never-OK, no S3): a settled, unreferenced runner checkpoint (%s) past 7 days keeps every row byte for byte and fences no writer", async state => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    if (state === "retired_before_rule") {
      // A retirement written by expiry before this rule, whose deletion never ran:
      // its cursor and event parts still hold the controller journal.
      await db.update(nativeRunnerCheckpoints).set({ material: nativeCheckpointRetirement({ companyId: session.companyId,
        agentId: session.agentId, sessionId: session.sessionId, runIds: [session.runId] }) })
        .where(eq(nativeRunnerCheckpoints.part, "header"));
    }
    const rows = async () => (await db.select({ part: nativeRunnerCheckpoints.part, material: nativeRunnerCheckpoints.material })
      .from(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, session.runId))).sort((a, b) => a.part.localeCompare(b.part));
    const before = JSON.stringify(await rows());
    const later = nativeHarnessBackupExpirationService(db, { stateBase, closedForDays: 7, now: new Date(now.getTime() + 8 * DAY_MS),
      isSessionBusy: () => false });
    for (const expiration of [service(), later]) {
      const result = await expiration.tickCheckpoints();
      expect(result).toMatchObject({ expiredCheckpoints: 0, checkpointCandidates: 0, failed: 0 });
      expect(result.skipped.native_runner_checkpoint_kept).toBe(1);
    }
    expect(JSON.stringify(await rows())).toBe(before);
    expect((await rows()).map(row => row.part)).toEqual(["cursor", "event:1", "header"]);
    const [authority] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, session.runId));
    expect(authority?.controllerGeneration).toBe(0);
  });

  it.each(["resume", "lease", "lease_stamp", "recovery", "running", "recent", "open", "execution", "dry_run"])(
    "preserves a checkpoint protected by %s without its controller disk", async protection => {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session);
      await fs.rm(stateBase, { recursive: true, force: true });
      if (protection !== "resume") await db.delete(agentTaskSessions);
      if (protection === "lease") await db.insert(environmentLeases).values({
        companyId: session.companyId, issueId: session.issueId, status: "retained",
      });
      if (protection === "lease_stamp") await db.insert(environmentLeases).values({
        companyId: session.companyId, status: "retained",
        metadata: { nativeHarnessBackup: { normalizedSessionId: session.sessionId } },
      });
      if (protection === "recovery") await db.update(nativeRunFinalizations).set({ recoveryState: "pending" });
      if (protection === "running") await db.update(heartbeatRuns).set({ status: "running" });
      if (protection === "recent") await db.update(issues).set({ completedAt: now });
      if (protection === "open") await db.update(issues).set({ status: "in_progress" });
      if (protection === "execution") await db.update(issues).set({ executionRunId: session.runId });
      expect(await service().tickCheckpoints({ dryRun: protection === "dry_run" })).toMatchObject({ expiredCheckpoints: 0, failed: 0 });
      expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
      const [authority] = await db.select().from(nativeRunFinalizations);
      expect(authority?.controllerGeneration).toBe(0);
      // Break the issue/run reference cycle before the shared teardown.
      if (protection === "execution") await db.update(issues).set({ executionRunId: null });
    },
  );

  it("reads one company's session runs through the company/session index", async () => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await seedCheckpoint(session);
    await db.delete(agentTaskSessions);
    await fs.rm(stateBase, { recursive: true, force: true });
    // Another company's live run with the same session ID must not protect it.
    const foreign = await seedSession({ runStatus: "running" });
    await db.update(heartbeatRuns).set({ nativeSessionId: session.sessionId }).where(eq(heartbeatRuns.id, foreign.runId));
    await db.delete(agentTaskSessions);
    // Another live run of the same agent in a different session must not either.
    await db.insert(heartbeatRuns).values({ companyId: session.companyId, agentId: session.agentId, status: "running",
      issueId: session.issueId, nativeIssueId: session.issueId, nativeSessionId: randomUUID() });
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const prior = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, params) => { statements.push({ sql: query, params: [...params] }); };
    try {
      // Neither foreign run protects it: it reaches the keep (not a blocker).
      const dry = await service().tickCheckpoints({ dryRun: true });
      expect(dry).toMatchObject({ checkpointCandidates: 0, failed: 0 });
      expect(dry.skipped.native_runner_checkpoint_kept).toBe(1);
    } finally { db.$client.options.debug = prior; }
    const lookup = statements.find(query => query.sql.includes("nativeControllerRecovery")
      && query.sql.includes('"heartbeat_runs"."native_session_id" = '));
    expect(lookup).toBeTruthy();
    const plan = await db.$client.begin(async sql => {
      await sql.unsafe("set local enable_seqscan = off");
      return JSON.stringify(await sql.unsafe(`explain (format json) ${lookup!.sql}`, lookup!.params as never[]));
    });
    expect(plan).toContain("heartbeat_runs_company_native_session_idx");

    // A second live run of the same session, company and agent protects it.
    await db.insert(heartbeatRuns).values({ companyId: session.companyId, agentId: session.agentId, status: "running",
      issueId: session.issueId, nativeIssueId: session.issueId, nativeSessionId: session.sessionId });
    const protectedDry = await service().tickCheckpoints({ dryRun: true });
    expect(protectedDry).toMatchObject({ checkpointCandidates: 0, failed: 0 });
    expect(protectedDry.skipped.native_runner_checkpoint_kept).toBeUndefined(); // a blocker, not the keep
    expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(3);
  });

  it("continues checkpoint retention past retained sessions within bounded pages and keeps every checkpoint", async () => {
    for (let index = 0; index < 3; index++) {
      const session = await seedSession({ finalization: { phase: "committed" } });
      await seedCheckpoint(session);
    }
    await fs.rm(stateBase, { recursive: true, force: true });
    const expiration = service();
    expect(await expiration.tickCheckpoints({ maxEntries: 2 })).toMatchObject({ expiredCheckpoints: 0, truncated: true });
    expect(await expiration.tickCheckpoints({ maxEntries: 2 })).toMatchObject({ expiredCheckpoints: 0, truncated: false });
    await db.delete(agentTaskSessions);
    const firstPage = await expiration.tickCheckpoints({ maxEntries: 2 });
    expect(firstPage).toMatchObject({ expiredCheckpoints: 0, truncated: true });
    expect(firstPage.skipped.native_runner_checkpoint_kept).toBe(2);
    const secondPage = await expiration.tickCheckpoints({ maxEntries: 2 });
    expect(secondPage).toMatchObject({ expiredCheckpoints: 0, truncated: false });
    expect(secondPage.skipped.native_runner_checkpoint_kept).toBe(1);
    expect(await db.select().from(nativeRunnerCheckpoints)).toHaveLength(9);
  });

  it("excludes setup evidence scopes from session discovery without altering their evidence", async () => {
    const session = await seedSession();
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", stateBase);
    const setupRuntime = await createNativeSetupRuntime(session.companyId);
    const setupRoot = path.dirname(setupRuntime);
    const evidence = path.join(setupRoot, "setup-evidence.json");
    await fs.writeFile(evidence, "preserve setup evidence\n");

    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, candidates: 0, expired: 0 });
    expect(result.skipped.native_backup_local_copy_kept).toBe(1);
    await expectKept(session);
    expect(result.skipped.no_backup).toBeUndefined();
    expect(await fs.readFile(evidence, "utf8")).toBe("preserve setup evidence\n");
    await fs.rm(setupRuntime, { recursive: true, force: true });
  });

  it("keeps the backup of a session whose issue closed before the window: still current, re-hashes, resume pointer kept", async () => {
    const session = await seedSession();
    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, candidates: 0, expired: 0, clearedTaskSessions: 0, failed: 0 });
    expect(result.skipped.native_backup_local_copy_kept).toBe(1);
    expect(result.reclaimedBytes).toBe(0);
    await expectKept(session);
    expect(await exists(path.join(session.root, "control-plane", "control-plane-state.json"))).toBe(true);
    expect(await fs.readdir(path.join(session.root, "failover-backups"))).toEqual(["current"]);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("RK1 (never-OK, no S3): a destroyed box's backup, issue closed, no live lease, clock +8 days: tick, expireBackup and reconcileBackup keep it current and it re-hashes to its stamp", async () => {
    expect(process.env.PAPERCLIP_STORAGE_PROVIDER ?? "local_disk").not.toBe("s3");
    // Issue closed now, backup written now; the box's lease ended "expired" (what the
    // turn-end destroy leaves, environment-runtime releaseRunLeases): no live lease.
    const session = await seedSession({ closedDaysAgo: 0, backupAgeDays: 0, leaseStatus: "expired",
      finalization: { phase: "committed" } });
    const backup = await stampBackup(session);
    expect(verifyNativeHarnessBackupStamp(backup.stamp, backup.providerLeaseId)).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * DAY_MS));
    const retention = nativeHarnessBackupExpirationService(db, { stateBase, closedForDays: 7, isSessionBusy: () => false });
    const pass = await retention.tick();
    expect(pass).toMatchObject({ candidates: 0, expired: 0, failed: 0 });
    expect((await retention.expireBackup(session.scope)).expired).toBe(0);
    expect((await retention.reconcileBackup(session.scope))?.dueAt).toBeNull();
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
    expect(await fs.readdir(path.join(session.root, "failover-backups"))).toEqual(["current"]);
    expect(verifyNativeHarnessBackupStamp(backup.stamp, backup.providerLeaseId)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  // Data-safety regression: exercise the actual DB decision and recursive
  // deletion, including crash leftovers. No deletion or storage mocks.
  it.each(["backup", "continuity", "quarantine", "expired_backup", "retiring_backup", "expired_continuity", "expired_quarantine"])(
    "keeps every Pi conversation byte in place when retention reaches %s", async kind => {
      const session = await seedSession();
      let source = session.current;
      if (kind === "continuity" || kind === "expired_continuity") source = await seedArchive(session.root);
      if (kind === "quarantine" || kind === "expired_quarantine") source = await seedQuarantine(session.scope);
      if (kind.startsWith("expired_") || kind === "retiring_backup") {
        const parent = kind.endsWith("backup") ? path.dirname(session.current) : path.dirname(source);
        const leftover = path.join(parent, `${kind === "retiring_backup" ? ".retiring-" : ".expired-"}${randomUUID()}`);
        if (source === session.current && kind === "retiring_backup") {
          // A newer current makes settleLeftovers discard the interrupted copy.
          await fs.cp(source, leftover, { recursive: true });
        } else await fs.rename(source, leftover);
        source = leftover;
      }
      const files = new Map([
        [`pi/${session.sessionId}.jsonl.invalid-garbage`, process.env.PAPERCLIP_NATIVE_RETENTION_ORIGINAL
          ? await fs.readFile(process.env.PAPERCLIP_NATIVE_RETENTION_ORIGINAL) : Buffer.from([0, 255, 10, 123])],
        [`pi/${session.sessionId}.jsonl.invalid-foreign`, Buffer.from('{"type":"session","id":"foreign"}\n')],
        [`pi/${session.sessionId}.jsonl`, process.env.PAPERCLIP_NATIVE_RETENTION_SESSION
          ? await fs.readFile(process.env.PAPERCLIP_NATIVE_RETENTION_SESSION)
          : Buffer.from('{"type":"session","id":"missing-file-era"}\n{"type":"message","text":"only copy"}\n')],
        ["pi-agent/sessions/child/session.jsonl", Buffer.from('{"type":"session","id":"native-child"}\n')],
      ]);
      for (const [relative, bytes] of files) {
        await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
        await fs.writeFile(path.join(source, relative), bytes);
      }
      const old = new Date(now.getTime() - 10 * DAY_MS);
      await fs.utimes(source, old, old);
      // An interrupted expiry's .expired- copy of the only backup is put back as current.
      const keptAt = kind === "expired_backup" ? session.current : source;
      const assertInPlace = async () => {
        for (const [relative, bytes] of files) expect(await fs.readFile(path.join(keptAt, relative)), `${kind}: ${relative} kept in place`).toEqual(bytes);
        expect(await exists(path.join(stateBase, "conversation-evidence"))).toBe(false);
      };
      const result = await service().tick();
      expect(result).toMatchObject({ failed: 0, expired: 0, evidenceRemoved: 0 });
      await assertInPlace();
      // A new service (no in-memory exemption) and a much later clock keep it too.
      await nativeHarnessBackupExpirationService(db, { stateBase, now: new Date(now.getTime() + 3650 * DAY_MS),
        isSessionBusy: () => false }).tick();
      await assertInPlace();
    },
  );

  it("keeps the backup of a cancelled issue's session", async () => {
    const session = await seedSession({ issueStatus: "cancelled" });
    expect(await service().tick()).toMatchObject({ expired: 0, skipped: { native_backup_local_copy_kept: 1 } });
    await expectKept(session);
  });

  it.each([
    ["issue_open", { issueStatus: "in_progress" }],
    ["recently_closed", { closedDaysAgo: 2 }],
    ["live_run", { runStatus: "running" }],
    ["pending_finalization", { finalization: { phase: "settling" } }],
    ["pending_finalization", { finalization: { phase: "observed", recoveryState: "resuming_session" } }],
    ["pending_finalization", { finalization: { phase: "committed", leaseOwner: "controller" } }],
    ["live_lease", { leaseStatus: "released" }],
    ["recent_backup", { backupAgeDays: 1 }],
    ["cleanup_active", { cleanupActive: true }],
  ] as const)("keeps the backup when %s", async (reason, input) => {
    const session = await seedSession(input);
    const result = await service().tick();

    expect(result).toMatchObject({ checked: 1, candidates: 0, expired: 0, failed: 0 });
    expect(result.skipped[reason]).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("keeps the backup when the session's control-plane state is too large to read", async () => {
    const session = await seedSession();
    const statePath = path.join(session.root, "control-plane", "control-plane-state.json");
    await fs.writeFile(statePath, `${await fs.readFile(statePath, "utf8")}${" ".repeat(5 * 1024 * 1024)}`);

    const result = await service().tick();

    expect(result.skipped.identity_unknown).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("keeps the backup of a session that is executing in this process", async () => {
    const session = await seedSession();
    const result = await nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      isSessionBusy: (scope) => scope === session.scope,
    }).tick();

    expect(result.skipped.session_active).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("settled finalizations and expired leases do not block retention, which keeps the backup", async () => {
    const session = await seedSession({ finalization: { phase: "committed" }, leaseStatus: "expired" });
    expect(await service().tick()).toMatchObject({ expired: 0, skipped: { native_backup_local_copy_kept: 1 } });
    await expectKept(session);
  });

  it("retains incomplete native snapshot publications even after the issue closes", async () => {
    const session = await seedSession({ finalization: { phase: "committed" } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeControllerRecovery: {
      schema: "paperclip.native-controller-recovery.v1", checkpoint: null,
    } } }).where(eq(heartbeatRuns.id, session.runId));
    expect(await service().tick()).toMatchObject({ expired: 0, skipped: { native_recovery_incomplete: 1 } });
    expect(await exists(session.current)).toBe(true);
  });

  it.each([
    ["committed", "resuming_session"],
    ["terminal_failure", "blocked"],
  ] as const)("stale %s recovery state %s does not block retention once the issue is closed, which keeps the backup", async (phase, recoveryState) => {
    const session = await seedSession({ finalization: { phase, recoveryState } });
    expect(await service().tick()).toMatchObject({ expired: 0, skipped: { native_backup_local_copy_kept: 1 } });
    await expectKept(session);
  });

  it("dry run reports no candidate for a kept backup and deletes nothing", async () => {
    const session = await seedSession();
    const result = await nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      dryRun: true,
      isSessionBusy: () => false,
    }).tick();

    expect(result).toMatchObject({ candidates: 0, expired: 0, clearedTaskSessions: 0 });
    expect(result.candidateBytes).toBe(0);
    expect(result.skipped.native_backup_local_copy_kept).toBe(1);
    await expectKept(session);
    expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("continues across ticks when a batch is bounded and keeps every backup", async () => {
    const sessions = [await seedSession(), await seedSession(), await seedSession()];
    const expiration = nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      maxEntries: 2,
      isSessionBusy: () => false,
    });

    expect(await expiration.tick()).toMatchObject({ checked: 2, expired: 0, truncated: true });
    expect(await expiration.tick()).toMatchObject({ checked: 1, expired: 0, truncated: false });
    for (const session of sessions) await expectKept(session);
  });

  it("uses the configured clock for the closed window", async () => {
    const session = await seedSession({ closedDaysAgo: 8, backupAgeDays: 20 });
    const early = nativeHarnessBackupExpirationService(db, {
      stateBase,
      now: new Date(now.getTime() - 2 * DAY_MS),
      isSessionBusy: () => false,
    });
    expect((await early.tick()).skipped.recently_closed).toBe(1);
    expect(await exists(session.current)).toBe(true);
    expect(await service().tick()).toMatchObject({ expired: 0, skipped: { native_backup_local_copy_kept: 1 } });
    await expectKept(session);
  });

  it("restores a backup whose expiry stopped before its final check", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const retiring = path.join(session.root, "failover-backups", `.retiring-${randomUUID()}`);
    await fs.rename(session.current, retiring);

    await service().tick();

    expect(await exists(retiring)).toBe(false);
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
  });

  it("keeps an unconfirmed retired backup beside a newer backup", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const retiring = path.join(session.root, "failover-backups", `.retiring-${randomUUID()}`);
    await fs.mkdir(path.join(retiring, "codex-home"), { recursive: true });

    await service().tick();

    expect(await exists(path.join(retiring, "codex-home"))).toBe(true);
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
  });

  it("keeps a backup left over from an interrupted expiry beside the current one", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const leftover = path.join(session.root, "failover-backups", `.expired-${randomUUID()}`);
    await fs.mkdir(path.join(leftover, "codex-home"), { recursive: true });

    await service().tick();

    expect(await exists(path.join(leftover, "codex-home"))).toBe(true);
    expect(await exists(session.current)).toBe(true);
  });
  async function seedArchive(root: string, input: { stampedDaysAgo?: number; mtimeDaysAgo?: number; name?: string } = {}) {
    const stampedAt = now.getTime() - (input.stampedDaysAgo ?? 10) * DAY_MS;
    const archive = path.join(root, "continuity-breaks", input.name ?? `${stampedAt}-${randomUUID()}`);
    await fs.mkdir(path.join(archive, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(archive, "codex-home", "history.jsonl"), "x".repeat(64 * 1024));
    const mtime = new Date(now.getTime() - (input.mtimeDaysAgo ?? input.stampedDaysAgo ?? 10) * DAY_MS);
    await fs.utimes(archive, mtime, mtime);
    return archive;
  }

  async function seedQuarantine(
    scope: string,
    input: { stampedDaysAgo?: number; name?: string } = {},
  ) {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-sessions-"));
    const stampedAt = now.getTime() - (input.stampedDaysAgo ?? 10) * DAY_MS;
    const entry = path.join(
      stateBase,
      "quarantine",
      input.name ?? `${scope}.identity_indeterminate.${stampedAt}.4242.${randomUUID()}`,
    );
    await fs.mkdir(path.join(entry, "control-plane"), { recursive: true });
    await fs.writeFile(path.join(entry, "history.jsonl"), "x".repeat(64 * 1024));
    return entry;
  }

  function evidenceService(overrides: Parameters<typeof nativeHarnessBackupExpirationService>[1] = {}) {
    return nativeHarnessBackupExpirationService(db, {
      stateBase,
      now,
      evidenceRetentionDays: 7,
      isSessionBusy: () => false,
      ...overrides,
    });
  }

  async function emptyStateBase() {
    if (!stateBase) stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-durable-sessions-"));
    return createHash("sha256").update(randomUUID()).digest("hex");
  }

  async function startEvidence(options: Parameters<typeof nativeHarnessBackupExpirationService>[1] = {}) {
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      vi.setSystemTime(now);
    }
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => true,
      onError: error => { throw error; } });
    worker = registerNativeRunnerEvidenceRetentionWork(coordinator, db, { stateBase, isSessionBusy: () => false, ...options }, () => admitted);
    await worker.ready;
  }
  async function settled(deadline: number | null = null) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBe(deadline);
    }, { timeout: 5000 });
  }
  async function quiet(ms = 3 * 60 * 60_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), directories = vi.spyOn(fs, "readdir");
    await vi.advanceTimersByTimeAsync(ms);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(directories).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); directories.mockRestore();
  }

  async function startBackups(options: Parameters<typeof nativeHarnessBackupExpirationService>[1] = {}) {
    if (!stateBase) await emptyStateBase();
    if (!vi.isFakeTimers()) {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      vi.setSystemTime(now);
    }
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => true,
      onError: error => backupErrors.push(error) });
    backupWorker = registerNativeHarnessBackupExpirationWork(coordinator, db,
      { stateBase, isSessionBusy: () => false, ...options }, () => admitted);
    await backupWorker.ready;
  }

  it.each([false, true])("backup deadline worker leaves empty and retained terminal history quiet (%s)", async history => {
    await emptyStateBase();
    if (history) {
      const session = await seedSession();
      await fs.rm(path.join(session.root, "failover-backups"), { recursive: true });
      await db.insert(heartbeatRuns).values(Array.from({ length: 500 }, () => ({
        companyId: session.companyId, agentId: session.agentId, status: "succeeded", issueId: session.issueId,
        nativeIssueId: session.issueId, nativeSessionId: randomUUID(), finishedAt: now,
      })));
      for (let index = 0; index < 250; index++) await fs.mkdir(path.join(stateBase,
        createHash("sha256").update(String(index)).digest("hex")));
    }
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await startBackups({ maxEntries: 20 }); await settled();
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); await quiet();
    expect(backupErrors).toEqual([]);
  });

  it("ordinary task close arms no backup deadline; the worker keeps the bytes and resume pointer past 7 days and stays quiet", async () => {
    const session = await seedSession({ issueStatus: "todo" });
    await startBackups(); await settled(); await quiet();
    await issueService(db).update(session.issueId, { status: "done", companyGuard: session.companyId });
    await settled(); await quiet(8 * DAY_MS);
    await expectKept(session);
    expect(await taskSessionCount(session.agentId)).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, session.runId))).toHaveLength(1);
    expect(backupErrors).toEqual([]); await quiet();
  });

  it("ordinary backup publication after quiet schedules no deadline and keeps the published backup", async () => {
    const session = await seedSession();
    const backupRoot = path.dirname(session.current);
    const pendingRoot = path.join(backupRoot, "pending-publication");
    await fs.rename(session.current, pendingRoot);
    await startBackups(); await settled(); await quiet();
    const publishedAt = Date.now();
    await fs.utimes(pendingRoot, new Date(publishedAt), new Date(publishedAt));
    await publishNativeHarnessBackup({ db, companyId: session.companyId, scopeDigest: session.scope, backupRoot, pendingRoot });
    await settled(); await quiet(8 * DAY_MS);
    await expectKept(session); expect(await taskSessionCount(session.agentId)).toBe(1);
    expect(await fs.readdir(backupRoot)).toEqual(["current"]); await quiet();
  });

  it("restart reconstructs no backup deadline, keeps the backup and does not change business timestamps", async () => {
    const session = await seedSession({ closedDaysAgo: 2 });
    const [before] = await db.select().from(issues).where(eq(issues.id, session.issueId));
    await startBackups(); await settled();
    await backupWorker!.stop(); await coordinator!.stop();
    await startBackups(); await settled();
    const [after] = await db.select().from(issues).where(eq(issues.id, session.issueId));
    expect(after!.updatedAt).toEqual(before!.updatedAt); expect(after!.completedAt).toEqual(before!.completedAt);
    await quiet(8 * DAY_MS); await expectKept(session);
  });

  it("dry run reports no kept backup and rechecks quietly after source invalidation", async () => {
    const session = await seedSession(); const report = vi.spyOn(logger, "info");
    await startBackups({ dryRun: true }); await settled();
    expect(report.mock.calls.filter(call => call[1] === "native harness backup expiration")).toHaveLength(0);
    expect(await taskSessionCount(session.agentId)).toBe(1); await expectKept(session);
    await quiet();
    noteNativeHarnessBackupChange(db, { companyId: session.companyId, scopeDigest: session.scope });
    await settled();
    expect(report.mock.calls.filter(call => call[1] === "native harness backup expiration")).toHaveLength(0);
    await quiet();
  });

  it("company-only notifications inspect only the indexed company's blocked backup sources", async () => {
    const own = await seedSession({ issueStatus: "todo" });
    const other = await seedSession({ issueStatus: "todo" });
    await startBackups({ maxEntries: 1 }); await settled(); await quiet();
    const sql: Array<{ query: string; parameters: unknown[] }> = [];
    const previous = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, parameters) => { sql.push({ query, parameters }); };
    const directories = vi.spyOn(fs, "readdir");
    try {
      const closed = await issueService(db).update(own.issueId, { status: "done" });
      expect(closed!.status).toBe("done"); await settled();
      const unrelated = [other.companyId, other.agentId, other.runId, other.sessionId, other.issueId];
      expect(sql.filter(query => query.parameters.some(parameter =>
        unrelated.some(id => String(parameter).includes(id))))).toEqual([]);
      expect(directories.mock.calls.some(call => call[0] === stateBase
        || String(call[0]).startsWith(other.root))).toBe(false);
      expect(await exists(other.current)).toBe(true);
      await expectKept(own);
    } finally { db.$client.options.debug = previous; directories.mockRestore(); }
    await quiet();
  });

  it("coalesces repeated task writes to one retained root in a large company with the same historical agent", async () => {
    const own = await seedSession({ issueStatus: "todo" });
    const unrelated: Awaited<ReturnType<typeof seedSession>>[] = [];
    for (let index = 0; index < 80; index++) unrelated.push(await seedSession({ companyId: own.companyId,
      agentId: own.agentId, issueStatus: index % 2 ? "todo" : "done", closedDaysAgo: 2,
      runStatus: index % 3 ? "succeeded" : "running" }));
    await startBackups({ isSessionBusy: digest => unrelated.some((entry, index) => index % 4 === 0 && entry.scope === digest) });
    await settled(); await quiet(60_000);
    const reads = vi.spyOn(fs, "readFile");
    const queries: Array<{ query: string; parameters: unknown[] }> = [];
    const previous = db.$client.options.debug;
    db.$client.options.debug = (_connection, query, parameters) => { queries.push({ query, parameters }); };
    try {
      await db.transaction(async tx => {
        await issueService(db).update(own.issueId, { status: "done" }, tx);
        for (let index = 0; index < 12; index++) await issueService(db).update(own.issueId,
          { completedAt: new Date(now.getTime() - DAY_MS) }, tx);
      });
      const writes = queries.length;
      await settled();
      expect(reads.mock.calls.map(call => String(call[0]))).toEqual([path.join(own.root, "control-plane", "control-plane-state.json")]);
      expect(queries.length - writes).toBeLessThanOrEqual(20);
      const otherIds = unrelated.flatMap(entry => [entry.issueId, entry.runId, entry.sessionId]);
      expect(queries.filter(query => query.parameters.some(parameter => otherIds.some(id => String(parameter).includes(id))))).toEqual([]);
    } finally { reads.mockRestore(); db.$client.options.debug = previous; }
    await issueService(db).update(own.issueId, { status: "todo" }); await settled();
    await quiet(); expect(await exists(own.current)).toBe(true);
  });

  it.each([false, true])("sandbox attachment reconciles only its retained root using durable run authority (explicit run: %s)", async explicitRun => {
    const own = await seedSession({ runStatus: "running" });
    const unrelated = [];
    for (let index = 0; index < 16; index++) unrelated.push(await seedSession({ companyId: own.companyId,
      agentId: own.agentId, issueStatus: "todo", runStatus: index % 2 ? "running" : "succeeded" }));
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "sandbox" }).returning();
    async function attach(runId: string) {
      const operationId = randomUUID();
      await db.insert(sandboxCreationOperations).values({ id: operationId, companyId: own.companyId,
        environmentId: environment!.id, originalEnvironmentId: environment!.id, runId,
        provider: "controlled", driverKey: "controlled", config: {}, metadata: {}, nextAttemptAt: new Date() });
      return environmentService(db).acquireLease({ creationOperationId: operationId, companyId: own.companyId,
        environmentId: environment!.id, ...(explicitRun ? { heartbeatRunId: runId } : {}) });
    }
    await startBackups(); await settled();
    const reads = vi.spyOn(fs, "readFile");
    try {
      const lease = await attach(own.runId); await settled();
      expect(reads.mock.calls.map(call => String(call[0])))
        .toEqual([path.join(own.root, "control-plane", "control-plane-state.json")]);
      expect((await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.leaseId, lease.id)))[0])
        .toMatchObject({ state: "attached", runId: own.runId });
      reads.mockClear();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: own.companyId, agentId: own.agentId, status: "running" }).returning();
      await attach(run!.id); await settled();
      expect(reads).not.toHaveBeenCalled();
      expect(await exists(own.current)).toBe(true);
      for (const other of unrelated) expect(await exists(other.current)).toBe(true);
      await quiet();
    } finally {
      reads.mockRestore();
      await db.delete(sandboxCreationOperations).where(eq(sandboxCreationOperations.companyId, own.companyId));
      await db.delete(environmentLeases).where(eq(environmentLeases.environmentId, environment!.id));
      await db.delete(environments).where(eq(environments.id, environment!.id));
    }
  });

  it("indexes protected session relations so a new run, historical task close and exact process release reactivate only its backup", async () => {
    const own = await seedSession({ closedDaysAgo: 2 });
    const other = await seedSession({ companyId: own.companyId, agentId: own.agentId, issueStatus: "todo" });
    const [linked] = await db.insert(issues).values({ companyId: own.companyId, title: "New linked task", status: "todo" }).returning();
    await startBackups(); await settled(); await quiet(60_000);
    const reads = vi.spyOn(fs, "readFile");
    const runId = randomUUID();
    try {
      await db.transaction(async tx => {
        await notifyNativeEnvironmentSettlement(tx, { companyId: own.companyId, runId, issueId: linked!.id });
        await tx.insert(heartbeatRuns).values({ id: runId, companyId: own.companyId, agentId: own.agentId,
          nativeSessionId: own.sessionId, nativeIssueId: linked!.id, issueId: other.issueId, status: "running" });
      });
      await settled();
      expect(reads.mock.calls.every(call => String(call[0]).startsWith(own.root))).toBe(true);
      expect(reads).toHaveBeenCalled(); reads.mockClear();
      await issueService(db).update(linked!.id, { status: "done" }); await settled();
      expect(reads.mock.calls.every(call => String(call[0]).startsWith(own.root))).toBe(true); reads.mockClear();
      await db.transaction(async tx => {
        await notifyRetainedNativeSessionCleanup(tx, { companyId: own.companyId, runId, agentId: own.agentId });
        await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      });
      await settled(); reads.mockClear();
      const cleanupScope = { companyId: own.companyId, agentId: own.agentId };
      const observed = vi.fn(); const stop = onRetainedNativeSessionCleanupRelease(db, observed);
      releaseRetainedNativeSessionCleanup(db, cleanupScope, { companyId: own.companyId, runId });
      expect(observed).toHaveBeenCalledWith(cleanupScope, { companyId: own.companyId, runId }); stop();
      await settled();
      expect(reads.mock.calls.every(call => String(call[0]).startsWith(own.root))).toBe(true);
      expect(reads).toHaveBeenCalled();
      await issueService(db).update(linked!.id, { status: "todo" }); await settled();
    } finally { reads.mockRestore(); }
    expect(await exists(other.current)).toBe(true); await expectKept(own); await quiet();
  });

  it("ordinary lease release without a run uses its source identity instead of other retained roots", async () => {
    const own = await seedSession({ leaseStatus: "retained" });
    const other = await seedSession({ companyId: own.companyId, agentId: own.agentId, issueStatus: "todo" });
    await startBackups(); await settled(); await quiet(60_000);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, own.companyId));
    const reads = vi.spyOn(fs, "readFile");
    try {
      await environmentService(db).releaseLease(lease!.id, "expired"); await settled();
      expect(reads).toHaveBeenCalled();
      expect(reads.mock.calls.every(call => String(call[0]).startsWith(own.root))).toBe(true);
    } finally { reads.mockRestore(); }
    await expectKept(own); expect(await exists(other.current)).toBe(true); await quiet();
  });

  it("a lease metadata edit that removes its last backup reference schedules no deadline and keeps the backup", async () => {
    const own = await seedSession({ leaseStatus: "retained", closedDaysAgo: 2 });
    const other = await seedSession({ companyId: own.companyId, agentId: own.agentId, issueStatus: "todo" });
    await startBackups(); await settled();
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, own.companyId));
    const reads = vi.spyOn(fs, "readFile");
    try {
      await environmentService(db).updateLeaseMetadata(lease!.id, {}); await settled();
      expect(reads).toHaveBeenCalled(); expect(reads.mock.calls.every(call => String(call[0]).startsWith(own.root))).toBe(true);
    } finally { reads.mockRestore(); }
    await quiet(8 * DAY_MS);
    await expectKept(own); expect(await exists(other.current)).toBe(true); await quiet();
  });

  it.each(["EIO", "EACCES"])("retains a failed identity read as real retry debt (%s)", async code => {
    const own = await seedSession(); const read = fs.readFile;
    const fault = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(own.root, "control-plane", "control-plane-state.json")) {
        throw Object.assign(new Error("controlled identity I/O failure"), { code });
      }
      return read(...args);
    });
    await startBackups(); expect(backupErrors).toHaveLength(1);
    const retry = coordinator!.nextWakeAt()!; expect(retry - Date.now()).toBeGreaterThanOrEqual(29_000);
    expect(await exists(own.current)).toBe(true); fault.mockRestore(); await quiet(5000);
    await vi.advanceTimersByTimeAsync(retry - Date.now()); await settled();
    await expectKept(own); expect(await taskSessionCount(own.agentId)).toBe(1); await quiet();
  });

  it.each(["EIO", "EACCES"])("retains expired-only leftover after a directory read failure and restores it as current (%s)", async code => {
    const session = await seedSession();
    const backupRoot = path.dirname(session.current);
    const expired = path.join(backupRoot, `.expired-${randomUUID()}`);
    await fs.rename(session.current, expired);
    const read = fs.readdir;
    const fault = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (String(args[0]) === backupRoot) throw Object.assign(new Error("controlled cleanup listing failure"), { code });
      return read(...args);
    });
    await startBackups();
    expect(backupErrors).toHaveLength(1);
    const retry = coordinator!.nextWakeAt();
    expect(retry).not.toBeNull();
    expect(retry! - Date.now()).toBeGreaterThanOrEqual(29_000);
    expect(await exists(session.current)).toBe(false);
    expect(await exists(expired)).toBe(true);
    fault.mockRestore();
    await quiet(5000);
    await vi.advanceTimersByTimeAsync(retry! - Date.now()); await settled();
    expect(await fs.readdir(backupRoot)).toEqual(["current"]);
    await expectKept(session);
    await quiet();
  });

  it("reconciles retention without issue row locks", async () => {
    await seedSession({ closedDaysAgo: 2 }); const queries: string[] = [];
    const previous = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { queries.push(query); };
    try {
      await startBackups(); await settled();
      expect(queries.some(query => /for\s+share/i.test(query))).toBe(false);
    } finally { db.$client.options.debug = previous; }
    await quiet();
  });

  it("finds a backup root's leases by run, backup stamp and identity through indexes, within one company", async () => {
    const session = await seedSession({ leaseStatus: "retained" });
    const [stamped] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(eq(environmentLeases.companyId, session.companyId));
    const [runLease] = await db.insert(environmentLeases).values({ companyId: session.companyId,
      heartbeatRunId: session.runId, status: "released", metadata: {} }).returning();
    const [own] = await db.insert(environmentLeases).values({ companyId: session.companyId, status: "active",
      metadata: { nativeHarnessBackup: { sessionScopeSha256: "0".repeat(64) } } }).returning();
    // Not references: another digest, a stamp that is not a string match, and
    // the same digest in another company.
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 6)}` });
    await db.insert(environmentLeases).values([
      { companyId: session.companyId, status: "retained", metadata: { nativeHarnessBackup: { sessionScopeSha256: "f".repeat(64) } } },
      { companyId: session.companyId, status: "retained", metadata: { nativeHarnessBackup: { sessionScopeSha256: [session.scope] } } },
      { companyId: session.companyId, status: "retained", metadata: { sessionScopeSha256: session.scope } },
      { companyId: otherCompanyId, status: "retained", metadata: { nativeHarnessBackup: { sessionScopeSha256: session.scope } } },
    ]);
    // Unrelated lease history, so the planner prefers indexes to a company scan.
    await db.$client.unsafe(`insert into environment_leases (company_id, status, metadata)
      select $1::uuid, 'released', jsonb_build_object('sandbox', repeat('x', 512)) from generate_series(1, 2000)`, [session.companyId]);
    await db.$client.unsafe("analyze environment_leases");
    const statePath = path.join(session.root, "control-plane", "control-plane-state.json");
    await fs.writeFile(statePath, JSON.stringify({ identity: {
      runId: session.runId, normalizedSessionId: session.sessionId, environmentLeaseId: own!.id } }));

    const queries: Array<{ text: string; params: unknown[] }> = [];
    const previous = db.$client.options.debug;
    db.$client.options.debug = (_connection, text, params) => { queries.push({ text, params: params as unknown[] }); };
    let reconciled: Awaited<ReturnType<ReturnType<typeof service>["reconcileBackup"]>>;
    try { reconciled = await service().reconcileBackup(session.scope); } finally { db.$client.options.debug = previous; }
    expect([...reconciled!.dependencies.leaseIds].sort()).toEqual([stamped!.id, runLease!.id, own!.id].sort());

    // Every arm of the company's lease lookup must be index-backed, or the
    // planner reads each lease's metadata (environment_leases_native_backup_scope_idx).
    const lookup = queries.find(query => query.text.startsWith('select "id" from "environment_leases"')
      && query.text.includes("sessionScopeSha256"));
    expect(lookup).toBeDefined();
    const custom = JSON.stringify(await db.$client.unsafe(`explain (format json) ${lookup!.text}`, lookup!.params as never[]));
    // A reused prepared statement gets a generic plan; the bound digest must
    // still prove the partial index predicate.
    const generic = JSON.stringify(await db.$client.begin(async tx => {
      await tx.unsafe("set local plan_cache_mode = force_generic_plan");
      await tx.unsafe(`prepare backup_lease_lookup as ${lookup!.text}`);
      const values = lookup!.params.map(value => `'${String(value).replaceAll("'", "''")}'`).join(", ");
      return tx.unsafe(`explain (format json) execute backup_lease_lookup(${values})`);
    }));
    for (const text of [custom, generic]) {
      expect(text).toContain("environment_leases_native_backup_scope_idx");
      expect(text).toContain("BitmapOr");
      expect(text).not.toContain("Seq Scan");
    }
  });

  it("rejects destructive backup scopes outside the controller digest namespace", async () => {
    await emptyStateBase(); const remove = vi.spyOn(fs, "rm");
    await expect(service().expireBackup("../outside")).rejects.toThrow("Invalid native harness backup scope");
    expect(remove).not.toHaveBeenCalled(); remove.mockRestore();
  });

  it.each([false, true])("keeps the backup after ordinary agent deletion (restart %s)", async restart => {
    const session = await seedSession();
    await startBackups(); await settled();
    const backupRoot = path.dirname(session.current);
    if (restart) { await backupWorker!.stop(); await coordinator!.stop(); }
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, session.agentId));
    await agentService(db).remove(session.agentId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, session.runId))).toEqual([]);
    if (restart) await startBackups();
    await settled();
    expect(await fs.readdir(backupRoot)).toEqual(["current"]); await expectKept(session);
    expect(backupErrors).toEqual([]);
    await quiet();
  });

  it("restores an orphan retiring journal without expiring the recovered backup or unrelated names", async () => {
    const session = await seedSession(); const backupRoot = path.dirname(session.current);
    const retiring = path.join(backupRoot, `.retiring-${randomUUID()}`);
    await fs.rename(session.current, retiring);
    await fs.mkdir(path.join(backupRoot, ".expired-unrecognized"));
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, session.agentId));
    await agentService(db).remove(session.agentId);
    await fs.rm(path.join(session.root, "control-plane"), { recursive: true });
    await startBackups(); await settled();
    expect(await exists(session.current)).toBe(true); expect(await exists(retiring)).toBe(false);
    expect(await exists(path.join(session.current, "manifest.json"))).toBe(true);
    expect(await exists(path.join(backupRoot, ".expired-unrecognized"))).toBe(true);
    await quiet();
  });

  it("retains live lease references and keeps the owning company's backup after lease release", async () => {
    const first = await seedSession({ leaseStatus: "retained" });
    const other = await seedSession({ leaseStatus: "retained" });
    await startBackups(); await settled(); await quiet();
    await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({ status: "expired" })
      .where(eq(environmentLeases.companyId, first.companyId)), { companyId: first.companyId });
    await settled(); await expectKept(first); expect(await exists(other.current)).toBe(true);
    expect(await taskSessionCount(other.agentId)).toBe(1); expect(await taskSessionCount(first.agentId)).toBe(1); await quiet();
  });

  it("retains a first ordinary close during drain, dispatches it after resume and keeps the backup", async () => {
    const session = await seedSession({ issueStatus: "todo" });
    await startBackups(); await settled(); admitted = false;
    await issueService(db).update(session.issueId, { status: "done" });
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    await quiet(60_000); admitted = true;
    await settled(); await quiet(8 * DAY_MS);
    await expectKept(session); expect(await taskSessionCount(session.agentId)).toBe(1);
  });

  it("honors outer rollback for nested ordinary close and activates only on committed work", async () => {
    const session = await seedSession({ issueStatus: "todo" });
    await startBackups(); await settled();
    await expect(db.transaction(async outer => {
      await outer.transaction(async nested => {
        await issueService(db).update(session.issueId, { status: "done" }, nested);
      });
      expect(await exists(session.current)).toBe(true);
      throw new Error("rollback outer close");
    })).rejects.toThrow("rollback outer close");
    await settled(); await quiet(8 * DAY_MS);
    expect(await exists(session.current)).toBe(true);
    const [saved] = await db.select().from(issues).where(eq(issues.id, session.issueId));
    expect(saved!.status).toBe("todo");
  });

  it("leaves empty evidence and retained backups quiet without invoking backup SQL", async () => {
    const session = await seedSession();
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await startEvidence(); await settled(); expect(await exists(session.current)).toBe(true);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); await quiet();
  });

  it("reconstructs and replaces the saved evidence pass after a publication signal; every archive is kept", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const first = await seedArchive(session.root, { stampedDaysAgo: 2 });
    const firstDeadline = now.getTime() + 5 * DAY_MS + 1;
    await startEvidence(); await settled(firstDeadline); await quiet();
    const writtenAt = Date.now();
    const next = await seedArchive(session.root, { name: `${writtenAt}-${randomUUID()}` });
    noteNativeRunnerEvidence(writtenAt);
    await settled(firstDeadline);
    await vi.advanceTimersByTimeAsync(firstDeadline - Date.now());
    await settled(writtenAt + 7 * DAY_MS + 1); expect(await exists(first)).toBe(true);
    await vi.advanceTimersByTimeAsync(writtenAt + 7 * DAY_MS + 1 - Date.now()); await settled();
    expect(await exists(next)).toBe(true); expect(await exists(session.current)).toBe(true); await quiet();
  });

  it.each(["session root", "archive directory"])("preserves an evidence inspection failure at %s until its concrete retry succeeds; the archive is kept", async location => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root);
    const original = fs.lstat;
    const denied = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === (location === "session root" ? session.root : path.join(session.root, "continuity-breaks"))) throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      return original(...args);
    });
    await startEvidence(); expect(coordinator!.nextWakeAt()).not.toBeNull();
    const retryAt = coordinator!.nextWakeAt()!; expect(await exists(archive)).toBe(true);
    denied.mockRestore(); await quiet(5000);
    await vi.advanceTimersByTimeAsync(retryAt - Date.now()); await settled();
    expect(await exists(archive)).toBe(true); await quiet();
  });

  it("retries a busy evidence obligation and disarms after the session releases it; the archive is kept", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root); let busy = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(now);
    let inspectedAt: number | undefined;
    await startEvidence({ isSessionBusy: () => { inspectedAt = Date.now(); return busy; } });
    await vi.advanceTimersByTimeAsync(50);
    const retryAt = coordinator!.nextWakeAt()!; expect(inspectedAt).toBeDefined();
    expect(retryAt - inspectedAt!).toBeGreaterThanOrEqual(60 * 60_000);
    await quiet(5000); busy = false;
    await vi.advanceTimersByTimeAsync(retryAt - Date.now()); await settled();
    expect(await exists(archive)).toBe(true); await quiet();
  });

  it("retains the first publication during drain and keeps the archive on resume", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    await startEvidence(); await settled(); admitted = false;
    const archive = await seedArchive(session.root);
    noteNativeRunnerEvidence(now.getTime() - 10 * DAY_MS);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    await quiet(60_000); expect(await exists(archive)).toBe(true);
    admitted = true; await settled(); expect(await exists(archive)).toBe(true); await quiet();
  });

  it("reconstructs the same retained deadline after restart", async () => {
    const scope = await emptyStateBase(); await seedQuarantine(scope, { stampedDaysAgo: 6 });
    const deadline = now.getTime() + DAY_MS + 1;
    await startEvidence(); await settled(deadline);
    worker!.unsubscribe(); await coordinator!.stop();
    await startEvidence(); await settled(deadline); await quiet(60_000);
    expect(coordinator!.nextWakeAt()).toBe(deadline);
  });

  it("backs off a failed state-base inspection and lets publication reactivate it; the archive is kept", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root), read = fs.readdir;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(now);
    let inspectedAt: number | undefined;
    const denied = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === stateBase) {
        inspectedAt = Date.now();
        throw Object.assign(new Error("state base unavailable"), { code: "EACCES" });
      }
      return read(...args);
    });
    await startEvidence(); await vi.advanceTimersByTimeAsync(50);
    expect(inspectedAt).toBeDefined();
    expect(coordinator!.nextWakeAt()! - inspectedAt!).toBeGreaterThanOrEqual(60 * 60_000);
    denied.mockRestore(); await quiet(5 * 60_000); expect(await exists(archive)).toBe(true);
    noteNativeRunnerEvidence(now.getTime() - 10 * DAY_MS);
    await settled(); expect(await exists(archive)).toBe(true); await quiet();
  });

  it("lets a healthy saved evidence pass preempt a long-busy evidence retry; both archives are kept", async () => {
    const busy = await seedSession({ issueStatus: "in_progress" }), healthy = await seedSession({ issueStatus: "in_progress" });
    const held = await seedArchive(busy.root);
    const dueAt = now.getTime() + 10_001;
    const available = await seedArchive(healthy.root, { name: `${dueAt - 7 * DAY_MS - 1}-${randomUUID()}` });
    await startEvidence({ isSessionBusy: scope => scope === busy.scope }); await settled(dueAt);
    await vi.advanceTimersByTimeAsync(dueAt - Date.now());
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(100);
      expect(await exists(available)).toBe(true);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()! - Date.now()).toBeGreaterThan(59 * 60_000);
    });
    expect(await exists(held)).toBe(true);
    await quiet(60_000);
  });

  it("reports no reclaimed evidence bytes and keeps the archive", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root); const reported = vi.spyOn(logger, "info");
    await startEvidence(); await settled();
    expect(reported.mock.calls.some(call => call[1] === "native runner evidence retention"
      && Number((call[0] as { evidenceRemoved?: number }).evidenceRemoved ?? 0) > 0)).toBe(false);
    expect(await exists(archive)).toBe(true); await quiet();
  });

  it("schedules publication at the first removable instant after its retention boundary", async () => {
    const scope = await emptyStateBase(); await startEvidence(); await settled(); await quiet();
    const writtenAt = Date.now();
    await seedQuarantine(scope, { name: `${scope}.identity_indeterminate.${writtenAt}.4242.${randomUUID()}` });
    noteNativeRunnerEvidence(writtenAt); await settled(writtenAt + 7 * DAY_MS + 1);
  });

  it("uses bounded continuations without recounting an evidence session forever; every entry is kept", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archives = [await seedArchive(session.root), await seedArchive(session.root)];
    const quarantine = await seedQuarantine(session.scope);
    await startEvidence({ maxEntries: 1 }); await settled();
    for (const archive of [...archives, quarantine]) expect(await exists(archive)).toBe(true);
    await quiet();
  });

  it.each(["continuity", "quarantine"])("RK3 (never-OK): a %s archive holding raw trace bytes is kept in place past 7 days and its bytes are unchanged", async kind => {
    const session = await seedSession({ issueStatus: "done", closedDaysAgo: 0, backupAgeDays: 0 });
    const archive = kind === "continuity"
      ? await seedArchive(session.root, { stampedDaysAgo: 0 })
      : await seedQuarantine(session.scope, { stampedDaysAgo: 0 });
    // Raw trace, as the executor moves it there (NATIVE_CONTINUITY_STATE_ENTRIES /
    // quarantineRunnerdStateRoot): the Codex rollout and the runner's frame journal.
    const trace = new Map([
      ["codex-home/sessions/rollout.jsonl", Buffer.from('{"type":"response_item","payload":{"role":"assistant","text":"only copy"}}\n')],
      ["control-plane/control-plane-state.json", Buffer.from(JSON.stringify({ committedEvents: [{ seq: 1, frame: "agent output" }] }))],
    ]);
    for (const [relative, bytes] of trace) {
      await fs.mkdir(path.dirname(path.join(archive, relative)), { recursive: true });
      await fs.writeFile(path.join(archive, relative), bytes);
    }
    const later = new Date(now.getTime() + 8 * DAY_MS);
    const retention = evidenceService({ now: later });
    const pass = await retention.tick();
    expect(pass).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0, failed: 0 });
    // A second pass much later still keeps it.
    await evidenceService({ now: new Date(now.getTime() + 3650 * DAY_MS) }).tick();
    expect(await exists(archive)).toBe(true);
    for (const [relative, bytes] of trace) expect(await fs.readFile(path.join(archive, relative))).toEqual(bytes);
    expect(await exists(path.join(stateBase, "conversation-evidence"))).toBe(false);
  });

  it("keeps continuity archives older than the retention window as well as recent ones", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const old = await seedArchive(session.root, { stampedDaysAgo: 9 });
    const recent = await seedArchive(session.root, { stampedDaysAgo: 2 });

    const result = await evidenceService().tick();

    expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0, failed: 0 });
    expect(result.evidenceReclaimedBytes).toBe(0);
    expect(result.skipped.native_runner_evidence_kept).toBe(1);
    expect(result.skipped.recent_evidence).toBe(1);
    expect(await exists(old)).toBe(true);
    expect(await exists(recent)).toBe(true);
    expect(await exists(session.current)).toBe(true);
  });

  it("keeps the continuity-breaks folder because its archives are kept", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    await seedArchive(session.root);

    expect(await evidenceService().tick()).toMatchObject({ evidenceRemoved: 0, skipped: { native_runner_evidence_kept: 1 } });
    expect(await exists(path.join(session.root, "continuity-breaks"))).toBe(true);
  });

  it("ages a continuity archive by its name and falls back to mtime for a future stamp; the aged one is kept", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const stampedRecently = await seedArchive(session.root, { stampedDaysAgo: 1, mtimeDaysAgo: 30 });
    const futureStamp = await seedArchive(session.root, {
      name: `${now.getTime() + DAY_MS}-${randomUUID()}`,
      mtimeDaysAgo: 30,
    });
    const futureRecent = await seedArchive(session.root, {
      name: `${now.getTime() + 2 * DAY_MS}-${randomUUID()}`,
      mtimeDaysAgo: 1,
    });

    expect(await evidenceService().tick()).toMatchObject({ evidenceRemoved: 0, skipped: { recent_evidence: 2, native_runner_evidence_kept: 1 } });
    expect(await exists(stampedRecently)).toBe(true);
    expect(await exists(futureStamp)).toBe(true);
    expect(await exists(futureRecent)).toBe(true);
  });

  it("ignores folders that are not continuity archives", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const other = await seedArchive(session.root, { name: "notes", stampedDaysAgo: 30 });

    expect(await evidenceService().tick()).toMatchObject({ evidenceCandidates: 0 });
    expect(await exists(other)).toBe(true);
  });

  it("keeps the evidence of a session that is executing in this process", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root);
    const quarantine = await seedQuarantine(session.scope);

    const result = await evidenceService({ isSessionBusy: (scope) => scope === session.scope }).tick();

    expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0 });
    expect(result.skipped.session_active).toBe(3);
    expect(await exists(archive)).toBe(true);
    expect(await exists(quarantine)).toBe(true);
  });

  it("keeps evidence reached before its session starts, before any removal is prepared", async () => {
    const scope = await emptyStateBase();
    const root = path.join(stateBase, scope);
    const archive = await seedArchive(root);
    let checks = 0;

    const result = await evidenceService({ isSessionBusy: () => ++checks > 1 }).tick();

    expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0 });
    expect(result.skipped.native_runner_evidence_kept).toBe(1);
    expect(await exists(archive)).toBe(true);
  });

  it("dry run reports no evidence candidate and deletes nothing", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root);
    const quarantine = await seedQuarantine(session.scope);
    const leftover = path.join(session.root, "continuity-breaks", `.expired-${randomUUID()}`);
    await fs.mkdir(leftover);

    const result = await evidenceService({ dryRun: true }).tick();

    expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0, evidenceReclaimedBytes: 0 });
    expect(result.evidenceCandidateBytes).toBe(0);
    expect(result.skipped.native_runner_evidence_kept).toBe(2);
    expect(await exists(archive)).toBe(true);
    expect(await exists(quarantine)).toBe(true);
    expect(await exists(leftover)).toBe(true);
  });

  it("skips symlinked evidence without following it", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-evidence-outside-"));
    try {
      await fs.writeFile(path.join(outside, "keep.txt"), "keep");
      const stampedAt = now.getTime() - 10 * DAY_MS;
      await fs.mkdir(path.join(session.root, "continuity-breaks"), { recursive: true });
      const archiveLink = path.join(session.root, "continuity-breaks", `${stampedAt}-${randomUUID()}`);
      await fs.symlink(outside, archiveLink);
      await fs.mkdir(path.join(stateBase, "quarantine"), { recursive: true });
      const quarantineLink = path.join(
        stateBase,
        "quarantine",
        `${session.scope}.identity_indeterminate.${stampedAt}.4242.${randomUUID()}`,
      );
      await fs.symlink(outside, quarantineLink);

      const result = await evidenceService().tick();

      expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0 });
      expect(result.skipped.unsafe_path).toBe(2);
      expect(await exists(archiveLink)).toBe(true);
      expect(await exists(quarantineLink)).toBe(true);
      expect(await exists(path.join(outside, "keep.txt"))).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("skips symlinked evidence folders without following them", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-evidence-outside-"));
    try {
      const stampedAt = now.getTime() - 10 * DAY_MS;
      const inside = path.join(outside, `${stampedAt}-${randomUUID()}`);
      await fs.mkdir(inside);
      await fs.utimes(inside, new Date(stampedAt), new Date(stampedAt));
      await fs.symlink(outside, path.join(session.root, "continuity-breaks"));
      await fs.symlink(outside, path.join(stateBase, "quarantine"));

      const result = await evidenceService().tick();

      expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0 });
      expect(result.skipped.unsafe_path).toBe(2);
      expect(await exists(inside)).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps quarantine entries older than the retention window as well as recent ones", async () => {
    const scope = await emptyStateBase();
    const old = await seedQuarantine(scope, { stampedDaysAgo: 9 });
    const recent = await seedQuarantine(scope, { stampedDaysAgo: 2 });

    const result = await evidenceService().tick();

    expect(result).toMatchObject({ evidenceCandidates: 0, evidenceRemoved: 0, failed: 0 });
    expect(result.skipped.native_runner_evidence_kept).toBe(1);
    expect(result.skipped.recent_evidence).toBe(1);
    expect(await exists(old)).toBe(true);
    expect(await exists(recent)).toBe(true);
    expect(await fs.readdir(path.join(stateBase, "quarantine"))).toEqual([path.basename(old), path.basename(recent)].sort());
  });

  it("keeps cleanup source archives in quarantine", async () => {
    const scope = await emptyStateBase();
    const entry = await seedQuarantine(scope, { name: `${scope}.identity_indeterminate.cleanup.${randomUUID()}` });
    const old = new Date(now.getTime() - 30 * DAY_MS);
    await fs.utimes(entry, old, old);

    const result = await evidenceService().tick();

    expect(result.evidenceCandidates).toBe(0);
    expect(result.skipped.cleanup_archive).toBe(1);
    expect(await exists(entry)).toBe(true);
  });

  it("keeps evidence left over from an interrupted removal", async () => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archive = await seedArchive(session.root, { stampedDaysAgo: 1 });
    const leftover = path.join(session.root, "continuity-breaks", `.expired-${randomUUID()}`);
    await fs.mkdir(path.join(leftover, "codex-home"), { recursive: true });
    const quarantineLeftover = path.join(stateBase, "quarantine", `.expired-${randomUUID()}`);
    await fs.mkdir(quarantineLeftover, { recursive: true });

    await evidenceService().tick();

    expect(await exists(path.join(leftover, "codex-home"))).toBe(true);
    expect(await exists(quarantineLeftover)).toBe(true);
    expect(await exists(archive)).toBe(true);
  });

  it.each([false, true])("pages evidence across ticks and keeps every entry (dry run %s)", async (dryRun) => {
    const session = await seedSession({ issueStatus: "in_progress" });
    const archives = [await seedArchive(session.root), await seedArchive(session.root), await seedArchive(session.root)];
    const quarantine = await seedQuarantine(session.scope);
    const retention = evidenceService({ dryRun, maxRemovals: 2 });

    const results = [];
    for (let i = 0; i < 4; i++) {
      const result = await retention.tick();
      results.push(result);
      if (!result.truncated) break;
    }

    expect(results.map((result) => result.evidenceCandidates)).toEqual([0]);
    expect(results.map((result) => result.truncated)).toEqual([false]);
    expect(results[0]!.skipped.native_runner_evidence_kept).toBe(4);
    for (const archive of archives) expect(await exists(archive)).toBe(true);
    expect(await exists(quarantine)).toBe(true);
  });

  it("does not count a kept session backup or its kept archives on either tick", async () => {
    const session = await seedSession();
    await seedArchive(session.root);
    await seedArchive(session.root);
    const retention = evidenceService({ dryRun: true, maxRemovals: 2 });

    const first = await retention.tick();
    const second = await retention.tick();

    expect(first).toMatchObject({ candidates: 0, evidenceCandidates: 0, truncated: false });
    expect(first.skipped).toMatchObject({ native_backup_local_copy_kept: 1, native_runner_evidence_kept: 2 });
    expect(second).toMatchObject({ candidates: 0, evidenceCandidates: 0, truncated: false });
    await expectKept(session);
  });
  it("keeps old quarantine entries whether or not their session's issue is still open", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const entry = await seedQuarantine(session.scope);
    await fs.cp(path.join(session.root, "control-plane"), path.join(entry, "control-plane"), { recursive: true });

    expect(await evidenceService().tick()).toMatchObject({ evidenceRemoved: 0, skipped: { native_runner_evidence_kept: 1 } });
    expect(await exists(entry)).toBe(true);
  });

  it("stays quiet until retained evidence is due, wakes when new evidence is written, and keeps both", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const recent = await seedArchive(session.root, { stampedDaysAgo: 2 });
    const retention = evidenceService();
    const at = (days: number) => ({ now: new Date(now.getTime() + days * DAY_MS) });

    expect((await retention.tick()).skipped.recent_evidence).toBe(1);
    expect((await retention.tick(at(4))).skipped.recent_evidence).toBeUndefined();
    expect(await retention.tick(at(6))).toMatchObject({ evidenceRemoved: 0, skipped: { native_runner_evidence_kept: 1 } });
    expect(await exists(recent)).toBe(true);

    const written = await seedArchive(session.root, { stampedDaysAgo: 0 });
    expect(await retention.tick(at(8))).toMatchObject({ evidenceCandidates: 0 });
    retention.noteEvidence(now.getTime());
    expect(await retention.tick(at(8))).toMatchObject({ evidenceRemoved: 0 });
    expect(await exists(written)).toBe(true);
  });

  it("retries evidence of a busy session on the next tick and keeps it", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archive = await seedArchive(session.root);
    let busy = true;
    const retention = evidenceService({ isSessionBusy: () => busy });

    expect(await retention.tick()).toMatchObject({ evidenceRemoved: 0 });
    busy = false;
    expect(await retention.tick()).toMatchObject({ evidenceRemoved: 0, skipped: { native_runner_evidence_kept: 1 } });
    expect(await exists(archive)).toBe(true);
  });

  it("dry run reports no evidence candidate, before or after new evidence is written", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    await seedArchive(session.root);
    const retention = evidenceService({ dryRun: true });

    expect(await retention.tick()).toMatchObject({ evidenceCandidates: 0 });
    expect(await retention.tick()).toMatchObject({ evidenceCandidates: 0 });
    retention.noteEvidence(now.getTime());
    expect(await retention.tick({ now: new Date(now.getTime() + 7 * DAY_MS) })).toMatchObject({ evidenceCandidates: 0 });
  });

  it("counts inspected archives against the entry limit and keeps leftovers", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archives = [
      await seedArchive(session.root, { stampedDaysAgo: 1 }),
      await seedArchive(session.root, { stampedDaysAgo: 2 }),
      await seedArchive(session.root, { stampedDaysAgo: 3 }),
    ];
    const leftovers = [randomUUID(), randomUUID()].map((id) => path.join(session.root, "continuity-breaks", `.expired-${id}`));
    for (const leftover of leftovers) await fs.mkdir(leftover);
    const retention = evidenceService({ maxEntries: 2 });

    const first = await retention.tick();
    expect(first).toMatchObject({ checked: 2, truncated: true });
    expect(first.skipped.recent_evidence).toBe(1);
    expect((await fs.readdir(path.join(session.root, "continuity-breaks"))).filter((name) => name.startsWith(".expired-"))).toHaveLength(2);

    const results = [first];
    for (let i = 0; i < 6 && results.at(-1)!.truncated; i++) results.push(await retention.tick());
    expect(results.at(-1)!.truncated).toBe(false);
    expect(results.every((result) => result.checked <= 2)).toBe(true);
    expect(results.every((result) => (result.skipped.recent_evidence ?? 0) <= 2)).toBe(true);
    expect(results.reduce((sum, result) => sum + (result.skipped.recent_evidence ?? 0), 0)).toBe(3);
    for (const leftover of leftovers) expect(await exists(leftover)).toBe(true);
    for (const archive of archives) expect(await exists(archive)).toBe(true);
  });

  it("keeps leftovers whether or not the sweep must stop", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    await fs.mkdir(path.join(session.root, "continuity-breaks"));
    const leftover = path.join(session.root, "continuity-breaks", `.expired-${randomUUID()}`);
    await fs.mkdir(leftover);
    let calls = 0;

    const retention = evidenceService({ shouldContinue: () => ++calls !== 2 });

    await retention.tick();
    expect(await exists(leftover)).toBe(true);
    await retention.tick();
    expect(await exists(leftover)).toBe(true);
  });

  it("keeps a due evidence pass pending when drain stops it before any session", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archive = await seedArchive(session.root);
    let draining = true;
    const retention = evidenceService({ shouldContinue: () => !draining });

    expect(await retention.tick()).toMatchObject({ checked: 0, truncated: true });
    draining = false;
    expect(await retention.tick()).toMatchObject({ evidenceRemoved: 0, skipped: { native_runner_evidence_kept: 1 } });
    expect(await exists(archive)).toBe(true);
  });

  it("finishes one-entry batches without recounting a resumed session and keeps every entry", async () => {
    const session = await seedSession({ issueStatus: "in_progress", backupAgeDays: 1 });
    const archives = [await seedArchive(session.root), await seedArchive(session.root)];
    const quarantine = await seedQuarantine(session.scope);
    const retention = evidenceService({ maxEntries: 1 });

    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(await retention.tick());
      if (!results.at(-1)!.truncated) break;
    }

    expect(results.at(-1)!.truncated).toBe(false);
    for (const archive of archives) expect(await exists(archive)).toBe(true);
    expect(await exists(quarantine)).toBe(true);
  });
});
