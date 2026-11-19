import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentTaskSessions, agents, authUsers, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns,
  issueComments, issues, nativeHarnessBackups, nativeRunFinalizations, plugins } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, PrpEvent } from "@paperclipai/paperclip-runner";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { NativePredecessorRetirementUnprovenError } from "../services/native-runtime/predecessor-retirement.js";
import { buildNativeHarnessBackupManifest, closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { createNativeHarnessBackupStamp } from "../services/native-runtime/native-harness-backup-stamp.js";
import { assertSettledNativeHarnessBackupSource, settledNativeHarnessBackupOwner } from "../services/native-runtime/native-harness-preservation-source.js";
import { prestageNativeHarnessBackups } from "../services/native-runtime/native-harness-backup-migration.js";
import { restoreDurableNativeHarnessBackup } from "../services/native-runtime/native-harness-backup-storage.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// A closed local harness transcript is source material, not a durable-copy
// receipt. The real online owner must still authorize, publish and restore it.
async function seedClosedHarnessTranscript(db: ReturnType<typeof createDb>, runtimeRoot: string,
  run: typeof heartbeatRuns.$inferSelect, lease: typeof environmentLeases.$inferSelect) {
  const base = join(runtimeRoot, `custody-backups-${randomUUID()}`);
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
  const scopeId = randomUUID(), scopeDigest = createHash("sha256").update(scopeId).digest("hex");
  const root = join(base, scopeDigest, "failover-backups", "current");
  await mkdir(join(root, "codex-home", "sessions"), { recursive: true });
  await mkdir(join(root, "runner"));
  const transcript = JSON.stringify({ sessionId: run.nativeSessionId, text: "The person's native harness transcript survives retirement failure." });
  await writeFile(join(root, "codex-home", "sessions", "transcript.json"), transcript);
  await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ runId: run.id, lifecycle: "suspended" }));
  const execution = { provider: { kind: "codex" }, binding: { companyId: run.companyId, issueId: run.nativeIssueId,
    runId: run.id, agentId: run.agentId, executionWorkspaceId: randomUUID() },
    workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: run.nativeSessionId, driverKind: "codex_app_server", protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } as never;
  const manifest = buildNativeHarnessBackupManifest({ backupRoot: root, execution, runnerInstanceId: run.runnerInstanceId!,
    providerSessionIdentity: { providerSessionId: "old-provider-session" }, sourceProviderLeaseId: lease.providerLeaseId! });
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  const stamp = createNativeHarnessBackupStamp({ manifestPath: join(root, "manifest.json"), sessionScopeId: scopeId,
    authorizedProviderLeaseId: lease.providerLeaseId!, runnerInstanceId: run.runnerInstanceId!, normalizedSessionId: run.nativeSessionId!,
    completedAt: manifest.completedAt });
  await db.update(environmentLeases).set({ metadata: { ...lease.metadata, nativeHarnessBackup: stamp } }).where(eq(environmentLeases.id, lease.id));
  return { scopeDigest, root, manifestSha256: stamp.manifestSha256, transcript, storage: createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "custody-object-store"))) };
}

const support = await getRecoveryPostgresSupport({});

