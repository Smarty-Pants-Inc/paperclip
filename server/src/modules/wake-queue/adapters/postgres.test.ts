import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_REASON_PREFIX } from "../../../services/recovery/unanswered-person-message.js";
import { readPersonStopHold } from "../../../services/acknowledged-native-stop.js";
import { personMessageOwedSql } from "../../../services/person-message-answer.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { DELIVERY_QUEUES } from "../../../services/delivery-work-notifications.js";
import { instanceSettingsService } from "../../../services/instance-settings.js";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createSystemRecovery } from "../../../services/system-recovery-state.js";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  chatCompletionDeliveries,
  chatTaskHandoffs,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueTreeHolds,
  issues,
  nativeRunFinalizations,
  subscribeDatabaseWork,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import {
  createAdmissionTransactionScope,
  createPostgresWakeQueueAdapter,
  createWakeAdmissionWriter,
} from "./postgres.js";
import type { WakeQueuePostgresAdapterDeps } from "./postgres.js";
import { createReleaseIssueExecution } from "../application/use-cases.js";
import type { TransactionScope } from "../application/ports.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInRunContext, withQueuedCommentIdsInWakePayload } from "../../../services/issue-queued-comment-queue.js";

// Proves the atomicity and company-scope properties the security review
// requires: every mutation names `companyId` in its own SQL `WHERE` clause,
// a foreign-company row is invisible to a read, and a deferred-status
// compare-and-set that affects no row leaves no other trace. The decision
// branching itself is proven against plain facts in `domain/policy.test.ts`.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WAKE_QUEUE_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-queue adapter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake-queue postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const stubDeps: WakeQueuePostgresAdapterDeps = {
    resolveResponsibleUserId: async () => "responsible-user",
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  };

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-queue-postgres-adapter-");
    db = createDb(external ?? tempDb!.connectionString, { maxConnections: 6 });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    // `heartbeat_runs.wakeup_request_id` references `agent_wakeup_requests.id`,
    // so the run row must go first.
    await db.delete(nativeRunFinalizations);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(input: { companyId: string; name?: string }): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name ?? "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    issueId?: string;
    status?: string;
    assigneeAgentId?: string | null;
    executionRunId?: string | null;
    checkoutRunId?: string | null;
    parentId?: string | null;
    identifier?: string;
  }): Promise<string> {
    const issueId = input.issueId ?? randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Wake-queue adapter fixture issue",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionRunId: input.executionRunId ?? null,
      checkoutRunId: input.checkoutRunId ?? null,
      parentId: input.parentId ?? null,
      identifier: input.identifier,
    });
    return issueId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    contextSnapshot?: Record<string, unknown>;
    errorCode?: string | null;
    runtimeMode?: string;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      status: input.status ?? "failed",
      contextSnapshot: input.contextSnapshot ?? {},
      errorCode: input.errorCode ?? null,
    });
    return runId;
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    requestedByActorType?: string;
    requestedByActorId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: input.requestedByActorType ?? "user",
      requestedByActorId: input.requestedByActorId ?? null,
      payload: { issueId: input.issueId, ...(input.payload ?? {}) },
    });
    return id;
  }

  it("carries pending person input through the review-participant recovery seed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Review the COBALT follow-up." }).returning();
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId, wakeCommentId: message.id } });
    await db.update(heartbeatRuns).set({ responsibleUserId: "responsible-user",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, runId));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (locked, ports) => {
      const queued = await ports.transaction.queueReviewParticipantRecoveryRun({ companyId, issue: locked.primaryIssue!, finishingRun: locked.run,
        recoveryAgent: { id: agentId, companyId, name: "Reviewer", invokable: true }, sessionBefore: null, now: new Date() });
      return { outcome: { kind: "queued_review_participant_recovery", run: queued }, postCommitEffects: [] };
    });
    expect(result.outcome.kind).toBe("queued_review_participant_recovery");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(successor.contextSnapshot).toMatchObject({
      commentContinuation: true, wakeCommentId: message.id, wakeCommentIds: [message.id] });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successor.wakeupRequestId!));
    expect(wake.payload?._paperclipWakeContext).toMatchObject({ wakeCommentIds: [message.id] });
  });

  function recordReleaseRunReads() {
    const rows: unknown[][] = [];
    function recordSelects<T extends Pick<Db, "select">>(executor: T): T {
      return new Proxy(executor, { get(target, key) {
        if (key !== "select") return Reflect.get(target, key);
        return (...fields: Parameters<Db["select"]>) => {
          const builder = target.select(...fields), from = builder.from.bind(builder);
          builder.from = ((...args: Parameters<typeof from>) => {
            const query = from(...args);
            if (args[0] === heartbeatRuns) {
              const execute = query.execute.bind(query);
              query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                const result = await execute(...executeArgs); rows.push(result); return result;
              };
            }
            return query;
          }) as typeof builder.from;
          return builder;
        };
      }});
    }
    const transaction: Db["transaction"] = (callback, config) =>
      db.transaction(tx => callback(recordSelects(tx)), config);
    const recorded = new Proxy(db, { get(target, key) {
      return key === "transaction" ? transaction : Reflect.get(target, key);
    }});
    return { recorded, rows };
  }

  it.each(["legacy", "native"])("keeps %s in-flight work and every recovery receipt while omitting output from release reads", async runtimeMode => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const payload = randomBytes(512 * 1024).toString("base64");
    const evidence = { cancellation: { source: "queued_message", expected: true, initiator: { type: "system" }, reason: "Fixture", recordedAt: "2020-01-01T00:00:00Z" },
      workspaceRestoreFailure: "restore_unsafe_archive", workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [randomUUID()] },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId },
      executionCancellation: { state: "acknowledged" }, executionRecovery: { kind: "interrupted", providerStopped: true },
      configurationIncomplete: { reason: "workspace_unavailable" }, unknownFutureReceipt: { retained: true } };
    await db.update(heartbeatRuns).set({ runtimeMode,
      ...(runtimeMode === "native" ? { runnerProfileJson: { savedInput: payload }, stdoutExcerpt: payload, stderrExcerpt: payload,
        contextSnapshot: { issueId, paperclipWake: { savedTask: payload }, paperclipTaskMarkdown: payload } } : {}),
      resultJson: { ...evidence, stdout: payload.repeat(3), stderr: payload } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    const { recorded, rows } = recordReleaseRunReads();
    const result = await createPostgresWakeQueueAdapter(recorded, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { throw new Error("in-flight work must not drain"); },
    );
    expect(result.outcome.kind).toBe("released");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([{ ...run, resultJson: evidence,
      ...(runtimeMode === "native" ? { runnerProfileJson: null, stdoutExcerpt: null, stderrExcerpt: null,
        contextSnapshot: { issueId } } : {}) }]);
    expect(result.run.contextSnapshot).toEqual({ issueId });
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(8 * 1024);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toEqual(run);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toEqual(issue);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]).toEqual(wake);
  });

  it.each([null, ["stdout", { stderr: "array evidence" }], "scalar", 42].map(result => ({ result })))("preserves non-object result evidence $result during release", async ({ result }) => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await db.update(heartbeatRuns).set({ resultJson: result as Record<string, unknown> | null }).where(eq(heartbeatRuns.id, runId));
    const { recorded, rows } = recordReleaseRunReads();
    await createPostgresWakeQueueAdapter(recorded, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { throw new Error("in-flight work must not drain"); },
    );
    expect(rows).toHaveLength(1);
    expect((rows[0][0] as typeof heartbeatRuns.$inferSelect).resultJson).toEqual(result);
  });

  it.each(["assignee", "mentioned"])("preserves a paused recipient's accepted message until resume (%s)", async kind => {
    const companyId = await seedCompany();
    const ownerId = await seedAgent({ companyId });
    const recipientId = kind === "assignee" ? ownerId : await seedAgent({ companyId });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, recipientId));
    const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: ownerId });
    const runId = await seedRun({ companyId, agentId: ownerId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Accepted input must survive an agent pause" }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId: recipientId, issueId, requestedByActorId: "responsible-user",
      payload: { _paperclipWakeContext: { issueId, wakeReason: kind === "mentioned" ? "issue_comment_mentioned" : "issue_commented",
        wakeCommentIds: [comment.id] } },
    });
    const [accepted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    const input = { companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true };
    for (let pass = 0; pass < 2; pass++) {
      expect((await release(input)).outcome.kind).toBe("released");
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]).toEqual(accepted);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    }
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, recipientId));
    expect((await release(input)).outcome.kind).toBe("promoted");
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(delivered).toMatchObject({ status: "queued", runId: expect.any(String), payload: accepted.payload });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered.runId!));
    expect(successor).toMatchObject({ agentId: recipientId, contextSnapshot: { wakeCommentIds: [comment.id] } });
    await release(input);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(2);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0].body).toBe(comment.body);
  });

  it.each(["queued", "running", "scheduled_retry", "cancelled"])("preserves a stranded queue when another agent has a newer %s turn", async status => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const otherAgentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await seedRun({ companyId, agentId: otherAgentId, status, contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId: otherAgentId, issueId });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(false);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("ignores a foreign company's run when rechecking a stranded queue", async () => {
    const companyId = await seedCompany();
    const foreignCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const foreignAgentId = await seedAgent({ companyId: foreignCompanyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await seedRun({ companyId: foreignCompanyId, agentId: foreignAgentId, status: "running", contextSnapshot: { issueId } });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(true);
  });

  it.each(["unfinished", "running"])("does not drain a stranded queue through an %s source", async kind => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: kind === "running" ? "running" : "succeeded", contextSnapshot: { issueId } });
    if (kind === "running") await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(false);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it("recovers a historical mention without consuming a former owner's task messages", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedAgent({ companyId });
    const formerOwnerId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: ownerId });
    const runId = await seedRun({ companyId, agentId: ownerId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Saved task input" }).returning();
    const [mention] = await db.insert(issueComments).values({ companyId, issueId, authorAgentId: ownerId, createdByRunId: runId, body: "Accepted feedback" }).returning();
    const handoffId = await seedDeferredWake({ companyId, agentId: formerOwnerId, issueId,
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [message.id] } },
    });
    const mentionId = await seedDeferredWake({ companyId, agentId: formerOwnerId, issueId,
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_comment_mentioned", wakeCommentIds: [mention.id] } },
    });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    const result = await release({ companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true });
    expect(result.outcome.kind).toBe("promoted");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, handoffId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, mentionId));
    expect(promoted).toMatchObject({ status: "queued", runId: expect.any(String) });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, promoted.runId!)))[0].contextSnapshot)
      .toMatchObject({ wakeCommentIds: [mention.id] });
    expect((await db.select().from(issueComments).where(eq(issueComments.id, message.id)))[0].body).toBe(message.body);
  });

  it.each(["missing", "retryable_failure"])("holds native queue recovery with %s finalization evidence", async phase => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    if (phase !== "missing") await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    let drained = false;
    await createPostgresWakeQueueAdapter(db, stubDeps).withIssueExecutionLock(
      { companyId, runId, now: new Date(), resumeStrandedQueue: true },
      async () => { drained = true; return { outcome: { kind: "released" }, postCommitEffects: [] }; },
    );
    expect(drained).toBe(false);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

  it.each(["active_lease", "pending_cleanup", "failed_cleanup", "unknown_cleanup", "local_provider_resource", "ssh_provider_mismatch", "cleanup_claim", "finalizer_owner", "workspace_owner"])(
    "waits for native cleanup and finalizer ownership before recovering saved input (%s)", async kind => {
      const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: agentId });
      const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date(),
        ...(kind === "workspace_owner" ? { runnerProfileJson: { nativeWorkspaceFinalizationOwner: {
          token: "copyback-owner", hostname: "previous-worker", pid: 123, processStartedAt: new Date(Date.now() - 1000).toISOString(),
        } } } : {}),
      }).where(eq(heartbeatRuns.id, runId));
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "committed",
        ...(kind === "finalizer_owner" ? { leaseOwner: "finalizer-worker", leaseExpiresAt: new Date(Date.now() - 1000) } : {}),
      });
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
      const [lease] = ["finalizer_owner", "workspace_owner"].includes(kind) ? [] : await db.insert(environmentLeases).values({
        companyId, heartbeatRunId: runId, provider: kind === "unknown_cleanup" ? "daytona" : kind === "ssh_provider_mismatch" ? "ssh" : "local",
        providerLeaseId: kind === "local_provider_resource" ? randomUUID() : kind === "ssh_provider_mismatch" ? "ssh://worker@example.invalid:22/workspace" : null,
        status: kind === "active_lease" ? "active" : kind === "pending_cleanup" ? "pending_cleanup" : "released",
        releasedAt: kind === "active_lease" ? null : new Date(),
        cleanupStatus: kind === "failed_cleanup" ? "failed" : ["unknown_cleanup", "local_provider_resource", "ssh_provider_mismatch"].includes(kind) ? null : "success",
        metadata: kind === "cleanup_claim" ? { pendingCleanupInFlight: true } : {},
      }).returning();
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Saved input after cleanup" }).returning();
      const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
        payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
      });
      const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
        recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
      });
      const input = { companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true };
      const held = await release(input);
      expect(held).toMatchObject({ outcome: { kind: "released" }, postCommitEffects: [] });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ executionRunId: runId, checkoutRunId: runId });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
      if (lease) await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(), metadata: {} }).where(eq(environmentLeases.id, lease.id));
      if (kind === "finalizer_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, runId));
      if (kind === "workspace_owner") await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, runId));
      expect((await release(input)).outcome.kind).toBe("promoted");
      await release(input);
      expect(await db.select().from(heartbeatRuns)).toHaveLength(2);
      expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0].body).toBe(comment.body);
    },
  );

  it.each(["released", "retained", "local_release", "ssh_release", "unrelated_cleanup"])("allows native queue recovery after settled %s cleanup", async kind => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, status: "blocked", assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "committed" });
    if (kind === "unrelated_cleanup") {
      const foreignCompany = await seedCompany(), foreignAgent = await seedAgent({ companyId: foreignCompany });
      const foreignRun = await seedRun({ companyId: foreignCompany, agentId: foreignAgent, status: "running" });
      await db.insert(environmentLeases).values({ companyId: foreignCompany, heartbeatRunId: foreignRun, provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    } else {
      await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
        provider: kind === "local_release" ? "local" : kind === "ssh_release" ? "ssh" : "daytona",
        providerLeaseId: kind === "ssh_release" ? "ssh://worker@example.invalid:22/workspace" : null,
        metadata: kind === "ssh_release" ? { driver: "ssh" } : {},
        status: ["local_release", "ssh_release"].includes(kind) ? "released" : kind,
        leasePolicy: kind === "retained" ? "reuse_by_environment" : "ephemeral", cleanupStatus: ["local_release", "ssh_release"].includes(kind) ? null : "success",
        releasedAt: kind === "retained" ? null : new Date(),
      });
    }
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Saved input for the next turn" }).returning();
    await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
    });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    expect((await release({ companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true })).outcome.kind).toBe("promoted");
  });

  it.each([true, false])("promotes saved input behind a restart-ended native run only once the fresh continuation replaced it (replaced: %s)", async replaced => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, status: "in_progress", assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date(),
      errorCode: "native_restart_recovery_blocked",
      resultJson: replaced ? { freshContinuationSupersededAt: new Date().toISOString() } : {},
    }).where(eq(heartbeatRuns.id, runId));
    // Restart recovery ended the run: its finalization stays terminal_failure, never committed.
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure",
      recoveryState: "blocked", failureCode: "native_restart_recovery_blocked" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Follow-up during the run" }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
    });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    const result = await release({ companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true });
    if (replaced) {
      expect(result.outcome.kind).toBe("promoted");
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).not.toBe("deferred_issue_execution");
      // No reconciliation incident re-blocks the task the fallback released.
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).not.toBe("blocked");
    } else {
      expect(result.outcome.kind).toBe("released");
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    }
  });

  it.each([
    ["fresh_isolated_workspace", "promoted", "not_requested"], ["remote_epoch", "promoted", "not_requested"],
    ["writer_ended", "released", "not_requested"],
    // The isolated continuation is still to be delivered: it runs first and binds the new workspace;
    // promoting the follow-up now would make it the task's next run, without the isolation.
    ["fresh_isolated_workspace", "released", "pending"],
  ] as const)("promotes saved input behind an exhausted restart hold once a %s continuation replaced the run (%s, continuation %s)", async (isolation, expected, continuationDelivery) => {
    // Restart recovery exhausted its retries (systemRecovery.state exhausted, no stop receipt), then the
    // fallback replaced the run. An isolated continuation reuses none of the old executor's workspace,
    // so the manual-admission hold no longer stands between the task and the person's follow-up.
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, status: "in_progress", assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, finishedAt: new Date(),
      errorCode: "native_restart_recovery_blocked", resultJson: { freshContinuationSupersededAt: new Date().toISOString() },
    }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure",
      recoveryState: "blocked", failureCode: "native_restart_recovery_blocked",
      failureDetail: { systemRecovery: { ...createSystemRecovery(runId), state: "exhausted" }, replacementDenied: "fresh_continuation" } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: agentId,
      cause: "fresh_continuation", fingerprint: `fresh-continuation:${runId}`, nextAction: "Continuing.", resolvedAt: new Date(),
      evidence: { runId, freshContinuation: { sourceRunId: runId, isolation,
        delivery: continuationDelivery === "pending" ? "recorded" : "saved_input" }, continuationDelivery } });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Follow-up during the run" }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
    });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    const result = await release({ companyId, runId, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true });
    expect(result.outcome.kind).toBe(expected);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    if (expected === "promoted") expect(wake.status).not.toBe("deferred_issue_execution");
    else expect(wake.status).toBe("deferred_issue_execution");
    if (continuationDelivery !== "pending") return;
    // The isolated continuation is delivered and runs; its release promotes the follow-up behind it.
    const continuationRunId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ finishedAt: new Date() }).where(eq(heartbeatRuns.id, continuationRunId));
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence}
      || ${JSON.stringify({ continuationDelivery: "delivered", continuationRunId })}::jsonb` })
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect((await release({ companyId, runId: continuationRunId, now: new Date(), suppressImmediateRecovery: true })).outcome.kind)
      .toBe("promoted");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status)
      .not.toBe("deferred_issue_execution");
  });

  it.each([
    "completed", "multiple_comments", "repeated_reference", "parent_reference", "mixed_issue_references", "mixed_foreign_references", "mixed_unknown_references", "no_comments", "missing_comment",
    "human_comment", "other_run_comment", "foreign_comment", "other_issue_comment", "deleted_comment",
    "mixed_human_comments", "mixed_other_run_comments", "mixed_unrelated_comments",
    "no_reference", "code_reference", "ambiguous_children", "child_open", "child_cancelled",
    "foreign_child", "unrelated_child", "other_child_assignee", "parent_open",
    "source_other_task", "source_other_agent", "wrong_company", "wrong_run",
  ])("proves completed delegation from transactional comment and child rows (%s)", async (scenario) => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const leadId = await seedAgent({ companyId, name: "Lead" });
    const workerId = await seedAgent({ companyId, name: "Worker" });
    const foreignAgentId = await seedAgent({ companyId: otherCompanyId });
    const issueId = await seedIssue({ companyId, identifier: "QA-1", assigneeAgentId: leadId, status: scenario === "parent_open" ? "in_progress" : "done" });
    const otherIssueId = await seedIssue({ companyId, identifier: "QA-99" });
    const foreignIssueId = await seedIssue({ companyId: otherCompanyId, identifier: "QA-98" });
    const runId = await seedRun({ companyId, agentId: scenario === "source_other_agent" ? workerId : leadId,
      status: "succeeded", contextSnapshot: { issueId: scenario === "source_other_task" ? otherIssueId : issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const otherRunId = await seedRun({ companyId, agentId: leadId, status: "succeeded", contextSnapshot: { issueId } });
    await seedIssue({
      companyId: scenario === "foreign_child" ? otherCompanyId : companyId,
      identifier: "QA-2", parentId: scenario === "unrelated_child" ? otherIssueId : issueId,
      assigneeAgentId: scenario === "foreign_child" ? foreignAgentId : scenario === "other_child_assignee" ? leadId : workerId,
      status: scenario === "child_open" ? "in_progress" : scenario === "child_cancelled" ? "cancelled" : "done",
    });
    if (scenario === "ambiguous_children") {
      await seedIssue({ companyId, identifier: "QA-3", parentId: issueId, assigneeAgentId: workerId, status: "done" });
    }
    const body = scenario === "parent_reference" ? "QA-1 is done thanks to @Worker completing QA-2"
      : scenario === "mixed_issue_references" ? "@Worker completed QA-2; now investigate QA-99"
      : scenario === "mixed_foreign_references" ? "@Worker completed QA-2; also check QA-98"
      : scenario === "mixed_unknown_references" ? "@Worker completed QA-2; also check QA-999"
      : scenario === "no_reference" ? "Thanks @Worker" : scenario === "code_reference" ? "Example `QA-2`"
      : scenario === "ambiguous_children" ? "@Worker completed QA-2 and QA-3"
      : scenario === "repeated_reference" ? "@Worker completed [QA-2](/issues/QA-2); QA-2 is done"
      : "@Worker completed QA-2";
    const [comment] = await db.insert(issueComments).values({
      companyId: scenario === "foreign_comment" ? otherCompanyId : companyId,
      issueId: scenario === "foreign_comment" ? foreignIssueId : scenario === "other_issue_comment" ? otherIssueId : issueId,
      authorAgentId: scenario === "human_comment" ? null : leadId,
      authorUserId: scenario === "human_comment" ? "responsible-user" : null,
      createdByRunId: scenario === "human_comment" ? null : scenario === "other_run_comment" ? otherRunId : runId,
      body, deletedAt: scenario === "deleted_comment" ? new Date() : null,
    }).returning();
    const commentIds = scenario === "no_comments" ? [] : [comment.id];
    if (scenario === "missing_comment") commentIds.push(randomUUID());
    if (["multiple_comments", "mixed_human_comments", "mixed_other_run_comments", "mixed_unrelated_comments"].includes(scenario)) {
      const [second] = await db.insert(issueComments).values({ companyId, issueId,
        authorAgentId: scenario === "mixed_human_comments" ? null : leadId,
        authorUserId: scenario === "mixed_human_comments" ? "responsible-user" : null,
        createdByRunId: scenario === "mixed_human_comments" ? null : scenario === "mixed_other_run_comments" ? otherRunId : runId,
        body: scenario === "mixed_unrelated_comments" ? "@Worker, investigate a new error" : "QA-2 was delivered",
      }).returning();
      commentIds.push(second.id);
    }
    let checked = false;
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      checked = true;
      const completed = await ports.transaction.isCompletedDelegationMention({
        companyId: scenario === "wrong_company" ? otherCompanyId : companyId,
        issueId, finishingRunId: scenario === "wrong_run" ? otherRunId : runId, wakeAgentId: workerId, commentIds,
      });
      expect(completed).toBe(["completed", "multiple_comments", "repeated_reference", "parent_reference"].includes(scenario));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(checked).toBe(true);
  });

  it("skips malformed queued comment ids instead of failing the whole liveness batch", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId, authorAgentId: agentId, createdByRunId: null, body: "Mentioned follow-up",
    }).returning();
    const missingCommentId = randomUUID();
    // An 8-char short form, like the id observed in a live wake payload. It is
    // not a uuid, so it can never match a comment row, but it used to abort the
    // whole `inArray` statement and block every queued wake for the issue.
    const malformedCommentId = "0422d095";
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let result: { liveNonSelfCommentIds: string[]; containedSelfAuthoredComment: boolean } | null = null;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      result = await ports.transaction.getQueuedCommentLiveness({
        companyId, issueId, wakeAgentId: agentId, finishingRunId: runId, finishingRunAgentId: agentId,
        queuedCommentIds: [comment.id, malformedCommentId, missingCommentId],
      });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result).not.toBeNull();
    expect(result!.liveNonSelfCommentIds).toEqual([comment.id]);
    expect(result!.containedSelfAuthoredComment).toBe(false);
  });

  it("treats an all-malformed queued comment id list as nothing live", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let result: { liveNonSelfCommentIds: string[]; containedSelfAuthoredComment: boolean } | null = null;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      result = await ports.transaction.getQueuedCommentLiveness({
        companyId, issueId, wakeAgentId: agentId, finishingRunId: runId, finishingRunAgentId: agentId,
        queuedCommentIds: ["0422d095"],
      });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result).not.toBeNull();
    expect(result!.liveNonSelfCommentIds).toEqual([]);
    expect(result!.containedSelfAuthoredComment).toBe(false);
  });

  it.each([false, true])("ignores retired Chat off values before interrupted queue promotion (conversation=%s)", async (conversation) => {
    const settings = instanceSettingsService(db);
    const original = (await settings.getExperimental()).enableAgentChat;
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId, authorUserId: "responsible-user", body: "Pending input",
    }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { commentId: comment.id, _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } },
    });
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", resultJson: {
      queuedCommentInterruptQueueId: wakeId, executionCancellation: { state: "acknowledged" },
      conversationContinuation: "continue_conversation_v1",
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: "responsible-user", conversationState: "active" } : {}),
    }).where(eq(issues.id, issueId));
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} },
    });
    try {
      await settings.updateExperimental({ enableAgentChat: false });
      const result = await release({ companyId, runId, now: new Date() });
      expect(result.outcome.kind).toBe("promoted");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
      expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0].body).toBe(comment.body);
      await release({ companyId, runId, now: new Date() });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
    } finally {
      await settings.updateExperimental({ enableAgentChat: original });
    }
  });

  for (const hasDeferredMessage of [false, true]) {
    it(`plans conversation recovery during owner cleanup without draining messages (queued=${hasDeferredMessage})`, async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
      await db.update(heartbeatRuns).set({
        processPid: process.pid,
        resultJson: { conversationContinuation: "continue_conversation_v1" },
      }).where(eq(heartbeatRuns.id, runId));
      const wakeId = hasDeferredMessage ? await seedDeferredWake({ companyId, agentId, issueId }) : null;
      const release = createReleaseIssueExecution({
        issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
        recovery: {
          escalateStrandedAssignedIssue: async () => { throw new Error("unexpected escalation"); },
          escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("unexpected escalation"); },
        },
      });
      const result = await release({ companyId, runId, now: new Date() });
      expect(result.outcome.kind).toBe("released");
      expect(result.postCommitEffects.every((effect) => effect.kind === "conversation_retry_requested")).toBe(true);
      if (!wakeId) expect(result.postCommitEffects).toEqual([
        { kind: "conversation_retry_requested", companyId, runId, reviewParticipant: false },
      ]);
      if (wakeId) {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
        expect(wake.status).toBe("deferred_issue_execution");
      }
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    });
  }

  it("releases an acknowledged native handoff without blocking or restarting the old owner", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, resultJson: {
      reassignmentStopRequested: true,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const before = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not restart the outgoing owner"); });
    expect(result).toMatchObject({ outcome: { kind: "released" }, postCommitEffects: [] });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({
      status: "in_progress", statusVersion: before.statusVersion, assigneeAgentId: agentId, executionRunId: null, checkoutRunId: null,
    });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
  });

  it("runs the new assignee's parked wake when a reassignment committed while the native Stop was settling", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const nextAgentId = await seedAgent({ companyId, name: "NextOwner" });
    // The board reassigned the task while the outgoing run's Stop was still
    // being acknowledged by its owner, so the task already names the successor.
    const issueId = await seedIssue({ companyId, assigneeAgentId: nextAgentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, resultJson: {
      reassignmentStopRequested: true,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
    } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const outgoingWakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const assignmentWakeId = await seedDeferredWake({ companyId, agentId: nextAgentId, issueId });
    await db.update(agentWakeupRequests).set({ source: "assignment", reason: "issue_assigned" })
      .where(eq(agentWakeupRequests.id, assignmentWakeId));
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => { throw new Error("must not escalate a stopped run"); },
        escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("must not escalate a stopped run"); } },
    });

    const result = await release({ companyId, runId, now: new Date() });

    expect(result.outcome.kind).toBe("promoted");
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, nextAgentId)));
    expect(successors).toHaveLength(1);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, assignmentWakeId)))[0])
      .toMatchObject({ status: "queued", runId: successors[0]!.id });
    // The stopped agent's own queued work is still not promoted by its Stop.
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, outgoingWakeId)))[0].status)
      .toBe("deferred_issue_execution");
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, agentId)))).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
  });

  // Stop row, S10 Option B (org 11-17 08:11Z, "Stop means stop", Gate 5
  // native): a person queued A, B, C behind a chat turn (one wake each, as a
  // chat saves them) and pressed the square Stop. Nothing is promoted and no
  // run starts; the chat's messages wait as ONE queue, in order, for the
  // owner's Send. A held chat (leaf_pause) is the same. A task keeps its rule.
  it.each(["chat", "held-chat", "new-boundary", "task"] as const)("a person's Stop on a native chat turn sends nothing and gathers its waiting messages in order (%s)", async (variant) => {
    const chat = variant !== "task";
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    if (chat) await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: "board-user",
      conversationState: "active" }).where(eq(issues.id, issueId));
    if (variant === "held-chat") await db.insert(issueTreeHolds).values({ companyId, rootIssueId: issueId, mode: "pause",
      status: "active", createdByActorType: "user", createdByUserId: "board-user",
      releasePolicy: { strategy: "manual", note: "leaf_pause" } });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, errorCode: "cancelled",
      finishedAt: new Date(), resultJson: {
        cancelledByActorType: "user", cancelledByUserId: "board-user",
        cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "board-user" },
          reason: "Cancelled by a board operator", recordedAt: new Date().toISOString() },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId,
          scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
      } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const queuedIds: string[] = [];
    const wakeIds: string[] = [];
    // new-boundary: A, B, /new, C. Only A and B gather; /new keeps its turn
    // boundary and C stays behind it.
    const bodies = variant === "new-boundary" ? ["A", "B", "/new", "C"] : ["A", "B", "C"];
    for (const [index, body] of bodies.entries()) {
      const at = new Date(Date.now() - 60_000 + index * 21_000);
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "board-user", body,
        createdAt: at }).returning();
      queuedIds.push(comment.id);
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand",
        triggerDetail: "manual", reason: "issue_execution_deferred", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "board-user", requestedAt: at,
        idempotencyKey: `conversation-comment:${comment.id}`,
        payload: withQueuedCommentIdsInWakePayload({ issueId,
          _paperclipWakeContext: { issueId, taskKey: issueId, wakeReason: "issue_commented", source: "issue.comment" } }, [comment.id]),
      }).returning();
      wakeIds.push(wake.id);
    }
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => { throw new Error("must not escalate a stopped run"); },
        escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("must not escalate a stopped run"); } },
    });

    // A repeated release (finalizer and Stop both release) changes nothing more.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await release({ companyId, runId, now: new Date() });
      expect(result.outcome.kind).toBe("released");
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: runId, status: "cancelled" });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      const wakes = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, wakeIds));
      const byId = new Map(wakes.map((wake) => [wake.id, wake]));
      if (!chat) {
        // Guard: a task's Stop holds each queued comment where it was.
        for (const [index, id] of wakeIds.entries()) {
          expect(byId.get(id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
          expect(queuedCommentIdsFromWakePayload(byId.get(id)!.payload)).toEqual([queuedIds[index]]);
        }
        continue;
      }
      const gathered = variant === "new-boundary" ? 2 : 3;
      expect(byId.get(wakeIds[0]!)).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(queuedCommentIdsFromWakePayload(byId.get(wakeIds[0]!)!.payload)).toEqual(queuedIds.slice(0, gathered));
      for (const id of wakeIds.slice(1, gathered)) expect(byId.get(id)).toMatchObject({ status: "coalesced", runId: null });
      for (const [index, id] of wakeIds.entries()) if (index >= gathered) {
        expect(byId.get(id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
        expect(queuedCommentIdsFromWakePayload(byId.get(id)!.payload)).toEqual([queuedIds[index]]);
      }
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ executionRunId: null });
    }
  });

  it("releases an acknowledged interrupt Stop without blocking or retiring the settling executor", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, errorCode: "operator_interrupted", resultJson: {
      operatorInterrupted: true, interruptionSource: "issue_comment_interrupt", interruptedIssueId: issueId,
      interruptedByActorType: "user", interruptedByActorId: "board-user",
      cancelledByActorType: "user", cancelledByUserId: "board-user",
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() },
    } }).where(eq(heartbeatRuns.id, runId));
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed",
      leaseOwner: "settling-executor", leaseExpiresAt });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const before = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not restart the stopped run"); });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({
      status: "in_progress", statusVersion: before.statusVersion, executionRunId: null, checkoutRunId: null,
    });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]).toMatchObject({
      phase: "observed", leaseOwner: "settling-executor", leaseExpiresAt, recoveryState: null,
    });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
  });

  // H1 bug B: a budget pause stopped the agent's run, and the release blocked
  // the task behind a reconciliation incident with no control. A pause is an
  // intentional stop; resuming continues the task.
  it.each(["Agent lifecycle stop requested", "Cancelled due to budget pause", "Cancelled due to agent pause"])(
    "keeps a native task's status and opens no incident when a pause stopped its run (%s)", async (reason) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, errorCode: "cancelled",
      resultJson: { cancellation: { reason, source: "control_plane", expected: true, initiator: { type: "system" },
        recordedAt: new Date().toISOString() },
        ...(reason === "Agent lifecycle stop requested" ? { pauseStop: { holds: ["budget"], companyPauseReason: null } } : {}) } }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => undefined as never);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
  });

  // Review: the full release (createReleaseIssueExecution), not only the
  // native incident step, must leave a paused agent's task unblocked.
  it.each(["native", "legacy"] as const)("keeps a %s task unblocked through the full release when its agent's pause stopped the run", async (runtimeMode) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    await db.update(agents).set({ status: "paused", lifecycleState: "pausing", lifecycleHolds: ["manual"] }).where(eq(agents.id, agentId));
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode, ...(runtimeMode === "native" ? { nativeIssueId: issueId } : {}),
      errorCode: "cancelled", resultJson: { cancellation: { reason: "Agent lifecycle stop requested", source: "control_plane",
        expected: true, initiator: { type: "system" } }, pauseStop: { holds: ["manual"], companyPauseReason: null } } })
      .where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const escalateStrandedAssignedIssue = vi.fn(async () => undefined);
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    await release({ companyId, runId, now: new Date() });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress" });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    expect(escalateStrandedAssignedIssue).not.toHaveBeenCalled();
  });

  it("still opens a reconciliation incident when termination replaced the pause that stamped the run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    await db.update(agents).set({ lifecycleState: "terminating" }).where(eq(agents.id, agentId));
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, errorCode: "cancelled",
      resultJson: { cancellation: { reason: "Agent lifecycle stop requested", source: "control_plane", expected: true,
        initiator: { type: "system" } }, pauseStop: { holds: ["budget"], companyPauseReason: null } } })
      .where(eq(heartbeatRuns.id, runId));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => undefined as never);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0])
      .toMatchObject({ cause: "native_continuation_requires_reconciliation" });
  });

  it("still opens a reconciliation incident when agent termination stopped the run", async () => {
    // Termination and cleanup use the lifecycle stop reason too, with no pauseStop.
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, errorCode: "cancelled",
      resultJson: { cancellation: { reason: "Agent lifecycle stop requested", source: "control_plane",
        expected: true, initiator: { type: "system" } } } }).where(eq(heartbeatRuns.id, runId));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => undefined as never);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0])
      .toMatchObject({ cause: "native_continuation_requires_reconciliation" });
  });

  it("still opens a reconciliation incident for a native run cancelled by another system stop", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, errorCode: "cancelled",
      resultJson: { cancellation: { reason: "Cancelled because the company was archived", source: "control_plane",
        expected: true, initiator: { type: "system" } } } }).where(eq(heartbeatRuns.id, runId));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => undefined as never);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0])
      .toMatchObject({ cause: "native_continuation_requires_reconciliation" });
  });

  it.each(["in_progress", "blocked"])("preserves recovery ownership and queued messages when a native task fails from %s", async (status) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", errorCode: "thread_binding_mismatch" }).where(eq(heartbeatRuns.id, runId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not replay an uncertain execution"); });
    const blockedIssue = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(blockedIssue.status).toBe("blocked");
    const entries = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    if (status === "in_progress") {
      expect(blockedIssue.blockedTransitionAt).not.toBeNull();
      expect(entries[0]).toMatchObject({ action: "issue.updated", details: { status: "blocked", previousStatus: "in_progress" } });
    } else expect(entries).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    const action = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0];
    expect(action).toMatchObject({ ownerType: "board", cause: "native_continuation_requires_reconciliation" });
    if (status === "in_progress") expect(action.evidence).toMatchObject({ nativeFailureBlock: { runId, statusVersion: blockedIssue.statusVersion } });
    else expect(action.evidence.nativeFailureBlock).toBeUndefined();
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not replay"); });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].statusVersion).toBe(blockedIssue.statusVersion);
  });

  it.each([true, false])("holds a native pre-dispatch failure only when no automatic retry owns it (retry scheduled: %s)", async (retryScheduled) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", errorCode: "adapter_failed",
      resultJson: { failureCause: "40001", nativePreDispatchFailure: { version: 1, providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    if (retryScheduled) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "scheduled_retry",
        retryOfRunId: runId, scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1,
        contextSnapshot: { issueId, retryReason: "interrupted_preparation" } });
    }
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => undefined as never);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    const issue = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    if (retryScheduled) {
      // The uncharged retry owns the next attempt: no incident, no blocked task, no Retry click.
      expect(issue.status).toBe("in_progress");
      expect(actions).toHaveLength(0);
    } else {
      // An exhausted lane keeps today's hold, whose task offers a manual Retry.
      expect(issue.status).toBe("blocked");
      expect(actions[0]).toMatchObject({ cause: "native_continuation_requires_reconciliation" });
    }
  });

  // Keep reason: SMA-183 retry/resend must reach admission, not only the
  // unanswered-message worker's 'no run' notice. No generic 429 exemption.
  it.each(["proved", "intent", "allocation", "unproved"] as const)("releases saved input after a positively pre-setup HTTP429, and only that (%s)", async proof => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: randomUUID(),
      finishedAt: new Date(), errorCode: "setup_failed", runnerProfileJson: { nativeExecutionInput: { admitted: true } },
      resultJson: { failureCause: "provider_http_429", ...(proof === "unproved" ? {} : {
        nativePreDispatchFailure: { version: 1, providerWorkStarted: false } }) } }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure" });
    if (proof === "intent") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1,
      stream: "system", eventType: "native.process_start_requested" });
    if (proof === "allocation") await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      provider: "boat", providerLeaseId: "acquired-allocation" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    let reached = false;
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => {
      reached = true;
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(reached).toBe(proof === "proved");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(proof === "proved" ? 0 : 1);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe(proof === "proved" ? "in_progress" : "blocked");
    // Refused cases keep the saved message; successful release delegates its
    // promotion to the existing queue owner, not a second handwritten path.
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]!.status).toBe("deferred_issue_execution");
  });

  it.each(["task_retry", "issue_commented"])("promotes a real saved %s after pre-setup HTTP429 instead of only a no-run note", async reason => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: randomUUID(),
      finishedAt: new Date(), errorCode: "setup_failed", runnerProfileJson: { nativeExecutionInput: { admitted: true } },
      resultJson: { failureCause: "provider_http_429", nativePreDispatchFailure: { version: 1, providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "responsible-user",
      body: "Answer this saved message after the setup outage." }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { _paperclipWakeContext: { issueId, wakeReason: reason, wakeCommentIds: [comment.id] } } });
    await db.update(agentWakeupRequests).set({ reason }).where(eq(agentWakeupRequests.id, wakeId));
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } });
    expect((await release({ companyId, runId, now: new Date() })).outcome.kind).toBe("promoted");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake).toMatchObject({ status: "queued", runId: expect.any(String) });
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(successor).toMatchObject({ status: "queued", agentId, contextSnapshot: { issueId, wakeCommentIds: [comment.id] } });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).map(row => row.body)).toEqual([comment.body]);
    await release({ companyId, runId, now: new Date() });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
  });

  it("does not open a reconciliation incident for a native run whose model the provider rejected", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", errorCode: "native_provider_model_rejected" }).where(eq(heartbeatRuns.id, runId));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not restart a rejected model"); });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("blocked");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
  });

  it.each(["active", "escalated"])("repairs a failed native task with an existing %s recovery action", async (status) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "failed", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", errorCode: "runner_lost" }).where(eq(heartbeatRuns.id, runId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const [existing] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, status, kind: "active_run_watchdog",
      ownerType: "board", cause: "native_runner_restart_unverified", fingerprint: `restart:${runId}`,
      evidence: { runId, priorProof: "keep", automaticRecovery: { attempts: 2 } },
      nextAction: "Verify the previous execution stopped", attemptCount: 2, maxAttempts: 3,
    }).returning();
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const release = () => adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => { throw new Error("must not replay"); });
    await release();
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked.status).toBe("blocked");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: existing.id, status, cause: existing.cause,
      ownerType: "board", attemptCount: 2, maxAttempts: 3, nextAction: existing.nextAction,
      evidence: { runId, priorProof: "keep", automaticRecovery: { attempts: 2 },
        nativeFailureBlock: { runId, statusVersion: blocked.statusVersion } } });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("deferred_issue_execution");
    await release();
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].statusVersion).toBe(blocked.statusVersion);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toHaveLength(1);
  });

  it.each(["queued", "running", "scheduled_retry"])("does not promote another turn behind a %s successor without an execution lock", async (status) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "succeeded", contextSnapshot: { issueId } });
    await seedRun({ companyId, agentId, status, contextSnapshot: { issueId } });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let drained = false;
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async () => {
      drained = true;
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(drained).toBe(false);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake.status).toBe("deferred_issue_execution");
  });

  it.each(["clean", "launch", "cleanup"])("promotes saved input only after a verified pre-dispatch review wait (%s)", async evidence => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "cancelled", contextSnapshot: { issueId },
      errorCode: "issue_continuation_waiting_on_review" });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 1000), resultJson: {
      stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate",
    } }).where(eq(heartbeatRuns.id, runId));
    if (evidence === "launch") await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "native.process_start_requested", stream: "system", level: "info" });
    if (evidence === "cleanup") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId,
      provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
      authorUserId: "responsible-user", body: "Continue with this new message." }).returning();
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, requestedByActorId: "responsible-user",
      payload: { commentId: comment.id, _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } } });
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, stubDeps),
      recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } });
    const result = await release({ companyId, runId, now: new Date() });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    if (evidence !== "clean") {
      expect(result.outcome.kind).toBe("released");
      expect(runs).toHaveLength(1);
      expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
      return;
    }
    expect(result.outcome.kind).toBe("promoted");
    expect(runs).toHaveLength(2);
    const successor = runs.find(run => run.status === "queued")!;
    expect(wake.runId).toBe(successor.id);
    expect(successor.contextSnapshot).toMatchObject({ wakeCommentIds: [comment.id] });
    await release({ companyId, runId, now: new Date() });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
  });

  it("leaves deferred work untouched until the effective execution hold clears", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", status: "resolved",
      fingerprint: runId, evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Check the stopped execution.",
    }).returning();
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    let drainCalls = 0;
    const drain = async () => {
      drainCalls++;
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    };
    for (let i = 0; i < 3; i++) {
      expect((await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, drain)).outcome.kind).toBe("released");
    }
    expect(drainCalls).toBe(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]).toMatchObject({
      status: "deferred_issue_execution", runId: null,
    });
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, hold!.id));
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, drain);
    expect(drainCalls).toBe(1);
  });

  // Review test (a): a foreign-company agent id produces the current failed
  // wake status and the current error text, and creates no run.
  it("skips preserved handoff receipts for one drain without changing their durable state", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const previous = await seedDeferredWake({ companyId, agentId, issueId });
    const next = await seedDeferredWake({ companyId, agentId, issueId });
    await db.update(agentWakeupRequests).set({ requestedAt: new Date("2026-01-01") }).where(eq(agentWakeupRequests.id, previous));
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      expect((await ports.transaction.findNextDeferredWake({ companyId, issueId }))?.id).toBe(previous);
      expect((await ports.transaction.findNextDeferredWake({ companyId, issueId, excludedWakeIds: [previous] }))?.id).toBe(next);
      expect(await ports.transaction.findNextDeferredWake({ companyId, issueId, excludedWakeIds: [previous, next] })).toBeNull();
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    const [preserved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, previous));
    expect(preserved.status).toBe("deferred_issue_execution");
    expect(preserved.runId).toBeNull();
  });

  it("fails a deferred wake whose agent belongs to a different company, without creating a run", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignAgentId = await seedAgent({ companyId: otherCompanyId });
    const finishingAgentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: finishingAgentId, status: "in_progress" });
    // A finishing run status other than the legacy-reconciliation set (failed,
    // timed_out, interrupted, cancelled) reaches the module's own drain logic.
    const runId = await seedRun({ companyId, agentId: finishingAgentId, contextSnapshot: { issueId }, status: "succeeded" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const wakeId = await seedDeferredWake({ companyId, agentId: foreignAgentId, issueId });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (locked, ports) => {
      const candidate = await ports.transaction.findNextDeferredWake({ companyId, issueId: locked.primaryIssue.id });
      expect(candidate?.id).toBe(wakeId);
      const agent = await ports.transaction.findInvokableAgent({ companyId, agentId: foreignAgentId });
      expect(agent).toBeNull();
      const failed = await ports.transaction.failDeferredWake({ companyId, wakeId: candidate!.id, agentId: candidate!.agentId, now: new Date() });
      expect(failed).toBe(true);
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result.outcome.kind).toBe("released");

    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("failed");
    expect(wakeRow?.error).toBe("Deferred wake could not be promoted: agent is not invokable");
    expect(wakeRow?.runId).toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
  });

  // Review test (b): each release adapter mutation with a foreign company
  // affects no row.
  it("scopes every release mutation to its own company and affects no row across a company boundary", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    await db.update(issues).set({ executionState: { phase: "running" } }).where(eq(issues.id, issueId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock(
      { companyId, runId, now: new Date() },
      async (_locked, ports) => {
        const cancelledUnderWrongCompany = await ports.transaction.cancelDeferredWake({
          companyId: otherCompanyId,
          agentId,
          wakeId,
          reason: "cross-company cancel attempt",
          now: new Date(),
        });
        expect(cancelledUnderWrongCompany).toBe(false);

        const failedUnderWrongCompany = await ports.transaction.failDeferredWake({
          companyId: otherCompanyId,
          agentId,
          wakeId,
          now: new Date(),
        });
        expect(failedUnderWrongCompany).toBe(false);

        const normalizedUnderWrongCompany = await ports.transaction.normalizeDeferredWakeCommentIds({
          companyId: otherCompanyId,
          wakeId,
          payload: { issueId },
          liveCommentIds: ["c1"],
          now: new Date(),
        });
        expect(normalizedUnderWrongCompany).toBeNull();

        const reopenedUnderWrongCompany = await ports.transaction.reopenIssue({
          companyId: otherCompanyId,
          issueId,
          runId,
        });
        expect(reopenedUnderWrongCompany).toBeNull();

        return { outcome: { kind: "released" as const }, postCommitEffects: [] };
      },
    );

    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("deferred_issue_execution");
    expect(wakeRow?.error).toBeNull();
    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.status).toBe("blocked");
    expect(issueRow?.executionState).toEqual({ phase: "running" });
  });

  // Review defect: the reopen path must carry the company into every read,
  // lock, and write. A check before the write is not a boundary, because
  // `issues.company_id` can change between that check and the write.
  it("refuses to reopen an issue for a company that does not own it, and leaves the issue untouched", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    await db.update(issues).set({ executionState: { phase: "running" } }).where(eq(issues.id, issueId));
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const captured: { reopened: { status: string; executionState: Record<string, unknown> | null } | null } = {
      reopened: null,
    };
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      captured.reopened = await ports.transaction.reopenIssue({ companyId: otherCompanyId, issueId, runId });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(captured.reopened).toBeNull();

    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.status).toBe("blocked");
    expect(issueRow?.executionState).toEqual({ phase: "running" });
  });

  it("reopens an issue for the company that owns it, and clears the execution state", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, status: "blocked" });
    await db.update(issues).set({ executionState: { phase: "running" } }).where(eq(issues.id, issueId));
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const captured: { reopened: { status: string; executionState: Record<string, unknown> | null } | null } = {
      reopened: null,
    };
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      captured.reopened = await ports.transaction.reopenIssue({ companyId, issueId, runId });
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(captured.reopened?.status).toBe("todo");
    expect(captured.reopened?.executionState).toBeNull();

    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.status).toBe("todo");
    expect(issueRow?.executionState).toBeNull();
  });

  // Review test (c): a deferred-status compare-and-set that affects no row
  // claims nothing, and no other write in the promotion path ever runs.
  it("fails the promotion claim when the deferred-status compare-and-set loses the race, before any other write", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    // A concurrent finalization already claimed this wake before the promotion claim runs.
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, wakeId));

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (_locked, ports) => {
      const claimed = await ports.transaction.claimDeferredWakeForPromotion({ companyId, wakeId, now: new Date() });
      expect(claimed).toBe(false);
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result.outcome.kind).toBe("released");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.executionRunId).toBeNull();
    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("cancelled");
  });

  // `finalizePromotedWake`'s own writes guard against clobbering state a
  // concurrent write already changed: it never takes the issue's execution
  // lock away from a run that already holds it, and it never overwrites a
  // `runId` a wake row already carries. Both guards only matter as defense
  // in depth today (the release drain calls this at most once per
  // transaction), so this drives the port directly to prove the SQL itself,
  // independent of that call pattern.
  it("guards finalizePromotedWake's own writes against clobbering an already-set execution lock or runId", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const wakeIdA = await seedDeferredWake({ companyId, agentId, issueId });
    const wakeIdB = await seedDeferredWake({ companyId, agentId, issueId });
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId }, status: "succeeded" });
    const deferredAgent = { id: agentId, companyId, name: "CodexCoder", invokable: true };

    const finalizedRunIds: string[] = [];
    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (locked, ports) => {
      const finalize = async (wakeId: string) => {
        const promoted = await ports.transaction.finalizePromotedWake({
          companyId,
          wakeId,
          deferredAgent,
          issue: locked.primaryIssue,
          finishingRun: locked.run,
          contextSnapshot: { issueId },
          reason: "issue_execution_promoted",
          source: "automation",
          triggerDetail: null,
          payload: {},
          responsibleUserId: "responsible-user",
          sessionBefore: null,
          now: new Date(),
        });
        finalizedRunIds.push(promoted.id);
      };
      // The issue's execution lock is free; this call takes it.
      await finalize(wakeIdA);
      // The issue's execution lock is already held by the first call's run,
      // so this call's issue-lock write must no-op even though a run is
      // still created.
      await finalize(wakeIdB);
      // Repeating the same wake must not overwrite its now-set `runId`.
      await finalize(wakeIdA);
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    const [runA, runB, runC] = finalizedRunIds;

    const wakeRowA = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeIdA)))[0];
    const wakeRowB = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeIdB)))[0];
    expect(wakeRowA?.runId).toBe(runA);
    expect(wakeRowB?.runId).toBe(runB);
    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.executionRunId).toBe(runA);
    expect(issueRow?.executionRunId).not.toBe(runB);
    expect(issueRow?.executionRunId).not.toBe(runC);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    // All three finalize calls each still insert their own run row.
    expect(runs.map((run) => run.id).sort()).toEqual([runId, runA, runB, runC].sort());
  });

  it("locks the context issue and every sibling issue in id order, and two concurrent releases do not deadlock", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueA = await seedIssue({ companyId, assigneeAgentId: agentId });
    const issueB = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runA = await seedRun({ companyId, agentId, contextSnapshot: { issueId: issueA } });
    const runB = await seedRun({ companyId, agentId, contextSnapshot: { issueId: issueB } });
    await db.update(issues).set({ executionRunId: runA, checkoutRunId: runB }).where(eq(issues.id, issueA));
    await db.update(issues).set({ executionRunId: runB, checkoutRunId: runA }).where(eq(issues.id, issueB));

    const adapterA = createPostgresWakeQueueAdapter(db, stubDeps);
    const adapterB = createPostgresWakeQueueAdapter(db, stubDeps);
    const releaseA = adapterA.withIssueExecutionLock({ companyId, runId: runA, now: new Date() }, async (_locked, _ports) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    const releaseB = adapterB.withIssueExecutionLock({ companyId, runId: runB, now: new Date() }, async (_locked, _ports) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });

    await expect(Promise.all([releaseA, releaseB])).resolves.toBeDefined();

    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    for (const row of rows) {
      expect(row.executionRunId).toBeNull();
      expect(row.checkoutRunId).toBeNull();
    }
  });

  it("clears both lock columns on every sibling and keeps a transferred executionRunId", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const finishingRunId = await seedRun({ companyId, agentId, contextSnapshot: {} });
    const retryRunId = await seedRun({ companyId, agentId, contextSnapshot: {}, status: "queued" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, executionRunId: retryRunId, checkoutRunId: finishingRunId });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId: finishingRunId, now: new Date() }, async () => ({
      outcome: { kind: "released" as const },
      postCommitEffects: [],
    }));
    expect(result.outcome.kind).toBe("released");

    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    // executionRunId already pointed at the retry, not the finishing run, so it must survive.
    expect(issueRow?.executionRunId).toBe(retryRunId);
    expect(issueRow?.checkoutRunId).toBeNull();
  });

  // The admission half opens no transaction of its own: `heartbeat.ts` still
  // owns it. These tests drive the admission writer directly against a
  // transaction they open themselves, the same way `heartbeat.ts` will.
  describe("wake admission", () => {
    it.each(["running", "cancelled", "receipt-collision", "actor-mismatch"])("preserves both queued input sources after %s", async scenario => {
      const companyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const [oldComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "source-user", body: "Original input" }).returning();
      const [newComment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "source-user", body: "Incoming input" }).returning();
      const runId = await seedRun({ companyId, agentId, status: ["receipt-collision", "actor-mismatch"].includes(scenario) ? "queued" : scenario,
        contextSnapshot: withQueuedCommentIdsInRunContext({ issueId }, [oldComment.id]) });
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, runId, source: "assignment", status: "queued",
        requestedByActorType: "user", requestedByActorId: "source-user",
        payload: withQueuedCommentIdsInWakePayload({ issueId }, [oldComment.id]),
      }).returning();
      await db.update(heartbeatRuns).set({ wakeupRequestId: wake.id }).where(eq(heartbeatRuns.id, runId));
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const operation = db.transaction(async tx => createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(
        createAdmissionTransactionScope(companyId, tx as unknown as Db), {
          companyId, agentId, activeExecutionRunId: runId, activeExecutionRunStatus: "queued",
          mergedContextSnapshot: withQueuedCommentIdsInRunContext({ issueId }, [oldComment.id, newComment.id]),
          source: "on_demand", triggerDetail: "manual", payload: { issueId, commentId: newComment.id },
          requestedByActorType: "user", requestedByActorId: scenario === "actor-mismatch" ? "another-user" : "source-user", idempotencyKey: null,
          ...(["receipt-collision", "actor-mismatch"].includes(scenario)
            ? { durableReceipt: { id: scenario === "receipt-collision" ? wake.id : randomUUID(), requestedAt: new Date() } } : {}),
        },
      ));
      if (scenario === "receipt-collision") await expect(operation).rejects.toMatchObject({ cause: { code: "23505" } });
      else await expect(operation).resolves.toBeNull();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toEqual(before);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([wake]);
    });

    it("rolls back a deferred merge when its own durable receipt insert fails", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const wakeId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        payload: { originalTarget: true },
      });
      const occupiedReceiptId = await seedDeferredWake({
        companyId,
        agentId,
        issueId,
        payload: { originalReceipt: true },
      });
      const before = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
        .orderBy(agentWakeupRequests.id);
      const writer = createWakeAdmissionWriter();

      await expect(
        db.transaction(async (tx) => {
          const scope = createAdmissionTransactionScope(
            companyId,
            tx as unknown as Db,
          );
          await writer.mergeIntoExistingDeferredWake(scope, {
            companyId,
            existingDeferredWakeId: wakeId,
            mergedPayload: { issueId, changedByMerge: true },
            nextCoalescedCount: 9,
            coalescedReceipt: {
              id: occupiedReceiptId,
              requestedAt: new Date(),
              agentId,
              source: "automation",
              triggerDetail: "system",
              reason: "question_response",
              payload: { issueId, coalescedIntoWakeupRequestId: wakeId },
              requestedByActorType: "user",
              requestedByActorId: "actor-1",
              idempotencyKey: "colliding-receipt",
              runId: null,
            },
          });
        }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });

      // The target update precedes the deliberately colliding INSERT. Both
      // complete rows must be restored, including payload, count and timestamps.
      const after = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))
        .orderBy(agentWakeupRequests.id);
      expect(after).toEqual(before);
      expect(after).toHaveLength(2);
    });

    // Review test (b): an admission adapter mutation with a foreign company
    // affects no row.
    it("refuses to merge into a deferred wake for a company that does not own it, and leaves the wake untouched", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
      const writer = createWakeAdmissionWriter();

      await expect(
        db.transaction(async (tx) => {
          const scope = createAdmissionTransactionScope(otherCompanyId, tx as unknown as Db);
          await writer.mergeIntoExistingDeferredWake(scope, {
            companyId: otherCompanyId,
            existingDeferredWakeId: wakeId,
            mergedPayload: { issueId, foo: "bar" },
            nextCoalescedCount: 5,
          });
        }),
      ).rejects.toThrow();

      const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
      expect(wakeRow?.status).toBe("deferred_issue_execution");
      expect(wakeRow?.coalescedCount).not.toBe(5);
      expect(wakeRow?.payload).not.toHaveProperty("foo");
    });

    it.each([DELIVERY_QUEUES.nativeResponsePresentation, DELIVERY_QUEUES.nativeReviewResponse, DELIVERY_QUEUES.nativeStatusReassessment])(
      "scopes a real coalesced-input %s response wake to its active run after commit", async queue => {
      const companyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const runId = await seedRun({ companyId, agentId, status: "running" });
      const hints: Array<Record<string, unknown>> = [];
      const unsubscribe = subscribeDatabaseWork(db, queue, (event, values) => {
        if (event === "settled") for (const value of values ?? []) hints.push(JSON.parse(value));
      });
      try {
        await db.transaction(async tx => {
          await createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(createAdmissionTransactionScope(companyId, tx as unknown as Db), {
            companyId, activeExecutionRunId: runId, activeExecutionRunStatus: "running", mergedContextSnapshot: { commentId: "fresh-input" },
            agentId, source: "on_demand", triggerDetail: null, payload: null,
            requestedByActorType: "user", requestedByActorId: null, idempotencyKey: null,
          });
          expect(hints).toEqual([]);
        });
        expect(hints).toEqual([{ companyId, runId }]);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].contextSnapshot)
          .toMatchObject({ commentId: "fresh-input" });
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, runId))).toHaveLength(1);
      } finally { unsubscribe(); }
    });

    // Review test (b), the coalesce write: a foreign company affects no row
    // on the active execution run either.
    it("refuses to coalesce into a run for a company that does not own it, and leaves the run and the wake table untouched", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { taskKey: "issue-1" } });
      const writer = createWakeAdmissionWriter();

      await expect(
        db.transaction(async (tx) => {
          const scope = createAdmissionTransactionScope(otherCompanyId, tx as unknown as Db);
          await writer.coalesceIntoActiveExecutionRun(scope, {
            companyId: otherCompanyId,
            activeExecutionRunId: runId,
            activeExecutionRunStatus: "running",
            mergedContextSnapshot: { taskKey: "issue-1", commentId: "c1" },
            agentId,
            source: "on_demand",
            triggerDetail: null,
            payload: null,
            requestedByActorType: "user",
            requestedByActorId: null,
            idempotencyKey: null,
          });
        }),
      ).rejects.toThrow();

      const runRow = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
      expect(runRow?.contextSnapshot).toEqual({ taskKey: "issue-1" });
      const wakeRows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, otherCompanyId));
      expect(wakeRows).toHaveLength(0);
    });

    // Review test (d): a transaction-port call cannot use the root database
    // executor. The module rejects a missing scope handle and a mismatched
    // scope handle, and neither case writes a row.
    it("rejects a missing transaction scope and a mismatched one, without writing through the root executor", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = await seedAgent({ companyId });
      const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
      const writer = createWakeAdmissionWriter();
      const newWakeInput = {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: null,
        payload: { issueId },
        requestedByActorType: "system",
        requestedByActorId: null,
        idempotencyKey: null,
      };

      await expect(
        writer.insertNewDeferredWake(undefined as unknown as TransactionScope, newWakeInput),
      ).rejects.toThrow(/transaction scope/);

      await expect(
        db.transaction(async (tx) => {
          const mismatchedScope = createAdmissionTransactionScope(otherCompanyId, tx as unknown as Db);
          await writer.insertNewDeferredWake(mismatchedScope, newWakeInput);
        }),
      ).rejects.toThrow(/different company/);

      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(rows).toHaveLength(0);
    });
  });
});

// RFL 17:07Z stale-wake amendment: real persisted input, release drain and
// per-message sweep. Provider execution is simulated; admission and custody are real.
describeEmbeddedPostgres("stale deferred person wakes (RFL 17:07Z)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const owner = "stale-wake-owner";
  const deps: WakeQueuePostgresAdapterDeps = {
    resolveResponsibleUserId: async () => owner,
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  };
  const ago = (ms: number) => new Date(Date.now() - ms);
  const day = 24 * 60 * 60_000;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-deferred-wake-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await tempDb?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Paul's daily chat", issuePrefix: "SW",
      requireBoardApprovalForNewAgents: false }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Daily agent", role: "engineer",
      status: "idle", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Daily chat", status: "in_review",
      assigneeAgentId: agent.id, conversationAgentId: agent.id, conversationUserId: owner,
      conversationState: "waiting" }).returning();
    return { companyId: company.id, agentId: agent.id, issueId: issue.id };
  }
  type Chat = Awaited<ReturnType<typeof seed>>;

  async function message(c: Chat, body: string, at: Date) {
    const [m] = await db.insert(issueComments).values({ companyId: c.companyId, issueId: c.issueId,
      authorType: "user", authorUserId: owner, body, createdAt: at, updatedAt: at }).returning();
    return m;
  }
  async function wake(c: Chat, id: string, at: Date, status = "deferred_issue_execution") {
    const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status, requestedAt: at,
      requestedByActorType: "user", requestedByActorId: owner, idempotencyKey: `conversation-comment:${id}`,
      payload: withQueuedCommentIdsInWakePayload({ issueId: c.issueId,
        _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: "issue_commented" } }, [id]),
    }).returning();
    return w;
  }
  async function run(c: Chat, ids: string[], startedAt: Date, status = "succeeded", wakeupRequestId?: string) {
    const [r] = await db.insert(heartbeatRuns).values({ companyId: c.companyId, agentId: c.agentId, status,
      runtimeMode: "native", nativeIssueId: c.issueId, startedAt, createdAt: startedAt, finishedAt: ago(60_000),
      wakeupRequestId, contextSnapshot: { issueId: c.issueId, taskKey: c.issueId, wakeCommentIds: ids } }).returning();
    return r;
  }
  async function reply(c: Chat, runId: string, body = "Reply to the later turn") {
    await db.insert(issueComments).values({ companyId: c.companyId, issueId: c.issueId, authorType: "agent",
      authorAgentId: c.agentId, createdByRunId: runId, body });
  }
  async function drain(c: Chat, runId: string, resumeStrandedQueue = false) {
    await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, c.issueId));
    return createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, deps), recovery: {
      escalateStrandedAssignedIssue: async () => { throw new Error("unexpected automatic recovery"); },
      escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("unexpected automatic recovery"); },
    } })({ companyId: c.companyId, runId, now: new Date(), ...(resumeStrandedQueue ? { resumeStrandedQueue: true } : {}) });
  }
  async function cards(c: Chat, id: string) {
    return db.select().from(issueComments).where(and(eq(issueComments.companyId, c.companyId),
      eq(issueComments.issueId, c.issueId), sql`${issueComments.metadata}->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX + id}`));
  }
  async function sweep(c: Chat) {
    for (let pass = 0; pass < 2; pass++) await settleUnansweredPersonMessage(db, {
      companyId: c.companyId, issueId: c.issueId, now: new Date(), olderOutcomes: [] });
  }
  async function noRunFor(id: string) {
    return db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${id}`);
  }
  async function movedChat(carried = false, cancelled = false, linkedOnly = false) {
    const c = await seed();
    const old = await message(c, "OLD: request held two days ago", ago(2 * day + 60_000));
    const w = await wake(c, old.id, ago(2 * day), cancelled ? "cancelled" : undefined);
    if (carried) {
      const failed = await run(c, linkedOnly ? [] : [old.id], ago(2 * day - 60_000), "failed", linkedOnly ? w.id : undefined);
      await db.update(heartbeatRuns).set({ finishedAt: new Date(failed.startedAt!.getTime() + 30_000) })
        .where(eq(heartbeatRuns.id, failed.id));
    }
    const later = await message(c, "A later daily-work question", ago(day));
    const r = await run(c, [later.id], ago(day - 60_000));
    await reply(c, r.id);
    return { c, old, w, r };
  }

  it("sw-1: old never-claimed wake is cancelled, never promoted; sweep writes exactly ONE true card", async () => {
    const { c, old, w, r } = await movedChat();
    const result = await drain(c, r.id);
    const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id));
    console.log("sw-1 drain", result.outcome.kind, "wake", saved.status, saved.error);
    expect(saved).toMatchObject({ status: "cancelled", error: "The conversation moved on", runId: null });
    expect(await noRunFor(old.id)).toEqual([]);
    const [floor] = await db.select({ owed: personMessageOwedSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }) })
      .from(issueComments).where(eq(issueComments.id, old.id));
    console.log("sw-1 cancelled never-carried message owed for card", floor.owed);
    await sweep(c);
    const notices = await cards(c, old.id);
    console.log("sw-1 sweep cards", notices.length, notices.map(n => n.body));
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("no run started for it");
    expect(notices[0].body).toContain(`Your message is saved: "${old.body}".`);
  });

  it("sw-2: OLD was carried by a failed run; cancel with no re-send and NO late card", async () => {
    const { c, old, w, r } = await movedChat(true);
    await drain(c, r.id);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0])
      .toMatchObject({ status: "cancelled", error: "The conversation moved on" });
    expect(await noRunFor(old.id)).toHaveLength(1); // only the original failed carrier
    await sweep(c);
    console.log("sw-2 sweep cards", (await cards(c, old.id)).length);
    expect(await cards(c, old.id)).toEqual([]);
  });

  it("st-stop (sw-3): Stop-held README survives the replied '9 + 10' marker and is answered ONCE afterwards", async () => {
    const c = await seed();
    const readme = await message(c, "README: update the project readme", ago(2 * day + 60_000));
    const w = await wake(c, readme.id, ago(2 * day));
    const stopped = await run(c, [], ago(2 * day + 120_000), "cancelled");
    await db.update(heartbeatRuns).set({ finishedAt: ago(2 * day - 60_000),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: owner,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: stopped.id, companyId: c.companyId,
        issueId: c.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
        dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } })
      .where(eq(heartbeatRuns.id, stopped.id));
    await drain(c, stopped.id); // real Stop release writes/keeps the held wake
    const marker = await message(c, "9 + 10", ago(30 * 60_000));
    const r = await run(c, [marker.id], ago(29 * 60_000));
    await reply(c, r.id, "19");
    expect(await readPersonStopHold(db, { ...c, messageId: readme.id })).toBeNull();
    const result = await drain(c, r.id);
    console.log("sw-3 marker drain", result.outcome.kind);
    expect(result.outcome.kind).toBe("promoted");
    const [promoted] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, w.id)));
    expect(promoted.contextSnapshot).toMatchObject({ wakeCommentIds: [readme.id] });
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, promoted.id));
    await reply(c, promoted.id, "README updated");
    await drain(c, promoted.id);
    await sweep(c);
    expect(await noRunFor(readme.id)).toHaveLength(1);
    expect(await cards(c, readme.id)).toEqual([]);
    console.log("sw-3 README carriers", (await noRunFor(readme.id)).length, "cards", (await cards(c, readme.id)).length);
  });

  it("sw-4: a fresh wake requested during the live turn promotes as today", async () => {
    const c = await seed();
    const r = await run(c, [], ago(60 * 60_000));
    const fresh = await message(c, "Fresh daily-work input", ago(30 * 60_000));
    const w = await wake(c, fresh.id, ago(29 * 60_000));
    await reply(c, r.id);
    const result = await drain(c, r.id);
    expect(result.outcome.kind).toBe("promoted");
    expect(await noRunFor(fresh.id)).toHaveLength(1);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0].runId).toBeTruthy();
    console.log("sw-4 drain", result.outcome.kind);
  });

  it("sw-5: unclaimed CANCELLED wake fields are not delivery; ONE card remains owed", async () => {
    const { c, old } = await movedChat(false, true);
    await sweep(c);
    console.log("sw-5 sweep cards", (await cards(c, old.id)).length);
    expect(await cards(c, old.id)).toHaveLength(1);
  });

  it("sw-6: the run-to-wake claim link counts even without run-side message ids; NO late card", async () => {
    const { c, old } = await movedChat(true, true, true);
    await sweep(c);
    expect(await cards(c, old.id)).toEqual([]);
    console.log("sw-6 sweep cards", (await cards(c, old.id)).length);
  });

  async function finishQueued(c: Chat, w: typeof agentWakeupRequests.$inferSelect, text: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, w.id));
    expect(rows).toHaveLength(1);
    const r = rows[0];
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, r.id));
    await reply(c, r.id, text);
    await drain(c, r.id);
    return r;
  }

  it("st-chain3: three plain messages in separate deferred wakes answer once, in order, without cards", async () => {
    const c = await seed();
    const first = await message(c, "First turn", ago(60 * 60_000));
    const r = await run(c, [first.id], ago(59 * 60_000));
    const messages = [], wakes = [];
    for (let index = 0; index < 3; index++) {
      const m = await message(c, `Default message ${index + 1}`, ago((30 - index) * 60_000));
      messages.push(m); wakes.push(await wake(c, m.id, m.createdAt));
    }
    await reply(c, r.id);
    expect((await drain(c, r.id)).outcome.kind).toBe("promoted");
    for (let index = 0; index < 3; index++) {
      const carrier = await finishQueued(c, wakes[index], `Answered ${index + 1}`);
      expect(carrier.contextSnapshot).toMatchObject({ wakeCommentIds: [messages[index].id] });
      expect(await noRunFor(messages[index].id)).toHaveLength(1);
      await sweep(c);
      expect(await cards(c, messages[index].id)).toEqual([]);
    }
    const replies = await db.select({ body: issueComments.body }).from(issueComments).where(and(
      eq(issueComments.issueId, c.issueId), eq(issueComments.authorType, "agent"))).orderBy(issueComments.createdAt);
    expect(replies.map(r => r.body)).toEqual(["Reply to the later turn", "Answered 1", "Answered 2", "Answered 3"]);
    console.log("st-chain3 answered order", replies.map(r => r.body), "cards 0; one carrier each");
  });

  it("st-install-gap: six-minute server-down gap with no newer input answered preserves M2", async () => {
    const c = await seed();
    const first = await message(c, "S's own input", ago(20 * 60_000));
    const m = await message(c, "M2 waiting across install", ago(10 * 60_000));
    const w = await wake(c, m.id, ago(10 * 60_000));
    // S was queued before M2, but only STARTS after M2. The six minutes
    // without any intervening run represent a restart mid-chain, not a sleep.
    const s = await run(c, [first.id], ago(9 * 60_000));
    await db.update(heartbeatRuns).set({ finishedAt: ago(3 * 60_000) }).where(eq(heartbeatRuns.id, s.id));
    await reply(c, s.id);
    expect((await drain(c, s.id)).outcome.kind).toBe("promoted");
    await finishQueued(c, w, "M2 answered after restart");
    await sweep(c);
    expect(await noRunFor(m.id)).toHaveLength(1); expect(await cards(c, m.id)).toEqual([]);
    console.log("st-install-gap M2 promoted and answered once after 6 min; cards 0");
  });

  it("st-e39: stale completion wake supersedes D, names the finished task once, and starts no run", async () => {
    const c = await seed();
    const [task] = await db.insert(issues).values({ companyId: c.companyId, title: "Finish the README",
      identifier: "SMA-611", status: "done", completedAt: ago(4 * 60 * 60_000) }).returning();
    await db.insert(chatTaskHandoffs).values({ companyId: c.companyId, taskId: task.id, conversationId: c.issueId,
      agentId: c.agentId, sessionGeneration: 0 });
    const [delivery] = await db.insert(chatCompletionDeliveries).values({ companyId: c.companyId, taskId: task.id,
      statusVersion: task.statusVersion, status: "queued" }).returning();
    const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
      source: "automation", reason: "chat_task_completed", requestedByActorType: "system",
      status: "deferred_issue_execution", requestedAt: ago(4 * 60 * 60_000),
      payload: { issueId: c.issueId, chatCompletionDeliveryIds: [delivery.id], _paperclipWakeContext: {
        issueId: c.issueId, taskKey: c.issueId, wakeReason: "chat_task_completed", chatCompletionDeliveryIds: [delivery.id] } } }).returning();
    const m = await message(c, "What is next today?", ago(3 * 60 * 60_000));
    const s = await run(c, [m.id], ago(179 * 60_000)); await reply(c, s.id, "Today's answer");
    for (let pass = 0; pass < 2; pass++) { await drain(c, s.id); await sweep(c); }
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0])
      .toMatchObject({ status: "cancelled", error: "The conversation moved on", runId: null });
    expect((await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.id, delivery.id)))[0].status).toBe("superseded");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, w.id))).toEqual([]);
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, c.issueId), eq(issueComments.authorType, "system")));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("Finished earlier (this report was delayed): SMA-611 — Finish the README.");
    console.log("st-e39 cancelled; D superseded; no run; ONE note:", notes[0].body);
  });

  it("st-failed-newer: even a replying FAILED newer carrier cannot stale the live queue", async () => {
    const c = await seed();
    const old = await message(c, "Still my live request", ago(40 * 60_000));
    const w = await wake(c, old.id, ago(39 * 60_000));
    const later = await message(c, "Newer but failed", ago(20 * 60_000));
    const failed = await run(c, [later.id], ago(19 * 60_000), "failed");
    await reply(c, failed.id);
    // A failed native run has its separate recovery gate. A settled, empty
    // finalizer drains here; the only newer PERSON carrier is still FAILED.
    const finalizer = await run(c, [], ago(10 * 60_000));
    await reply(c, finalizer.id);
    expect((await drain(c, finalizer.id)).outcome.kind).toBe("promoted");
    await finishQueued(c, w, "Old live request answered"); await sweep(c);
    expect(await noRunFor(old.id)).toHaveLength(1); expect(await cards(c, old.id)).toEqual([]);
    console.log("st-failed-newer FAILED does not stale: promoted and answered once, cards 0");
  });

  it("st-busy: a six-minute busy-finalization early return does not age the waiting message", async () => {
    const c = await seed();
    const first = await message(c, "Current turn", ago(30 * 60_000));
    const r = await run(c, [first.id], ago(29 * 60_000)); await reply(c, r.id);
    const m = await message(c, "Wait behind finalization", ago(20 * 60_000));
    const w = await wake(c, m.id, ago(20 * 60_000));
    await db.insert(nativeRunFinalizations).values({ companyId: c.companyId, issueId: c.issueId, runId: r.id,
      phase: "applied", updatedAt: ago(6 * 60_000) });
    expect((await drain(c, r.id, true)).outcome.kind).toBe("released");
    expect(await noRunFor(m.id)).toEqual([]);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, r.id));
    expect((await drain(c, r.id, true)).outcome.kind).toBe("promoted");
    await finishQueued(c, w, "Waiting request answered"); await sweep(c);
    expect(await noRunFor(m.id)).toHaveLength(1); expect(await cards(c, m.id)).toEqual([]);
    console.log("st-busy real finalization early return then promotion after >5 min; answer once, cards 0");
  });

  it.each(["cancelled", "failed"])("st-bpp: B''b carried by a %s run, then a newer answered person input: no card or new run", async status => {
    const { c, old, w, r } = await movedChat(true);
    await db.update(heartbeatRuns).set({ status }).where(and(eq(heartbeatRuns.companyId, c.companyId), sql`${heartbeatRuns.id} <> ${r.id}`));
    await drain(c, r.id); await sweep(c);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0].status).toBe("cancelled");
    expect(await noRunFor(old.id)).toHaveLength(1); expect(await cards(c, old.id)).toEqual([]);
    console.log("st-bpp", status, "old carried input dropped; cards 0; no new run");
  });

  it("st-together: newer input claimed together with M answers both; no stale card or resend for M", async () => {
    const c = await seed();
    const m = await message(c, "M first", ago(40 * 60_000));
    const w = await wake(c, m.id, ago(39 * 60_000));
    const newer = await message(c, "Next together", ago(20 * 60_000));
    const r = await run(c, [m.id, newer.id], ago(19 * 60_000));
    await reply(c, r.id, "M answered first; next answered second");
    await drain(c, r.id); await sweep(c);
    expect(await noRunFor(m.id)).toHaveLength(1); expect(await noRunFor(newer.id)).toHaveLength(1);
    expect(await cards(c, m.id)).toEqual([]); expect(await cards(c, newer.id)).toEqual([]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0].status).toBe("cancelled");
    console.log("st-together both input ids in ONE replying run; no card, no resend");
  });

  it.each(["wakeCommentIds", "commentId", "wakeCommentId", "firstTurnQueuedInput", "claimed-wake"])(
    "st-claim: a succeeded reply with newer PERSON input in %s makes the old receipt stale", async field => {
      const c = await seed();
      const old = await message(c, "Old request never claimed", ago(40 * 60_000));
      const w = await wake(c, old.id, ago(39 * 60_000));
      const newer = await message(c, "Newer person input", ago(20 * 60_000));
      const inputWake = field === "claimed-wake" ? await wake(c, newer.id, ago(19 * 60_000), "completed") : null;
      const r = await run(c, [], ago(18 * 60_000), "succeeded", inputWake?.id);
      const context = { issueId: c.issueId, ...(field === "wakeCommentIds" ? { wakeCommentIds: [newer.id] }
        : field === "commentId" ? { commentId: newer.id } : field === "wakeCommentId" ? { wakeCommentId: newer.id }
        : field === "firstTurnQueuedInput" ? { firstTurnQueuedInput: { commentIds: [newer.id] } } : {}) };
      await db.update(heartbeatRuns).set({ contextSnapshot: context, ...(inputWake ? { nativeIssueId: null } : {}) })
        .where(eq(heartbeatRuns.id, r.id));
      await reply(c, r.id);
      // Also exercise custody before promotion: a stale deferred receipt must
      // not hide its never-claimed input from the real sweep.
      await sweep(c); expect(await cards(c, old.id)).toHaveLength(1);
      await drain(c, r.id); await sweep(c);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0])
        .toMatchObject({ status: "cancelled", error: "The conversation moved on", runId: null });
      expect(await cards(c, old.id)).toHaveLength(1); expect(await noRunFor(old.id)).toEqual([]);
      console.log("st-claim", field, "stale before drain; one named card, no run");
    });

  it.each(["no-input", "reply-boundary-only", "unclaimed-wake", "no-reply", "deleted-reply"])(
    "st-not-claim: %s does not move the live queue on", async shape => {
      const c = await seed();
      const old = await message(c, "Still waiting", ago(40 * 60_000));
      const w = await wake(c, old.id, ago(39 * 60_000));
      const newer = await message(c, "Newer but not answered", ago(20 * 60_000));
      const r = await run(c, ["no-reply", "deleted-reply"].includes(shape) ? [newer.id] : [], ago(18 * 60_000));
      if (shape === "reply-boundary-only") await db.update(heartbeatRuns).set({ contextSnapshot: {
        issueId: c.issueId, conversationReplyBoundaryCommentId: newer.id } }).where(eq(heartbeatRuns.id, r.id));
      if (shape === "unclaimed-wake") await wake(c, newer.id, ago(19 * 60_000), "cancelled");
      if (shape !== "no-reply") await reply(c, r.id);
      if (shape === "deleted-reply") await db.update(issueComments).set({ deletedAt: new Date() })
        .where(eq(issueComments.createdByRunId, r.id));
      await sweep(c); expect(await cards(c, old.id)).toEqual([]);
      expect((await drain(c, r.id)).outcome.kind).toBe("promoted");
      await finishQueued(c, w, "Waiting message answered");
      await sweep(c); expect(await cards(c, old.id)).toEqual([]);
      expect(await noRunFor(old.id)).toHaveLength(1);
      console.log("st-not-claim", shape, "live custody, promoted and answered; no card");
    });

  it.each(["issue_monitor", "restored_run"])("st-system: stale %s names its held update once, with no run", async reason => {
    const c = await seed();
    const [held] = await db.insert(issueComments).values({ companyId: c.companyId, issueId: c.issueId,
      authorType: "agent", authorAgentId: c.agentId, body: `${reason}: check the README result`, createdAt: ago(40 * 60_000) }).returning();
    const w = await wake(c, held.id, ago(39 * 60_000));
    await db.update(agentWakeupRequests).set({ requestedByActorType: "system", requestedByActorId: null,
      reason, payload: withQueuedCommentIdsInWakePayload({ issueId: c.issueId,
        _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: reason } }, [held.id]) })
      .where(eq(agentWakeupRequests.id, w.id));
    const newer = await message(c, "Person moved on", ago(20 * 60_000));
    const r = await run(c, [newer.id], ago(19 * 60_000)); await reply(c, r.id);
    for (let pass = 0; pass < 2; pass++) { await drain(c, r.id); await sweep(c); }
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0])
      .toMatchObject({ status: "cancelled", error: "The conversation moved on", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, w.id))).toEqual([]);
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, c.issueId), eq(issueComments.authorType, "system")));
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(`Not run because the conversation moved on (this update was delayed): "${held.body}".`);
    console.log("st-system", reason, "ONE note:", notes[0].body);
  });

  it("st-system-long: a 500-character held update is quoted at 60 characters in ONE note", async () => {
    const c = await seed();
    const [held] = await db.insert(issueComments).values({ companyId: c.companyId, issueId: c.issueId,
      authorType: "agent", authorAgentId: c.agentId, body: "x".repeat(500), createdAt: ago(40 * 60_000) }).returning();
    const w = await wake(c, held.id, ago(39 * 60_000));
    await db.update(agentWakeupRequests).set({ requestedByActorType: "system", requestedByActorId: null,
      reason: "issue_monitor", payload: withQueuedCommentIdsInWakePayload({ issueId: c.issueId,
        _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: "issue_monitor" } }, [held.id]) })
      .where(eq(agentWakeupRequests.id, w.id));
    const newer = await message(c, "Person moved on", ago(20 * 60_000));
    const r = await run(c, [newer.id], ago(19 * 60_000)); await reply(c, r.id);
    for (let pass = 0; pass < 2; pass++) { await drain(c, r.id); await sweep(c); }
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id)))[0])
      .toMatchObject({ status: "cancelled", runId: null, error: "The conversation moved on" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, w.id))).toEqual([]);
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, c.issueId), eq(issueComments.authorType, "system")));
    expect(notes.map(n => n.body)).toEqual([
      `Not run because the conversation moved on (this update was delayed): "${"x".repeat(59)}…".`,
    ]);
    console.log("st-system-long ONE note:", notes[0].body);
  });
});
