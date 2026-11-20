import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments, issues, principalPermissionGrants } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

const support = await getRecoveryPostgresSupport({});
// Only the provider is simulated: admission, ordered event consumption, settlement,
// checkpoint, executor cleanup, runtime and terminal database writes are real.
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
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." });
        turn = Promise.withResolvers<string>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "endrun-session", identity,
        providerSessionId: "endrun-provider-session", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "endrun", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    return backend;
  };
}

describe.skipIf(!support.supported)("native endrun settlement spans", () => {
  const fixture = nativeRestartFixture({});
  it.each(["pi_rpc", "codex"])("keeps selected %s settlement steps under endrun through the terminal DB commit", async providerKind => {
    const { companyId, agentId, temporary } = fixture.current;
    const db = createDb(temporary.connectionString, { maxConnections: 4 });
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const manager = new AsyncLocalStorageContextManager().enable();
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(context.setGlobalContextManager(manager)).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: completingBackend(db) });
    const instructionRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Settlement", adapterConfig: {} });
    await mkdir(instructionRoot, { recursive: true });
    await writeFile(path.join(instructionRoot, "AGENTS.md"), "Complete the requested task.\n");
    try {
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values([
        { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
        { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
      ]).onConflictDoNothing();
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
        permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
      await db.update(agents).set({ status: "idle", adapterConfig: { provider: providerKind, model: providerKind === "pi_rpc" ? "paperclip/faux" : "gpt-5.4", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsRootPath: instructionRoot, instructionsEntryFile: "AGENTS.md", idleTimeoutMs: 60_000 } }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
      const [issue] = await db.insert(issues).values({ companyId, title: "Measure native settlement", status: "in_progress", assigneeAgentId: agentId,
        responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" }).returning();
      const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id, authorType: "user", authorUserId: userId, body: "Start." }).returning();
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented", requestedByActorType: "user",
        requestedByActorId: userId, manualUserWake: true, payload: { issueId: issue!.id, commentId: message!.id },
        contextSnapshot: { issueId: issue!.id, taskKey: issue!.id, wakeCommentId: message!.id, debug: { providerTrace: "raw" } } });
      expect(run).not.toBeNull();
      await waitForCondition("the run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]).toMatchObject({ status: "succeeded" });
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      if (process.env.PAPERCLIP_ENDRUN_SPANS_EVIDENCE) await writeFile(
        `${process.env.PAPERCLIP_ENDRUN_SPANS_EVIDENCE}-${providerKind}.json`,
        JSON.stringify(spans.map(span => ({ name: span.name, id: span.spanContext().spanId,
          parent: span.parentSpanContext?.spanId, start: span.startTime, end: span.endTime,
          events: span.events.map(event => ({ name: event.name, time: event.time })) })), null, 2));
      const endrun = spans.find(span => span.name === "endrun");
      expect(endrun, "endrun must reach the terminal commit, not stop at trace.finish").toBeDefined();
      const selected = ["ingestion.settle", "accounting.persist", "wake_receipt.validate", "warm.release", "coordinator.release",
        "native_trace.finish_drain", "executor.cleanup", "adapter_events.drain", "runtime.gateway_revoke", "instruction.release",
        "completion.log_finalize", "completion.terminal_write", "native_finalize.claim", "native_finalize.assessment_read",
        "native_finalize.policy", "native_finalize.status_commit", "native_finalize.projection",
        "instruction_checkpoint.capture", "instruction_checkpoint.validate", "instruction_checkpoint.canonical_apply", "instruction_checkpoint.scratch_cleanup",
        ...(providerKind === "codex" ? ["provider_trace.finalize"] : [])];
      if (providerKind === "pi_rpc") expect(spans.some(span => span.name === "provider_trace.finalize")).toBe(false);
      const byId = new Map(spans.map(span => [span.spanContext().spanId, span]));
      for (const name of selected) {
        const child = spans.find(span => span.name === name);
        expect(child, name).toBeDefined();
        let parent = child?.parentSpanContext?.spanId;
        while (parent && parent !== endrun!.spanContext().spanId) parent = byId.get(parent)?.parentSpanContext?.spanId;
        expect(parent, `${name} must be nested under endrun`).toBe(endrun!.spanContext().spanId);
      }
      expect(endrun!.events.map(event => event.name)).toEqual(expect.arrayContaining(["turn.terminal", "finished_at.sampled", "terminal.db_commit"]));
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await rm(instructionRoot, { recursive: true, force: true });
      await db.$client.end();
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      trace.disable(); context.disable(); await provider.shutdown();
    }
  }, 60_000);
});