describe.skipIf(!support.supported)("unaddressable native custody releases fresh-box admission, never the old box", () => {
  const fixture = nativeRestartFixture({});

  it.each(["unpinned", "pinned", "successor cannot start"] as const)("%s: real predispatch retry, sweep and queue", async scenario => {
    const { companyId, agentId, runtimeRoot } = fixture.current;
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const pluginId = randomUUID(), driverKey = `custody-${pluginId}`, pluginKey = `paperclip.${driverKey}`;
    const oldBox = `old-${randomUUID()}`, newBox = `fresh-${randomUUID()}`;
    const calls: Array<{ method: string; box?: string }> = [];
    let acquisitions = 0;
    const manager = {
      isRunning: vi.fn(() => true),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentExecute",
        "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] })),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string }) => {
        calls.push({ method, box: params.providerLeaseId });
        if (method === "environmentAcquireLease") return { providerLeaseId: acquisitions++ === 0 ? oldBox : newBox,
          metadata: { remoteCwd: "/workspace" } };
        if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
        if (method === "environmentDestroyLease" || method === "environmentReleaseLease")
          return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
        throw new Error(`Unexpected provider call: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Custody provider", description: "Test provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey, kind: "sandbox_provider",
          displayName: "Custody provider", configSchema: { type: "object" } }] } } as never);
    const [environment] = await db.insert(environments).values({ name: driverKey, driver: "sandbox", status: "active",
      config: { provider: driverKey, image: "fake:test", reuseLease: false } }).returning();
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager });
    const env = (await environmentService(db).getById(environment!.id))!;
    const turns = new Map<string, string>();
    const allocations = new Map<string, string>();
    let failedRunId = "", replacementAllocationRefused = false;
    const backend: NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> = execution => {
      let identity: NativeRunIdentity, sourceInstanceId = "";
      let turn = Promise.withResolvers<string>();
      const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      const session: NativeSession = {
        identity: () => identity, capabilities: async () => capabilities,
        attachRun: async input => { identity = input.identity; },
        startTurn: async input => { turns.set(identity.runId, JSON.stringify(input.message)); const turnId = randomUUID();
          turn.resolve(turnId); return { turnId }; },
        async *events() {
          const turnId = await turn.promise;
          const event = (seq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
            schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
            sourceEventId: `${sourceInstanceId}:${identity.runId}:${seq}`, sourceSeq: seq, runId: identity.runId,
            normalizedSessionId: identity.sessionId, turnId, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload });
          yield event(1, "turn.started", {});
          yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Done on the fresh box." });
          turn = Promise.withResolvers<string>();
          yield event(3, "turn.completed", { status: "completed" });
        },
        result: async () => null,
        snapshot: async () => ({ backendKind: "mock", sessionId: "custody-session", identity,
          providerSessionId: "custody-provider-session", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
        close: async () => {},
      };
      return {
        descriptor: async () => {
          const runId = execution.binding.runId;
          if (failedRunId && scenario === "successor cannot start") {
            replacementAllocationRefused = true;
            throw Object.assign(new Error("The replacement computer could not be started."), { code: "sandbox_allocation_refused" });
          }
          const acquired = await runtime.acquireRunLease({ companyId, environment: env, issueId: execution.binding.issueId,
            agentId, adapterType: "paperclip_runner", heartbeatRunId: runId, persistedExecutionWorkspace: null });
          allocations.set(runId, acquired.lease.providerLeaseId!);
          if (!failedRunId) {
            failedRunId = runId;
            // Historical native lease: session identity exists, no verified copy,
            // and no pin through which this controller can address the old box.
            await db.update(heartbeatRuns).set({ nativeSessionId: execution.session.normalizedSessionId }).where(eq(heartbeatRuns.id, runId));
            await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner",
              taskKey: execution.binding.issueId!, lastRunId: runId });
            await db.update(environmentLeases).set({ leasePolicy: "reuse_by_execution_workspace" })
              .where(eq(environmentLeases.id, acquired.lease.id));
            if (scenario !== "pinned") {
              const { pluginId: _pin, ...metadata } = acquired.lease.metadata!;
              await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, acquired.lease.id));
            }
            throw new NativePredecessorRetirementUnprovenError("previous-run", oldBox, new Error("Retirement was not confirmed."));
          }
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          sourceInstanceId = run!.runnerInstanceId!;
          return { kind: "mock", name: "custody-fresh-box", version: "1", capabilities,
            runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
        },
        openSession: async input => { identity = input.identity; return session; },
        recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
      };
    };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: backend, pluginWorkerManager: manager });
    try {
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
      const [issue] = await db.insert(issues).values({ companyId, title: "Continue on a fresh computer", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
        conversationState: "active" }).returning();
      const issueId = issue!.id;
      const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
        body: "Please continue my saved work." }).returning();
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
        payload: { issueId, commentId: message!.id }, contextSnapshot: { issueId, taskKey: issueId, wakeCommentId: message!.id } });
      expect(run).not.toBeNull();
      await waitForCondition("the predecessor to settle", () => heartbeat.getTaskDrainStatus().quiescent, 30_000);
      expect(await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.runId, run!.id))).toEqual([]);
      expect(turns.has(run!.id)).toBe(false);
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, run!.id)));
      expect(successor).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 });
      await heartbeat.sweepPendingCleanupLeases();
      const [old] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, run!.id),
        eq(environmentLeases.providerLeaseId, oldBox)));
      const [failedSource] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(old!.metadata?.nativeHarnessBackup).toBeUndefined();
      const archive = await seedClosedHarnessTranscript(db, runtimeRoot, failedSource!, old!);
      const assertOldCustody = () => {
        expect(old).toMatchObject({ status: "released", cleanupStatus: "success" });
        expect(old!.metadata?.orphanedRunLeaseRecovery).toMatchObject({ nativeCustodyUnverified: true });
        expect(calls.filter(call => /Destroy|Release/.test(call.method) && call.box === oldBox)).toEqual([]);
        if (scenario === "pinned") {
          expect(calls.filter(call => call.method === "environmentStopLease" && call.box === oldBox)).toEqual([{ method: "environmentStopLease", box: oldBox }]);
          expect(old!.metadata?.sandboxStopAndRetainReceipt).toMatchObject({ providerLeaseId: oldBox, pluginId });
          expect(old!.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped", providerLeaseId: oldBox });
        } else {
          expect(calls.filter(call => call.method === "environmentStopLease" && call.box === oldBox)).toEqual([]);
          expect(old!.metadata?.orphanedRunLeaseRecovery).toMatchObject({ disposition: "retained_unstoppable", reason: "provider_plugin_pin_missing" });
          expect(old!.metadata?.remoteExecutionTermination).toBeUndefined();
          expect(old!.metadata?.sandboxStopAndRetainReceipt).toBeUndefined();
        }
      };

      const startedAt = Date.now();
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("normal fresh-box admission", async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id));
        return row?.status === (scenario === "successor cannot start" ? "failed" : "succeeded");
      });
      await waitForCondition("the successor to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      assertOldCustody();
      const admissionMs = Date.now() - startedAt;
      expect(admissionMs).toBeLessThan(10_000);
      expect(calls.filter(call => call.method === "environmentDestroyLease" && call.box === oldBox)).toEqual([]);
      const copied = await prestageNativeHarnessBackups(db, { storage: archive.storage, signal: AbortSignal.timeout(15_000) });
      console.log("CUSTODY_CONTINUATION_COPY", JSON.stringify({ scenario, copied }));
      expect(copied).toEqual({ inspected: 1, published: 1, current: 0, deferred: {} });
      const restored = join(runtimeRoot, `continuation-restored-${randomUUID()}`);
      expect(await restoreDurableNativeHarnessBackup({ db, storage: archive.storage, companyId,
        scopeDigest: archive.scopeDigest, backupRoot: restored })).toBe(true);
      expect(await readFile(join(restored, "current", "codex-home", "sessions", "transcript.json"), "utf8")).toBe(archive.transcript);
      expect((await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.runId, run!.id)))[0])
        .toMatchObject({ status: "current", scopeDigest: archive.scopeDigest, manifestSha256: archive.manifestSha256 });
      if (scenario !== "successor cannot start") {
        const owner = await settledNativeHarnessBackupOwner(db, { companyId, issueId, runId: run!.id,
          sessionId: failedSource!.nativeSessionId!, runnerInstanceId: failedSource!.runnerInstanceId!,
          scopeDigest: archive.scopeDigest, root: archive.root, manifestSha256: archive.manifestSha256,
          providerLeaseId: oldBox, signal: AbortSignal.timeout(15_000) });
        expect(owner).toMatchObject({ selectedSessionId: null, selectedLastRunId: null });
        const [sourceLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, old!.id));
        const { orphanedRunLeaseRecovery: _obligation, ...withoutObligation } = sourceLease!.metadata!;
        await db.update(environmentLeases).set({ metadata: withoutObligation }).where(eq(environmentLeases.id, old!.id));
        await expect(db.transaction(tx => assertSettledNativeHarnessBackupSource(tx as unknown as typeof db, owner!))).rejects.toThrow("native_harness_preservation_source_unsettled");
        await db.update(environmentLeases).set({ metadata: sourceLease!.metadata }).where(eq(environmentLeases.id, old!.id));
      }
      const [currentIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const presentation = await taskInterruptionPresentation(db, currentIssue!);
      if (scenario === "successor cannot start") {
        expect(replacementAllocationRefused).toBe(true);
        expect(presentation).toMatchObject({ state: "failed", canRetry: true });
        expect(JSON.stringify(presentation)).not.toContain("Waiting for the sandbox provider");
        expect(turns.has(successor!.id)).toBe(false);
      } else {
        expect(allocations.get(run!.id)).toBe(oldBox);
        expect(allocations.get(successor!.id)).toBe(newBox);
        expect(turns.get(successor!.id)).toContain("Please continue my saved work.");
      }
      // Count only destructive calls against the old box: a successful fresh
      // ephemeral sandbox can be released normally after its own turn.
      expect(calls.filter(call => /Destroy|Release/.test(call.method) && call.box === oldBox)).toEqual([]);
      console.log("UNPINNED_CUSTODY_ROW", JSON.stringify({ scenario, oldBox, newBox: allocations.get(successor!.id),
        admissionMs, sourceRunId: run!.id, oldStatus: old!.status, obligation: old!.metadata?.orphanedRunLeaseRecovery,
        oldDestroys: calls.filter(call => /Destroy|Release/.test(call.method) && call.box === oldBox).length,
        stopReceipt: old!.metadata?.sandboxStopAndRetainReceipt, transcriptRestored: true, presentation }));
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      vi.unstubAllEnvs();
      await db.$client.end();
    }
  }, 90_000);

  it("sweeps a historical invalid stop intent and preserves its sealed session through the existing copy net", async () => {
    const { companyId, agentId, runtimeRoot } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const manager = { isRunning: vi.fn(() => true), call: vi.fn(async () => { throw new Error("Unpinned custody cannot call a provider"); }) } as unknown as PluginWorkerManager;
    const heartbeat = heartbeatService(db, { pluginWorkerManager: manager });
    try {
      const seeded = await fixture.seedRun("sealed-unpinned", db);
      const { runId, issueId, native } = seeded;
      // A historical closed source: no live writer, selected sealed session,
      // and a failed native finalization. This does not alter archive guards.
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, leaseExpiresAt: null,
        recoveryState: "original_failure_retained" }).where(eq(nativeRunFinalizations.runId, runId));
      await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId, lastRunId: runId });
      const [environment] = await db.insert(environments).values({ name: "Historical unpinned source", driver: "sandbox", status: "active",
        config: { provider: "historical-unregistered-provider", image: "fake:test" } }).returning();
      const oldBox = `sealed-old-${randomUUID()}`;
      const [lease] = await db.insert(environmentLeases).values({ environmentId: environment!.id, companyId, agentId, issueId,
        heartbeatRunId: runId, providerLeaseId: oldBox, status: "pending_cleanup", cleanupStatus: "failed", cleanupAttempts: 4,
        metadata: { driver: "plugin", sandboxProvider: true, remote: true,
          orphanedRunLeaseRecovery: { nativeCustodyUnverified: true, reason: "native_harness_copy_unverified", recoveredAt: new Date().toISOString() },
          sandboxStopAndRetain: { schema: "paperclip.sandbox-stop-and-retain.v1", requestId: "legacy-invalid-stop", nativeCustodyUnverified: true,
            pluginId: null, providerLeaseId: oldBox, allocationKey: "legacy", bindingDigest: "legacy", requestedAt: new Date().toISOString() } } }).returning();
      expect(await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.runId, runId))).toEqual([]);
      await heartbeat.sweepPendingCleanupLeases();
      const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id));
      expect(retained).toMatchObject({ status: "released", cleanupStatus: "success" });
      expect(retained!.metadata?.orphanedRunLeaseRecovery).toMatchObject({ nativeCustodyUnverified: true,
        disposition: "retained_unstoppable", reason: "provider_plugin_pin_missing" });
      expect(retained!.metadata?.sandboxStopAndRetain).toBeUndefined();
      expect(retained!.metadata?.remoteExecutionTermination).toBeUndefined();
      expect(retained!.metadata?.sandboxStopAndRetainReceipt).toBeUndefined();
      expect(manager.call).not.toHaveBeenCalled();

      const base = join(runtimeRoot, `custody-backups-${randomUUID()}`);
      vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
      const scopeId = randomUUID(), scopeDigest = createHash("sha256").update(scopeId).digest("hex");
      const root = join(base, scopeDigest, "failover-backups", "current");
      await mkdir(join(root, "codex-home", "sessions"), { recursive: true });
      await mkdir(join(root, "runner"));
      const transcript = JSON.stringify({ sessionId: native.normalizedSessionId, text: "The person's native harness transcript survives retirement failure." });
      await writeFile(join(root, "codex-home", "sessions", "transcript.json"), transcript);
      await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({ runId, lifecycle: "suspended" }));
      const execution = { provider: { kind: "codex" }, binding: { companyId, issueId, runId, agentId, executionWorkspaceId: randomUUID() },
        workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } } as never;
      const manifest = buildNativeHarnessBackupManifest({ backupRoot: root, execution, runnerInstanceId: native.runnerInstanceId,
        providerSessionIdentity: { providerSessionId: "old-provider-session" }, sourceProviderLeaseId: oldBox });
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      const stamp = createNativeHarnessBackupStamp({ manifestPath: join(root, "manifest.json"), sessionScopeId: scopeId,
        authorizedProviderLeaseId: oldBox, runnerInstanceId: native.runnerInstanceId, normalizedSessionId: native.normalizedSessionId,
        completedAt: manifest.completedAt });
      await db.update(environmentLeases).set({ metadata: { ...retained!.metadata, nativeHarnessBackup: stamp } }).where(eq(environmentLeases.id, lease!.id));
      const storage = createStorageService(createLocalDiskStorageProvider(join(runtimeRoot, "custody-object-store")));
      const copied = await prestageNativeHarnessBackups(db, { storage, signal: AbortSignal.timeout(15_000) });
      expect(copied).toEqual({ inspected: 1, published: 1, current: 0, deferred: {} });
      expect((await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.runId, runId)))[0]).toMatchObject({ status: "current" });
      const restored = join(runtimeRoot, `custody-restored-${randomUUID()}`);
      expect(await restoreDurableNativeHarnessBackup({ db, storage, companyId, scopeDigest, backupRoot: restored })).toBe(true);
      expect(await readFile(join(restored, "current", "codex-home", "sessions", "transcript.json"), "utf8")).toBe(transcript);
      expect(manager.call).not.toHaveBeenCalled();
      console.log("UNPINNED_SEALED_COPY_ROW", JSON.stringify({ oldBox, oldStatus: retained!.status,
        providerCalls: 0, copied, transcriptRestored: true }));
    } finally {
      await heartbeat.drainActiveRunExecutions();
      vi.unstubAllEnvs();
      await db.$client.end();
    }
  }, 90_000);
});
