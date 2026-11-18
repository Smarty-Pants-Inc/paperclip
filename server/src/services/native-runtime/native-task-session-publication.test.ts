import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, agentTaskSessions, companies, completionContracts, createDb, heartbeatRuns, issues,
  nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { CONTROL_PLANE_CONFORMANCE_OPEN, CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import type { PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { redactRegisteredSecretValues } from "../run-secret-redaction.js";
import { nativeSha256 } from "./canonical.js";
import { applyRunnerGoalPrpEvent } from "../runner-goals.js";
import { PaperclipControlPlanePort, type PaperclipControlPlaneBinding } from "./paperclip-control-plane-port.js";
import { nativeTaskSessionPublicationHandled, publishNativeTaskSessionInTransaction, publishPiConversationInTransaction, NATIVE_TASK_SESSION_PUBLICATION_KEY,
  type NativeTaskSessionPublicationContext } from "./native-task-session-publication.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_NATIVE_PUBLICATION_TEST_DATABASE_URL");
describe("accepted native task session publication", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>> | null = null;
  let db: Db;
  let measured: Db;
  let client: Db["$client"];
  const statements: string[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startRecoveryPostgres("native-publication-");
    const url = external ?? temporary!.connectionString;
    db = createDb(url, { maxConnections: 2 });
    // Test-only wire observer. Production still uses the existing Db/pools.
    const postgres = createRequire(import.meta.resolve("@paperclipai/db"))("postgres") as
      (url: string, options: object) => Db["$client"];
    client = postgres(url, { max: 1, prepare: false, connection: { application_name: "native-publication-observer" },
      debug: (_id: number, query: string) => { statements.push(query); } });
    measured = drizzle(client) as unknown as Db;
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  async function fixture(source: "runner" | "control" = "runner", accepted = true, providerKind?: "pi_rpc") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sessionId = randomUUID(), contractId = randomUUID(), runner = randomUUID(), control = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native pointer", issuePrefix: `P${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native pointer", adapterType: "codex_local", status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Native pointer", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "standalone-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "standalone-v1", objective: "Conformance", criteria: [{ id: "objective", requirement: "Complete" }] },
      canonicalSha256: "publication-contract", createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId: runner, completionContractId: contractId,
      completionContractSha256: "publication-contract", startedAt: new Date(Date.now() - 2_000),
      runnerProfileJson: providerKind ? { nativeExecutionInput: { provider: { kind: providerKind } } } : {} });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const owner = { companyId, issueId, runId, authorityRunId: runId, bootId: "publication-boot", generation: 1, leaseOwner: "publication-owner" };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
      controllerBootId: owner.bootId, controllerGeneration: owner.generation, leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const binding: PaperclipControlPlaneBinding = { companyId, agentId, issueId, runId, sessionId,
      completionContractId: contractId, completionContractSha256: "publication-contract", sourceInstanceId: runner,
      controlPlaneSourceInstanceId: control };
    const context: NativeTaskSessionPublicationContext = { taskKey: issueId, adapterType: "codex_local", ...(providerKind ? { providerKind } : {}),
      sessionParamsJson: { cwd: "/working", paperclipSessionConfigFingerprint: "prepared-once", opaque: "private-prepared-param" } };
    const snapshot: PersistedNativeSession = { backendKind: "mock", sessionId, identity: { companyId, agentId, issueId, runId, sessionId },
      providerSessionId: "provider-thread", activeTurnId: null, pendingRuntimeRequests: [], goal: null,
      semanticResult: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL };
    const port = new PaperclipControlPlanePort(measured, binding, { taskSessionPublication: context, taskSessionPublicationOwner: owner });
    await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN, identity: snapshot.identity, sourceInstanceId: runner });
    if (accepted) await new PaperclipControlPlanePort(db, binding).completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: "publication-turn" });
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: context.adapterType, taskKey: issueId,
      goalSourceId: `${source === "runner" ? runner : control}:${runId}`, goalSourceCursor: 4 });
    const read = async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [session] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, issueId));
      return { run, session };
    };
    return { binding, owner, context, snapshot, port, read };
  }

  it.each(["runner", "control"] as const)("publishes from the exact accepted %s epoch in one checkpoint transaction", async source => {
    const f = await fixture(source); statements.length = 0;
    await f.port.checkpointSession(f.snapshot);
    const queries = [...statements], { run, session } = await f.read();
    expect(session).toMatchObject({ sessionParamsJson: { ...f.context.sessionParamsJson, sessionId: f.binding.sessionId },
      sessionDisplayId: "provider-thread", lastRunId: f.binding.runId });
    expect(nativeTaskSessionPublicationHandled(run.runnerProfileJson, { ...f.binding, ...f.context })).toBe(true);
    expect(queries.filter(query => /^begin\b/i.test(query.trim()))).toHaveLength(1);
    expect(queries.filter(query => /^commit\b/i.test(query.trim()))).toHaveLength(1);
    expect(queries.filter(query => /native_run_results/i.test(query))).toHaveLength(1);
    expect(queries.filter(query => /^select .*from "agent_task_sessions"/i.test(query.trim()))).toHaveLength(1);
    expect(queries.filter(query => /^update "agent_task_sessions"/i.test(query.trim()))).toHaveLength(1);
    expect(queries).toHaveLength(7);
    expect(JSON.stringify(run.runnerProfileJson)).not.toContain("private-prepared-param");
    expect(JSON.stringify({ [NATIVE_TASK_SESSION_PUBLICATION_KEY]: run.runnerProfileJson![NATIVE_TASK_SESSION_PUBLICATION_KEY] }).length).toBeLessThan(4_096);
    expect(redactRegisteredSecretValues(run.runnerProfileJson, [])).not.toHaveProperty(NATIVE_TASK_SESSION_PUBLICATION_KEY);
    expect(nativeTaskSessionPublicationHandled(run.runnerProfileJson, { ...f.binding, ...f.context, companyId: randomUUID() })).toBe(false);
    expect(nativeTaskSessionPublicationHandled(run.runnerProfileJson, { ...f.binding, ...f.context, agentId: randomUUID() })).toBe(false);
    const malformed = structuredClone(run.runnerProfileJson!);
    (malformed[NATIVE_TASK_SESSION_PUBLICATION_KEY] as Record<string, unknown>).resultId = "not-an-id";
    expect(nativeTaskSessionPublicationHandled(malformed, { ...f.binding, ...f.context })).toBe(false);
  });

  it("does not recreate a reset pointer or query task state on repeated terminal maintenance", async () => {
    const f = await fixture(); await f.port.checkpointSession(f.snapshot);
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.binding.issueId)); statements.length = 0;
    await f.port.checkpointSession(f.snapshot);
    const repeated = [...statements];
    expect((await f.read()).session).toBeUndefined();
    expect(repeated.filter(query => /agent_task_sessions|native_run_results/i.test(query))).toHaveLength(0);
    expect(repeated.filter(query => /^begin\b/i.test(query.trim()))).toHaveLength(1);
    expect(repeated.filter(query => /^update /i.test(query.trim()))).toHaveLength(1);
  });

  it("publishes a fresh authorized retry after a different provider session owned the goal epoch", async () => {
    const f = await fixture();
    const priorRunId = randomUUID(), priorSessionId = randomUUID(), priorRunnerId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: priorRunId, companyId: f.binding.companyId,
      agentId: f.binding.agentId, nativeIssueId: f.binding.issueId, nativeSessionId: priorSessionId,
      runnerInstanceId: priorRunnerId, runtimeMode: "native", status: "failed",
      createdAt: new Date(Date.now() - 10_000), finishedAt: new Date(Date.now() - 5_000) });
    await db.update(agentTaskSessions).set({ lastRunId: priorRunId,
      sessionParamsJson: { sessionId: priorSessionId }, sessionDisplayId: "prior-provider-thread",
      goalSourceId: `${priorRunnerId}:${priorRunId}`, goalSourceCursor: 1_000,
    }).where(eq(agentTaskSessions.taskKey, f.binding.issueId));

    await applyRunnerGoalPrpEvent(db, { ...f.binding, adapterType: f.context.adapterType }, {
      eventType: "session.goal.snapshot", sourceInstanceId: f.binding.sourceInstanceId,
      sourceRunId: f.binding.runId, sourceSeq: 1, payload: { goal: null, workingNow: false },
    });
    await f.port.checkpointSession(f.snapshot);
    const { run, session } = await f.read();
    expect(session).toMatchObject({ lastRunId: f.binding.runId,
      sessionParamsJson: { ...f.context.sessionParamsJson, sessionId: f.binding.sessionId },
      sessionDisplayId: "provider-thread", goalSourceId: `${f.binding.sourceInstanceId}:${f.binding.runId}` });
    expect(run.runnerProfileJson?.nativeTaskSessionPublication).toMatchObject({ outcome: "published" });
  });

  it("persists a pre-acceptance terminal observation and publishes only at the existing accepted checkpoint", async () => {
    const f = await fixture("runner", false);
    // Driver event/startup checkpoints can expose a semantic terminal observation
    // before the runtime calls completeRun. That observation is not acceptance.
    await f.port.checkpointSession(f.snapshot);
    const observed = await f.read();
    expect(observed.run.runnerProfileJson?.sessionCheckpoint).toMatchObject({ semanticResult: CONTROL_PLANE_CONFORMANCE_RESULT });
    expect(observed.run.runnerProfileJson).not.toHaveProperty(NATIVE_TASK_SESSION_PUBLICATION_KEY);
    expect(observed.session?.sessionParamsJson).toBeNull();
    expect(nativeTaskSessionPublicationHandled(observed.run.runnerProfileJson, { ...f.binding, ...f.context })).toBe(false);
    await f.port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: "publication-turn" });
    expect((await f.read()).session?.sessionParamsJson).toBeNull();
    await f.port.checkpointSession(f.snapshot);
    const completed = await f.read();
    expect(completed.session?.lastRunId).toBe(f.binding.runId);
    expect(nativeTaskSessionPublicationHandled(completed.run.runnerProfileJson, { ...f.binding, ...f.context })).toBe(true);
  });

  it("publishes Pi's active conversation before result acceptance and preserves it across Stop", async () => {
    const f = await fixture("runner", false, "pi_rpc");
    const active = { ...f.snapshot, semanticResult: null, terminal: null, activeTurnId: "active-pi-turn" };
    await f.port.checkpointSession(active);
    const before = await f.read();
    expect(before.session).toMatchObject({ lastRunId: f.binding.runId, sessionDisplayId: "provider-thread",
      sessionParamsJson: { ...f.context.sessionParamsJson, sessionId: f.binding.sessionId } });
    expect(before.run.runnerProfileJson).not.toHaveProperty(NATIVE_TASK_SESSION_PUBLICATION_KEY);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.binding.runId))).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.binding.runId));
    await f.port.checkpointSession({ ...active, activeTurnId: null,
      terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "cancelled", runTerminalState: "cancelled", reportedWorkDisposition: "needs_review" } });
    expect((await f.read()).session).toEqual(before.session);
  });

  it.each(["clean", "completed_warm_predecessor", "older_goal_predecessor", "current_pointer_older_goal", "foreign_predecessor", "foreign_predecessor_epoch", "foreign_pointer", "unfinished_predecessor", "later_predecessor", "newer_goal_owner", "missing", "foreign_epoch", "newer_execution", "generation_reset", "uncertain", "failed", "failed_run", "no_board_stop", "issue_stop", "before_selection_stop"])(
    "publishes clean retained Pi Stop bookkeeping without relaxing %s fences", async kind => {
      const f = await fixture("runner", false, "pi_rpc");
      const cancelled: PersistedNativeSession = { ...f.snapshot, semanticResult: null, terminal: { schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "cancelled", runTerminalState: "cancelled", reportedWorkDisposition: "yielded" } };
      await db.update(heartbeatRuns).set({ status: kind === "failed_run" ? "failed" : "cancelled", resultJson: {
        startupCancellation: { errorCode: "cancelled", beforeNativeSelection: kind === "before_selection_stop" },
        cancelledByActorType: kind === "no_board_stop" ? "system" : "user", cancelledByUserId: "board",
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.binding.runId,
          companyId: f.binding.companyId, issueId: f.binding.issueId, scope: kind === "issue_stop" ? "issue" : "run", reasonCode: "cancellation_run_only",
          dispatchState: "acknowledged", dispatched: true, intentAuditId: "intent", acknowledgementAuditId: "ack" },
      } }).where(eq(heartbeatRuns.id, f.binding.runId));
      if (kind === "missing") await db.delete(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.binding.issueId));
      if (kind === "foreign_epoch") await db.update(agentTaskSessions).set({ goalSourceId: `${randomUUID()}:${f.binding.runId}` }).where(eq(agentTaskSessions.taskKey, f.binding.issueId));
      if (kind === "newer_execution") {
        const newer = randomUUID();
        await db.insert(heartbeatRuns).values({ id: newer, companyId: f.binding.companyId, agentId: f.binding.agentId, status: "running" });
        await db.update(issues).set({ executionRunId: newer }).where(eq(issues.id, f.binding.issueId));
      }
      if (kind === "generation_reset") await db.update(issues).set({ conversationAgentId: f.binding.agentId,
        conversationUserId: "publication-test-user", conversationState: "active", conversationSessionGeneration: 2 }).where(eq(issues.id, f.binding.issueId));
      let priorRunId: string | null = null;
      const predecessors = ["completed_warm_predecessor", "older_goal_predecessor", "current_pointer_older_goal", "foreign_predecessor", "foreign_predecessor_epoch", "foreign_pointer", "unfinished_predecessor", "later_predecessor", "newer_goal_owner"];
      if (predecessors.includes(kind)) {
        priorRunId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: priorRunId, companyId: f.binding.companyId,
          agentId: f.binding.agentId, nativeIssueId: f.binding.issueId,
          nativeSessionId: kind === "foreign_predecessor" ? randomUUID() : f.binding.sessionId,
          status: kind === "unfinished_predecessor" ? "running" : "succeeded",
          finishedAt: kind === "unfinished_predecessor" ? null : new Date(Date.now() + (kind === "later_predecessor" ? 10_000 : -5_000)) });
        let goalRunId = priorRunId;
        if (["older_goal_predecessor", "current_pointer_older_goal", "newer_goal_owner"].includes(kind)) {
          goalRunId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: goalRunId, companyId: f.binding.companyId,
            agentId: f.binding.agentId, nativeIssueId: f.binding.issueId, nativeSessionId: f.binding.sessionId,
            status: kind === "newer_goal_owner" ? "running" : "succeeded",
            finishedAt: kind === "newer_goal_owner" ? null : new Date(Date.now() - 10_000) });
        }
        if (kind === "current_pointer_older_goal") priorRunId = f.binding.runId;
        await db.update(agentTaskSessions).set({ lastRunId: priorRunId,
          goalSourceId: `${kind === "foreign_predecessor_epoch" ? randomUUID() : f.binding.sourceInstanceId}:${goalRunId}`,
          sessionParamsJson: { sessionId: kind === "foreign_pointer" ? randomUUID() : f.binding.sessionId } })
          .where(eq(agentTaskSessions.taskKey, f.binding.issueId));
      }
      if (kind === "uncertain") cancelled.activeTurnId = "unsettled-turn";
      if (kind === "failed") cancelled.terminal = { ...cancelled.terminal!, runTerminalState: "failed" };
      const publish = (retained: boolean) => db.transaction(async tx => {
        await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.binding.runId)).for("update");
        const [issue] = await tx.select().from(issues).where(eq(issues.id, f.binding.issueId)).for("no key update");
        const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.binding.runId)).for("update");
        return publishPiConversationInTransaction(tx, { binding: f.binding, context: f.context, snapshot: cancelled,
          run, issue }, retained ? { retainedCancelledOwner: true } : undefined);
      });
      const before = (await f.read()).session;
      const permitted = ["clean", "completed_warm_predecessor", "older_goal_predecessor", "current_pointer_older_goal"].includes(kind);
      expect(await publish(false)).not.toBe("published");
      expect(await publish(true)).toBe(permitted ? "published" : kind === "missing" ? "missing_stub"
        : ["foreign_epoch", "newer_execution", "foreign_predecessor", "foreign_predecessor_epoch", "foreign_pointer", "unfinished_predecessor", "later_predecessor", "newer_goal_owner"].includes(kind) ? "suppressed_newer"
        : kind === "generation_reset" ? "suppressed_reset" : "suppressed_authority");
      const after = (await f.read()).session;
      expect(after?.lastRunId ?? null).toBe(permitted ? f.binding.runId : priorRunId);
      if (!permitted) expect(after).toEqual(before);
      else expect(after?.goalSourceId).toBe(before?.goalSourceId);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.binding.runId))).toHaveLength(0);
      expect((await f.read()).run.runnerProfileJson).not.toHaveProperty(NATIVE_TASK_SESSION_PUBLICATION_KEY);
    });

  it.each(["missing", "foreign_epoch", "newer_execution", "generation_reset", "stop", "stale_owner", "wrong_provider"])(
    "fences Pi's pre-acceptance conversation pointer for %s", async kind => {
      const f = await fixture("runner", false, "pi_rpc");
      if (kind === "missing") await db.delete(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.binding.issueId));
      if (kind === "foreign_epoch") await db.update(agentTaskSessions).set({ goalSourceId: `${randomUUID()}:${f.binding.runId}` }).where(eq(agentTaskSessions.taskKey, f.binding.issueId));
      if (kind === "newer_execution") {
        const newer = randomUUID();
        await db.insert(heartbeatRuns).values({ id: newer, companyId: f.binding.companyId, agentId: f.binding.agentId, status: "running" });
        await db.update(issues).set({ executionRunId: newer }).where(eq(issues.id, f.binding.issueId));
      }
      if (kind === "generation_reset") await db.update(issues).set({ conversationAgentId: f.binding.agentId,
        conversationUserId: "publication-test-user", conversationState: "active", conversationSessionGeneration: 2 }).where(eq(issues.id, f.binding.issueId));
      if (kind === "stop") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.binding.runId));
      if (kind === "stale_owner") await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.binding.runId));
      if (kind === "wrong_provider") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" } } } }).where(eq(heartbeatRuns.id, f.binding.runId));
      const checkpoint = f.port.checkpointSession({ ...f.snapshot, semanticResult: null, terminal: null, activeTurnId: "active-pi-turn" });
      if (kind === "stale_owner") await expect(checkpoint).rejects.toThrow("checkpoint_owner_lost");
      else await checkpoint;
      const { run, session } = await f.read();
      expect(session?.sessionParamsJson?.sessionId).not.toBe(f.binding.sessionId);
      expect(run.runnerProfileJson).not.toHaveProperty(NATIVE_TASK_SESSION_PUBLICATION_KEY);
    });

  it("does not hold the issue parent lock while a result replay waits for the status coordinator", async () => {
    const f = await fixture();
    let committed = 0;
    const port = new PaperclipControlPlanePort(db, f.binding, { nativeRecovery: { owner: f.owner,
      compatibility: { configDigest: nativeSha256("config"), processConfigDigest: null } },
      onResultCommitted: async () => { committed++; } });
    await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN, identity: f.snapshot.identity, sourceInstanceId: f.binding.sourceInstanceId });
    let replay: Promise<unknown> | undefined;
    let statusLockError: unknown = null;
    try {
      await db.transaction(async tx => {
        // This is commitNativeStatusDecision's actual lock prefix. Hold its
        // coordinator first, then overlap an identical remote result replay.
        await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.binding.runId)).for("update");
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        replay = port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT,
          terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: "publication-turn" }).then(() => null, error => error);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [state] = await measured.execute(sql`select exists (
            select 1 from pg_stat_activity where ${backend.pid} = any(pg_blocking_pids(pid))) as waiting`);
          if (state.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        // A bounded test-local timeout reports the inverse-order cycle without
        // relying on which transaction PostgreSQL chooses as deadlock victim.
        await tx.execute(sql`set local lock_timeout = '500ms'`);
        await tx.select().from(issues).where(eq(issues.id, f.binding.issueId)).for("update");
      });
    } catch (error) { statusLockError = error; }
    const replayError = await replay;
    expect(statusLockError).toBeNull();
    expect(replayError).toBeNull();
    expect(committed).toBe(0);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.binding.runId))).toHaveLength(1);
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, f.binding.runId));
    await expect(port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: "publication-turn" })).rejects.toThrow("checkpoint_owner_lost");
  });

  it.each(["missing", "foreign_epoch", "newer_pointer", "newer_execution", "generation_reset", "stop"])("fences %s and records a handled suppression", async kind => {
    const f = await fixture();
    if (kind === "missing") await db.delete(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.binding.issueId));
    if (kind === "foreign_epoch") await db.update(agentTaskSessions).set({ goalSourceId: `${randomUUID()}:${f.binding.runId}` }).where(eq(agentTaskSessions.taskKey, f.binding.issueId));
    if (kind === "newer_pointer" || kind === "newer_execution") {
      const newer = randomUUID();
      await db.insert(heartbeatRuns).values({ id: newer, companyId: f.binding.companyId, agentId: f.binding.agentId,
        status: "running", issueId: f.binding.issueId, startedAt: new Date() });
      if (kind === "newer_pointer") await db.update(agentTaskSessions).set({ lastRunId: newer, sessionParamsJson: { sessionId: "newer" } }).where(eq(agentTaskSessions.taskKey, f.binding.issueId));
      else await db.update(issues).set({ executionRunId: newer }).where(eq(issues.id, f.binding.issueId));
    }
    if (kind === "generation_reset") await db.update(issues).set({ conversationAgentId: f.binding.agentId,
      conversationUserId: "publication-test-user", conversationState: "active", conversationSessionGeneration: 2 }).where(eq(issues.id, f.binding.issueId));
    if (kind === "stop") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.binding.runId));
    await f.port.checkpointSession(f.snapshot);
    const { run, session } = await f.read();
    expect(nativeTaskSessionPublicationHandled(run.runnerProfileJson, { ...f.binding, ...f.context })).toBe(true);
    expect(session?.sessionParamsJson?.sessionId).not.toBe(f.binding.sessionId);
  });

  it("keeps unsupported task keys and missing remote recovery headers outside handled publication", async () => {
    const f = await fixture();
    const context = { ...f.context, taskKey: "custom-task" };
    const port = new PaperclipControlPlanePort(measured, f.binding, { taskSessionPublication: context, taskSessionPublicationOwner: f.owner });
    await port.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN, identity: f.snapshot.identity, sourceInstanceId: f.binding.sourceInstanceId });
    await port.checkpointSession(f.snapshot);
    const { run, session } = await f.read();
    expect(session?.sessionParamsJson).toBeNull();
    expect(nativeTaskSessionPublicationHandled(run.runnerProfileJson, { ...f.binding, ...context })).toBe(false);
    const remote = await fixture();
    const remotePort = new PaperclipControlPlanePort(measured, remote.binding, { taskSessionPublication: remote.context,
      taskSessionPublicationOwner: remote.owner, nativeRecovery: { owner: remote.owner,
        compatibility: { configDigest: nativeSha256("config"), processConfigDigest: null } } });
    await remotePort.openRun({ ...CONTROL_PLANE_CONFORMANCE_OPEN, identity: remote.snapshot.identity, sourceInstanceId: remote.binding.sourceInstanceId });
    await remotePort.checkpointSession(remote.snapshot);
    expect((await remote.read()).session?.sessionParamsJson).toBeNull();
    expect(nativeTaskSessionPublicationHandled((await remote.read()).run.runnerProfileJson, { ...remote.binding, ...remote.context })).toBe(false);
  });

  it("rejects stale owners and a different accepted result without partially publishing", async () => {
    const stale = await fixture();
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, stale.binding.runId));
    await expect(stale.port.checkpointSession(stale.snapshot)).rejects.toThrow("checkpoint_owner_lost");
    expect((await stale.read()).session?.sessionParamsJson).toBeNull();
    const wrong = await fixture();
    await expect(wrong.port.checkpointSession({ ...wrong.snapshot, semanticResult: { ...CONTROL_PLANE_CONFORMANCE_RESULT, summary: "different" } })).rejects.toThrow("publication_result_mismatch");
    expect((await wrong.read()).session?.sessionParamsJson).toBeNull();
    const foreign = await fixture();
    const foreignResult = await fixture();
    const [otherCoordinator] = await db.select({ resultId: nativeRunFinalizations.resultId }).from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, foreignResult.binding.runId));
    await expect(db.update(nativeRunFinalizations).set({ resultId: otherCoordinator.resultId })
      .where(eq(nativeRunFinalizations.runId, foreign.binding.runId)))
      .rejects.toMatchObject({ cause: { constraint_name: "native_run_finalizations_result_owner_fk" } });
    expect((await foreign.read()).session?.sessionParamsJson).toBeNull();
    await db.update(nativeRunFinalizations).set({ resultId: null }).where(eq(nativeRunFinalizations.runId, foreign.binding.runId));
    // The CP defers preacceptance snapshots, while the publication helper itself
    // still requires accepted-result authority if called directly.
    await expect(publishNativeTaskSessionInTransaction({} as never, { binding: foreign.binding,
      context: foreign.context, snapshot: foreign.snapshot, run: (await foreign.read()).run,
      issue: null, resultId: null })).rejects.toThrow("publication_result_missing");
  });

  it("adds no publication SQL for nonterminal or goal snapshots", async () => {
    const f = await fixture(); statements.length = 0;
    await f.port.checkpointSession({ ...f.snapshot, semanticResult: null, terminal: null });
    expect(statements.some(query => /agent_task_sessions|native_run_results|publication_issue/i.test(query))).toBe(false);
    statements.length = 0;
    await f.port.checkpointSession({ ...f.snapshot, goal: {} as NonNullable<PersistedNativeSession["goal"]> });
    expect(statements.some(query => /agent_task_sessions|native_run_results|publication_issue/i.test(query))).toBe(false);
    expect((await f.read()).session?.sessionParamsJson).toBeNull();
  });

  it.each(["completed_predecessor", "expired_accepted_lease"])("preserves legitimate %s maintenance", async kind => {
    const f = await fixture();
    if (kind === "completed_predecessor") {
      const prior = randomUUID();
      await db.insert(heartbeatRuns).values({ id: prior, companyId: f.binding.companyId, agentId: f.binding.agentId,
        issueId: f.binding.issueId, status: "succeeded", finishedAt: new Date(Date.now() - 5_000) });
      await db.update(agentTaskSessions).set({ lastRunId: prior, sessionParamsJson: { sessionId: "prior" } })
        .where(eq(agentTaskSessions.taskKey, f.binding.issueId));
    } else {
      await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(nativeRunFinalizations.runId, f.binding.runId));
    }
    await f.port.checkpointSession(f.snapshot);
    expect((await f.read()).session?.lastRunId).toBe(f.binding.runId);
  });

  it("does not block completeRun's issue KEY SHARE while publishing", async () => {
    const f = await fixture(); let release!: () => void; let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.binding.issueId)).for("key share"); locked(); await hold;
    });
    await ready;
    try { await f.port.checkpointSession(f.snapshot); }
    finally { release(); await blocker; }
    expect((await f.read()).session?.lastRunId).toBe(f.binding.runId);
  });

  it("rechecks the owner clock and issue authority after an issue lock wait", async () => {
    const f = await fixture(); let release!: () => void; let locked!: () => void;
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 500) }).where(eq(nativeRunFinalizations.runId, f.binding.runId));
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const newer = randomUUID();
    await db.insert(heartbeatRuns).values({ id: newer, companyId: f.binding.companyId, agentId: f.binding.agentId,
      issueId: f.binding.issueId, status: "running", startedAt: new Date() });
    const blocker = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.binding.issueId)).for("no key update");
      await tx.update(issues).set({ executionRunId: newer }).where(eq(issues.id, f.binding.issueId));
      locked(); await hold;
    });
    await ready;
    const publication = f.port.checkpointSession(f.snapshot);
    const rejected = expect(publication).rejects.toThrow("checkpoint_owner_lost");
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where application_name = 'native-publication-observer'
          and wait_event_type = 'Lock' and query like '%publication_issue%'`);
        if (rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 600));
    } finally { release(); await blocker; }
    await rejected;
    expect((await f.read()).session?.sessionParamsJson).toBeNull();
  });

  it("rolls back the pointer if combined private metadata exceeds its existing bound", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeControllerRecovery: { padding: "x".repeat(4_096) } } }).where(eq(heartbeatRuns.id, f.binding.runId));
    await expect(f.port.checkpointSession(f.snapshot)).rejects.toThrow("publication_metadata_too_large");
    const { run, session } = await f.read();
    expect(session?.sessionParamsJson).toBeNull();
    expect(run.runnerProfileJson).not.toHaveProperty(NATIVE_TASK_SESSION_PUBLICATION_KEY);
  });
});
