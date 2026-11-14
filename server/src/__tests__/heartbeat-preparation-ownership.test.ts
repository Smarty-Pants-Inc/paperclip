import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issueComments,
  issueRecoveryActions, issues } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { preparationConnectionLost, settlePreparationFailureWithFreshConnection } from "../services/heartbeat/run-completion.js";
import { isTransientWorkspacePreparationCode } from "../services/heartbeat/retries.js";
import { assertClaimedRuntimeAdapterCompatible } from "../services/native-runtime/runtime-mode.js";
import { currentControllerProcess } from "../services/controller-process-identity.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// Fault injection at the actual pre-selection fresh-workspace readiness read,
// not at a fake queue/executor. Queue admission and all persistence stay real.
const faults = vi.hoisted(() => ({ kind: "none", entered: false, killAfterTerminalWrite: false, terminalWriteKilled: false }));
vi.mock("../services/heartbeat/run-lifecycle.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/run-lifecycle.js")>();
  return { ...actual, createHeartbeatLifecycle: (...args: Parameters<typeof actual.createHeartbeatLifecycle>) => {
    const owner = actual.createHeartbeatLifecycle(...args);
    return { ...owner, setRunStatusIfRunning: async (...writeArgs: Parameters<typeof owner.setRunStatusIfRunning>) => {
      const result = await owner.setRunStatusIfRunning(...writeArgs);
      if (faults.killAfterTerminalWrite && !faults.terminalWriteKilled && writeArgs[2]?.errorCode === "setup_connection_lost" && result.updated) {
        faults.terminalWriteKilled = true;
        // F3: a committed terminal write followed by a real lost fresh backend.
        // The next fresh attempt must resume claim/note/lease settlement.
        await args[0].execute(sql`select pg_terminate_backend(pg_backend_pid())`);
      }
      return result;
    } };
  } };
});
vi.mock("../services/fresh-workspace-continuation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/fresh-workspace-continuation.js")>();
  return { ...actual, readFreshWorkspaceReadiness: async (...args: Parameters<typeof actual.readFreshWorkspaceReadiness>) => {
    const result = await actual.readFreshWorkspaceReadiness(...args);
    if (args[1].contextSnapshot?.freshContinuationIsolation) {
      faults.entered = true;
      if (faults.kind === "connection") await args[0].execute(sql`select pg_sleep(30) /* d11c-preparation */`);
    }
    return result;
  } };
});
vi.mock("../services/legacy-controller-lease.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/legacy-controller-lease.js")>();
  return { ...actual, legacyControllerClaim: (...args: Parameters<typeof actual.legacyControllerClaim>) => ({
    ...actual.legacyControllerClaim(...args),
    ...(faults.kind === "foreign" ? { controllerBootId: "00000000-0000-4000-8000-000000000001" } : {}),
    ...(faults.kind === "foreign-live" ? { controllerBootId: "00000000-0000-4000-8000-000000000002",
      controllerProcess: { ...actual.legacyControllerClaim(...args).controllerProcess,
        bootId: "00000000-0000-4000-8000-000000000002" } } : {}),
    ...(faults.kind === "mode" ? { runtimeModeResolvedAt: new Date(), runtimeModeReason: "persisted_legacy_selection" } : {}),
  }) };
});

const support = await getRecoveryPostgresSupport({});
async function until(description: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) { if (await check()) return; await sleep(10); }
  throw new Error(`Timed out waiting for ${description}`);
}
function completingBackend(db: ReturnType<typeof createDb>): NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    let turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity, capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn: async () => { const turnId = randomUUID(); turn.resolve(turnId); return { turnId }; },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Recovered normally." });
        turn = Promise.withResolvers<string>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "preparation-deadline-session", identity,
        providerSessionId: "preparation-deadline-provider", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Normal native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "preparation-deadline", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    return backend;
  };
}

