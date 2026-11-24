import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, issueComments,
  issueRecoveryActions, issueRelations, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { NativePredecessorRetirementUnprovenError } from "../services/native-runtime/predecessor-retirement.js";
import { NativeProviderArtifactTransferTimeoutError } from "../services/native-runtime/native-provider-artifacts.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { buildNativeHarnessBackupManifest, resolveNativeHarnessPersistenceProfile, restoreNativeControllerProjections, closeIdleWarmNativeSessionsForRestart, restoreRemoteSuspendedRunnerCheckpoint, retireRefusedContinuousPiOwner, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";
import { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import { nativeRunnerCheckpointWriter } from "../services/native-runtime/native-runner-checkpoint.js";
import { admitNativeContinuationRefusal, NativeContinuationAdmissionRefusalError } from "../services/native-runtime/remote-warm-session-recovery.js";
import { retirePiRunnerByFact } from "../services/native-runtime/native-pi-retirement.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { PROCESS_START_REQUESTED } from "../services/native-process-start-events.js";
import { createNativeControllerRecovery, resolveNativeControllerRecovery } from "../services/native-runtime/native-controller-recovery.js";

// Budget admission is the last database write before the dispatch gate enters
// the native executor. Exhausted serialization retries there fail the run with
// no provider work started.
const admissionFaults = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("../services/budget-reservations.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/budget-reservations.js")>();
  const { AccountingContentionError } = await import("../services/accounting-transaction.js");
  return {
    ...actual,
    reserveRunBudget: async (...args: Parameters<typeof actual.reserveRunBudget>) => {
      if (admissionFaults.remaining > 0) {
        admissionFaults.remaining -= 1;
        throw new AccountingContentionError(Object.assign(new Error("could not serialize access due to concurrent update"),
          { name: "PostgresError", code: "40001" }), 4);
      }
      return actual.reserveRunBudget(...args);
    },
  };
});

const support = await getRecoveryPostgresSupport({});

type AdmissionFailure = { remaining: number; turnNeverIssued: boolean; environmentId: string; provider: string;
  providerLeaseId: string; leasePolicy: "reuse_by_environment" | "reuse_by_execution_workspace"; failedRuns: string[];
  sessionRoots: string[] };

