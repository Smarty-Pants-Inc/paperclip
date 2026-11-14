import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
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
const readinessFault = vi.hoisted(() => ({ entered: false, release: undefined as (() => void) | undefined,
  stall: false, observedMode: "" }));
vi.mock("../services/fresh-workspace-continuation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/fresh-workspace-continuation.js")>();
  return { ...actual, readFreshWorkspaceReadiness: async (...args: Parameters<typeof actual.readFreshWorkspaceReadiness>) => {
    const readiness = await actual.readFreshWorkspaceReadiness(...args);
    if (readinessFault.stall && args[1].contextSnapshot?.freshContinuationIsolation) {
      readinessFault.observedMode = readiness?.mode ?? "missing";
      readinessFault.entered = true;
      await new Promise<void>(resolve => { readinessFault.release = resolve; setTimeout(resolve, 50_000); }); // JUDGE: slow (50 s) but COMPLETES
    }
    return readiness;
  } };
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

describe.skipIf(!support.supported)("claimed recovery run preparation deadline", () => {
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

  // JUDGE (RFL D11): a legitimate preparation step that takes 50 s and then
  // RETURNS NORMALLY. Not a hang. Records what happens to the run; asserts only
  // that it settles, so the same bytes run on base and on head.
  it("JUDGE: a readiness phase that takes 50 s and then completes", async () => {
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
    const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    readinessFault.stall = true;
    readinessFault.entered = false;
    try {
      const { runId, issueId } = await restoredTask(db, heartbeat);
      await until("real readiness phase", () => readinessFault.entered);
      const end = performance.now() + 110_000;
      while (performance.now() < end && ["queued", "running"].includes((await readRun(runId)).status)) await sleep(250);
      await sleep(1_500);
      const run = await readRun(runId);
      const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const receipt = { commit: process.env.JUDGE_COMMIT, slowPhaseMs: 50_000, runId, status: run.status, errorCode: run.errorCode, error: run.error,
        claimToTerminalMs: run.finishedAt && run.startedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
        preparation: (run.resultJson as Record<string, unknown> | null)?.preparation ?? null,
        executionRunId: issue?.executionRunId ?? null, systemNotes: notes.map(note => note.body) };
      writeFileSync(process.env.JUDGE_RECEIPT!, JSON.stringify(receipt, null, 2));
      console.info("judge-slow-prep", JSON.stringify(receipt));
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain(run.status);
    } finally {
      readinessFault.stall = false;
      readinessFault.release?.();
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 170_000);
});