describe.skipIf(!support.supported)("D11 preparation ownership and database failure", () => {
  const fixture = nativeRestartFixture({});
  async function restoredTask(db: ReturnType<typeof createDb>, heartbeat: ReturnType<typeof heartbeatService>) {
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.insert(issues).values({ companyId, title: "Continue after recovery", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active" }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
      authorType: "user", authorUserId: userId, body: "Please continue my daily task." }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id,
      invocationSource: "on_demand", status: "failed", errorCode: "process_lost", finishedAt: new Date(),
      contextSnapshot: { issueId: issue!.id, wakeCommentId: message!.id } }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue!.id,
      kind: "active_run_watchdog", status: "resolved", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "process_lost", fingerprint: randomUUID(), nextAction: "Continue the task", outcome: "restored",
      evidence: { continuationDelivery: "pending", executionReconciliation: { runId: source!.id,
        providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "No provider process started." },
        freshContinuation: { isolation: "fresh_isolated_workspace", sourceRunId: source!.id } } }).returning();
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id));
    expect(run).toBeDefined();
    expect(run!.contextSnapshot).toMatchObject({ wakeReason: "issue_recovery_action_restored", source: "execution.reconciled",
      forceFreshSession: true, freshContinuationIsolation: action!.id });
    return { issueId: issue!.id, messageId: message!.id, runId: run!.id };
  }

  async function runFailure(kind: "connection" | "foreign" | "mode", code: string, killAfterTerminalWrite = false) {
    const applicationName = `d11c-${randomUUID()}`;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4, applicationName });
    const admin = createDb(fixture.current.temporary.connectionString, { maxConnections: 1 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
    faults.kind = kind; faults.entered = false;
    faults.killAfterTerminalWrite = killAfterTerminalWrite; faults.terminalWriteKilled = false;
    let killed = 0;
    const began = performance.now();
    try {
      const { runId, issueId, messageId } = await restoredTask(db, heartbeat);
      if (kind === "connection") {
        await until("preparation query on a real pooled backend", async () => {
          const rows = await admin.execute<{ pid: number }>(sql`select pid from pg_stat_activity
            where application_name = ${applicationName} and query like '%d11c-preparation%' and state = 'active'`);
          if (!rows.length) return false;
          const result = await admin.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity
            where application_name = ${applicationName} and pid <> pg_backend_pid()`);
          killed = result.length;
          return true;
        });
        expect(killed).toBeGreaterThan(0);
      }
      await until(`named ${code}`, async () => {
        const [run] = await admin.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return run?.status === "failed" && run.errorCode === code;
      }, 15_000);
      await heartbeat.drainActiveRunExecutions();
      const [run] = await admin.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [issue] = await admin.select().from(issues).where(eq(issues.id, issueId));
      const [agent] = await admin.select().from(agents).where(eq(agents.id, run!.agentId));
      expect(agent!.status).not.toBe("running");
      expect(run!.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(issue!.checkoutRunId).toBeNull();
      expect(issue!.executionRunId).not.toBe(runId);
      // Paperclip's bounded retry owner transfers the execution claim atomically
      // to its durable scheduled successor; that is not an orphaned failed claim.
      if (issue!.executionRunId) {
        const [successor] = await admin.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, issue!.executionRunId));
        expect(successor).toMatchObject({ status: "scheduled_retry", retryOfRunId: runId });
        expect(successor!.scheduledRetryAt).toBeInstanceOf(Date);
      } else {
        expect(issue).toMatchObject({ executionLockedAt: null, executionAgentNameKey: null });
      }
      if (kind === "mode") expect(faults.entered).toBe(false);
      const notes = () => admin.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
      await until("one existing-owner unanswered note", async () => (await notes()).length === 1);
      await settleUnansweredPersonMessage(admin, { companyId: fixture.current.companyId, issueId });
      expect(await notes()).toHaveLength(1);
      expect(faults.terminalWriteKilled).toBe(killAfterTerminalWrite);
      expect(performance.now() - began).toBeLessThan(15_000);
      console.info("d11c-failure-proof", JSON.stringify({ kind, runId, status: run!.status, errorCode: run!.errorCode,
        elapsedMs: performance.now() - began, killed, terminalWriteKilled: faults.terminalWriteKilled,
        releasedRunId: runId, successorClaim: issue!.executionRunId,
        resultJson: run!.resultJson, note: (await notes())[0]!.body }));
    } finally {
      faults.kind = "none"; faults.killAfterTerminalWrite = false;
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end(); await admin.$client.end();
    }
  }
  it("recognizes wrapped driver disconnect codes and keeps named setup losses retry-eligible", () => {
    for (const code of ["ECONNRESET", "57P01", "08006", "CONNECTION_CLOSED"]) {
      expect(preparationConnectionLost({ cause: { code } })).toBe(true);
    }
    expect(preparationConnectionLost(new Error("ECONNRESET in untrusted prose"))).toBe(false);
    expect(preparationConnectionLost({ code: "42P01" })).toBe(false);
    expect(isTransientWorkspacePreparationCode("setup_connection_lost")).toBe(true);
    expect(isTransientWorkspacePreparationCode("setup_owner_lost")).toBe(true);
    expect(isTransientWorkspacePreparationCode("runtime_mode_adapter_incompatible")).toBe(false);
  });
  it("checks both persisted-mode mismatches without rejecting the unresolved queue default", () => {
    expect(() => assertClaimedRuntimeAdapterCompatible({ runtimeMode: "native", runtimeModeResolvedAt: new Date() }, "process"))
      .toThrow(expect.objectContaining({ code: "runtime_mode_adapter_incompatible" }));
    expect(() => assertClaimedRuntimeAdapterCompatible({ runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }, "paperclip_runner"))
      .toThrow(expect.objectContaining({ code: "runtime_mode_adapter_incompatible" }));
    expect(() => assertClaimedRuntimeAdapterCompatible({ runtimeMode: "legacy", runtimeModeResolvedAt: null }, "paperclip_runner")).not.toThrow();
    expect(() => assertClaimedRuntimeAdapterCompatible({ runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }, "process")).not.toThrow();
  });
  it("bounds fresh settlement to three logged attempts and closes every new pool", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    const { companyId, agentId } = fixture.current;
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "failed" }).returning();
    const backendPids: number[] = [];
    const began = performance.now();
    try {
      await expect(settlePreparationFailureWithFreshConnection(db, { run: run!, runId: run!.id,
        outerErr: Object.assign(new Error("lost setup connection"), { code: "ECONNRESET" }), signal: new AbortController().signal,
        providerDispatchStarted: false, nativeDispatchMayHaveStarted: false,
        identityRedactor: { redact: value => value }, readFailureReportSecrets: () => [],
      }, async fresh => {
        const [backend] = await fresh.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        backendPids.push(backend!.pid);
        throw Object.assign(new Error("settlement connection unavailable"), { code: "08006" });
      })).rejects.toMatchObject({ code: "08006" });
      expect(backendPids).toHaveLength(3);
      expect(new Set(backendPids).size).toBe(3);
      expect(performance.now() - began).toBeLessThan(10_000);
      const held = await db.execute(sql`select pid from pg_stat_activity where pid in (${sql.join(backendPids.map(pid => sql`${pid}`), sql`, `)})`);
      expect(held).toHaveLength(0);
      console.info("d11c-bounded-settlement-proof", JSON.stringify({ attempts: backendPids.length, distinctFreshBackends: new Set(backendPids).size,
        remainingBackends: held.length, elapsedMs: performance.now() - began }));
    } finally { await db.$client.end(); }
  }, 15_000);
  it("fails a killed pooled preparation connection promptly, releases the claim and posts one note", async () => {
    await runFailure("connection", "setup_connection_lost");
  }, 45_000);
  it("resumes settlement on another fresh connection after the terminal write's backend dies", async () => {
    await runFailure("connection", "setup_connection_lost", true);
  }, 45_000);
  it("does not silently drop preparation owned by an unprovable foreign controller", async () => {
    await runFailure("foreign", "setup_owner_lost");
  }, 45_000);
  it("only logs when a foreign controller is provably alive", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
    const warnings = vi.spyOn(logger, "warn");
    let runId: string | undefined;
    try {
      await currentControllerProcess(); // Populate the OS start-time identity.
      faults.kind = "foreign-live"; faults.entered = false;
      const task = await restoredTask(db, heartbeat); runId = task.runId;
      await heartbeat.drainActiveRunExecutions();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run!.status).toBe("running");
      expect(faults.entered).toBe(false);
      expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ runId, ownerVerdict: "alive",
        ownerBootId: "00000000-0000-4000-8000-000000000002", ownerProcess: expect.any(Object), ourBootId: expect.any(String) }),
        "run preparation belongs to a foreign controller");
      expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, task.issueId), eq(issueComments.authorType, "system")))).toHaveLength(0);
      console.info("d11c-foreign-live-proof", JSON.stringify({ runId, status: run!.status, unchanged: true, warning: true, notes: 0 }));
    } finally {
      warnings.mockRestore(); faults.kind = "none";
      if (runId) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    }
  }, 30_000);
  it("rejects a persisted legacy mode on the native-only adapter before workspace preparation", async () => {
    await runFailure("mode", "runtime_mode_adapter_incompatible");
  }, 45_000);
  it("renews a real preparing controller, preserves it while live, and sweeps it after SIGKILL", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Real preparing owner", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id, invocationSource: "on_demand", responsibleUserId: userId,
      status: "running", executionStage: "preparing", startedAt: new Date(), contextSnapshot: { issueId: issue!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issue!.id));
    const applicationName = `d11c-owner-${randomUUID()}`;
    const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), fileURLToPath(new URL("./helpers/preparation-controller-child.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.stdin.end(JSON.stringify({ connectionString: fixture.current.temporary.connectionString, runId: run!.id, applicationName }));
    const heartbeat = heartbeatService(db);
    try {
      await until("real child preparing query", async () => {
        if (child.exitCode !== null) throw new Error(`Preparation child exited: ${output}`);
        return (await db.execute(sql`select pid from pg_stat_activity where application_name = ${applicationName}
          and query like '%d11c-owner-preparing%' and state = 'active'`)).length > 0;
      }, 15_000);
      const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      await until("live preparation lease renewal", async () => {
        const [renewed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
        return renewed!.controllerLeaseExpiresAt!.getTime() > claimed!.controllerLeaseExpiresAt!.getTime() + 5_000;
      }, 15_000);
      expect((await heartbeat.reapOrphanedRuns({ staleThresholdMs: 300_000 })).runIds).not.toContain(run!.id);
      child.kill("SIGKILL");
      await exited;
      const diedAt = performance.now();
      const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 300_000 });
      expect(reaped.runIds).toContain(run!.id);
      const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(settled).toMatchObject({ status: "failed", errorCode: "process_lost" });
      expect(performance.now() - diedAt).toBeLessThan(90_000);
      console.info("d11c-real-owner-proof", JSON.stringify({ runId: run!.id, pid: child.pid,
        renewed: true, alivePreserved: true, signal: child.signalCode, detectionMs: performance.now() - diedAt, status: settled!.status }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${applicationName}`);
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    }
  }, 60_000);
  it("uses the existing sweep for an expired preparing lease even from this boot, without a five-minute age wait", async () => {
    const db = createDb(fixture.current.temporary.connectionString);
    const { legacyControllerBootId } = await import("../services/legacy-controller-lease.js");
    const { companyId, agentId } = fixture.current;
    const [issue] = await db.insert(issues).values({ companyId, title: "Owner died during preparation", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: issue!.id, invocationSource: "on_demand", status: "running",
      executionStage: "preparing", controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() - 25_000), startedAt: new Date(Date.now() - 85_000), updatedAt: new Date(),
      contextSnapshot: { issueId: issue!.id } }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issue!.id));
    const heartbeat = heartbeatService(db);
    try {
      const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 300_000 });
      expect(reaped.runIds).toContain(run!.id);
      const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(settled).toMatchObject({ status: "failed", errorCode: "process_lost" });
      console.info("d11c-sweep-proof", JSON.stringify({ runId: run!.id, status: settled!.status, code: settled!.errorCode, ageMs: 85_000 }));
    } finally { await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end(); }
  }, 30_000);
});