function nativeBackend(db: ReturnType<typeof createDb>, options: { failDescriptorOnce?: { failed: boolean };
  unretiredPredecessorOnce?: { failed: boolean; environmentId: string; taskBlocked?: boolean; repeat?: string[]; freshSessionRequired?: boolean; noLease?: boolean; preDoorRunId?: string }; turnMessages?: Map<string, string>;
  savedAdmission?: { attempted: boolean; stage: "metadata_format" | "backup_without_reusable_lease";
    readable: boolean; noLease: boolean; retire429?: boolean; failedSource?: boolean; selectedSession?: string; predecessorRunId?: string;
    unstartedFollowUps?: boolean };
  admissionFailure?: AdmissionFailure; beforeRetirementFailure?: (runId: string, issueId: string) => Promise<void> } = {}):
  NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    let turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn: async input => {
        options.turnMessages?.set(identity.runId, JSON.stringify(input.message));
        const turnId = randomUUID();
        turn.resolve(turnId);
        return { turnId };
      },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." });
        turn = Promise.withResolvers<string>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "predispatch-session", identity,
        providerSessionId: "predispatch-provider-session", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        if (options.failDescriptorOnce && !options.failDescriptorOnce.failed) {
          options.failDescriptorOnce.failed = true;
          throw Object.assign(new Error("could not serialize access due to concurrent update"), { name: "PostgresError", code: "40001" });
        }
        const saved = options.savedAdmission;
        if (saved && !saved.attempted) {
          saved.attempted = true;
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
          const priorRunId = saved.predecessorRunId = randomUUID(), environmentId = randomUUID(), priorLeaseId = randomUUID();
          saved.selectedSession = run!.nativeSessionId!;
          const previous = { ...execution, binding: { ...execution.binding, runId: priorRunId } };
          const priorIdentity = { runId: priorRunId, normalizedSessionId: run!.nativeSessionId!, runnerInstanceId: run!.runnerInstanceId!,
            environmentLeaseId: priorLeaseId, turnId: "saved-turn", itemId: "saved-item" };
          const snapshot = { backendKind: "runner" as const, driverKind: execution.session.driverKind, sessionId: "saved-thread",
            providerSessionId: "saved-provider", identity: { ...execution.binding, runId: priorRunId, sessionId: run!.nativeSessionId! },
            activeTurnId: null, pendingRuntimeRequests: [] };
          const profile: Record<string, unknown> = { ...run!.runnerProfileJson, nativeExecutionInput: previous, sessionCheckpoint: snapshot };
          delete profile.nativeControllerRecovery;
          await db.insert(heartbeatRuns).values({ ...run!, id: priorRunId, status: saved.failedSource ? "failed" : "succeeded", retryOfRunId: null,
            createdAt: new Date(run!.createdAt.getTime() - 1_000),
            finishedAt: new Date(run!.createdAt.getTime() - (saved.unstartedFollowUps ? 750 : 100)), runnerProfileJson: profile });
          const owner = { companyId: run!.companyId, issueId: execution.binding.issueId, runId: priorRunId,
            authorityRunId: priorRunId, bootId: randomUUID(), generation: 1, leaseOwner: randomUUID() };
          await db.insert(nativeRunFinalizations).values({ companyId: owner.companyId, issueId: owner.issueId, runId: priorRunId,
            phase: "observed", controllerBootId: owner.bootId, controllerGeneration: 1,
            leaseOwner: owner.leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
          const root = scopedRunnerdStateRoot(execution);
          if (saved.readable || saved.unstartedFollowUps) {
            const core = new DurablePrpControlPlane({ stateDirectory: join(root, "saved-controller"), identity: priorIdentity,
              expectedRunnerVersion: "saved-build", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
            if (saved.unstartedFollowUps) {
              for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"])
                Object.assign(core.queueCommand(type), { status: "completed", result: { status: "completed" } });
              core.store.state.committedEvents.push({ sourceSeq: 1, sourceEventId: "held-terminal", eventType: "run.terminal",
                priority: 0, envelope: { ...priorIdentity }, deliveryCount: 1, logicalEffectCount: 1 });
              core.store.state.ackedSourceSeq = 1;
            }
            core.setCheckpointPersistence(nativeRunnerCheckpointWriter(db, owner));
            try { await core.flushCheckpoint(); } finally { await core.stop(); }
            // Fixture scratch is not a Runner root entry. The durable DB
            // checkpoint above remains available to the actual restore door.
            if (saved.unstartedFollowUps) rmSync(join(root, "saved-controller"), { recursive: true, force: true });
          }
          const [result] = await db.insert(nativeRunResults).values({ companyId: run!.companyId, issueId: execution.binding.issueId,
            runId: priorRunId, completionContractId: run!.completionContractId!, serverFingerprint: "saved-build",
            schemaStatus: "accepted", resultJson: {}, canonicalSha256: "saved-result" }).returning();
          await db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result!.id,
            leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, priorRunId));
          if (saved.unstartedFollowUps) {
            // Stop consumed no Pi turn. A later admission failure also owns only
            // the rebound pointer, not the held owner's settled session.
            for (const [index, status] of ["cancelled", "failed"].entries()) {
              const id = randomUUID();
              await db.insert(heartbeatRuns).values({ ...run!, id, status, startedAt: null,
                processPid: null, processGroupId: null, processStartedAt: null,
                createdAt: new Date(run!.createdAt.getTime() - 500 + index * 100),
                finishedAt: new Date(run!.createdAt.getTime() - 450 + index * 100),
                runnerProfileJson: { ...profile, sessionCheckpoint: { ...snapshot, cursor: null,
                  identity: { ...snapshot.identity, runId: id } } },
                resultJson: status === "failed" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null });
              if (status === "failed") await db.insert(nativeRunFinalizations).values({ companyId: run!.companyId,
                issueId: execution.binding.issueId, runId: id, phase: "terminal_failure" });
            }
            await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile,
              nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: `sha256:${"b".repeat(64)}`,
                processConfigDigest: null }, { runId: priorRunId, runnerInstanceId: run!.runnerInstanceId!,
                normalizedSessionId: run!.nativeSessionId! }) } }).where(eq(heartbeatRuns.id, priorRunId));
          }
          await db.insert(environments).values({ id: environmentId, name: `saved-${priorRunId}`, driver: "sandbox" });
          if (!saved.noLease) await db.insert(environmentLeases).values([
            { id: priorLeaseId, companyId: run!.companyId, environmentId, issueId: execution.binding.issueId, heartbeatRunId: priorRunId,
              provider: "daytona", providerLeaseId: "saved-sandbox", leasePolicy: "reuse_by_environment", status: "released",
              metadata: { remoteCwd: execution.workspace.cwd } },
            { companyId: run!.companyId, environmentId, issueId: execution.binding.issueId, heartbeatRunId: run!.id,
              provider: "daytona", providerLeaseId: "saved-sandbox", leasePolicy: "reuse_by_environment", status: "active",
              metadata: { remoteCwd: execution.workspace.cwd } },
          ]);
          if (saved.readable) {
            const backupRoot = join(root, "failover-backups", "current");
            for (const directory of resolveNativeHarnessPersistenceProfile(execution).directories)
              mkdirSync(join(backupRoot, directory.name), { recursive: true });
            const runnerState = { schema: "paperclip.runner.durable.state.v1", ...priorIdentity, lifecycle: "suspended", outbox: [] };
            const providerState = { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "prepared", threadId: "saved-thread",
              providerSessionId: "saved-provider", activeProviderTurnId: null, config: { provider: "pi_rpc", driver: "pi_rpc" } };
            const remoteRoot = join(execution.workspace.cwd!, ".paperclip-runtime", "paperclip-runner", "sessions",
              createHash("sha256").update(run!.nativeSessionId!).digest("hex"), "runner");
            mkdirSync(remoteRoot, { recursive: true });
            for (const directory of [join(backupRoot, "runner"), remoteRoot]) {
              writeFileSync(join(directory, "runner-state.json"), JSON.stringify(runnerState));
              writeFileSync(join(directory, "codex-provider-state.json"), JSON.stringify(providerState));
            }
            writeFileSync(join(backupRoot, "manifest.json"), JSON.stringify(buildNativeHarnessBackupManifest({
              backupRoot, execution, runnerInstanceId: run!.runnerInstanceId!, sourceProviderLeaseId: "saved-sandbox",
              providerSessionIdentity: { providerSessionId: "saved-thread", providerBackendSessionId: "saved-provider", providerSessionIdentity: null },
            })));
          }
          // The earlier retirement's 429 is historical: it must converge on
          // admission of this selected save, never start another retry owner.
          if (saved.retire429) {
            const retirement = await retirePiRunnerByFact({ identity: priorIdentity,
              read: async () => ({ runner: { ...priorIdentity, outbox: [] }, provider: { config: { provider: "pi_rpc" } } }),
              settle: async () => {}, collectStopped: async () => {}, recordProof: async () => {},
              stop: async () => { throw Object.assign(new Error("Boat retire returned 429"), { status: 429 }); },
            }).catch(error => error);
            expect(retirement).toMatchObject({ status: 429 });
            await db.update(heartbeatRuns).set({ error: retirement.message }).where(eq(heartbeatRuns.id, priorRunId));
          }
          await options.beforeRetirementFailure?.(run!.id, execution.binding.issueId);
          const restore = () => restoreNativeControllerProjections({ db, execution, sessionContinuity: "continuous",
            runnerExecutionTarget: { kind: "remote", transport: "sandbox", environmentId, leaseId: priorLeaseId,
              providerKey: "daytona", remoteCwd: execution.workspace.cwd,
              sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "saved-sandbox" },
              runner: { execute: async (request: { command: string; args?: string[] }) => {
                try { return { exitCode: 0, timedOut: false, stderr: "", stdout: execFileSync(request.command, request.args ?? [], { encoding: "utf8" }) }; }
                catch { return { exitCode: 1, timedOut: false, stderr: "", stdout: "" }; }
              } } } as never }, root);
          if (saved.stage === "metadata_format") {
            await restore();
            // This backend executes deterministic PRP, not Runnerd. The real
            // restore door has verified/materialized the selected controller;
            // do not leave its synthetic process-less projection as a live
            // Runner owner for the next deterministic turn.
            if (saved.unstartedFollowUps) rmSync(root, { recursive: true, force: true });
          }
          else {
            // The real first refusal happens after admission intent, but before
            // runner.process.launch. This must not be mistaken for provider work.
            await appendHeartbeatRunEvent(db, { companyId: run!.companyId, agentId: run!.agentId, runId: run!.id,
              eventType: PROCESS_START_REQUESTED, stream: "system", level: "info", message: "Admission requested before host preparation" });
            let selectedRunId: string = priorRunId;
            if (saved.unstartedFollowUps) {
              const selected = await resolveNativeControllerRecovery(db, { ...execution.binding,
                currentRunId: execution.binding.runId, normalizedSessionId: run!.nativeSessionId! });
              expect(selected.kind).toBe("recoverable");
              if (selected.kind !== "recoverable") throw new Error("settled held source was not selected");
              selectedRunId = selected.checkpoint.runId;
              expect(selectedRunId).toBe(priorRunId);
            }
            await admitNativeContinuationRefusal({ db, binding: execution.binding,
              refusal: new NativeContinuationAdmissionRefusalError(saved.stage, selectedRunId), providerLeaseId: "saved-sandbox",
              beforeProviderTurn: true, restoreSameSession: saved.readable ? restore : async () => false });
          }
        }
        const unretired = options.unretiredPredecessorOnce;
        if (unretired && (!unretired.failed || unretired.repeat)) {
          unretired.repeat?.push(execution.binding.runId);
          // Staging: this run resumed the task's reused sandbox, where
          // the previous run's warm Runner could not be retired before any
          // provider work. The executor reports that after its coordinator claim.
          unretired.failed = true;
          if (unretired.taskBlocked) await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, execution.binding.issueId));
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
          if (!unretired.noLease) await db.insert(environmentLeases).values({ companyId: run!.companyId, environmentId: unretired.environmentId,
            issueId: execution.binding.issueId, heartbeatRunId: run!.id, provider: "daytona", providerLeaseId: "sandbox-reused",
            leasePolicy: "reuse_by_environment", status: "active", metadata: { remoteCwd: "/workspace" } });
          await options.beforeRetirementFailure?.(run!.id, execution.binding.issueId);
          if (unretired.preDoorRunId) {
            // Real uncommitted predecessor row + missing local authority. Let
            // the actual pre-door restore branch, not a fabricated error,
            // choose the typed visible failure consumed by run completion.
            await db.insert(heartbeatRuns).values({ ...run!, id: unretired.preDoorRunId, status: "cancelled",
              startedAt: new Date(), finishedAt: new Date(), retryOfRunId: null });
            await db.insert(nativeRunFinalizations).values({ runId: unretired.preDoorRunId,
              companyId: run!.companyId, issueId: execution.binding.issueId, phase: "observed" });
            const root = scopedRunnerdStateRoot(execution);
            mkdirSync(join(root, "control-plane"), { recursive: true, mode: 0o700 });
            writeFileSync(join(root, "control-plane/control-plane-state.json"), JSON.stringify({
              schema: "paperclip.runner.durable.control-plane-state.v1", identity: {
                runId: unretired.preDoorRunId, normalizedSessionId: execution.session.normalizedSessionId,
                runnerInstanceId: "pre-door-prior-runner", environmentLeaseId: "pre-door-prior-lease" } }));
            const input = { db, execution, sessionContinuity: "continuous" as const,
              runnerExecutionTarget: { kind: "remote" as const, transport: "sandbox" as const, remoteCwd: "/workspace",
                sandboxLeaseAcquisition: { outcome: "resumed" as const, providerLeaseId: "sandbox-reused" } } };
            await restoreRemoteSuspendedRunnerCheckpoint(input, root); // Must defer to the door, not refuse here.
            await retireRefusedContinuousPiOwner(input, root, { runId: unretired.preDoorRunId,
              normalizedSessionId: execution.session.normalizedSessionId!, runnerInstanceId: "pre-door-prior-runner",
              environmentLeaseId: "pre-door-prior-lease", turnId: "prior-turn", itemId: "prior-item" });
            throw new Error("the door must not admit an uncommitted predecessor without exit proof");
          }
          throw new NativePredecessorRetirementUnprovenError("previous-run", "sandbox-reused",
            new Error("Controller journal drain timed out; preserve the session before replacing its writer."), unretired.freshSessionRequired);
        }
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Normal native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "native-predispatch-retry", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    const failure = options.admissionFailure;
    if (!failure) return backend;
    return Object.assign(backend, {
      providerTurnNeverIssued: () => failure.turnNeverIssued,
      providerAdmissionPersisted: async () => {
        if (failure.remaining <= 0) return;
        failure.remaining -= 1;
        const runId = execution.binding.runId;
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await db.insert(environmentLeases).values({ companyId: run!.companyId, environmentId: failure.environmentId,
          issueId: execution.binding.issueId, heartbeatRunId: runId, provider: failure.provider,
          providerLeaseId: `${failure.providerLeaseId}-${failure.failedRuns.length}`, leasePolicy: failure.leasePolicy,
          status: "active", metadata: { remoteCwd: "/workspace" } });
        failure.failedRuns.push(runId);
        const root = scopedRunnerdStateRoot(execution);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(join(root, "failed-attempt"), runId);
        failure.sessionRoots.push(root);
        throw new NativeProviderArtifactTransferTimeoutError("upload", 120_000, 512 * 1024 * 1024);
      },
    });
  };
}

