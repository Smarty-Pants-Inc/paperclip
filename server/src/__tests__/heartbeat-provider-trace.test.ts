import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments, issues, providerTraceRecords } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as nativeExecutor from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

const support = await getRecoveryPostgresSupport({});

// Keep reason: recorded real catch — pi_rpc traces waited for rust_native,
// although only Codex produces that channel. Exercise real admission, trace
// storage and native dispatch; replace only the external provider boundary.
function completingBackend(db: ReturnType<typeof createDb>): NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    const turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
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
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." });
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "trace-session", identity,
        providerSessionId: "trace-provider-session", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "provider-trace", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    return backend;
  };
}

describe.skipIf(!support.supported)("heartbeat provider trace admission", () => {
  const fixture = nativeRestartFixture({});
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["pi_rpc", "run", false],
    ["pi_rpc", "agent", false],
    ["pi_rpc", "both", false],
    ["pi_rpc", "off", false],
    ["codex", "run", true],
    ["codex", "agent", true],
    ["codex", "off", false],
  ] as const)("%s with raw requested by %s: captures=%s", async (provider, requestedBy, captures) => {
    const { companyId, agentId, temporary } = fixture.current;
    const db = createDb(temporary.connectionString, { maxConnections: 4 });
    const execute = vi.spyOn(nativeExecutor, "executePaperclipNativeSession");
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
    try {
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Trace operator", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      await db.update(agents).set({ status: "idle", adapterConfig: { provider, model: provider === "pi_rpc" ? "paperclip/faux" : "gpt-6.1-sol",
        lifecycleMode: "warm", idleTimeoutMs: 60_000 }, runtimeConfig: requestedBy === "agent" || requestedBy === "both" ? { debug: { providerTrace: "raw" } } : {} })
        .where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
      const [issue] = await db.insert(issues).values({ companyId, title: "Inspect this conversation", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
        conversationState: "active" }).returning();
      const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id,
        authorType: "user", authorUserId: userId, body: "Start." }).returning();
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
        payload: { issueId: issue.id, commentId: message.id },
        contextSnapshot: { issueId: issue.id, taskKey: issue.id, wakeCommentId: message.id,
          ...(requestedBy === "run" || requestedBy === "both" ? { debug: { providerTrace: "raw" }, providerTraceRequestedBy: userId } : {}) } });
      expect(run).not.toBeNull();
      await waitForCondition("native trace run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const completed = await heartbeat.getRun(run!.id);
      expect(completed, JSON.stringify(completed)).toMatchObject({ status: "succeeded", runtimeMode: "native" });
      const dispatch = execute.mock.calls.find(([input]) => input.execution.binding.runId === run!.id)?.[0];
      expect(dispatch).toBeDefined();
      const rows = await db.select().from(providerTraceRecords).where(eq(providerTraceRecords.runId, run!.id));
      if (captures) {
        expect(rows).toEqual([expect.objectContaining({ provider, requestedBy: requestedBy === "agent" ? `agent:${agentId}:debug-setting` : userId })]);
        expect(dispatch!.runnerEnvironment?.PAPERCLIP_PROVIDER_TRACE_PATH).toEqual(expect.any(String));
        expect(dispatch!.runnerEnvironment?.PAPERCLIP_PROVIDER_TRACE_MAX_BYTES).toBe("67108864");
      } else {
        expect(rows).toEqual([]);
        expect(dispatch!.runnerEnvironment).not.toHaveProperty("PAPERCLIP_PROVIDER_TRACE_PATH");
        expect(dispatch!.runnerEnvironment).not.toHaveProperty("PAPERCLIP_PROVIDER_TRACE_MAX_BYTES");
        expect(completed?.runnerProfileJson).not.toHaveProperty("providerTrace");
      }
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await nativeExecutor.closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 60_000);
});
