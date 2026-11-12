import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// Keep reason: the reported cross-issue chat delay came from admission behind
// another run of the same agent. Exercise the real DB, wake queue, claims and
// native executor; the injected backend holds turns without a paid provider.
// This does not qualify a sandbox, resident Pi process, or wall-clock budget.
const support = await getRecoveryPostgresSupport({});

describe.skipIf(!support.supported)("native Pi cross-issue concurrency", () => {
  const fixture = nativeRestartFixture({});

  it("starts independent issue sessions up to the configured cap and drains the next chat when a slot frees", async () => {
    const { companyId, agentId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 8 });
    const started = new Map<string, NativeRunIdentity>();
    const releases = new Map<string, () => void>();
    let releasingAll = false;
    const nativeSessionBackendFactory: NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> = execution => {
      expect(execution.provider.kind).toBe("pi_rpc");
      let identity: NativeRunIdentity;
      let sourceInstanceId = "";
      const turn = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      releases.set(execution.binding.runId, () => release.resolve());
      if (releasingAll) release.resolve();
      const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      const session: NativeSession = {
        identity: () => identity,
        capabilities: async () => capabilities,
        attachRun: async input => { identity = input.identity; },
        startTurn: async () => {
          started.set(identity.runId, { ...identity });
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
          await release.promise;
          yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Concurrency check complete." });
          yield event(3, "turn.completed", { status: "completed" });
        },
        result: async () => ({
          result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Concurrency check complete.",
            completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
              criteria: execution.completionContract.contract.criteria.map(criterion => ({ criterionId: criterion.id,
                status: "satisfied", evidenceRefs: ["provider:pi_rpc:agent-message"] })), remainingWork: [] },
            evidence: [{ ref: "provider:pi_rpc:agent-message" }], verification: [], attentionRequests: [], artifacts: [] },
          terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed",
            runTerminalState: "succeeded", reportedWorkDisposition: "done" },
          turnId: await turn.promise,
        }),
        snapshot: async () => ({ backendKind: "mock", sessionId: identity.sessionId, identity,
          providerSessionId: `provider-${identity.sessionId}`, cursor: null, activeTurnId: null,
          pendingRuntimeRequests: [], lineage: [] }),
        close: async () => { release.resolve(); },
      };
      return {
        descriptor: async () => {
          const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, execution.binding.runId));
          if (!run?.runnerInstanceId) throw new Error("Native admission did not persist a runner identity");
          sourceInstanceId = run.runnerInstanceId;
          return { kind: "mock", name: "pi-concurrency-admission", version: "1", capabilities,
            runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
        },
        openSession: async input => { identity = input.identity; return session; },
      };
    };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory });
    const dispatchErrors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      canReconcile: () => true, onError: error => dispatchErrors.push(error) });
    const worker = heartbeat.registerRunDispatchWork(coordinator, () => true);
    const status = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    const setCap = async (maxConcurrentRuns: number) => db.update(agents).set({
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns } },
    }).where(eq(agents.id, agentId));
    try {
      await worker.ready;
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Chat owner", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      await db.update(agents).set({ status: "idle", adapterConfig: {
        provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off",
      } }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
      const chat = async (title: string, conversation = false) => {
        const [issue] = await db.insert(issues).values({ companyId, title, status: "in_progress",
          assigneeAgentId: agentId, responsibleUserId: userId,
          ...(conversation ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}),
        }).returning();
        const [comment] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
          authorType: "user", authorUserId: userId, body: title }).returning();
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
          requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
          payload: { issueId: issue!.id, commentId: comment!.id },
          contextSnapshot: { issueId: issue!.id, taskKey: issue!.id, wakeCommentId: comment!.id } });
        expect(run).not.toBeNull();
        return { runId: run!.id, issueId: issue!.id };
      };

      await setCap(1);
      const a = await chat("A: long work");
      await waitForCondition("A to enter its native turn", () => started.has(a.runId));
      const b = await chat("B: chat while A is busy", true);
      await heartbeat.resumeQueuedRuns();
      expect((await status(b.runId))?.status).toBe("queued");
      expect(started.has(b.runId)).toBe(false);
      expect((await status(a.runId))?.status).toBe("running");

      // This is the product fix: only the saved agent policy changes.
      await setCap(3);
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("B to start without A finishing", () => started.has(b.runId));
      const c = await chat("C: third independent issue");
      await waitForCondition("C to fill the third slot", () => started.has(c.runId));
      const d = await chat("D: fourth issue waits at the cap");
      await heartbeat.resumeQueuedRuns();
      expect((await status(d.runId))?.status).toBe("queued");
      expect(started.has(d.runId)).toBe(false);
      for (const run of [a, b, c]) expect((await status(run.runId))?.status).toBe("running");
      expect(new Set([...started.values()].map(identity => identity.sessionId)).size).toBe(3);
      expect(started.get(a.runId)?.issueId).toBe(a.issueId);
      expect(started.get(b.runId)?.issueId).toBe(b.issueId);

      releases.get(a.runId)!();
      await waitForCondition("D to start after A frees one slot", () => started.has(d.runId), 20_000);
      const finishedA = await status(a.runId);
      expect({ status: finishedA?.status, errorCode: finishedA?.errorCode, error: finishedA?.error })
        .toEqual({ status: "succeeded", errorCode: null, error: null });
      for (const run of [b, c, d]) expect((await status(run.runId))?.status).toBe("running");
      expect(new Set([...started.values()].map(identity => identity.sessionId)).size).toBe(4);
      expect(dispatchErrors).toEqual([]);
    } finally {
      await worker.stop();
      await coordinator.stop();
      releasingAll = true;
      for (const release of releases.values()) release();
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);
});
