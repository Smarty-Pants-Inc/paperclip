// Follow-Paperclip Cuts A + B (adopt-lead 05:37Z; spec fp-FINAL-WITH-RFL-FIXES, RFL A-5 / B-5 / B-2).
// RED first, test-only: these pin the behaviour the two cuts must reach, through the real acquisition,
// the real fresh-continuation fallback and delivery, and the real unanswered-message sweep. Only provider
// I/O is a controlled peer (the Boat plugin worker).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations, plugins,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../__tests__/helpers/truncate-with-deadlock-retry.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import {
  FRESH_CONTINUATION_PENDING_BOUND_MS, FRESH_CONTINUATIONS_PER_CHAIN, FRESH_CONTINUATION_WINDOW_MS,
  continueHeldExecutions, ensureFreshContinuation, resetBacklogContinuationPacingForTests,
} from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { isFreshThreadRefusal } from "./native-runtime/runner-reconciliation-refusal.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { createNativeHarnessBackupStamp, readNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-runtime/native-harness-backup-stamp.js";
import { persistNativeHarnessBackup, verifyDurableNativeHarnessBackup } from "./native-runtime/native-harness-backup-storage.js";
import { obsoleteWorkspaceCustodyRefusal } from "./native-runtime/native-workspace-finalization-state.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { settleUnansweredPersonMessagesForTask, UNANSWERED_MESSAGE_SETTLE_MS } from "./recovery/unanswered-person-message.js";

// Only the durable storage backend selector is a peer: real encrypted objects,
// publication, download/hash verification and local tree verification run below.
const custodyPeer = vi.hoisted(() => ({ storage: null as StorageService | null }));
vi.mock("./native-runtime/native-harness-backup-storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-runtime/native-harness-backup-storage.js")>(),
  durableNativeHarnessStorage: () => custodyPeer.storage,
}));
// Positive destroy outcome tests isolate the workspace receipt boundary. There
// is NO production receipt integration yet: the default real function refuses.
// The separate workspace_unverified row exercises that real refusal end-to-end.
vi.mock("./native-runtime/native-workspace-finalization-state.js", async importOriginal => {
  const original = await importOriginal<typeof import("./native-runtime/native-workspace-finalization-state.js")>();
  return { ...original, obsoleteWorkspaceCustodyRefusal: vi.fn(original.obsoleteWorkspaceCustodyRefusal) };
});

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
// A typed fresh-thread refusal (runner-reconciliation-refusal.ts FRESH_THREAD_REFUSAL_CODES).
const TYPED = "runner_remote_state_unavailable";
// B-2 (RFL ruled 05:51Z): the ONE bound is the fork's K=2 chain cap; this is the text the person sees when it is
// reached. "Press Retry" only where the task view proves a Retry control in that state, so the ruled default applies.
const BOUND_REACHED_TEXT = "Paperclip tried to continue this task twice from its saved work, and both attempts failed. "
  + "Your message and the saved work are kept. Send a new message to try again.";

