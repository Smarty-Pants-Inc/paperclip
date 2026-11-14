import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issueComments,
  issueRecoveryActions, issues } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// Fault injection at the actual pre-selection fresh-workspace readiness read,
// not at a fake queue/executor. Queue admission and all persistence stay real.
const faults = vi.hoisted(() => ({ kind: "none", entered: false }));
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

  async function runFailure(kind: "connection" | "foreign" | "mode", code: string) {
    const applicationName = `d11c-${randomUUID()}`;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4, applicationName });
    const admin = createDb(fixture.current.temporary.connectionString, { maxConnections: 1 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
    faults.kind = kind; faults.entered = false;
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
      expect(run!.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(issue).toMatchObject({ executionRunId: null, checkoutRunId: null, executionLockedAt: null, executionAgentNameKey: null });
      if (kind === "mode") expect(faults.entered).toBe(false);
      const notes = () => admin.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
      await until("one existing-owner unanswered note", async () => (await notes()).length === 1);
      await settleUnansweredPersonMessage(admin, { companyId: fixture.current.companyId, issueId, messageId });
      expect(await notes()).toHaveLength(1);
      console.info("d11c-failure-proof", JSON.stringify({ kind, runId, status: run!.status, errorCode: run!.errorCode,
        elapsedMs: performance.now() - began, killed, resultJson: run!.resultJson, note: (await notes())[0]!.body }));
    } finally {
      faults.kind = "none";
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end(); await admin.$client.end();
    }
  }
  it("fails a killed pooled preparation connection promptly, releases the claim and posts one note", async () => {
    await runFailure("connection", "setup_connection_lost");
  }, 45_000);
  it("does not silently drop preparation owned by an unprovable foreign controller", async () => {
    await runFailure("foreign", "setup_owner_lost");
  }, 45_000);
  it("rejects a persisted legacy mode on the native-only adapter before workspace preparation", async () => {
    await runFailure("mode", "runtime_mode_adapter_incompatible");
  }, 45_000);
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