describe.skipIf(!support.supported)("heartbeat native pre-dispatch failure retry", () => {
  const fixture = nativeRestartFixture({});

  async function startTask(db: ReturnType<typeof createDb>, heartbeat: ReturnType<typeof heartbeatService>,
    status: "in_progress" | "blocked" = "in_progress", provider = "codex") {
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ status: "idle", adapterConfig: { provider } }).where(eq(agents.id, agentId));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.insert(issues).values({ companyId, title: "Survive a database fault", status,
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active" }).returning();
    if (status === "blocked") {
      const [blocker] = await db.insert(issues).values({ companyId, title: "Open subtask", status: "todo" }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: issue!.id, type: "blocks" });
    }
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
      authorType: "user", authorUserId: userId, body: "Start." }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
      payload: { issueId: issue!.id, commentId: message!.id },
      contextSnapshot: { issueId: issue!.id, taskKey: issue!.id, wakeCommentId: message!.id } });
    expect(run).not.toBeNull();
    await waitForCondition("the first run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
    return { issueId: issue!.id, runId: run!.id };
  }

  it.each([
    { stage: "metadata_format", readable: true, noLease: false, unstartedFollowUps: true },
    { stage: "backup_without_reusable_lease", readable: false, noLease: false, unstartedFollowUps: true },
    { stage: "metadata_format", readable: true, noLease: false },
    { stage: "metadata_format", readable: true, noLease: false, failedSource: true },
    { stage: "backup_without_reusable_lease", readable: true, noLease: false },
    { stage: "metadata_format", readable: false, noLease: false },
    { stage: "backup_without_reusable_lease", readable: false, noLease: false },
    { stage: "metadata_format", readable: false, noLease: true },
    { stage: "backup_without_reusable_lease", readable: false, noLease: true },
    { stage: "metadata_format", readable: false, noLease: true, retire429: true },
    { stage: "backup_without_reusable_lease", readable: false, noLease: true, retire429: true },
  ] as const)("saved admission $stage readable=$readable noLease=$noLease retire429=$retire429 failedSource=$failedSource unstarted=$unstartedFollowUps answers once", async input => {
    const cell = { failedSource: false, unstartedFollowUps: false, ...input };
    const sameSession = cell.readable && !cell.failedSource;
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const saved = { ...cell, attempted: false, selectedSession: "", predecessorRunId: "" };
    const messages = new Map<string, string>();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { savedAdmission: saved, turnMessages: messages }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat, "in_progress", "pi_rpc");
      const [first] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(first!.status).toBe(sameSession ? "succeeded" : "failed");
      if (sameSession) expect(first!.nativeSessionId).toBe(saved.selectedSession);
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(successors).toHaveLength(sameSession ? 0 : 1);
      if (cell.unstartedFollowUps && !sameSession) expect(first!.resultJson?.predecessorRetirementFallback)
        .toMatchObject({ predecessorRunId: saved.predecessorRunId, freshSessionRequired: true });
      if (!sameSession) {
        expect(first!.resultJson).toMatchObject({ predecessorRetirementFallback: { freshSessionRequired: true,
          ...(cell.noLease ? { replacedProviderLeaseIds: [] } : {}) } });
        expect(successors[0]!.contextSnapshot?.explicitFreshSession).toBe(true);
        expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
        await heartbeat.resumeQueuedRuns();
        await waitForCondition("saved admission fresh continuation to answer", async () =>
          (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
        await waitForCondition("saved admission continuation to settle", () => heartbeat.getTaskDrainStatus().quiescent);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]!.nativeSessionId)
          .not.toBe(saved.selectedSession);
      }
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.filter(c => c.body === "Done.")).toHaveLength(1);
      expect(comments.filter(c => c.body === "New session" && c.conversationSessionGeneration != null)).toHaveLength(sameSession ? 0 : 1);
      expect(comments.filter(c => c.body.includes("The saved session could not be restored; continuing in a new session.")
        && c.body.includes(`/runs/${runId}`))).toHaveLength(sameSession ? 0 : 1);
      expect([...messages.values()]).toHaveLength(1);
      expect([...messages.values()][0]).toContain("Start.");
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).not.toBe("blocked");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 0 });
      if (cell.unstartedFollowUps) {
        const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
        const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
          authorUserId: issue!.conversationUserId!, body: "Second message after Stop." }).returning();
        const next = await heartbeat.wakeup(fixture.current.agentId, { source: "on_demand", triggerDetail: "manual",
          reason: "issue_commented", requestedByActorType: "user", requestedByActorId: issue!.conversationUserId!, manualUserWake: true,
          payload: { issueId, commentId: message!.id }, contextSnapshot: { issueId, taskKey: issueId, wakeCommentId: message!.id } });
        expect(next).not.toBeNull();
        await waitForCondition("second message after Stop to settle", () => heartbeat.getTaskDrainStatus().quiescent);
        const [answer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id));
        expect(answer!.status).toBe("succeeded");
        const [firstAnswer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sameSession ? runId : successors[0]!.id));
        expect(answer!.nativeSessionId).toBe(firstAnswer!.nativeSessionId);
        if (sameSession) expect(answer!.nativeSessionId).toBe(saved.selectedSession);
        const finalComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        expect(finalComments.filter(c => c.body === "Done.")).toHaveLength(2);
        expect(finalComments.filter(c => c.body === "New session" && c.conversationSessionGeneration != null)).toHaveLength(sameSession ? 0 : 1);
        expect(finalComments.filter(c => c.body.includes("could not be restored"))).toHaveLength(sameSession ? 0 : 1);
        expect(messages.size).toBe(2);
        expect(messages.get(next!.id)).toContain("Second message after Stop.");
        const taskRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, issueId));
        expect(taskRuns.filter(r => r.error?.includes("metadata_format"))).toHaveLength(0);
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).not.toBe("blocked");
        expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      }
    } finally {
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    }
  }, 90_000);

  it("keeps the fresh-session notice and answers once with no reusable lease", async () => {
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const messages = new Map<string, string>();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, {
      unretiredPredecessorOnce: { failed: false, environmentId: randomUUID(), freshSessionRequired: true, noLease: true },
      turnMessages: messages,
    }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat, "in_progress", "pi_rpc");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.filter(c => c.body === "New session" && c.conversationSessionGeneration != null)).toHaveLength(1);
      expect(comments.filter(c => c.body.includes("could not be restored") && c.body.includes(runId))).toHaveLength(1);
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(successors).toHaveLength(1);
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("no-lease fresh continuation to answer", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("no-lease continuation to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(messages.size).toBe(1);
      expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(c => c.body === "Done.")).toHaveLength(1);
    } finally {
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    }
  }, 90_000);

  it("re-queues a native run that failed at budget admission and completes it without a Retry", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db) });
    try {
      admissionFaults.remaining = 1;
      const { issueId, runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native", errorCode: "adapter_failed",
        resultJson: expect.objectContaining({ failureCause: "40001",
          nativePreDispatchFailure: { version: 1, providerWorkStarted: false } }) });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation",
        scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).not.toBe("blocked");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      // The first attempt is due at once; the scheduler promotes it and the
      // queue starts it, exactly once.
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)))).toHaveLength(1);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    } finally {
      admissionFaults.remaining = 0;
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it.each([{ freshSessionRequired: false, preDoor: false }, { freshSessionRequired: true, preDoor: false },
    { freshSessionRequired: true, preDoor: true }])("re-queues an unretired predecessor onto a fresh sandbox (fresh session = $freshSessionRequired, pre-door absent authority = $preDoor)", async ({ freshSessionRequired, preDoor }) => {
    const { companyId } = fixture.current;
    const predecessorRunId = preDoor ? randomUUID() : "previous-run";
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id, freshSessionRequired,
        ...(preDoor ? { preDoorRunId: predecessorRunId } : {}) } }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat, "in_progress", freshSessionRequired ? "pi_rpc" : "codex");
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native", errorCode: "adapter_failed",
        resultJson: expect.objectContaining({ failureCause: "native_predecessor_retirement_unproven",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          predecessorRetirementFallback: expect.objectContaining({ version: 1, providerWorkStarted: false,
            predecessorRunId, replacedProviderLeaseIds: ["sandbox-reused"] }) }) });
      // The reused sandbox is replaced at the next acquisition, not resumed.
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, "sandbox-reused")));
      expect(lease?.metadata).toMatchObject({ replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId,
        predecessorRunId } });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
        eq(activityLog.action, "environment.lease_replacement_requested")))).toHaveLength(1);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.filter(c => c.conversationSessionGeneration != null)).toHaveLength(freshSessionRequired ? 1 : 0);
      expect(comments.filter(c => c.body.includes("could not be restored"))).toHaveLength(freshSessionRequired ? 1 : 0);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      if (freshSessionRequired) expect(successors[0]!.contextSnapshot?.explicitFreshSession).toBe(true);
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).not.toBe("blocked");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id));
      if (freshSessionRequired) expect(finished!.nativeSessionId).not.toBe(failed!.nativeSessionId);
      expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(c => c.body === "Done.")).toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issueId))).filter(r => r.status === "failed")).toHaveLength(1);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      if (preDoor) {
        const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
        const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
          authorUserId: issue!.conversationUserId!, body: "Next message after fresh recovery." }).returning();
        const next = await heartbeat.wakeup(fixture.current.agentId, { source: "on_demand", triggerDetail: "manual",
          reason: "issue_commented", requestedByActorType: "user", requestedByActorId: issue!.conversationUserId!, manualUserWake: true,
          payload: { issueId, commentId: message!.id }, contextSnapshot: { issueId, taskKey: issueId, wakeCommentId: message!.id } });
        expect(next).not.toBeNull();
        await waitForCondition("next message after fresh recovery to settle", () => heartbeat.getTaskDrainStatus().quiescent);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id)))[0]?.status).toBe("succeeded");
        const finalComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        expect(finalComments.filter(c => c.body === "Done.")).toHaveLength(2);
        expect(finalComments.filter(c => c.conversationSessionGeneration != null)).toHaveLength(1);
        expect(finalComments.filter(c => c.body.includes("could not be restored"))).toHaveLength(1);
      }
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  // Never-OK: cleanup failure must not hide a continuity break; task FK key-share locks must not deadlock its notice.
  it.each(["retirement", "metadata_format", "backup_without_reusable_lease"] as const)("writes a visible $stage fresh-session failure despite coordinator-close failure while a task key-share lock is held", async stage => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `close-fault-${randomUUID()}`, driver: "sandbox" }).returning();
    const name = `retirement_close_${randomUUID().replaceAll("-", "")}`;
    const release = Promise.withResolvers<void>(), acquired = Promise.withResolvers<void>();
    let keyShare: Promise<unknown> | undefined, noticeObservation: Promise<unknown> | undefined, triggered = false;
    let noticeError: unknown;
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, {
      ...(stage === "retirement" ? { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id, freshSessionRequired: true } }
        : { savedAdmission: { attempted: false, stage, readable: false, noLease: true } }),
      beforeRetirementFailure: async (runId, issueId) => {
        await db.$client.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.run_id = '${runId}'::uuid AND NEW.phase = 'terminal_failure' AND NEW.failure_code = 'native_pre_dispatch_failure'
          THEN RAISE EXCEPTION 'injected coordinator-close failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER ${name} BEFORE UPDATE ON native_run_finalizations FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        triggered = true;
        keyShare = db.transaction(async tx => {
          await tx.execute(sql`select id from issues where id = ${issueId} for key share`);
          acquired.resolve(); await release.promise;
        });
        await acquired.promise;
        // The remainder of stock failure cleanup can need a stronger lock;
        // retain KEY SHARE only until this marker transaction finishes.
        noticeObservation = waitForCondition("notice to commit under KEY SHARE", async () =>
          (await db.select().from(issueComments).where(eq(issueComments.createdByRunId, runId)))
            .some(comment => comment.conversationSessionGeneration != null), 5_000)
          .catch(error => { noticeError = error; }).finally(() => release.resolve());
      },
    }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat, "in_progress", "pi_rpc");
      await noticeObservation; expect(noticeError).toBeUndefined();
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.filter(c => c.conversationSessionGeneration != null)).toHaveLength(1);
      expect(comments.filter(c => c.body.includes("could not be restored") && c.body.includes(runId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId), eq(activityLog.action, "issue.comment_added"))))
        .toHaveLength(2);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "failed" });
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId))))
        .toHaveLength(0);
    } finally {
      release.resolve(); await keyShare; await noticeObservation;
      if (triggered) await db.$client.unsafe(`DROP TRIGGER ${name} ON native_run_finalizations; DROP FUNCTION ${name}()`);
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    }
  }, 90_000);

  it("stops retrying with a truthful failure when the next attempt met the same unretired sandbox instead of a fresh one", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const attempts: string[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id, repeat: attempts } }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      const [first] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(first).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 });
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the second attempt to end", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id)))[0]?.status === "failed");
      await waitForCondition("the second attempt to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(attempts).toEqual([runId, first!.id]);
      const [second] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
      expect(second?.resultJson ?? {}).not.toHaveProperty("predecessorRetirementFallback");
      expect(second?.error ?? "").not.toMatch(/fresh sandbox/i);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, first!.id)))).toHaveLength(0);
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 0 });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ canRetry: true });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it.each([
    { title: "continues a follow-up on a blocked task whose predecessor could not be retired", blockedAfter: false },
    { title: "does not continue a task that was blocked only after its run failed", blockedAfter: true },
  ])("$title", async ({ blockedAfter }) => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id, taskBlocked: !blockedAfter } }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat, blockedAfter ? "in_progress" : "blocked");
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", resultJson: expect.objectContaining({
        failureCause: "native_predecessor_retirement_unproven",
        predecessorRetirementFallback: expect.objectContaining({ issueStatusAtFailure: blockedAfter ? "in_progress" : "blocked" }) }) });
      if (blockedAfter) await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task?.status).toBe("blocked");
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry", scheduledRetryReason: "interrupted_preparation" })]);
      expect(await taskInterruptionPresentation(db, task!)).toMatchObject({ state: "working", canRetry: false });
      if (blockedAfter) {
        await heartbeat.promoteDueScheduledRetries();
        await heartbeat.resumeQueuedRuns();
        await waitForCondition("the stale retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
        const [stale] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id));
        expect(["cancelled", "scheduled_retry"]).toContain(stale?.status);
        return;
      }
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [retried] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id));
      expect({ status: retried?.status, errorCode: retried?.errorCode, error: retried?.error }).toEqual({ status: "succeeded", errorCode: null, error: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("delivers the monitor check to the automatic retry of a monitor run that failed before provider work", async () => {
    const { companyId, agentId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const turnMessages = new Map<string, string>();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id }, turnMessages }) });
    try {
      await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      const [issue] = await db.insert(issues).values({ companyId, title: "Phase 2 on the monitor check", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, monitorNotes: "Phase 2 check" }).returning();
      const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_monitor_due",
        payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, taskKey: issue!.id,
          source: "issue.monitor", wakeReason: "issue_monitor_due", monitorNotes: "Phase 2 check" } });
      expect(run).not.toBeNull();
      await waitForCondition("the monitor run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(failed).toMatchObject({ status: "failed", resultJson: expect.objectContaining({
        failureCause: "native_predecessor_retirement_unproven" }) });
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, run!.id)));
      expect(successor).toMatchObject({ scheduledRetryReason: "interrupted_preparation" });

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to start its provider turn", () => turnMessages.has(successor!.id));
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [retried] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id));
      const continuation = retried!.contextSnapshot?.executionContinuation as ExecutionContinuationEnvelope;
      expect(continuation.trigger).toMatchObject({ sourceRunId: run!.id, retriedReason: "issue_monitor_due" });
      expect(renderPaperclipWakePrompt(retried!.contextSnapshot?.paperclipWake)).toContain("- retried wake: issue_monitor_due");
      expect(turnMessages.get(successor!.id)).toContain("- retried wake: issue_monitor_due");
      expect(turnMessages.has(run!.id)).toBe(false);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it.each([
    { target: "remote sandbox", provider: "e2b", leasePolicy: "reuse_by_execution_workspace" as const },
    { target: "plugin-task sandbox", provider: "daytona", leasePolicy: "reuse_by_environment" as const },
  ])("continues on a fresh $target when the provider artifacts fail to save before any turn", async ({ provider, leasePolicy }) => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const turnMessages = new Map<string, string>();
    const failure: AdmissionFailure = { remaining: 1, turnNeverIssued: true, environmentId: environment!.id, provider,
      providerLeaseId: `sandbox-${provider}`, leasePolicy, failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure, turnMessages }) });
    const warn = vi.spyOn(logger, "warn");
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      expect(failure.failedRuns).toEqual([runId]);
      expect(warn.mock.calls.filter(([, message]) => typeof message === "string" && message.includes("could not be marked workspace_failed")))
        .toEqual([]);
      expect(turnMessages.has(runId)).toBe(false);
      expect(existsSync(failure.sessionRoots[0]!)).toBe(false);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native",
        resultJson: expect.objectContaining({ failureCause: "native_failed_before_provider_turn",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          predecessorRetirementFallback: expect.objectContaining({ version: 1, providerWorkStarted: false,
            predecessorRunId: null, replacedProviderLeaseIds: [`sandbox-${provider}-0`] }) }) });
      expect(failed!.error).toBe("Setting up the computer took too long, so the task is continuing on a fresh one.");
      expect(failed!.error).not.toMatch(/[a-z0-9]+_[a-z0-9_]+|\d|\(|\)/i);
      expect(failed!.runnerProfileJson).toMatchObject({ failedBeforeProviderTurn: {
        cause: "native_failed_before_provider_turn", technicalCause: "native_provider_artifacts_transfer_timeout" } });
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, `sandbox-${provider}-0`)));
      expect(lease?.metadata).toMatchObject({ replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId } });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue!.status).not.toBe("blocked");
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "working", canRetry: false });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the continuation to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the continuation to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(turnMessages.has(successors[0]!.id)).toBe(true);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)))).toHaveLength(1);
      const [settled] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, settled!)).toMatchObject({ state: "resolved", canRetry: false });
    } finally {
      warn.mockRestore();
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("keeps today's ambiguous hold when the Runner ledger cannot prove no turn was sent", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const failure: AdmissionFailure = { remaining: 1, turnNeverIssued: false, environmentId: environment!.id, provider: "daytona",
      providerLeaseId: "sandbox-turn-maybe-sent", leasePolicy: "reuse_by_environment", failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure }) });
    try {
      const { runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed?.status).toBe("failed");
      expect(failed?.resultJson ?? {}).not.toHaveProperty("predecessorRetirementFallback");
      expect(failed?.resultJson?.failureCause).not.toBe("native_failed_before_provider_turn");
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, "sandbox-turn-maybe-sent-0")));
      expect(lease?.metadata ?? {}).not.toHaveProperty("replaceBeforeReuse");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.scheduledRetryReason, "interrupted_preparation")))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("backs off a lasting pre-turn failure and stops at the shared lane cap without hammering", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const failure: AdmissionFailure = { remaining: Number.POSITIVE_INFINITY, turnNeverIssued: true, environmentId: environment!.id,
      provider: "daytona", providerLeaseId: "sandbox-lasting", leasePolicy: "reuse_by_environment", failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure }) });
    const successorOf = async (runId: string) => (await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId))));
    const runToEnd = async (runId: string) => {
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the attempt to end", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status === "failed");
      await waitForCondition("the attempt to settle", () => heartbeat.getTaskDrainStatus().quiescent);
    };
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      const [first] = await successorOf(runId);
      expect(first).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 });
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([first!.id]);
      const secondStartedAt = Date.now();
      await runToEnd(first!.id);
      const [second] = await successorOf(first!.id);
      expect(second).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 2 });
      expect(second!.scheduledRetryAt!.getTime() - secondStartedAt).toBeGreaterThanOrEqual(15_000);
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).not.toContain(second!.id);
      expect(failure.failedRuns).toHaveLength(2);
      const [waiting] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, waiting!)).toMatchObject({ state: "working", canRetry: false });

      await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 12, scheduledRetryAt: new Date(Date.now() - 1_000),
        contextSnapshot: { ...second!.contextSnapshot, executionRetryAccounting: {
          ...(second!.contextSnapshot?.executionRetryAccounting as Record<string, unknown>), interruptedPreparations: 12 } } })
        .where(eq(heartbeatRuns.id, second!.id));
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([second!.id]);
      await runToEnd(second!.id);
      expect(await successorOf(second!.id)).toHaveLength(0);
      expect(failure.failedRuns).toHaveLength(3);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "failed", canRetry: true });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 120_000);

  it("keeps the hold when the failure follows entry into the native executor", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { failDescriptorOnce: { failed: false } }) });
    try {
      const { runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed?.status).toBe("failed");
      expect(failed?.resultJson ?? {}).not.toHaveProperty("nativePreDispatchFailure");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.scheduledRetryReason, "interrupted_preparation")))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);
});