suite("follow-Paperclip Cuts A + B: REDs (A-5, B-5, B-2)", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let companyId = "", agentId = "", userId = "";
  const ownedRoots: string[] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-follow-paperclip-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.mocked(obsoleteWorkspaceCustodyRefusal).mockReset();
    vi.mocked(obsoleteWorkspaceCustodyRefusal).mockImplementation(
      (await vi.importActual<typeof import("./native-runtime/native-workspace-finalization-state.js")>("./native-runtime/native-workspace-finalization-state.js")).obsoleteWorkspaceCustodyRefusal);
    custodyPeer.storage = null;
    for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
    resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(db, "truncate table companies, environments, plugins cascade");
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function company(overrideAgentId?: string) {
    companyId = randomUUID(); agentId = overrideAgentId ?? randomUUID(); userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Paul", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Follow Paperclip", issuePrefix: `FP${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }

  /** A person's message whose run ended with a typed fresh-thread refusal, held by its recovery action. */
  async function heldTypedMessage(finishedAt = new Date(Date.now() - 60_000)) {
    const issueId = randomUUID(), runId = randomUUID(), messageId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer Paul", status: "blocked",
      assigneeAgentId: agentId, responsibleUserId: userId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Please summarise the copper orchard report.", createdAt: new Date(finishedAt.getTime() - 11 * 60_000) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", errorCode: TYPED, error: TYPED, nativePhase: "terminal_failure", responsibleUserId: userId,
      startedAt: new Date(finishedAt.getTime() - 10 * 60_000), finishedAt, createdAt: new Date(finishedAt.getTime() - 10.5 * 60_000),
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: messageId, wakeCommentIds: [messageId] } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-continuation:${runId}`, nextAction: "Continue from the last saved work.", maxAttempts: 3, createdAt: finishedAt,
      evidence: { runId, originalFailureCode: TYPED, nativeFailureBlock: { runId, statusVersion: 4 } } }).returning();
    return { issueId, runId, messageId, actionId: action!.id, finishedAt };
  }

  const successors = (runId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
  const currentSystemNotes = async (issueId: string) => (await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"))))
    .filter(note => !(note.metadata as Record<string, unknown> | null)?.supersededByCommentId && !note.deletedAt);
  async function occupySlot() {
    const [other] = await db.insert(issues).values({ companyId, title: "Other work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running", contextSnapshot: { issueId: other!.id } });
  }
  async function deliver(database = db) {
    const heartbeat = heartbeatService(database);
    await deliverReconciledExecutions(database, heartbeat.wakeup);
    await deliverReconciledExecutions(database, heartbeat.wakeup);
  }

  async function custodyFixture(input: { issueId: string; runId: string; providerLeaseId: string; completedAt: Date }, durable = true) {
    const base = await mkdtemp(join(tmpdir(), "paperclip-a5-custody-")); ownedRoots.push(base);
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", base);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "51".repeat(32));
    const sessionScopeId = randomUUID(), normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
    const scopeDigest = createHash("sha256").update(sessionScopeId).digest("hex");
    const root = join(base, scopeDigest, "failover-backups", "current");
    await mkdir(join(root, "pi"), { recursive: true });
    const history = Buffer.from('{"message":"copper orchard"}\n');
    await writeFile(join(root, "pi", "history.jsonl"), history, { mode: 0o600 });
    const directorySha = `sha256:${createHash("sha256").update(`file:history.jsonl:384:${history.length}\0`).update(history).digest("hex")}`;
    const manifest = { schema: "paperclip.native-harness-backup.v1", normalizedSessionId, runnerInstanceId,
      sourceProviderLeaseId: input.providerLeaseId, completedAt: input.completedAt.toISOString(),
      directories: [{ name: "pi", sha256: directorySha, bytes: history.length }] };
    const manifestPath = join(root, "manifest.json"); await writeFile(manifestPath, JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath, sessionScopeId, authorizedProviderLeaseId: input.providerLeaseId,
      normalizedSessionId, runnerInstanceId, completedAt: manifest.completedAt });
    expect(readNativeHarnessBackupStamp(stamp, input.providerLeaseId)).toEqual(stamp);
    expect(await verifyNativeHarnessBackupStampAsync(stamp, input.providerLeaseId, AbortSignal.timeout(5000))).toBe(true);
    custodyPeer.storage = createStorageService(createLocalDiskStorageProvider(join(base, "durable")));
    if (durable) {
      // Offline capture is fenced by the ended run and a quiescent coordinator.
      await db.insert(nativeRunFinalizations).values({ companyId, issueId: input.issueId, runId: input.runId,
        phase: "observed", leaseOwner: null });
      await persistNativeHarnessBackup({ db, storage: custodyPeer.storage, root, scopeDigest,
        owner: { kind: "offline_migration", companyId, issueId: input.issueId, runId: input.runId, writersStopped: true } });
      expect(await verifyDurableNativeHarnessBackup({ db, storage: custodyPeer.storage, companyId, scopeDigest,
        manifestSha256: stamp.manifestSha256 })).toBe(true);
    }
    return { stamp, root };
  }

  // ---------------------------------------------------------------- A-5
  // The person's next message wakes a follow-up run on the SAME task (reuse leases are scoped to the task). After the image
  // change its acquisition finds the old boot-source lease obsolete. After Cut A that is upstream's guarded destroy
  // (destroyReusableSandboxLease), dispatched ONLY with the box's native session in verified custody (RFL's A-5 condition,
  // upstream's own resume-replacement guard verifyRecoverableNativeHarnessBackup). A typed destroyed receipt lands on the old
  // lease; a failed or void destroy records none and strips the old stop receipt (environments.ts releaseLease). Without
  // custody nothing is destroyed: the lease is kept, and source mismatch keeps it from serving the next run. In every case
  // the follow-up, which then fails with a typed fresh-thread refusal, is still continued within upstream's bound and
  // delivered once, carrying the message (RFL A-5: A and B ship together).
  describe("A-5: a follow-up acquisition with boot-source drift; the held message is still answered", () => {
    it.each([
      ...(["destroyed", "failed", "void"] as const).flatMap(variant =>
        (["two_copies", "no_durable", "no_local"] as const).map(custody => ({ variant, custody }))),
      { variant: "destroyed", custody: "workspace_unverified" },
      { variant: "destroyed", custody: "no_custody" },
      { variant: "destroyed", custody: "dry_run" },
    ] as const)("$variant / $custody", async ({ variant, custody }) => {
      await company();
      expect(isFreshThreadRefusal({ errorCode: TYPED })).toBe(true);
      const issueId = randomUUID(), messageId = randomUUID(), oldRunId = randomUUID(), followUpId = randomUUID();
      const environmentId = randomUUID(), pluginId = randomUUID(), oldLeaseId = randomUUID();
      const t0 = new Date(Date.now() - 3600_000);
      await db.insert(issues).values({ id: issueId, companyId, title: "Answer Paul", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, statusVersion: 4 });
      const [environment] = await db.insert(environments).values({ id: environmentId, name: `Boat ${environmentId.slice(0, 8)}`, driver: "sandbox",
        status: "active", config: { provider: "boat", image: "boot-source-before-upgrade", reuseLease: true } }).returning();
      await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat",
        version: "1.0.0", apiVersion: 1, status: "ready", categories: ["automation"],
        manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat peer", author: "Paperclip",
          categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true,
            configSchema: { type: "object" } }] } } as never);
      // The earlier turn: its warm box was released for reuse with a bound stop receipt.
      await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
        status: "succeeded", createdAt: t0, startedAt: t0, finishedAt: new Date(t0.getTime() + 60_000), contextSnapshot: { issueId } });
      const releasedAt = new Date(t0.getTime() + 61_000), providerLeaseId = `bx-old-${oldLeaseId.slice(0, 8)}`;
      vi.stubEnv("PAPERCLIP_OBSOLETE_SANDBOX_DESTROY", custody === "dry_run" ? "" : "destroy");
      if (custody !== "workspace_unverified") vi.mocked(obsoleteWorkspaceCustodyRefusal).mockResolvedValue(null);
      const backup = custody === "no_custody" ? null : await custodyFixture({ issueId, runId: oldRunId,
        providerLeaseId, completedAt: releasedAt }, custody !== "no_durable");
      if (custody === "no_local") await rm(backup!.root, { recursive: true });
      await db.insert(environmentLeases).values({ id: oldLeaseId, companyId, environmentId, issueId, heartbeatRunId: oldRunId,
        provider: "boat", providerLeaseId, leasePolicy: "reuse_by_environment", status: "released", cleanupStatus: "success",
        acquiredAt: t0, releasedAt, lastUsedAt: releasedAt,
        metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, pluginKey: "paperclip.boat", agentId, ...environment!.config,
          reusableSandboxLease: { adapterType: "paperclip_runner" }, pendingCleanupInFlight: false,
          ...(backup ? { nativeHarnessBackup: backup.stamp } : {}),
          remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped", companyId, runId: oldRunId,
            leaseId: oldLeaseId, provider: "boat", providerLeaseId, confirmedAt: releasedAt.toISOString() } } });
      const [oldBefore] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
      // Paul's message wakes the follow-up on the same task; the next image changed the boot source.
      await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: userId,
        body: "Please summarise the copper orchard report.", createdAt: new Date(Date.now() - 5 * 60_000) });
      await db.insert(heartbeatRuns).values({ id: followUpId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
        invocationSource: "on_demand", status: "running", responsibleUserId: userId, createdAt: new Date(Date.now() - 4 * 60_000),
        startedAt: new Date(Date.now() - 4 * 60_000),
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: messageId, wakeCommentIds: [messageId] } });
      const drifted = { ...environment!.config, image: "boot-source-after-upgrade" };
      await db.update(environments).set({ config: drifted }).where(eq(environments.id, environmentId));
      const call = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") return { providerLeaseId: "bx-fresh", metadata: { ...drifted, remoteCwd: "/workspace" } };
        if (method === "environmentDestroyLease") {
          if (variant === "failed") throw new Error("boat destroy timed out");
          return variant === "void" ? undefined : { providerLeaseId: params.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`unexpected provider call ${method}`);
      });
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
      } as unknown as PluginWorkerManager });
      const acquired = await runtime.acquireRunLease({ companyId, environment: { ...environment!, config: drifted, envVars: {} } as unknown as Environment,
        issueId, agentId, heartbeatRunId: followUpId, adapterType: "paperclip_runner", persistedExecutionWorkspace: null } as never);
      expect(acquired.lease.providerLeaseId, "the stale source never serves the next run").toBe("bx-fresh");

      const destroys = call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").map(([, , params]) => params.providerLeaseId);
      expect.soft(call.mock.calls.some(([, method]) => method === "environmentStopLease"), "no acquisition-issued stop").toBe(false);
      const [oldAfter] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
      const decisions = await db.select().from(activityLog).where(and(eq(activityLog.entityId, oldLeaseId),
        eq(activityLog.companyId, companyId)));
      const decision = decisions.find(row => row.action.startsWith("environment.lease.obsolete_"));
      if (custody !== "two_copies") {
        expect.soft(destroys, "unverified copy/workspace or dry-run -> no destroy").toEqual([]);
        expect.soft(oldAfter, "the box and its stop receipt are kept unchanged").toEqual(oldBefore);
        if (custody === "dry_run") expect.soft(decision?.action).toBe("environment.lease.obsolete_would_destroy");
        else expect.soft(decision?.details).toMatchObject({ reason: custody === "no_custody" ? "no_custody_stamp"
          : custody === "no_durable" ? "durable_custody_copy_unverified"
          : custody === "no_local" ? "local_custody_copy_unverified" : "workspace_custody_unverified" });
      } else {
        expect.soft(destroys).toEqual([providerLeaseId]);
        expect.soft(decision?.action).toBe(variant === "destroyed" ? "environment.lease.obsolete_destroyed" : "environment.lease.obsolete_destroy_pending");
        if (variant === "destroyed") {
          expect.soft(oldAfter).toMatchObject({ status: "expired", cleanupStatus: "success",
            metadata: { remoteExecutionTermination: { state: "destroyed", leaseId: oldLeaseId, runId: oldRunId, providerLeaseId } } });
          expect.soft(hasRemoteTerminationReceipt(oldAfter!)).toBe(true);
        } else {
          expect.soft(oldAfter!.metadata?.remoteExecutionTermination, "failed/void is never a termination receipt").toBeUndefined();
          expect.soft(oldAfter!.status).toBe(variant === "failed" ? "pending_cleanup" : "expired");
        }
      }

      // The follow-up then fails with a typed fresh-thread refusal before answering; its own box stopped with a receipt.
      // Its receipt is confirmed after the acquisition and no later than its release (the gate's time rule).
      const failedAt = new Date(Math.max(Date.now(), acquired.lease.acquiredAt.getTime() + 1));
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: failedAt,
        metadata: { ...acquired.lease.metadata, remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped",
          companyId, runId: followUpId, leaseId: acquired.lease.id, provider: "boat", providerLeaseId: "bx-fresh", confirmedAt: failedAt.toISOString() } } })
        .where(eq(environmentLeases.id, acquired.lease.id));
      const [blocked] = await db.update(issues).set({ status: "blocked", blockedTransitionAt: failedAt }).where(eq(issues.id, issueId)).returning();
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: TYPED, error: TYPED, nativePhase: "terminal_failure", finishedAt: failedAt })
        .where(eq(heartbeatRuns.id, followUpId));
      await db.insert(nativeRunFinalizations).values({ runId: followUpId, companyId, issueId, phase: "terminal_failure",
        recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active",
        ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
        fingerprint: `native-continuation:${followUpId}`, nextAction: "Continue from the last saved work.", maxAttempts: 3, createdAt: failedAt,
        evidence: { runId: followUpId, originalFailureCode: TYPED, nativeFailureBlock: { runId: followUpId, statusVersion: blocked!.statusVersion } } });

      // The person's message is still answered: continued within upstream's bound, delivered exactly once.
      let result: Awaited<ReturnType<typeof ensureFreshContinuation>> | null = null;
      for (const at of [0, FRESH_CONTINUATION_PENDING_BOUND_MS + 60_000]) {
        result = await ensureFreshContinuation(db, { companyId, runId: followUpId, trigger: "held_recovery", now: new Date(Date.now() + at) });
        if (result.kind === "continued") break;
      }
      expect(result, "continued within ~10 min (upstream's bound), never held forever").toMatchObject({ kind: "continued" });
      await occupySlot();
      await deliver();
      const next = await successors(followUpId);
      expect(next).toHaveLength(1);
      expect(next[0]!.contextSnapshot).toMatchObject({ issueId, previousRunId: followUpId, forceFreshSession: true,
        wakeCommentIds: [messageId] });
    }, 60_000);
  });

  // Every adapter is guarded; full-id config distinguishes prefix collisions.
  // These are synthetic fixture identities, NOT the production Paul/Kate IDs.
  const paulId = "29b216c4-0000-4000-8000-000000000001", kateId = "46a1dae4-0000-4000-8000-000000000001";
  const fullIds = `${paulId},${kateId}`;
  it.each([
    { name: "pre-metadata adapter", adapterType: null, id: undefined, ids: "", reason: "no_custody_stamp" },
    { name: "known non-native adapter", adapterType: "claude_local", id: undefined, ids: "", reason: "no_custody_stamp" },
    { name: "Paul full id", adapterType: null, id: paulId, ids: fullIds, reason: "agent_excluded_until_paul_says" },
    { name: "Kate full id", adapterType: null, id: kateId, ids: fullIds, reason: "agent_excluded_until_paul_says" },
    { name: "different agent sharing Paul prefix", adapterType: null, id: "29b216c4-0000-4000-8000-000000000002", ids: fullIds, reason: "no_custody_stamp" },
    { name: "different agent sharing Kate prefix", adapterType: null, id: "46a1dae4-0000-4000-8000-000000000002", ids: fullIds, reason: "no_custody_stamp" },
    { name: "unconfigured prefix fail-closed", adapterType: null, id: paulId, ids: "", reason: "agent_excluded_until_paul_says" },
    { name: "partial config fail-closed", adapterType: null, id: kateId, ids: paulId, reason: "agent_excluded_until_paul_says" },
    { name: "malformed config fail-closed", adapterType: null, id: paulId, ids: `${fullIds},29b216c4`, reason: "agent_excluded_until_paul_says" },
  ])("fail closed: $name", async ({ adapterType, id, ids, reason }) => {
    await company(id);
    vi.stubEnv("PAPERCLIP_OBSOLETE_SANDBOX_DESTROY", "destroy");
    vi.stubEnv("PAPERCLIP_OBSOLETE_SANDBOX_DESTROY_EXCLUDED_AGENT_IDS", ids);
    const issueId = randomUUID(), oldRunId = randomUUID(), followUpId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID(), oldLeaseId = randomUUID();
    const t0 = new Date(Date.now() - 3600_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer Paul", status: "in_progress", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ id: environmentId, name: `Boat ${environmentId.slice(0, 8)}`, driver: "sandbox",
      status: "active", config: { provider: "boat", image: "boot-source-before-upgrade", reuseLease: true } }).returning();
    await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat",
      version: "1.0.0", apiVersion: 1, status: "ready", categories: ["automation"],
      manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat peer", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true,
          configSchema: { type: "object" } }] } } as never);
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
      status: "succeeded", createdAt: t0, startedAt: t0, finishedAt: new Date(t0.getTime() + 60_000), contextSnapshot: { issueId } });
    const providerLeaseId = `bx-old-${oldLeaseId.slice(0, 8)}`;
    // A warm box from an older release: retained (still running), and no reusableSandboxLease.adapterType recorded.
    await db.insert(environmentLeases).values({ id: oldLeaseId, companyId, environmentId, issueId, heartbeatRunId: oldRunId,
      provider: "boat", providerLeaseId, leasePolicy: "reuse_by_environment", status: "retained", acquiredAt: t0, lastUsedAt: t0,
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, pluginKey: "paperclip.boat", agentId, ...environment!.config,
        pendingCleanupInFlight: false, ...(adapterType ? { reusableSandboxLease: { adapterType } } : {}) } });
    const [oldBefore] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
    await db.insert(heartbeatRuns).values({ id: followUpId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
      status: "running", createdAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId } });
    const drifted = { ...environment!.config, image: "boot-source-after-upgrade" };
    await db.update(environments).set({ config: drifted }).where(eq(environments.id, environmentId));
    const call = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: "bx-fresh", metadata: { ...drifted, remoteCwd: "/workspace" } };
      if (method === "environmentDestroyLease") return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      throw new Error(`unexpected provider call ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
    } as unknown as PluginWorkerManager });
    const acquired = await runtime.acquireRunLease({ companyId, environment: { ...environment!, config: drifted, envVars: {} } as unknown as Environment,
      issueId, agentId, heartbeatRunId: followUpId, adapterType, persistedExecutionWorkspace: null } as never);
    expect(acquired.lease.providerLeaseId).toBe("bx-fresh");
    expect.soft(call.mock.calls.filter(([, method]) => method === "environmentDestroyLease"), "every adapter, no custody -> never destroyed")
      .toEqual([]);
    const [oldAfter] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
    expect.soft(oldAfter).toEqual(oldBefore);
    const decisions = await db.select().from(activityLog).where(and(eq(activityLog.entityId, oldLeaseId), eq(activityLog.companyId, companyId)));
    expect.soft(decisions.find(row => row.action === "environment.lease.obsolete_destroy_refused")?.details).toMatchObject({ reason });
  }, 60_000);

  // ---------------------------------------------------------------- B-5 + B-2
  // The kept held-notice writer returns early for the typed family (native-session-executor.ts noticeHeldUnfinishedPredecessor,
  // `if (freshThreadRefusalCode(error)) return`). After Cut B the typed family is an ordinary failure: the fallback continues it
  // (its user text is the recovery action's nextAction, no thread comment), and the ONE thread note owner is the unanswered-message
  // sweep (recovery/unanswered-person-message.ts). B-2: the ONE bound is the K=2 chain cap; #21394's hourly window does not
  // re-open it.
  describe("B-5 / B-2: a typed chain that reaches the one bound gets exactly one note, from the unanswered-message sweep", () => {
    async function failContinuation(runId: string, issueId: string) {
      const now = new Date();
      const [task] = await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null, blockedTransitionAt: now })
        .where(eq(issues.id, issueId)).returning();
      const [run] = await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: issueId,
        nativePhase: "terminal_failure", errorCode: TYPED, error: TYPED, startedAt: new Date(now.getTime() - 1_000), finishedAt: now })
        .where(eq(heartbeatRuns.id, runId)).returning();
      if (run!.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: now })
        .where(eq(agentWakeupRequests.id, run!.wakeupRequestId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
      const hold = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
        fingerprint: `native-continuation:${runId}`, nextAction: "Continue from the last saved work.",
        evidence: { runId, originalFailureCode: TYPED, nativeFailureBlock: { runId, statusVersion: task!.statusVersion } } });
      const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
      await settleUnrecoverableExecutions(db, record!.createdAt);
      return now;
    }

    it("K=2 typed continuations, then the bound: no third run (even past the hourly window), one note within the settle time", async () => {
      await company();
      const f = await heldTypedMessage();
      await occupySlot();
      let source = f.runId;
      // The first failure is the message's own run; continue it, then fail each continuation the same typed way.
      await settleUnrecoverableExecutions(db, f.finishedAt);
      for (let attempt = 1; attempt <= FRESH_CONTINUATIONS_PER_CHAIN; attempt++) {
        await continueHeldExecutions(db);
        await deliver();
        const next = await successors(source);
        expect(next, `continuation ${attempt} is delivered`).toHaveLength(1);
        expect(next[0]!.contextSnapshot).toMatchObject({ wakeCommentIds: [f.messageId] });
        await settleUnansweredPersonMessagesForTask(db, { companyId, issueId: f.issueId, now: new Date(Date.now() + 30_000) });
        expect.soft(await currentSystemNotes(f.issueId), `no thread note while continuation ${attempt} is owed`).toHaveLength(0);
        source = next[0]!.id as typeof source;
        await failContinuation(source, f.issueId);
      }
      const endedAt = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source)))[0]!.finishedAt!;
      // B-2: the bound holds. Neither the held backlog nor delivery starts a third, even after #21394's hourly window.
      for (const at of [0, FRESH_CONTINUATION_WINDOW_MS + 60_000]) {
        await continueHeldExecutions(db, new Date(Date.now() + at));
        await deliver();
      }
      expect.soft(await successors(source), "the K=2 bound: no third continuation").toHaveLength(0);
      // B-5: the one note, from the unanswered-message sweep, within its settle time after the last run ended.
      const acceptance = endedAt.getTime() + UNANSWERED_MESSAGE_SETTLE_MS + 1_000;
      await settleUnansweredPersonMessagesForTask(db, { companyId, issueId: f.issueId, now: new Date(acceptance) });
      await settleUnansweredPersonMessagesForTask(db, { companyId, issueId: f.issueId, now: new Date(acceptance + 60_000) });
      const notes = await currentSystemNotes(f.issueId);
      expect(notes, `exactly one note, posted by ${UNANSWERED_MESSAGE_SETTLE_MS / 1000 + 1} s after the last run ended`).toHaveLength(1);
      expect(notes[0]!.metadata).toMatchObject({ authorizationReason: `unanswered_message:${f.messageId}` });
      expect(notes[0]!.body).toBe(BOUND_REACHED_TEXT);
      expect(notes[0]!.createdAt.getTime() - endedAt.getTime()).toBeLessThan(UNANSWERED_MESSAGE_SETTLE_MS + 60_000);
    }, 60_000);
  });

  // Keep the reference so a missing export is a type error, not a silent skip.
  void sql;
});
